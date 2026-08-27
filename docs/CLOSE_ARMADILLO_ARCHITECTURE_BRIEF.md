# Independent architecture review: 3dterminal room configurability

Cloudy Marlin’s confession is directionally right and still too narrow. The failure is not “three desk IDs live in `main.ts`.” The failure is that **there is no domain model**. The demo is a working collage: one 1,322-line entry point, three copy-pasted loaders, a stale README contract, an unused Hyperia client, and a SATCOM backend that does not participate in the scene.

I do **not** recommend a generic scene editor, a backend-owned layout, or baking app behavior into GLBs. That would be the opposite overcorrection.

---

## Verdict

| Claim | Assessment |
|---|---|
| Rooms/stations are not configurable | **True.** One room, three special-case stations, all compiled into `frontend/src/main.ts`. |
| Demo behavior works | **Mostly true** for orbit + desk HUD + PTY/web assignment + power + local persistence. |
| Rectangular texture on concave wall was the wall-screen bug | **Incomplete.** `Wall_Screen_1/2/3` have **no UVs at all** (`POSITION`+`NORMAL` only). Distortion was inevitable. |
| Assets are dumb meshes, so config must own everything | **False.** The desk/monitor GLBs already have assemblies, screen faces, pivots, and `CamTarget`. The theater already has light empties. The runtime ignores them. |
| Backend should become the room source of truth | **False for layout.** The Rust server is a leftover SATCOM ticker. Do not put 3D composition there. |
| “Preserve input” | **There is no Hyperia input path.** Focused mode is documented read-only. The 3D client only scrolls the HUD. Do not “preserve” a feature that does not exist. |

---

## 1) Current coupling and failure points

### 1.1 `main.ts` is the product

Everything that should be a module is a closure in one file:

- renderer / orbit camera / three camera languages
- room load + `scale.setScalar(1.5)`
- three independent `GLTFLoader` desk recipes
- HUD canvas + hit testing
- monitor power / boot / PTY / web-pixel sessions
- Hyperia discovery (`/ws/wall`, `/hyperia-api/status`, undocumented `panes`)
- persistence
- lighting
- master reset

`frontend/src/hyperia/wall-client.ts` and `protocol.ts` exist and are **not on the live path**. Discovery and focused sockets are inlined. `protocol.ts` does not know about `screen-snapshot`, `panes`, web panes, or `/ws/pixels/{id}`.

### 1.2 Three station recipes, not three instances

All three desks load the same `standing_desk_sim_master.glb`, then diverge in code:

| Station | Monitors | Recipe |
|---|---|---|
| `operator-desk-1` | 2 | Hide `Monitor_Assembly_[14]`, bind `MonScreen_2/3` to **global** `texture`/`secondTexture` |
| `operator-desk-2` | 4 | Keep all four stock screens, local sessions |
| `operator-desk-3` | 2 | Hide all four assemblies, then `addDisplay()` with magic widths/offsets onto `curved_monitor_ultrawide.glb` + `monitor_black.glb` |

Desk 1 is still on the old dual-monitor globals (`monitorSessions`, `monitorTargets`, `facetEnabled`, `monitorShells`). Desk 2/3 are not. That is leftover prototype state, not a station type.

### 1.3 Layout is a pile of world-space numbers

Live constants in `main.ts` (they have already drifted once during this inspection):

```123:132:frontend/src/main.ts
const PRESENTATION_SCREEN = new THREE.Vector3(0, 2.8, -18.5);
const DESK_ARC_POSES = {
  'operator-desk-1': { x: 0, z: 7.0 },
  'operator-desk-2': { x: -5.8, z: 6.15 },
  'operator-desk-3': { x: 5.8, z: 6.15 },
} as const;
```

These numbers are **post-`1.5` room scale**. Change the shell scale and the arc, reset button `(16.8, 13.05, -19.53)`, ceiling lights, wall wash, and screen spill all go stale together. Yaw is derived from a fake look-at, not from an authored socket.

Three different “overview” cameras already exist:

