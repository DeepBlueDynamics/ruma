# Hyperia→3D Rust Port Spec — Lane B: Scene, Assets, and Raster Pipeline

## Scope

This lane begins after Lane A has decoded terminal cells or web JPEG bytes.
It ends when the renderer presents a texture on a pickable scene surface.
Lane C owns bindings, persistence, and lease policy.
This document specifies portable behavior, not TypeScript APIs.
## CONTRACT

### Coordinates and entity boundaries

1. Use a right-handed, Y-up coordinate system with authored dimensions in meters.
2. Room root scale should be identity; bake approved scale changes into the asset.
3. The current 1.5x room enlargement is authored and runtime scale is 1 (frontend/src/config/rooms/panoramic-theater.ts:4).
4. Treat room, station, display glass, content state, and camera state as separate entities.
5. A content assignment must not mutate geometry, power, or camera state.
6. A camera action must not mutate a binding.
7. A station's authored operator side is local +Z.
8. Derive station yaw from a configured facing surface, not the world origin.
9. The current +Z yaw conversion is atan2(normal.x, normal.z) (frontend/src/scene/layout.ts:93).
10. Update world transforms before measuring bounds, normals, or ray intersections.
### GLB extras and semantic roles

11. Every behavior-bearing GLB node must carry semantic_role in extras.
12. Numbered displays must also carry a stable screen_index.
13. Names may remain for diagnostics and migration, but not primary behavior.
14. The Blender build writes semantic_role as a custom property (tools/blender/build_tron_architecture.py:240).
15. Screen rebuild writes screen_index and corner_radius too (tools/blender/build_tron_architecture.py:146).
16. Canonical room-kind metadata is room.panoramicTheater (tools/blender/build_tron_architecture.py:305).
17. Canonical enclosing geometry role is room.shell (tools/blender/build_tron_architecture.py:264).
18. Canonical ceiling role is ceiling.main (tools/blender/build_tron_architecture.py:263).
19. Canonical base-floor role is floor.gridBase (tools/blender/build_tron_architecture.py:262).
20. Canonical sector role is floor.tile (tools/blender/build_tron_architecture.py:273).
21. Pedestal roles are pedestal.lower, pedestal.middle, and pedestal.top (tools/blender/build_tron_architecture.py:265).
22. Accent roles are accent.pedestalRing and accent.ceilingRing (tools/blender/build_tron_architecture.py:268).
23. Physical display glass uses screen.surface (tools/blender/build_tron_architecture.py:323).
24. Physical bezel uses screen.frame (tools/blender/build_tron_architecture.py:328).
25. Luminous perimeter geometry uses screen.lightRail (tools/blender/build_tron_architecture.py:224).
26. Light anchors are light.anchor.coolFill, light.anchor.screenCool, and light.anchor.screenWarm (tools/blender/build_tron_architecture.py:270).
27. Legacy aliases floor, dais, screen.glass, and presentation.screen appear only in runtime compatibility code (frontend/src/scene/room-cleanup.ts:19).
28. Normalize legacy aliases once at load.
29. Preserve unknown roles and log them; never hide a node merely because its role is unknown.
30. Reject duplicate unique roles unless the descriptor explicitly declares a set.
31. Order display sets by screen_index, not node name.
32. Validate all required roles before allocating stream or raster resources.
33. screen.surface must be discoverable independently of which display is active.
34. screen.frame receives frame material only.
35. screen.lightRail receives emissive rail material only.
36. room.shell provides bounds even if its render visibility is off.
37. floor.tile participates in floor occlusion picking.
38. light.anchor.* supplies transforms for renderer-created lights.
39. Pedestal roles remain visible unless descriptor policy disables them.
40. Current frame and rail material separation is correct (frontend/src/main.ts:1446).
### Room descriptor

