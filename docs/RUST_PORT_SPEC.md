# Rust Port Spec — Hyperia live terminal surfaces

Synthesis of four independent lanes, each written against the code this
session, not against chat history. Lane files carry the detail and the
`file:line` citations; this document carries the decisions, the
contradictions the lanes found in each other, and the plan.

| Lane | Scope | File | Lines |
|---|---|---|---|
| A | wire protocol & session lifecycle | `PORT_SPEC_LANE_A.md` | 558 |
| B | scene, assets, raster pipeline | `PORT_SPEC_LANE_B.md` | 483 |
| C | binding model, leases, control plane | `PORT_SPEC_LANE_C.md` | 559 |
| D | Rust architecture & sequencing | `PORT_SPEC_LANE_D.md` | 439 |

**Assumption, stated because it was not specified:** the target project
is unknown, so nothing below names a renderer. The split is drawn so that
choosing wgpu, Bevy, egui, or a headless recorder changes exactly one
crate. If the target is already fixed, say so — it collapses §3's last
row and nothing else.

---

## 1. Executive summary

**What is worth porting is not the 3D room.** It is a surface compositor
for live terminal streams: decode → gate on visibility → rasterise →
upload, with a binding layer saying which surface shows which source.
Three.js is load-bearing in only two places — measuring whether a surface
is visible, and uploading the raster. Both are already behind interfaces.

**The single highest-value change the port makes is a type.** A bay's
source is stored as `paneId: String`, with tabs encoded as `"tab:"+uuid`
and catalog images as `"terminal:"+id`. Three kinds in one string field.
Lane C found **four** independent call sites that each had to remember
the discriminator, and each one that forgot became a user-visible bug.
A Rust tagged enum makes the entire class unrepresentable. That is the
argument for the port; everything else is refinement.

**The single biggest process failure was verification.** Every agent's
ritual was `tsc --noEmit` + `vite build`, and every report said "clean".
Both pass with a black screen. Features shipped verified only that way.
The port's hard gate: the raster crate renders to an in-memory RGBA
buffer with golden-image tests, on CI, with no GPU.

**Ten decisions, in order of how much they cost if skipped:**

1. `BaySource` tagged enum from commit one — not a cleanup pass (Lane C §3.1)
2. Golden-image tests before the renderer exists (Lane D §4.7, Lane B §422)
3. Split `binding` (persistent intent) from `lease` (derived, never serialised) (Lane C §3.2)
4. Bay state on the server, not `localStorage` (Lane C §3.3)
5. One reconnect policy for all four sockets (Lane A §3.3)
6. `VisibilityProbe` as a trait, so the lease gate is table-testable (Lane D §1.1)
7. Tabs inside the lease machine, not beside it (Lane C §3.5)
8. Role index drives asset discovery; names survive only in migration logs (Lane B §294)
9. Cancellation tokens instead of generation counters (Lane A §1.12, Lane D §2.1)
10. Glyph atlas instead of per-cell `fillText` (Lane B §321, §167)

---

## 2. Shape of the system

```
        Hyperia sidecar :9800
   ┌─────────┬──────────┬──────────┬──────────┐
   │ /ws/wall│ /ws/pane │/ws/pixels│ /ws/tab  │
   └────┬────┴─────┬────┴─────┬────┴────┬─────┘
        │ cell     │ raw PTY  │ JPEG    │ layout + demux
        │ deltas   │ bytes    │         │
   ┌────▼──────────▼──────────▼─────────▼─────┐
   │ hyperia-client   one policy, one backoff │  tokio
   │ vte parse here, NOT on the render thread │
   └───────────────────┬──────────────────────┘
                       │ Arc<GridSnapshot> / Arc<Rgba>   (watch: latest-wins)
   ┌───────────────────▼──────────────────────┐
   │ surface-lease   none | overview | focused│  ← VisibilityProbe (trait)
   └───────────────────┬──────────────────────┘
   ┌───────────────────▼──────────────────────┐
   │ surface-core   glyph atlas, dirty rects  │  no GPU, golden-testable
   └───────────────────┬──────────────────────┘
   ┌───────────────────▼──────────────────────┐
   │ surface-render-<backend>   texture upload│  ← the only GPU crate
   └──────────────────────────────────────────┘

   ops-host (axum) ── static · /hyperia-api proxy · /ws/v1/control
                      owns bay bindings + power + desk height
```

Boundary rule: **a crate may not depend on a renderer unless its name
says so.** Enforce in the workspace manifest, not in review. This is what
makes a 2,638-line god file structurally impossible rather than
discouraged.

---

## 3. Crate layout

