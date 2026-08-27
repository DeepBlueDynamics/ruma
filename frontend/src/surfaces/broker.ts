import * as THREE from 'three';
import { OverviewSource, paintOverviewGrid, type OverviewView, type RenderTarget } from '../content/source';
import { wallRowPayload, type Cell, type GridRow, type WallMessage } from '../hyperia/protocol';
import { hyperiaWsUrl, openContentSocket, sessionAlreadyStreaming, type StreamSession } from '../hyperia/stream';
import { DisplaySurface } from './display';
import { FocusedPixelsSource, FocusedPtySource } from './stream-sources';

export type StreamKind = 'pty' | 'pixels';
export type LeaseMode = 'none' | 'overview' | 'focused';

export type StreamAssignment = {
  paneId: string;
  kind: StreamKind;
};

/**
 * A screen the broker can lease streams for. `display` is the new
 * DisplaySurface; acquire/release/applyOverview let the live MonitorSession
 * path keep its existing painters.
 */
export type StreamBinding = {
  id: string;
  object: THREE.Object3D;
  display?: DisplaySurface;
  getPowered(): boolean;
  getAssignment(): StreamAssignment | null;
  /** Live MonitorSession (or equivalent). Broker opens the focused socket on this object. */
  getStreamSession?(): (StreamSession & { paneId: string; canvas?: HTMLCanvasElement }) | undefined;
  /** Prepare painters only — must not open or close sockets. */
  acquireFocused?(kind: StreamKind, paneId: string): void;
  onFocusedText?(message: Record<string, unknown>, assignment: StreamAssignment): void;
  onFocusedBinary?(data: ArrayBuffer | Blob, assignment: StreamAssignment): void;
  releaseFocused?(): void;
  applyOverview?(view: OverviewView): void;
  beginOverview?(): void;
};

export type StreamBrokerOptions = {
  baseUrl?: string;
  /** Distance (m) at which a visible powered screen may take a focused lease. */
  focusedDistance?: number;
  /** Stay focused until this farther distance (hysteresis). */
  releaseDistance?: number;
  overviewFps?: number;
  hiddenGraceMs?: number;
};

type LeaseState = {
  binding: StreamBinding;
  mode: LeaseMode;
  assignedPane?: string;
  hiddenSince?: number;
  lastFocusAttempt?: number;
  overview?: OverviewSource;
  focusedPty?: FocusedPtySource;
  focusedPixels?: FocusedPixelsSource;
  focusedSocket?: WebSocket;
  focusedGeneration?: number;
};

type PaneView = OverviewView & {
  paneId: string;
};

function blankCell(): Cell { return ['', 'default', 'default', 0]; }

function blankGrid(cols: number, rows: number): Cell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, blankCell));
}

/**
 * Tight world AABB of this object’s own mesh — not descendants, not a
 * geometry bounding sphere. Fat spheres put the center metres behind the
 * glass, so a 0.6 m sit looked like > focusedDistance and never focused.
 */
function worldScreenBox(
  object: THREE.Object3D,
  box: THREE.Box3,
): THREE.Box3 {
  object.updateWorldMatrix(true, false);
  box.makeEmpty();
  if (object instanceof THREE.Mesh && object.geometry) {
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    if (object.geometry.boundingBox) box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
  }
  if (box.isEmpty()) {
    object.getWorldPosition(box.min);
    box.max.copy(box.min).addScalar(0.05);
    box.min.addScalar(-0.05);
  }
  return box;
}

function applyRows(view: PaneView, changes: GridRow[]): void {
  for (const row of changes) {
    if (row.y < 0 || row.y >= view.rows) continue;
    const next = Array.from({ length: view.cols }, blankCell);
    row.cells.slice(0, view.cols).forEach((cell, x) => { next[x] = cell; });
    view.grid[row.y] = next;
  }
}

/**
 * Visibility-gated Hyperia stream leasing.
 *
 * Only `/ws/pane/{id}` (PTY) and `/ws/pixels/{id}` are leased, plus one shared
 * low-fps `/ws/wall` for overview. The ops-room control channel
 * (`/ws/v1/control` on :8080) is not a Hyperia stream — do not register it,
 * lease it, or close it from this class. It stays up regardless of camera or
 * monitor power.
 *
 * Visibility is measured from the SCREEN mesh geometry only. Desk descendants
 * (including legs Manatee hides with `visible=false`) must not be in the
 * sample: `Box3.expandByObject` still includes invisible children, and a
 * `visible` walk would flip the gate when legs disappear.
 */