41. Load a complete room from one versioned descriptor without room-specific source edits.
42. Include schema, id, label, units, coordinates, shell URI, and authored scale.
43. Include the complete station list.
44. Each station includes id, label, prefab URI, bay definitions, placement, and facing rule.
45. Each bay includes stable bay id, display selector/anchor, and optional physical width.
46. Station placement is a tagged polar-or-grid union.
47. Polar data includes center, radius, center angle, spacing, count, and ordered station ids.
48. Grid data includes origin, rows, columns, pitch, and ordered station ids.
49. Existing polar and grid inputs are correctly disjoint (frontend/src/scene/layout.ts:3).
50. Include stationFacingSurface separately from display content/power.
51. Include all room displays, not only one presentation mesh.
52. Each display includes id, ordered surfaces, mapping, layout, and configurable section count.
53. Display layout modes may be spanned, tiled, or single (frontend/src/descriptors/room-descriptor.ts:26).
54. Each surface declares authored or cylindrical mapping.
55. General cylinders declare axis and radial plane.
56. Include named camera views or ratios derived from shell bounds.
57. Include floor policy: authored/generated, sectors, rings, and gap.
58. Include enabled role policy and lights bound to light anchors.
59. Include presentation display id, not a raw mesh name.
60. Include station bay counts, prefab variants, camera margin, and pick tolerance.
61. Reject missing nodes, duplicate ids, invalid bays, empty grids, nonpositive radii, and invalid section layouts.
62. Current validation checks only id, shell.asset, and stations-array presence (frontend/src/descriptors/room-descriptor.ts:50).
63. Rust validation must return all path-qualified failures.
64. Build name and semantic-role indices in one traversal.
65. Current RoomLoader already gathers named anchors in one traversal (frontend/src/scene/room-loader.ts:15).
66. Return a typed RoomInstance with shell, role index, displays, stations, lights, floor, views, and bounds.
67. Consume stations, wallDisplays, and views; do not merely deserialize them.
68. Those fields exist in RoomDescriptor today (frontend/src/descriptors/room-descriptor.ts:39).
69. Current RoomLoader consumes only shell and presentationScreen (frontend/src/scene/room-loader.ts:15).
### Assets and instancing

70. Fetch and parse an asset at most once per canonical URI at a time.
71. Concurrent same-URI requests share one in-flight future.
72. Current AssetCache does this with URL-to-Promise caching (frontend/src/assets/cache.ts:7).
73. Instances have independent transforms and mutable material parameters.
74. Immutable vertex/index buffers and immutable source images may be shared.
75. Current material cloning prevents live textures bleeding across instances (frontend/src/assets/cache.ts:28).
76. Clone geometry before any index/vertex mutation.
77. Monitor cap removal follows that rule (frontend/src/scene/monitor-housing.ts:31).
78. Evict failed in-flight entries so transient failures can retry.
79. Reference-count parsed and GPU resources.
80. Release buffers, images, samplers, and pipelines after the last instance is gone.
81. Cache keys include intentional asset version query parameters.
82. Treat name-based housing repair as a legacy adapter.
83. Correct new assets author a real opening or separate back shell.
84. A repair adapter preserves rear cap and edge walls.
85. It reports removed triangle count and refuses an empty result.
86. Current repair recomputes index, groups, and bounds (frontend/src/scene/monitor-housing.ts:87).
### Display surfaces and sizing

