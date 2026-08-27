import { hyperiaWsUrl } from './stream';
import { ATTR, cssColor, normalizeGridRows, paneChrome, type Cell } from './protocol';

/**
 * `/ws/tab/{tabId}` composition client.
 *
 * Server order is guaranteed: hello → tab-layout → terminal FRAME keyframes
 * in that first burst. Layout is the manifest; do not invent a wait, a seed,
 * or a wall-feed fallback. A keyframe of blank rows is a valid empty mirror
 * (idle pane / restart) — paint an empty terminal, do not treat it as "no data".
 *
 * Terminals: cell-grid frame/delta. Web: { t: "pixels", paneId, jpeg }.
 * Input (not wired here): { t: "input", paneId, keys }.
 *
 * Panes are keyed by paneId, never by rect. Sidecar ≤0.17.9 may send late
 * panes at the default 0,0,100,100; if 2+ share that (or any) rect, pack
 * auto-grids them. Never hide a pane the manifest included.
 */

type TabPaneLayout = {
  paneId: string;
  type: 'terminal' | 'web';
  /** Stable Hyperia codename. Prefer this for labels. Never shadowed by title. */
  name: string;
  /** True when sidecar v0.17.9+ sent layout.name. Topology must not overwrite it. */
  namedFromLayout: boolean;
  /** Volatile OSC title; show as status when it differs from name. */
  title: string;
  color: string;
  colorFromLayout: boolean;
  focused: boolean;
  state: 'running' | 'idle';
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
};

type PaneState = {
  layout: TabPaneLayout;
  cols: number;
  rows: number;
  grid: Cell[][];
  cursor: { x: number; y: number; visible: boolean };
  hasFrame: boolean;
  bitmap?: ImageBitmap;
};

function blankCell(): Cell { return ['', 'default', 'default', 0]; }
function blankGrid(cols: number, rows: number): Cell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, blankCell));
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asPercent(value: unknown, fallback: number): number {
  const n = asNumber(value, fallback);
  return n > 0 && n <= 1 ? n * 100 : n;
}

function paneKind(rec: Record<string, unknown>): 'terminal' | 'web' {
  const raw = String(rec.type ?? rec.kind ?? rec.shell ?? rec.paneType ?? 'terminal').toLowerCase();
  return raw === 'web' || raw === 'pixels' || raw === 'browser' ? 'web' : 'terminal';
}