- load/reset/reset-view: `(17.7, 9.9, 19.2)` → `(0, 3.15, 0)`
- `focusRoom()`: `(11.8, 6.6, 12.8)` → `(0, 2.1, 0)`
- seated view: derived from the **procedural HUD plane**, not from `CamTarget`

### 1.4 README contract is dead

README still specifies:

- runtime asset `huge_ops_command_room.glb`
- `Room_Huge_Screen_Face` with normalized UVs
- `Existing_Workstation_R{row}_{column}`
- `MonScreen_1`–`4` as the integration API

What actually runs:

- `panoramic_command_theater_architecture.glb`
- `Wall_Screen_1/2/3` (no UVs)
- desks instanced in TS, not present in the room GLB
- `huge_ops_command_room.glb` **does** have a 28×8 m UV’d quad (`Room_Huge_Screen_Face`) and **does not** contain any workstations

So the “stable scene contract” was a previous architecture that was abandoned in place. Anyone implementing against the README will bind the wrong room.

### 1.5 Assets already have the hooks the code reimplements

**Desk** (`standing_desk_sim_master.glb`):

- `Standing_Desk_Master` → `Desk_Height_Pivot` → `Monitor_Assembly_1..4` → `MonTiltNode_*` → `MonScreen_*` (quads **with** UVs)
- `CamTarget` at `(0, 1.25, 0)`
- `Desk_CtrlDisplay` — this is the **hand-controller LCD**, ~5 cm, not a desktop HUD. Do not hijack it.

**Displays:**

- `CurvedMon_Screen`: 98 verts, **has** `TEXCOORD_0` (curve was authored correctly)
- `Monitor_ScreenFace`: UV’d quad

**Theater:**

- `Wall_Screen_1/2/3` + frames + plinths
- empties `Area_Cool_Fill`, `Screen_Cyan_Spill`, `Screen_Warm_Spill` (posed, unused)
- **no cameras, no extras, no desk sockets, no KHR_lights**
- 160 unique floor-tile meshes (5×32). That is a performance/authoring smell, not a config problem.

**Zero** `extras` on any inspected node. Naming is the only contract, and the runtime does not even use the useful names (`CamTarget`, light empties, assemblies as visibility units except as regex hide lists).

### 1.6 Hyperia is glued on sideways

Documented v1 (`HYPERIA_EVENT_STREAM_API.md`):

- `/ws/wall` — topology + cell-grid frames/deltas
- `/ws/pane/{id}` — raw PTY, read-only
- input explicitly out of scope (“use MCP `terminal_keys`”)

What the client actually does:

- wall socket used as a **pane directory**, not to texture the wall
- focused PTY bytes → offscreen xterm → canvas texture
- web panes → undocumented `ws://localhost:9800/ws/pixels/{id}?w=&h=&fps=12`
- HTTP topology via Vite `/hyperia-api` proxy
- **WebSocket URLs bypass the proxy** and hardcode `localhost:9800`
- a specific pane UUID is filtered out in two places
- `restoreStationConnections()` waits for `desks.size < 3` — a third desk is a load-bearing invariant
- `probeFocusedDimensions()` keys off `paneLive`, which is never set true. Dead.

Wall-mode cell rendering (`renderTerminal` / `applyRows`) is leftover and unused on the live path.

### 1.7 Persistence is room-blind and dual-keyed

Live keys:

- `ops-room-station-${id}-v2` — targets, power, selected monitor, HUD scroll
- `ops-room-selected-desk-v1`
- `ops-room-circular-theater-camera-v2`
- leftover `ops-room-monitor-targets-v1` still written on PTY connect

Station IDs are stable today, which is why restore works. A second room, a renamed desk, or a monitor-count change will silently collide or drop assignments.

### 1.8 Backend is not in this architecture

`backend/src/main.rs` is a 250 ms SATCOM snapshot loop (`ASTER-9K` / `MERIDIAN-2` / `RELAY-7`) plus static file serving. The frontend never consumes `/api/v1/snapshot` or `/ws/v1/simulation` except `/api/version` for the boot splash. Putting room JSON here “because we have a Rust server” would couple the wrong owner to the wrong data.

