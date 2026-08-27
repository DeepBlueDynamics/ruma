# Project Report — Operations Command Room

**Date:** 2026-08-20
**Revised:** 2026-08-25 — several findings have since been fixed; see §0
**Scope:** `/workspace/3dterminal` — full-project engineering assessment
**Basis:** direct inspection of the working tree this session, plus four
independent agent lanes that produced `RUST_PORT_SPEC.md`

---

## 0. Remediation log — 2026-08-25

Findings acted on after this report was first written. Original text is left
intact below with a status marker; nothing has been deleted.

| Finding | Action | Status |
|---|---|---|
| §5.12 No version control | Two commits created: a baseline snapshot of the whole tree, then the cleanup. `.mcp.json*` and `.nemesis8.toml` excluded — the `.bak` carried a live Hyperia agent token, which was removed from all git objects before it could persist. | **Fixed** |
| §6 The verification gap | `vitest` added. `console.assert` replaced with throwing assertions. `npm test` is now `tsc --noEmit && vitest run`. 11 checks, mutation-tested to confirm they fail with exit 1. | **Fixed (partially — see below)** |
| §6 No rendering test | Still absent. Nothing observes what the scene draws. | **Open — now the top item** |
| §5.11 Stale README | Rewritten against the real scene contract, real routes read from `backend/src/main.rs`, and the real test command. | **Fixed** |
| Dead code (not in original report) | `noUnusedLocals` / `noUnusedParameters` enabled. 26 dead symbols removed, −190 lines. | **Fixed** |
| Dev server bound to localhost | `vite.config.ts` now binds `0.0.0.0`, reachable from a container host. | **Fixed** |
| §5.1 Stringly-typed bindings | Untouched. Needs the tagged union from `RUST_PORT_SPEC.md` §4. | **Open** |
| §5.2 – §5.10 | Untouched. | **Open** |

Two things surfaced during remediation that were not in the original report:

**A live credential was one commit away from being tracked.** `.mcp.json.bak`
in the project root contains `Bearer hyp_agent_…`. It was staged by the first
`git add -A`, caught by a pre-commit credential scan, removed by amend, and the
loose object purged with `git gc --prune=now`. It is now git-ignored. The token
itself still sits in plaintext in the working tree and **should be rotated** —
being ignored is not the same as being safe.

**The BSP tile packer was orphaned, and the test documented the version that no
longer exists.** `packTabTiles` was rewritten at some point to lay panes out as
uniform full-width rows, discarding the BSP rects entirely; `rectKey`,
`quantize`, `isFullTabRect`, `autoGrid` and `TabStream.rects` were all left
behind, and the doc comment still described the packing it no longer did. This
was invisible precisely because the assertions could not run — the moment they
could, the first execution failed on it. The tests were rewritten to assert the
invariants that survive a strategy change (every pane keeps a tile, no two tiles
collide, nothing leaves the box) plus one check that pins the current strategy
so a future change has to be deliberate. **The BSP-faithful layout was not
restored — that is a product decision, not a cleanup.**

---

## 1. What this project is

A browser-based 3D operations room. A Blender-authored GLB is loaded by a
Three.js client, which binds live canvas textures onto named display
meshes and streams real terminal content into them from a Hyperia sidecar
over WebSockets. A Rust/Axum server serves the bundle, proxies the
sidecar, and owns a small amount of authoritative state.

The genuinely novel part is not the room. It is that **real, interactive
terminal sessions render as first-class objects inside a 3D scene** —
eight desk monitors plus a curved wall, each leasing live streams only
when someone is close enough to read them.

That part works. Most of the rest is scaffolding around it in varying
states of completion.

---

## 2. Status at a glance

