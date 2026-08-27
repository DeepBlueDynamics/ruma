I read the code independently rather than taking your framing on faith. Short version: **you're right that it's over-coupled, but you've misdiagnosed which coupling actually hurts.** The magic numbers are a symptom. The real defect is that there is *no contract at all* between the Blender assets and the runtime — and a config file, by itself, will not create one. It will just move the magic numbers from `.ts` to `.json`.

---

# 1. Assessment of current architecture

## What actually exists

- `frontend/src/main.ts` — 1322 lines, one module, top-level mutable globals, three near-identical `GLTFLoader.load` callbacks, DOM + scene graph + WebSocket protocol + canvas rasterization + persistence + input all interleaved.
- `backend/src/main.rs` — 133 lines serving a **fake satellite telemetry simulation the frontend never consumes**. The frontend calls exactly one backend route: `/api/version`. `/ws/v1/simulation` and `/api/v1/snapshot` have zero clients.
- `frontend/src/hyperia/wall-client.ts` + the wall half of `protocol.ts` — **entirely dead**. Nothing imports `HyperiaWallClient`.
- `README.md` documents a "stable scene contract" (`Room_Huge_Screen_Face`, `Existing_Workstation_R{row}_{col}`) — **neither name exists in any asset the app loads.** The doc describes an architecture that was never built.

## The coupling points, ranked by actual damage

**(1) There is no asset↔runtime contract. This is the root cause.**

I dumped the GLBs. Every node's `extras` is empty; asset and scene `extras` are `None`. Blender authored *zero* metadata. So the runtime has no choice but to reverse-engineer geometry:

```ts
const controlWorld = new THREE.Vector3(center.x, topBounds.max.y + .012, topBounds.max.z - .14);   // :97
const viewTarget   = new THREE.Vector3(center.x, topBounds.max.y + .207, center.z + .072);         // :117
const viewPosition = new THREE.Vector3(center.x, topBounds.max.y + .81,  center.z + 1.163);        // :118
```

But those anchors **already exist in the asset and you ignored them.** `standing_desk_sim_master.glb` contains nodes named `Desk_CtrlDisplay`, `Desk_HandController`, and `CamTarget`. `curved_monitor_ultrawide.glb` contains `CurvedMon_Tilt_Pivot`, `CurvedMon_Height_Pivot`, `CamTarget`. The desk has `MonTiltNode_1..4` mount points. The code uses none of them — it computes bounding boxes and adds hand-tuned offsets to rediscover positions Blender already knows.

That is the failure. Not "constants are in TypeScript."

**(2) The wall-screen distortion was not a UV-space mistake — the meshes have no UVs.**

`Wall_Screen_1/2/3` have **no `TEXCOORD_0` attribute at all** (1116 verts each, POSITION + NORMAL only). Any texture assignment was always going to garbage. You reverted to a flat color, which is correct as a stopgap, but the fix is an authoring fix: cylindrically unwrap them in Blender and export UVs. No runtime code can rescue a mesh with no UV channel except a projection shader, and you shouldn't need one here.

Also worth knowing: those three arcs span x∈[-13.4, 13.8], z∈[-13.8, 13.8] — they wrap most of a circle. Your `PRESENTATION_SCREEN = (0, 2.8, -18.5)` (`:127`) corresponds to **no authored geometry**; at `scale 1.5` the shell radius is ~20.6 and `Wall_Screen_2`'s center is ~(-7.2, 6.2, -12.8). The desks are yawed toward an eyeballed point in space.

**(3) `room.scale.setScalar(1.5)` (`:519`) is not a config value — it's a bug to fix in Blender.**

It makes room units and desk units disagree, which is why every light coordinate (`:551-563`), the master reset plane (`:547`), and the camera poses (`:510`, `:788`) are unrelated magic numbers. Putting `1.5` in a JSON file preserves the incoherence. Re-export the shell at true scale.

**(4) Implicit global state instead of parameter passing.**

`targetPane`, `selectedMonitor`, `selectedDeskId` (`:8-10`, `:80`) are module globals that `connectFocused` reads implicitly (`:1114-1117`). The consequence is visible in `restoreStationConnections` (`:1060`), which has to *temporarily mutate `selectedDeskId`* and restore it afterward to reconnect other stations. It's also gated on `desks.size < 3` — a hardcoded station count in the restore path.

