# Antigravity Architecture Plan: Object Normalization for 3D Terminal Room

This document outlines the architectural plan to normalize object handling across **Terminals**, **Monitors**, and **Desks** in the 3D Operations Command Room Simulator (`3dterminal`).

---

## 1. Executive Summary & Core Architectural Goal

Currently, [`frontend/src/main.ts`](file:///workspace/3dterminal/frontend/src/main.ts) is a 1,300-line monolithic file containing inline magic coordinates, copy-pasted loader logic, module-level mutable globals, and hardcoded geometric relationships. 

The goal of this architectural refactoring is to:
1. Establish a **Prefab + Instance** model driven by declarative composition descriptors.
2. Enforce a strict **Split of Authority** between 3D assets (Blender), room layout descriptors (JSON/TS), runtime application state, and data adapters.
3. Normalize object interactions using core interfaces (`DisplaySurface`, `ContentSource`, `StationInstance`, `StreamBroker`).

---

## 2. Split of Authority

| Domain | Responsibilities | What It OWNS |
| :--- | :--- | :--- |
| **Asset Layer (Blender / GLB)** | Physical geometry, materials, UV maps, screen quad meshes, named pivots, and socket anchors. | Named nodes: `Station_Anchor_01`, `MonTiltNode_1..4`, `CamTarget`, `Desk_CtrlDisplay`. **UV mapping for all display screens.** |
| **Composition Layer (Descriptors / JSON)** | Prefab declarations and slot mapping (combining desks + monitors into a room layout). | Declarative rules: *"Attach standing desk prefab to `Station_Anchor_01` and populate slots 2 and 3 with flat monitors."* **Zero 3D coordinates or vector numbers.** |
| **Runtime Store (State)** | Application state, monitor power status, active pane routing, user selections, and camera poses. | Reactive state store (e.g., `ops-room/v3` schema). |
| **Data Adapters (Hyperia)** | PTY terminal streaming, web pixel feeds, and wall overview streams. | Socket lifecycle, terminal/canvas rendering, and stream leasing based on visibility. |

> [!IMPORTANT]
> **Governing Architectural Rule:** Config files and TypeScript code must **never contain 3D coordinates** that Blender could have authored. Position desks, seats, lights, and camera targets using named Empty nodes in Blender.

---

## 3. Core Abstractions

```
+-------------------------------------------------------------------+
|                           Room Runtime                            |
+-------------------------------------------------------------------+
        |                                           |
        v                                           v
+------------------------+                 +------------------------+
|    StationInstance     |                 |     DisplaySurface     |
| (Desks & Workstations) |                 |  (Monitors & Screens)  |
+------------------------+                 +------------------------+
   - Attached to Anchor                     - Manages UV/Aspect/Mesh
   - Holds N Bay Slots                      - Binds 1 ContentSource
   - Has Seat CamTarget                     - Screen Shader / Material
        |                                           |
        +-------------------+-----------------------+
                            |
                            v
                +-----------------------+
                |     ContentSource     |
                | (Terminals & Displays)|
                +-----------------------+
                   - attach(target)
                   - detach()
                   - update()
                  /        |        \
                 /         |         \
   +------------------+ +-------------+ +---------------+
   |  TerminalSource  | | PixelSource | | Off/BootSource|
   | (PTY / Xterm.js) | | (Web JPEG)  | | (Local Anim)  |
   +------------------+ +-------------+ +---------------+
```

### 3.1 Monitors & Screens: `DisplaySurface` & `ContentSource`
Instead of treating desk screens and panoramic wall screens as separate custom implementations:
* **`DisplaySurface`**: Wraps any screen mesh (24" desktop quad, 34" curved ultrawide GLB, or a section of the 60° curved wall mesh). Manages aspect ratios, UV projection, and material assignment.
* **`ContentSource`**: Interface with clean lifecycle methods:
  ```ts
  interface ContentSource {
    attach(target: RenderTarget): void;
    detach(): void;
    update(deltaTime: number): void;
  }
  ```
* **Concrete Implementations**:
  * `TerminalSource`: Wraps Xterm.js canvas rendering for active PTY streams.
  * `PixelSource`: Receives JPEG frame streams for web application panes (`/ws/pixels/{id}`).
  * `BootSource` & `OffSource`: Local canvas animations when a monitor is powered off or booting up.
  * `WallOverviewSource`: High-level grid visualization for the main panoramic screen.

### 3.2 Desks & Workstations: `StationPrefab` & `StationInstance`
* **Asset Caching**: Fetch and parse GLTF assets (`standing_desk_sim_master.glb`, `curved_monitor_ultrawide.glb`) **once** using an `AssetCache`, then clone meshes and instance materials.
* **Anchor Sockets**: Place a workstation by parenting its root node to a named empty in the room asset (`Station_Anchor_01`).
* **Bay Slots**: Standardize monitor attachment points (`MonTiltNode_1..4`). A station exposes slots that can either:
  * Show/hide built-in monitor sub-assemblies.
  * Attach a separate monitor device prefab (`curved-ultrawide`, `desktop-black-24`) directly to the tilt node socket.
* **Camera Anchors**: Derive seated camera positions from the desk's authored `CamTarget` node rather than hardcoding procedural offsets in code.

### 3.3 Terminals & Data Streams: Stream Leasing Broker
Instead of spawning heavy Xterm.js instances and full PTY scrollback streams for every powered screen in the room:
* **Overview / Wall Mode (`/ws/wall`)**: Uses low-frequency cell/grid updates for distant or un-focused workstations.
* **Stream Broker (Visibility-Gated Leases)**: Only requests full focused PTY streams (`/ws/pane/{id}`) and high-FPS pixel feeds when a monitor is **powered**, **visible to the camera**, and **within interaction threshold**.

---

## 4. Target Descriptor Schema

Configuration files define **composition only**:

```jsonc
// config/rooms/panoramic-theater.room.json
{
  "$schema": "ops-room/room@1",
  "id": "panoramic-theater",
  "shell": { "asset": "panoramic_command_theater_architecture" },
  "stations": [
    {
      "id": "ops-1",
      "label": "Operator Desk 1",
      "prefab": "standing-desk",
      "placement": { "anchor": "Station_Anchor_01" },
      "bays": [
        { "bay": "2", "device": "builtin-flat" },
        { "bay": "3", "device": "builtin-flat" }
      ]
    },
    {
      "id": "ops-3",
      "label": "Operator Desk 3",
      "prefab": "standing-desk",
      "placement": { "anchor": "Station_Anchor_03" },
      "bays": [
        { "bay": "1", "device": "curved-ultrawide" },
        { "bay": "3", "device": "flat-black-24" }
      ]
    }
  ],
  "wallDisplays": [
    {
      "id": "theater-wall",
      "nodes": ["Wall_Screen_1", "Wall_Screen_2", "Wall_Screen_3"],
      "mode": "spanned"
    }
  ]
}
```

---

## 5. Phased Implementation Plan

| Phase | Title | Objectives | Deliverables |
| :--- | :--- | :--- | :--- |
| **Phase 0** | **Characterization Harness** | Capture baseline numerical transforms for all objects and cameras to prevent regressions. | `baseline.json` test harness |
| **Phase 1** | **Asset Caching & Decoupling** | Extract `ContentSource` and `DisplaySurface` from [`main.ts`](file:///workspace/3dterminal/frontend/src/main.ts). Add GLTF `AssetCache`. | `AssetCache`, `DisplaySurface`, `ContentSource` modules |
| **Phase 2** | **Blender Anchor Pass** | Author named `Station_Anchor_*`, `CamTarget`, and light empties in Blender. Cylindrically unwrap `Wall_Screen_1..3` meshes to add proper `TEXCOORD_0` UVs. | Updated GLB assets + committed Blender export script |
| **Phase 3** | **Descriptor Schema & Loader** | Implement typed TypeScript descriptors to compose rooms dynamically without hardcoded coordinates. | `RoomLoader`, `StationPrefab` loader, schema validation |
| **Phase 4** | **Stream Broker & State v3** | Upgrade the streaming layer to lease full PTY feeds dynamically based on camera visibility. Migrate state to `ops-room/v3`. | `StreamBroker`, updated persistence layer |