| Dimension | State |
|---|---|
| Git history | ~~**Zero commits.** 88 untracked entries~~ → 2 commits on `master`, full tree tracked (2026-08-25) |
| Frontend | 7,498 lines TypeScript across 29 modules |
| Backend | 435 lines Rust, one file |
| Binary assets | ~68 MB (19 MB GLB, 49 MB PNG) — now committed to plain git; git-lfs unavailable in this container and no remote exists yet |
| Design docs | 13 markdown files, ~500 KB |
| Automated tests | ~~**Effectively zero**~~ → 11 checks under `vitest`, verified to fail on regression. No rendering test — see §6 |
| Last build | `frontend/dist` current as of 2026-08-19 20:09 |
| Backend process | not running at time of writing |
| Hyperia sidecar | up — 1 window, 2 tabs, 3 panes |

Two numbers worth sitting with: there is **more design documentation than
Rust code by an order of magnitude**, and there is **no version control
history whatsoever** for ~68 MB of irreplaceable Blender-authored assets.

---

## 3. Architecture as built

```
Blender (.blend) ──build script──▶ .glb + extras ──▶ frontend/public/assets
                                                          │
Hyperia sidecar :9800                                     ▼
  /ws/wall      cell-grid deltas, all panes ──▶ ┌──────────────────┐
  /ws/pane/{id} raw PTY bytes ────────────────▶ │  StreamBroker    │
  /ws/pixels/{id} JPEG ───────────────────────▶ │  lease gating    │
  /ws/tab/{id}  BSP layout + demuxed frames ──▶ └────────┬─────────┘
                (bypasses the broker entirely)           │
                                                         ▼
ops-room-server :8080                          canvas → CanvasTexture
  static · /hyperia-api proxy                   → display mesh
  /ws/v1/control · /api/v1/desk-height
```

### Module inventory

| Module | Lines | Assessment |
|---|---|---|
| `main.ts` | **2,638** | God file. 96 functions. Picking, HUD, camera, bindings, tab streams, power, persistence |
| `display/video-wall.ts` | 1,010 | Wall compositor. Hardcoded to 4 sections in 3 separate loops |
| `hyperia/tab-stream.ts` | 636 | `/ws/tab` client. Self-contained and good |
| `surfaces/broker.ts` | 611 | Lease engine. The best-designed file in the project |
| `scene/celestial.ts` | 311 | Decoration. Uses `Math.random` |
| `state/store.ts` | 246 | localStorage persistence, third hand-written migration |
| `display/surface.ts` | 246 | Cylindrical UV unwrap, orientation derivation. Strong |
| 22 others | 1,810 | Mostly small and coherent |
| `hyperia/wall-client.ts` | 32 | **Dead code** — zero importers |

`main.ts` is 35% of the frontend. Nearly every good boundary in the other
28 modules exists, and `main.ts` reaches around it.

---

## 4. What works

**The lease engine.** Visibility- and distance-gated streaming with
hysteresis at 6 m acquire / 8.5 m release and a 400 ms hidden-grace. One
shared 10 fps wall socket multiplexes every distant screen; only screens
you are close enough to read get a dedicated socket. This is why eight
live terminals do not melt the client. It is the most carefully reasoned
code here, and its comments record the bugs it was hardened against.

**Cell-grid streaming.** Terminals travel as `[char, fg, bg, attrs]`
tuples, not pixels. An 80×24 delta is a few hundred bytes and is
resolution-independent — one feed correctly drives a 256 px desk monitor
and a 4 K wall. Full 256-colour and attribute support.

**Cylindrical UV unwrapping.** Curved wall screens had no authored UVs.
The runtime generates them seam-safely — `atan2` about the segment's own
mean direction, so arcs crossing ±π stay continuous — and derives
physical aspect as `radius × span / rise`, which is what keeps terminal
text proportional on a curved surface. This is real, non-obvious
geometry work and it is correct.

**Tab composition.** A whole Hyperia tab, with its BSP split layout,
composites onto a single monitor with per-pane demuxed frames, correct
handling of terminal and web panes, and auto-gridding for panes the
sidecar reports stacked at full-tab rects.

