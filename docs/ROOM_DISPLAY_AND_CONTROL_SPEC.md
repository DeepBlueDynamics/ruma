# Room Display and Agent Control Contract

Status: architecture baseline for the single-room prototype  
Date: 2026-08-14  
Owners: shared 3dterminal workspace

This document is the product contract for the next implementation pass. It
supersedes the current behavior where `Wall_Screen_2` automatically becomes a
wall of every Hyperia pane. That behavior confused three separate concepts:
the physical room displays, the physical desk HUDs, and the content that may be
routed to either kind of display.

## 1. Vocabulary and invariants

Use these names consistently in code, configuration, UI copy, and MCP tools.

| Term | Meaning |
| --- | --- |
| `Room` | One authored 3D environment. The current prototype has one room. |
| `RoomDisplay` | One physical wall display mesh in the room. The current room has exactly three: `Wall_Screen_1`, `Wall_Screen_2`, and `Wall_Screen_3`. |
| `Desk` | One physical operator station. A desk owns its local monitors and one local HUD. |
| `DeskMonitor` | One physical monitor belonging to exactly one desk. |
| `DeskHUD` | The router/control surface embedded in a desk. It changes that desk's selected monitor, power, and source assignment. |
| `HyperiaPane` | An external PTY or web-pane content source discovered through Hyperia. |
| `Terminal` | A stable logical content endpoint with declared connect/read/input capabilities. Its renderer or transport may change without changing its ID. |
| `LayoutSlot` | A configurable region within a `RoomDisplay`. Do not call this a pane; that collides with `HyperiaPane`. |

Hard invariants:

1. The three `RoomDisplay` objects are independent and independently powered.
2. A `DeskHUD` remains on its desk. It never silently becomes the content of a
   room display and never silently routes a selection to a room display.
3. A `RoomDisplay` can show different kinds of content over time. It is not a
   special-purpose Hyperia pane wall.
4. A room-display layout is data. The current three-desk arrangement is an
   initial configuration, not a hardcoded renderer.
5. Selecting content changes only the explicit destination. Power state and
   source assignment do not imply one another.
6. Interactive controls are painted on physical scene surfaces. No floating
   DOM widget is part of the product UI.
7. Geometry and semantic mesh identity come from the room asset. Composition,
   power, assignments, and view state come from configuration/runtime state.

## 2. Object hierarchy

```text
Room
├── roomDisplays[]
│   ├── RoomDisplay 1 -> Wall_Screen_1
│   ├── RoomDisplay 2 -> Wall_Screen_2
│   └── RoomDisplay 3 -> Wall_Screen_3
└── desks[]
    └── Desk
        ├── deskMonitors[]
        └── deskHud
```

`DisplaySurface` remains the low-level mesh/canvas/texture binding. It is not a
content controller and must not own desk state. The runtime store is the sole
owner of serializable room-display and desk state. `RoomDisplayController` and
`DeskController` own their surface/render/hit-test/stream lifecycles and dispatch
semantic commands to that store. Both may consume the same reusable
content-source adapters.

## 3. Room configuration

The singular `presentationScreen` property is replaced by a list. Mesh names
remain asset bindings; all behavior is addressed by stable application IDs.

```ts
type RoomConfig = {
  id: string;
  shell: { asset: string; scale: number };
  roomDisplays: RoomDisplayConfig[];
  desks: DeskConfig[];
  stationLayout: StationLayout;
  stationFacingSurface: { mesh: string } | { anchor: string };
};

type RoomDisplayConfig = {
  id: string;                  // room-display-1, -2, -3
  surface: { mesh: string; mapping: 'authored' | 'cylindrical' };
  defaultPowered: boolean;
  defaultConfiguration: RoomDisplayConfiguration | null;
  cameraAnchor?: string;
};

type DeskConfig = {
  id: string;
  label: string;
  prefab: string;
  monitorSlots: MonitorSlotConfig[];
  hud:
    | { kind: 'procedural-desktop' }
    | { kind: 'surface'; anchor: string };
};
```

