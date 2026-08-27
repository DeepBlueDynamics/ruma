# Restrained Tron Scene Plan

Reviewed against the live scene and the exported GLB with Silky Raven on
2026-08-13. This plan deliberately separates asset identity, visual theme, and
renderer behavior so another room can reuse the look without inheriting this
room's mesh names.

## Target

- Make the wall-screen bezel physically rounded, including its visible outer
  silhouette, while preserving the exact cylindrical screen curvature.
- Carry a restrained Tron language through the room: near-black architecture,
  neutral-white primary rails, dim cyan secondary seams, and red only for
  destructive/off states.
- Keep every control on the physical desks, monitors, or wall displays. Add no
  floating DOM controls.
- Preserve terminal/web streaming, station persistence, camera behavior, and
  physical HUD interaction.

## Architecture boundaries

1. **Asset roles** describe what an authored object is. Blender custom
   properties export to GLTF `extras` and become Three.js `userData`. Target
   roles include `screen.surface`, `screen.frame`, `screen.lightRail`,
   `floor.gridBase`, `ceiling.main`, `accent.pedestalRing`,
   `accent.ceilingRing`, and `light.anchor.*`.
2. **The asset adapter** is the only temporary name-coupled layer. Until the
   Blender roles are exported, one panoramic-theater adapter maps existing
   names to roles. No renderer or theme code may match mesh names.
3. **The theme** maps semantic roles and states to appearance. A reusable
   `tron-restrained` theme owns colors, material families, line widths, and
   powered/selected/off state styles. The room config only references the theme
   ID.
4. **The renderer profile** owns exposure, tone mapping, and bloom. Bloom is
   not room geometry and does not belong in the room config.
5. **Station accents** are driven by `DeskStation`/monitor state. Theme code
   does not inspect pane IDs or duplicate monitor power state.

## Implementation sequence

### 1. Establish a clean lighting baseline

- Before changing any light or material, capture comparable live screenshots
  from overview, desk view, and monitor focus through the existing
  `web_pane_eval` canvas-capture path.
- Remove the six hardcoded `RectAreaLight` instances before tuning the look;
  they are currently created without `RectAreaLightUniformsLib` and are not
  anchored to the room asset.
- Audit the eight hardcoded cyan wall `PointLight`s, the global cyan rim light,
  and three desk spot pools. Retain only lights that visibly model a useful
  source.
- Use the existing authored `Area_Cool_Fill`, `Screen_Cyan_Spill`, and
  `Screen_Warm_Spill` transform nodes as light anchors instead of hardcoded
  world coordinates. They are empty `Object3D`s in the current GLB, not working
  lights.
- Defer final PointLight/SpotLight intensity, range, and falloff tuning until
  after the 1.5× scale is baked into the Blender asset. Anchored positions will
  self-correct, but world-unit light ranges will not.

### 2. Establish roles and the reusable theme foundation

- Implement the isolated compatibility adapter for the current untagged GLB.
  It may contain names such as `Room_Floor_Base`; all downstream systems consume
  roles only.
- Add a typed theme contract and `tron-restrained` preset outside room config.
- Use dark physically based materials for architecture, neutral-white light
  cores, restrained cyan secondary accents, and red only for reset/off states.
- Clone materials per semantic role before changing them; the pedestal and
  ceiling rings currently share cyan material behavior but need independent
  intensities.
- Handle `MeshBasicMaterial` and `MeshStandardMaterial` explicitly. Never set
  `emissive` on a basic material and assume it worked.
- Fail visibly in development when a required role is missing, and degrade
  safely in production by leaving the original material intact.

### 3. Author the genuinely rounded screen assembly in parallel

This Blender work proceeds in parallel with the adapter/theme work above; it
does not block visible theme progress against the current asset.

- In Blender, round both the inner opening and outer silhouette of
  `Wall_Screen_1/2/3_Frame` while retaining each frame's current cylindrical
  radius and depth. Do not approximate this with runtime `TubeGeometry`.