**Asset caching.** One parse per URI with shared in-flight promises;
per-instance material cloning so live textures do not bleed across desks.

**Same-origin sidecar proxy.** `/hyperia-api/*` works identically in dev
and production, so the client never learns the sidecar's address.

**Room layout as a function of room shape.** `polar()` for circular
rooms, `grid()` for rectangular, with station yaw derived by sampling the
normal of the wall each station faces. Small, pure, and right.

---

## 5. What does not work

Ranked by cost, not by how hard they are to fix.

### 5.1 Bindings are stringly-typed — four bugs from one missing type
A monitor's source is a `String`. It holds three different kinds: a pane
UUID, a tab as `"tab:"+uuid`, and a catalog image as `"terminal:"+id`.
Four independent call sites each had to remember the discriminator, and
each one that forgot became a user-visible bug:

1. The boot card painting over a live tab on every ~3 s topology refresh
2. `/ws/pane/tab:<uuid>` — a URL that cannot exist — opened on restore
3. Reconcile erasing live tab bindings on the first successful poll
4. Wall cell-grids painting over a tab-owned canvas

All four have local guards now. Guards are the wrong shape: they must be
re-added at every future call site, forever.

### 5.2 The asset contract is authored and ignored
Every GLB node carries a `semantic_role` in its `extras`. The runtime
reads it in **four** places, all cosmetic. Loading is name-based:
`RoomLoader` indexes `node.name`, `main.ts` hardcodes `Wall_Screen_1..3`,
and `room-cleanup.ts` hides everything not matching a name regex plus a
*legacy* role list that omits the canonical roles the Blender script
actually writes. **A correctly tagged but renamed node gets hidden.**

This is the finding I personally got wrong — I had recorded the role
contract as the project's strongest design, having watched it survive a
room re-author. A partner agent disproved it against the code. The idea
is sound; the wiring was never done.

### 5.3 The room descriptor is theater
`RoomDescriptor` declares stations, wall displays, and camera views.
`RoomLoader` consumes `shell` and `presentationScreen` — nothing else.
The real configuration lives in a separate TypeScript constant.
Validation checks three fields. The descriptor was built to absorb
per-room change and never absorbed any, which is a direct cause of §5.6.

### 5.4 Two of three authored wall screens are unwired
All three get UVs. Only `Wall_Screen_2` becomes a display surface; the
other two get dark materials. Wall composition is hardcoded to four
sections in three separate loops with a hardcoded persistence key.

### 5.5 Tabs sit outside the lease engine
The broker's `getAssignment()` returns `null` for tab-bound bays, so the
gate that exists to refuse unwatched sockets never sees the newest and
most expensive source kind. A tab-bound monitor 40 m away holds a 12 fps
compositor socket indefinitely.

### 5.6 `main.ts` is a 2,638-line god file
Every architectural boundary in the project exists in some small module
that `main.ts` then routes around. It is also the file four concurrent
agents edited simultaneously, repeatedly, with merge damage.

### 5.7 State lives in the wrong process
Monitor bindings persist to `localStorage` — per-browser, invisible to
the server, invisible to a second client, on its third hand-written
migration, with a v1 key still being written — while the Rust server sits
idle already owning desk heights and a control socket.

### 5.8 Four reconnect policies, none good
Wall: 1500 ms flat, and only if someone is subscribed. Focused: 350 ms
floor, infinite, no cap or jitter. Tab: **no retry at all**. Control
socket: 1 s / 3 s. Plus a dead `wall-client.ts` that echoes `resync`,
which can loop against a confused sidecar.

### 5.9 No socket authentication
The client attaches no token to any of the four WebSockets and relies on
anonymous reads. The moment the sidecar sets `requireToken`, every
upgrade 401s and the room goes blind while the sidecar is perfectly
healthy.

### 5.10 Rendering performance is unbudgeted
Full-canvas repaint per frame; glyphs via `fillText` in nested per-cell
loops with no atlas and no dirty-row upload; PTY content rasterised
twice. It survives because the grids are small. It will not scale to
wall resolution. Separately, decoded JPEG frames can present out of
order under load.