The current room seed is:

- `room-display-2` / `Wall_Screen_2`: on and configured as exactly three equal
  sections. The left section is the registered local source `nav.solution`
  (`/assets/nav.solution.png`). The middle section is registered terminal
  `nav.route` (`/assets/nav.route.png`). The right section remains independently
  assignable; Hyperia discovery never changes the section count.
- `room-display-1` / `Wall_Screen_1` and `room-display-3` / `Wall_Screen_3`: off
  and unconfigured. Powering either on starts its setup flow on that physical
  screen.
- No room display defaults to `hyperia-overview` or renders every discovered
  Hyperia pane.

`stationFacingSurface` is a static asset/placement reference only. It replaces
code that used the singular presentation display for both desk orientation and
display content. Changing content or power on the corresponding display must
not move the desks.

## 4. Room-display state and content

Each room display has a minimal persisted core. Boot timing and an in-progress
setup draft are transient controller state. The visible phase is derived, so an
impossible combination such as `mode: layout` with no configuration cannot be
persisted.

```ts
type PersistedRoomDisplayState = {
  id: string;
  powered: boolean;
  configuration: RoomDisplayConfiguration | null;
};

type RoomDisplayConfiguration =
  | { kind: 'layout'; layout: RoomDisplayLayout }
  | { kind: 'single-content'; content: ContentBinding };

type RoomDisplayTransientState = {
  phase: 'steady' | 'booting' | 'editing';
  setupDraft?: RoomDisplaySetupDraft;
};

type RoomDisplayLayout =
  | {
      kind: 'grid' | 'columns';
      columns: number;
      slots: OrderedLayoutSlot[];
    }
  | {
      kind: 'freeform';
      slots: FreeformLayoutSlot[];
    };

type OrderedLayoutSlot = {
  id: string;
  content: ContentBinding;
};

type FreeformLayoutSlot = OrderedLayoutSlot & {
  rect: { x: number; y: number; width: number; height: number }; // normalized
};

type ContentBinding =
  | { kind: 'empty' }
  | {
      kind: 'desk-control';
      deskId: string;
      monitorIds: string[];
      representation: 'selectors' | 'live-miniatures';
    }
  | { kind: 'desk-monitor'; deskId: string; monitorId: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'hyperia-pane'; paneId: string }
  | { kind: 'local-content'; sourceId: string }
  | { kind: 'hyperia-overview'; filter?: HyperiaPaneFilter };
```

`hyperia-overview` preserves the existing video-wall work as an optional content
type. It is never an implicit default and is not the center display's initial
mode.

`nav.solution` is registered as terminal ID `terminal:nav.solution`, terminal
type `nav-solution`. Its current adapter is
`{ kind: 'placeholder-image', asset: '/assets/nav.solution.png' }`. The image is
not the terminal identity and must not leak into desk or room-display routing
logic. When the live terminal is implemented, its transport/renderer replaces
that adapter while all saved assignments keep the same terminal ID.

The placeholder declares `connect: true`, `read: true`, and `input: false`.
Reading it reports its definition, placeholder lifecycle, and current
connections; it does not invent telemetry that the future terminal has not yet
produced.

`nav.route` follows the same contract as terminal ID `terminal:nav.route`,
terminal type `nav-route`, with `nav.route.png` as its current placeholder-image
adapter. It appears automatically in every desk HUD because HUDs enumerate the
terminal catalog instead of naming individual images.

The browser control seam already uses terminal semantics:

```ts
await window.opsRoom.dispatch({
  kind: 'terminal.read',
  terminalId: 'terminal:nav.solution',
});

await window.opsRoom.dispatch({
  kind: 'terminal.connect',
  terminalId: 'terminal:nav.solution',
  target: {
    kind: 'desk-monitor',
    deskId: 'operator-desk-1',
    monitorId: 'monitor-1',
  },
});
```

The Rust MCP tools must delegate to these same commands through the renderer
control channel; they must not create a second terminal registry.