87. DisplaySurface owns id, mesh, mapping, physical aspect, orientation, raster target, texture, and transient source handle.
88. Persistent assignment and power live outside the mesh.
89. Current code intentionally separates physical DisplaySurface from MonitorSession (frontend/src/display/surface.ts:9).
90. Planar aspect is local-X extent divided by local-Y extent.
91. Never use a world AABB for panel aspect; yaw would inflate it.
92. Current local measurement is the reference (frontend/src/display/surface.ts:35).
93. For raster height H, width is round(H * aspect).
94. Clamp aspect to [0.25, 8] and width to [640, 4096].
95. Current sizing implements those limits (frontend/src/display/surface.ts:26).
96. Default desk raster is 1440x900 and default terminal grid is 120x40 (frontend/src/display/session.ts:64).
97. Binding to glass recomputes physical aspect and advances a raster epoch (frontend/src/display/session.ts:88).
98. Raster epoch invalidates asynchronous work for an obsolete size.
99. Resizing preserves binding and electrical power.
100. Letterbox with min(destination_width/source_width, destination_height/source_height).
101. Current letterbox computation is the reference (frontend/src/display/session.ts:29).
102. Full-frame raster textures use explicit sRGB, linear filters, and no mipmaps.
103. Current texture setup does that (frontend/src/display/surface.ts:175).
104. Content is unlit and not tone-mapped.
105. Current surface material is MeshBasicMaterial with toneMapped false (frontend/src/display/surface.ts:214).
106. Curved walls may be double-sided; desk glass should be front-sided.
107. Glass, frame, rail, housing, and stand remain separate drawables.
### Exact cylindrical unwrap

108. Generate curved-wall UVs in surface-local coordinates.
109. For the current Y-axis cylinder, vertices are x,y,z in the XZ radial plane.
110. middle = atan2(sum(z), sum(x)).
111. delta = atan2(z,x) - middle.
112. wrapped = atan2(sin(delta), cos(delta)).
113. Mean-relative wrapping keeps arcs crossing ±π continuous.
114. Existing seam-safe measurement is at frontend/src/display/surface.ts:52.
115. u = (wrapped - minOffset) / (maxOffset - minOffset).
116. v = (y - minY) / (maxY - minY).
117. Current UV write is at frontend/src/display/surface.ts:76.
118. radius is mean hypot(x,z).
119. span is maxOffset - minOffset.
120. rise is maxY - minY.
121. physical aspect = radius * span / rise.
122. Clamp span and rise away from zero.
123. u increases toward the interior viewer's right.
124. General Rust code declares cylinder axis and viewer side.
125. Generated UVs require instance-owned mesh buffers if source geometry is shared.
126. Never use planar projection for curved text surfaces.
127. Planar projection distorts horizontal distance and glyph width.
128. Missing TEXCOORD_0 is valid when mapping is cylindrical.
129. Current wall screens had POSITION and NORMAL but no TEXCOORD_0 (frontend/src/display/surface.ts:46).
130. An authored unwrap may replace generated UVs without changing raster logic.
131. Validate authored UV bounds, nonzero area, and orientation.
### UV orientation

132. Painted +X appears at viewer-right and painted +Y appears upward.
133. Measure orientation from geometry/UV derivatives, not monitor-specific caller flags.
134. Choose a representative triangle near panel centroid.
135. Compute dP/du and dP/dv from triangle and UV deltas.
136. Compare dP/du with viewer-right and dP/dv with world-up.
137. Set flipU and flipV from those signs.
138. Current derivative measurement begins at frontend/src/display/surface.ts:101.
139. Degenerate UVs produce a warning and deterministic fallback.
140. Texture and hit testing share one orientation transform.
141. A texture flip without inverse pointer mapping is a bug.
142. Legacy MonScreen flip uses π rotation and X repeat -1 (frontend/src/display/surface.ts:175).
143. Prefer normalizing UV buffers once in Rust.
144. Otherwise store both uv_to_texture and texture_to_uv matrices.
### Terminal grid to texture

