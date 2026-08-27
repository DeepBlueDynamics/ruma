# LANE D — Rust port architecture & sequencing

Owner: Sweet Asp 🍬. Companion lanes: A (wire protocol), B (scene/raster),
C (binding/leases/control plane).

---

## 0. What is actually being ported

The valuable thing in `3dterminal` is **not** the 3D room. It is a
**surface compositor for live terminal streams**:

```
Hyperia sidecar ──ws──▶ decode ──▶ cell grid / pixel frame
                                        │
                              lease gate (is anyone looking?)
                                        │
                                   rasterize
                                        │
                              texture ──▶ any renderer
                                        ▲
                               binding: surface ⇄ source
```

Every part of that pipeline is renderer-agnostic. Three.js appears in
exactly two places that matter — *measuring* whether a surface is visible,
and *uploading* the raster — and both are behind interfaces already
(`StreamBinding.object`, `DisplaySurface`). The port should make that
separation structural rather than incidental.

**Corollary for the target project:** do not start by picking a renderer.
Start with `hyperia-proto` + `surface-core`, which are pure and testable
with zero graphics. If the target project renders to an egui panel, a
wgpu quad, a Bevy material, or a headless PNG, only the last crate
changes.

---

## 1. CONTRACT — crate layout

Seven crates. The boundary rule: **a crate may not depend on a renderer
unless its name says so.**

| crate | depends on | responsibility |
|---|---|---|
| `hyperia-proto` | `serde` only | wire types, cell/colour/attr codec, normalisers. **No IO.** |
| `hyperia-client` | `tokio`, `tokio-tungstenite`, `vte` | four socket kinds, lifecycle, reconnect, PTY→grid parse |
| `surface-core` | `hyperia-proto` | `ContentSource`/`Surface` traits, glyph raster, dirty rects |
| `surface-lease` | `surface-core` | visibility-gated lease state machine, over an abstract probe |
| `room-descriptor` | `serde` | room/station/bay schema + GLB `extras` contract validation |
| `surface-render-<be>` | a renderer | texture alloc/upload, uv→cell hit-test. One per backend. |
| `ops-host` | `axum` | static serving, sidecar proxy, control WS, persistence |

`ops-host` is the only crate that binds a port. `surface-render-*` is the
only crate that touches a GPU. Everything else is `#![forbid(unsafe_code)]`
and unit-testable on a CI box with no display.

### 1.1 Core traits

```rust
/// Anything that can produce pixels for a surface.
pub trait ContentSource: Send {
    fn id(&self) -> &SourceId;
    /// Draw into `target`; return the regions that changed.
    fn paint(&mut self, target: &mut RasterTarget) -> DirtyRects;
    /// Latest logical size, for aspect and hit-test mapping.
    fn cell_extent(&self) -> Option<CellExtent>;
}

/// Anything that can display a raster. Implemented per renderer.
pub trait Surface {
    fn id(&self) -> &SurfaceId;
    fn raster(&mut self) -> &mut RasterTarget;
    fn commit(&mut self, dirty: DirtyRects);   // CPU buffer -> GPU texture
    fn powered(&self) -> bool;
}

/// How the lease broker learns whether a surface is worth streaming.
/// Deliberately NOT a camera: a headless recorder implements this too.
pub trait VisibilityProbe {
    fn measure(&self, surface: &SurfaceId) -> Visibility; // { visible, distance_m }
}
```

`VisibilityProbe` is the single most important abstraction in the port.
In `3dterminal` the equivalent logic is welded to `THREE.Frustum` and
`THREE.Box3` inside `broker.ts` (`measure`, `worldScreenBox`,
`boxFacesCamera` — `frontend/src/surfaces/broker.ts:219-243`). Behind a
trait, the lease machine becomes pure state + arithmetic and gets a
deterministic unit test suite. That is currently untestable here, and it
is exactly the code that produced our worst false-alarm debugging (see
§4.6).

### 1.2 The binding type — make the bug unrepresentable

```rust
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BaySource {
    Empty,
    Pane { id: PaneId },
    Tab  { id: TabId },
    Catalog { id: CatalogId },
}
```

This is non-negotiable and must be in from **commit one**. See §4.2 for
what the string-typed version cost us. A `String` field that sometimes
holds `"<uuid>"` and sometimes holds `"tab:<uuid>"` is a sum type that
the compiler was never told about, and every call site that forgot the
discriminator became a bug. Rust removes the entire bug class for free —
this alone justifies the port.