### 1.9 What I will not call a failure

- Per-monitor `generation` + socket close on power-off is the right session isolation.
- Web-pane JPEG path separate from PTY is correct.
- Seated camera derived from operator-side + HUD is a reasonable fallback when seat anchors do not exist.
- Leaving wall screens dark after the UV disaster was the right tactical call.

---

## 2) Target architecture (and what I reject)

### What to build

A **prefab + instance** model, not a sandbox:

```
Catalog (reusable, versioned)
  DisplayType     stock-quad | curved-uw | desktop-black | wall-segment
  StationPrefab   desk asset + slots + default HUD/seat policy
  LightRig        how to bind empties / procedural lights
  Interaction     hud | reset | display-focus

Room (one instance document)
  shell asset + scale + named views
  station instances (prefab + pose or socket)
  display bindings (slot → DisplayType)
  wall displays
  lights (bind-by-name and/or explicit)
```

Runtime is a **composer**, not a scene file:

1. Load catalog + selected room document.
2. Load shell; collect anchors/sockets/empties.
3. Spawn station prefabs into sockets or explicit poses.
4. Bind display slots to screen meshes + `MonitorSession`.
5. Bind lights and named cameras.
6. Hand live session/assignment state to a separate store.

Hyperia stays an **adapter**. A display has a `source` at runtime (`none | pty | web-pixels | wall-grid | local-canvas`). Room config never contains pane UUIDs.

### What I reject

| Temptation | Why not |
|---|---|
| Full ECS / editor | One room, three stations. You need a spawn function, not Unity. |
| Backend-owned layout | Nothing 3D lives in Rust today. Assignments can move later; poses should not. |
| “Just put it all in the GLB” | Then every layout tweak is a Blender export, and pane/power/camera-user-state gets baked into art. |
| “Just put it all in JSON” | Then every artist move of a screen or light requires a parallel number edit. That is how `1.5` + `z: -18.5` happened. |
| Revive `Existing_Workstation_R*_` as the API | That contract never existed in the current theater, and `huge_ops` does not contain those nodes. |
| Use `Desk_CtrlDisplay` as the desk HUD | Wrong mesh, wrong size, wrong place. |
| Drive the panoramic wall with `/ws/wall` cell grids | Wall meshes have no UVs; wall-mode is low-fidelity. Wall content is a **display type** with its own projection, not “the same canvas as a 27-inch panel.” |

### Preferred split of authority

| Concern | Owner |
|---|---|
| Mesh, UVs, pivots, physical size, screen shader slot | Blender / GLB |
| Socket / anchor **pose** (where a desk sits, where a seat is, where a light aims) | Blender empty, referenced by name |
| Which prefab fills a socket, which displays a station has, which views exist | Room document |
| Pane assignment, power, HUD scroll, selected desk | Runtime store (localStorage now; optional backend later) |
| PTY / pixels / topology | Hyperia adapter |
| SATCOM / sim | Unrelated; do not block this work |

If a second author wants to rearrange desks in Blender, they move sockets. If a second author wants a 4-monitor vs curved pair, they change the station instance’s prefab/slots. Neither touches `main.ts`.

---

## 3) Config / schema and runtime boundaries

Do **not** start with JSON Schema in the backend. Start with TypeScript types that the current theater can be expressed in losslessly. Serialize later, when a second room exists. A typed module is a schema.

### 3.1 Catalog (stable)

