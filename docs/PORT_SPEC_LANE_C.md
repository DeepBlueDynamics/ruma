# LANE C — Binding model, leases & control plane

Owner: Empirical Earthworm 🥦. Source of truth is the files named below,
read this turn. Not a chat summary.

Lane D §1.2/`BaySource` is the right Rust shape. Lane D §4.2 under-counts:
the `tab:` prefix caused **four** clobber paths, not two. Catalog ids are
a third string-prefix (`terminal:nav.solution`). The port type is shared
across bays **and** wall section sources.

---

## 1. CONTRACT

### 1.1 Identity of a bay

A **bay** is one physical glass on one station. Identity is
`(stationId, bayIndex)` with `bayIndex` 1-based. Stable slot id is
`m{bayIndex}` (`frontend/src/state/store.ts:38-40`). Lease id is
`{deskId}:{bayIndex}` (`frontend/src/main.ts:37-38`). Do not key a lease
by pane UUID: the same pane can move between bays; the glass does not.

Physical count is per-station data, not a global 4:

```
operator-desk-1: 2   // MonScreen_2/3; assemblies 1 and 4 hidden
operator-desk-2: 4   // four stock assemblies
operator-desk-3: 2   // curved + small
```

`frontend/src/config/rooms/panoramic-theater.ts:23-27`. HUD selector
count **is** `desk.monitorCount` (`main.ts:878`). Wiring a 4-button HUD
onto a 2-monitor desk is a config bug, not a feature.

### 1.2 What a bay can be bound to

Three live source kinds exist in this repo, stuffed into one
`paneId: string` (`store.ts:5`):

| Kind | Stored string | Socket | Broker `getAssignment` |
|---|---|---|---|
| empty | `""` | none | `null` |
| Hyperia pane | UUID | `/ws/pane/{id}` or `/ws/pixels/{id}` | `{ paneId, kind }` |
| Hyperia tab | `"tab:" + tabUUID` | `/ws/tab/{tabId}` **outside** the broker | `null` (`main.ts:59`) |
| catalog placeholder | `"terminal:nav.solution"` etc. | none (PNG) | `null` (`main.ts:55-59`) |

`StreamAssignment` only knows panes (`broker.ts:11-14`):

```
{ paneId: string, kind: 'pty' | 'pixels' }
```

`kind` is inferred: `pane.shell === 'web'` or `session.source.kind === 'web-pixels'`
→ pixels, else pty (`main.ts:60-62`). There is no `kind: 'tab'`. Tabs are
a side channel: `getAssignment` returns `null`, so `desiredMode` is
`'none'` (`broker.ts:197-200`) and the broker never opens `/ws/tab`.
`attachTabStream` (`main.ts:461-488`) owns that socket.

Catalog entries: `frontend/src/terminal/catalog.ts:24-80`. Discriminator
is `terminalById(id)` — another string prefix (`terminal:`).

**Port from day one — tagged union, exhaustive match:**

```
BaySource = Empty
          | Pane    { id: PaneId }      // Hyperia pane UUID
          | Tab     { id: TabId }       // Hyperia tab UUID, never "tab:"+id
          | Catalog { id: CatalogId }   // "nav.solution", not a pane
```

`StreamKind` for leases: `Pty | Pixels | Tab`. A tab-bound bay **is**
leasable; it is not `None`. Wall section sources (`video-wall.ts`
`SectionSource`) use the same `Pane | Catalog` tags in memory already —
reuse `BaySource`, do not invent a second union.

### 1.3 Persistence (what actually ships)

Schema `ops-room-store-v3` in `localStorage` (`store.ts:30-36, 166-168`):

```
{ version: 3, activeRoomId, rooms: {
    [roomId]: { roomId, selectedStationId, camera?, stations: {
      [stationId]: { stationId, heightM, selectedMonitor, expandedTabId,
                     hudScroll, bays: [{ bayIndex, bayId, paneId, powered }] }
    }}
}}
```

`DeskStation.save` writes v3 (`main.ts:222-235`). It still *defines*
`ops-room-station-${id}-v2` (`main.ts:211`) but no longer writes it on
save. `connectPaneToMonitor` **still** writes the global
`ops-room-monitor-targets-v1` array of length 2 (`main.ts:2399-2400`) —
desk-1-only leftover. Ignore it in the port.