---

## 2. CONTRACT — async architecture

### 2.1 One task per stream, cancellation instead of generations

`stream.ts` implements a hand-rolled generation counter to ignore
messages from a socket that has been superseded
(`frontend/src/hyperia/stream.ts:42` — `if (generation !== session.generation ...) return`).
Every consumer must remember to check it; `broker.ts` carries a parallel
`focusedGeneration` field it never actually reads.

Rust replaces this with structural cancellation:

```rust
struct Lease {
    token: CancellationToken,
    task:  JoinHandle<()>,
    frames: watch::Receiver<Arc<GridSnapshot>>,
}
impl Drop for Lease {
    fn drop(&mut self) { self.token.cancel(); }
}
```

Dropping the lease cancels the socket task. A superseded task cannot
deliver a frame because it no longer exists. No counter, no discipline
required at the call site.

### 2.2 Parse off the render thread — the big win

Today the PTY byte stream is fed to an xterm-ish painter on the browser
main thread, in the same frame budget as the 3D scene. In Rust, the
socket task owns a `vte::Parser` and publishes **immutable grid
snapshots**:

```rust
// in the stream task
parser.advance(&mut grid, &bytes);
let _ = frames.send(Arc::new(grid.snapshot()));   // latest-wins
```

Channel choice by stream kind — this matters and is easy to get wrong:

| stream | channel | rationale |
|---|---|---|
| `/ws/pane/{id}` raw PTY bytes | **must not drop** — parse in-task | dropping bytes corrupts terminal state permanently |
| parsed grid snapshots | `watch` (latest-wins) | renderer only ever wants the newest |
| `/ws/wall` cell deltas | `broadcast`, lag = force resync | deltas are ordered; on lag, send `{t:"resync"}` |
| `/ws/pixels/{id}` JPEG | `watch` (latest-wins) | stale frames are worthless |
| `/ws/tab/{id}` | `watch` per pane rect | same as above, keyed by child pane |

The `broadcast` + lag → resync rule is the one place where dropping is
correct *and* recoverable, because the protocol has a resync verb
(`broker.ts:414-420`). Use it; do not silently skip deltas.

### 2.3 Threading model

Three thread classes, and a hard rule about what crosses between them:

- **Render thread** — owns GPU resources, `!Send` is fine here. Reads
  `watch::Receiver` non-blockingly once per frame.
- **Tokio runtime** — owns sockets and parsers. Never touches a GPU
  handle.
- **Rasteriser** — CPU-side glyph blit into `Vec<u8>` RGBA. May run on
  either; put it on the tokio runtime via `spawn_blocking` if a surface
  is large (the 1440×900 wall) and on the render thread if small.

Crossing rule: **only `Arc<GridSnapshot>` and `Arc<RasterBuffer>` cross
the boundary.** No `wgpu::Texture`, no window handle, no `Rc`. If a type
crossing the boundary is not `Send + Sync + 'static`, the design is wrong.

### 2.4 Back-pressure and the lease as a throttle

Leases are not an optimisation, they are the back-pressure mechanism.
With ~8 desk bays plus a wall, ungated streaming means 9 concurrent PTY
sockets at full rate for content nobody is looking at. The existing gate
is right and should port unchanged in behaviour:

- `focused` — dedicated socket, full rate. Acquire at ≤ 6 m **and**
  visible.
- `overview` — no dedicated socket at all; painted from the single shared
  `/ws/wall` feed. Class default is 2 fps (`broker.ts:143`) but the live
  construction overrides to **10** (`main.ts:34`).
- `none` — unpowered or unbound; nothing.

Hysteresis: acquire at 6.0 m, release at 8.5 m
(`broker.ts:141-142`). Hidden surfaces get a 400 ms grace before demotion
(`hiddenGraceMs`) so a camera whip-pan does not tear down every socket.
These three numbers are the whole tuning surface; expose them in config,
not constants.

---

## 3. WHAT WORKED

**3.1 Cell grids, not pixels, for terminals.** A `Cell` is
`(char, fg, bg, attrs)` (`frontend/src/hyperia/protocol.ts:2`). An 80×24
delta is a few hundred bytes; the equivalent JPEG is tens of kilobytes.
It is also resolution-independent, so the same feed drives a 256 px desk
monitor and a 4 K wall with no server-side change. Every attempt to shortcut
this with pixels regressed legibility. **Port verbatim.**