145. Lane A supplies authoritative grid, cursor, dimensions, and dirty rows.
146. Preserve the last grid across deltas.
147. Resize allocates a blank grid at new dimensions.
148. Keyframe establishes authoritative rows.
149. Delta replaces only named rows.
150. Resync retains the last raster until a new keyframe.
151. Clearing hasFrame on resync previously blacked the wall until another delta (frontend/src/display/video-wall.ts:364).
152. Delta for an unknown pane requests resync.
153. Current missing-cache resync is at frontend/src/display/video-wall.ts:404.
154. Cell aspect is 0.6 width per 1.0 height.
155. cell_h = min(rect_h/rows, rect_w/(cols*0.6)).
156. cell_w = cell_h*0.6.
157. Center the fitted grid.
158. Current wall glyph metrics are at frontend/src/display/video-wall.ts:776.
159. Support default, indexed, and RGB foreground/background.
160. INVERSE swaps foreground/background.
161. DIM changes opacity.
162. BOLD and ITALIC select style.
163. UNDERLINE and STRIKE draw decorations.
164. Invisible and width-zero continuation cells draw no glyph.
165. Clip cursor to bounds and draw it only when visible.
166. Preserve compatibility with the current per-cell loop (frontend/src/display/video-wall.ts:776).
167. Rust should use a shaped glyph atlas and instanced quads.
168. Atlas key includes cluster, face, size bucket, weight, italic, and shaping result.
169. Wide-glyph continuation cells generate no second quad.
170. Track dirty rows while applying deltas.
171. Update texture rows or instance ranges for small damage.
172. Rebuild fully when damage crosses a measured threshold.
173. Direct PTY bytes pass through a terminal emulator.
174. Apply resize metadata before subsequent bytes.
175. Current PTY stream resizes before later bytes (frontend/src/display/video-wall.ts:876).
176. Coalesce emulator damage within one render tick.
177. Async/session code owns emulator mutation.
178. Immutable render snapshots cross to renderer ownership.
### Web pixels

179. Web frames are flat, front-facing images.
180. Geometry applies wall curvature and monitor tilt.
181. Preserve aspect and letterbox.
182. Decode JPEG off the render thread.
183. Tag every decode with socket generation and frame sequence.
184. Discard obsolete generations.
185. Discard any sequence older than last presented.
186. Release decoded images immediately after upload/copy.
187. Current path closes ImageBitmap after drawing (frontend/src/display/video-wall.ts:974).
188. Choose capture width, height, and fps from lease/projected size.
189. Current wall hardcodes 1280x800 at 15 fps (frontend/src/display/video-wall.ts:974).
190. Static panes may emit no duplicate frame; retain the last texture.
191. Decode failure retains the last frame and emits bounded diagnostics.
192. Socket loss marks content stale/unavailable without erasing binding.
### Scheduling and GPU upload

193. Model updates mark a surface dirty.
194. Coalesce multiple changes into one presentation tick.
195. Current wall uses one queued requestAnimationFrame guard (frontend/src/display/video-wall.ts:444).
196. Current render clears the whole canvas and repaints all sections (frontend/src/display/video-wall.ts:453).
197. Current CanvasTexture upload is triggered with needsUpdate (frontend/src/display/video-wall.ts:573).
198. One render owner owns each GPU texture.
199. Async tasks never mutate GPU textures directly.
200. Async tasks send grid damage or decoded frames through bounded channels.
201. Render owner drains and coalesces once per frame.
202. Retain last presented texture while no update is ready.
203. Full uploads are acceptable for boot cards and small HUDs.
204. Terminals should use dirty-row writes or instance-buffer updates.
205. Web JPEGs may use full image uploads.
206. Under pressure, drop intermediate web frames for the newest complete one.
207. Do not drop terminal deltas unless merged into authoritative grid or superseded by keyframe.
208. Expose upload count, dropped frames, glyph instances, and texture bytes.
### Wall composition

