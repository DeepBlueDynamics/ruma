# Hyperia→3D Port Spec — Lane Assignments

**Goal.** Produce a spec that lets a *different* project re-implement what
`3dterminal` does — render live Hyperia terminal panes/tabs onto surfaces —
as a **Rust** port. Not a rewrite of this repo. A portable spec.

Audience: an engineer who has never seen this repo, working in Rust
(tokio + tungstenite, renderer TBD: wgpu / bevy / egui / native window).

**Every lane must answer three things, explicitly labelled:**

1. **CONTRACT** — what the target project must implement, stated
   independently of TypeScript/Three.js. Wire shapes, invariants, ordering
   guarantees, failure modes. Be exact. Cite `file.ts:line` for anything you
   assert so it can be checked.
2. **WHAT WORKED** — designs here that earned their keep. Say *why* they
   worked, and what pressure they survived.
3. **WHAT DIDN'T** — designs that failed, cost us rework, or are still
   wrong. Name the bug it caused. Do not be diplomatic; this section is the
   whole point. A lane with an empty WHAT-DIDN'T section will be rejected.

Then: **RUST NOTES** — where the TS design does *not* translate, and what
the Rust shape should be instead (ownership, `Send`/`Sync`, back-pressure,
who owns the texture, blocking vs async boundaries).

## Rules

- Read the real code. Do not summarise from memory or from a prior chat.
- No new features. No edits to `frontend/` or `backend/` in this task.
- Length: 300–600 lines. Dense. No filler, no restating this brief.
- If you find a claim from another lane that is wrong, say so by name.
- Write ONLY your own output file. Do not touch another lane's file.

---

## LANE A — Wire protocol & session lifecycle
**Owner: Quiet Marmoset 👾** → write `PORT_SPEC_LANE_A.md`

Source: `frontend/src/hyperia/*.ts` (`protocol.ts`, `stream.ts`,
`wall-client.ts`, `tab-stream.ts`), `frontend/src/surfaces/broker.ts`.

Cover all four sockets: `/ws/wall`, `/ws/pane/{id}`, `/ws/pixels/{id}`,
`/ws/tab/{tabId}`. For each: handshake, auth (token in query? header?),
message union, keyframe-vs-delta semantics, resync, heartbeat/ping,
close/reconnect policy, backoff, and what happens on sidecar restart.

Must nail: the cell encoding (`Cell` tuple, `Color` union incl. `idx:N`
256-colour mapping, `ATTR` bitfield); why `normalizeGridRows` has three
fallbacks for row shape; the `name` vs OSC `title` rule in `paneChrome`;
token classes `hyp_pane_*` (volatile) vs `hyp_agent_*` (persistent) and
what breaks when you pick wrong. Input injection on `/ws/tab` too.

## LANE B — Scene, assets & the raster pipeline
**Owner: Probable Finch 🧀** → write `PORT_SPEC_LANE_B.md`

Source: `frontend/src/scene/*.ts`, `frontend/src/display/*.ts`
(`surface.ts`, `video-wall.ts`, `session.ts`), `frontend/src/assets/cache.ts`,
`frontend/src/config/rooms/panoramic-theater.ts`,
`frontend/src/descriptors/room-descriptor.ts`.

Cover: the GLB `extras`/`semantic_role` asset contract — full role
vocabulary and what the runtime does per role; how a display surface is
discovered, sized, and given UVs (incl. the cylindrical unwrap for curved
walls: u from atan2 about the segment's own mean direction, v from Y,
aspect = radius*span/rise) and why naive planar UVs failed; the
grid→texture path (glyph metrics, 0.6 aspect, atlas vs per-frame draw,
dirty-rect vs full repaint, texture upload cadence); hit-testing
(uv → canvas px → hit region) and the picking tolerance problem.

Also: room layout as a function of room shape (grid for rectangular,
polar for circular) and what the descriptor must carry so a room is data,
not code.

## LANE C — Binding model, leases & control plane
**Owner: Empirical Earthworm 🥦** → write `PORT_SPEC_LANE_C.md`

Source: `frontend/src/surfaces/broker.ts`, `stream-sources.ts`,
`display.ts`, `frontend/src/state/store.ts`, `frontend/src/control/ops-room.ts`,
`backend/src/main.rs`, `frontend/src/terminal/catalog.ts`.

Cover: the bay→source binding model and its persistence; the visibility-
gated lease state machine (`none`/`overview`/`focused`, `focusedDistance`,
`releaseDistance`, hysteresis) and why leases exist at all (socket cost);
frustum + distance gating; the backend's role — static serving,
`/hyperia-api/*` proxy, `/api/v1/desk-height`, `/ws/v1/control` with
retained state on connect; reconnect/restore ordering.

Must nail, unsparingly: the `tab:<id>` **string-prefix binding hack** — why
it was introduced, the two clobber bugs it caused (boot card repainting over
tab-bound bays via the topology refresh; `connectPaneToMonitor` opening
`/ws/pane/tab:<id>`), and the proposed v4 `{kind:'pane'|'tab'|'catalog', id}`
model that should be in the port **from day one**. State the migration.

## LANE D — Rust port architecture & sequencing
**Owner: Sweet Asp 🍬 (me)** → `PORT_SPEC_LANE_D.md`, then merge all four
into `RUST_PORT_SPEC.md`.

---

## Deliverable protocol

Write your file, then reply in your pane with exactly:
`LANE <X> DONE <n> lines`
plus a 3-line summary of your harshest WHAT-DIDN'T finding. Nothing else.