**(5) Persistence is four un-coordinated key families with drifting versions.**

`ops-room-monitor-targets-v1` (legacy, still written at `:1137`, effectively unread), `ops-room-station-${id}-v2`, `ops-room-selected-desk-v1`, `ops-room-circular-theater-camera-v2`. Station state is keyed by hardcoded station ID, so **any renaming or repositioning in a future config orphans user state silently.**

**(6) The streaming layer uses the wrong protocol mode and hardcodes the endpoint.**

`ws://localhost:9800` is inlined twice (`:1146`, `:1197`). `HYPERIA_EVENT_STREAM_API.md` explicitly targets a containerized consumer reaching `ws://host.docker.internal:9800`. This cannot deploy as designed, and cannot do TLS.

More importantly: the doc designs **wall mode** (`/ws/wall`, cheap cell-grid deltas for all panes) precisely for a monitor wall, and **focused mode** (raw PTY + 512KB scrollback replay) for walk-up inspection. You use `/ws/wall?fps=2` for topology discovery only, and open a **full focused stream with `scrollback=1` for every powered monitor** (`:1146`). Eight powered monitors = eight full PTY streams + eight scrollback replays + eight xterm.js instances. You built the expensive path everywhere and left the cheap path as dead code.

**(7) Duplication.** `standing_desk_sim_master.glb` (1.5 MB) is fetched and parsed **three times** (`:728`, `:806`, `:850`), with the `Desk_Wood_Top` material fixup copy-pasted three times, and `connectFocused`/`connectWebPanePixels` duplicating generation-guard/socket/power logic.

## Real bugs I found while reading

These are independent of the refactor and worth fixing regardless:

- **`RectAreaLight` is non-functional.** Seven of them are added (`:552`, `:562`) but `RectAreaLightUniformsLib.init()` is never imported or called — three.js requires it. Your ceiling illumination and screen spill contribute nothing. (They also don't affect `MeshBasicMaterial`, which you've switched most visible surfaces to.)
- **Shadows cover a 10m box in a 40m room.** `shadowMap.enabled = true` with a `DirectionalLight` at default shadow-camera extents (`:494-495`), while ~160 floor tiles have `castShadow` evaluated. Cost without benefit.
- **`probeFocusedDimensions` is dead.** It early-returns on `!paneLive` (`:1247`); `paneLive` is initialized `false` (`:598`) and never assigned. It runs on a 1s interval doing nothing.
- **The entire DOM HUD is dead.** `frame()` sets `panePicker.style.display = 'none'` **every frame** (`:1312`). `monitorTabs` is `[]` and never populated (`:23`), so its listeners no-op.
- **Machine-specific data in source.** Pane UUID `a9420527-ed3a-4750-b088-03b719495aef` is hardcoded in two filters (`:1086`, `:1275`), plus a `/Operations Command Room/i` title regex (`:1283`).
- Dead: `renderTerminal`, `applyRows`, `blankGrid`, `grid`, `cursor`, `ptyTerminal`, `activeCanvas`, module-level `facetEnabled`/`monitorShells` (shadowed by the per-station copy, which is never read).

---

# 2. Target design

**The governing rule, and my main disagreement with your plan: config must never contain a coordinate that Blender could have authored.** If you need a position, add an Empty in Blender and reference it *by name*. Config expresses *composition*; the asset expresses *geometry*. Violate this and you've built a second, worse Blender in JSON.

Three layers:

### Layer A — Asset contract (Blender is authoritative)

Blender's export script writes `extras` and named anchors. This is the API.

```jsonc
// node "Desk_CtrlDisplay" extras
{ "ops": { "role": "control-surface", "widthM": 0.38, "heightM": 0.20 } }

// node "MonTiltNode_2" extras
{ "ops": { "role": "monitor-bay", "bay": "2", "maxWidthM": 0.62 } }

// node "MonScreen_2" extras
{ "ops": { "role": "display-surface", "surface": "flat", "aspect": 1.6, "uvRect": [0,0,1,1] } }

// node "CurvedMon_Screen" extras
{ "ops": { "role": "display-surface", "surface": "cylindrical",
           "radiusM": 1.2, "arcDeg": 62, "aspect": 2.33 } }

// room: new empties
Station_Anchor_01..NN   → { "role": "station-anchor", "facing": "Wall_Screen_2" }
View_Overview           → { "role": "camera-pose", "fovDeg": 46 }
Light_Ceiling_Row_01..  → { "role": "light", "kind": "rect", "wM": 24, "hM": 2.2, "lumens": ... }
Wall_Screen_1..3        → { "role": "display-surface", "surface": "cylindrical", "group": "theater-wall", "span": [0,3] }
```

