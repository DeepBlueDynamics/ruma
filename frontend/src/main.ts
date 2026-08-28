import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Terminal } from '@xterm/xterm';
import { createDisplaySurface, type DisplaySurface } from './display/surface';
import { buildStationLayout, sampleSurfaceNormalAtStation, yawFromSurfaceNormal } from './scene/layout';
import { meshMiddleAzimuth } from './scene/wall-unit';
import { CLOSED_DESKS_KEY, nextSpawnedDeskStationId, normalizeClosedDesks, normalizeSpawnedDesks, SPAWNED_DESKS_KEY, spawnedDeskOrdinal, type SpawnedDeskRecord, type SpawnedDeskVariant } from './state/spawned-desks';
import { recutFloorGrid } from './scene/floor-grid';
import { removeRoomWallsAndCeiling } from './scene/room-cleanup';
import { panoramicTheaterRoom } from './config/rooms/panoramic-theater';
import { bindSessionSurface, createMonitorSession, drawContained, fillBezel, sessionContentRect, type MonitorSession } from './display/session';
import { VideoWallController, type VideoWallPane, type VideoWallRegion, type VideoWallRouterRegion } from './display/video-wall';
import { sessionAlreadyStreaming } from './hyperia/stream';
import { TabStream } from './hyperia/tab-stream';
import type { Color, WallMessage } from './hyperia/protocol';
import { paintOverviewGrid } from './content/source';
import { StreamBroker } from './surfaces/broker';
import type { OpsRoomCommand, OpsRoomCommandResult, OpsRoomSnapshot, SourceConnection, SourceRef } from './control/ops-room';
import { installClientObservability } from './observability/client-logs';
import { SystemLoadTracker } from './observability/system-load';
import { AssetCache } from './assets/cache';
import { bayByIndex, bayIdForIndex, StateStoreV3 } from './state/store';
import { RoomLoader } from './scene/room-loader';
import { StationInstance } from './scene/station';
import { CelestialSky } from './scene/celestial';
import { openMonitorHousingFronts } from './scene/monitor-housing';
import './style.css';

installClientObservability();

const streamBroker = new StreamBroker({ overviewFps: 10, focusedDistance: 6, releaseDistance: 8.5 });
const releasingLeases = new Set<string>();

function screenLeaseId(deskId: string, index: number): string {
  return `${deskId}:${index}`;
}

function registerDeskScreen(desk: DeskStation, index: number, mesh: THREE.Mesh): void {
  const id = screenLeaseId(desk.id, index);
  streamBroker.register({
    id,
    // Screen glass only — never the desk root. Hidden legs must not enter the gate.
    // Do not wrap this mesh in SurfaceDisplay: its constructor replaces the
    // session canvas material with an empty texture, so the glass goes dark
    // even when a MonitorSession is painting.
    object: mesh,
    getPowered: () => desk.sessions[index - 1]?.powered === true,
    getStreamSession: () => desk.sessions[index - 1],
    getAssignment: () => {
      const session = desk.sessions[index - 1];
      const paneId = desk.monitorTargets[index - 1];
      // Tab bindings own their own /ws/tab socket; the broker must not try to
      // lease "tab:<id>" as if it were a paneId.
      if (!session || !paneId || tabIdFromBinding(paneId)) return null;
      const pane = discoveredPanes.find(candidate => candidate.paneId === paneId);
      const kind = pane?.shell === 'web' || session.source.kind === 'web-pixels' ? 'pixels' : 'pty';
      return { paneId, kind };
    },
    acquireFocused: (kind, paneId) => {
      const session = desk.sessions[index - 1];
      if (!session?.powered) return;
      session.paneId = paneId;
      session.source = kind === 'pixels' ? { kind: 'web-pixels', paneId } : { kind: 'pty', paneId };
      if (kind === 'pixels') {
        const pane = discoveredPanes.find(candidate => candidate.paneId === paneId)
          ?? { paneId, title: '', cols: 120, rows: 40, state: 'running', shell: 'web' };
        renderWebPaneCard(session, pane);
        return;
      }
      preparePtySession(session);
    },
    onFocusedText: (message, assignment) => {
      const session = desk.sessions[index - 1];
      if (!session) return;
      handleFocusedControl(session, desk, index - 1, message, assignment.kind);
    },
    onFocusedBinary: (data, assignment) => {
      if (tabStreams.has(id)) return;
      const session = desk.sessions[index - 1];
      if (!session?.powered) return;
      if (assignment.kind === 'pixels') {
        void paintFocusedPixels(session, data);
        return;
      }
      if (!(data instanceof ArrayBuffer)) return;
      session.live = true;
      session.terminal.write(new Uint8Array(data), () => renderPtyTerminal(session));
    },
    releaseFocused: () => {
      const session = desk.sessions[index - 1];
      if (!session) return;
      releasingLeases.add(id);
      session.generation++;
      session.socket?.close();
      session.socket = undefined;
      session.live = false;
    },
    applyOverview: view => {
      if (tabStreams.has(screenLeaseId(desk.id, index))) return;
      const session = desk.sessions[index - 1];
      if (!session?.powered) return;
      const context = session.canvas.getContext('2d');
      if (!context) return;
      paintOverviewGrid({
        canvas: session.canvas,
        context,
        texture: session.texture,
        markDirty: () => { session.texture.needsUpdate = true; },
      }, view);
      session.live = view.hasFrame;
    },
  });
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<div id="status">LOADING DESK PROTOTYPE</div><div id="system-load" data-level="ok" aria-label="System load tracker"></div><button id="reset-view" type="button">RESET VIEW</button>`;
const status = document.querySelector<HTMLDivElement>('#status')!;
const systemLoad = new SystemLoadTracker(document.querySelector<HTMLDivElement>('#system-load')!);
const resetView = document.querySelector<HTMLButtonElement>('#reset-view')!;

const DESK_LEG_MESH_NAMES = new Set([
  'Desk_Foot_Left',
  'Desk_Foot_Right',
  'Desk_LegUpper_Left',
  'Desk_LegUpper_Right',
  'Desk_SupportArm_Left',
  'Desk_SupportArm_Right',
  'Desk_LegSleeve_Left',
  'Desk_LegSleeve_Right',
]);
const DESK_HEIGHT_MIN_METRES = .65;
const DESK_HEIGHT_MAX_METRES = 1.25;

function hideDeskLegMeshes(root: THREE.Object3D): void {
  root.traverse(node => {
    if (node instanceof THREE.Mesh && DESK_LEG_MESH_NAMES.has(node.name)) node.visible = false;
  });
}

class DeskStation {
  selectedMonitor = 1;
  readonly monitorTargets: string[];
  readonly monitorScreens = new Map<number, THREE.Mesh>();
  readonly sessions: MonitorSession[] = [];
  expandedTabId = '';
  hudScroll = 0;
  hudScrollMax = 0;
  readonly restoredPower: boolean[];
  hudPanel!: THREE.Mesh;
  hudCanvas!: HTMLCanvasElement;
  hudAnchor!: THREE.Object3D;
  viewPosition!: THREE.Vector3;
  viewTarget!: THREE.Vector3;
  readonly heightPivot: THREE.Object3D;
  readonly defaultHeightMetres: number;
  heightMetres: number;
  readonly instance: StationInstance;
  private readonly heightPivotBaseY: number;

  constructor(readonly id: string, readonly label: string, readonly object: THREE.Object3D, readonly monitorCount: number) {
    this.instance = new StationInstance({ id, label, object, monitorCount });
    const heightPivot = object.getObjectByName('Desk_Height_Pivot');
    const top = object.getObjectByName('Desk_Wood_Top');
    if (!heightPivot || !top) throw new Error(`${id} is missing Desk_Height_Pivot or Desk_Wood_Top`);
    this.heightPivot = heightPivot;
    this.heightPivotBaseY = heightPivot.position.y;
    object.updateWorldMatrix(true, true);
    const deskFloor = new THREE.Box3().setFromObject(object).min.y;
    this.defaultHeightMetres = new THREE.Box3().setFromObject(top).max.y - deskFloor;
    const store = StateStoreV3.getInstance();
    const stationState = store.getStationState('panoramic-theater', id, monitorCount);

    this.heightMetres = THREE.MathUtils.clamp(
      stationState.heightM ?? this.defaultHeightMetres,
      DESK_HEIGHT_MIN_METRES,
      DESK_HEIGHT_MAX_METRES,
    );
    this.applyHeight();
    // Retired placeholder-catalog assignments ('terminal:*') degrade to an
    // empty bay: powered-on it paints the on-surface source picker.
    this.monitorTargets = Array.from({ length: monitorCount }, (_, i) => {
      const paneId = bayByIndex(stationState, i + 1)?.paneId ?? '';
      return paneId.startsWith('terminal:') ? '' : paneId;
    });
    this.restoredPower = Array.from({ length: monitorCount }, (_, i) => bayByIndex(stationState, i + 1)?.powered === true);
    this.selectedMonitor = Math.min(monitorCount, Math.max(1, stationState.selectedMonitor ?? 1));
    this.expandedTabId = stationState.expandedTabId ?? '';
    this.hudScroll = stationState.hudScroll ?? 0;
  }


  selectMonitor(index: number): void {
    if (index < 1 || index > this.monitorCount) return;
    this.selectedMonitor = index;
    this.save();
  }

  save(): void {
    const store = StateStoreV3.getInstance();
    store.updateStationState('panoramic-theater', this.id, {
      heightM: this.heightMetres,
      selectedMonitor: this.selectedMonitor,
      expandedTabId: this.expandedTabId,
      hudScroll: this.hudScroll,
      bays: this.monitorTargets.map((paneId, i) => ({
        bayIndex: i + 1,
        bayId: bayIdForIndex(i + 1),
        paneId,
        powered: this.sessions[i]?.powered ?? this.restoredPower[i] ?? false,
      })),
    }, this.monitorCount);
  }

  setHeight(metres: number, persist = true): number {
    if (!Number.isFinite(metres)) throw new TypeError(`Desk height must be a finite number, received ${metres}`);
    this.heightMetres = THREE.MathUtils.clamp(metres, DESK_HEIGHT_MIN_METRES, DESK_HEIGHT_MAX_METRES);
    this.applyHeight();
    if (this.hudAnchor) refreshDeskView(this);
    if (persist) this.save();
    return this.heightMetres;
  }

  private applyHeight(): void {
    this.heightPivot.position.y = this.heightPivotBaseY + this.heightMetres - this.defaultHeightMetres;
    this.object.updateWorldMatrix(true, true);
  }

  reset(): void {
    this.monitorTargets.fill(''); this.selectedMonitor = 1; this.expandedTabId = ''; this.hudScroll = 0;
    this.sessions.forEach((_, i) => setMonitorPower(this, i + 1, false, false));
    this.save(); drawDeskHud(this.id);
  }
}
type DeskHudHitRegion = {
  kind: 'monitor' | 'tab' | 'tab-connect' | 'pane' | 'scroll-up' | 'scroll-down' | 'remove';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  index?: number;
  tabId?: string;
  paneId?: string;
};
const desks = new Map<string, DeskStation>();
const DESK_STORAGE_KEY = 'ops-room-selected-desk-v1';
let selectedDeskId = localStorage.getItem(DESK_STORAGE_KEY) || 'operator-desk-1';

// Operator-spawned desks. The registry is the durable truth; each record is
// materialized into full station machinery (bays, HUD, broker leases) on boot
// and on spawn, and torn down again by the HUD's ✕ affordance.
let spawnedDesks: SpawnedDeskRecord[] = (() => {
  try { return normalizeSpawnedDesks(JSON.parse(localStorage.getItem(SPAWNED_DESKS_KEY) ?? 'null')); }
  catch { return []; }
})();
function persistSpawnedDesks(): void {
  localStorage.setItem(SPAWNED_DESKS_KEY, JSON.stringify(spawnedDesks));
}
// Built-in desks the operator closed via the HUD ✕. Spawned desks disappear
// by leaving their registry; the three authored stations persist closure and
// are skipped at boot.
let closedDesks: string[] = (() => {
  try { return normalizeClosedDesks(JSON.parse(localStorage.getItem(CLOSED_DESKS_KEY) ?? 'null')); }
  catch { return []; }
})();
function persistClosedDesks(): void {
  localStorage.setItem(CLOSED_DESKS_KEY, JSON.stringify(closedDesks));
}
let monitorHold: { deskId: string; index: number; start: number; triggered: boolean } | undefined;
const diagnostics = { appVersion: 'unknown', hyperiaVersion: 'offline', hyperiaOnline: false, gpu: 'unavailable', webgl: false };

let resolveOpsRoomReady!: () => void;
let opsRoomReadyResolved = false;
const opsRoomReady = new Promise<void>(resolve => { resolveOpsRoomReady = resolve; });

function maybeResolveOpsRoomReady(): void {
  if (opsRoomReadyResolved || !roomShell || desks.size < 3) return;
  opsRoomReadyResolved = true;
  resolveOpsRoomReady();
}

function opsRoomSnapshot(): OpsRoomSnapshot {
  const connections = new Map<string, { source: SourceRef; targets: SourceConnection[] }>();
  const targetsFor = (source: SourceRef): SourceConnection[] => {
    const key = source.kind === 'pane' ? `pane:${source.paneId}` : `tab:${source.tabId}`;
    let entry = connections.get(key);
    if (!entry) {
      entry = { source, targets: [] };
      connections.set(key, entry);
    }
    return entry.targets;
  };
  for (const viewer of wallViewers) viewer.controller.sectionSourcesSnapshot().forEach((source, index) => {
    if (source) targetsFor(source).push({
      kind: 'room-display-section',
      displayId: `room-display-${viewer.controller.displayIndex}`,
      sectionId: `section-${index + 1}`,
    });
  });
  desks.forEach(desk => desk.monitorTargets.forEach((target, index) => {
    if (!target) return;
    const tabId = tabIdFromBinding(target);
    targetsFor(tabId ? { kind: 'tab', tabId } : { kind: 'pane', paneId: target }).push({
      kind: 'desk-monitor',
      deskId: desk.id,
      monitorId: `monitor-${index + 1}`,
      powered: desk.sessions[index]?.powered ?? false,
    });
  }));
  return {
    schema: 'ops-room/browser-state@1',
    sceneReady: !!roomShell && desks.size >= 3,
    tabs: discoveredTabs.map(tab => ({ tabId: tab.tabId, name: tab.name, paneIds: tab.panes.map(pane => pane.paneId) })),
    panes: discoveredPanes.map(pane => ({ paneId: pane.paneId, name: paneCreatureName(pane) || pane.paneId.slice(0, 8), shell: pane.shell })),
    connections: [...connections.values()],
  };
}

async function dispatchOpsRoom(command: OpsRoomCommand): Promise<OpsRoomCommandResult> {
  const source = command.source;
  const known = source.kind === 'pane'
    ? discoveredPanes.some(pane => pane.paneId === source.paneId)
    : discoveredTabs.some(tab => tab.tabId === source.tabId);
  if (!known) return {
    ok: false,
    command: command.kind,
    code: 'source_not_found',
    message: `Unknown ${source.kind} ${source.kind === 'pane' ? source.paneId : source.tabId}`,
  };
  if (command.kind === 'source.read') return {
    ok: true,
    command: command.kind,
    snapshot: opsRoomSnapshot(),
  };

  if (command.kind !== 'source.connect' || command.target?.kind !== 'desk-monitor') return {
    ok: false,
    command: command.kind,
    code: 'invalid_target',
    message: 'Source connect requires a desk-monitor target',
  };

  const match = /^monitor-(\d+)$/.exec(command.target.monitorId);
  const monitorIndex = match ? Number(match[1]) : 0;
  const desk = desks.get(command.target.deskId);
  if (!desk || monitorIndex < 1 || monitorIndex > desk.monitorCount || !desk.sessions[monitorIndex - 1]) return {
    ok: false,
    command: command.kind,
    code: 'target_not_ready',
    message: `Desk monitor ${command.target.deskId}/${command.target.monitorId} is not ready`,
  };
  if (source.kind === 'tab') connectTabToMonitor(desk, monitorIndex, source.tabId);
  else connectPaneToMonitor(desk, monitorIndex, source.paneId);
  return { ok: true, command: command.kind, snapshot: opsRoomSnapshot() };
}

window.opsRoom = {
  ready: opsRoomReady,
  snapshot: opsRoomSnapshot,
  dispatch: dispatchOpsRoom,
};

function registerDesk(id: string, label: string, object: THREE.Object3D, monitorCount: number): DeskStation {
  const station = new DeskStation(id, label, object, monitorCount);
  object.name = id;
  object.userData.deskId = id;
  object.traverse(child => { child.userData.deskId = id; });
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  const center = bounds.getCenter(new THREE.Vector3());
  let top: THREE.Object3D | undefined;
  object.traverse(child => { if (child.name === 'Desk_Wood_Top') top = child; });
  const topBounds = top ? new THREE.Box3().setFromObject(top) : bounds;
  // A real, flat display embedded into the front-center of the desktop (+Z is
  // the operator/viewer side in the authored desk asset).
  const controlWorld = new THREE.Vector3(center.x, topBounds.max.y + .012, topBounds.max.z - .14);
  const hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1024; hudCanvas.height = 512;
  const hudTexture = new THREE.CanvasTexture(hudCanvas);
  hudTexture.colorSpace = THREE.SRGBColorSpace;
  const hudPanel = new THREE.Mesh(new THREE.PlaneGeometry(.38, .2), new THREE.MeshBasicMaterial({ map: hudTexture, toneMapped: false }));
  hudPanel.name = `${id}-hud-panel`;
  hudPanel.rotation.x = -Math.PI / 2;
  hudPanel.position.copy(station.heightPivot.worldToLocal(controlWorld.clone()));
  hudPanel.userData.deskId = id;
  hudPanel.userData.hudToggle = true;
  hudPanel.userData.hudTexture = hudTexture;
  hudPanel.userData.hitRegions = [];
  station.heightPivot.add(hudPanel);
  const hudAnchor = new THREE.Object3D();
  hudAnchor.position.copy(station.heightPivot.worldToLocal(controlWorld.clone().add(new THREE.Vector3(0, .08, 0))));
  station.heightPivot.add(hudAnchor);
  // Calibrated from the operator's live camera placement, then squared to the
  // station centerline. Preserve that head height/downward angle for every
  // desk by expressing the pose relative to its authored top and center.
  const viewTarget = new THREE.Vector3(center.x, topBounds.max.y + .207, center.z + .072);
  const viewPosition = new THREE.Vector3(center.x, topBounds.max.y + .81, center.z + 1.163);
  Object.assign(station, { hudPanel, hudCanvas, hudAnchor, viewPosition, viewTarget });
  desks.set(id, station);
  drawDeskHud(id);
  maybeResolveOpsRoomReady();
  return station;
}

function boundsInObjectSpace(object: THREE.Object3D, space: THREE.Object3D): THREE.Box3 {
  object.updateWorldMatrix(true, true);
  space.updateWorldMatrix(true, false);
  const worldToSpace = space.matrixWorld.clone().invert();
  const bounds = new THREE.Box3().makeEmpty();
  const point = new THREE.Vector3();
  object.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.computeBoundingBox();
    const local = node.geometry.boundingBox;
    if (!local) return;
    for (const x of [local.min.x, local.max.x])
      for (const y of [local.min.y, local.max.y])
        for (const z of [local.min.z, local.max.z]) {
          point.set(x, y, z).applyMatrix4(node.matrixWorld).applyMatrix4(worldToSpace);
          bounds.expandByPoint(point);
        }
  });
  return bounds;
}

const stationPlacements = buildStationLayout(panoramicTheaterRoom.stationLayout);
const roomLayoutCenter = new THREE.Vector3(
  panoramicTheaterRoom.stationLayout.kind === 'polar' ? panoramicTheaterRoom.stationLayout.center[0] : 0,
  0,
  panoramicTheaterRoom.stationLayout.kind === 'polar' ? panoramicTheaterRoom.stationLayout.center[1] : 0,
);
let roomShell: THREE.Object3D | undefined;
let presentationSurface: THREE.Mesh | undefined;
// A tab binding lives in the same bay slot as a pane binding, tagged so the
// broker and router can tell them apart without a schema migration. The
// {kind,id} bay model supersedes this encoding when it lands.
const TAB_BINDING_PREFIX = 'tab:';
function tabBindingId(tabId: string): string { return `${TAB_BINDING_PREFIX}${tabId}`; }
function tabIdFromBinding(value: string | undefined): string | undefined {
  return value && value.startsWith(TAB_BINDING_PREFIX) ? value.slice(TAB_BINDING_PREFIX.length) : undefined;
}
const tabStreams = new Map<string, TabStream>();
const dirtyTabStreams = new Set<string>();

function tabStreamKey(deskId: string, index: number): string { return `${deskId}:${index}`; }

function disposeTabStream(deskId: string, index: number): void {
  const key = tabStreamKey(deskId, index);
  tabStreams.get(key)?.dispose();
  tabStreams.delete(key);
  dirtyTabStreams.delete(key);
}

function attachTabStream(desk: DeskStation, index: number, tabId: string): void {
  const session = desk.sessions[index - 1];
  if (!session?.powered) return;
  const key = tabStreamKey(desk.id, index);
  disposeTabStream(desk.id, index);
  session.generation++;
  session.socket?.close();
  session.socket = undefined;
  session.live = false;
  session.paneId = '';
  streamBroker.notifyChanged(screenLeaseId(desk.id, index));
  const stream = new TabStream(tabId, session.canvas, () => dirtyTabStreams.add(key));
  const tab = discoveredTabs.find(candidate => candidate.tabId === tabId);
  if (tab) stream.rememberNames(tab.panes.map(pane => ({
    paneId: pane.paneId,
    name: pane.name,
    title: pane.title,
    state: pane.state,
    bspX: pane.bspX,
    bspY: pane.bspY,
    bspW: pane.bspW,
    bspH: pane.bspH,
  })));
  tabStreams.set(key, stream);
  stream.connect();
  dirtyTabStreams.add(key);
  session.live = true;
}

function connectTabToMonitor(desk: DeskStation, index: number, tabId: string): void {
  const session = desk.sessions[index - 1];
  if (!session) return;
  desk.monitorTargets[index - 1] = tabBindingId(tabId);
  desk.save();
  // Routing content never changes electrical power and never moves the camera.
  // An off monitor remembers this assignment and attaches when powered on.
  if (session.powered) attachTabStream(desk, index, tabId);
  drawAllDeskHuds();
  status.textContent = `${desk.label.toUpperCase()} · MONITOR ${index} · TAB ${tabId.slice(0, 8)}${session.powered ? '' : ' · POWER OFF'}`;
}

function sessionForTabStreamKey(key: string): MonitorSession | undefined {
  const at = key.lastIndexOf(':');
  if (at <= 0) return;
  const deskId = key.slice(0, at);
  const index = Number(key.slice(at + 1));
  if (!Number.isInteger(index) || index < 1) return;
  return desks.get(deskId)?.sessions[index - 1];
}

function paintDirtyTabStreams(): void {
  if (!dirtyTabStreams.size) return;
  for (const key of dirtyTabStreams) {
    const stream = tabStreams.get(key);
    if (!stream) continue;
    stream.paint();
    const session = sessionForTabStreamKey(key);
    if (session) session.texture.needsUpdate = true;
  }
  dirtyTabStreams.clear();
}

// One viewer per wall arc. Every display is fed by dedicated /ws/pane,
// /ws/pixels and /ws/tab leases — /ws/wall is topology only. All sections on
// all three displays boot disconnected and paint their on-surface source
// picker until the operator assigns a live pane or tab.
type WallViewer = {
  readonly controller: VideoWallController;
  surface?: DisplaySurface;
  mesh?: THREE.Mesh;
};
const wallViewers: WallViewer[] = [1, 2, 3].map(displayIndex => ({ controller: new VideoWallController(displayIndex) }));
function wallViewerForMesh(object: THREE.Object3D): WallViewer | undefined {
  return wallViewers.find(viewer => viewer.mesh === object);
}
streamBroker.onWallMessage(message => ingestWallTopology(message));

function applyStationPlacement(desk: THREE.Object3D, id: string): void {
  const placement = stationPlacements.get(id); if (!placement) return;
  const position = placement.position;
  const sampledNormal = presentationSurface
    ? sampleSurfaceNormalAtStation(presentationSurface, position, roomLayoutCenter)
    : undefined;
  // The screen mesh is the final authority. The center-based direction is only
  // a load-order fallback until the room and its presentation surface exist.
  const operatorDirection = sampledNormal ?? roomLayoutCenter.clone().sub(position).setY(0).normalize();
  desk.rotation.y = yawFromSurfaceNormal(operatorDirection);
  // Asset origins are not guaranteed to sit at the visual center. Place the
  // evaluated mesh bounds at the layout point instead of placing its origin.
  desk.position.x = 0; desk.position.z = 0;
  desk.updateMatrixWorld(true);
  const visualCenter = new THREE.Box3().setFromObject(desk).getCenter(new THREE.Vector3());
  desk.position.x += position.x - visualCenter.x;
  desk.position.z += position.z - visualCenter.z;
  desk.updateMatrixWorld(true);
}

function alignStationsToPresentationSurface(): void {
  if (!presentationSurface) return;
  for (const station of desks.values()) {
    applyStationPlacement(station.object, station.id);
    refreshDeskView(station);
  }
}

function refreshDeskView(station: DeskStation): void {
  station.object.updateMatrixWorld(true);
  const anchor = station.hudAnchor.getWorldPosition(new THREE.Vector3());
  const operatorSide = new THREE.Vector3(0, 0, 1).transformDirection(station.object.matrixWorld).normalize();
  station.viewTarget.copy(anchor).addScaledVector(operatorSide, -.08).add(new THREE.Vector3(0, .12, 0));
  station.viewPosition.copy(anchor).addScaledVector(operatorSide, 1.12).add(new THREE.Vector3(0, .72, 0));
}

/** Set the physical work-surface height in metres and persist it for this desk. */
function setDeskHeight(deskId: string, metres: number): number {
  const desk = desks.get(deskId);
  if (!desk) throw new RangeError(`Unknown desk ${deskId}`);
  const applied = desk.setHeight(metres);
  console.info('desk-height-changed', { deskId, requestedMetres: metres, appliedMetres: applied });
  status.textContent = `${desk.label.toUpperCase()} · HEIGHT ${applied.toFixed(2)} M`;
  return applied;
}

type RoomControlCommand = { t: 'deskHeight'; deskId: string; metres: number };

function applyRoomControlCommand(command: RoomControlCommand): void {
  const apply = () => {
    try { setDeskHeight(command.deskId, command.metres); }
    catch (error) { console.warn('room-control-command-rejected', command, error); }
  };
  if (desks.has(command.deskId)) apply();
  else void opsRoomReady.then(apply);
}

function connectRoomControl(): void {
  // Same-origin ops-room control plane (desk height, etc.). Not a Hyperia
  // stream — StreamBroker must never lease, count, or close this socket.
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws/v1/control`);
  let opened = false;
  socket.addEventListener('open', () => {
    opened = true;
    console.info('room-control-connected');
  });
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    try {
      const command = JSON.parse(event.data) as Partial<RoomControlCommand>;
      if (command.t === 'deskHeight' && typeof command.deskId === 'string' && typeof command.metres === 'number') {
        applyRoomControlCommand(command as RoomControlCommand);
      }
    } catch (error) { console.warn('room-control-message-invalid', error); }
  });
  socket.addEventListener('close', () => {
    window.setTimeout(connectRoomControl, opened ? 1000 : 3000);
  });
}