/** Stable Hyperia-style accent from the creature name (same name → same hue). */
function colorFromName(name: string): string {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 78% 62%)`;
}

function paneRunState(value: unknown): 'running' | 'idle' {
  return value === 'idle' ? 'idle' : 'running';
}

function isPlaceholderName(name: string, paneId: string): boolean {
  const trimmed = name.trim();
  return !trimmed || trimmed === paneId || trimmed === paneId.slice(0, 8);
}

function parseLayoutPane(raw: unknown): TabPaneLayout | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const rect = (rec.rect && typeof rec.rect === 'object' ? rec.rect : rec) as Record<string, unknown>;
  const paneId = String(rec.paneId ?? rec.id ?? rec.uid ?? '');
  if (!paneId) return undefined;
  const chrome = paneChrome({
    name: rec.name,
    title: rec.title ?? rec.label,
    paneId,
  });
  const colorFromLayout = typeof rec.color === 'string' && rec.color.trim().length > 0
    || typeof rec.headerColor === 'string' && rec.headerColor.trim().length > 0;
  const color = typeof rec.color === 'string' && rec.color.trim()
    ? rec.color.trim()
    : typeof rec.headerColor === 'string' && rec.headerColor.trim()
      ? rec.headerColor.trim()
      : colorFromName(chrome.name);
  return {
    paneId,
    type: paneKind(rec),
    name: chrome.name,
    namedFromLayout: chrome.namedFromLayout,
    title: chrome.title,
    color,
    colorFromLayout,
    focused: rec.focused === true || rec.active === true,
    state: paneRunState(rec.state),
    // Hyperia BSP leaves use bspX/Y/W/H (percent). Stacked/hidden nodes
    // still report 0,0,100,100 — those are not the visible split.
    x: asPercent(rect.x ?? rec.bspX ?? rect.left, 0),
    y: asPercent(rect.y ?? rec.bspY ?? rect.top, 0),
    w: asPercent(rect.w ?? rec.bspW ?? rec.width, 100),
    h: asPercent(rect.h ?? rec.bspH ?? rec.height, 100),
    cols: Math.max(1, asNumber(rec.cols, 80)),
    rows: Math.max(1, asNumber(rec.rows, 24)),
  };
}

function rectArea(pane: { w: number; h: number }): number {
  return Math.max(0, pane.w) * Math.max(0, pane.h);
}

export type TabTileRect = { paneId: string; x: number; y: number; w: number; h: number };

/** Panes carry their PTY grid size; that is what makes layout repair possible. */
export type PaneMetrics = TabTileRect & { cols: number; rows: number; splitLabel?: string };

function hasMetrics(pane: TabTileRect): pane is PaneMetrics {
  const rec = pane as Partial<PaneMetrics>;
  return typeof rec.cols === 'number' && rec.cols > 0
    && typeof rec.rows === 'number' && rec.rows > 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * A pane the sidecar never placed. Stacked and freshly-split panes keep the
 * default full-tab rect until the next relayout, so in a multi-pane tab this
 * rect means "unknown", not "fills the tab".
 */
function isFullTabRect(pane: TabTileRect): boolean {
  return round1(pane.x) === 0 && round1(pane.y) === 0
    && round1(pane.w) >= 99 && round1(pane.h) >= 99;
}

function overlaps(a: TabTileRect, b: TabTileRect): boolean {
  return a.x < b.x + b.w - .5 && b.x < a.x + a.w - .5
    && a.y < b.y + b.h - .5 && b.y < a.y + a.h - .5;
}

/** Do these rects already cover the tab exactly once? Then nothing needs repair. */
function rectsTile(panes: TabTileRect[]): boolean {
  let area = 0;
  for (let i = 0; i < panes.length; i++) {
    if (isFullTabRect(panes[i]) && panes.length > 1) return false;
    for (let j = i + 1; j < panes.length; j++) {
      if (overlaps(panes[i], panes[j])) return false;
    }
    area += Math.max(0, panes[i].w) * Math.max(0, panes[i].h);
  }
  return Math.abs(area - 10000) < 200;
}

/**
 * Per-pane chrome (title bar, borders) expressed in text rows.
 *
 * Every column spans the full tab height, so for columns j:
 *     rowSum_j + paneCount_j * chrome  =  constant
 * Two columns with different pane counts determine `chrome` outright. A
 * negative result means the grouping is not a real column layout — that is the
 * check that rules out wrong partitions, not the fit itself, which solves
 * exactly for any two groups of differing size and so proves nothing.
 *
 * Returns null when no column grouping can be reconciled.
 */
function solveChromeRows(columns: Array<Array<{ rows: number }>>): number | null {
  const stats = columns.map(column => ({
    rows: column.reduce((sum, pane) => sum + pane.rows, 0),
    count: column.length,
  }));
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      if (stats[i].count === stats[j].count) continue;
      const chrome = (stats[j].rows - stats[i].rows) / (stats[i].count - stats[j].count);
      if (!Number.isFinite(chrome) || chrome <= 0) continue;
      const heights = stats.map(stat => stat.rows + stat.count * chrome);
      const spread = Math.max(...heights) - Math.min(...heights);
      if (spread <= Math.max(...heights) * .02) return chrome;
    }
  }
  return null;
}

/**
 * Vertical order within a column.
 *
 * `splitLabel` (a, b, c…) is the authoritative order when the feed carries it.
 * Hyperia 0.17.38 does not send it on /api/status or via terminal_status, so
 * the fallback is: positioned panes keep their reported order, and a repaired
 * pane goes last — its true slot is genuinely unknown, not guessed.
 */
function orderColumn<T extends PaneMetrics>(column: T[]): T[] {
  if (column.every(pane => typeof pane.splitLabel === 'string' && pane.splitLabel)) {
    return [...column].sort((a, b) => (a.splitLabel as string).localeCompare(b.splitLabel as string));
  }
  return [...column].sort((a, b) => {
    const aKnown = !isFullTabRect(a), bKnown = !isFullTabRect(b);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return a.y - b.y;
  });
}

/**
 * Rebuild the true split geometry from the rects that ARE valid plus the PTY
 * dimensions of the ones that are not.
 *
 * Upstream cause (confirmed by the Hyperia author, fixed in 0.17.40, canary
 * c05a4344): same-direction splits build N-ary term groups, but the BSP walker
 * feeding the sidecar only visited children[0] and children[1]. Every 3rd+ pane
 * in a stack therefore got no rect at all and fell back to 0,0,100,100, while
 * its siblings kept their stale pre-split shares. Observed on 0.17.38 — a
 * five-pane tab reported as four quadrants with two panes sharing one rect.
 *
 * So the repair below is needed for any tab with a 3+ stack until the sidecar
 * restarts on 0.17.40 or later. After that, valid rects pass through untouched
 * (see the fast path at the top of the function) and this code goes quiet on
 * its own — there is no version check to remember to remove.
 *
 * `cols`/`rows` do not go stale, because they come from a real PTY resize. Two
 * panes in the same column have the same `cols`; panes in the same column also
 * share a row cadence, which is what identifies the column an unplaced pane
 * belongs to. So: trust the rects that tile, use the grid sizes to slot in the
 * ones that do not, then re-divide each column proportionally by row count.
 *
 * Returns null when the rects are too damaged to anchor to — the caller then
 * falls back to the uniform row stack, which is ugly but never hides a pane.
 */
export function repairTabLayout<T extends PaneMetrics>(panes: T[]): Array<T & TabTileRect> | null {
  if (panes.length < 2) return null;

  // Fast path — trust the sidecar when it tiles. Once Hyperia is on 0.17.40+
  // every tab lands here and nothing below runs.
  if (rectsTile(panes)) return panes.map(pane => ({ ...pane }));

  const placed: T[] = [];
  const unplaced: T[] = [];
  for (const pane of panes) {
    if (isFullTabRect(pane)) { unplaced.push(pane); continue; }
    // A rect that collides with one already accepted is stale too.
    if (placed.some(other => overlaps(other, pane))) { unplaced.push(pane); continue; }
    placed.push(pane);
  }
  if (!placed.length) return null;

  // Columns come from the x/width of the rects that survived.
  const columns = new Map<string, T[]>();
  for (const pane of placed) {
    const key = `${round1(pane.x)}:${round1(pane.w)}`;
    const column = columns.get(key);
    if (column) column.push(pane); else columns.set(key, [pane]);
  }

  for (const pane of unplaced) {
    // Same column ⇒ same width in cells, and the same row cadence.
    let best: T[] | undefined;
    let bestScore = Infinity;
    for (const column of columns.values()) {
      const head = column[0];
      if (head.cols !== pane.cols) continue;
      const score = Math.abs(head.rows - pane.rows);
      if (score < bestScore) { bestScore = score; best = column; }
    }
    if (!best) return null;
    best.push(pane);
  }

  const groups = [...columns.values()];
  // Sanity gate, not a weighting. Every column spans the full tab height, so a
  // real column grouping implies a positive per-pane chrome; a negative one
  // means these panes are not actually stacked the way the rects suggest.
  // Against the live capture this ruled out 14 of 15 candidate partitions.
  if (groups.length > 1 && solveChromeRows(groups) === null) return null;
  const gap = .4;
  const tiles: Array<T & TabTileRect> = [];
  for (const column of groups) {
    const ordered = orderColumn(column);
    // Divide by row count. Weighting by rows-plus-solved-chrome was tried and
    // dropped: measured against the one left-column rect the buggy walker did
    // set (Ostrich h=37), rows alone is off by 0.29 points and chrome-weighted
    // by 0.51. `rows` is integer-quantised, so chrome is not recoverable to
    // that precision — deriving it from that rect gives 1.55 rows, from the
    // column-height equation 5.00. Equal shares would be off by 3.67.
    const total = ordered.reduce((sum, pane) => sum + pane.rows, 0);
    const x = round1(ordered[0].x);
    const w = round1(ordered[0].w);
    let y = 0;
    for (const pane of ordered) {
      const share = (pane.rows / total) * 100;
      tiles.push({
        ...pane,
        x,
        w,
        y: y + (y > 0 ? gap / 2 : 0),
        h: Math.max(1, share - gap),
      });
      y += share;
    }
  }
  return tiles;
}

/**
 * Turn the panes of a tab into tiles on a surface.
 *
 * Prefers the tab's real split geometry, reconstructed by `repairTabLayout`
 * from the valid rects plus PTY grid sizes. When that is not recoverable —
 * damaged rects, or a feed with no cols/rows — falls back to laying every pane
 * out as a full-width row of equal height.
 *
 * Both paths guarantee the same thing: never hide a pane we received, and never
 * give two panes the same rect. Identity is `paneId`, never geometry.
 */
export function packTabTiles<T extends TabTileRect>(panes: T[]): Array<T & TabTileRect> {
  if (!panes.length) return [];
  if (panes.length === 1) return [{ ...panes[0], x: 0, y: 0, w: 100, h: 100 }];

  if (panes.every(hasMetrics)) {
    const repaired = repairTabLayout(panes as Array<T & PaneMetrics>);
    if (repaired && repaired.length === panes.length) return repaired;
  }

  const count = panes.length;
  const rowHeight = 100 / count;
  const gap = .4;

  return panes.map((pane, index) => {
    return {
      ...pane,
      x: 0,
      y: index * rowHeight + (index > 0 ? gap / 2 : 0),
      w: 100,
      h: Math.max(1, rowHeight - gap),
    };
  });
}

export class TabStream {
  private socket?: WebSocket;
  /** paneId → live state. Never keyed by rect (rects collide on default 100%). */
  private readonly panes = new Map<string, PaneState>();
  private readonly names = new Map<string, string>();
  private generation = 0;
  private disposed = false;
  tabName = '';
  connected = false;

  constructor(
    readonly tabId: string,
    private readonly canvas: HTMLCanvasElement,
    private readonly onDirty: () => void,
  ) {}

  /**
   * Topology /status names are fallbacks only. Sidecar v0.17.9+ layout.name
   * is the stable codename and must never be shadowed by OSC title.
   */
  rememberNames(panes: Array<{
    paneId: string;
    name?: string;
    title?: string;
    state?: string;
    bspX?: number;
    bspY?: number;
    bspW?: number;
    bspH?: number;
  }>): void {
    let changed = false;
    for (const pane of panes) {
      const stableName = (pane.name || '').trim();
      const title = (pane.title || '').trim();
      if (stableName && this.names.get(pane.paneId) !== stableName) {
        this.names.set(pane.paneId, stableName);
        changed = true;
      } else if (!stableName && title && !this.names.has(pane.paneId)) {
        this.names.set(pane.paneId, title);
        changed = true;
      }
      const live = this.panes.get(pane.paneId);
      if (live) {
        if (!live.layout.namedFromLayout) {
          const fallback = stableName || this.names.get(pane.paneId) || '';
          if (fallback && live.layout.name !== fallback && (stableName || isPlaceholderName(live.layout.name, live.layout.paneId))) {
            live.layout.name = fallback;
            if (!live.layout.colorFromLayout) live.layout.color = colorFromName(fallback);
            changed = true;
          }
        }
        if (title && live.layout.title !== title) {
          live.layout.title = title;
          changed = true;
        }
        if (pane.state === 'idle' || pane.state === 'running') {
          const state = paneRunState(pane.state);
          if (live.layout.state !== state) {
            live.layout.state = state;
            changed = true;
          }
        }
      }
    }
    if (changed) this.onDirty();
  }

  connect(): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.socket?.close();
    const url = hyperiaWsUrl(
      `/ws/tab/${encodeURIComponent(this.tabId)}?fps=12&w=${this.canvas.width}&h=${this.canvas.height}`,
    );
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (generation !== this.generation) return;
      this.connected = true;
      console.info('tab-stream-open', { tabId: this.tabId, generation });
      this.onDirty();
    });
    socket.addEventListener('message', event => {
      if (generation !== this.generation || typeof event.data !== 'string') return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      this.handle(socket, message);
    });
    socket.addEventListener('error', () => {
      if (generation === this.generation) console.warn('tab-stream-error', { tabId: this.tabId, generation });
    });
    socket.addEventListener('close', event => {
      if (generation !== this.generation) return;
      this.connected = false;
      console.info('tab-stream-close', { tabId: this.tabId, generation, code: event.code, reason: event.reason });
      this.onDirty();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.socket?.close();
    this.socket = undefined;
    for (const pane of this.panes.values()) pane.bitmap?.close();
    this.panes.clear();
  }

  sendKeys(paneId: string, keys: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ t: 'input', paneId, keys }));
  }

  private handle(socket: WebSocket, message: Record<string, unknown>): void {
    const type = String(message.t ?? '');
    if (type === 'ping') { socket.send(JSON.stringify({ t: 'pong' })); return; }

    if (type === 'hello') {
      this.connected = true;
      console.info('tab-stream-hello', { tabId: this.tabId, mode: message.mode, serverVersion: message.serverVersion });
      this.onDirty();
      return;
    }

    if (type === 'tab-layout') {
      this.applyManifest(message);
      return;
    }

    if (type === 'frame' || type === 'delta' || type === 'resize') {
      this.applyTerminalFrame(message);
      return;
    }

    if (type === 'state' && typeof message.paneId === 'string') {
      const pane = this.panes.get(message.paneId);
      if (pane) {
        pane.layout.state = paneRunState(message.state);
        if (typeof message.title === 'string') pane.layout.title = message.title;
        if (typeof message.name === 'string' && message.name.trim()) {
          pane.layout.name = message.name.trim();
          pane.layout.namedFromLayout = true;
          if (!pane.layout.colorFromLayout) pane.layout.color = colorFromName(pane.layout.name);
        }
        if (message.focused === true || message.focused === false) pane.layout.focused = message.focused === true;
        this.onDirty();
      }
      return;
    }

    if (type === 'pixels' && typeof message.paneId === 'string' && typeof message.jpeg === 'string') {
      this.applyPixels(message.paneId, message.jpeg);
    }
  }

  private applyManifest(message: Record<string, unknown>): void {
    if (typeof message.tabName === 'string') this.tabName = message.tabName;
    const raw = message.panes ?? message.layout;
    const layouts = (Array.isArray(raw) ? raw : []).map(parseLayoutPane).filter((pane): pane is TabPaneLayout => !!pane);
    const tiles = packTabTiles(layouts);
    console.info('tab-stream-layout', {
      tabId: this.tabId,
      tabName: this.tabName,
      paneCount: layouts.length,
      tiles: tiles.map(pane => pane.name || pane.title || pane.paneId.slice(0, 8)),
      panes: layouts.map(pane => ({
        paneId: pane.paneId,
        type: pane.type,
        name: pane.name,
        title: pane.title,
        namedFromLayout: pane.namedFromLayout,
        state: pane.state,
        x: pane.x, y: pane.y, w: pane.w, h: pane.h,
        cols: pane.cols, rows: pane.rows,
      })),
    });
    if (!layouts.length) return;
    // Identity is paneId. Two panes can share 0,0,100,100 until sidecar 0.17.10.
    const seen = new Set<string>();
    for (const layout of tiles) {
      // 0.17.9+ layout.name is the stable codename. Until then it is absent
      // and we fall back to title, then topology /status names.
      const known = this.names.get(layout.paneId);
      if (!layout.namedFromLayout && known) {
        layout.name = known;
        if (!layout.colorFromLayout) layout.color = colorFromName(known);
      }
      seen.add(layout.paneId);
      const existing = this.panes.get(layout.paneId);
      if (existing) {
        if (!layout.namedFromLayout && existing.layout.namedFromLayout) {
          layout.name = existing.layout.name;
          layout.namedFromLayout = true;
          if (!layout.colorFromLayout) layout.color = existing.layout.color;
        }
        if (!layout.title && existing.layout.title) layout.title = existing.layout.title;
        existing.layout = layout;
        if (layout.cols !== existing.cols || layout.rows !== existing.rows) {
          existing.cols = layout.cols;
          existing.rows = layout.rows;
          existing.grid = blankGrid(layout.cols, layout.rows);
        }
        continue;
      }
      this.panes.set(layout.paneId, {
        layout,
        cols: layout.cols,
        rows: layout.rows,
        grid: blankGrid(layout.cols, layout.rows),
        cursor: { x: 0, y: 0, visible: false },
        hasFrame: false,
      });
    }
    for (const [paneId, pane] of this.panes) {
      if (seen.has(paneId)) continue;
      pane.bitmap?.close();
      this.panes.delete(paneId);
    }
    this.onDirty();
  }

  private applyTerminalFrame(message: Record<string, unknown>): void {
    const paneId = typeof message.paneId === 'string' ? message.paneId : undefined;
    if (!paneId) return;
    const pane = this.panes.get(paneId);
    if (!pane) {
      console.warn('tab-stream-frame-no-pane', { tabId: this.tabId, paneId, t: message.t, known: [...this.panes.keys()] });
      return;
    }
    const type = String(message.t ?? '');
    if (type === 'resize') {
      pane.cols = Math.max(1, asNumber(message.cols, pane.cols));
      pane.rows = Math.max(1, asNumber(message.rows, pane.rows));
      pane.grid = blankGrid(pane.cols, pane.rows);
      pane.hasFrame = true;
      this.onDirty();
      return;
    }
    const cols = asNumber(message.cols, pane.cols);
    const rows = asNumber(message.rows, pane.rows);
    if (type === 'frame' && (cols !== pane.cols || rows !== pane.rows)) {
      pane.cols = Math.max(1, cols);
      pane.rows = Math.max(1, rows);
      pane.grid = blankGrid(pane.cols, pane.rows);
    }
    const rowsData = normalizeGridRows(message.rows_data);
    for (const row of rowsData) {
      if (row.y < 0 || row.y >= pane.rows) continue;
      const next = Array.from({ length: pane.cols }, blankCell);
      row.cells.slice(0, pane.cols).forEach((cell, x) => { next[x] = cell; });
      pane.grid[row.y] = next;
    }
    const cursor = message.cursor as PaneState['cursor'] | undefined;
    if (cursor) pane.cursor = cursor;
    pane.hasFrame = true;
    if (type === 'frame') {
      const nonempty = rowsData.reduce((count, row) => count + row.cells.filter(cell => cell[0]).length, 0);
      console.info('tab-stream-keyframe', {
        tabId: this.tabId,
        paneId,
        cols: pane.cols,
        rows: pane.rows,
        rowPackets: rowsData.length,
        nonemptyCells: nonempty,
      });
    }
    this.onDirty();
  }

  private applyPixels(paneId: string, jpeg: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) {
      console.warn('tab-stream-pixels-no-pane', { tabId: this.tabId, paneId });
      return;
    }
    const bytes = Uint8Array.from(atob(jpeg), character => character.charCodeAt(0));
    void createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then(bitmap => {
      if (this.disposed || !this.panes.has(paneId)) { bitmap.close(); return; }
      pane.bitmap?.close();
      pane.bitmap = bitmap;
      pane.hasFrame = true;
      this.onDirty();
    }).catch(() => { /* drop a bad jpeg */ });
  }

  paint(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, width, height);

    if (!this.panes.size) {
      ctx.fillStyle = '#4e91a9';
      ctx.font = `600 ${Math.max(14, Math.round(height * .045))}px "Cascadia Mono", "Segoe UI Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.connected ? `TAB ${this.tabName || this.tabId.slice(0, 8)}` : 'CONNECTING TAB…', width / 2, height / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      return;
    }

    const byId = new Map([...this.panes.values()].map(pane => [pane.layout.paneId, pane]));
    const tiles = packTabTiles([...this.panes.values()].map(pane => pane.layout))
      .sort((a, b) => rectArea(b) - rectArea(a));
    for (const tile of tiles) {
      const pane = byId.get(tile.paneId);
      if (!pane) continue;
      const x = tile.x / 100 * width;
      const y = tile.y / 100 * height;
      const w = Math.max(1, tile.w / 100 * width);
      const h = Math.max(1, tile.h / 100 * height);
      const headerH = Math.max(24, Math.min(40, Math.round(h * 0.16)));
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      this.paintHeader(ctx, pane, x, y, w, headerH);
      ctx.globalAlpha = pane.layout.state === 'idle' ? 0.72 : 1;
      if (pane.layout.type === 'web') this.paintWeb(ctx, pane, x, y + headerH, w, Math.max(1, h - headerH));
      else this.paintTerminal(ctx, pane, x, y + headerH, w, Math.max(1, h - headerH));
      ctx.globalAlpha = 1;
      ctx.restore();
      const glow = pane.layout.state === 'running' || pane.layout.focused;
      ctx.strokeStyle = glow ? pane.layout.color : '#1a2a32';
      ctx.lineWidth = pane.layout.focused ? 2 : glow ? 1.5 : 1;
      ctx.globalAlpha = pane.layout.state === 'idle' ? 0.45 : 1;
      ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
      ctx.globalAlpha = 1;
    }
  }

  private paintHeader(
    ctx: CanvasRenderingContext2D,
    pane: PaneState,
    x: number,
    y: number,
    w: number,
    headerH: number,
  ): void {
    const accent = pane.layout.color;
    const name = pane.layout.name || this.names.get(pane.layout.paneId) || pane.layout.paneId.slice(0, 8);
    const title = pane.layout.title && pane.layout.title !== name ? pane.layout.title : '';
    ctx.fillStyle = pane.layout.state === 'idle' ? '#07090c' : '#0a1016';
    ctx.fillRect(x, y, w, headerH);
    ctx.fillStyle = accent;
    ctx.globalAlpha = pane.layout.state === 'idle' ? 0.45 : 1;
    ctx.fillRect(x, y, w, Math.max(2, Math.round(headerH * 0.12)));
    ctx.fillRect(x, y, Math.max(4, Math.round(headerH * 0.18)), headerH);
    ctx.globalAlpha = 1;
    const fontSize = Math.max(13, Math.min(20, Math.round(headerH * (title ? 0.42 : 0.58))));
    ctx.font = `700 ${fontSize}px "Cascadia Mono", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = pane.layout.focused ? '#ffffff' : accent;
    const textX = x + headerH * 0.5;
    const maxW = Math.max(8, w - headerH * 0.7);
    if (title) {
      ctx.fillText(name, textX, y + headerH * 0.38, maxW);
      ctx.font = `500 ${Math.max(9, fontSize - 2)}px "Cascadia Mono", "Segoe UI Emoji", sans-serif`;
      ctx.fillStyle = '#8aa4b0';
      ctx.fillText(title, textX, y + headerH * 0.72, maxW);
    } else {
      ctx.fillText(name, textX, y + headerH * 0.58, maxW);
    }
  }

  private paintWeb(ctx: CanvasRenderingContext2D, pane: PaneState, x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = '#080d13';
    ctx.fillRect(x, y, w, h);
    if (!pane.bitmap) return;
    const scale = Math.min(w / pane.bitmap.width, h / pane.bitmap.height);
    const dw = pane.bitmap.width * scale;
    const dh = pane.bitmap.height * scale;
    ctx.drawImage(pane.bitmap, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  private paintTerminal(ctx: CanvasRenderingContext2D, pane: PaneState, x: number, y: number, w: number, h: number): void {
    // Empty keyframe = empty terminal. Always paint the surface; never a
    // "no data" card. Cells stay blank until the mirror emits something.
    ctx.fillStyle = '#070a0f';
    ctx.fillRect(x, y, w, h);
    const cellH = Math.min(h / pane.rows, w / (pane.cols * .6));
    const cellW = cellH * .6;
    const originX = x + (w - cellW * pane.cols) / 2;
    // Top-align under the header. A 12-row pane in 69% of the glass (Husky
    // Prawn) letterboxed vertically reads as an empty black tile from across
    // the room.
    const originY = y + Math.min(6, h * 0.02);
    const fontSize = Math.max(4, Math.floor(cellH * .86));
    ctx.font = `${fontSize}px "Cascadia Mono", Consolas, monospace`;
    ctx.textBaseline = 'top';
    for (let row = 0; row < pane.rows; row++) {
      const line = pane.grid[row];
      if (!line) continue;
      for (let column = 0; column < pane.cols; column++) {
        const cell = line[column];
        if (!cell) continue;
        const [character, foreground, background, attributes] = cell;
        let fg = cssColor(foreground, '#d7e2ea');
        let bg = cssColor(background, '#070a0f');
        if (attributes & ATTR.INVERSE) { const swap = fg; fg = bg; bg = swap; }
        const px = originX + column * cellW;
        const py = originY + row * cellH;
        if (bg !== '#070a0f') {
          ctx.fillStyle = bg;
          ctx.fillRect(px, py, cellW + 1, cellH + 1);
        }
        if (!character) continue;
        ctx.globalAlpha = attributes & ATTR.DIM ? .55 : 1;
        ctx.font = `${attributes & ATTR.ITALIC ? 'italic ' : ''}${attributes & ATTR.BOLD ? '700 ' : '500 '}${fontSize}px "Cascadia Mono", "Segoe UI Emoji", sans-serif`;
        ctx.fillStyle = fg;
        ctx.fillText(character, px, py);
        if (attributes & ATTR.UNDERLINE) ctx.fillRect(px, py + cellH * 0.88, cellW, Math.max(1, cellH * 0.07));
        if (attributes & ATTR.STRIKE) ctx.fillRect(px, py + cellH * 0.48, cellW, Math.max(1, cellH * 0.06));
        ctx.globalAlpha = 1;
      }
    }
    if (pane.cursor.visible && pane.cursor.x < pane.cols && pane.cursor.y < pane.rows) {
      ctx.fillStyle = 'rgba(220,245,255,.8)';
      ctx.fillRect(originX + pane.cursor.x * cellW, originY + (pane.cursor.y + .88) * cellH, cellW, Math.max(1, cellH * .08));
    }
    ctx.textBaseline = 'alphabetic';
  }
}