`normalizeBays` (`store.ts:55-74`): pad **up** to `monitorCount`; never
drop a higher-index bay already present. A stale 2-bay blob for desk-2
grows to 4. A 4-bay blob for desk-1 does **not** shrink. HUD uses
constructor `monitorCount`, so ghost bays in storage are inert but
poison a later count bump.

Migration v2→v3 (`store.ts:203-241`): scan `ops-room-station-*-v*`,
`targets[]`/`powered[]` → bays. Desk-2 forced to 4
(`store.ts:224`). One-shot; no version field on the v2 blob.

**Port:** server owns this. Client is a subscriber. See §4.

### 1.4 Power is not a source

Power is electrical. Source is routing. They do not write each other.

- `connectPaneToMonitor` / `connectTabToMonitor` / `connectTerminal` do
  not flip `session.powered` (`main.ts:2384-2390, 495-497, 1770-1774`).
  Off bay **remembers** the assignment and attaches on power-on
  (`setMonitorPower` `main.ts:1796-1805`).
- Power is the numbered HUD button only (`setMonitorPower` `main.ts:1788`).
- Off ⇒ dispose tab stream, bump generation, close socket, paint off
  (`main.ts:1791-1794`). On ⇒ re-dispatch by stored `BaySource`.

`getPowered() === false` ⇒ lease `'none'` (`broker.ts:197-200`).

### 1.5 Lease state machine

Modes: `'none' | 'overview' | 'focused'` (`broker.ts:9`).

Constructed from `main.ts:34`:

```
focusedDistance = 6.0 m     // acquire
releaseDistance = 8.5 m     // hold (hysteresis)
overviewFps     = 10        // ctor override; class default is 2 (broker.ts:143)
hiddenGraceMs   = 400       // default (broker.ts:144)
```

`desiredMode` (`broker.ts:196-217`):

```
if !powered OR assignment is null           → none
if no camera sample yet                     → keep (none upgrades to overview)
measure(screen mesh) → { visible, distance }
if currently focused:
    stay focused unless (hidden ≥ 400ms) OR distance > 8.5
    else drop to overview
else:
    focused  iff visible AND distance ≤ 6.0
    else overview
```

Why leases exist: one `/ws/wall` multiplexes every pane as a cell grid
(cheap). `/ws/pane/{id}` is a raw PTY + client VT (expensive). `/ws/pixels/{id}`
is a JPEG stream sized to the canvas. Eight desk bays × focused PTY is
the cost the gate exists to refuse. Tabs are a fourth socket the gate
currently **does not** see (because `getAssignment` is null).

**Who may open sockets.** `acquireFocused` is painters only
(`broker.ts:29, 333-334`). The broker then opens on
`getStreamSession()` (`broker.ts:337-340`) or, if no session, on
`binding.display` (`broker.ts:342-355`). `main.ts` never sets
`binding.display`; it always provides `getStreamSession`. The
`surfaces/display.ts` `DisplaySurface` path is a parallel type.
**Do not wrap the live session mesh in `surfaces/display.ts:18-41`:**
that constructor **replaces the mesh material** with a fresh empty
canvas (`main.ts:46-48`). Two `DisplaySurface` types exist
(`display/surface.ts` vs `surfaces/display.ts`). Port: one trait.

Focused URL (`broker.ts:366-368`):

```
pixels → ws://{host}:9800/ws/pixels/{paneId}?w=&h=&fps=12
pty    → ws://{host}:9800/ws/pane/{paneId}?scrollback=1
```

Host is `location.hostname` (`hyperia/stream.ts:17-21`). The ops-room
HTTP proxy is **not** used for Hyperia WS. Generation counter
(`stream.ts:34-42`) discards events from superseded sockets.
`focusedGeneration` is stored (`broker.ts:378`) and **never read**.

`ensureFocused` throttles re-acquire to 350 ms (`broker.ts:324`).
On focused-socket death while mode is still focused, drop to overview
then retry (`broker.ts:276-282, 372-375`).

Overview: subscribe bay → paneId (`broker.ts:436-443`). One shared
`/ws/wall?fps=` (`broker.ts:468-472`). `flushOverview` paints only
bays whose mode is `'overview'` (`broker.ts:553-562`). External
consumers (`onWallMessage`, `broker.ts:462-466`) keep the wall socket
alive even with zero desk overview subs; on close, reconnect in 1500 ms
**iff** listeners remain (`broker.ts:490-496`).

`requestWallResync` is 1500 ms coalesced (`broker.ts:414-419`).

### 1.6 Visibility measurement (frustum + distance)