Every current magic number in `main.ts` becomes an authored empty. The `1.5` scale disappears into a correct export.

### Layer B — Descriptors (JSON, composition only)

```jsonc
// config/rooms/panoramic-theater.room.json
{ "schema": "ops-room/room@1", "id": "panoramic-theater",
  "shell": { "asset": "panoramic_command_theater_architecture" },
  "stations": [
    { "id": "ops-1", "label": "Operator Desk 1", "prefab": "standing-desk",
      "placement": { "anchor": "Station_Anchor_01" },
      "bays": [ { "bay": "2", "device": "builtin-flat" },
                { "bay": "3", "device": "builtin-flat" } ] },
    { "id": "ops-3", "label": "Operator Desk 3", "prefab": "standing-desk",
      "placement": { "anchor": "Station_Anchor_03" },
      "bays": [ { "bay": "1", "device": "curved-ultrawide", "widthM": 1.55 },
                { "bay": "3", "device": "flat-black-24" } ] }
  ],
  "wallDisplays": [ { "id": "theater-wall", "nodes": ["Wall_Screen_1","Wall_Screen_2","Wall_Screen_3"],
                      "mode": "spanned" } ],
  "views":    { "overview": { "anchor": "View_Overview" } },
  "lighting": { "profile": "theater-cool" } }
```

```jsonc
// config/prefabs/standing-desk.prefab.json
{ "schema": "ops-room/prefab@1", "asset": "standing_desk_sim_master",
  "controlSurface": { "node": "Desk_CtrlDisplay", "layout": "station-router" },
  "seatedView": { "node": "CamTarget" },
  "hideUnusedBays": true }

// config/devices/curved-ultrawide.device.json
{ "schema": "ops-room/device@1", "asset": "curved_monitor_ultrawide",
  "mount": "CurvedMon_Height_Pivot", "screen": "CurvedMon_Screen" }
```

Note what is *absent*: no coordinates, no yaw, no scale, no light positions, no camera vectors. Adding a fourth desk is one array entry plus one Empty in Blender.

### Layer C — Runtime (pure, injected, no globals)

```
config/     schema.ts, load.ts            — validate loudly; error names the file + JSON path
assets/     cache.ts                      — load-once + instance (clone materials for screens only)
            anchors.ts                    — resolve role/name → world matrix; throw naming the node
scene/      room.ts, station.ts, display.ts, lighting.ts, views.ts
content/    source.ts (interface), terminal.ts, pixels.ts, boot.ts, off.ts, control-surface.ts
surfaces/   flat.ts, cylindrical.ts       — content-rect → UV mapping, letterboxing
hyperia/    broker.ts                     — one wall connection; focused leased per display
state/      store.ts                      — one versioned namespace + migrations
input/      picking.ts                    — one raycast dispatcher, typed handlers
```

Two abstractions carry the weight:

**`DisplaySurface`** — owns the mesh, its UV/aspect mapping, and one `ContentSource`. Whether it's a desk monitor or a 60°-arc wall panel is a property of the surface, not a branch in the caller. This is what makes the wall screens tractable once they have UVs.

**`ContentSource`** — `{ attach(target: RenderTarget): void; detach(): void }`. `TerminalSource`, `PixelSource`, `BootSource`, `OffSource`, `ControlSurfaceSource` all implement it. The generation-guard/socket/power duplication collapses into `Display.setSource()`.

**Scope discipline: do not build an ECS.** One room type, under a dozen stations. Three descriptor types and eight modules is enough.

---

# 3. Migration that doesn't break the working room

The hard problem is that today's behavior is encoded *only* as tuned constants. Refactoring blind will break it. So:

**Phase 0 — characterization harness (do this first, it gates everything).**
Add a debug dump: for every station and display, emit id, world matrix, bbox, and camera pose to JSON. Capture it from the current build as `baseline.json`. Every later phase must reproduce it within epsilon. This converts "did I break the room?" from eyeballing screenshots into a numeric diff, and it's the only safe way to delete tuned constants.