Layout validation requires unique slot IDs, valid referenced object IDs, valid
column counts, and—in freeform mode—normalized in-bounds rectangles with a
declared non-overlap policy. Grid/column rectangles are computed by the renderer;
they are not stored separately where they could disagree with the grid.

### Deferred companion-source composition

A physical room-display section will sometimes need to show its primary source
and one companion source together. The later composition mode must support at
least side-by-side and picture-in-picture presentation while preserving the
section's stable physical ID. The current picker assigns one primary source;
its persisted schema and controller boundary must remain evolvable to a
`primary + companion + layout` composition rather than treating single-source
content as a permanent limitation.

## 5. First-run setup on a room display

Powering on an unconfigured room display runs this setup entirely on that
physical surface:

1. Show a short, real boot state and then `DISPLAY NOT CONFIGURED`.
2. Ask how many desk-control sections the display should contain.
3. Select the desks for those sections from the room's configured desks.
4. For each selected desk, choose how many of that desk's monitors should be
   represented and select the monitor IDs.
5. Create exactly one `desk-control` slot per selected desk, preserving the
   selected `monitorIds` inside that slot.
6. Choose whether those monitor IDs appear as selectors or live miniatures.
7. Preview the resulting layout on the same display and confirm it.
8. Persist the configuration atomically and enter active layout mode.

The first implementation may use an even column/grid layout. The stored shape
must already be `RoomDisplayLayout`, so later freeform layout does not require a
state migration.

Choosing one direct desk monitor, Hyperia pane, local source, or overview is a
separate source-picker/reconfigure path. It is not mixed into the default
desk-section wizard. Counts are temporary UX constraints derived from the
selected desk and monitor ID arrays; counts are not persisted independently.

The draft is not live configuration until Confirm. Back edits the draft. Cancel
or power-off discards the draft; if the display was initially unconfigured, it
returns to off/unconfigured. Reconfigure Cancel restores the previous confirmed
configuration exactly. Configuring or assigning content while a display is off
never powers it on.

Powering off a configured display preserves its layout. Powering it back on
boots into that layout. A separate explicit `RECONFIGURE` action enters setup;
ordinary power cycling must not erase it.

A direct `hyperia-pane` room-display binding whose source temporarily disappears
renders `SOURCE UNAVAILABLE` inside its slot and preserves the confirmed layout
and binding so it can recover or be reconfigured. It never erases or powers down
a desk. This is intentionally different from a desk monitor's existing
boot/choose-source fallback when its assigned pane is removed from topology.

## 6. Desk HUD reuse and mirroring

The on-desk HUD and a `desk-control` room-display slot must be two views of the
same desk-control model, not unrelated canvas implementations and not a dead
bitmap copy.

```text
DeskController / DeskRouterViewModel
├── render(desk HUD surface)
├── render(room display slot, clipped to slot rectangle)
└── dispatch(semantic DeskAction)
```

Required desk actions include:

- select a desk monitor;
- toggle/hold-to-power that desk monitor;
- expand or collapse a Hyperia tab group;
- scroll the pane list;
- assign a selected Hyperia pane to the selected desk monitor;
- assign the registered local `nav.solution` source to the selected desk
  monitor.

HUD actions never move the camera. They change routing, selection, power, and
list state only. Human navigation comes exclusively from direct clicks on scene
geometry such as a desk, monitor, room display, or room-display content region.

Dispatching one of these actions through a room-display mirror updates the same
desk state as dispatching it on the physical desk HUD. It does not change the
room display's own power or replace the room display's layout. Showing a desk
monitor full-screen on a room display is a separate, explicit room-display
action.

Both views use the same semantic hit regions transformed into their own canvas
rectangle. Mirroring a desk monitor reuses its current frame/source lease; it
must not open a duplicate PTY or pixel socket merely because the same content is
visible on two surfaces.

## 7. Interaction routing

Every pointer interaction resolves to a stable object ID and then to a semantic
action:

```text
raycast -> SceneObjectRef -> controller.hitTest(uv) -> semantic action -> store
```