```ts
type Vec3 = [number, number, number];

type DisplayType = {
  id: string;                     // 'stock-quad' | 'curved-uw' | 'desktop-black' | 'wall-segment'
  asset?: string;                 // omit = use mesh already in parent
  screenMesh: string | RegExp;    // CurvedMon_Screen, Monitor_ScreenFace, /^MonScreen_\d+$/
  projection: 'uv' | 'cylinder' | 'none';
  canvas: { width: number; height: number };
};

type StationSlot = {
  id: string;                     // 'm1'..  stable for persistence
  display: string;                // DisplayType.id
  // Either bind an authored assembly...
  assembly?: string;              // Monitor_Assembly_2
  screen?: string;                // MonScreen_2
  // ...or attach a separate display prefab onto an anchor
  attach?: { anchor: string; widthM?: number; localPosition?: Vec3 };
};

type StationPrefab = {
  id: string;
  asset: string;
  ground: 'origin' | 'bounds-min-y';
  seatAnchor?: string;            // empty name; fallback: derive
  hud: 'procedural-desktop' | { mesh: string } | 'none';
  slots: StationSlot[];
};

type View = {
  id: string;
  kind: 'orbit' | 'seat' | 'focus-display';
  position?: Vec3;
  target?: Vec3;
  fov?: number;
  fromAnchor?: string;
};
```

### 3.2 Room document (the thing that replaces the constants)

```ts
type RoomDoc = {
  id: 'panoramic-theater';        // persistence namespace
  version: 1;
  shell: { asset: string; scale: number };
  views: View[];                  // 'overview', 'reset' must be one named view — they are currently two
  lookAt?: { object?: string; position?: Vec3 }; // optional; prefer socket yaw
  stations: Array<{
    id: string;                   // 'operator-desk-1'  KEEP these IDs
    prefab: string;
    socket?: string;              // preferred
    position?: Vec3;              // escape hatch
    yaw?: number | 'toward-lookAt';
  }>;
  walls: Array<{
    id: string;
    mesh: string;                 // Wall_Screen_2
    display: 'wall-segment';
    projection: 'cylinder';
  }>;
  lights: Array<
    | { bind: string; type: 'rect' | 'point' | 'spot'; intensity?: number }
    | { type: 'hemisphere' | 'directional'; ... }
  >;
  interactions: Array<{ id: 'master-reset'; anchor?: string; position?: Vec3 }>;
};
```

Current theater becomes **data**, not code. Desk 3 is a prefab `desk-curved-plus-secondary` with two attach slots, not a third loader.

### 3.3 Runtime modules (cut `main.ts` along these lines)

```
main.ts                         bootstrap only
config/catalog.ts
config/rooms/panoramic-theater.ts
scene/RoomLoader.ts             shell, scale, named-node index
scene/StationSpawner.ts         one function for all desks
scene/DisplayBinder.ts          screen mesh → CanvasTexture + userData
scene/LightBinder.ts
scene/ViewController.ts         named views; kill the three overview poses
scene/Interaction.ts            raycast, HUD hits, reset
session/MonitorSession.ts       power, generation, canvas
session/AssignmentStore.ts      persist/restore, room-scoped
hyperia/protocol.ts             complete the real wire types
hyperia/discovery.ts            wall + /status, no UUID special cases in callers
hyperia/pty-session.ts
hyperia/web-pixels.ts
hud/DeskHud.ts
```

**Invariant:** Hyperia modules must not import Three. DisplayBinder must not import WebSocket. AssignmentStore must not import GLTF.

### 3.4 Persistence schema (do this in the same PR as the loader)

```ts
// key: ops-room/${roomId}/stations-v3
type RoomSaveV3 = {
  version: 3;
  selectedStationId: string;
  stations: Record<string, {
    selectedSlot: string;         // 'm1' not index 1
    expandedTabId: string;
    hudScroll: number;
    slots: Record<string, { paneId: string; powered: boolean }>;
  }>;
};
```

Migrate `ops-room-station-operator-desk-*-v2` on first load. Keep slot ids `m1..m4` aligned with current monitor indices so assignments survive. Camera key becomes `ops-room/${roomId}/camera`. Drop `ops-room-monitor-targets-v1`.

`restoreStationConnections` must wait on **“all configured stations spawned”**, not `desks.size < 3`.

---

## 4) Blender metadata vs external config

### Use empties for spatial truth. Use config for meaning.

Add empties, not logic:

| Empty | Role |
|---|---|
| `Socket_Station_C` / `_L` / `_R` | Where a desk instance is planted |
| `Anchor_Seat` | Seated camera position (local to desk) |
| `Anchor_Look` | Seated look-at |
| `Anchor_Hud` | Optional; only if you stop using the procedural desktop HUD |
| `Light_Area_Cool_Fill` (already `Area_Cool_Fill`) | Bind, do not re-place |
| `Cam_Overview` | Replace the two competing overview vectors |

Convention: **name prefix is the API**. Optional `extras.ops = { role, id }` later if names collide. Do not put pane IDs, power, Hyperia URLs, FOV policy, or “this is monitor 2 of operator-desk-1” in extras.

### Display meshes

A mesh is a display **only** if it is listed in a slot or has `extras.ops.role = "screen"`. Name matching (`MonScreen_*`, `CurvedMon_Screen`, `Monitor_ScreenFace`) is a catalog default, not app behavior.

### Wall screens

Do **not** paint `Wall_Screen_*` until they have a projection:

1. **Preferred:** author cylindrical UVs on the three segments (or one unwrapped ribbon). Then they are a normal `uv` display.
2. **Acceptable:** add child `Wall_Screen_*_Content` meshes that *are* UV’d, leave architecture as dark glass.
3. **Reject:** runtime `CanvasTexture` on a mesh with no `TEXCOORD_0`. That is the bug you already shipped.

`huge_ops` `Room_Huge_Screen_Face` is already a UV’d quad. That room is a good **second** room to prove the loader, not a reason to keep the README contract.

### What not to bake

- Desk IDs, monitor counts, Hyperia pane maps
- Master-reset hit behavior
- Room scale `1.5` as a Blender export (keep scale in the room doc; better: re-export the shell at final size and delete the runtime multiply)

Re-exporting the theater at 1.5× and deleting `setScalar(1.5)` is a one-time hygiene win. Every light and socket then lives in one space.

---

## 5) Staged migration (preserve the live demo)

Golden-path checklist to run after **every** stage:

- Desk 1: two stock screens; power on/off; long-press off; boot splash; assign PTY; assign web pane; persist across reload
- Desk 2: four screens, same
- Desk 3: curved + black, same
- Topology refresh does not drop live sockets
- Missing pane returns that monitor to boot (`reconcileMonitorSources`)
- Master reset clears power + assignments, does not break Hyperia discovery
- Seated / focus / overview cameras still feel the same

### Stage 0 — Freeze the demo, stop the bleeding (half day)

- Stop adding room numbers to `main.ts`.
- Write the current theater as a typed `RoomDoc` **without changing spawn**. Prove the document can describe what exists.
- Screenshot + the checklist above.
- Kill dead UI: `#pane-picker` is forced `display:none` every frame; `facetToggle` is desk-1-only; `monitorTabs` is empty.

### Stage 1 — One `spawnStation()` (1–2 days) — **highest leverage**

Replace the three loaders with one function driven by `StationPrefab` + instance pose.

- Desk 1 must stop using global `monitorSessions` / `texture` / `secondTexture`.
- Visibility of `Monitor_Assembly_*` becomes slot data (`hiddenAssemblies` or “only show slotted assemblies”).
- Desk 3 attach math (`width 1.55 / 0.66`, offsets `-.36 / .88`) moves into the prefab.

**No Hyperia changes.** Persistence keys stay `operator-desk-1..3`.

This is the actual architectural fix. If this lands and nothing else does, a fourth desk is a data change.

### Stage 2 — Extract Hyperia without changing wires (1 day)

- Complete `protocol.ts` for real messages (`meta`, `resize`, `screen-snapshot`, `replay-end`, `panes`, pixel `meta`).
- `discovery.ts` owns wall + `/status`; delete the hardcoded UUID from callers (put “ignore this pane/title” in a small filter list if you must).
- `pty-session.ts` / `web-pixels.ts` take a `MonitorSession` + URL factory.
- Route WS through the Vite proxy (`/hyperia-ws`) so `localhost:9800` is not compiled in.
- Do **not** auto-send `resync` the way the unused `HyperiaWallClient` does.