connectRoomControl();

function selectDesk(id: string): void {
  const desk = desks.get(id);
  if (!desk) return;
  const returnToRoom = deskViewId === id && !focusedScreen;
  selectedDeskId = id;
  desk.selectMonitor(desk.selectedMonitor);
  localStorage.setItem(DESK_STORAGE_KEY, id);
  drawAllDeskHuds();
  // Clicking the desk body is always navigation, including re-selecting the
  // current desk after orbiting away or leaning into a monitor.
  if (returnToRoom) focusRoom();
  else {
    focusDesk(id);
    status.textContent = `${desk.label.toUpperCase()} SELECTED`;
  }
}

function activateDeskWithoutCamera(id: string): DeskStation | undefined {
  const desk = desks.get(id); if (!desk) return;
  selectedDeskId = id;
  desk.selectMonitor(desk.selectedMonitor);
  localStorage.setItem(DESK_STORAGE_KEY, id);
  drawAllDeskHuds();
  return desk;
}

function chooseMonitor(index: number, deskId = selectedDeskId): void {
  const desk = desks.get(deskId); if (!desk) return;
  selectedDeskId = desk.id;
  localStorage.setItem(DESK_STORAGE_KEY, desk.id);
  desk.selectMonitor(index);
  desk.save();
  drawAllDeskHuds();
}

type CameraMove = {
  start: number;
  duration: number;
  fromPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPosition: THREE.Vector3;
  toTarget: THREE.Vector3;
};
let cameraMove: CameraMove | undefined;
let focusedScreen: { deskId: string; monitorIndex: number } | undefined;
let deskViewId: string | undefined;

function beginCameraMove(toPosition: THREE.Vector3, toTarget: THREE.Vector3): void {
  clearWallUnitFocus();
  const positionDistance = camera.position.distanceTo(toPosition);
  const targetDistance = controls.target.distanceTo(toTarget);
  // Scale duration with the actual move: close monitor/desk transitions stay
  // responsive, while a cross-room move gets enough time to feel intentional.
  const duration = THREE.MathUtils.clamp(850 + positionDistance * 70 + targetDistance * 25, 900, 1800);
  cameraMove = {
    start: performance.now(),
    duration,
    fromPosition: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toPosition: toPosition.clone(),
    toTarget: toTarget.clone(),
  };
}

function roomOverviewPose(): { position: THREE.Vector3; target: THREE.Vector3 } {
  const stations = [...desks.values()];
  const focusPoint = new THREE.Vector3();
  if (stations.length) {
    const bounds = new THREE.Box3();
    for (const station of stations) focusPoint.add(bounds.setFromObject(station.object).getCenter(new THREE.Vector3()));
    focusPoint.divideScalar(stations.length);
  } else {
    for (const placement of stationPlacements.values()) focusPoint.add(placement.position);
    if (stationPlacements.size) focusPoint.divideScalar(stationPlacements.size);
  }
  const shellBounds = roomShell ? new THREE.Box3().setFromObject(roomShell) : undefined;
  const shellCenter = shellBounds?.getCenter(new THREE.Vector3()) ?? roomLayoutCenter.clone();
  const shellSize = shellBounds?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(
    panoramicTheaterRoom.stationLayout.kind === 'polar' ? panoramicTheaterRoom.stationLayout.radius * 2 : 1,
    panoramicTheaterRoom.stationLayout.kind === 'polar' ? panoramicTheaterRoom.stationLayout.radius : 1,
    panoramicTheaterRoom.stationLayout.kind === 'polar' ? panoramicTheaterRoom.stationLayout.radius * 2 : 1,
  );
  const innerRadius = Math.min(shellSize.x, shellSize.z) / 2;
  const awayFromStations = shellCenter.clone().sub(focusPoint).setY(0);
  if (awayFromStations.lengthSq() < 1e-6) awayFromStations.set(0, 0, 1);
  const position = shellCenter.clone().addScaledVector(awayFromStations.normalize(), innerRadius * panoramicTheaterRoom.overview.radiusRatio);
  position.y = (shellBounds?.min.y ?? shellCenter.y) + shellSize.y * panoramicTheaterRoom.overview.heightRatio;
  focusPoint.y = Math.max(focusPoint.y, (shellBounds?.min.y ?? 0) + shellSize.y * panoramicTheaterRoom.overview.targetHeightRatio);
  return { position, target: focusPoint };
}

function setOverviewCamera(): void {
  const overview = roomOverviewPose();
  camera.position.copy(overview.position);
  controls.target.copy(overview.target);
  camera.fov = 46; camera.zoom = 1; camera.updateProjectionMatrix(); seatLookTarget(); controls.update();
}

function tagMonitorHierarchy(root: THREE.Object3D, monitorIndex: number): void {
  root.traverse(node => { node.userData.monitorIndex = monitorIndex; });
}

// Monitor ownership is explicit on each assembly hierarchy. A prior proximity
// fallback used a sphere around the registered glass; the right desk's large
// curved monitor made that sphere reach the tabletop and embedded HUD, turning
// ordinary desk/router clicks into monitor-focus clicks.
// How far behind the nearest intersection a monitor may sit and still win the
// click. Generous enough to cover a desk slab or stand edge grazing in front of
// a panel, tight enough that it never steals a click aimed past the monitor.
const MONITOR_PICK_TOLERANCE = 0.25;

function resolveMonitorIndex(object: THREE.Object3D): number | undefined {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (typeof node.userData.monitorIndex === 'number') return node.userData.monitorIndex;
  }
  return undefined;
}


function focusRoom(): void {
  focusedScreen = undefined; deskViewId = undefined;
  controls.minDistance = .65; controls.zoomSpeed = 1;
  camera.fov = 46; camera.updateProjectionMatrix();
  const overview = roomOverviewPose();
  beginCameraMove(overview.position, overview.target);
  status.textContent = 'COMMAND ROOM OVERVIEW';
}

function focusDesk(id: string): void {
  const desk = desks.get(id); if (!desk) return;
  focusedScreen = undefined;
  deskViewId = id;
  controls.minDistance = .65;
  controls.zoomSpeed = 1;
  drawAllDeskHuds();
  camera.fov = 42;
  camera.updateProjectionMatrix();
  beginCameraMove(desk.viewPosition, desk.viewTarget);
}

function deskMonitorFocusPose(screen: THREE.Object3D, desk: DeskStation): {
  center: THREE.Vector3;
  size: THREE.Vector3;
  normal: THREE.Vector3;
  position: THREE.Vector3;
  distance: number;
} {
  const bounds = new THREE.Box3().setFromObject(screen);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const distance = Math.max(size.x, size.y) * .78 + .2;
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(screen.matrixWorld).normalize();
  const seatedDirection = desk.viewPosition.clone().sub(center).normalize();
  if (normal.dot(seatedDirection) < 0) normal.negate();
  const position = center.clone().addScaledVector(normal, distance).add(new THREE.Vector3(0, .02, 0));
  return { center, size, normal, position, distance };
}