Priority is explicit:

1. desk monitor glass / desk HUD;
2. desk geometry;
3. room-display content surface;
4. room shell.

There is no global `presentationSurface` click path. Each room display registers
its own surface and hit regions. A room-display click is dispatched only to the
controller for the hit display.

Camera navigation is also semantic:

- click a desk -> focus that desk;
- click the already focused desk -> room overview;
- click a desk monitor -> open its close monitor view;
- click it again -> return to its desk view;
- click a room display -> focus that complete display;
- click a room-display slot -> focus or activate that slot according to its
  content type;
- double-click a room-display slot -> replace that slot temporarily with its
  on-surface source router; router actions never move the camera;
- all automated moves use the existing eased camera transition.

## 8. Durable state and migration

Rust owns the canonical, revisioned semantic configuration and command ordering.
The browser owns observed renderer facts: scene readiness, actual camera pose,
render health, and whether a camera transition has settled. The browser reports
those facts to Rust; it does not create a competing durable state model.

Use one versioned runtime document, rather than unrelated per-feature storage
keys:

```ts
type RoomRuntimeStateV1 = {
  schema: 'ops-room/state@1';
  revision: number;
  roomId: string;
  roomDisplays: Record<string, PersistedRoomDisplayState>;
  desks: Record<string, PersistedDeskState>;
  camera: PersistedCameraState;
  selection: PersistedSelectionState;
};
```

The one-time browser migration reads existing `ops-room-station-*-v2` desk state,
preserves valid monitor assignments and power state, submits that seed to Rust,
and records `ops-room/migrated/state@1/<roomId>`. Once Rust acknowledges the
canonical snapshot, it is the reload source of truth. A temporary local snapshot
may be cached only for offline startup and is explicitly marked stale.

The current automatic all-pane wall is not migrated as a display assignment
because it was accidental behavior, not user configuration.

## 9. Rust MCP control plane

The browser owns the live Three.js scene, so the Rust service cannot control the
camera by mutating server state alone. It hosts the canonical state, MCP endpoint,
command ledger, and a correlated browser control channel:

```text
MCP client/agent
    <-> Rust `/mcp`
    <-> command broker
    <-> browser `/ws/v1/control`
    <-> scene controllers and runtime store
```

The browser publishes a full observed scene snapshot after load and after every
semantic change. Rust forwards idempotent, set-style commands with a command ID,
optional expected revision, and expiry. The browser acknowledges `accepted`,
`applied`, `settled`, or `rejected`. Rust commits revision N+1 only after the
required acknowledgement; MCP must not report success when a command was merely
queued. Camera commands wait for `settled`; configuration and power commands
wait for `applied`.

The browser exposes the exact same boundary locally as a typed
`window.opsRoom` facade:

```ts
window.opsRoom.ready: Promise<void>;
window.opsRoom.snapshot(): OpsRoomSnapshot;
window.opsRoom.dispatch(command: OpsRoomCommand): Promise<OpsRoomCommandResult>;
```

This replaces the current late-created, ad hoc `window.opsDebug` object. It
provides an immediate inspection/control seam for Hyperia's web-pane tooling and
is also the only seam used by the Rust browser-control client. Debug access and
MCP therefore cannot develop different camera or display semantics. The facade
exists from bootstrap: pre-load snapshots report `sceneReady: false`, and
commands whose targets are not loaded reject with `target_not_ready` rather than
being lost.

Initial MCP resources:

- `room://panoramic-theater/state` - current room, camera, selection, display,
  desk, monitor, renderer, and source state;
- `room://panoramic-theater/catalog` - stable scene-object IDs and available
  actions;
- `room://panoramic-theater/content-sources` - validated assignable sources;
- `room://panoramic-theater/commands/{commandId}` - command outcome and audit
  details.

Initial MCP tools:

```text
room_inspect(roomId, include?)
room_set_view(target, transition, waitFor, ifRevision?)
room_activate(targetId, actionId, ifRevision?)
room_display_set_power(displayId, powered, ifRevision?)
room_display_configure(displayId, completeLayout, powerOn?, ifRevision?)
room_display_assign_content(displayId, slotId, content, ifRevision?)
room_display_clear_content(displayId, slotId, ifRevision?)
desk_monitor_set_power(deskId, monitorId, powered, ifRevision?)
desk_monitor_assign_pane(deskId, monitorId, paneId, ifRevision?)
terminal_read(terminalId)
terminal_connect(terminalId, target, ifRevision?)
room_command_status(commandId)
```

`room_activate` exists so an agent can perform the semantic equivalent of a
visible click. Agents should prefer deterministic `room_set_view` and explicit
set operations. Raw screen coordinates are diagnostic-only; durable automation
addresses objects and actions by ID.

The command channel is `/ws/v1/room-control`. Only one browser instance with the
matching room ID may hold the active renderer lease; extra instances are
observers. Full snapshots are preferred over patch reconciliation in the first
implementation. Camera pose telemetry is throttled and committed when movement
ends.

The control server is local-first and scoped to this application. It does not
proxy arbitrary Hyperia input or arbitrary JavaScript. Read calls remain
available while no browser is connected and are marked stale; mutation calls
return `no_live_renderer` rather than being silently queued.

Security requirements:

- use a distinct `OPS_ROOM_AGENT_TOKEN`, never the Hyperia agent token;
- default `OPS_ROOM_BIND` to `127.0.0.1`; binding externally is explicit;
- replace permissive CORS with configured origins and validate `Origin`/`Host`
  on `/mcp` and the renderer WebSocket;
- validate every object ID and content source against the registered catalog;
- never expose terminal bytes, arbitrary URLs, filesystem paths, or arbitrary
  browser code through room control;
- audit principal, command ID, target, revisions, outcome, and latency without
  recording credentials or terminal content.

Expected failures are structured and revision-safe: `no_live_renderer`,
`target_not_ready`, `revision_conflict`, `invalid_source`, `cancelled`, and
`indeterminate`. Duplicate idempotency keys return the recorded result without
executing twice. A newer camera move cancels an older unsettled move.

## 10. Module boundaries

The target structure is:

```text
frontend/src/domain/
  room.ts
  room-display.ts
  desk.ts
  content-binding.ts
  runtime-store.ts
frontend/src/display/
  surface.ts
  room-display-controller.ts
  room-display-renderer.ts
  desk-router-view-model.ts
  desk-router-renderer.ts
  sources/
frontend/src/interaction/
  registry.ts
  router.ts
  camera-controller.ts
frontend/src/control/
  protocol.ts
  browser-client.ts
backend/src/control/
  mod.rs
  broker.rs
  protocol.rs
  state.rs
  command.rs
  ws.rs
backend/src/mcp/
  mod.rs
  tools.rs
  resources.rs
backend/src/auth.rs
```

`main.ts` becomes composition/bootstrap code. It loads the room descriptor,
creates the controllers from data, and wires shared services. It does not own a
hardcoded presentation screen, desk count, monitor count, or content policy.

## 11. Delivery order

1. Baseline the current asset/object metadata and freeze this contract.
2. Introduce `RoomRuntime`, stable object IDs, semantic commands, the typed
   registry, and `window.opsRoom` without changing visuals. Route existing
   physical clicks through that command path.
3. Add `/ws/v1/room-control`, the active renderer lease, full state snapshots,
   revisions, and acknowledgement handling. Add `/mcp` with `room_inspect`,
   `room_set_view`, and `room_activate`. This is the first usable control slice
   and lets an agent inspect the real scene and move the real camera.
4. Replace singular `presentationScreen` with three `RoomDisplayConfig` entries;
   bind a controller/surface for each. Seed center configured, sides off.
5. Replace the center's automatic video wall with the configurable three-desk
   control layout. Keep `VideoWallController` only as optional
   `hyperia-overview` content.
6. Extract the desk router view model/actions and render it both on desks and in
   `desk-control` room-display slots.
