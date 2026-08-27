# Operations Command Room Simulator

A browser-based 3D operations room that renders **live Hyperia terminal panes as
surfaces in the scene** — the main curved wall display and the monitors on three
operator desks are real terminals, not textures of terminals. A Rust/Axum
service serves the built client and proxies the Hyperia sidecar.

## Architecture

- `frontend/` — Vite + TypeScript + three.js client (~7.3k lines). Loads the
  Blender-authored room, binds canvas textures to named meshes, and manages a
  visibility-gated lease per surface so only nearby screens stream at full rate.
- `backend/` — Axum/Tokio service (`ops-room-server`). Serves `frontend/dist`,
  holds a scaffold simulation, keeps a client-log ring buffer, and proxies
  `/hyperia-api/*` to the Hyperia sidecar. Binds `0.0.0.0:8080`
  (override with `OPS_ROOM_PORT`).
- `assets/` — Blender authoring sources (`assets/blender/`), exported GLB
  variants (`assets/models/`) and render previews (`assets/renders/`). The
  runtime copies the client actually loads live in `frontend/public/assets/`.
- `docs/satcom-ops-room.html` — behaviour/reference prototype. Its simulation,
  controls and audio are worth migrating as modules; its hard-coded room
  geometry is not.
- `docs/HYPERIA_EVENT_STREAM_API.md` — the terminal-stream source. The client talks
  to the sidecar directly over `/ws/wall`, `/ws/pane/{id}`, `/ws/pixels/{id}`
  and `/ws/tab/{tabId}`.
- `docs/REPORT.md` — an evidence-based assessment of what works and what does not.
- `docs/RUST_PORT_SPEC.md` plus `docs/PORT_SPEC_LANE_{A,B,C,D}.md` — the spec for
  porting this integration to Rust in another project.

## Scene contract

These names are the integration API between the Blender scene and the client.
Renaming one without updating the binder breaks the room silently.

| Mesh | Role |
| --- | --- |
| `Wall_Screen_1`, `Wall_Screen_3` | Flanking wall arcs. Real cylindrical UVs, but dark — no content is assigned to them yet (`main.ts:1466`). |
| `Wall_Screen_2` | The room's main display. The only wall arc bound to a live surface. Declared as `presentationScreen` in the room descriptor. |
| `Wall_Screen_{1,2,3}_Frame` | Frame geometry, styled from `screenFrameStyle`. |
| `Desk_Height_Pivot` | Required on every desk. Missing it throws at load. |
| `Desk_Wood_Top` | Required on every desk. Missing it throws at load. |
| `Desk_Leg*`, `Desk_Foot_*`, `Desk_SupportArm_*` | Driven by the desk-height animation. |

The room itself is described in `frontend/src/config/rooms/panoramic-theater.ts`:
shell asset, `presentationScreen`, `stationBays` (desk-1 ×2, desk-2 ×4,
desk-3 ×2) and the polar station layout.

Note the descriptor declares more than the loader consumes — `RoomLoader` reads
the shell and `presentationScreen` and indexes nodes by **name**. The
`semantic_role` custom properties on the GLB nodes are cosmetic today; they do
not drive loading. See `docs/REPORT.md` §5.2.

## Development

```bash
npm --prefix frontend install
npm --prefix frontend run dev      # binds 0.0.0.0 so it is reachable from a container host
```

In another terminal:

```bash
cargo run -p ops-room-server
```

Vite proxies `/api` and `/ws` to the Rust server and `/hyperia-api` to the
sidecar on `:9800`. Production is served by Rust from `frontend/dist`.

The production client polls the served `index.html` build fingerprint, so after
the bundle has loaded once, a later `npm --prefix frontend run build` reloads
the open WebPane on its own; the Rust process only needs restarting for backend
changes.

### Tests

```bash
npm --prefix frontend test         # tsc --noEmit && vitest run
```

`tsc` runs with `strict`, `noUnusedLocals` and `noUnusedParameters`. The suite
in `frontend/src/tests/architecture.test.ts` covers descriptor validation, state
persistence and migration, bay normalisation, wall grid row shapes, cell colour
mapping, pane naming, and tab tile packing. The same checks are reachable in the
browser console as `window.runArchitectureTests()`.

There is **no rendering test** — nothing yet observes what the scene actually
draws, which is the project's largest verification gap. See `docs/REPORT.md` §6.

Browser diagnostics land in a bounded server-side ring buffer (most recent 500
entries, reset on restart):

```bash
curl http://localhost:8080/api/client-logs
```

## HTTP and WebSocket surface

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness. |
| `GET /api/version` | Build fingerprint used for hot reload. |
| `GET /api/client-logs` | Read the diagnostic ring buffer. |
| `POST /api/client-logs` | Client forwards console output and uncaught errors. |
| `GET /api/v1/snapshot` | Scaffold simulation snapshot. |
| `GET /api/v1/desk-height` · `POST /api/v1/desk-height` | Desk height state. |
| `GET /ws/v1/simulation` | Scaffold telemetry stream. |
| `GET /ws/v1/control` | Control channel. |
| `ANY /hyperia-api/{*path}` | Proxy to the Hyperia sidecar. |

The simulation behind `/api/v1/snapshot` and `/ws/v1/simulation` is still a
deterministic scaffold — the SATCOM orbit/contact/fault model has not been
ported into Rust.

## Where to take it next

Ordered by leverage, per `docs/REPORT.md` §9:

1. Add a headless render-to-PNG golden test — today nothing can observe a black
   screen.
2. Replace the `"tab:"` / `"terminal:"` string prefixes on bay sources with a
   tagged union; four distinct clobber bugs trace to that one `String`.
3. Assign content to `Wall_Screen_1` and `Wall_Screen_3`.
4. Port the SATCOM simulation into a testable Rust domain crate.
5. Migrate binary assets to git-lfs before adding a remote.