| crate | depends on | responsibility |
|---|---|---|
| `hyperia-proto` | `serde` | wire types, cell/colour/attr codec, `normalize_grid_rows`, `pane_chrome`. **No IO.** |
| `hyperia-client` | `tokio`, `tokio-tungstenite`, `vte` | four socket kinds, one reconnect policy, credentials, PTY→grid |
| `surface-core` | `hyperia-proto` | `ContentSource`/`Surface` traits, glyph atlas, dirty rects, cylindrical unwrap |
| `surface-lease` | `surface-core` | lease state machine over `VisibilityProbe` |
| `room-descriptor` | `serde` | versioned room schema, GLB `extras` role index, exhaustive validation |
| `surface-render-<be>` | a renderer | texture alloc/upload, uv→cell hit-test |
| `ops-host` | `axum` | static, sidecar proxy, control WS, bay persistence |

`ops-host` is the only crate that binds a port. `surface-render-*` is the
only crate that touches a GPU. Everything else is unit-testable on a CI
box with no display and no sidecar.

---

## 4. The four types that delete bug classes

### 4.1 `BaySource` — three kinds, one string field today

```rust
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BaySource {
    Empty,
    Pane    { id: PaneId },
    Tab     { id: TabId },      // never "tab:" + id
    Catalog { id: CatalogId },  // never "terminal:" + id
}
```

Shared across bays **and** wall section sources — Lane C checked; the
wall already models `Pane | Catalog` separately in memory. One type, in
`hyperia-proto` or a small `surface-core` module, not inside the lease
crate.

Migration runs once, on the server, with tests: `""` → `Empty`; strip
`"tab:"` → `Tab`; strip `"terminal:"`/catalog lookup → `Catalog`; UUID
parse → `Pane`; unparseable → `Empty` + log, never panic mid-restore.
**Do not keep the prefix inside the id** — `Tab { id: "tab:…" }` is the
same bug wearing a hat.

### 4.2 Binding vs lease

`session.paneId` answers two questions today: *what is this glass bound
to* and *what socket is currently open*. They legitimately diverge — a
bound-but-unleased bay, a tab-bound bay whose `paneId` is deliberately
`''` — and every divergence was a bug.

```rust
struct Bay { station: StationId, index: u8, source: BaySource, powered: bool }  // persisted
struct Lease { kind: StreamKind, mode: LeaseMode,
               token: CancellationToken, task: JoinHandle<()> }                 // derived, never serialised
impl Drop for Lease { fn drop(&mut self) { self.token.cancel(); } }
```

Power is electrical; source is routing; neither writes the other. An
off bay **remembers** its assignment and reattaches on power-on. Every
path that mixed them here was reverted.

### 4.3 `StreamKind` includes `Tab`

```rust
enum StreamKind { Pty, Pixels, Tab }
```

Lane C's sharpest structural finding: `getAssignment()` returns `null`
for tab-bound bays, so `desiredMode` is `none` and **the broker never
sees `/ws/tab` at all**. A tab-bound bay 40 m away still holds a 12 fps
compositor socket. The lease system exists to refuse exactly that, and
was bypassed for the newest source kind. In the port, `Tab` is leasable
under the same hysteresis as everything else.

### 4.4 `SemanticRole` — non-exhaustive, and actually load-bearing

```rust
#[non_exhaustive]
enum SemanticRole { RoomShell, CeilingMain, FloorGridBase, FloorTile,
                    ScreenSurface, ScreenFrame, ScreenLightRail,
                    Pedestal(PedestalTier), Accent(AccentKind),
                    LightAnchor(AnchorKind), Unknown(String) }
```

Build `HashMap<SemanticRole, SmallVec<NodeHandle>>` in one traversal,
enforce cardinality, order display sets by `screen_index` not by node
name. **Preserve unknown roles and log them; never hide a node because
its role is unknown** — that is the exact bug in §6.4.

---

## 5. WHAT WORKED — verified, port these

**Cell grids, not pixels, for terminals.** `[char, fg, bg, attrs]`. An
80×24 delta is a few hundred bytes; the JPEG equivalent is tens of
kilobytes, and the grid is resolution-independent, so one feed drives a
256 px desk monitor and a 4 K wall. Survived 7+ panes at 10 fps.

**One cell packing for wall and tab.** The tab compositor did not invent
a second grid codec. Keep it one type.

**One shared wall socket multiplexing every overview surface.** N
surfaces cost one socket, not N. This is why eight live screens do not
melt the client.