7. Implement and verify the on-surface room-display setup flow and the remaining
   display/monitor MCP tools.
8. Migrate runtime state to Rust authority, move bootstrap logic out of
   `main.ts`, remove or make debug-only the floating `#status`, `#reset-view`,
   and `#pane-picker`, and proxy Hyperia transports through the backend.
9. Build, test, and verify all three displays, persistence/isolation, and
   agent-driven camera/display control in the live Hyperia web pane.

The MCP layer and the physical UI must call the same `RoomRuntime.execute`
implementation. Neither is allowed to invent a second state or action model.

## 12. Acceptance checks

The implementation is not complete until these are demonstrated in the live
scene:

1. The room registry reports three distinct room displays, each bound to the
   correct `Wall_Screen_*` mesh.
2. On a clean `ops-room/state@1` state, display 2 has exactly three equal
   sections, with `nav.solution` contained in the left third and `nav.route` in
   the middle third; the two side room displays are black/off. No all-pane
   mosaic appears.
3. Powering on a side display shows its on-surface setup flow. Configure it with
   two desks and selected monitor slots; reload; the same configuration returns.
4. A pane selection made in a mirrored desk control changes only the selected
   monitor on that desk. No neighboring monitor goes black or powers on/off.
5. The same desk state is visible and operable from its physical HUD and its
   room-display mirror.
6. Any room display can be deliberately switched to one desk monitor, one PTY,
   one web pane, or an optional overview without affecting the other displays.
7. A missing Hyperia pane returns the bound desk monitor to its real boot/choose
   source state. It does not resurrect a stale assignment.
8. A room display directly bound to a missing pane shows `SOURCE UNAVAILABLE`,
   preserves its confirmed layout, and recovers without changing any desk.
9. `room_set_view` moves the live browser camera to room overview, every desk,
   every desk monitor, and every room display, then returns an acknowledged
   settled state revision through MCP.
10. `room_inspect` exposes the room, all three room displays, all desks, and every
   desk monitor with stable IDs and valid actions.
11. `window.opsRoom.snapshot()` returns the same revision and object identity as
    the MCP state resource; dispatching through either path has the same result.
12. Powering any desk monitor or room display on/off neither assigns nor clears
    its content; powering off suspends the stream lease and powering on resumes
    the preserved assignment when its source still exists.
13. Setup Cancel and power-off discard only the draft; Confirm applies the
    complete layout atomically. A configured-off display retains its layout
    through power cycles and reloads.
14. Physical and mirrored HUD pointer mapping dispatch the same semantic action.
    All three curved room surfaces pass edge/corner hit tests, and a desk/HUD hit
    always wins over a wrapping wall behind it.
15. Switching content disposes its obsolete socket/animation work. Mirroring one
    desk monitor on a room display opens no duplicate source stream.
16. Invalid IDs, stale revisions, duplicate commands, and renderer disconnects
    produce the structured failure behavior above without an unintended state
    revision.
17. Reducer transition, layout validation, setup atomicity, and legacy station
    migration have pure automated tests. Migration preserves all valid desk
    monitor state and refuses to migrate the accidental all-pane wall.
18. No product control appears as a floating HTML widget.
19. Clicking the `nav.solution` wall section frames that exact left third;
    clicking `nav.solution` on a desk HUD assigns it to the selected desk
    monitor without moving the camera.
20. `terminal_read('terminal:nav.solution')` reports placeholder state and all
    current wall/desk-monitor connections. `terminal_connect` routes it by
    stable terminal and target IDs without depending on the PNG filename.
21. The authored Blender room and exported GLB omit `Dais_Navy_Seal` and all
    three `Wall_Screen_*_Lower_Plinth` objects. `Wall_Screen_1..3`, their frames,
    light rails, curved geometry, UV mapping, and content state remain intact.
22. Clicking any desk monitor preserves its current source and stream lease; it
    changes only the camera/active monitor selection. No HUD action initiates a
    camera transition.