### 5.11 The README describes a scene that no longer exists — **FIXED 2026-08-25**
Its "stable scene contract" names `Room_Huge_Screen_Face` and
`Existing_Workstation_R{row}_{col}`. Both appear **zero** times in
`frontend/src`. The build order it lists is largely superseded.

### 5.12 No version control — **FIXED 2026-08-25**
Zero commits. Every fix described in this report exists only as
uncommitted working-tree state, alongside ~68 MB of untracked Blender
sources and exports with no LFS configuration. A single bad `git clean`
or container reset loses the project.

---

## 6. The verification gap

This deserves its own section because it caused most of the rest.

`package.json` declares:

```json
"test": "tsc --noEmit"
```

**The test script is the typechecker.** There is no test runner and no
test framework in the dependency tree.

There is exactly one test file, `frontend/src/tests/architecture.test.ts`
— 138 lines, ten genuinely well-chosen assertions covering bay
normalisation, grid row shapes, colour mapping, name-vs-title precedence,
and tab tile packing. It is:

- **never imported by any module** (verified: zero importers)
- built on `console.assert`, which neither throws nor exits non-zero

So those ten good assertions have never run, and could not fail a build
if they did.

The consequence ran through the whole project. The standard verification
ritual across every agent working here — including me — was
`tsc --noEmit` + `vite build`, reported as "clean". **Both pass with a
black screen.** Multiple features landed verified only that way. At least
two rendering regressions reached the user because compilation success
was mistaken for correctness.

This is the single highest-leverage thing to fix, and it is cheap: a real
runner, the existing ten assertions wired to it, and one headless
render-to-PNG golden test.

**Update 2026-08-25 — half done.** The runner exists: `vitest`, throwing
assertions, `npm test` = `tsc --noEmit && vitest run`, 11 checks green and
mutation-tested (flip one colour constant in `protocol.ts` and the suite exits
1). On its very first real execution it caught a live inconsistency — see §0.

**The render test is still missing, and it is now the top open item.** Every
check in the suite is a pure-function check. Nothing yet observes a single
pixel, so the failure mode that actually reached the user — a black screen that
typechecks and builds — remains undetectable by CI.

---

## 7. Process observations

The project has been built by several AI agents working concurrently in
Hyperia panes against a shared working tree. That is genuinely productive
— but this session produced clean evidence of its failure mode.

**Concurrent writes to shared files silently destroy work.** While
producing the port spec, two agents independently wrote the same lane
file; one overwrote the other, and the loss was invisible until I
compared line counts. The same pattern previously caused merge damage in
`main.ts` and agents reporting success against code another agent had
already replaced.

**Agents cannot reliably identify themselves.** Two panes misidentified
which lane they owned despite explicit assignment by pane name. Assigning
work by *artifact* rather than by *identity* fixed it immediately.

**Unverifiable code produces confident wrong reports.** I twice reported
the lease engine as broken — `focused=0, sockets=0` — when the camera was
12–28 m away and `overview` was the correct answer, and dispatched
another agent after a phantom both times. The logic was right; it was
*unobservable*. Behind a testable interface it would have been a
twenty-line table test.

The structural lesson, now recorded in the port spec: **give each agent a
module boundary, not a file range.** The dependency graph is the
coordination primitive.

---

## 8. Risk register

| Risk | Severity | Note |
|---|---|---|
| Total loss of uncommitted work | **Critical** | Zero commits, 68 MB untracked binaries, no LFS |
| Stringly-typed bindings regress again | High | Four guards, no type-level protection |
| Sidecar enables `requireToken` | High | Room goes blind instantly; no client-side token path |
| Renderer regressions ship unnoticed | High | No test can observe rendering |
| Room re-author hides tagged nodes | Medium | Name-based cleanup contradicts the role contract |
| Performance cliff at wall resolution | Medium | No glyph atlas, double rasterisation |
| localStorage schema migration #4 | Medium | Each has been hand-written and untested |