**Keyframe/delta split with resync.** Full `frame` after connect/resize,
`delta` for changed rows only, and a `resync` verb for the lagged case.
Crucially: **on resync, keep the last raster** — clearing it flashed the
wall black until the next delta.

**Lease hysteresis, 6 m acquire / 8.5 m release, 400 ms hidden grace.**
Without the band, a camera parked on the boundary thrashes sockets every
frame. Keep the numbers as *defaults*, make them data.

**Tight screen-mesh AABB for visibility — never a sphere, never a
subtree.** A bounding sphere puts the centre metres behind the glass, so
sitting 0.6 m away measured as beyond 6 m and never focused. A subtree
box is worse: `Box3.expandByObject` does not skip invisible children, so
hiding desk legs rather than removing them kept them in the sample and
flipped the gate.

**Ignore-unknown message types.** The sidecar added `panes`,
`tab-layout`, `pixels`, `screen-snapshot` without a coordinated bump and
the runtime survived. In Rust: `#[serde(other)]` / `Unknown`, and never
`deny_unknown_fields`.

**`paneChrome`'s `namedFromLayout` boolean.** Distinguishing "layout sent
a stable `name`" from "we fell back to the OSC `title`" stopped volatile
process titles from renaming panes. Port the boolean, not a heuristic on
the string.

**Blank keyframe means empty terminal, not missing data.** Treating it as
"no data" made idle panes look broken and invited a wall-feed fallback
that the implementer correctly refused.

**Power ⊥ source.** Off remembers the assignment. Operators power-cycle
without losing routing.

**`normalizeBays` grows, never shrinks.** The failure mode of shrinking
is silent assignment loss. Bay *count* comes from config, not from blob
length.

**Empty-discovery guard on reconcile.** Late topology used to zero a
desk. Distinguishing "not loaded yet" from "gone" is mandatory for any
restore-from-network design.

**Mean-relative cylindrical unwrap.** `middle = atan2(Σz, Σx)`, then
`wrapped = atan2(sin δ, cos δ)` about that mean — continuous across ±π,
which planar projection and naive `atan2` are not. Physical aspect =
`radius × span / rise`. This is what makes terminal text on a curved wall
keep its proportions.

**Geometry-derived UV orientation.** Measure `dP/du` and `dP/dv` from a
representative triangle and compare against viewer-right and world-up,
rather than passing per-monitor flip flags. Survived both authored desk
quads and generated wall UVs.

**Asset promise-sharing and per-instance material cloning.** One parse
per URI; cloned materials stop live textures bleeding across desks.

**Same-origin HTTP proxy for the sidecar.** Dev-only `/hyperia-api`
proxying made production report HYPERIA OFFLINE. One route in both modes.

**Control socket with retained snapshot on connect.** Idempotent
assignments, not deltas, so a lagged subscriber can skip and a reloaded
client is consistent with no custom sync round-trip.

---

## 6. WHAT DIDN'T — ranked by what it cost

### 6.1 String-typed bindings — four bugs, one missing type
Tabs were bolted onto `paneId: String` as `"tab:"+uuid` explicitly "so
the broker and router can tell them apart without a schema migration".
That sentence is the confession. Four call sites forgot the
discriminator:

1. **Boot card over live tab.** Powered ∧ no `paneId` → paint boot. Tab
   attach deliberately clears `paneId`. The ~3 s topology refresh painted
   boot straight over the compositing tab. *This is the bug the user
   reported as "showing a single pane after temporarily showing the
   image."*
2. **`/ws/pane/tab:<uuid>`.** Restore handed the stored string verbatim
   into the pane URL builder. That URL cannot exist; the bay went dark.
3. **Reconcile wipe.** Any id not in `discoveredPanes` was treated as
   dead. `"tab:<uuid>"` is never a pane id, so a live tab binding was
   erased on the first successful status fetch.
4. **Overview paint-over.** Wall cell-grids painted onto a tab-owned
   canvas when a stale assignment lingered in the lease state.

Each was fixed with a local guard. Guards are the wrong shape: they must
be re-added at every future call site, forever. Catalog `"terminal:"` is
the same class waiting for its collision.

### 6.2 Verification that proved compilation, not rendering
`tsc --noEmit` + `vite build`, reported "clean", repeatedly, for features
nobody had looked at. Both pass with a black screen. **This is the
failure the port must not reproduce**, and it is the reason M2 in §7 is a
golden PNG rather than a demo.

### 6.3 Tabs bypassing the lease machine
`getAssignment()` returns `null` for tabs, so the gate that exists to
refuse unwatched sockets never sees the newest and most expensive source
kind. Unbounded by frustum or distance.