23. Desk HUD topology includes the Operations Command Room tab and its web pane
    by their current Hyperia IDs, with no hard-coded legacy tab UUID. The room
    display overview still excludes the simulator's own pane to prevent an
    accidental self-mirroring wall feed.
24. The logical terminal `terminal:nav.war` uses `warnav.png` as its temporary
    `placeholder-image` adapter, appears in every desk HUD, and can be assigned
    to any desk monitor without moving the camera.
25. Double-clicking any section of `Wall_Screen_2` opens that section's router
    inside the curved screen texture and eases the camera into a centered view
    of that same section. Selecting a terminal or Hyperia pane updates only that
    section, persists across reload, closes the router, and does not move the
    camera; a single click retains its navigation behavior.
26. The far-right desk's separately loaded curved and small monitors are placed
    from desk-local anchors and remain rigid children of that desk regardless
    of room/display asset load order. They cannot detach toward the room origin.
27. A production build change automatically reloads an already instrumented
    WebPane. The Rust server retains the latest 500 browser info/warn/error
    records at `GET /api/client-logs`, including an explicit right-desk monitor
    placement diagnostic after both monitor assets attach.
28. A compact, non-interactive system-load readout remains visible in the top
    right corner. It reports rolling FPS, average and maximum frame time, long
    frames, renderer draw calls/triangles, GPU resource counts, shader programs,
    and Chromium JS heap when available. Its severity color follows measured
    frame health, and it publishes a throttled `system-load-snapshot` through
    `/api/client-logs` so performance regressions can be inspected without
    relying on a visual guess.
29. Every station hides exactly the eight authored `Desk_Foot_*`,
    `Desk_LegUpper_*`, `Desk_LegSleeve_*`, and `Desk_SupportArm_*` meshes at
    runtime; `MonSleeve_1..4` remain visible. The work surface, physical HUD,
    and all stock or custom monitors share `Desk_Height_Pivot`, preserve X/Z
    station placement, and restore a persisted absolute height in the
    0.65–1.25 m range. `window.opsDebug.setDeskHeight(deskId, metres)` and the
    retained `/ws/v1/control` `deskHeight` command produce the same result.

## 13. Explicit non-goals for this slice

- Multiple rooms.
- Arbitrary drag-and-drop layout editing.
- Streaming every pane merely because Hyperia discovered it.
- Re-authoring the three wall meshes in Blender; their current semantic roles
  and cylindrical display surfaces are sufficient for this software pass.
- Giving MCP arbitrary shell, browser-JavaScript, or raw Hyperia control.

## 14. Open review points

These are the only product choices still open to correction before phase 3:

1. Whether selecting a desk-monitor miniature should temporarily zoom that slot
   inside the existing layout or replace the entire room display until Back.
2. Where the physical power/reconfigure affordance belongs in the authored
   screen bezel. It must remain in-scene and per-display.

Everything else above is treated as a required invariant.

## 15. Meadowlark review and proposed ownership

Slight Meadowlark should review this contract before either agent edits the
shared display runtime again. Requested answers:

1. Does the center seed preserve exactly three sections with `nav.solution` in
   the left third, without treating Hyperia discovery as display composition?
2. Do the setup flow and `desk-control.monitorIds` capture the user's intended
   “how many desks / how many monitors / which monitors” configuration?
3. Are any existing display, HUD, or camera behaviors missing from the
   acceptance list?
4. Does Meadowlark disagree with any sole-state-owner, power/source-isolation,
   or click-routing invariant? If so, give a concrete counterexample before
   editing code.

Proposed work split after that review:

- Codex owns `RoomRuntime`, stable object registry, `window.opsRoom`, Rust
  command broker/MCP, state migration, and integration tests.
- Meadowlark remains read-only during that foundation pass. If the user asks it
  to resume implementation, it may own the room-display canvas renderer and
  on-surface setup views behind the frozen runtime interfaces; it must not edit
  camera, desk power, source-session, or Rust control code.
- `main.ts` is not a shared scratchpad. One writer integrates composition after
  module-level work passes its tests.