**Sample the screen mesh only**, never the desk root.
`Box3.expandByObject` includes `visible=false` children (hidden legs);
that is why `worldScreenBox` copies **this mesh's geometry AABB**
(`broker.ts:71-91, 219-220`). Fat bounding spheres put the center metres
behind the glass so a 0.6 m sit read as `distance > 6` and never focused
(`broker.ts:72-74`).

`measure` (`broker.ts:219-230`):

```
distance = AABB.distanceToPoint(camera.position)
if distance ≤ 0.08 OR camera inside AABB     → visible (near-plane would reject)
if distance ≤ focusedDistance                → visible iff any AABB corner
                                                 is in front of camera (local −Z ≤ 0.05)
                                                 boxFacesCamera, broker.ts:234-241
else                                         → frustum.intersectsBox(AABB)
```

Hysteresis is **distance**, not frustum: once focused, stay until 8.5 m
or 400 ms off-screen. Walking past the glass at 7 m must not flap.

### 1.7 Control plane (ops-room-server, not Hyperia)

`backend/src/main.rs`. Binds `0.0.0.0:{OPS_ROOM_PORT|8080}`.

| Route | Role |
|---|---|
| `ServeDir(frontend/dist)` | production static |
| `GET/POST /api/v1/desk-height` | retained map `deskId → metres`, clamp `[0.65, 1.25]` (`main.rs:116-117, 257-280`) |
| `GET /ws/v1/control` | **retained snapshot on connect**, then broadcast (`main.rs:287-309`) |
| `/hyperia-api/{*path}` | `{HYPERIA_URL}/api/{path}` (`main.rs:315-348`); 502 if sidecar down, never 404 |
| `/api/health`, `/api/version`, `/api/client-logs`, `/api/v1/snapshot`, `/ws/v1/simulation` | ops-room local |

`HYPERIA_URL` defaults `http://127.0.0.1:9800`, **not** `localhost`
(`main.rs:38-45`). Token: `HYPERIA_AGENT_TOKEN` bearer on the HTTP
proxy only. Hyperia **websockets from the browser do not go through
this proxy**.

Control messages (`main.rs:124-129`):

```
{ "t": "deskHeight", "deskId": "operator-desk-1", "metres": 0.85 }
```

Idempotent assignments, not deltas. A lagged subscriber skips
(`RecvError::Lagged` continue, `main.rs:304-306`). Client
(`main.ts:593-615`): same-origin `/ws/v1/control`; reconnect 1 s if
the socket had opened, 3 s if it never did. **StreamBroker must never
register, lease, or close this socket** (`broker.ts:106-110`,
`main.ts:594-595`).

Client height clamp duplicates the server (`main.ts:152-153, 238-240`).
Server clamp is authoritative for tool calls; scene clamp is
authoritative against the authored `Desk_Height_Pivot`.

Vite dev (`frontend/vite.config.ts:3-14`): `/api` and `/ws` → `:8080`;
`/hyperia-api` → `:9800` with `/api` rewrite. Production: axum does
both. The client URL for status is always `/hyperia-api/status`
(`main.ts:2324`).

### 1.8 `window.opsRoom` (in-page MCP-shaped façade)

`frontend/src/control/ops-room.ts` is **types only**. Implementation is
`main.ts:300-368`. Commands: `terminal.read`, `terminal.connect` to
`{ kind:'desk-monitor', deskId, monitorId:'monitor-N' }`. Connect
refuses unready desks (`target_not_ready`). It only binds **catalog**
terminals, not Hyperia panes/tabs. Snapshot schema
`ops-room/browser-state@1` lists catalog connections only. Ready
resolves when room shell **and** 3 desks exist (`main.ts:294-297`).
Desk-height control commands arriving before that wait on the same
promise (`main.ts:590`).

### 1.9 Restore / reconnect ordering

Strict order. Violating it is how desk-3 lost a bay (comment
`main.ts:1823-1825`).

1. `registerDesk` reads v3 bays into `monitorTargets` / `restoredPower`
   (`main.ts:194-204`). Sessions are not yet created.
2. GLB load → `sessions[]` of length `monitorCount` → `wireMonitorBay`
   (mesh → canvas → `streamBroker.register`) → `activateStationBays`:
   `ensureStationBays`, apply saved power, `notifyChanged` per bay
   (`main.ts:1595-1601`).
3. `refreshStatusTopology` every 3 s (`main.ts:2322, poll at caller`).
   Empty discovery **must not** wipe assignments.