/** Focus a physical monitor after a direct click on that monitor. */
function focusDeskMonitor(deskId: string, monitorIndex: number): void {
  const desk = desks.get(deskId);
  const screen = desk?.monitorScreens.get(monitorIndex);
  if (!desk || !screen) return;
  const { center, position } = deskMonitorFocusPose(screen, desk);
  focusedScreen = { deskId, monitorIndex };
  deskViewId = undefined;
  controls.minDistance = .08;
  controls.zoomSpeed = 1.35;
  beginCameraMove(position, center);
  status.textContent = `${desk.label.toUpperCase()} · MONITOR ${monitorIndex} FOCUS`;
}

function toggleScreenFocus(screen: THREE.Object3D, deskId: string, monitorIndex: number): void {
  const desk = desks.get(deskId); if (!desk) return;
  const { center, size, distance, normal } = deskMonitorFocusPose(screen, desk);

  const explicitFocus = focusedScreen?.deskId === deskId && focusedScreen.monitorIndex === monitorIndex;
  // Old camera snapshots stored the pose but not its semantic state. Detect a
  // restored close-up from the actual target/position so its very first click
  // behaves as the expected "back to desk" toggle.
  const cameraOffset = camera.position.clone().sub(center);
  const axialDistance = cameraOffset.dot(normal);
  const lateralDistance = cameraOffset.addScaledVector(normal, -axialDistance).length();
  const panelSize = Math.max(size.x, size.y);
  const restoredFocus = controls.target.distanceTo(center) <= Math.max(.1, panelSize * .22)
    && axialDistance > 0
    && axialDistance <= distance * 1.8
    && lateralDistance <= Math.max(.08, panelSize * .35);
  if (explicitFocus || restoredFocus) {
    focusDesk(deskId);
    status.textContent = `${desk.label.toUpperCase()} · DESK VIEW`;
    return;
  }

  focusDeskMonitor(deskId, monitorIndex);
}

function drawDeskHud(id: string): void {
  const desk = desks.get(id); if (!desk) return;
  const ctx = desk.hudCanvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#031c26'); gradient.addColorStop(1, '#020c12');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1024, 512);
  ctx.strokeStyle = '#40dcff'; ctx.lineWidth = 4; ctx.strokeRect(6, 6, 1012, 500);
  ctx.fillStyle = '#5f98b3'; ctx.font = '28px Cascadia Mono, monospace';
  ctx.fillText('DESK TERMINAL ROUTER', 34, 48);
  ctx.fillStyle = '#8eeaff'; ctx.font = 'bold 24px Cascadia Mono, monospace';
  ctx.fillText(desk.label.toUpperCase(), 34, 84);
  const hitRegions: DeskHudHitRegion[] = [];
  // Compact physical monitor selector: numbered miniatures only, aligned at
  // the upper-right. Monitor count comes from this station's configuration.
  const gap = 10;
  const tabWidth = 58;
  const tabHeight = 44;
  const selectorWidth = desk.monitorCount * tabWidth + (desk.monitorCount - 1) * gap;
  const selectorStart = 982 - selectorWidth;
  for (let monitor = 1; monitor <= desk.monitorCount; monitor++) {
      const x = selectorStart + (monitor - 1) * (tabWidth + gap);
      const powered = desk.sessions[monitor - 1]?.powered ?? false;
      const holdProgress = monitorHold?.deskId === desk.id && monitorHold.index === monitor ? Math.min(1, (performance.now() - monitorHold.start) / 650) : 0;
      ctx.fillStyle = !powered ? '#3a080d' : holdProgress > 0 ? `rgb(${Math.round(11 + 105 * holdProgress)} ${Math.round(66 * (1 - holdProgress))} ${Math.round(83 * (1 - holdProgress))})` : desk.selectedMonitor === monitor ? '#0b4253' : '#031119';
      ctx.fillRect(x, 30, tabWidth, tabHeight);
      ctx.strokeStyle = !powered || holdProgress >= 1 ? '#ff3949' : holdProgress > 0 ? `rgb(255 ${Math.round(220 * (1 - holdProgress))} ${Math.round(255 * (1 - holdProgress))})` : desk.selectedMonitor === monitor ? '#42dcff' : '#17475b'; ctx.lineWidth = 3;
      ctx.strokeRect(x, 30, tabWidth, tabHeight);
      ctx.fillStyle = !powered ? '#ff7580' : desk.selectedMonitor === monitor ? '#e6fbff' : '#4e91a9';
      ctx.font = 'bold 24px Cascadia Mono, monospace';
      ctx.textAlign = 'center'; ctx.fillText(String(monitor), x + tabWidth / 2, 60); ctx.textAlign = 'left';
      hitRegions.push({ kind: 'monitor', x0: x, y0: 30, x1: x + tabWidth, y1: 30 + tabHeight, index: monitor });
  }
  // Every desk carries its teardown affordance on its own HUD.
  {
    const removeX = selectorStart - 58;
    ctx.fillStyle = '#2a070c'; ctx.fillRect(removeX, 30, 44, 44);
    ctx.strokeStyle = '#ff5864'; ctx.lineWidth = 3; ctx.strokeRect(removeX, 30, 44, 44);
    ctx.fillStyle = '#ffb3ba'; ctx.font = 'bold 24px Cascadia Mono, monospace'; ctx.textAlign = 'center';
    ctx.fillText('✕', removeX + 22, 60); ctx.textAlign = 'left';
    hitRegions.push({ kind: 'remove', x0: removeX, y0: 30, x1: removeX + 44, y1: 74 });
  }
  const deskTarget = desk.monitorTargets[desk.selectedMonitor - 1];
  const rows: Array<
    | { kind: 'tab'; tab: TabGroup }
    | { kind: 'pane'; pane: PaneInfo }
  > = [];
  for (const tab of discoveredTabs) {
    rows.push({ kind: 'tab', tab });
    if (desk.expandedTabId === tab.tabId) tab.panes.forEach(pane => rows.push({ kind: 'pane', pane }));
  }
  const visibleRows = 7;
  desk.hudScrollMax = Math.max(0, rows.length - visibleRows);
  desk.hudScroll = Math.max(0, Math.min(desk.hudScroll, desk.hudScrollMax));
  let y = 108;
  for (const row of rows.slice(desk.hudScroll, desk.hudScroll + visibleRows)) {
    if (row.kind === 'tab') {
      const tab = row.tab, expanded = desk.expandedTabId === tab.tabId;
      ctx.fillStyle = expanded ? '#0b4253' : '#071720'; ctx.fillRect(34, y, 858, 46);
      ctx.strokeStyle = expanded ? '#42dcff' : '#17475b'; ctx.strokeRect(34, y, 858, 46);
      ctx.fillStyle = '#bcefff'; ctx.font = '21px Cascadia Mono, monospace';
      ctx.fillText(tab.name.slice(0, 30), 50, y + 30);
      // A tab is a grouping item, so it needs its own connect affordance: the
      // row body still expands/collapses, this binds the WHOLE tab to the
      // selected monitor over /ws/tab/{tabId}.
      const bound = desk.monitorTargets[desk.selectedMonitor - 1] === tabBindingId(tab.tabId);
      ctx.fillStyle = bound ? '#0b4253' : '#08202a';
      ctx.fillRect(742, y + 6, 144, 34);
      ctx.strokeStyle = bound ? '#42dcff' : '#2c6d85'; ctx.lineWidth = 2;
      ctx.strokeRect(742, y + 6, 144, 34);
      ctx.fillStyle = bound ? '#e6fbff' : '#8eeaff';
      ctx.font = 'bold 17px Cascadia Mono, monospace'; ctx.textAlign = 'center';
      // This HUD never sets textBaseline, so it stays the canvas default
      // (alphabetic), like every other label here. The box spans y+6..y+40, so
      // the baseline belongs in its lower third — at y+15 the glyphs rendered
      // above the box entirely and hung off the top edge.
      ctx.fillText(bound ? 'CONNECTED' : 'CONNECT TAB', 814, y + 29);
      ctx.textAlign = 'left';
      hitRegions.push({ kind: 'tab', x0: 34, y0: y, x1: 736, y1: y + 46, tabId: tab.tabId });
      hitRegions.push({ kind: 'tab-connect', x0: 742, y0: y + 6, x1: 886, y1: y + 40, tabId: tab.tabId });
    } else {
      const pane = row.pane;
      const active = pane.paneId === deskTarget;
      ctx.fillStyle = active ? '#0b2534' : '#08111a'; ctx.fillRect(58, y, 834, 45);
      ctx.strokeStyle = active ? '#42c8ff' : '#173141'; ctx.strokeRect(58, y, 834, 45);
      ctx.fillStyle = active ? '#e6f8ff' : '#8ebbd0'; ctx.font = '19px Cascadia Mono, monospace';
      const kind = pane.shell === 'web' ? 'WEB' : 'PTY';
      ctx.fillText(`${kind}  ${(paneCreatureName(pane) || pane.paneId.slice(0, 8)).slice(0, 30)}`, 74, y + 29);
      hitRegions.push({ kind: 'pane', x0: 58, y0: y, x1: 892, y1: y + 45, paneId: pane.paneId });
    }
    y += 52;
  }
  // Large physical scroll buttons and a simple proportional scrollbar.
  ctx.fillStyle = '#0b3342'; ctx.fillRect(910, 108, 72, 54); ctx.fillRect(910, 428, 72, 54);
  ctx.strokeStyle = '#42c8ff'; ctx.strokeRect(910, 108, 72, 54); ctx.strokeRect(910, 428, 72, 54);
  ctx.fillStyle = '#d7f8ff'; ctx.font = 'bold 30px Cascadia Mono, monospace'; ctx.textAlign = 'center';
  ctx.fillText('▲', 946, 145); ctx.fillText('▼', 946, 466); ctx.textAlign = 'left';
  hitRegions.push({ kind: 'scroll-up', x0: 910, y0: 108, x1: 982, y1: 162 });
  hitRegions.push({ kind: 'scroll-down', x0: 910, y0: 428, x1: 982, y1: 482 });
  const trackY = 174, trackH = 242;
  ctx.fillStyle = '#06141c'; ctx.fillRect(934, trackY, 24, trackH);
  const thumbH = Math.max(34, trackH * Math.min(1, visibleRows / Math.max(visibleRows, rows.length)));
  const thumbY = trackY + (trackH - thumbH) * (desk.hudScrollMax ? desk.hudScroll / desk.hudScrollMax : 0);
  ctx.fillStyle = '#2c9fbd'; ctx.fillRect(934, thumbY, 24, thumbH);
  desk.hudPanel.userData.hitRegions = hitRegions;
  (desk.hudPanel.userData.hudTexture as THREE.CanvasTexture).needsUpdate = true;
}
function drawAllDeskHuds(): void { desks.forEach((_, id) => drawDeskHud(id)); }


const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
// Do not enable shadows until the room supplies an authored, room-scale shadow
// rig. Three's default directional shadow frustum creates a hard square across
// the center floor in this 40m theater.
renderer.shadowMap.enabled = false;
app.prepend(renderer.domElement);
diagnostics.webgl = !renderer.getContext().isContextLost();
diagnostics.gpu = renderer.getContext().getParameter(renderer.getContext().RENDERER) || 'WebGL';