209. Wall layout is descriptor-driven and section count is data.
210. Sections use validated normalized rectangles or deterministic grid layout.
211. Rectangles are bounded, nonempty, uniquely identified, and nonoverlapping unless z-order is explicit.
212. One assignment maps to one section.
213. Missing source renders SOURCE UNAVAILABLE and retains assignment.
214. Current wall preserves that identity (frontend/src/display/video-wall.ts:520).
215. Empty section renders UNASSIGNED.
216. Catalog images are aspect-contained.
217. PTY uses terminal raster; web uses pixel raster.
218. Router hit regions are produced by the same layout that paints controls.
219. Persisted source assignments override defaults.
220. Current assignments persist in local storage (frontend/src/display/video-wall.ts:748).
221. Persistence key uses descriptor room id and display id.
222. Release stream resources for no-longer-visible sections.
223. Current view rebuild does release removed pane streams (frontend/src/display/video-wall.ts:297).
224. Physical reset/router controls belong on the physical display, not floating DOM.
### Picking and hit routing

225. Raycast from pointer NDC into scene.
226. Surface hit returns mesh, distance, triangle, and interpolated UV.
227. Transform raw UV through inverse orientation mapping.
228. raster_x = transformed_u * raster_width.
229. raster_y = (1-transformed_v) * raster_height.
230. Current wall uses this raw mapping (frontend/src/main.ts:1346).
231. Hit regions use raster pixels from the same layout pass that painted them.
232. HUD selection never moves the camera.
233. Current open wall router dispatches immediately without camera motion (frontend/src/main.ts:1391).
234. Use actual raster dimensions; do not assume 1024x512.
235. Current desk HUD does assume 1024x512 (frontend/src/main.ts:1058).
236. Resolve semantic ownership before generic scene selection.
237. Monitor assembly descendants carry explicit bay/monitor id.
238. A monitor may win slightly behind the nearest same-station edge.
239. This handles slab, grommet, bezel, or stand barely nearer than glass.
240. Current tolerance is 0.25 m (frontend/src/main.ts:728).
241. Rust makes tolerance prefab-specific and scale-aware.
242. Wall never wins over nearer station geometry within tolerance.
243. Current routing resolves desk before wall (frontend/src/main.ts:1067).
244. Floor blocks click-through to the far wall.
245. Current floor occlusion margin is 0.04 m (frontend/src/main.ts:1042).
246. Double-click recognition is section-local and cancels pending single-click.
247. Pointer drag beyond threshold cancels click.
248. Wheel over physical HUD scrolls HUD and stops camera dolly.
249. Current capture-phase wheel handler does so (frontend/src/main.ts:1167).
250. Test four curved-surface corners and center for UV/action parity.
251. Test shallow-angle monitor hits with bezel, stand, slab, and HUD intersections.
### Room-shaped station layout

252. Circular rooms use polar placement.
253. Rectangular rooms use grid placement.
254. Polar first angle = center_angle - spacing*(count-1)/2.
255. Station i = center + radius*[cos(angle_i), sin(angle_i)] in XZ.
256. Current polar implementation is at frontend/src/scene/layout.ts:25.
257. Grid row = floor(index/columns); column = index%columns.
258. Center X/Z around origin using pitch.
259. Current grid implementation is at frontend/src/scene/layout.ts:36.
260. Invalid dimensions fail descriptor validation.
261. Output is keyed by stable station id.
262. Resolve facing separately from position.
263. For regular curved surfaces, sample normal at station azimuth.
264. Transform normals with surface normal matrix.
265. Flatten to XZ and orient toward station.
266. Current sampler follows that process (frontend/src/scene/layout.ts:52).
267. Arbitrary/nonconcentric surfaces need closest-triangle normal or authored anchor.
268. Desk height moves a dedicated authored pivot.
269. Current station finds Desk_Height_Pivot (frontend/src/scene/station.ts:31).
270. Height travel limits belong in prefab metadata.
271. Height moves desktop, HUD, monitors, and stands without moving station root.
## WHAT WORKED