### 6.4 The asset contract is authored and ignored
`semantic_role` appears in exactly **four** places in `frontend/src`, all
cosmetic. Loading is name-based: `RoomLoader` indexes `node.name` and
picks the presentation screen by name; `main.ts` hardcodes
`Wall_Screen_1..3`; `room-cleanup.ts` protects by name regex plus a
*legacy* role list that does not include the canonical roles the Blender
pass writes. **A correctly tagged, renamed node gets hidden.** Room
cleanup is a second, conflicting room definition, not cleanup.

*(Lane D originally listed this design under WHAT WORKED, claiming it
survived a re-author unchanged. Lane B disproved it; Lane D is corrected
in place. The idea is right, the wiring was never done.)*

### 6.5 The room descriptor is theater
It declares `stations`, `wallDisplays`, and `views`; `RoomLoader`
consumes only `shell` and `presentationScreen`. The real configuration
lives in a separate TypeScript constant. Validation checks three fields.
Consequence: room setup stayed hardcoded and agents kept rewriting
`main.ts` — the descriptor never absorbed the pressure it was built for.

### 6.6 Only one of three authored wall screens is wired
All three receive UVs; only `Wall_Screen_2` gets a `DisplaySurface`. The
other two get dark materials. Wall composition is hardcoded to four
sections in three separate loops, with a hardcoded persistence key.

### 6.7 One field answering two questions
Covered in §4.2. Every divergence between "bound" and "streaming" was a
bug.

### 6.8 Persistence in the wrong process
`localStorage`, per-browser, invisible to the server and to any second
client, already on its third hand-written migration, with a v1 key still
being written and a v2 key still named — while a Rust server sat idle
already owning desk heights and a control socket.

### 6.9 Four reconnect policies, all bad
Wall: 1500 ms flat, and only if someone is subscribed. Focused: 350 ms
floor, infinite, no cap, no jitter. Tab: **none at all** — `connect()`
never retries. Control socket: 1 s / 3 s. Plus a dead `HyperiaWallClient`
that has zero reconnect and *echoes* `resync`, which can loop against a
confused sidecar. Delete it; do not port it.

### 6.10 The client never authenticates any socket
No token on wall, pane, pixels, or tab. The room relies on anonymous
reads. The moment a sidecar sets `requireToken`, every upgrade 401s and
the room goes blind while `:9800` is up. Ops-host holds the agent token
and never gives it to the browser. **Decide in the port:** proxy Hyperia
WS through ops-host and attach `hyp_agent_*` server-side, or mint a
short-lived read ticket onto `?token=`. Never ship `hyp_pane_*` to a
renderer — it dies with its pane *and* with the sidecar, which is
precisely the failure that cost this session a debugging cycle.

### 6.11 Hardcoded `{hostname}:9800`
Breaks TLS termination, a sidecar on another host, and containers. The
HTTP side already learned this and takes `HYPERIA_URL`; the WS side never
did. Take a `HyperiaEndpoint { host, port, tls, credential }`.

### 6.12 The typed message union is a lie
It has no `panes`, no `tab-layout`, no `pixels`. The live first wall
burst is `t:"panes"` — a flat roster with no BSP — while the code models
`t:"topology"` with nested windows. A port must accept **both**. Also:
`hello.v` is never checked, so a v2 sidecar breaks us silently.

### 6.13 Full-frame Canvas2D repaint, and PTY rasterised twice
The wall clears and repaints every section; glyphs go through `fillText`
in nested per-cell loops with no atlas and no dirty-row upload. PTY is
drawn at 1280×800 and then that canvas is copied again during wall
render — duplicate CPU work and memory bandwidth per terminal write.

### 6.14 JPEG frames can present out of order
Decode results are rejected on stale socket generation but **not** on an
older completion from the same socket. Under decode pressure an older
frame can overwrite a newer one. Track `last_presented_sequence`.

### 6.15 Hit-testing and texture orientation are separate systems
Texture sampling may rotate and repeat UVs; hit testing uses raw UV with
a V flip. A flipped interactive surface clicks mirrored controls. Desk
HUD hit mapping additionally hardcodes 1024×512, so any HUD resolution
change desynchronises what is drawn from what is clickable.

### 6.16 Smaller, still real
Asset cache permanently caches rejection — one transient failure poisons
a URI until reload. Two different `DisplaySurface` types exist, one of
which **replaces the mesh's material** on construction. `FocusedPtySource`
paints every glyph one colour, so "full fidelity" focused mode is a
monochrome dump while the cheap wall path has full colour. Floor recut
builds 180 meshes from hardcoded radii. Stars use `Math.random`, so
screenshots are not reproducible — fatal for golden tests. A 25 cm global
monitor pick tolerance patches shallow-angle races but can steal
unrelated clicks. Desk travel limits are hardcoded per prefab.