async function refreshDiagnostics(): Promise<void> {
  try {
    const [appResponse, hyperiaResponse] = await Promise.all([fetch('/api/version', { cache: 'no-store' }), fetch('/hyperia-api/status', { cache: 'no-store' })]);
    if (appResponse.ok) diagnostics.appVersion = String((await appResponse.json() as { version: string }).version);
    if (hyperiaResponse.ok) {
      const info = await hyperiaResponse.json() as { version?: string };
      diagnostics.hyperiaOnline = true; diagnostics.hyperiaVersion = info.version ?? 'connected';
    } else diagnostics.hyperiaOnline = false;
  } catch { diagnostics.hyperiaOnline = false; }
}
void refreshDiagnostics(); setInterval(refreshDiagnostics, 3000);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05080d);
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 1200);
camera.position.set(1.35, 1.15, 2.35);
camera.lookAt(0, 0.78, 0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 0.1;
controls.maxDistance = 55;
controls.minPolarAngle = Math.PI * 0.08;
controls.maxPolarAngle = Math.PI * 0.92;
// Dragging looks around from where you stand — nothing orbits. OrbitControls
// still supplies damping and right-drag pan, but its pivot is pinned just
// ahead of the camera so rotation reads as turning your head, and the wheel
// walks the view forward instead of dollying onto a pivot.
const LOOK_TARGET_DISTANCE = 0.6;
controls.rotateSpeed = -0.45;
controls.enableZoom = false;
function seatLookTarget(): void {
  const forward = controls.target.clone().sub(camera.position);
  if (forward.lengthSq() < 1e-8) camera.getWorldDirection(forward);
  else forward.normalize();
  controls.target.copy(camera.position).addScaledVector(forward, LOOK_TARGET_DISTANCE);
}
controls.target.set(0, 0.78, 0);
seatLookTarget();
controls.update();

const deskRaycaster = new THREE.Raycaster();
const deskPointer = new THREE.Vector2();
const pointerDown = new THREE.Vector2();
let pointerDownAt = 0;
/** Authored floor/dais tiles. The wall arc is DoubleSide and wraps the room, so a
 *  ray aimed at the floor would otherwise punch through and hit the far glass. */
let floorPickables: THREE.Object3D[] = [];

function nearestFloorHit(): THREE.Intersection | undefined {
  if (!floorPickables.length) return;
  return deskRaycaster.intersectObjects(floorPickables, false)[0];
}

function floorOccludes(distance: number): boolean {
  const hit = nearestFloorHit();
  return !!hit && hit.distance <= distance + 0.04;
}
renderer.domElement.addEventListener('pointerdown', event => {
  pointerDown.set(event.clientX, event.clientY); pointerDownAt = performance.now();
  deskPointer.set(event.clientX / innerWidth * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  deskRaycaster.setFromCamera(deskPointer, camera);
  const hit = deskRaycaster.intersectObjects([...desks.values()].map(desk => desk.hudPanel), false)[0];
  if (!hit?.uv) return;
  const desk = desks.get(hit.object.userData.deskId); if (!desk) return;
  const px = hit.uv.x * 1024, py = (1 - hit.uv.y) * 512;
  const region = (desk.hudPanel.userData.hitRegions as DeskHudHitRegion[]).find(r => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
  if (region?.kind === 'monitor' && region.index && desk.sessions[region.index - 1]?.powered) monitorHold = { deskId: desk.id, index: region.index, start: pointerDownAt, triggered: false };
});
renderer.domElement.addEventListener('pointerup', event => {
  const completedHold = monitorHold?.triggered ?? false;
  monitorHold = undefined;
  if (pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) return;
  deskPointer.set(event.clientX / innerWidth * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  deskRaycaster.setFromCamera(deskPointer, camera);
  // Resolve station geometry first. The presentation wall wraps behind the
  // room and must never win a ray that also touches a desk, HUD, or monitor.
  const hits = deskRaycaster.intersectObjects([...desks.values()].map(desk => desk.object), true);
  // Aiming at a monitor must win over whatever happens to be a millimetre
  // nearer along the same ray. Desk 3's displays are separate assets resting on
  // the desktop, so at shallow angles the desk slab, a grommet or a stand edge
  // can beat the panel by a hair - and losing that race fell through to
  // selectDesk, which zooms to the desk or all the way back out to the room.
  const nearest = hits[0];
  const preferred = hits.find(candidate =>
    typeof resolveMonitorIndex(candidate.object) === 'number'
    && candidate.distance - (nearest?.distance ?? 0) <= MONITOR_PICK_TOLERANCE);
  const hit = preferred ?? nearest;
  if (!hit && wallPointerTargets.length) {
    const wallHit = deskRaycaster.intersectObjects(wallPointerTargets, false)[0];
    if (!wallHit || floorOccludes(wallHit.distance)) return;
    // Bezel (frame / light rail) clicks rotate to face that screen's unit;
    // glass clicks route through the display's canvas regions.
    if (wallHit.object.userData.wallBezel === true) {
      cancelPendingWallClick();
      const index = Number(wallHit.object.userData.screen_index
        ?? (wallHit.object.name.match(/^Wall_Screen_([1-3])/) ?? [])[1]);
      const viewer = wallViewers.find(v => v.controller.displayIndex === index) ?? wallViewers[1];
      toggleWallScreenFocus(viewer);
      return;
    }
    const viewer = wallViewerForMesh(wallHit.object);
    if (viewer) routeWallPointer(viewer, wallHit);
    return;
  }
  if (!hit) return;
  cancelPendingWallClick();
  const deskId = hit?.object.userData.deskId;
  if (typeof deskId !== 'string') return;
  const desk = desks.get(deskId);
  const hitMonitorIndex = resolveMonitorIndex(hit.object);
  if (typeof hitMonitorIndex === 'number') {
    // Frame the registered screen, never the mesh the ray happened to win. The
    // bezel and housing sit within a hundredth of a metre of the screen face,
    // so the winner is effectively arbitrary and could otherwise frame a stand.
    const screen = desk?.monitorScreens.get(hitMonitorIndex) ?? hit.object;
    // An idle powered bay paints its source picker directly on the glass;
    // a click that lands on one of its rows routes content, never the camera.
    if (desk && hit.object === desk.monitorScreens.get(hitMonitorIndex) && hit.uv
      && dispatchMonitorPickerClick(desk, hitMonitorIndex, hit.uv)) return;
    // Preserve focusedScreen until toggleScreenFocus has decided whether this
    // click is a lean-in or a return to the seated desk/head position.
    activateDeskWithoutCamera(deskId);
    chooseMonitor(hitMonitorIndex, deskId);
    toggleScreenFocus(screen, deskId, hitMonitorIndex);
  } else if (hit.object.userData.hudToggle) {
    const desk = desks.get(deskId)!;
    if (!hit.uv) return;
    const px = hit.uv.x * 1024, py = (1 - hit.uv.y) * 512;
    const region = (desk.hudPanel.userData.hitRegions as DeskHudHitRegion[]).find(r => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
    if (region?.kind === 'monitor' && region.index) {
      const session = desk.sessions[region.index - 1];
      if (completedHold) { drawDeskHud(desk.id); }
      else if (performance.now() - pointerDownAt >= 650) setMonitorPower(desk, region.index, false);
      else if (!session?.powered) setMonitorPower(desk, region.index, true);
      else chooseMonitor(region.index, desk.id);
    }
    if (region?.kind === 'tab' && region.tabId) {
      desk.expandedTabId = region.tabId;
      desk.save();
      connectTabToMonitor(desk, desk.selectedMonitor, region.tabId);
    }
    if (region?.kind === 'tab-connect' && region.tabId) connectTabToMonitor(desk, desk.selectedMonitor, region.tabId);
    if (region?.kind === 'pane' && region.paneId) {
      // Desk routing is desk-local. The presentation wall has its own direct
      // /ws/wall feed and is never replaced by a HUD selection.
      connectPaneToMonitor(desk, desk.selectedMonitor, region.paneId);
    }
    if (region?.kind === 'scroll-up') scrollDeskHud(desk, -1);
    if (region?.kind === 'scroll-down') scrollDeskHud(desk, 1);
    if (region?.kind === 'remove') removeDesk(desk.id);
  }
  else selectDesk(deskId);
});
renderer.domElement.addEventListener('pointercancel', () => { monitorHold = undefined; cancelPendingWallClick(); drawAllDeskHuds(); });
renderer.domElement.addEventListener('dblclick', event => {
  if (!wallScreenMeshes.length) return;
  deskPointer.set(event.clientX / innerWidth * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  deskRaycaster.setFromCamera(deskPointer, camera);
  const wallHit = deskRaycaster.intersectObjects(wallScreenMeshes, false)[0];
  const viewer = wallHit ? wallViewerForMesh(wallHit.object) : undefined;
  if (!wallHit?.uv || !viewer?.surface) return;
  if (floorOccludes(wallHit.distance)) return;
  const deskHit = deskRaycaster.intersectObjects([...desks.values()].map(desk => desk.object), true)[0];
  if (deskHit && deskHit.distance <= wallHit.distance + MONITOR_PICK_TOLERANCE) return;
  const px = wallHit.uv.x * viewer.surface.canvas.width;
  const py = (1 - wallHit.uv.y) * viewer.surface.canvas.height;
  const sectionIndex = viewer.controller.sectionIndexAt(px, py);
  if (sectionIndex === undefined) return;
  event.preventDefault();
  cancelPendingWallClick();
  viewer.controller.openSectionRouter(sectionIndex);
  wallZoom = undefined;
  viewer.controller.setFocusedPane(undefined);
  const focusRegion = wallSectionFocusRegion(viewer, sectionIndex);
  if (focusRegion) focusWallRegion(viewer, focusRegion);
  console.info('main-screen-source-picker-opened', { displayIndex: viewer.controller.displayIndex, sectionIndex: sectionIndex + 1, input: 'dblclick' });
  status.textContent = `DISPLAY ${viewer.controller.displayIndex} · SECTION ${sectionIndex + 1} SOURCE PICKER`;
});

function scrollDeskHud(desk: DeskStation, amount: number): void {
  desk.hudScroll = Math.max(0, Math.min(desk.hudScrollMax, desk.hudScroll + amount));
  desk.save();
  drawDeskHud(desk.id);
}

function deskPanelUnderPointer(event: WheelEvent): DeskStation | undefined {
  deskPointer.set(event.clientX / innerWidth * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  deskRaycaster.setFromCamera(deskPointer, camera);
  const hit = deskRaycaster.intersectObjects([...desks.values()].map(desk => desk.hudPanel), false)[0];
  return hit ? desks.get(hit.object.userData.deskId) : undefined;
}

renderer.domElement.addEventListener('wheel', event => {
  event.preventDefault();
  // OrbitControls owns a bubble-phase wheel listener on this same canvas.
  // Handle router input in capture phase and stop it here, otherwise the pane
  // list scroll and the camera move happen from the same wheel gesture.
  event.stopImmediatePropagation();
  const desk = deskPanelUnderPointer(event);
  if (desk) { scrollDeskHud(desk, event.deltaY > 0 ? 1 : -1); return; }
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  camera.position.addScaledVector(forward, -Math.sign(event.deltaY) * 0.9);
  camera.position.y = Math.max(camera.position.y, 0.25);
  seatLookTarget();
  saveCamera();
}, { passive: false, capture: true });

// WASD walks the camera in the ground plane; the look direction steers.
const WALK_SPEED = 3.5;
const walkKeys: Record<string, boolean> = { w: false, a: false, s: false, d: false };
addEventListener('keydown', event => {
  const key = event.key.toLowerCase();
  if (!(key in walkKeys) || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  walkKeys[key] = true;
});
addEventListener('keyup', event => {
  const key = event.key.toLowerCase();
  if (!(key in walkKeys)) return;
  walkKeys[key] = false;
  if (!walkKeys.w && !walkKeys.a && !walkKeys.s && !walkKeys.d) saveCamera();
});
let lastWalkTick = performance.now();

function applyWalk(now: number): void {
  const dt = Math.min(0.05, (now - lastWalkTick) / 1000);
  lastWalkTick = now;
  if (cameraMove) return;
  const surge = (walkKeys.w ? 1 : 0) - (walkKeys.s ? 1 : 0);
  const strafe = (walkKeys.d ? 1 : 0) - (walkKeys.a ? 1 : 0);
  if (!surge && !strafe) return;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) return;
  forward.normalize();
  const step = new THREE.Vector3()
    .addScaledVector(forward, surge)
    .addScaledVector(new THREE.Vector3(-forward.z, 0, forward.x), strafe)
    .normalize()
    .multiplyScalar(WALK_SPEED * dt);
  camera.position.add(step);
  controls.target.add(step);
}

addEventListener('keydown', event => {
  const desk = desks.get(selectedDeskId);
  if (!desk || !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)) return;
  event.preventDefault();
  const amount = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : event.key === 'PageUp' ? -6 : 6;
  scrollDeskHud(desk, amount);
});

const CAMERA_STORAGE_KEY = `ops-room/${panoramicTheaterRoom.id}/camera-v3`;
type CameraSnapshot = {
  position: number[];
  target: number[];
  zoom: number;
  focusedScreen?: { deskId: string; monitorIndex: number };
  deskViewId?: string;
};
function saveCamera(): void {
  localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    zoom: camera.zoom,
    focusedScreen,
    deskViewId,
  } satisfies CameraSnapshot));
}
function restoreCamera(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(CAMERA_STORAGE_KEY) ?? 'null') as CameraSnapshot | null;
    if (!saved || saved.position.length !== 3 || saved.target.length !== 3) return false;
    focusedScreen = saved.focusedScreen && typeof saved.focusedScreen.deskId === 'string' && Number.isInteger(saved.focusedScreen.monitorIndex)
      ? saved.focusedScreen
      : undefined;
    deskViewId = typeof saved.deskViewId === 'string' ? saved.deskViewId : undefined;
    camera.position.fromArray(saved.position); controls.target.fromArray(saved.target); camera.zoom = saved.zoom || 1;
    seatLookTarget();
    camera.updateProjectionMatrix(); controls.update(); return true;
  } catch { return false; }
}
controls.addEventListener('end', saveCamera);

scene.background = new THREE.Color(0x000000);
scene.add(new THREE.HemisphereLight(0x91bce8, 0x050608, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 3.2);
key.position.set(2.5, 4, 3); key.castShadow = false; scene.add(key);

const celestialSky = new CelestialSky();
scene.add(celestialSky.group);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ color: 0x090d13, roughness: 0.55, metalness: 0.25 }),
);
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

function resetRoom(): void {
  monitorHold = undefined; focusedScreen = undefined; deskViewId = undefined; wallZoom = undefined;
  clearWallUnitFocus();
  for (const viewer of wallViewers) viewer.controller.setFocusedPane(undefined);
  desks.forEach(desk => desk.reset());
  selectedDeskId = 'operator-desk-1'; localStorage.setItem(DESK_STORAGE_KEY, selectedDeskId);
  localStorage.removeItem(CAMERA_STORAGE_KEY);
  setOverviewCamera(); saveCamera();
  status.textContent = 'ROOM RESET · ALL DISPLAYS POWERED OFF';
}

// Wall arcs and desk monitors share DisplaySurface geometry, but never content
// state. Populated once the room shell resolves; bezels (frames + light rails)
// are pointer targets for the whole-wall framing toggle.
const wallScreenMeshes: THREE.Mesh[] = [];
const wallBezelMeshes: THREE.Mesh[] = [];
let wallPointerTargets: THREE.Object3D[] = [];

const WALL_FOCUS_FOV_DEG = 52;

// Snapshot of the operator's camera before a bezel focus move, so clicking
// the same bezel again restores exactly where they were. Clicking a
// different bezel swings to that screen while keeping the original return
// point. Any other camera move abandons the focus and returns the orbit
// limits it borrowed.
let wallUnitReturn: {
  displayIndex: number;
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  minDistance: number;
  maxDistance: number;
  zoomSpeed: number;
} | undefined;

function clearWallUnitFocus(): void {
  if (!wallUnitReturn) return;
  controls.maxDistance = wallUnitReturn.maxDistance;
  wallUnitReturn = undefined;
}

/**
 * The arc is concentric with the room axis, so its own centre of curvature
 * is the one spot inside the room that sees the whole span without
 * foreshortening. Sit just short of it rather than flat against the glass —
 * the camera never leaves the room.
 */
function wallScreenFocusPose(viewer: WallViewer): { position: THREE.Vector3; target: THREE.Vector3 } | undefined {
  if (!viewer.mesh) return;
  const bounds = new THREE.Box3().setFromObject(viewer.mesh);
  const target = bounds.getCenter(new THREE.Vector3());
  const outward = new THREE.Vector3(target.x, 0, target.z);
  const radius = outward.length() || 1;
  outward.divideScalar(radius);
  const position = outward.multiplyScalar(radius * .12).setY(target.y);
  return { position, target };
}

/**
 * Bezel click: rotate to face that screen's whole unit from inside the room.
 * Same bezel again restores the pre-focus camera; a different bezel swings
 * to it while keeping the original return point.
 */
function toggleWallScreenFocus(viewer: WallViewer): void {
  if (wallUnitReturn && wallUnitReturn.displayIndex === viewer.controller.displayIndex) {
    const previous = wallUnitReturn;
    wallUnitReturn = undefined;
    camera.fov = previous.fov; camera.updateProjectionMatrix();
    controls.minDistance = previous.minDistance;
    controls.maxDistance = previous.maxDistance;
    controls.zoomSpeed = previous.zoomSpeed;
    beginCameraMove(previous.position, previous.target);
    status.textContent = 'WALL FOCUS RELEASED';
    return;
  }
  const pose = wallScreenFocusPose(viewer);
  if (!pose) return;
  const snapshot = wallUnitReturn ?? {
    displayIndex: viewer.controller.displayIndex,
    position: camera.position.clone(),
    target: controls.target.clone(),
    fov: camera.fov,
    minDistance: controls.minDistance,
    maxDistance: controls.maxDistance,
    zoomSpeed: controls.zoomSpeed,
  };
  focusedScreen = undefined; deskViewId = undefined; wallZoom = undefined;
  for (const other of wallViewers) other.controller.setFocusedPane(undefined);
  camera.fov = WALL_FOCUS_FOV_DEG; camera.updateProjectionMatrix();
  controls.minDistance = .4;
  controls.zoomSpeed = 1.1;
  // OrbitControls clamps radius every update; keep the borrowed limit wide
  // enough that the tween cannot be dragged back inside it.
  controls.maxDistance = Math.max(snapshot.maxDistance, pose.position.distanceTo(pose.target) * 1.1);
  beginCameraMove(pose.position, pose.target);
  wallUnitReturn = { ...snapshot, displayIndex: viewer.controller.displayIndex };
  status.textContent = viewer.controller.displayIndex === 2 ? 'MAIN SCREEN FOCUS' : `ROOM DISPLAY ${viewer.controller.displayIndex} FOCUS`;
}

function focusWallScreen(viewer: WallViewer): void {
  const pose = wallScreenFocusPose(viewer);
  if (!pose) return;
  focusedScreen = undefined; deskViewId = undefined;
  wallZoom = undefined;
  viewer.controller.setFocusedPane(undefined);
  controls.minDistance = .4; controls.zoomSpeed = 1.1;
  camera.fov = WALL_FOCUS_FOV_DEG; camera.updateProjectionMatrix();
  beginCameraMove(pose.position, pose.target);
  status.textContent = viewer.controller.displayIndex === 2 ? 'MAIN SCREEN' : `ROOM DISPLAY ${viewer.controller.displayIndex}`;
}

// Selecting any content section moves the operator camera to that physical
// portion of the arc; selecting it again returns to the complete display.
let wallZoom: { displayIndex: number; contentId: string } | undefined;

/** The camera framing only needs a titled canvas rect, not a full region. */
type WallFocusRect = { title: string; x0: number; y0: number; x1: number; y1: number };

function pointOnWallRegion(viewer: WallViewer, region: WallFocusRect): THREE.Vector3 | undefined {
  if (!viewer.mesh || !viewer.surface) return;
  const mesh = viewer.mesh;
  const position = mesh.geometry.getAttribute('position');
  if (!position?.count) return;

  let sumX = 0, sumZ = 0, radius = 0, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    sumX += x; sumZ += z; radius += Math.hypot(x, z);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const middle = Math.atan2(sumZ, sumX);
  let minOffset = Infinity, maxOffset = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const delta = Math.atan2(position.getZ(i), position.getX(i)) - middle;
    const offset = Math.atan2(Math.sin(delta), Math.cos(delta));
    minOffset = Math.min(minOffset, offset); maxOffset = Math.max(maxOffset, offset);
  }

  const u = ((region.x0 + region.x1) / 2) / viewer.surface.canvas.width;
  const v = 1 - ((region.y0 + region.y1) / 2) / viewer.surface.canvas.height;
  const angle = middle + minOffset + (maxOffset - minOffset) * u;
  const localRadius = radius / position.count;
  const local = new THREE.Vector3(
    Math.cos(angle) * localRadius,
    minY + (maxY - minY) * v,
    Math.sin(angle) * localRadius,
  );
  return mesh.localToWorld(local);
}

function focusWallRegion(viewer: WallViewer, region: WallFocusRect): void {
  const surface = viewer.surface;
  if (!surface || !viewer.mesh) return;
  const target = pointOnWallRegion(viewer, region);
  if (!target) return;
  const bounds = new THREE.Box3().setFromObject(viewer.mesh);
  const wallHeight = bounds.getSize(new THREE.Vector3()).y;
  const regionHeight = wallHeight * (region.y1 - region.y0) / surface.canvas.height;
  const regionWidth = wallHeight * surface.panelAspect * (region.x1 - region.x0) / surface.canvas.width;
  const verticalFov = THREE.MathUtils.degToRad(42);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const standoff = Math.max(
    .8,
    regionHeight / (2 * Math.tan(verticalFov / 2)),
    regionWidth / (2 * Math.tan(horizontalFov / 2)),
  ) * 1.18;
  const inward = new THREE.Vector3(roomLayoutCenter.x - target.x, 0, roomLayoutCenter.z - target.z).normalize();
  controls.minDistance = .25; controls.zoomSpeed = 1.25;
  camera.fov = 42; camera.updateProjectionMatrix();
  beginCameraMove(target.clone().addScaledVector(inward, standoff), target);
  status.textContent = `${region.title.toUpperCase()} · WALL DETAIL`;
}

function wallSectionFocusRegion(viewer: WallViewer, sectionIndex: number): WallFocusRect | undefined {
  if (!viewer.surface || sectionIndex < 0 || sectionIndex > 3) return;
  const { canvas } = viewer.surface;
  const sectionWidth = canvas.width / 4;
  return {
    title: `Display ${viewer.controller.displayIndex} Section ${sectionIndex + 1}`,
    x0: sectionIndex * sectionWidth,
    y0: 0,
    x1: (sectionIndex + 1) * sectionWidth,
    y1: canvas.height,
  };
}

function isWallRouterRegion(region: VideoWallRegion | undefined): region is VideoWallRouterRegion {
  return !!region && (
    region.kind === 'router-tab'
    || region.kind === 'router-tab-expand'
    || region.kind === 'router-pane'
    || region.kind === 'router-scroll-up'
    || region.kind === 'router-scroll-down'
    || region.kind === 'router-close'
    || region.kind === 'router-add-desk'
  );
}