---

## 9. Recommendations

**Immediately, before any further feature work:**

1. ~~**`git init` is already done — now commit.**~~ **DONE 2026-08-25.**
   Committed. LFS could not be configured — `git-lfs` is not installed in
   this container and there is no remote yet; `.gitattributes` marks the
   patterns to migrate before the first push. **Rotate the Hyperia agent
   token in `.mcp.json.bak`** — it is git-ignored now, but still plaintext
   on disk.
2. **Wire the ten existing assertions to a real runner** (`vitest`), make
   `npm test` fail on failure, and add one headless render-to-PNG golden
   test. Cheapest possible fix for §6. — **HALF DONE 2026-08-25:** runner
   wired and mutation-verified; **the render test is still missing and is
   now the single highest-leverage open item in this report.**

**Next:**

3. Replace the stringly-typed binding with a tagged union — `Empty |
   Pane | Tab | Catalog` — and let the exhaustiveness check find every
   call site. Removes bug class §5.1 permanently.
4. Move binding and power state to the server, over the existing control
   socket, with a versioned schema and a tested migration.
5. Bring tabs inside the lease engine as a first-class stream kind.
6. Make the role index actually drive asset discovery; keep names for
   migration logs only. Fixes §5.2 and §5.4 together.
7. One reconnect policy — exponential backoff with jitter and a cap — for
   all four sockets.
8. ~~Rewrite the README against the scene that exists.~~ **DONE 2026-08-25.**

**Strategic:**

The port spec (`RUST_PORT_SPEC.md`, synthesised from four independent
lanes this session) argues that the valuable, portable asset here is not
the 3D room but the **surface compositor**: decode → visibility-gate →
rasterise → upload, with a binding layer. A Rust port structurally
eliminates §5.1 and §5.6 — the type system makes the binding bug
unrepresentable, and a crate graph makes a god file impossible. If a port
happens, `BaySource` and golden-image tests belong in commit one, not in
a cleanup pass.

---

## 10. Document inventory

| Document | Size | Status |
|---|---|---|
| `RUST_PORT_SPEC.md` | 24 KB | Current — merged port plan |
| `PORT_SPEC_LANE_A.md` | 21 KB | Current — wire protocol |
| `PORT_SPEC_LANE_B.md` | 31 KB | Current — scene & raster |
| `PORT_SPEC_LANE_C.md` | 24 KB | Current — bindings & leases |
| `PORT_SPEC_LANE_D.md` | 21 KB | Current — Rust architecture |
| `ROOM_DISPLAY_AND_CONTROL_SPEC.md` | 30 KB | Recent, largely current |
| `HYPERIA_EVENT_STREAM_API.md` | 11 KB | Sidecar's stated intent; client has diverged |
| `SILKY_RAVEN_ARCHITECTURE_BRIEF.md` | 17 KB | Historical (2026-08-13) |
| `CLOSE_ARMADILLO_ARCHITECTURE_BRIEF.md` | 23 KB | Historical (2026-08-13) |
| `TRON_SCENE_PLAN.md` | 9 KB | Historical |
| `ANTIGRAVITY_PLAN.md` | 8 KB | Historical |
| `README.md` | 3 KB | **Stale — describes a superseded scene** |

---

## 11. Bottom line

The hard, novel part of this project works: live terminals stream into a
3D room with sensible resource gating, correct curved-surface text, and
real tab composition. Several individual files — the lease broker, the UV
unwrap, the tab client — are genuinely good work.

What is missing is not capability. It is **the machinery that makes
capability durable**: version control, tests that can observe what the
software actually renders, and types that encode the invariants people
keep forgetting. All three gaps have the same signature — they let
confident, plausible, wrong work pass as finished.

Two commits and one test runner would change the project's risk profile
more than any feature on the roadmap.