272. Promise sharing stopped repeated GLB parse for repeated desk prefabs (frontend/src/assets/cache.ts:18).
273. Per-instance material cloning stopped display textures bleeding across desks (frontend/src/assets/cache.ts:32).
274. Separate glass/frame/rail/housing allowed unlit content plus restrained luminous styling (frontend/src/main.ts:1446).
275. Mean-relative cylindrical unwrap survived ±π seams and missing authored UVs (frontend/src/display/surface.ts:52).
276. radius*span/rise preserved terminal proportions on curved walls.
277. Geometry-derived orientation survived authored desk quads and generated wall UV conventions (frontend/src/display/surface.ts:101).
278. Last-raster frame cache survived resync/keyframe gaps without black flashes (frontend/src/display/video-wall.ts:364).
279. One render-queued flag coalesced bursts of deltas and image loads (frontend/src/display/video-wall.ts:444).
280. Raster-space hit rectangles kept controls attached to desk/wall surfaces (frontend/src/display/video-wall.ts:428).
281. Semantic monitor ownership plus desk-first hit order fixed shallow-angle stand/slab races (frontend/src/main.ts:1067).
282. Pure polar/grid functions stopped repeated hand-authored desk pose edits (frontend/src/scene/layout.ts:25).
283. Surface-normal yaw survived curved screens and shifted room centers (frontend/src/scene/layout.ts:52).
284. Content state outside DisplaySurface survived power cycling and source switching (frontend/src/display/session.ts:9).
285. Closing accepted ImageBitmaps limited decoder resource leakage (frontend/src/display/video-wall.ts:974).
286. Cloning geometry before housing repair avoided corrupting shared cached meshes (frontend/src/scene/monitor-housing.ts:31).
## WHAT DIDN'T