**Phase 1 — extract, no behavior change.** Pull streaming/session/persistence out of `main.ts` into `content/`, `hyperia/`, `state/`. Constants stay inline. Add the asset cache (kills the 3× GLB load). Delete the dead code listed above. Baseline diff must be zero.

**Phase 2 — Blender authoring pass.** Add anchors and `extras` to the room and prefabs. **Seed the anchor transforms from the constants currently in `main.ts`** so the asset reproduces today's layout exactly. Re-export the shell at true scale (bake the 1.5). Unwrap `Wall_Screen_1..3`. Write the exporter as a committed script, not manual clicks — this contract must be reproducible.

**Phase 3 — config + loaders.** Introduce descriptors, drive the scene from them, delete the constants. Baseline diff ≈ zero (allow epsilon for the scale rebake).

**Phase 4 — persistence v3.** Single namespace `ops-room/v3`, shaped `{ rooms: { [roomId]: { camera, selectedStationId, stations: { [stationId]: { bays: [{ paneId, powered }], ... } } } } }`. Migration reads all four v1/v2 key families and remaps via an explicit `{ "operator-desk-1": "ops-1", ... }` legacy table. **Keep orphaned station blobs rather than dropping them** — a station absent from config today may return tomorrow. Add `bayId` to the record so reordering bays doesn't scramble pane assignments.

**Phase 5 — streaming correctness.** Endpoint from runtime config. Adopt wall mode for idle/distant monitors; lease focused streams only for displays that are powered *and* visible *and* above a screen-space size threshold; drop back to wall grid on zoom-out. Move the pane-exclusion filter from hardcoded UUID to config (`excludeSelf: true` matched by title pattern from config).

Streaming semantics to preserve verbatim through all phases: generation guards on every async callback, `scrollback=1` on focused connect, `resize` applied to the VT before subsequent bytes, ping→pong on both sockets, close→`returnMonitorToBoot`, and web panes routed to `/ws/pixels` rather than the PTY path.

---

# 4. Next steps, priority order

| # | Step | Why now | Size |
|---|---|---|---|
| 1 | Hyperia endpoint → runtime config; delete hardcoded pane UUID/title filters | Blocks the containerized deployment the API doc specifies; machine-specific data in source | XS |
| 2 | Asset cache (load-once + instance) | 3× 1.5 MB fetch/parse today; prerequisite for N stations | XS |
| 3 | Characterization harness + `baseline.json` | Gates safe deletion of every tuned constant | S |
| 4 | Fix the four real bugs: `RectAreaLightUniformsLib`, shadow-camera extents, dead DOM HUD, dead probe | Independent of refactor; lighting is currently just broken | S |
| 5 | **Blender anchor + `extras` pass, committed exporter script; true-scale shell; wall-screen UVs** | **Long pole. Everything downstream depends on it. Start it in parallel with 1–4.** | L |
| 6 | `Display` / `ContentSource` / `Station` extraction from `main.ts` | Removes globals and the connect-path duplication | M |
| 7 | Descriptor schema + validating loader | Only meaningful after 5 — without anchors it's magic numbers in JSON | M |
| 8 | Persistence v3 + migration | Must land with 7, before station IDs change | S |
| 9 | Wall mode + visibility-gated focused leases | Current design won't scale past a handful of powered monitors | M |
| 10 | Backend: serve `config/` from disk with hot reload; delete or feature-gate the satellite sim | Removes the rebuild loop for room edits; the sim is misleading dead weight | S |

**Start 1–4 and 5 concurrently.** Do not start 7 before 5 lands.

---

## The three claims of yours I'd push back on

1. **"The problem is hardcoded values in `main.ts`."** Partly. The deeper problem is that the assets carry no metadata, so *someone* has to invent coordinates. Move them to JSON without the Blender pass and you've gained nothing but a file boundary.
2. **"I treated a curved screen like a flat normalized UV."** The meshes have no UV channel whatsoever. That's an authoring gap, not a runtime mistake — and it means no amount of runtime code was going to work.
3. **"The live behavior works."** It works on your machine. It cannot run in a container (hardcoded `localhost:9800`), your ceiling lighting is inert (`RectAreaLight` uninitialized), shadows cover a quarter of the room, and a hardcoded pane UUID from your session is compiled into the bundle. Fix those before the refactor — they're cheap and they're real.