**3.2 One shared low-fps wall socket for all overview surfaces.** N
surfaces in overview cost one socket, not N (`ensureWallSocket`,
`broker.ts:468`). This is why the room can show eight live screens at
once without melting. **Port verbatim.**

**3.3 Hysteresis on the lease.** Acquire ≠ release distance. Without the
2.5 m band, a camera parked at the boundary thrashes sockets every frame.
**Port verbatim, and unit-test it** — with `VisibilityProbe` behind a
trait this becomes a 20-line test that is impossible to write today.

**3.4 Measuring visibility from the screen mesh only.** Not the station
subtree. `Box3.expandByObject` does *not* skip invisible children, so
once desk legs were hidden rather than removed, a subtree-based bbox kept
them in the sample and the gate flipped. `worldScreenBox`
(`broker.ts:76-95`) takes the mesh's own geometry AABB and nothing else.
A bounding *sphere* is also wrong — it puts the centre metres behind the
glass, so sitting 0.6 m from a screen measured as beyond `focusedDistance`
and never focused. **Port the rule: tight AABB of the display mesh, never
a sphere, never a subtree.**

**3.5 GLB `extras.semantic_role` as the asset↔runtime contract — as a
*design*, not as shipped.** ~~This survived a full re-author of the room
geometry without a code change.~~ **Retracted — Lane B is right and I was
wrong.** `semantic_role` appears in exactly four places in `frontend/src`
(`main.ts:1446`, `main.ts:1493`, `room-cleanup.ts:15`,
`floor-grid.ts:70`), all cosmetic. Loading is name-based: `RoomLoader`
indexes `node.name` and selects `presentationScreen` by name
(`room-loader.ts:28-35`); `main.ts:1472` hardcodes
`Wall_Screen_1..3`; `room-cleanup.ts:3` protects by name regex plus a
*legacy* role list (`floor`, `dais`, `screen.glass`,
`presentation.screen`) that does not include the canonical roles the
Blender pass actually writes (`room.shell`, `ceiling.main`,
`screen.surface`, `pedestal.*`). A correctly tagged, renamed node is
therefore **hidden**. The contract is authored and ignored. **Port the
idea, and make it load-bearing this time** — role index drives discovery,
names survive only in migration logs. Lane B owns the vocabulary.

**3.6 Room layout as a function of room shape.** `polar()` for circular
rooms, `grid()` for rectangular (`frontend/src/scene/layout.ts:25-47`),
plus `sampleSurfaceNormalAtStation` so a station's yaw is derived from
the wall it faces rather than authored per-room. This is what makes rooms
data instead of code. **Port; it is small and it is right.**

**3.7 Backend as a same-origin proxy.** `/hyperia-api/{*path}`
(`backend/src/main.rs:227`) means no CORS, one origin in dev and prod,
and the sidecar's address is a server config value rather than something
baked into the bundle. **Port.**

**3.8 Retained state on control-socket connect.** `/ws/v1/control` sends
current state immediately on connect rather than only on change
(`backend/src/main.rs:289-313`). A client that connects late is not
blind. **Port, and extend it to bay bindings** — see §4.5.

---

## 4. WHAT DIDN'T

This section is the point of the document. Do not port around these;
port *away* from them.

**4.1 The god file.** `frontend/src/main.ts` is 2,638 lines and holds
picking, HUD drawing, camera, bindings, tab streams, power state, and
persistence. Every good boundary listed in §3 exists in some small module
that `main.ts` then reaches around. Four agents editing that one file
concurrently produced merge damage repeatedly. **Rust mitigation:** the
crate graph in §1 makes the god file impossible — `surface-core` cannot
call into the renderer because it does not depend on it. Enforce with
`cargo-deny`/workspace deps, not with review.

**4.2 String-typed bindings — two production bugs.** A bay's binding is a
`paneId: string` (`frontend/src/state/store.ts:5`). Tabs were retrofitted
by encoding `"tab:<uuid>"` into that same field. Two call sites did not
know:

- `refreshSessionRaster` repaints the boot card for any powered bay with
  no `paneId` — and a tab-bound bay deliberately has none. The ~3 s
  topology refresh therefore painted boot straight over the live tab.
  User-visible symptom: *"showing a single pane after temporarily showing
  the image."*
- `connectPaneToMonitor` received the stored `"tab:<uuid>"` on restore and
  opened `/ws/pane/tab:<uuid>` — a URL that cannot exist.

Both were fixed with guards. Guards are the wrong fix; they must be added
at every future call site forever. **Rust mitigation: `BaySource` enum
(§1.2). The match is exhaustive, so the compiler finds every site.** This
is the single clearest reason to do the port in Rust at all.

**4.3 One field meaning two things.** `session.paneId` answers both
"what is this bay bound to?" and "what socket is currently open?". They
diverge legitimately — a bound-but-unleased bay, a tab-bound bay — and
every divergence was a bug. **Rust: split into `binding: BaySource`
(persistent, user intent) and `lease: Option<Lease>` (transient, derived).
Never serialise the second.**

**4.4 Repaint driven by a polling timer.** Authoritative content was
overwritten because an unrelated ~3 s topology refresh called a repaint
that did not know what was on the surface. **Rust: content invalidation
must be push-only, from the source that owns the pixels.** A timer may
mark *stale*; it may never *draw*. Encode it: `RasterTarget::commit` is
callable only from the surface's current `ContentSource`.

**4.5 Persistence in `localStorage` while a perfectly good server sat
idle.** `StateStoreV3` writes bay bindings to browser storage
(`frontend/src/state/store.ts:168`) — so state is per-browser, invisible
to the server, unavailable to any other client, and already on its third
hand-written migration (`loadAndMigrate`, `store.ts:174-246`) with a
fourth pending. Meanwhile `ops-room-server` already owns desk heights and
a control socket. **Rust: server owns bay state, client subscribes.
Version the schema and write real migrations with tests.** Do this at M2,
before there is data worth preserving.

**4.6 Visibility logic that could only be tested by flying a camera
around.** I twice reported the focused-lease path as broken — reporting
`focused=0, sockets=0` as a fault — when the camera was 12–28 m out and
`overview` was the correct answer. I dispatched another agent after a
phantom both times. The logic was right; it was *unobservable*. **Rust:
`VisibilityProbe` behind a trait turns this into a table test.** Cost of
not doing it: two wasted agent-days and two retractions.

**4.7 Verification that proved compilation, not rendering.** The
verification ritual across all agents was `tsc --noEmit` + `vite build`,
and every report said "clean". Both pass with a black screen. Several
features landed verified only this way. **Rust mitigation, and this is a
hard gate: `surface-core` must render to an in-memory RGBA buffer with no
GPU, and the test suite must assert on pixels** — golden-image tests for
a known grid, a known glyph run, a known dirty rect. If the port does one
thing this repo did not, make it this. Everything else on this list is
recoverable; an unobservable renderer is not.

**4.8 Canvas 2D `fillText` per cell, per frame.** No glyph atlas, no
batching, text metrics recomputed constantly. It survives because the
grids are small. At wall resolution it will not. **Rust: rasterise glyphs
once into an atlas** (`fontdue`/`swash` → R8 atlas), blit by rect. Lane B
owns the metrics, including the 0.6 glyph aspect the layout assumes.

**4.9 Missing `textBaseline` on a shared canvas context.** The
CONNECT TAB label rendered above its own box because `drawDeskHud` never
set `textBaseline` and the caller assumed a baseline convention the
canvas default did not provide. Trivial bug, real user-visible breakage,
and a direct consequence of "a mutable graphics context threaded through
a dozen drawing functions". **Rust: draw calls take an explicit
`TextAnchor`; no ambient mutable draw state.**

**4.10 Concurrent agents on shared mutable files with no lock.** Beyond
merge damage: agents reported success on code another agent had already
replaced. If the target project also runs multiple agents, give each a
crate, not a file range. The crate graph is the coordination primitive.

---

## 5. RUST NOTES — where the TS design does not translate

**5.1 `Blob`/`createImageBitmap` has no equivalent.** The pixels path
decodes JPEG via the browser's async image decoder
(`broker.ts:591-597`). In Rust use `zune-jpeg` or `image` on a
`spawn_blocking` — decode is 1–3 ms at 1440×900 and will visibly hitch a
render thread. Decode in the stream task, publish RGBA via `watch`.