4. `restoreStationConnections` (`main.ts:2301-2319`):
   - abort until `desks.size >= 3` (async GLB)
   - abort until latch `restoredMonitorConnections`
   - for each powered bay with a stored id:
     catalog → `connectTerminal`;
     `tab:` → `attachTabStream`;
     pane UUID in `discoveredPanes` → `connectPaneToMonitor`;
     else `unresolvedRemoteSource = true` (retry next poll)
   - latch true only when every remote source resolved
5. `reconcileMonitorSources` (`main.ts:1822-1832`): if discovery is
   non-empty and a bay's id is not catalog, not `tab:`, and not in
   `discoveredPanes`, **wipe to boot**. Empty discovery is "not loaded
   yet", not "everything died".

Power-on path repeats step 4 for that bay only (`main.ts:1800-1805`).

### 1.10 Invariants the port must keep

- Binding persistence is user intent. Lease is derived. Never serialise
  the socket.
- `session.paneId` is the **open stream's** pane, not the binding.
  Tab-bound bays set it to `''` on purpose (`main.ts:470, 1606-1608`).
- Generation bump **before** close (`stream.ts:34-37`).
- One wall socket. N overview subscribers. Focused sockets per visible
  bay, not per pane (two bays on one pane = two focused sockets today;
  port may fan-in).
- Failure: Hyperia HTTP down → 502 via proxy, client warns, does not
  wipe bays. Hyperia WS close → broker retries focused; wall retries if
  listeners exist. Sidecar restart: wall `resync`/`topology`; focused
  reconnect + scrollback; tabs reconnect `/ws/tab` (tab client owns that).

---

## 2. WHAT WORKED

**Hysteresis 6 / 8.5.** Acquire ≠ release. Walking the aisle at ~7 m
does not flap focused↔overview. Cost of not having it: socket storms.
Keep the numbers as defaults; make them data.

**Screen-mesh AABB, not object-graph sphere.** Survived Manatee hiding
legs (`visible=false` still in `expandByObject`) and the "sit at 0.6 m
never focuses" bug (sphere centre behind glass). `worldScreenBox` +
inside-AABB short-circuit (`broker.ts:223-226`) are load-bearing.

**Power ⊥ source.** Off remembers the assignment. Operators power-cycle
without losing routing. Every path that mixed them (early connect
functions) was reverted. The comment at `main.ts:2384-2386` is the law.

**Shared `/ws/wall` + subscriber map.** One cheap socket for every
overview bay **and** the presentation wall. `onWallMessage` existing
only after the wall was dark is the proof the multiplex was right and
the access control was wrong. Keep the multiplex; publish it.

**Control channel with retained snapshot.** Height POST is useless
without a way to reach the scene (`main.rs:121-123`). Snapshot-on-connect
plus idempotent events means a reloaded client is consistent without a
custom "sync me" round-trip. Lagged-skip is correct **because** events
are assignments.

**`normalizeBays` never shrinks.** Desk-2 survived a default of 2.
The failure mode of shrinking is silent assignment loss. Grow-only is
the right persistence default; HUD count comes from **config**, not
from blob length.

**Empty-discovery guard** on reconcile. Topology arriving late used to
zero desk-3. Distinguishing "not loaded" from "gone" is mandatory for
any restore-from-network design.

**HTTP proxy as a first-class server route.** Vite-only `/hyperia-api`
made production report HYPERIA OFFLINE (`main.rs:23-28`). Same-origin
status URL in both modes is the fix. Do not special-case dev.

---

## 3. WHAT DIDN'T

### 3.1 The `tab:` string-prefix hack (the one that matters)

Tabs were bolted onto `paneId: string` as `"tab:" + uuid`
(`main.ts:441-447`) "so the broker and router can tell them apart
without a schema migration" (`main.ts:441-443`). That sentence is the
confession: a tagged union was needed and a prefix was shipped instead.

**Clobber 1 — boot card over live tab.** `refreshSessionRaster`
(`main.ts:1604-1610`): powered ∧ no `session.paneId` → boot. Tab attach
deliberately clears `session.paneId` (`main.ts:470`). Topology refresh
(~3 s) therefore painted boot over the compositing tab. Guard added:
`tabStreams.has(desk:index)`. Guard is local. Next call site will forget.