287. **The room descriptor is mostly theater.**
288. It declares stations, wallDisplays, and views, but RoomLoader ignores them (frontend/src/descriptors/room-descriptor.ts:39; frontend/src/scene/room-loader.ts:15).
289. Actual bays, layout, overview, reset, and floor policy live in a separate TS constant (frontend/src/config/rooms/panoramic-theater.ts:23).
290. Bug: room setup stayed hardcoded and agents repeatedly rewrote main.ts.
291. **Validation is dangerously weak.**
292. It checks only id, shell.asset, and stations array (frontend/src/descriptors/room-descriptor.ts:50).
293. Bug: broken references and layouts fail later inside async scene setup.
294. **Semantic roles do not drive loading.**
295. RoomLoader indexes names and selects presentationScreen by name (frontend/src/scene/room-loader.ts:28).
296. main.ts hardcodes Wall_Screen_1..3 (frontend/src/main.ts:1470).
297. Bug: correct extras cannot save a renamed asset from going dark.
298. **Room cleanup is destructive and contradicts the asset.**
299. It hides every mesh outside a narrow name/legacy-role whitelist (frontend/src/scene/room-cleanup.ts:9).
300. Canonical room.shell, ceiling.main, pedestal.*, and accent.* are not protected.
301. Bug: walls, ceiling, and central pedestal disappear despite being authored.
302. This is a second conflicting room definition, not cleanup.
303. **Canonical screen.surface is absent from cleanup policy.**
304. Screens survive only because names match Wall_Screen_[1-3] (frontend/src/scene/room-cleanup.ts:3).
305. Bug: a renamed, correctly tagged screen is hidden.
306. **Only one of three wall screens is wired.**
307. All three get UVs, but only Wall_Screen_2 gets DisplaySurface/VideoWallController (frontend/src/main.ts:1470).
308. Flanking screens receive dark materials.
309. Bug: two authored displays cannot be configured or streamed.
310. **Wall composition is hardcoded to four sections.**
311. Three separate loops use section<4 (frontend/src/display/video-wall.ts:250).
312. Persistence key is hardcoded to room-display-2 (frontend/src/display/video-wall.ts:154).
313. Bug: intended section-count changes require code edits and drift from the room design.
314. **Floor recut creates 180 individual meshes from hardcoded radii.**
315. It hides authored sectors then builds five rings times 36 wedges (frontend/src/scene/floor-grid.ts:29; frontend/src/scene/floor-grid.ts:51).
316. Bug: excess draw calls and a floor design that is not data-driven.
317. **Asset cache permanently caches rejection.**
318. Failed Promise remains in the URL map (frontend/src/assets/cache.ts:18).
319. Bug: one transient failure poisons the asset until page reload.
320. It also lacks resource reference counting/disposal.
321. **Full-frame Canvas2D repaint is the raster architecture.**
322. Wall clears and repaints every section (frontend/src/display/video-wall.ts:453).
323. Glyphs call fillText inside nested cell loops (frontend/src/display/video-wall.ts:776).
324. Bug: CPU spikes and full texture uploads as grid/wall size grows.
325. There is no glyph atlas or dirty-row upload.
326. **PTY is rasterized twice.**
327. rasterPty repaints 1280x800, then wall render copies that canvas (frontend/src/display/video-wall.ts:927).
328. Bug: duplicate CPU drawing and memory bandwidth per terminal write.
329. **JPEG completion can present frames out of order.**
330. It rejects old socket generation but not an older completion from the same socket (frontend/src/display/video-wall.ts:999).
331. Bug: older frame can overwrite newer under decode pressure.
332. **Web capture policy is magic constants.**
333. Every wall web pane requests 1280x800@15 (frontend/src/display/video-wall.ts:974).
334. Bug: tiny/far sections cost as much bandwidth as focused surfaces.
335. **Global 25 cm monitor tolerance is an oversized patch.**
336. It fixed shallow-angle races but can steal nearby clicks (frontend/src/main.ts:728).
337. Use semantic hit proxies and prefab-specific tolerance.
338. **Desk HUD hit mapping is hardcoded to 1024x512.**
339. Literal dimensions convert UV to pixels (frontend/src/main.ts:1058).
340. Bug: any HUD resolution/aspect change desynchronizes visuals and actions.
341. **Texture and pointer orientation are separate systems.**
342. Texture sampling may rotate/repeat UV (frontend/src/display/surface.ts:175).
343. Hit testing uses raw UV plus V inversion (frontend/src/main.ts:1346).
344. Bug: a flipped interactive surface can click mirrored controls.
345. **Runtime monitor-panel surgery exposes a bad asset boundary.**
346. It finds names by regex and removes faces above a 0.45 normal-dot threshold (frontend/src/scene/monitor-housing.ts:31).
347. Bug risk: renamed or unusual geometry silently repairs the wrong face.
348. **Desk travel is hardcoded.**
349. Station assumes 0.65–1.25 m and baseline 0.72 (frontend/src/scene/station.ts:20).
350. Bug: a different prefab can clip while API reports valid height.
351. **Normal sampling chooses nearest vertex angle, not nearest surface point.**
352. It assumes radial relation to roomCenter (frontend/src/scene/layout.ts:52).
353. Bug risk: nonconcentric surfaces face desks incorrectly.
354. **Celestial decoration is nondeterministic infrastructure.**
355. Stars use Math.random (frontend/src/scene/celestial.ts:201).
356. Bug risk: screenshots and golden tests are not reproducible.
357. It is optional decoration, not terminal-surface contract.
## RUST NOTES