**5.2 There is no main thread to hide on.** Browser code gets away with
"everything is single-threaded, so nothing races". Every shared mutable
in `broker.ts` (`views`, `overviewSubs`, `bindings`) becomes an explicit
ownership decision. Recommendation: **the broker is single-owner, driven
from the render loop, and communicates with the tokio side only through
channels.** Do not wrap it in `Arc<Mutex<_>>` — that reintroduces the
shared-mutable model with added deadlock risk.

**5.3 `performance.now()` → `Instant`.** Straightforward, but note the
lease machine compares monotonic timestamps in three places
(`hiddenSince`, `lastFocusAttempt`, `lastWallResync`). Pass a `now:
Instant` into the state machine rather than reading the clock inside it —
that is what makes §4.6's table test possible.

**5.4 WebSocket reconnect must be explicit.** The browser gave us
`addEventListener('close')` and we hand-rolled policy per socket, badly
and inconsistently (the wall reconnects after 1500 ms only if listeners
exist — `broker.ts:496`; focused sockets retry through
`ensureFocused` with a 350 ms floor — `broker.ts:324`). **One
reconnect policy, one place**: exponential backoff with jitter, capped,
in `hyperia-client`, identical for all four socket kinds. Cancellation
tokens make "should I still be retrying?" trivially answerable.

**5.5 Token lifetime is a real state machine, not a constant.**
`hyp_pane_*` tokens die with the sidecar; `hyp_agent_*` persist. Cost us
a debugging session. In Rust model it as
`enum Credential { Pane(..), Agent(..) }` with a refresh path, and have
`hyperia-client` re-auth on `{t:"error", code:"unauthorized"}` rather
than surfacing a dead socket. Lane A owns the exact codes.

**5.6 Anything Blender-adjacent stays out-of-process.** The asset
pipeline talks to Blender over MCP. Keep it a build-time step producing
GLB + a validated descriptor; the runtime should never need Blender
running. It repeatedly did not have Blender in the state it expected.

---

## 6. SEQUENCING

Each milestone has an **exit criterion that is not "it compiles"**.

| M | scope | exit criterion |
|---|---|---|
| **M0** | `hyperia-proto` | round-trip every recorded wall/tab message from a captured fixture; property-test the colour codec incl. `idx:0..255` |
| **M1** | `hyperia-client`, wall socket only | connect to a live sidecar, print a decoded 80×24 grid as text; survive a sidecar restart |
| **M2** | `surface-core` headless | render a known grid to PNG; **golden-image test in CI**; dirty-rect correctness test |
| **M3** | `ops-host` + `BaySource` + server-side persistence | bind a bay over the control WS, restart the server, binding survives; second client sees it |
| **M4** | `surface-lease` + `VisibilityProbe` | table test drives a synthetic camera through the hysteresis band and asserts the exact acquire/release transitions |
| **M5** | `surface-render-<be>` | one live pane on one quad, on screen, legible, at 60 fps |
| **M6** | `room-descriptor` + layout fns | load two room shapes (circular, rectangular) from JSON with **zero code change** |
| **M7** | `/ws/tab` composition | a tab with 4 panes composites correctly and **survives a topology refresh** — the §4.2 regression, as a test |

M0–M2 need no GPU and no sidecar for CI. M3 and M4 are where this repo's
two worst bug classes get designed out; do not reorder them later to
chase a visible demo. M5 is the first thing anyone can look at — that is
deliberate, and it is the correction to §4.7.

**Do not port `main.ts`.** Read it for behaviour, then reimplement
against the crate graph. It is the only file here with no salvageable
structure.

---

## 7. Open questions for the other lanes

- **Lane A:** is `/ws/tab` input injection authenticated separately from
  the read path? The port needs to know whether a read-only surface is
  expressible.
- **Lane A:** exact `{t:"error"}` code set, so §5.5 can auto-reauth.
- **Lane B:** full `semantic_role` vocabulary, and which roles are
  *required* for a room to load vs optional.
- **Lane B:** confirm the 0.6 glyph aspect is a font property or an
  arbitrary constant — it changes the atlas design.
- **Lane C:** does anything besides bays need the v4 `{kind,id}` shape
  (catalog entries, wall displays)? If so it is a shared type, not a bay
  type.