**Clobber 2 — `/ws/pane/tab:<uuid>`.** `connectPaneToMonitor` is the
restore/click sink (`main.ts:2370`). Restore handed the stored string
in verbatim. Broker `openFocusedOnSession` interpolated it into
`/ws/pane/${paneId}` (`broker.ts:368`). That URL cannot exist. The
bay went dark and the painter recovered as a single pane or boot.
Guard added: `tabIdFromBinding` at the top (`main.ts:2374-2375`).

**Clobber 3 — reconcile wipe.** `reconcileMonitorSources` treated any
id not in `discoveredPanes` as dead (`main.ts:1826-1831`). `"tab:<uuid>"`
is never a pane id, so a live tab binding would be erased on the first
successful status fetch. Guard: `!tabIdFromBinding(paneId)`. Same
pattern, third site.

**Clobber 4 — overview paint-over.** `applyOverview` paints the wall
cell-grid onto the session canvas (`main.ts:103-114`). `getAssignment`
is null for tabs so mode is `'none'` **except** when a previous pane
assignment still sat in `LeaseState.assignedPane` or a notify raced.
The explicit `tabStreams.has(...)` return (`main.ts:104`) is the fourth
guard. `onFocusedBinary` has a fifth (`main.ts:83`).

Lane D §4.2 named (1) and (2). (3) and (4) are the same bug class:
**every consumer of `paneId: string` must remember a discriminator the
type system does not have.** Catalog `terminal:*` is the same class
waiting for a third collision (`terminalById` is yet another ad-hoc
parse, `main.ts:59, 1831`).

The proposed v4 `{kind, id}` is not a nice-to-have. It is the only
honest model of what the runtime already is. Guards are landmines.

### 3.2 One field, two questions

`session.paneId` = "which Hyperia pane is this socket talking to?"
`monitorTargets[i]` = "what did the operator bind to this glass?"

Tab-bound: target is `tab:<id>`, session.paneId is `''`.
Bound-but-unleased (overview / off): target is a UUID, session.paneId
may be stale or empty.
`sessionAlreadyStreaming` compares them (`stream.ts:25-26`). Every
mismatch was a bug. Split: `binding: BaySource` (persistent) vs
`lease: Option<Lease>` (derived). Serialise only the first.

### 3.3 Persistence in the wrong process

v3 is `localStorage` (`store.ts:168`). Per-browser, invisible to the
server, invisible to a second client, already on its third hand-written
migration, with `ops-room-monitor-targets-v1` still being written
(`main.ts:2400`) and a v2 key still named (`main.ts:211`). Meanwhile
`ops-room-server` already stores desk heights and pushes them over
`/ws/v1/control`. Bindings belong there. The browser store was a
prototype that shipped.

### 3.4 Two DisplaySurface types, one of which blanks the glass

`display/surface.ts` `createDisplaySurface` is what `bindSessionSurface`
uses. `surfaces/display.ts` `DisplaySurface` constructs a **new**
canvas and **assigns `mesh.material`** (`surfaces/display.ts:36-40`).
Comment at `main.ts:46-48` is a crime-scene tag. Broker still accepts
`binding.display?: DisplaySurface` from the latter. Port: one `Surface`
trait; constructing a surface must not steal another surface's material.

### 3.5 Tabs are not in the lease machine

Because `getAssignment` returns null, `/ws/tab` is unbounded by frustum
or distance. A tab-bound bay at 40 m still holds a 12 fps compositor
socket (`tab-stream.ts` connect URL). The lease system exists to stop
exactly that, then was bypassed for the new source kind. Port: `Tab` is
a first-class `StreamKind` under the same hysteresis.

### 3.6 `opsRoom` façade is a catalog-only toy

Types promise a control plane (`ops-room.ts`). Implementation cannot
bind a Hyperia pane or tab, cannot power a bay, cannot set height
(height is a different socket). Snapshot lies by omission: Hyperia
bindings are invisible. Do not port this as the control API. Fold pane
and tab bind, power, and height into `/ws/v1/control` with retained
state. Keep `window.opsRoom` only as a thin JS adapter if a browser
tool needs it.

### 3.7 `FocusedPtySource.paint` drops colour

`stream-sources.ts:65` fills every glyph `#d7e2ea`. The wall/tab path
maps `idx:N` / `#rrggbb` / attrs. Focused "full fidelity" is a
monochrome xterm dump. If the port keeps a VT, it must paint the VT's
actual colours. Do not copy this painter.

### 3.8 `focusedGeneration` is dead; generations are a social convention

Stored (`broker.ts:378`), unread. Correctness depends on every callback
checking `generation !== session.generation` (`stream.ts:42`). Miss it
and a closed socket paints. Rust cancellation tokens make the miss
unrepresentable. Do not port the counter.