### 6.17 Process: concurrent agents on shared mutable files
Beyond merge damage, agents reported success on code another agent had
already replaced. **This recurred while producing this very document** —
two of the three lanes independently wrote `PORT_SPEC_LANE_C.md`, and one
silently overwrote the other, costing a lane. If the target project runs
multiple agents, give each a crate, not a file range. The crate graph is
the coordination primitive.

---

## 7. Milestones

Every exit criterion is deliberately not "it compiles".

| M | scope | exit criterion |
|---|---|---|
| **M0** | `hyperia-proto` | round-trip every recorded wall/tab message from captured fixtures; property-test the colour codec including `idx:0..255`, `Idx(N)` debug leakage, and all four row shapes |
| **M1** | `hyperia-client`, wall only | connect to a live sidecar, print a decoded 80×24 grid as text; survive a sidecar restart; accept both `t:"panes"` and `t:"topology"` |
| **M2** | `surface-core` headless | render a known grid to PNG; **golden-image test in CI, no GPU**; dirty-rect correctness; ±π cylindrical unwrap continuity; `radius×span/rise` matches physical aspect |
| **M3** | `ops-host` + `BaySource` + server persistence | bind a bay over the control WS, restart the server, binding survives, a second client sees it. **Cannot ship with `paneId: String`** — if the prefix lands here, all four clobbers get reimplemented in Rust |
| **M4** | `surface-lease` + `VisibilityProbe` | table test drives a synthetic camera through the hysteresis band and asserts exact acquire/release transitions, including the hidden-grace path |
| **M5** | `surface-render-<be>` | one live pane on one quad, on screen, legible, 60 fps |
| **M6** | `room-descriptor` + layout | load circular and rectangular rooms from JSON with **zero code change**; unknown roles stay visible and diagnosable; all three wall screens can independently become displays |
| **M7** | `/ws/tab` composition | a 4-pane tab composites correctly and **survives a topology refresh** — §6.1 bug 1, as a test |
| **M8** | credentials & transport | `requireToken` sidecar works end to end; no `hyp_pane_*` reaches the client; endpoint is configuration, not a constant |

M0–M4 need no GPU. M0–M2 need no sidecar. M3 and M4 are where the two
worst bug classes get designed out — **do not reorder them later to chase
a visible demo.** M5 is the first thing anyone can look at, and that
placement is the deliberate correction to §6.2.

**Do not port `main.ts`.** 2,638 lines; it is the only file here with no
salvageable structure. Read it for behaviour, reimplement against the
crate graph.

---

## 8. Corrections register

Where the lanes corrected each other. Recorded because the corrections
are more load-bearing than the agreements.

| # | Claim | Correction | By |
|---|---|---|---|
| 1 | The `tab:` prefix caused two clobber bugs | **Four.** Reconcile-wipe and overview paint-over are the same class | C → D |
| 2 | Two source kinds share the `paneId` field | **Three.** Catalog `"terminal:"` is a third prefix awaiting its collision | C → D |
| 3 | `semantic_role` survived a re-author with no code change | **False.** Four cosmetic uses; loading is name-based; correctly-tagged renamed nodes get hidden | B → D |
| 4 | Overview runs at 2 fps | Class default is 2; live construction overrides to **10** | A, C → D |
| 5 | Tabs are a binding-layer problem | Tabs are also outside the lease machine entirely — an unbounded socket | C |
| 6 | The typed `WallMessage` union describes the wire | It omits `panes`, `tab-layout`, `pixels`; the live first burst is `t:"panes"` | A |
| 7 | Generation counters are merely awkward | `focusedGeneration` is stored and **never read**; correctness rests on every callback remembering | A, C |

Lane D's §3.5 was retracted in place rather than quietly edited.

---

## 9. Open questions

- **Which project is the target?** Nothing here names a renderer, which
  is defensible but costs one crate's worth of concreteness.
- **Transport for Hyperia WS:** proxy through `ops-host` (server-side
  `hyp_agent_*`, works in containers, one more hop) or direct with a
  minted read ticket? §6.10 blocks M8 until this is decided.
- **Overview of a tab:** the shared wall multiplex, or `/ws/tab` at low
  fps? Pick one; do not open both.
- **Fan-in:** two bays on one pane currently open two focused sockets.
  Worth deduplicating by source id, or is per-glass simpler?
- **Is the 0.6 glyph aspect a font property or an arbitrary constant?**
  It changes the atlas design.