function handleWallClick(viewer: WallViewer, hit: THREE.Intersection): void {
  const surface = viewer.surface;
  if (!surface || !hit.uv) return;
  const px = hit.uv.x * surface.canvas.width;
  const py = (1 - hit.uv.y) * surface.canvas.height;
  const region = viewer.controller.hitTest(px, py);
  if (region?.kind === 'router-add-desk' && region.deskVariant) {
    void spawnDeskForDisplay(viewer.controller.displayIndex, region.deskVariant);
    return;
  }
  if (isWallRouterRegion(region)) {
    viewer.controller.activateRouterRegion(region);
    status.textContent = `DISPLAY ${viewer.controller.displayIndex} · SECTION ${region.sectionIndex + 1}`;
    return;
  }
  if (region?.kind === 'reset') {
    resetRoom();
    return;
  }
  if (!region || (region.kind !== 'pane' && region.kind !== 'tab')) {
    focusWallScreen(viewer);
    return;
  }
  const contentId = region.kind === 'pane' ? `pane:${region.paneId}` : `tab:${region.tabId}`;
  if (wallZoom?.displayIndex === viewer.controller.displayIndex && wallZoom.contentId === contentId) {
    focusWallScreen(viewer);
    return;
  }
  wallZoom = { displayIndex: viewer.controller.displayIndex, contentId };
  viewer.controller.setFocusedPane(region.kind === 'pane' ? region.paneId : undefined);
  focusWallRegion(viewer, region);
}

const WALL_DOUBLE_CLICK_MS = 420;
let pendingWallClick: { viewer: WallViewer; hit: THREE.Intersection; sectionIndex: number; at: number; timer: number } | undefined;

function cancelPendingWallClick(): void {
  if (!pendingWallClick) return;
  clearTimeout(pendingWallClick.timer);
  pendingWallClick = undefined;
}

function routeWallPointer(viewer: WallViewer, hit: THREE.Intersection): void {
  const surface = viewer.surface;
  if (!surface || !hit.uv) return;
  const px = hit.uv.x * surface.canvas.width;
  const py = (1 - hit.uv.y) * surface.canvas.height;
  const region = viewer.controller.hitTest(px, py);
  // Picker controls — permanent on disconnected sections, reopened on
  // assigned ones — behave like desk-HUD controls: one click dispatches
  // immediately and never moves the camera.
  if (isWallRouterRegion(region) || region?.kind === 'reset') {
    cancelPendingWallClick();
    handleWallClick(viewer, hit);
    return;
  }
  const sectionIndex = viewer.controller.sectionIndexAt(px, py);
  if (sectionIndex === undefined) return;
  const now = performance.now();
  if (pendingWallClick && pendingWallClick.viewer === viewer && pendingWallClick.sectionIndex === sectionIndex && now - pendingWallClick.at <= WALL_DOUBLE_CLICK_MS) {
    cancelPendingWallClick();
    viewer.controller.openSectionRouter(sectionIndex);
    wallZoom = undefined;
    viewer.controller.setFocusedPane(undefined);
    const focusRegion = wallSectionFocusRegion(viewer, sectionIndex);
    if (focusRegion) focusWallRegion(viewer, focusRegion);
    console.info('main-screen-source-picker-opened', { displayIndex: viewer.controller.displayIndex, sectionIndex: sectionIndex + 1, input: 'pointer-pair' });
    status.textContent = `DISPLAY ${viewer.controller.displayIndex} · SECTION ${sectionIndex + 1} SOURCE PICKER`;
    return;
  }
  if (pendingWallClick) {
    const previous = pendingWallClick;
    cancelPendingWallClick();
    handleWallClick(previous.viewer, previous.hit);
  }
  const timer = window.setTimeout(() => {
    const queued = pendingWallClick;
    pendingWallClick = undefined;
    if (queued) handleWallClick(queued.viewer, queued.hit);
  }, WALL_DOUBLE_CLICK_MS);
  pendingWallClick = { viewer, hit, sectionIndex, at: now, timer };
}

// Full command-room shell and its architectural lighting initialized via RoomLoader.
const roomLoader = new RoomLoader();
roomLoader.loadRoom({
  schema: 'ops-room/room@1',
  id: panoramicTheaterRoom.id,
  label: 'Panoramic Command Theater',
  shell: panoramicTheaterRoom.shell,
  presentationScreen: panoramicTheaterRoom.presentationScreen,
  stations: [],
}).then(({ shellObject: room }) => {
  roomShell = room;
  maybeResolveOpsRoomReady();
  room.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.receiveShadow = true;
    node.castShadow = !/Room_(Floor|Ceiling)|Wall|Ceiling_Light|Wall_LED/.test(node.name);
    const role = node.userData.semantic_role as string | undefined;
    if (role === 'screen.frame' || /^Wall_Screen_[1-3]_Frame$/.test(node.name)) {
      const style = panoramicTheaterRoom.screenFrameStyle;
      node.material = new THREE.MeshStandardMaterial({
        color: style.color,
        emissive: style.emissive,
        emissiveIntensity: style.emissiveIntensity,
        roughness: style.roughness,
        metalness: style.metalness,
        toneMapped: false,
      });
      node.userData.wallBezel = true;
      wallBezelMeshes.push(node);
    }
    if (role === 'screen.lightRail') {
      node.material = new THREE.MeshStandardMaterial({
        color: 0xf7fbff,
        emissive: 0xffffff,
        emissiveIntensity: 1.15,
        roughness: .2,
        metalness: 0,
        toneMapped: false,
      });
      node.userData.wallBezel = true;
      wallBezelMeshes.push(node);
    }
  });

  // All three arcs are live displays: real UVs, a canvas-backed surface, and
  // a per-display controller with four disconnected sections.
  ['Wall_Screen_1', 'Wall_Screen_2', 'Wall_Screen_3'].forEach((name, index) => {
    const wallScreen = room.getObjectByName(name);
    if (!(wallScreen instanceof THREE.Mesh)) return;
    const viewer = wallViewers[index];
    viewer.mesh = wallScreen;
    viewer.surface = createDisplaySurface(wallScreen, {
      id: name,
      mapping: 'cylindrical',
      canvasHeight: 900,
      source: { kind: 'wall-status' },
    });
    viewer.controller.attachSurface(viewer.surface);
    wallScreenMeshes.push(wallScreen);
    if (name === panoramicTheaterRoom.presentationScreen) presentationSurface = wallScreen;
  });
  wallPointerTargets = [...wallScreenMeshes, ...wallBezelMeshes];
  recutFloorGrid(room, { sectors: panoramicTheaterRoom.floor.sectors });
  floorPickables = [];
  room.traverse(node => {
    if (!(node instanceof THREE.Mesh) || !node.visible) return;
    const role = node.userData.semantic_role as string | undefined;
    if (role === 'floor.tile' || role === 'floor' || role === 'dais' || /^(Floor|Dais)/i.test(node.name)) {
      floorPickables.push(node);
    }
  });
  const removedNodes = removeRoomWallsAndCeiling(room);
  status.textContent = `FLOOR 36 LINES · AUTHORED DAIS CLEAR · WALLS & CEILING REMOVED (${removedNodes.length} NODES)`;
  floor.visible = false;
  scene.add(room);
  room.updateWorldMatrix(true, true);
  alignStationsToPresentationSurface();
  // Materialize operator-spawned desks now that the wall meshes exist to give
  // each one its facing angle.
  for (const record of spawnedDesks) void materializeSpawnedDesk(record);
  if (!restoreCamera()) { setOverviewCamera(); saveCamera(); }

  // The MASTER RESET placard used to float in front of the presentation wall.
  // It competed with the main screen for the room's focal point, so the plate
  // is gone; the capability survives as opsDebug.resetRoom() until it earns a
  // home on a physical desk surface.

  status.textContent = 'PANORAMIC COMMAND THEATER ONLINE';
});

const terminalCanvas = document.createElement('canvas');
terminalCanvas.width = 1440; terminalCanvas.height = 900;
const texture = new THREE.CanvasTexture(terminalCanvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.generateMipmaps = false;
texture.center.set(0.5, 0.5);
texture.rotation = Math.PI;
texture.wrapS = THREE.RepeatWrapping;
texture.repeat.x = -1;

const secondCanvas = document.createElement('canvas');
secondCanvas.width = 1440; secondCanvas.height = 900;
const secondTexture = new THREE.CanvasTexture(secondCanvas);
secondTexture.colorSpace = THREE.SRGBColorSpace;
secondTexture.minFilter = THREE.LinearFilter;
secondTexture.magFilter = THREE.LinearFilter;
secondTexture.generateMipmaps = false;
secondTexture.center.set(.5, .5);
secondTexture.rotation = Math.PI;
secondTexture.wrapS = THREE.RepeatWrapping;
secondTexture.repeat.x = -1;
let activeCanvas = terminalCanvas;
let activeTexture = texture;

let cols = 120;
let rows = 40;
let ptyTerminal = new Terminal({ cols, rows, scrollback: 2000, convertEol: false, allowProposedApi: true });


function renderPoweredOff(session: MonitorSession): void {
  session.source = { kind: 'off' };
  const ctx = session.canvas.getContext('2d')!;
  const { width, height } = session.canvas;
  ctx.fillStyle = '#160204'; ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, Math.max(width, height) * .55);
  glow.addColorStop(0, '#78131c'); glow.addColorStop(1, '#090103');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ff3b49'; ctx.font = `bold ${Math.round(height * .047)}px Cascadia Mono, monospace`; ctx.textAlign = 'center';
  ctx.fillText('POWER OFF', width / 2, height * .52); ctx.textAlign = 'left';
  session.texture.needsUpdate = true;
}

function initializeStationSessions(station: DeskStation): void {
  station.sessions.forEach((session, i) => {
    session.powered = station.restoredPower[i];
    if (session.powered) renderMonitorPicker(session, station, i + 1);
    else renderPoweredOff(session);
  });
}

/** Bind one physical bay: session glass + StationInstance slot + StreamBroker lease. */
function wireMonitorBay(desk: DeskStation, bayIndex: number, mesh: THREE.Mesh): void {
  const session = desk.sessions[bayIndex - 1];
  if (!session) return;
  bindSessionSurface(session, mesh);
  desk.monitorScreens.set(bayIndex, mesh);
  if (session.surface) desk.instance.registerDisplaySurface(bayIndex, session.surface);
  registerDeskScreen(desk, bayIndex, mesh);
}

/** Restore power from StateStoreV3, persist the full bay list, then re-lease. */
function activateStationBays(desk: DeskStation): void {
  StateStoreV3.getInstance().ensureStationBays('panoramic-theater', desk.id, desk.monitorCount);
  initializeStationSessions(desk);
  desk.save();
  for (let bay = 1; bay <= desk.monitorCount; bay++) {
    streamBroker.notifyChanged(screenLeaseId(desk.id, bay));
  }
}

function refreshSessionRaster(session: MonitorSession, desk: DeskStation, index: number): void {
  if (!session.powered) renderPoweredOff(session);
  // A tab-bound bay deliberately has no paneId — its content comes from one
  // /ws/tab socket, not a pane stream. Without this guard every topology
  // refresh painted the boot card over the tab a few seconds after connecting.
  else if (tabStreams.has(`${desk.id}:${index}`)) dirtyTabStreams.add(`${desk.id}:${index}`);
  else if (!session.paneId) renderMonitorPicker(session, desk, index);
}


// Cold-boot POST for a powered monitor with no source bound. Shares the desk
// HUD's phosphor palette so an idle-but-live panel reads as part of the room
// rather than as a white-on-black error screen.
const BOOT_PALETTE = {
  top: '#04141d', bottom: '#01070b', rule: '#13495e', label: '#4e91a9',
  bright: '#d7f8ff', accent: '#40dcff', ok: '#3ce49a', warn: '#ffb454', fail: '#ff4b59',
};

type MonitorPickerRegion = {
  kind: 'tab' | 'pane' | 'scroll-up' | 'scroll-down';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  tabId?: string;
  paneId?: string;
};
// Keyed by `${deskId}:${index}` like tabStreams. Regions are canvas-space and
// only honored while the bay is still powered and source-less.
const monitorPickerRegions = new Map<string, MonitorPickerRegion[]>();
const monitorPickerScroll = new Map<string, number>();

// The WebGL RENDERER string is routinely 70+ characters and used to run off the
// right edge of the panel. Every value on the boot screen is clipped to its cell.
function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end--;
  return `${text.slice(0, end)}…`;
}

/**
 * Idle state for a powered, source-less bay: the source picker painted on the
 * glass itself. Lists every discovered tab (whole-tab binding) and its panes;
 * clicking a row routes content through the same connect paths the desk HUD
 * uses. Replaces the old POST/boot screen.
 */
function renderMonitorPicker(session: MonitorSession, desk: DeskStation, index: number): void {
  session.source = { kind: 'boot' };
  const key = tabStreamKey(desk.id, index);
  const regions: MonitorPickerRegion[] = [];
  const frame = sessionContentRect(session);
  const ctx = session.canvas.getContext('2d')!;
  fillBezel(ctx, session.canvas, BOOT_PALETTE.bottom);
  const unit = frame.height / 900;
  const padX = frame.x + 104 * unit;
  const contentWidth = frame.width - 208 * unit;
  const font = (size: number, weight = '') => `${weight} ${Math.round(size * unit)}px "Cascadia Mono", Consolas, monospace`.trim();

  const backdrop = ctx.createLinearGradient(0, frame.y, 0, frame.y + frame.height);
  backdrop.addColorStop(0, BOOT_PALETTE.top);
  backdrop.addColorStop(1, BOOT_PALETTE.bottom);
  ctx.fillStyle = backdrop;
  ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  let y = frame.y + 44 * unit;
  ctx.font = font(30, '600');
  ctx.fillStyle = BOOT_PALETTE.label;
  ctx.fillText('OPS ROOM TERMINAL', padX, y);
  ctx.textAlign = 'right';
  ctx.fillText(`BUILD ${diagnostics.appVersion}`, frame.x + frame.width - 104 * unit, y);
  ctx.textAlign = 'left';
  y += 52 * unit;
  ctx.font = font(44, '700');
  ctx.fillStyle = BOOT_PALETTE.bright;
  ctx.shadowColor = BOOT_PALETTE.accent;
  ctx.shadowBlur = 18 * unit;
  ctx.fillText(truncateToWidth(ctx, `${desk.label.toUpperCase()} · DISPLAY ${index} · SELECT SOURCE`, contentWidth), padX, y);
  ctx.shadowBlur = 0;
  y += 74 * unit;
  ctx.fillStyle = BOOT_PALETTE.rule;
  ctx.fillRect(padX, y, contentWidth, Math.max(1, 2 * unit));
  y += 26 * unit;

  const rows: Array<{ kind: 'tab'; tab: TabGroup } | { kind: 'pane'; pane: PaneInfo }> = [];
  for (const tab of discoveredTabs) {
    rows.push({ kind: 'tab', tab });
    tab.panes.forEach(pane => rows.push({ kind: 'pane', pane }));
  }

  const listTop = y;
  const listBottom = frame.y + frame.height - 44 * unit;
  const rowHeight = 58 * unit;
  const rowGap = 10 * unit;
  const visibleRows = Math.max(1, Math.floor((listBottom - listTop + rowGap) / (rowHeight + rowGap)));
  const maxScroll = Math.max(0, rows.length - visibleRows);
  const scroll = Math.max(0, Math.min(monitorPickerScroll.get(key) ?? 0, maxScroll));
  monitorPickerScroll.set(key, scroll);
  const railWidth = maxScroll ? 70 * unit : 0;
  const listWidth = contentWidth - (railWidth ? railWidth + 18 * unit : 0);

  if (!rows.length) {
    ctx.font = font(30);
    ctx.fillStyle = diagnostics.hyperiaOnline ? BOOT_PALETTE.accent : BOOT_PALETTE.warn;
    ctx.fillText(diagnostics.hyperiaOnline ? 'NO LIVE SOURCES · OPEN A HYPERIA TAB' : 'WAITING FOR HYPERIA', padX, listTop + 18 * unit);
  }

  y = listTop;
  for (const row of rows.slice(scroll, scroll + visibleRows)) {
    if (row.kind === 'tab') {
      ctx.fillStyle = '#071720';
      ctx.fillRect(padX, y, listWidth, rowHeight);
      ctx.strokeStyle = '#17475b';
      ctx.lineWidth = Math.max(1, 2 * unit);
      ctx.strokeRect(padX, y, listWidth, rowHeight);
      ctx.fillStyle = '#bcefff';
      ctx.font = font(24);
      ctx.fillText(truncateToWidth(ctx, `TAB  ${row.tab.name}`, listWidth - 34 * unit), padX + 17 * unit, y + rowHeight * .28);
      regions.push({ kind: 'tab', tabId: row.tab.tabId, x0: padX, y0: y, x1: padX + listWidth, y1: y + rowHeight });
    } else {
      const indent = 34 * unit;
      ctx.fillStyle = '#08111a';
      ctx.fillRect(padX + indent, y, listWidth - indent, rowHeight);
      ctx.strokeStyle = '#173141';
      ctx.lineWidth = Math.max(1, 2 * unit);
      ctx.strokeRect(padX + indent, y, listWidth - indent, rowHeight);
      ctx.fillStyle = '#8ebbd0';
      ctx.font = font(22);
      const kind = row.pane.shell === 'web' ? 'WEB' : 'PTY';
      ctx.fillText(truncateToWidth(ctx, `${kind}  ${paneCreatureName(row.pane) || row.pane.paneId.slice(0, 8)}`, listWidth - indent - 34 * unit), padX + indent + 17 * unit, y + rowHeight * .28);
      regions.push({ kind: 'pane', paneId: row.pane.paneId, x0: padX + indent, y0: y, x1: padX + listWidth, y1: y + rowHeight });
    }
    y += rowHeight + rowGap;
  }

  if (maxScroll) {
    const railX = padX + listWidth + 18 * unit;
    const buttonHeight = 64 * unit;
    for (const [kind, buttonY, glyph] of [
      ['scroll-up', listTop, '▲'],
      ['scroll-down', listBottom - buttonHeight, '▼'],
    ] as const) {
      ctx.fillStyle = '#0b3342';
      ctx.fillRect(railX, buttonY, railWidth, buttonHeight);
      ctx.strokeStyle = '#42c8ff';
      ctx.strokeRect(railX, buttonY, railWidth, buttonHeight);
      ctx.fillStyle = '#d7f8ff';
      ctx.font = font(28, '700');
      ctx.textAlign = 'center';
      ctx.fillText(glyph, railX + railWidth / 2, buttonY + buttonHeight * .28);
      ctx.textAlign = 'left';
      regions.push({ kind, x0: railX, y0: buttonY, x1: railX + railWidth, y1: buttonY + buttonHeight });
    }
  }

  ctx.globalAlpha = .05;
  ctx.fillStyle = '#000000';
  for (let line = 0; line < session.canvas.height; line += 4 * unit) ctx.fillRect(0, line, session.canvas.width, Math.max(1, unit));
  ctx.globalAlpha = 1;
  const vignette = ctx.createRadialGradient(session.canvas.width / 2, session.canvas.height / 2, session.canvas.height * .25, session.canvas.width / 2, session.canvas.height / 2, session.canvas.height * .85);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, session.canvas.width, session.canvas.height);

  monitorPickerRegions.set(key, regions);
  session.texture.needsUpdate = true;
}