export class StreamBroker {
  private readonly bindings = new Map<string, LeaseState>();
  private readonly views = new Map<string, PaneView>();
  private readonly overviewSubs = new Map<string, Set<string>>();
  private wall?: WebSocket;
  /** External consumers of the raw wall feed, e.g. the presentation wall. */
  private readonly wallListeners = new Set<(message: WallMessage) => void>();
  private lastWallResync = 0;
  private lastCamera?: THREE.Camera;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private readonly corner = new THREE.Vector3();
  private readonly baseUrl?: string;
  private readonly focusedDistance: number;
  private readonly releaseDistance: number;
  private readonly overviewFps: number;
  private readonly hiddenGraceMs: number;

  constructor(options: StreamBrokerOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, '');
    this.focusedDistance = options.focusedDistance ?? 6;
    this.releaseDistance = options.releaseDistance ?? 8.5;
    this.overviewFps = options.overviewFps ?? 2;
    this.hiddenGraceMs = options.hiddenGraceMs ?? 400;
  }

  register(binding: StreamBinding): void {
    const existing = this.bindings.get(binding.id);
    if (existing) {
      existing.binding = binding;
      return;
    }
    this.bindings.set(binding.id, { binding, mode: 'none' });
  }

  unregister(id: string): void {
    const state = this.bindings.get(id);
    if (!state) return;
    this.dropFocused(state);
    this.unsubscribeOverview(id);
    this.bindings.delete(id);
  }

  getMode(id: string): LeaseMode {
    return this.bindings.get(id)?.mode ?? 'none';
  }

  /** Re-evaluate one or all screens after power/assignment changes. */
  notifyChanged(id?: string): void {
    const sample = this.lastCamera ? { camera: this.lastCamera, now: performance.now() } : undefined;
    if (id) {
      const state = this.bindings.get(id);
      if (state) this.applyMode(state, this.desiredMode(state, sample));
      return;
    }
    for (const state of this.bindings.values()) this.applyMode(state, this.desiredMode(state, sample));
  }

  tick(camera: THREE.Camera): void {
    this.lastCamera = camera;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const now = performance.now();
    for (const state of this.bindings.values()) {
      this.applyMode(state, this.desiredMode(state, { camera, now }));
    }
  }

  dispose(): void {
    for (const id of [...this.bindings.keys()]) this.unregister(id);
    this.wall?.close();
    this.wall = undefined;
  }

  private desiredMode(state: LeaseState, sample?: { camera: THREE.Camera; now: number }): LeaseMode {
    const assignment = state.binding.getAssignment();
    if (!state.binding.getPowered() || !assignment) {
      state.hiddenSince = undefined;
      return 'none';
    }
    if (!sample) return state.mode === 'none' ? 'overview' : state.mode;

    const { visible, distance } = this.measure(state.binding, sample.camera);
    if (visible) state.hiddenSince = undefined;
    else if (state.hiddenSince === undefined) state.hiddenSince = sample.now;

    const hiddenLongEnough = !visible && state.hiddenSince !== undefined
      && sample.now - state.hiddenSince >= this.hiddenGraceMs;

    if (state.mode === 'focused') {
      if (!hiddenLongEnough && distance <= this.releaseDistance) return 'focused';
      return 'overview';
    }
    if (visible && distance <= this.focusedDistance) return 'focused';
    return 'overview';
  }

  private measure(binding: StreamBinding, camera: THREE.Camera): { visible: boolean; distance: number } {
    const screen = binding.display?.mesh ?? binding.object;
    worldScreenBox(screen, this.box);
    const distance = this.box.distanceToPoint(camera.position);
    // Sitting in the glass volume — frustum near-plane would reject this.
    if (distance <= 0.08 || this.box.containsPoint(camera.position)) {
      return { visible: true, distance };
    }
    if (distance <= this.focusedDistance) {
      return { visible: this.boxFacesCamera(camera), distance };
    }
    return { visible: this.frustum.intersectsBox(this.box), distance };
  }

  /** True if any corner of the screen AABB is in front of the camera (local −Z). */
  private boxFacesCamera(camera: THREE.Camera): boolean {
    const { min, max } = this.box;
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
      this.corner.set(x ? max.x : min.x, y ? max.y : min.y, z ? max.z : min.z);
      this.corner.applyMatrix4(camera.matrixWorldInverse);
      if (this.corner.z <= 0.05) return true;
    }
    return false;
  }

  inspectLease(id: string): {
    mode: LeaseMode;
    paneId?: string;
    distance?: number;
    visible?: boolean;
    socket: 'NONE' | 'CONNECTING' | 'OPEN' | 'CLOSING';
  } {
    const state = this.bindings.get(id);
    if (!state) return { mode: 'none', socket: 'NONE' };
    const assignment = state.binding.getAssignment();
    const session = state.binding.getStreamSession?.();
    const sock = session?.socket ?? state.focusedSocket;
    const socket: 'NONE' | 'CONNECTING' | 'OPEN' | 'CLOSING' = !sock ? 'NONE'
      : sock.readyState === WebSocket.CONNECTING ? 'CONNECTING'
      : sock.readyState === WebSocket.OPEN ? 'OPEN'
      : sock.readyState === WebSocket.CLOSING ? 'CLOSING'
      : 'NONE';
    const measured = this.lastCamera ? this.measure(state.binding, this.lastCamera) : undefined;
    return {
      mode: state.mode,
      paneId: assignment?.paneId,
      distance: measured?.distance,
      visible: measured?.visible,
      socket,
    };
  }

  private applyMode(state: LeaseState, next: LeaseMode): void {
    const paneId = state.binding.getAssignment()?.paneId;
    const assignmentChanged = paneId !== state.assignedPane;
    if (state.mode === next && !assignmentChanged) {
      if (next === 'overview') this.ensureOverview(state, false);
      else if (next === 'focused' && !this.ensureFocused(state)) {
        // desiredMode still says focused, but the lease died. Don't keep
        // advertising focused/NONE — drop to overview until the next tick
        // re-acquires.
        this.dropFocused(state);
        state.mode = 'overview';
        this.ensureOverview(state, true);
      }
      return;
    }
    if (state.mode === 'focused') this.dropFocused(state);
    if (state.mode === 'overview' || assignmentChanged) this.unsubscribeOverview(state.binding.id);
    state.assignedPane = paneId;
    if (next === 'focused') {
      state.mode = this.takeFocused(state) ? 'focused' : 'overview';
      if (state.mode === 'overview') this.ensureOverview(state, true);
      return;
    }
    state.mode = next;
    if (next === 'overview') this.ensureOverview(state, true);
  }

  /**
   * A live focused lease is the session socket (CONNECTING/OPEN) for this pane.
   * A leftover `focusedSocket` with `session.socket === undefined` is how
   * mode=focused / sock=NONE happened: acquire skipped openFocusedOnSession.
   */
  private liveFocusedSocket(state: LeaseState, paneId: string): boolean {
    const session = state.binding.getStreamSession?.();
    if (session) {
      if (sessionAlreadyStreaming(session, paneId)) {
        state.focusedSocket = session.socket;
        return true;
      }
      state.focusedSocket = undefined;
      return false;
    }
    const socket = state.focusedSocket;
    const live = !!socket && socket.readyState <= WebSocket.OPEN;
    if (!live) state.focusedSocket = undefined;
    return live;
  }

  private ensureFocused(state: LeaseState): boolean {
    const assignment = state.binding.getAssignment();
    if (!assignment) return false;
    if (this.liveFocusedSocket(state, assignment.paneId)) return true;
    const now = performance.now();
    if (state.lastFocusAttempt !== undefined && now - state.lastFocusAttempt < 350) return false;
    return this.takeFocused(state);
  }

  private takeFocused(state: LeaseState): boolean {
    const assignment = state.binding.getAssignment();
    if (!assignment) return false;
    this.unsubscribeOverview(state.binding.id);
    state.lastFocusAttempt = performance.now();
    // Painters only — must not open or close sockets.
    state.binding.acquireFocused?.(assignment.kind, assignment.paneId);
    if (this.liveFocusedSocket(state, assignment.paneId)) return true;

    const session = state.binding.getStreamSession?.();
    if (session) {
      this.openFocusedOnSession(state, session, assignment);
      return this.liveFocusedSocket(state, assignment.paneId);
    }
    const display = state.binding.display;
    if (!display) return false;
    if (assignment.kind === 'pixels') {
      const source = new FocusedPixelsSource(assignment.paneId);
      state.focusedPixels = source;
      display.setSource(source);
      this.openPixelSocket(state, assignment.paneId, source, display);
    } else {
      const source = new FocusedPtySource(assignment.paneId);
      state.focusedPty = source;
      display.setSource(source);
      this.openPtySocket(state, assignment.paneId, source);
    }
    return this.liveFocusedSocket(state, assignment.paneId);
  }

  private openFocusedOnSession(
    state: LeaseState,
    session: StreamSession & { paneId: string; canvas?: HTMLCanvasElement },
    assignment: StreamAssignment,
  ): void {
    session.paneId = assignment.paneId;
    session.powered = true;
    const canvas = session.canvas;
    const url = assignment.kind === 'pixels'
      ? hyperiaWsUrl(`/ws/pixels/${assignment.paneId}?w=${canvas?.width ?? 1440}&h=${canvas?.height ?? 900}&fps=12`)
      : hyperiaWsUrl(`/ws/pane/${assignment.paneId}?scrollback=1`);
    const { generation, socket } = openContentSocket(session, url, {
      onText: message => state.binding.onFocusedText?.(message, assignment),
      onBinary: data => state.binding.onFocusedBinary?.(data, assignment),
      onClose: () => {
        if (state.focusedSocket === socket) state.focusedSocket = undefined;
        if (state.mode === 'focused') this.ensureFocused(state);
      },
    });
    state.focusedSocket = socket;
    state.focusedGeneration = generation;
  }

  private dropFocused(state: LeaseState): void {
    if (state.mode === 'focused') state.binding.releaseFocused?.();
    if (state.focusedSocket && state.focusedSocket.readyState <= WebSocket.OPEN) state.focusedSocket.close();
    state.focusedSocket = undefined;
    state.focusedPty?.dispose();
    state.focusedPty = undefined;
    state.focusedPixels = undefined;
    state.focusedGeneration = undefined;
  }

  private emptyOverview(paneId: string): OverviewView {
    return {
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: false },
      grid: blankGrid(80, 24),
      hasFrame: false,
      title: paneId.slice(0, 8),
    };
  }

  private ensureOverview(state: LeaseState, paint = true): void {
    const assignment = state.binding.getAssignment();
    if (!assignment) return;
    const already = this.overviewSubs.get(assignment.paneId)?.has(state.binding.id) === true;
    this.subscribeOverview(state.binding.id, assignment.paneId);
    this.ensureWallSocket();
    if (!paint && already) return;
    this.paintOverviewBinding(state, assignment.paneId);
    const view = this.views.get(assignment.paneId);
    if (!view?.hasFrame) this.requestWallResync();
  }

  requestWallResync(): void {
    if (!this.wall || this.wall.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - this.lastWallResync < 1500) return;
    this.lastWallResync = now;
    this.wall.send(JSON.stringify({ t: 'resync' }));
  }

  private paintOverviewBinding(state: LeaseState, paneId: string): void {
    const view = this.views.get(paneId) ?? this.emptyOverview(paneId);
    if (state.binding.display && !state.binding.applyOverview) {
      if (!(state.overview instanceof OverviewSource) || state.overview.id !== `overview:${paneId}`) {
        state.overview = new OverviewSource(paneId);
        state.binding.display.setSource(state.overview);
      }
      state.overview.apply(view);
      return;
    }
    state.binding.beginOverview?.();
    state.binding.applyOverview?.(view);
  }

  private subscribeOverview(bindingId: string, paneId: string): void {
    let subs = this.overviewSubs.get(paneId);
    if (!subs) {
      subs = new Set();
      this.overviewSubs.set(paneId, subs);
    }
    subs.add(bindingId);
  }

  private unsubscribeOverview(bindingId: string): void {
    for (const [paneId, subs] of this.overviewSubs) {
      if (!subs.delete(bindingId)) continue;
      if (subs.size === 0) this.overviewSubs.delete(paneId);
    }
  }

  /**
   * Subscribe an external consumer to the shared `/ws/wall` cell-grid feed.
   *
   * The presentation wall renders terminal panes from these grids, but the feed
   * previously existed only for desk screens in overview mode and nothing
   * outside this class could reach it - so selecting a terminal on the main
   * screen silently showed nothing while web panes worked. Registering also
   * opens the socket, because the wall must not depend on some desk screen
   * happening to be in overview.
   */
  onWallMessage(listener: (message: WallMessage) => void): () => void {
    this.wallListeners.add(listener);
    this.ensureWallSocket();
    return () => { this.wallListeners.delete(listener); };
  }

  private ensureWallSocket(): void {
    if (this.wall && this.wall.readyState <= WebSocket.OPEN) return;
    const url = this.baseUrl
      ? `${this.baseUrl}/ws/wall?fps=${this.overviewFps}`
      : hyperiaWsUrl(`/ws/wall?fps=${this.overviewFps}`);
    const socket = new WebSocket(url);
    this.wall = socket;
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || this.wall !== socket) return;
      let message: WallMessage;
      try {
        message = JSON.parse(event.data) as WallMessage;
      } catch {
        return;
      }
      if (message.t === 'ping') {
        socket.send(JSON.stringify({ t: 'pong' }));
        return;
      }
      for (const listener of this.wallListeners) listener(message);
      this.handleWall(message);
    });
    socket.addEventListener('close', () => {
      if (this.wall !== socket) return;
      this.wall = undefined;
      // Desk screens re-open this on the next tick via subscribeOverview, but an
      // external consumer has no such tick. Without this the presentation wall
      // goes permanently dark on a single dropped socket.
      if (this.wallListeners.size > 0) setTimeout(() => { if (this.wallListeners.size > 0) this.ensureWallSocket(); }, 1500);
    });
    socket.addEventListener('error', () => {
      if (this.wall === socket) {
        this.wall = undefined;
        socket.close();
      }
    });
  }

  private handleWall(message: WallMessage): void {
    if (message.t === 'resync') {
      // Keep last overview raster; replacement frames follow.
      return;
    }
    if (message.t === 'topo' && message.op === 'remove') {
      this.views.delete(message.paneId);
      return;
    }
    const paneId = 'paneId' in message ? message.paneId : undefined;
    if (!paneId) return;
    let view = this.views.get(paneId);
    if (!view) {
      view = {
        paneId,
        cols: 80,
        rows: 24,
        cursor: { x: 0, y: 0, visible: false },
        grid: blankGrid(80, 24),
        hasFrame: false,
      };
      this.views.set(paneId, view);
    }
    if (message.t === 'frame') {
      if (message.cols !== view.cols || message.rows !== view.rows) {
        view.cols = message.cols;
        view.rows = message.rows;
        view.grid = blankGrid(view.cols, view.rows);
      }
      applyRows(view, wallRowPayload(message));
      view.cursor = message.cursor;
      view.hasFrame = true;
      this.flushOverview(paneId);
    } else if (message.t === 'delta') {
      applyRows(view, wallRowPayload(message));
      view.cursor = message.cursor;
      view.hasFrame = true;
      this.flushOverview(paneId);
    } else if (message.t === 'resize') {
      view.cols = Math.max(1, message.cols);
      view.rows = Math.max(1, message.rows);
      view.grid = blankGrid(view.cols, view.rows);
      view.hasFrame = false;
      this.flushOverview(paneId);
    }
  }

  private flushOverview(paneId?: string): void {
    const ids = paneId ? [paneId] : [...this.overviewSubs.keys()];
    for (const id of ids) {
      if (!this.views.has(id)) continue;
      for (const bindingId of this.overviewSubs.get(id) ?? []) {
        const state = this.bindings.get(bindingId);
        if (!state || state.mode !== 'overview') continue;
        this.paintOverviewBinding(state, id);
      }
    }
  }

  private openPtySocket(state: LeaseState, paneId: string, source: FocusedPtySource): void {
    const session = { generation: 0, live: false, powered: true, socket: undefined as WebSocket | undefined };
    const { generation, socket } = openContentSocket(session, hyperiaWsUrl(`/ws/pane/${paneId}?scrollback=1`), {
      onBinary: data => {
        if (data instanceof ArrayBuffer) source.write(new Uint8Array(data));
      },
      onText: message => {
        if (message.t === 'meta' || message.t === 'resize') {
          source.resize(Number(message.cols), Number(message.rows));
        }
      },
      onClose: () => {
        if (state.focusedSocket === socket) state.focusedSocket = undefined;
        if (state.mode === 'focused') this.ensureFocused(state);
      },
    });
    state.focusedSocket = socket;
    state.focusedGeneration = generation;
  }

  private openPixelSocket(state: LeaseState, paneId: string, source: FocusedPixelsSource, display: DisplaySurface): void {
    const session = { generation: 0, live: false, powered: true, socket: undefined as WebSocket | undefined };
    const { generation, socket } = openContentSocket(
      session,
      hyperiaWsUrl(`/ws/pixels/${paneId}?w=${display.canvas.width}&h=${display.canvas.height}&fps=12`),
      {
        onBinary: async data => {
          const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/jpeg' });
          const bitmap = await createImageBitmap(blob);
          if (state.mode !== 'focused' || state.focusedPixels !== source) { bitmap.close(); return; }
          source.draw(bitmap);
        },
        onClose: () => {
          if (state.focusedSocket === socket) state.focusedSocket = undefined;
          if (state.mode === 'focused') this.ensureFocused(state);
        },
      },
    );
    state.focusedSocket = socket;
    state.focusedGeneration = generation;
  }
}

export function paintBindingOverview(target: RenderTarget, view: OverviewView): void {
  paintOverviewGrid(target, view);
  target.markDirty();
}