### 3.9 Counting bays wrong, then persisting the wrong count

`stationBays` was briefly `{1:4, 2:4, 3:4}` while the comment said
desk-1/3 are two-slot (`panoramic-theater.ts` history). HUD draws
`monitorCount` buttons (`main.ts:876-889`). Operators got four selectors
on two-monitor desks. Config is the contract; do not infer count from
`MonScreen_*` name matches on a GLB that still contains hidden
assemblies (desk-1 still *has* MonScreen_1/4 in the file).

---

## 4. RUST NOTES

**`BaySource` is `Send + Sync + Clone + Serialize`.** It is data. It
does not hold a socket.

```
enum BaySource { Empty, Pane { id: PaneId }, Tab { id: TabId }, Catalog { id: CatalogId } }
struct Bay { station: StationId, index: u8, id: BayId /* m1 */, source: BaySource, powered: bool }
```

Serde tagged, `rename_all = "lowercase"`. Reject unknown kinds.

**Migration (run on the server, once, with tests):**

```
empty string          → Empty
strip prefix "tab:"   → Tab { id }
strip "terminal:" or catalog lookup → Catalog { id }
else UUID parse       → Pane { id }
unparseable           → Empty + log, do not crash restore
```

Do not keep the prefix in the stored id. `Tab { id: "tab:…" }` is the
same bug.

**Lease is not serialised.**

```
struct Lease { kind: StreamKind, source_id: SourceId, mode: Overview | Focused,
               token: CancellationToken, task: JoinHandle<()> }
```

`Drop` cancels. `StreamKind::Tab` opens `/ws/tab/{id}`. Overview of a
pane is a subscription on the shared wall multiplex, not a socket per
bay. Overview of a tab is either the same `/ws/tab` at low fps or a
wall-derived mosaic — pick one in Lane A; do not open both.

**`VisibilityProbe: Send`.** Input: surface AABB (world), camera
pose+projection **or** a precomputed `(visible, distance)`. Output:
`LeaseMode`. Table-test the hysteresis. Do not require wgpu to test
the gate. Lane D §1.1 `VisibilityProbe` is correct; implement it
**before** the renderer crate exists.

**Ownership of the raster.** The lease task produces frames into
`watch::Sender<Frame>`. The surface task is the only one that `commit`s
to GPU. Topology timers may set a `stale` flag; they must not call
paint. That is the boot-card bug in type form (Lane D §4.4) — agree.

**Back-pressure.** Wall at `overviewFps`. Focused PTY is unbounded
bytes — drop the lease rather than queue. Focused pixels: skip frames
if `commit` is behind (the JS path already drops a JPEG if mode
changed, `broker.ts:594`). Tab compositor: fps query param.

**Control plane.** Axum already has `/ws/v1/control` + retained
heights. Extend the enum:

```
ControlEvent::DeskHeight { desk_id, metres }
ControlEvent::BayBound   { station, bay, source: BaySource }
ControlEvent::BayPower   { station, bay, powered: bool }
```

Same snapshot-on-connect. Same lagged-skip. Persistence:
`HashMap<(StationId, u8), Bay>` behind `RwLock`, flushed to a versioned
file or sqlite. **Do not add a second websocket for bindings.**

**Proxy.** Keep `/hyperia-api/*` → sidecar `/api/*` with 502. Do **not**
proxy Hyperia websockets through ops-host unless the browser cannot
reach `:9800` (containers). If you must, that is a Lane A transport
concern; the lease machine should take a `HyperiaTransport` trait, not
hardcode `{hostname}:9800` (`stream.ts:17-21`).

**`ops-host` is the only crate that binds a port** (Lane D §1). Agree.
Bay state lives there, not in `surface-lease`.

**What else needs `{kind,id}`?** Yes, shared: wall section sources,
HUD rows, restore dispatch. Catalog is not bay-only. Put `BaySource`
in `hyperia-proto` or a tiny `surface-core` module, not inside the
lease crate.

---

## 5. Sequencing implication for Lane D

M3 in Lane D ("bind a bay over the control WS, restart, binding
survives") is the first milestone that **cannot** ship with
`paneId: string`. If M3 lands with the prefix, you will re-implement
clobbers 1–4 in Rust. `BaySource` is commit one of M3, not a cleanup.

Harsh lesson: a discriminator you cannot forget is worth more than
another guard in `main.ts`.