Leave `/ws/wall` as discovery until wall displays exist. Do not feed cell-grids onto `Wall_Screen_*`.

### Stage 3 — Assignment store + room-scoped persistence (half day)

- v2 → v3 migrate, then read/write only v3.
- Restore when **configured station count** is ready, not `=== 3`.
- Camera namespaced by `roomId`.

### Stage 4 — Views and lights from data + empties (1 day)

- One `ViewController`. `reset`, `overview`, and `focusRoom` must share a named view (today they disagree).
- Bind `Area_Cool_Fill` / `Screen_*_Spill` before adding more numeric lights.
- Master reset becomes an interaction with an anchor; until an empty exists, keep the coordinate in the room doc.

### Stage 5 — Wall display type (only after UVs or content meshes)

Separate surface, cylinder unwrap, optional wall-grid or a dedicated “situation” canvas. Not a Stage 1 blocker.

### Stage 6 — Second room as proof

Load `huge_ops_command_room.glb` as `rooms/huge-ops.ts` with one UV’d wall and the same desk prefabs. If that requires editing `StationSpawner`, the abstraction is still wrong.

**Do not** port SATCOM, first-person Rapier, or `satcom-ops-room.html` geometry in this sequence. README build-order items 2–3 are a different product. Rapier is in the lockfile via some leftover and not a direct dependency — ignore it.

**Do not** add 3D→PTY input in this sequence. If you want it later, it is a Hyperia capability (`terminal_keys` or a future stream write channel), attached to the focused session, never to the room doc.

---

## 6) Highest-priority next implementation steps

In this order. Anything else is decoration.

1. **`StationPrefab` + single `spawnStation()`** that reproduces desks 1–3 bit-for-bit (including desk 3 attach). This is the only step that makes “configurable” real.
2. **Move desk 1 off the global dual-canvas path** as part of (1). Until that dies, “one session model” is a lie.
3. **Persist slot ids, not array indexes**, and migrate v2. Cheap, and it is the thing that will break users when you refactor.
4. **Extract Hyperia session/discovery** so room work cannot regress PTY/web/power. Proxy the sockets.
5. **Collapse cameras into named views** in the room doc. Delete `PRESENTATION_SCREEN` once sockets or explicit yaws exist.
6. **Author theater sockets + seat anchors**, then delete `DESK_ARC_POSES`. Do not invent a light config language before binding the empties you already exported.
7. **Fix wall UVs or add content surfaces.** Do not retry canvas-on-`Wall_Screen_*` first.

### Explicit non-goals for the next week

- JSON Schema / YAML room editor
- Backend snapshot of the 3D scene
- First-person controller
- SATCOM domain crate
- Baking assignments into GLB extras
- Using `/ws/wall` frames as the panoramic texture
- “Input” into Hyperia from the 3D view

---

## Challenges to the other review

If the other write-up says any of the following, I disagree:

- **“Put room config in Axum.”** Wrong owner. The server does not load GLBs and does not know about monitors. At most it can later store `RoomSaveV3`.
- **“Discover workstations by walking `MonScreen_*` / README names.”** That cannot describe desk 3, and it cannot describe the theater. Slots are explicit.
- **“Bake station layout into the room GLB as meshes.”** Then every desk variant is a new room export. Instances + sockets scale; mega-scenes do not. You already have unused wood-species desk GLBs in the repo root that cannot be used until stations are prefabs.
- **“The wall bug was just a bad texture.”** The meshes have no UVs. Fix authoring or add a content mesh.
- **“Use `CamTarget` / `Desk_CtrlDisplay` as-is.”** `CamTarget` is a single point at 1.25 m, not a seated pose. `Desk_CtrlDisplay` is the height-controller LCD. Derive seat from new empties; keep the procedural desktop HUD until an authored HUD mesh of the right scale exists.
- **“Configurable means a user-facing layout editor.”** No. Configurable means a fourth station and a second room do not require editing the entry point.

The demo is allowed to stay a demo. It is not allowed to keep accumulating world-space numbers in `main.ts`. Stage 1 is the cut.