358. Use newtypes for RoomId, StationId, DisplayId, SurfaceId, BayId, and AssetId.
359. Deserialize a versioned descriptor with serde tagged enums.
360. Preserve unknown GLB extras in metadata.
361. Validate references after indexing nodes and return all path-qualified errors.
362. Represent SemanticRole as non_exhaustive known variants plus Unknown(String).
363. Build HashMap<SemanticRole, SmallVec<NodeHandle>> and enforce cardinality.
364. Bind behavior by role plus descriptor id; keep names only for migration logs.
365. AssetManager may use HashMap<AssetUri, Shared<BoxFuture<Result<Arc<ParsedAsset>, Error>>>>.
366. Remove failed futures after completion.
367. ParsedAsset owns immutable CPU mesh/image data.
368. Scene instances use Arc handles for immutable buffers.
369. Per-instance transforms and material params are owned values.
370. Compatibility mesh rewrites create a new Arc<MeshData>.
371. Use weak refs or generations so room unload releases GPU resources.
372. RoomInstance owns bounds, role index, stations, displays, lights, floor, and views.
373. StationInstance owns root transform and bay handles.
374. DisplaySurface owns geometry, mapping, orientation, aspect, and GPU texture.
375. Lane C's store owns serializable assignment/power.
376. Display controllers own only transient render/hit-test lifecycle.
377. Tokio tasks own sockets, JPEG decode jobs, and terminal-emulator mutation.
378. Renderer/device task solely mutates GPU resources.
379. Connect sides with bounded channels.
380. Messages carry stream generation and frame sequence.
381. Render owner discards stale generations and non-newer sequences.
382. Never hold a grid mutex while issuing GPU work.
383. Never run JPEG decode or font shaping in a render callback.
384. Keep one authoritative CellGrid per pane.
385. Apply deltas in protocol order and record dirty rows.
386. Publish immutable/copy-on-write render snapshots.
387. Use double buffering or row versions at high update rates.
388. Use glyph atlas plus instanced background/glyph quads.
389. Keep cursor separate so blinking does not dirty grid.
390. Full rebuild only on dimensions/font/mapping changes.
391. Decode JPEG in spawn_blocking or dedicated pool.
392. Allow one running decode plus one newest pending frame per surface.
393. Drop superseded pending JPEGs.
394. Track last_presented_sequence.
395. Upload decoded RGBA on render owner and reuse staging buffers.
396. For wgpu, textures need TEXTURE_BINDING|COPY_DST.
397. Prefer explicit sRGB texture formats.
398. Normalize UV flips at load when possible.
399. Otherwise store uv_to_texture and inverse texture_to_uv.
400. Apply inverse transform before hit-region lookup.
401. Flat captures require no pre-warp for curved geometry.
402. Generate hit regions and draw primitives from one pure layout function.
403. Resolve priority: HUD control, monitor, desk, floor, wall.
404. Use per-prefab hit proxy/tolerance.
405. Test hit ordering with real asset transforms.
406. Keep polar/grid placement pure and unit-tested.
407. Resolve facing separately from placement.
408. Use analytical normals for regular cylinders.
409. Use BVH closest-triangle normal for arbitrary meshes.
410. Use authored anchor axis where supplied.
411. Derive camera only after final room/station transforms.
412. Delivery order:
413. descriptor schema and exhaustive validation;
414. GLB extras parsing and role index;
415. pure placement and facing;
416. DisplaySurface plus cylindrical UV tests;
417. CellGrid plus glyph-atlas renderer;
418. JPEG generation/sequence gating;
419. bounded dirty uploads;
420. UV-consistent picking;
421. asset lifetime and room reload tests;
422. golden images for planar and curved surfaces.
423. Acceptance tests:
424. ±π arc unwrap is continuous.
425. radius*span/rise matches physical aspect.
426. Authored/generated surfaces paint upright and viewer-right.
427. UV actions match corners and center after flips.
428. Rotated planar monitor keeps aspect.
429. Delta changes only named rows.
430. Resync preserves visible raster.
431. Concurrent JPEG decode cannot present older frame.
432. Hidden/removed surface releases stream/decode resources.
433. Three GLB instances share buffers but not mutable materials.
434. Transient asset failure recovers without process restart.
435. Unknown roles remain visible and diagnosable.
436. All three wall screens can independently become DisplaySurfaces.
437. Section count comes only from descriptor.
438. Circular/rectangular rooms need no source edits.
439. Pedestal, shell, and ceiling follow descriptor policy, not regex.
440. Shallow monitor click beats own bezel, not unrelated geometry.
441. Floor blocks far-wall click-through.
442. Upload queue remains bounded under burst load.