- Author a separate, thin `screen.lightRail` mesh following the rounded inner
  opening. This supplies a physical neutral-white core that can be themed and
  bloomed without making the entire dark frame emissive.
- Round the physical display-surface geometry corners to the same radius so
  screen content cannot reveal square corners behind the frame. Do not mask the
  canvas; the cylindrical UV bounds/aspect remain valid because the mid-edge
  extrema are retained.
- Respect the measured 4 cm radial clearance between the screen outer face
  (20.64) and frame inner face (20.68), and verify the rail does not occlude
  content at oblique viewing angles.
- Bake the current 1.5× room scale into the authored Blender objects during
  this export and return runtime `shell.scale` to 1.0. Light anchors and all
  future room measurements must then operate in authored world units.
- Add role metadata to the screen surface, frame, and light rail, then export
  the GLB. Keep Silky Raven's cylindrical UV/display code unchanged.
- Remove the painted white canvas border once the physical light rail is live;
  retaining both would create a double bezel.

### 4. Add authored role metadata throughout the room

- Tag the floor base, ceiling, shell, pedestal tiers/ring, ceiling ring, screen
  plinths, display parts, and light anchors in Blender.
- Remove corresponding fallback name mappings as exported roles become
  available.

### 5. Apply architectural accents using existing geometry

- Floor: style `Room_Floor_Base` once so the gaps beneath the 160 floor tiles
  read as dim seams. Do not add edge geometry or one material/draw call per
  tile.
- Pedestal: tune the existing `Pedestal_Light_Ring`; do not add a second ring.
- Ceiling: tune the existing `Ceiling_Recess_Ring` and, if needed, use the
  authored `Ceiling_Main` UVs for sparse ribs.
- Shell: keep it dark and reflective in the first pass. It has no UVs and is a
  two-radius slab, so procedural whole-mesh cylindrical mapping is deferred
  until an authored inner-wall surface/UV role exists.
- Screens: use the new rounded physical light rail. Inactive screens remain
  black with a low rail; the active presentation screen gets the brighter rail.

### 6. Extend the same language to stations

- Keep bamboo/acacia/mango surfaces natural; Tron treatment belongs on control
  surfaces, monitor housings, and the existing triangular/facet treatment.
- Drive each monitor accent from its existing session power state so button and
  bezel can never diverge. Powered is white with a small cool halo; boot is dim;
  off remains dark with the existing red selector state.
- Theme the physical desk router canvas and its embedded border through the
  same role/state palette without adding screen-space UI.

### 7. Add restrained glow last

- Introduce post-processing only after the non-bloom scene reads correctly.
- Run bloom at half resolution with a high threshold and low strength so only
  authored light rails and deliberately bright pixels contribute.
- Preserve `containCamera()` before the composer render, and update composer
  dimensions on resize.
- Do not use broad cyan lights to simulate glow; they tint walls and recreate
  the rejected blue spill.

### 8. Verification and acceptance

- Type-check and production-build the frontend.
- Inspect live screenshots from room overview, all three desk views, an active
  terminal monitor, a web monitor, and an inactive screen.
- At an oblique close view, the screen frame's actual silhouette and opening
  must both have rounded corners; no square backing may remain visible.
- No blue rectangle or blue top spill may appear on the shell.
- Floor and ceiling accents must read at overview distance without overpowering
  terminal text.
- The floor treatment must not add 160 accent draw calls.
- Monitor power, selection, boot, saved connections, and desk routing must
  remain synchronized.
- `Wall_Screen_2` status-board text must remain crisp. Bloom threshold must sit
  above the board's `#d7f8ff`/`#40dcff` text luminance so the board does not
  smear into a glowing block.
- Wheel input over a physical desk router scrolls only the router; wheel input
  elsewhere still zooms the camera.

## Already completed during planning

- Corrected desk-router wheel routing: the capture-phase handler now consumes
  the event before `OrbitControls`. Live verification confirmed the HUD scrolls
  with no camera movement, while wheel input over the room still zooms.