/** True while the bay is powered but has no pane, tab, or in-flight stream. */
function monitorShowsPicker(desk: DeskStation, index: number): boolean {
  const session = desk.sessions[index - 1];
  return session?.powered === true && !session.paneId && !tabStreams.has(tabStreamKey(desk.id, index));
}

/** Route a raycast uv on idle monitor glass through its painted picker. */
function dispatchMonitorPickerClick(desk: DeskStation, index: number, uv: THREE.Vector2): boolean {
  if (!monitorShowsPicker(desk, index)) return false;
  const session = desk.sessions[index - 1];
  const regions = monitorPickerRegions.get(tabStreamKey(desk.id, index));
  if (!session || !regions?.length) return false;
  // Mirror the panel texture transform (configurePanelTexture) so canvas
  // hit-rects line up with what the operator actually sees on the glass.
  const u = session.surface?.orientation.flipU ? 1 - uv.x : uv.x;
  const v = session.surface?.orientation.flipV ? 1 - uv.y : uv.y;
  const px = u * session.canvas.width;
  const py = (1 - v) * session.canvas.height;
  const region = regions.find(r => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
  if (!region) return false;
  activateDeskWithoutCamera(desk.id);
  desk.selectMonitor(index);
  if (region.kind === 'tab' && region.tabId) connectTabToMonitor(desk, index, region.tabId);
  else if (region.kind === 'pane' && region.paneId) connectPaneToMonitor(desk, index, region.paneId);
  else {
    const key = tabStreamKey(desk.id, index);
    monitorPickerScroll.set(key, (monitorPickerScroll.get(key) ?? 0) + (region.kind === 'scroll-down' ? 1 : -1));
    renderMonitorPicker(session, desk, index);
  }
  return true;
}

/** Discovery changed: refresh the picker on every powered, source-less bay. */
function repaintIdleMonitors(): void {
  desks.forEach(desk => desk.sessions.forEach((session, i) => {
    if (monitorShowsPicker(desk, i + 1)) renderMonitorPicker(session, desk, i + 1);
  }));
}


function setMonitorPower(desk: DeskStation, index: number, powered: boolean, persist = true): void {
  const session = desk.sessions[index - 1]; if (!session) return;
  session.powered = powered;
  if (!powered) {
    disposeTabStream(desk.id, index);
    session.generation++; session.socket?.close(); session.socket = undefined; session.live = false;
    renderPoweredOff(session);
  } else {
    const preservedTarget = desk.monitorTargets[index - 1];
    session.generation++; session.socket?.close(); session.socket = undefined; session.live = false; session.paneId = '';
    activateDeskWithoutCamera(desk.id); desk.selectMonitor(index);
    const tabId = tabIdFromBinding(preservedTarget);
    if (tabId) attachTabStream(desk, index, tabId);
    else if (preservedTarget && discoveredPanes.some(pane => pane.paneId === preservedTarget)) connectPaneToMonitor(desk, index, preservedTarget);
    else renderMonitorPicker(session, desk, index);
  }
  if (persist) desk.save();
  streamBroker.notifyChanged(screenLeaseId(desk.id, index));
  drawDeskHud(desk.id);
  status.textContent = `${desk.label.toUpperCase()} · MONITOR ${index} · ${powered ? 'POWER ON' : 'POWER OFF'}`;
}

function returnMonitorToIdle(desk: DeskStation, index: number): void {
  const session = desk.sessions[index - 1]; if (!session?.powered) return;
  disposeTabStream(desk.id, index);
  session.generation++; session.socket?.close(); session.socket = undefined; session.live = false; session.paneId = '';
  desk.monitorTargets[index - 1] = ''; desk.save();
  renderMonitorPicker(session, desk, index);
  drawDeskHud(desk.id);
}

function reconcileMonitorSources(): void {
  // Empty discovery is "not loaded yet", not "every pane vanished". Wiping
  // here is how a desk-3 bay lost its assignment before topology arrived.
  if (discoveredPanes.length === 0 && discoveredTabs.length === 0) return;
  const available = new Set(discoveredPanes.map(pane => pane.paneId));
  desks.forEach(desk => desk.monitorTargets.forEach((paneId, i) => {
    // A tab is a first-class source, not a pane id. Keep its binding even when
    // topology briefly omits the tab (restart/background transition) so its
    // socket can recover without destroying the operator's saved setup.
    if (paneId && !tabIdFromBinding(paneId) && !available.has(paneId)) returnMonitorToIdle(desk, i + 1);
  }));
}

AssetCache.getInstance().instantiate('/assets/standing_desk_sim_master.glb').then((monitor) => {
  if (closedDesks.includes('operator-desk-1')) return;
  openMonitorHousingFronts(monitor);
  hideDeskLegMeshes(monitor);
  let foundScreen = false;
  monitor.traverse((node) => {
    if (/Monitor_Assembly_[14]/.test(node.name)) node.visible = false;
    const assemblyMatch = node.name.match(/^Monitor_Assembly_([23])$/);
    if (assemblyMatch) tagMonitorHierarchy(node, Number(assemblyMatch[1]) - 1);
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true; node.receiveShadow = true;
    if (/^MonPanel_[23]$/.test(node.name)) {
      // The desk-1 monitor housings always rendered faceted: the FX toggle
      // lived in the retired DOM picker and was unreachable. Keep the look on
      // the shells only — a faceted STAND catches the cyan room wash and
      // reads as a blue glow, so bases/necks/sleeves stay smooth.
      const material = node.material as THREE.MeshStandardMaterial;
      material.flatShading = true;
      material.needsUpdate = true;
    }
    if (node.name === 'Desk_Wood_Top') {
      const source = node.material as THREE.MeshStandardMaterial;
      // The slab is intentionally low-poly; physically-lit vertex normals
      // reveal its internal triangulation in WebGL. Keep the authored bamboo
      // map but make the finish texture-driven and facet-free.
      node.material = new THREE.MeshBasicMaterial({
        map: source.map,
        color: 0xfff1d2,
        toneMapped: true,
      });
      node.receiveShadow = false;
    }
    if (node.name === 'MonScreen_2') {
      node.userData.monitorIndex = 1;
      foundScreen = true;
    }
    if (node.name === 'MonScreen_3') {
      node.userData.monitorIndex = 2;
    }
  });
  monitor.updateMatrixWorld(true);
  let bounds = new THREE.Box3().setFromObject(monitor);
  const center = bounds.getCenter(new THREE.Vector3());
  monitor.position.x -= center.x;
  monitor.position.z -= center.z;
  monitor.position.y -= bounds.min.y;
  monitor.updateMatrixWorld(true);
  bounds = new THREE.Box3().setFromObject(monitor);
  const framedCenter = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const station = registerDesk('operator-desk-1', 'Operator Desk 1', monitor, panoramicTheaterRoom.stationBays['operator-desk-1']);
  applyStationPlacement(monitor, 'operator-desk-1');
  refreshDeskView(station);
  station.sessions.push(...Array.from({ length: station.monitorCount }, createMonitorSession));
  // Wire the GLASS only. tagMonitorHierarchy marks the whole assembly with
  // monitorIndex for click ownership; binding every marked mesh wrapped the
  // session canvas around bases, necks and housings — a powered picker
  // rendered as a blue-tinted stand.
  monitor.traverse(node => {
    const match = node.name.match(/^MonScreen_([23])$/);
    if (!(node instanceof THREE.Mesh) || !match) return;
    wireMonitorBay(station, Number(match[1]) - 1, node);
  });
  activateStationBays(station);
  scene.add(monitor);
  // Authored desk faces +Z. Frame it from a seated operator viewpoint, with
  // both center displays large enough to read and a strip of desktop visible.
  const front = new THREE.Vector3(0, 0, 1);
  const overview = roomOverviewPose();
  controls.target.copy(overview.target);
  camera.position.copy(overview.position);
  camera.fov = 46;
  // near/far are global camera policy (set at construction; far covers the
  // celestial dome) — never derived from one desk's bounding radius.
  camera.updateProjectionMatrix();
  controls.minDistance = .65;
  controls.maxDistance = 42;
  restoreCamera();
  controls.update();
  Object.assign(window, {
    opsDebug: {
      monitor,
      desks,
      get selectedDeskId() { return selectedDeskId; },
      bounds,
      framedCenter,
      size,
      front,
      camera,
      controls,
      scene,
      resetRoom,
      setDeskHeight,
      streamBroker,
      getStreamModes: () => {
        const modes: Record<string, Record<string, ReturnType<StreamBroker['inspectLease']>>> = {};
        for (const desk of desks.values()) {
          const screens: Record<string, ReturnType<StreamBroker['inspectLease']>> = {};
          for (let i = 1; i <= desk.monitorCount; i++) {
            screens[`screen-${i}`] = streamBroker.inspectLease(screenLeaseId(desk.id, i));
          }
          modes[desk.id] = screens;
        }
        return modes;
      },
      wallViewers,
      get spawnedDesks() { return spawnedDesks; },
      spawnDesk: (display: number, variant: SpawnedDeskVariant) => spawnDeskForDisplay(display, variant),
      removeDesk,
      reopenDesk: (stationId: string) => {
        closedDesks = closedDesks.filter(id => id !== stationId);
        persistClosedDesks();
        location.reload();
      },
      get closedDesks() { return closedDesks; },
      toggleWallScreenFocus: (display: number) => {
        const viewer = wallViewers.find(x => x.controller.displayIndex === display);
        if (viewer) toggleWallScreenFocus(viewer);
      },
      setMonitorPower: (deskId: string, index: number, powered: boolean) => {
        const target = desks.get(deskId);
        if (target) setMonitorPower(target, index, powered);
      },
      get discoveredTabs() { return discoveredTabs; },
      get discoveredPanes() { return discoveredPanes; },
      tabStreams,
      focusWallPane: (paneId: string) => {
        for (const viewer of wallViewers) {
          const region = viewer.controller.regionForPane(paneId);
          if (!region) continue;
          wallZoom = { displayIndex: viewer.controller.displayIndex, contentId: `pane:${paneId}` };
          viewer.controller.setFocusedPane(paneId);
          focusWallRegion(viewer, region);
          return;
        }
      },
      showWallOverview: () => focusWallScreen(wallViewers[1]),
    },
  });
  status.textContent = foundScreen ? 'DUAL DESK READY · CONNECTING HYPERIA' : 'SCREEN MESH NOT FOUND';
}).catch((error: unknown) => {
  status.textContent = 'MONITOR ASSET FAILED'; console.error(error);
});

// One additional authored four-monitor station. It remains a separate tracked
// desk entity so selection and its projected HUD never leak into desk 1.
AssetCache.getInstance().instantiate('/assets/standing_desk_sim_master.glb').then((desk) => {
  if (closedDesks.includes('operator-desk-2')) return;
  openMonitorHousingFronts(desk);
  hideDeskLegMeshes(desk);
  desk.traverse(node => {
    const assemblyMatch = node.name.match(/^Monitor_Assembly_([1-4])$/);
    if (assemblyMatch) tagMonitorHierarchy(node, Number(assemblyMatch[1]));
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = true;
    if (node.name === 'Desk_Wood_Top') {
      const source = node.material as THREE.MeshStandardMaterial;
      node.material = new THREE.MeshBasicMaterial({ map: source.map, color: 0xfff1d2, toneMapped: true });
      node.receiveShadow = false;
    }
    const screenMatch = node.name.match(/^MonScreen_([1-4])$/);
    if (screenMatch) {
      node.material = new THREE.MeshBasicMaterial({ color: 0x092634, toneMapped: false });
      node.userData.monitorIndex = Number(screenMatch[1]);
    }
  });
  desk.updateMatrixWorld(true);
  const initialBounds = new THREE.Box3().setFromObject(desk);
  const center = initialBounds.getCenter(new THREE.Vector3());
  desk.position.set(-center.x, -initialBounds.min.y, -center.z);
  desk.updateMatrixWorld(true);
  const station = registerDesk('operator-desk-2', 'Operator Desk 2', desk, panoramicTheaterRoom.stationBays['operator-desk-2']);
  applyStationPlacement(desk, 'operator-desk-2');
  refreshDeskView(station);
  station.sessions.push(...Array.from({ length: station.monitorCount }, createMonitorSession));
  desk.traverse(node => {
    const match = node.name.match(/^MonScreen_([1-4])$/);
    if (!(node instanceof THREE.Mesh) || !match) return;
    wireMonitorBay(station, Number(match[1]), node);
  });
  activateStationBays(station);
  scene.add(desk);

  const pool = new THREE.SpotLight(0xd7efff, 75, 9, .72, .55, 1.5);
  pool.position.set(-5.2, 6.5, .4);
  pool.target.position.set(-5.2, 1, 0);
  scene.add(pool, pool.target);
});

// Right station: authored desk with a large curved primary and smaller
// secondary display replacing its stock monitor assemblies.
AssetCache.getInstance().instantiate('/assets/standing_desk_sim_master.glb').then((desk) => {
  if (closedDesks.includes('operator-desk-3')) return;
  openMonitorHousingFronts(desk);
  hideDeskLegMeshes(desk);
  desk.traverse(node => {
    if (/Monitor_Assembly_[1-4]/.test(node.name)) node.visible = false;
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true; node.receiveShadow = true;
    if (node.name === 'Desk_Wood_Top') {
      const source = node.material as THREE.MeshStandardMaterial;
      node.material = new THREE.MeshBasicMaterial({ map: source.map, color: 0xfff1d2, toneMapped: true });
      node.receiveShadow = false;
    }
  });
  desk.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(desk);
  const center = bounds.getCenter(new THREE.Vector3());
  desk.position.set(-center.x, -bounds.min.y, -center.z);
  desk.updateMatrixWorld(true);
  const station = registerDesk('operator-desk-3', 'Operator Desk 3', desk, panoramicTheaterRoom.stationBays['operator-desk-3']);
  station.sessions.push(...Array.from({ length: station.monitorCount }, createMonitorSession));
  activateStationBays(station);
  scene.add(desk);
  // Capture placement anchors in desk-local coordinates before either the room
  // or the asynchronously loaded displays can move. World-space snapshots here
  // caused the desk to reach its station first and the two displays to arrive
  // later at the room origin, leaving an empty desktop on the far right.
  const anchors = captureDeskAnchors(desk);
  Promise.all([
    AssetCache.getInstance().instantiate('/assets/curved_monitor_ultrawide.glb'),
    AssetCache.getInstance().instantiate('/assets/monitor_black.glb'),
  ]).then(([curved, small]) => {
    attachAuxDisplay(station, desk, anchors, curved, 1, 1.55, -.36);
    attachAuxDisplay(station, desk, anchors, small, 2, .66, .88);
    applyStationPlacement(desk, 'operator-desk-3');
    refreshDeskView(station);
    console.info('right-desk-displays-attached', {
      deskId: station.id,
      deskPosition: desk.position.toArray(),
      monitors: [...station.monitorScreens.entries()].map(([index, screen]) => ({
        index,
        position: screen.getWorldPosition(new THREE.Vector3()).toArray(),
        size: new THREE.Box3().setFromObject(screen).getSize(new THREE.Vector3()).toArray(),
      })),
    });
  }).catch(error => { console.error('Right desk displays failed', error); status.textContent = 'RIGHT DESK DISPLAY LOAD FAILED'; });
  const pool = new THREE.SpotLight(0xd7efff, 75, 9, .72, .55, 1.5);
  pool.position.set(5.2, 6.5, .4); pool.target.position.set(5.2, 1, 0); scene.add(pool, pool.target);
});

// ---------------------------------------------------------------------------
// Aux display attachment (desk-3 recipe) and operator-spawned desks.

type DeskAnchors = { topLocalBounds: THREE.Box3; deskLocalCenter: THREE.Vector3 };

function captureDeskAnchors(desk: THREE.Object3D): DeskAnchors {
  let top: THREE.Object3D | undefined;
  desk.traverse(node => { if (node.name === 'Desk_Wood_Top') top = node; });
  return {
    topLocalBounds: boundsInObjectSpace(top ?? desk, desk),
    deskLocalCenter: boundsInObjectSpace(desk, desk).getCenter(new THREE.Vector3()),
  };
}

/** Mount a standalone monitor asset on a desk top as a first-class bay. */
function attachAuxDisplay(
  station: DeskStation,
  desk: THREE.Object3D,
  anchors: DeskAnchors,
  display: THREE.Object3D,
  index: number,
  targetWidth: number,
  xOffset: number,
): void {
  openMonitorHousingFronts(display);
  display.traverse(node => {
    node.userData.deskId = station.id;
    node.userData.monitorIndex = index;
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = true;
    // The standalone monitor assets ship metallic stands and housings. With
    // no environment map they mirror the cyan room wash and read as a blue
    // tint; the stock desk monitors are authored non-metallic, so match them.
    const material = node.material;
    if (material instanceof THREE.MeshStandardMaterial && material.metalness > 0) {
      material.metalness = 0;
      material.needsUpdate = true;
    }
  });
  display.updateMatrixWorld(true);
  const initial = new THREE.Box3().setFromObject(display);
  display.scale.multiplyScalar(targetWidth / initial.getSize(new THREE.Vector3()).x);
  display.updateMatrixWorld(true);
  const desiredLocal = new THREE.Vector3(
    anchors.deskLocalCenter.x + xOffset,
    anchors.topLocalBounds.max.y + .015,
    anchors.deskLocalCenter.z - .12,
  );
  // The custom displays must live below the same authored height pivot as the
  // stock assemblies. Convert the desk-local placement into pivot space so
  // later height changes carry the top, HUD and monitors together without
  // altering their horizontal station placement.
  const desiredInPivot = station.heightPivot.worldToLocal(desk.localToWorld(desiredLocal));
  station.heightPivot.add(display);
  const localBounds = boundsInObjectSpace(display, station.heightPivot);
  const localBottomCenter = localBounds.getCenter(new THREE.Vector3());
  localBottomCenter.y = localBounds.min.y;
  display.position.add(desiredInPivot.sub(localBottomCenter));
  display.updateWorldMatrix(true, true);
  let screen: THREE.Mesh | undefined;
  display.traverse(node => {
    if (!(node instanceof THREE.Mesh) || screen) return;
    if (node.name === 'CurvedMon_Screen' || node.name === 'Monitor_ScreenFace') screen = node;
  });
  if (!screen) display.traverse(node => {
    if (!(node instanceof THREE.Mesh) || screen) return;
    if (/Screen/i.test(node.name)) screen = node;
  });
  if (screen) {
    screen.userData.deskId = station.id; screen.userData.monitorIndex = index;
    wireMonitorBay(station, index, screen);
    refreshSessionRaster(station.sessions[index - 1], station, index);
    streamBroker.notifyChanged(screenLeaseId(station.id, index));
  }
}

const SPAWNED_DESK_RADIUS = 12;
const SPAWNED_DESK_SPACING_DEG = 15;
const SPAWNED_DESK_BAYS: Record<SpawnedDeskVariant, number> = { '3-up': 3, 'curved+side': 2, '4-up': 4 };

function spawnedDeskLabel(record: SpawnedDeskRecord): string {
  return `Viewer ${record.display} Desk ${spawnedDeskOrdinal(record.stationId)}`;
}

/** Fallback middle angles for the three wall arcs, matching the authored GLB. */
function displayFallbackAzimuth(display: number): number {
  return THREE.MathUtils.degToRad([0, -120, 120][display - 1] ?? -120);
}

/**
 * Floor pose in front of a wall viewer: on the screen's cylindrical middle
 * angle (mirroring how the polar stationLayout derives station poses from the
 * presentation arc), between the dais and the wall, facing the screen. Later
 * desks for the same display fan out around the middle.
 */
function placeSpawnedDesk(record: SpawnedDeskRecord, station: DeskStation): void {
  const viewer = wallViewers[record.display - 1];
  const ordinal = spawnedDeskOrdinal(record.stationId);
  const fan = ordinal <= 1 ? 0 : Math.ceil((ordinal - 1) / 2) * (ordinal % 2 === 0 ? 1 : -1);
  const azimuth = (viewer.mesh ? meshMiddleAzimuth(viewer.mesh) : displayFallbackAzimuth(record.display))
    + THREE.MathUtils.degToRad(fan * SPAWNED_DESK_SPACING_DEG);
  const position = new THREE.Vector3(
    roomLayoutCenter.x + Math.cos(azimuth) * SPAWNED_DESK_RADIUS,
    0,
    roomLayoutCenter.z + Math.sin(azimuth) * SPAWNED_DESK_RADIUS,
  );
  const desk = station.object;
  const sampledNormal = viewer.mesh
    ? sampleSurfaceNormalAtStation(viewer.mesh, position, roomLayoutCenter)
    : undefined;
  const operatorDirection = sampledNormal ?? roomLayoutCenter.clone().sub(position).setY(0).normalize();
  desk.rotation.y = yawFromSurfaceNormal(operatorDirection);
  desk.position.x = 0; desk.position.z = 0;
  desk.updateMatrixWorld(true);
  const visualCenter = new THREE.Box3().setFromObject(desk).getCenter(new THREE.Vector3());
  desk.position.x += position.x - visualCenter.x;
  desk.position.z += position.z - visualCenter.z;
  desk.updateMatrixWorld(true);
  refreshDeskView(station);
}

/** Build the full station machinery for one registry record. */
async function materializeSpawnedDesk(record: SpawnedDeskRecord): Promise<void> {
  if (desks.has(record.stationId)) return;
  const monitorCount = SPAWNED_DESK_BAYS[record.variant];
  const desk = await AssetCache.getInstance().instantiate('/assets/standing_desk_sim_master.glb');
  if (desks.has(record.stationId) || !spawnedDesks.some(entry => entry.stationId === record.stationId)) return;
  openMonitorHousingFronts(desk);
  hideDeskLegMeshes(desk);
  desk.traverse(node => {
    const assemblyMatch = node.name.match(/^Monitor_Assembly_([1-4])$/);
    if (assemblyMatch) {
      const assembly = Number(assemblyMatch[1]);
      if (record.variant === 'curved+side' || assembly > monitorCount) node.visible = false;
      else tagMonitorHierarchy(node, assembly);
    }
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true; node.receiveShadow = true;
    if (node.name === 'Desk_Wood_Top') {
      const source = node.material as THREE.MeshStandardMaterial;
      node.material = new THREE.MeshBasicMaterial({ map: source.map, color: 0xfff1d2, toneMapped: true });
      node.receiveShadow = false;
    }
    const screenMatch = node.name.match(/^MonScreen_([1-4])$/);
    if (screenMatch && record.variant !== 'curved+side' && Number(screenMatch[1]) <= monitorCount) {
      node.material = new THREE.MeshBasicMaterial({ color: 0x092634, toneMapped: false });
      node.userData.monitorIndex = Number(screenMatch[1]);
    }
  });
  desk.updateMatrixWorld(true);
  const initialBounds = new THREE.Box3().setFromObject(desk);
  const center = initialBounds.getCenter(new THREE.Vector3());
  desk.position.set(-center.x, -initialBounds.min.y, -center.z);
  desk.updateMatrixWorld(true);
  const station = registerDesk(record.stationId, spawnedDeskLabel(record), desk, monitorCount);
  station.sessions.push(...Array.from({ length: monitorCount }, createMonitorSession));
  if (record.variant !== 'curved+side') {
    desk.traverse(node => {
      const match = node.name.match(/^MonScreen_([1-4])$/);
      if (!(node instanceof THREE.Mesh) || !match || Number(match[1]) > monitorCount) return;
      wireMonitorBay(station, Number(match[1]), node);
    });
  }
  activateStationBays(station);
  scene.add(desk);
  placeSpawnedDesk(record, station);
  if (record.variant === 'curved+side') {
    const [curved, small] = await Promise.all([
      AssetCache.getInstance().instantiate('/assets/curved_monitor_ultrawide.glb'),
      AssetCache.getInstance().instantiate('/assets/monitor_black.glb'),
    ]);
    if (!desks.has(record.stationId)) return;
    const anchors = captureDeskAnchors(desk);
    attachAuxDisplay(station, desk, anchors, curved, 1, 1.55, -.36);
    attachAuxDisplay(station, desk, anchors, small, 2, .66, .88);
    // Re-place: the attached displays grew the visual bounds the centering used.
    placeSpawnedDesk(record, station);
  }
  drawAllDeskHuds();
  status.textContent = `${spawnedDeskLabel(record).toUpperCase()} ONLINE`;
}

async function spawnDeskForDisplay(displayIndex: number, variant: SpawnedDeskVariant): Promise<void> {
  if (displayIndex < 1 || displayIndex > 3) return;
  const record: SpawnedDeskRecord = {
    stationId: nextSpawnedDeskStationId(spawnedDesks, displayIndex),
    display: displayIndex as 1 | 2 | 3,
    variant,
  };
  spawnedDesks.push(record);
  persistSpawnedDesks();
  status.textContent = `SPAWNING ${spawnedDeskLabel(record).toUpperCase()}`;
  try {
    await materializeSpawnedDesk(record);
  } catch (error) {
    console.error('spawned-desk-failed', record, error);
    spawnedDesks = spawnedDesks.filter(entry => entry.stationId !== record.stationId);
    persistSpawnedDesks();
    status.textContent = 'DESK SPAWN FAILED';
  }
}

/** HUD ✕: tear down sessions and leases, then return the camera to the
 * desk's main screen. Spawned desks leave their registry; built-in stations
 * persist their closure and are skipped on the next boot. */
function removeDesk(stationId: string): void {
  const record = spawnedDesks.find(entry => entry.stationId === stationId);
  const desk = desks.get(stationId);
  if (!desk) return;
  if (record) {
    spawnedDesks = spawnedDesks.filter(entry => entry.stationId !== stationId);
    persistSpawnedDesks();
  } else if (!closedDesks.includes(stationId)) {
    closedDesks = [...closedDesks, stationId];
    persistClosedDesks();
  }
  for (let bay = 1; bay <= desk.monitorCount; bay++) {
    disposeTabStream(stationId, bay);
    streamBroker.unregister(screenLeaseId(stationId, bay));
    monitorPickerRegions.delete(tabStreamKey(stationId, bay));
    monitorPickerScroll.delete(tabStreamKey(stationId, bay));
    const session = desk.sessions[bay - 1];
    if (!session) continue;
    session.generation++;
    session.socket?.close();
    session.socket = undefined;
    session.live = false;
    session.terminal.dispose();
    session.texture.dispose();
  }
  scene.remove(desk.object);
  desks.delete(stationId);
  StateStoreV3.getInstance().removeStationState('panoramic-theater', stationId);
  if (focusedScreen?.deskId === stationId) focusedScreen = undefined;
  if (deskViewId === stationId) deskViewId = undefined;
  if (selectedDeskId === stationId) {
    selectedDeskId = desks.keys().next().value ?? '';
    localStorage.setItem(DESK_STORAGE_KEY, selectedDeskId);
  }
  drawAllDeskHuds();
  status.textContent = `${desk.label.toUpperCase()} REMOVED`;
  const display = record?.display ?? nearestDisplayToDesk(desk);
  const viewer = wallViewers.find(v => v.controller.displayIndex === display);
  if (viewer) focusWallScreen(viewer);
}

/** Which wall arc a desk faces — nearest by wrapped azimuth delta. */
function nearestDisplayToDesk(desk: DeskStation): number {
  const position = new THREE.Vector3();
  desk.object.getWorldPosition(position);
  const azimuth = Math.atan2(position.z, position.x);
  let best = 2, bestDelta = Infinity;
  for (const viewer of wallViewers) {
    const middle = viewer.mesh
      ? meshMiddleAzimuth(viewer.mesh)
      : displayFallbackAzimuth(viewer.controller.displayIndex);
    const delta = Math.abs(Math.atan2(Math.sin(azimuth - middle), Math.cos(azimuth - middle)));
    if (delta < bestDelta) { bestDelta = delta; best = viewer.controller.displayIndex; }
  }
  return best;
}

resetView.addEventListener('click', () => {
  clearWallUnitFocus();
  localStorage.removeItem(CAMERA_STORAGE_KEY);
  setOverviewCamera(); saveCamera();
});

const ansi16 = ['#000000','#cd3131','#0dbc79','#e5e510','#2472c8','#bc3fbc','#11a8cd','#e5e5e5','#666666','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#ffffff'];
function cssColor(color: Color, fallback: string): string {
  if (color === 'default') return fallback;
  if (color.startsWith('#')) return color;
  const index = Number(color.slice(4));
  if (index < 16) return ansi16[index];
  if (index < 232) {
    const n = index - 16, r = Math.floor(n / 36), g = Math.floor(n % 36 / 6), b = n % 6;
    const component = (v: number) => v === 0 ? 0 : 55 + v * 40;
    return `rgb(${component(r)} ${component(g)} ${component(b)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray} ${gray} ${gray})`;
}

function renderTextSnapshot(text: string, session?: MonitorSession): void {
  if (session && !session.powered) return;
  const canvas = session?.canvas ?? activeCanvas;
  const canvasTexture = session?.texture ?? activeTexture;
  const ctx = canvas.getContext('2d')!;
  fillBezel(ctx, canvas, '#070a0f');
  const frame = session ? sessionContentRect(session) : { x: 0, y: 0, width: canvas.width, height: canvas.height };
  ctx.fillStyle = '#070a0f'; ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
  ctx.fillStyle = '#d7e2ea';
  const padX = frame.x + 22, padY = frame.y + 18;
  const lines = text.replace(/\r/g, '').split('\n');
  const sourceCols = Math.max(80, ...lines.map(line => [...line].length));
  const fontSize = Math.max(8, Math.min(22, Math.floor((frame.width - 44) / sourceCols * 1.65)));
  const lineHeight = fontSize * 1.22;
  const visibleRows = Math.floor((frame.height - 36) / lineHeight);
  ctx.font = `${fontSize}px "Cascadia Mono", Consolas, monospace`;
  ctx.textBaseline = 'top';
  lines.slice(-visibleRows).forEach((line, index) => ctx.fillText(line, padX, padY + index * lineHeight));
  ctx.globalAlpha = .045;
  for (let y = 0; y < canvas.height; y += 4) ctx.fillRect(0, y, canvas.width, 1);
  ctx.globalAlpha = 1;
  canvasTexture.needsUpdate = true;
}

function numericColor(value: number, rgb: boolean, fallback: string): string {
  if (rgb) return `#${value.toString(16).padStart(6, '0')}`;
  return cssColor(`ansi${value}` as Color, fallback);
}

function renderPtyTerminal(session?: MonitorSession): void {
  if (session && !session.powered) return;
  const canvas = session?.canvas ?? activeCanvas;
  const canvasTexture = session?.texture ?? activeTexture;
  const terminal = session?.terminal ?? ptyTerminal;
  const terminalCols = session?.cols ?? cols;
  const terminalRows = session?.rows ?? rows;
  const ctx = canvas.getContext('2d')!;
  const buffer = terminal.buffer.active;
  const outerPadX = 22, outerPadY = 18;
  // Terminal glyphs are roughly 0.6 as wide as they are tall. Preserve that
  // cell aspect instead of stretching every source pane to the screen ratio.
  const cellH = Math.min(
    (canvas.height - outerPadY * 2) / terminalRows,
    (canvas.width - outerPadX * 2) / (terminalCols * .6),
  );
  const cellW = cellH * .6;
  const gridWidth = cellW * terminalCols;
  const gridHeight = cellH * terminalRows;
  const padX = (canvas.width - gridWidth) / 2;
  const padY = (canvas.height - gridHeight) / 2;
  const fontSize = Math.max(8, Math.floor(cellH * .86));
  ctx.fillStyle = '#070a0f'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontSize}px "Cascadia Mono", Consolas, monospace`;
  ctx.textBaseline = 'top';
  const cell = buffer.getNullCell();
  for (let y = 0; y < terminalRows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < terminalCols; x++) {
      const current = line.getCell(x, cell);
      if (!current || current.getWidth() === 0) continue;
      let fg = numericColor(current.getFgColor(), current.isFgRGB(), '#d7e2ea');
      let bg = numericColor(current.getBgColor(), current.isBgRGB(), '#070a0f');
      if (current.isFgDefault()) fg = '#d7e2ea';
      if (current.isBgDefault()) bg = '#070a0f';
      if (current.isInverse()) [fg, bg] = [bg, fg];
      if (bg !== '#070a0f') { ctx.fillStyle = bg; ctx.fillRect(padX + x * cellW, padY + y * cellH, cellW + 1, cellH + 1); }
      const character = current.getChars();
      if (character && !current.isInvisible()) {
        ctx.globalAlpha = current.isDim() ? .55 : 1;
        ctx.font = `${current.isItalic() ? 'italic ' : ''}${current.isBold() ? 'bold ' : ''}${fontSize}px "Cascadia Mono", Consolas, monospace`;
        ctx.fillStyle = fg; ctx.fillText(character, padX + x * cellW, padY + y * cellH);
        ctx.globalAlpha = 1;
        if (current.isUnderline()) ctx.fillRect(padX + x * cellW, padY + (y + .88) * cellH, cellW * Math.max(1, current.getWidth()), 1.5);
      }
    }
  }
  ctx.fillStyle = 'rgba(220,245,255,.8)';
  ctx.fillRect(padX + buffer.cursorX * cellW, padY + (buffer.cursorY + .88) * cellH, cellW, 2);
  canvasTexture.needsUpdate = true;
}

type PaneInfo = {
  paneId: string;
  name?: string;
  title: string;
  cols: number;
  rows: number;
  state: string;
  app?: string;
  shellName?: string;
  shell?: string;
  cwd?: string;
  active?: boolean;
  bspX?: number;
  bspY?: number;
  bspW?: number;
  bspH?: number;
};
type TabGroup = { tabId: string; name: string; active?: boolean; panes: PaneInfo[] };

function paneCreatureName(pane: { name?: string; title?: string }): string {
  return (pane.name || pane.title || '').trim();
}

function normalizeDiscoveredPane(pane: PaneInfo): PaneInfo {
  const name = typeof pane.name === 'string' ? pane.name.trim() : '';
  const title = typeof pane.title === 'string' ? pane.title.trim() : '';
  return { ...pane, name: name || undefined, title };
}
let discoveredPanes: PaneInfo[] = [];
let discoveredTabs: TabGroup[] = [];
let restoredMonitorConnections = false;

function isDeskHudPane(pane: PaneInfo): boolean {
  return paneCreatureName(pane).length > 0;
}

function syncTabStreamNames(): void {
  for (const [key, stream] of tabStreams) {
    const tab = discoveredTabs.find(candidate => candidate.tabId === stream.tabId);
    if (!tab) continue;
    stream.rememberNames(tab.panes.map(pane => ({
      paneId: pane.paneId,
      name: pane.name,
      title: pane.title,
      state: pane.state,
      bspX: pane.bspX,
      bspY: pane.bspY,
      bspW: pane.bspW,
      bspH: pane.bspH,
    })));
    dirtyTabStreams.add(key);
  }
}

function syncVideoWallPanes(): void {
  for (const viewer of wallViewers) {
    viewer.controller.setPanes(discoveredPanes as VideoWallPane[]);
    viewer.controller.setTabGroups(discoveredTabs);
  }
}

function restoreStationConnections(): void {
  if (restoredMonitorConnections || desks.size < 3) return;
  let unresolvedRemoteSource = false;
  const restoreDeskId = desks.has(selectedDeskId) ? selectedDeskId : 'operator-desk-1';
  for (const desk of desks.values()) desk.sessions.forEach((session, i) => {
    const sourceId = desk.monitorTargets[i];
    if (!session.powered || !sourceId) return;
    selectedDeskId = desk.id; desk.selectMonitor(i + 1);
    const tabId = tabIdFromBinding(sourceId);
    if (tabId) attachTabStream(desk, i + 1, tabId);
    else if (discoveredPanes.some(pane => pane.paneId === sourceId)) connectPaneToMonitor(desk, i + 1, sourceId);
    else unresolvedRemoteSource = true;
  });
  restoredMonitorConnections = !unresolvedRemoteSource;
  selectedDeskId = restoreDeskId;
  const selected = desks.get(selectedDeskId); if (selected) selected.selectMonitor(selected.selectedMonitor);
  drawAllDeskHuds();
}

async function refreshStatusTopology(): Promise<void> {
  try {
    const response = await fetch('/hyperia-api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const payload = await response.json() as { windows?: Array<{ tabs?: Array<{ tabId: string; name: string; active?: boolean; panes?: PaneInfo[] }> }> };
    const liveById = new Map(discoveredPanes.map(pane => [pane.paneId, pane]));
    discoveredTabs = (payload.windows ?? []).flatMap(window => window.tabs ?? [])
      .map(tab => ({
        tabId: tab.tabId,
        name: tab.name,
        active: tab.active,
        panes: (tab.panes ?? [])
          .map(pane => normalizeDiscoveredPane({ ...liveById.get(pane.paneId), ...pane }))
          .filter(isDeskHudPane),
      }))
      .filter(tab => tab.panes.length > 0);
    discoveredPanes = discoveredTabs.flatMap(tab => tab.panes);
    syncVideoWallPanes();
    syncTabStreamNames();
    reconcileMonitorSources();
    desks.forEach(desk => {
      if (!discoveredTabs.some(tab => tab.tabId === desk.expandedTabId)) desk.expandedTabId = '';
    });
    drawAllDeskHuds();
    repaintIdleMonitors();
    restoreStationConnections();
  } catch (error) {
    console.warn('Hyperia status topology unavailable', error);
  }
}


function connectPaneToMonitor(desk: DeskStation, index: number, paneId: string): void {
  // A stored "tab:<id>" target is a whole-tab binding, not a pane. Restore and
  // reconnect paths hand it back here verbatim; treating it as a paneId opened
  // /ws/pane/tab:<id>, which fails and repaints the bay over its tab.
  const boundTabId = tabIdFromBinding(paneId);
  if (boundTabId) { connectTabToMonitor(desk, index, boundTabId); return; }
  // Switching this bay to a single pane retires any tab that owned it, or the
  // tab keeps compositing over the pane it just replaced.
  const tabKey = `${desk.id}:${index}`;
  const retiring = tabStreams.get(tabKey);
  if (retiring) { retiring.dispose(); tabStreams.delete(tabKey); dirtyTabStreams.delete(tabKey); }
  const monitorIndex = index - 1;
  const session = desk.sessions[monitorIndex];
  if (!session) { status.textContent = `${desk.label.toUpperCase()} · MONITOR ${monitorIndex + 1} NOT READY`; return; }
  // Source selection never changes electrical state. Power is controlled only
  // by the physical numbered monitor button on this desk's HUD.
  if (!session.powered) {
    status.textContent = `${desk.label.toUpperCase()} · MONITOR ${monitorIndex + 1} · POWER OFF`;
    drawDeskHud(desk.id);
    return;
  }
  disposeTabStream(desk.id, index);
  desk.monitorTargets[monitorIndex] = paneId;
  desk.save();
  const paneInfo = discoveredPanes.find(pane => pane.paneId === paneId);
  const alreadyStreamingThisPane = sessionAlreadyStreaming(session, paneId);
  session.paneId = paneId;
  session.source = paneInfo?.shell === 'web' ? { kind: 'web-pixels', paneId } : { kind: 'pty', paneId };
  drawAllDeskHuds();
  refreshSessionRaster(session, desk, index);
  if (session.texture) session.texture.needsUpdate = true;

  if (alreadyStreamingThisPane && streamBroker.getMode(screenLeaseId(desk.id, index)) === 'focused') return;

  // Force socket cleanup for previous stream when switching panes
  session.generation++;
  session.socket?.close();
  session.socket = undefined;
  session.live = false;

  streamBroker.notifyChanged(screenLeaseId(desk.id, index));
  status.textContent = `${desk.label.toUpperCase()} · MONITOR ${index} · ${paneInfo?.shell === 'web' ? 'WEBPANE' : 'ASSIGNED'}`;
}

function preparePtySession(session: MonitorSession): void {
  session.terminal.dispose();
  session.terminal = new Terminal({ cols: session.cols, rows: session.rows, scrollback: 2000, convertEol: false, allowProposedApi: true });
}

function handleFocusedControl(
  session: MonitorSession,
  desk: DeskStation,
  monitorIndex: number,
  message: Record<string, unknown>,
  kind: 'pty' | 'pixels',
): void {
  if (message.t === 'hello') status.textContent = `HYPERIA ${message.serverVersion} · FOCUSED MODE`;
  if (kind === 'pixels' && message.t === 'meta') {
    status.textContent = `${desk.label.toUpperCase()} · MONITOR ${monitorIndex + 1} · WEB ${message.w}×${message.h}`;
    return;
  }
  if (message.t === 'meta') {
    session.cols = Number(message.cols); session.rows = Number(message.rows);
    session.terminal.resize(session.cols, session.rows);
    status.textContent = `MONITOR ${monitorIndex + 1} · CONNECTED ${session.cols}×${session.rows}`;
  }
  if (message.t === 'resize' && message.paneId === session.paneId) {
    session.cols = Number(message.cols); session.rows = Number(message.rows);
    session.terminal.resize(session.cols, session.rows);
    const pane = discoveredPanes.find(candidate => candidate.paneId === session.paneId);
    if (pane) { pane.cols = session.cols; pane.rows = session.rows; drawAllDeskHuds(); }
    renderPtyTerminal(session);
    status.textContent = `MONITOR ${monitorIndex + 1} · RESIZED ${session.cols}×${session.rows}`;
  }
  if (message.t === 'screen-snapshot' && message.paneId === session.paneId) {
    if (!session.live) renderTextSnapshot(String(message.text ?? ''), session);
    status.textContent = `MONITOR ${monitorIndex + 1} · REPLAYING ${session.paneId.slice(0, 8)}`;
  }
  if (message.t === 'replay-end') status.textContent = `MONITOR ${monitorIndex + 1} · LIVE ${session.cols}×${session.rows}`;
}

async function paintFocusedPixels(session: MonitorSession, data: ArrayBuffer | Blob): Promise<void> {
  const frameNumber = ++session.pixelFrame;
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  if (frameNumber !== session.pixelFrame || !session.powered) { bitmap.close(); return; }
  const ctx = session.canvas.getContext('2d')!;
  fillBezel(ctx, session.canvas, '#070a0f');
  drawContained(ctx, bitmap, session.canvas.width, session.canvas.height);
  bitmap.close();
  session.live = true;
  session.texture.needsUpdate = true;
}

function renderWebPaneCard(session: MonitorSession, pane: PaneInfo): void {
  const ctx = session.canvas.getContext('2d')!;
  const frame = sessionContentRect(session);
  fillBezel(ctx, session.canvas, '#03080d');
  const unit = frame.height / 900;
  const gradient = ctx.createLinearGradient(0, frame.y, 0, frame.y + frame.height);
  gradient.addColorStop(0, '#102c3b'); gradient.addColorStop(1, '#03080d');
  ctx.fillStyle = gradient; ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
  ctx.fillStyle = '#07131c'; ctx.fillRect(frame.x + 35 * unit, frame.y + 35 * unit, 1370 * unit, 72 * unit);
  ctx.strokeStyle = '#35cfee'; ctx.lineWidth = Math.max(1, 3 * unit); ctx.strokeRect(frame.x + 35 * unit, frame.y + 35 * unit, 1370 * unit, 830 * unit);
  ctx.fillStyle = '#57d9f1'; ctx.font = `bold ${Math.round(34 * unit)}px Cascadia Mono, monospace`; ctx.fillText('HYPERIA WEBPANE', frame.x + 72 * unit, frame.y + 84 * unit);
  ctx.fillStyle = '#e4faff'; ctx.font = `bold ${Math.round(52 * unit)}px Cascadia Mono, monospace`;
  ctx.fillText((paneCreatureName(pane) || 'WebPane').slice(0, 38), frame.x + 72 * unit, frame.y + 220 * unit);
  ctx.fillStyle = '#79aebf'; ctx.font = `${Math.round(30 * unit)}px Cascadia Mono, monospace`;
  ctx.fillText((pane.cwd || 'URL unavailable').slice(0, 72), frame.x + 72 * unit, frame.y + 285 * unit);
  ctx.fillStyle = '#0b2632'; ctx.fillRect(frame.x + 72 * unit, frame.y + 370 * unit, 1296 * unit, 360 * unit);
  ctx.strokeStyle = '#184e61'; ctx.strokeRect(frame.x + 72 * unit, frame.y + 370 * unit, 1296 * unit, 360 * unit);
  ctx.fillStyle = '#48cce8'; ctx.font = `${Math.round(28 * unit)}px Cascadia Mono, monospace`;
  ctx.fillText('WEB SOURCE ASSIGNED', frame.x + 118 * unit, frame.y + 450 * unit);
  ctx.fillStyle = '#678f9e'; ctx.font = `${Math.round(25 * unit)}px Cascadia Mono, monospace`;
  ctx.fillText('Awaiting Hyperia browser-frame bridge', frame.x + 118 * unit, frame.y + 512 * unit);
  ctx.fillText('PTY stream is not used for WebPanes', frame.x + 118 * unit, frame.y + 560 * unit);
  session.texture.needsUpdate = true;
}

void refreshStatusTopology();
setInterval(refreshStatusTopology, 3000);

function ingestWallTopology(message: WallMessage | { t: string; panes?: PaneInfo[]; windows?: Array<{ tabs?: TabGroup[] }> }): void {
  if (message.t === 'topology' && 'windows' in message && message.windows) {
    const liveById = new Map(discoveredPanes.map(pane => [pane.paneId, pane]));
    discoveredTabs = (message.windows as Array<{ tabs?: TabGroup[] }>).flatMap(window => window.tabs ?? []).map(tab => ({
      ...tab,
      panes: tab.panes
        .map(pane => normalizeDiscoveredPane({ ...liveById.get(pane.paneId), ...pane }))
        .filter(isDeskHudPane),
    }));
    discoveredPanes = discoveredTabs.flatMap(tab => tab.panes).filter(pane => paneCreatureName(pane).length > 0);
    syncVideoWallPanes();
    syncTabStreamNames();
    desks.forEach(desk => { if (!desk.expandedTabId && discoveredTabs.length) desk.expandedTabId = discoveredTabs.find(tab => tab.active)?.tabId ?? discoveredTabs[0].tabId; });
    drawAllDeskHuds();
    repaintIdleMonitors();
  }
  if (message.t === 'panes' && 'panes' in message && message.panes) {
    const liveById = new Map(discoveredPanes.map(pane => [pane.paneId, pane]));
    discoveredPanes = message.panes
      .map(pane => {
        const live = liveById.get(pane.paneId);
        const name = (typeof pane.name === 'string' && pane.name.trim()) || live?.name;
        return normalizeDiscoveredPane({ ...live, ...pane, name });
      })
      .filter(isDeskHudPane)
      .sort((a, b) => paneCreatureName(a).localeCompare(paneCreatureName(b)));
    syncVideoWallPanes();
    syncTabStreamNames();
    reconcileMonitorSources();
    drawAllDeskHuds();
    repaintIdleMonitors();
    restoreStationConnections();
  }
}

const celestialHud = document.createElement('div');
celestialHud.id = 'celestial-hud';
document.body.appendChild(celestialHud);

let lastCelestialUpdate = 0;

function updateCelestialHud(now: number): void {
  const celStatus = celestialSky.update(now, camera);
  if (now - lastCelestialUpdate < 250) return;
  lastCelestialUpdate = now;

  const obs = celestialSky.getActiveObservatory();
  const elev = celStatus.solarElevationDeg.toFixed(1);
  const stateStr = celStatus.isSunDown
    ? `NIGHT MODE ACTIVE (${celStatus.twilightState.toUpperCase()})`
    : `DAYLIGHT (${elev}° ABOVE HORIZON)`;

  const forceState = celestialSky.getForceSunState();
  const toggleLabel = forceState === 'night' ? 'SUN: NIGHT (FORCED)' : forceState === 'day' ? 'SUN: DAY (FORCED)' : 'SUN: LIVE GMT';

  celestialHud.innerHTML = `
    <div class="hud-title">CELESTIAL REMOTE STAR ACTION POINTS</div>
    <div>OBSERVATORY: <b>${obs.name}</b> (${obs.timezone})</div>
    <div>GMT SUN ELEVATION: <b>${elev}°</b> · ${stateStr}</div>
    <div>REMOTE STARS: <b>13 ACTION POINT SOURCES ACTIVE</b></div>
    <button id="toggle-sun-state" class="celestial-btn" type="button">${toggleLabel}</button>
  `;

  const toggleBtn = document.getElementById('toggle-sun-state');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      if (!forceState) celestialSky.setForceSunState('night');
      else if (forceState === 'night') celestialSky.setForceSunState('day');
      else celestialSky.setForceSunState(undefined);
    };
  }
}

function frame(now: number): void {
  if (monitorHold) {
    const desk = desks.get(monitorHold.deskId);
    if (desk && !monitorHold.triggered && now - monitorHold.start >= 650) {
      monitorHold.triggered = true;
      setMonitorPower(desk, monitorHold.index, false);
    } else if (desk && !monitorHold.triggered) drawDeskHud(desk.id);
  }
  if (cameraMove) {
    const t = Math.min(1, (now - cameraMove.start) / cameraMove.duration);
    // Quintic smootherstep: zero velocity and acceleration at both ends. The
    // previous cubic ease-out started at full speed, which caused the snap.
    const eased = t * t * t * (t * (t * 6 - 15) + 10);
    camera.position.lerpVectors(cameraMove.fromPosition, cameraMove.toPosition, eased);
    controls.target.lerpVectors(cameraMove.fromTarget, cameraMove.toTarget, eased);
    if (t === 1) { cameraMove = undefined; seatLookTarget(); saveCamera(); }
  }
  applyWalk(now);
  controls.update();
  streamBroker.tick(camera);
  paintDirtyTabStreams();
  updateCelestialHud(now);
  renderer.render(scene, camera);
  systemLoad.update(now, renderer);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
