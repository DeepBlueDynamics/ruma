import { Terminal } from '@xterm/xterm';
import { cssColor, wallRowPayload, type Cell, type Color, type Cursor, type GridRow, type WallMessage } from '../hyperia/protocol';
import { hyperiaWsUrl, openContentSocket, type StreamSession } from '../hyperia/stream';
import type { TerminalDefinition } from '../terminal/catalog';
import type { DisplaySurface } from './surface';

export type VideoWallPane = {
  paneId: string;
  name?: string;
  title: string;
  cols: number;
  rows: number;
  state: string;
  app?: string;
  shell?: string;
  cwd?: string;
  active?: boolean;
};

export type VideoWallPaneRegion = {
  kind: 'pane';
  paneId: string;
  title: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type VideoWallTerminalRegion = {
  kind: 'terminal';
  terminalId: string;
  title: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type VideoWallContentRegion = VideoWallPaneRegion | VideoWallTerminalRegion;

export type VideoWallTabGroup = {
  tabId: string;
  name: string;
  panes: VideoWallPane[];
};

export type VideoWallRouterRegion = {
  kind: 'router-terminal' | 'router-tab' | 'router-pane' | 'router-scroll-up' | 'router-scroll-down' | 'router-close';
  sectionIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  terminalId?: string;
  tabId?: string;
  paneId?: string;
};

export type VideoWallResetRegion = {
  kind: 'reset';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type VideoWallRegion = VideoWallContentRegion | VideoWallResetRegion | VideoWallRouterRegion;

type SectionSource =
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'pane'; paneId: string };

type RouterState = {
  sectionIndex: number;
  expandedTabId: string;
  scroll: number;
};

type PaneView = VideoWallPane & {
  cursor: Cursor;
  grid: Cell[][];
  hasFrame: boolean;
  webCanvas?: HTMLCanvasElement;
  webSocket?: WebSocket;
  webStreamKey?: string;
  webFrame: number;
  ptyTerminal?: Terminal;
  ptyLive?: boolean;
  webLive?: boolean;
  streamSession?: StreamSession;
};

function blankCell(): Cell { return ['', 'default', 'default', 0]; }

function blankGrid(cols: number, rows: number): Cell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, blankCell));
}

function numericColor(value: number, rgb: boolean, fallback: string): string {
  if (rgb) return `#${value.toString(16).padStart(6, '0')}`;
  return cssColor(`idx:${value}` as Color, fallback);
}

function paneLabel(pane: { name?: string; title?: string; paneId: string }): string {
  return (pane.name || pane.title || pane.paneId.slice(0, 8)).trim();
}

function isSelfPane(pane: VideoWallPane): boolean {
  return pane.shell === 'web' && /operations command room/i.test(`${pane.name ?? ''} ${pane.title}`);
}

function applyRows(view: { cols: number; rows: number; grid: Cell[][] }, changes: GridRow[]): void {
  for (const row of changes) {
    if (row.y < 0 || row.y >= view.rows) continue;
    const next = Array.from({ length: view.cols }, blankCell);
    row.cells.slice(0, view.cols).forEach((cell, x) => { next[x] = cell; });
    view.grid[row.y] = next;
  }
}

type CachedFrame = {
  cols: number;
  rows: number;
  cursor: Cursor;
  grid: Cell[][];
  hasFrame: boolean;
};

function emptyCache(cols = 80, rows = 24): CachedFrame {
  return {
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
    cursor: { x: 0, y: 0, visible: false },
    grid: blankGrid(Math.max(1, cols), Math.max(1, rows)),
    hasFrame: false,
  };
}

function truncate(ctx: CanvasRenderingContext2D, value: string, width: number): string {
  if (ctx.measureText(value).width <= width) return value;
  let end = value.length;
  while (end > 1 && ctx.measureText(`${value.slice(0, end)}…`).width > width) end--;
  return `${value.slice(0, end)}…`;
}

/**
 * Presentation wall (the big screen). Selected Hyperia panes get a dedicated
 * stream: PTY → `/ws/pane/{id}` (binary seed + live bytes into xterm), web →
 * `/ws/pixels/{id}`. `/ws/wall` is the many-tiny-monitors overview path and is
 * not used to paint this surface.
 */
export class VideoWallController {
  private static readonly sectionStorageKey = 'ops-room/room-display-2/sections-v1';
  private surface?: DisplaySurface;
  private readonly terminals = new Map<string, { terminal: TerminalDefinition; image: HTMLImageElement }>();
  private readonly sectionSources: Array<SectionSource | undefined>;
  private readonly views = new Map<string, PaneView>();
  /** Last wall raster per pane, kept even when the section is not showing it. */
  private readonly frameCache = new Map<string, CachedFrame>();
  private resyncHandler?: () => void;
  private lastResyncAt = 0;
  private availablePanes: VideoWallPane[] = [];
  private tabs: VideoWallTabGroup[] = [];
  private order: string[] = [];
  private regions: VideoWallRegion[] = [];
  private resetRegion?: VideoWallResetRegion;
  private focusedPaneId?: string;
  private router?: RouterState;
  private renderQueued = false;

  constructor() {
    this.sectionSources = this.restoreSectionSources();
  }

  attachSurface(surface: DisplaySurface): void {
    this.surface = surface;
    this.scheduleRender();
  }

  /** Ask the shared `/ws/wall` socket for a fresh keyframe (throttled). */
  setResyncHandler(handler: () => void): void {
    this.resyncHandler = handler;
  }

  private askResync(): void {
    const now = performance.now();
    if (now - this.lastResyncAt < 1500) return;
    this.lastResyncAt = now;
    this.resyncHandler?.();
  }

  private cacheFor(paneId: string, cols = 80, rows = 24): CachedFrame {
    let cache = this.frameCache.get(paneId);
    if (!cache) {
      cache = emptyCache(cols, rows);
      this.frameCache.set(paneId, cache);
    }
    return cache;
  }

  private applyCache(view: PaneView, cache: CachedFrame): void {
    view.cols = cache.cols;
    view.rows = cache.rows;
    view.cursor = cache.cursor;
    view.grid = cache.grid;
    view.hasFrame = cache.hasFrame;
  }

  setTerminalCatalog(terminals: readonly TerminalDefinition[]): void {
    for (const terminal of terminals) this.registerTerminal(terminal);
    this.scheduleRender();
  }

  setTabGroups(tabs: VideoWallTabGroup[]): void {
    this.tabs = tabs.map(tab => ({ ...tab, panes: [...tab.panes] }));
    if (this.router && !this.tabs.some(tab => tab.tabId === this.router!.expandedTabId)) {
      this.router.expandedTabId = '';
      this.router.scroll = 0;
    }
    this.scheduleRender();
  }

  setSectionTerminal(sectionIndex: number, terminal: TerminalDefinition): void {
    if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex > 2) {
      throw new RangeError(`Room-display section index ${sectionIndex} is outside 0..2`);
    }
    this.registerTerminal(terminal);
    // Calls during startup establish defaults only. A persisted user choice is
    // authoritative and must survive reloads.
    if (this.sectionSources[sectionIndex]) return;
    this.sectionSources[sectionIndex] = { kind: 'terminal', terminalId: terminal.id };
    this.rebuildViews();
    this.scheduleRender();
  }

  openSectionRouter(sectionIndex: number): void {
    if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex > 2) return;
    this.router = { sectionIndex, expandedTabId: '', scroll: 0 };
    this.scheduleRender();
  }

  isRouterOpen(): boolean { return !!this.router; }

  sectionIndexAt(x: number, y: number): number | undefined {
    const metrics = this.sectionMetrics();
    if (!metrics) return;
    const { outer, gap, sectionWidth, sectionHeight } = metrics;
    if (y < outer || y > outer + sectionHeight) return;
    for (let section = 0; section < 4; section++) {
      const start = outer + section * (sectionWidth + gap);
      if (x >= start && x <= start + sectionWidth) return section;
    }
  }

  activateRouterRegion(region: VideoWallRouterRegion): void {
    if (!this.router || region.sectionIndex !== this.router.sectionIndex) return;
    if (region.kind === 'router-close') {
      this.router = undefined;
    } else if (region.kind === 'router-tab' && region.tabId) {
      this.router.expandedTabId = this.router.expandedTabId === region.tabId ? '' : region.tabId;
      this.router.scroll = 0;
    } else if (region.kind === 'router-scroll-up') {
      this.router.scroll = Math.max(0, this.router.scroll - 1);
    } else if (region.kind === 'router-scroll-down') {
      this.router.scroll++;
    } else if (region.kind === 'router-terminal' && region.terminalId && this.terminals.has(region.terminalId)) {
      this.sectionSources[region.sectionIndex] = { kind: 'terminal', terminalId: region.terminalId };
      this.persistSectionSources();
      console.info('main-screen-source-assigned', { sectionIndex: region.sectionIndex + 1, kind: 'terminal', sourceId: region.terminalId });
      this.router = undefined;
      this.rebuildViews();
    } else if (region.kind === 'router-pane' && region.paneId) {
      this.sectionSources[region.sectionIndex] = { kind: 'pane', paneId: region.paneId };
      this.persistSectionSources();
      console.info('main-screen-source-assigned', { sectionIndex: region.sectionIndex + 1, kind: 'pane', sourceId: region.paneId });
      this.router = undefined;
      this.rebuildViews();
    }
    this.scheduleRender();
  }

  private registerTerminal(terminal: TerminalDefinition): void {
    if (this.terminals.has(terminal.id)) return;
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener('load', () => this.scheduleRender());
    image.src = terminal.adapter.asset;
    this.terminals.set(terminal.id, { terminal, image });
  }

  setPanes(panes: VideoWallPane[]): void {
    this.availablePanes = panes.filter(pane => paneLabel(pane) && !isSelfPane(pane));
    this.rebuildViews();
  }

  private rebuildViews(): void {
    // Explicit section assignments win. Any still-unconfigured section may use
    // the next discovered pane as its live default, without persisting that
    // incidental discovery order as user configuration.
    const explicit = this.sectionSources
      .filter((source): source is Extract<SectionSource, { kind: 'pane' }> => source?.kind === 'pane')
      .map(source => source.paneId);
    const fallback = this.availablePanes
      .map(pane => pane.paneId)
      .filter(paneId => !explicit.includes(paneId));
    const visibleIds: string[] = [];
    let fallbackIndex = 0;
    for (let section = 0; section < 4; section++) {
      const source = this.sectionSources[section];
      if (source?.kind === 'pane') visibleIds.push(source.paneId);
      else if (!source) {
        const paneId = fallback[fallbackIndex++];
        if (paneId) visibleIds.push(paneId);
      }
    }
    const present = new Set(visibleIds);
    for (const [paneId, view] of this.views) {
      if (present.has(paneId)) continue;
      this.releasePaneStream(view);
      this.views.delete(paneId);
      if (this.focusedPaneId === paneId) this.focusedPaneId = undefined;
    }

    for (const paneId of visibleIds) {
      const pane = this.availablePanes.find(candidate => candidate.paneId === paneId);
      const cols = Math.max(1, pane?.cols || 120);
      const rows = Math.max(1, pane?.rows || 40);
      let view = this.views.get(paneId);
      if (!view) {
        view = {
          paneId,
          name: pane?.name,
          title: pane?.title ?? paneId.slice(0, 8),
          cols,
          rows,
          state: pane?.state ?? 'running',
          app: pane?.app,
          shell: pane?.shell,
          cwd: pane?.cwd,
          active: pane?.active,
          cursor: { x: 0, y: 0, visible: false },
          grid: blankGrid(cols, rows),
          hasFrame: false,
          webFrame: 0,
        };
        this.views.set(paneId, view);
      } else if (pane) {
        view.name = pane.name;
        view.title = pane.title;
        view.state = pane.state;
        view.app = pane.app;
        view.shell = pane.shell;
        view.cwd = pane.cwd;
        view.active = pane.active;
      }
      this.syncPaneStream(view);
    }

    this.order = visibleIds;
    this.scheduleRender();
  }

  handleMessage(message: WallMessage): void {
    if (message.t === 'resync') {
      // Keep the last raster up. Keyframes that follow replace it in place.
      // Clearing hasFrame here is what made the wall go dark until the next
      // keystroke produced a delta.
      return;
    }
    if (message.t === 'topo' && message.op === 'remove') {
      const view = this.views.get(message.paneId);
      if (view) this.releasePaneStream(view);
      this.views.delete(message.paneId);
      this.frameCache.delete(message.paneId);
      this.order = this.order.filter(id => id !== message.paneId);
      if (this.focusedPaneId === message.paneId) this.focusedPaneId = undefined;
      this.scheduleRender();
      return;
    }

    const paneId = 'paneId' in message ? message.paneId : undefined;
    if (!paneId) return;
    const existed = this.frameCache.has(paneId);
    const cache = this.cacheFor(
      paneId,
      message.t === 'frame' || message.t === 'resize' ? message.cols : 80,
      message.t === 'frame' || message.t === 'resize' ? message.rows : 24,
    );

    if (message.t === 'frame') {
      if (message.cols !== cache.cols || message.rows !== cache.rows) {
        cache.cols = message.cols;
        cache.rows = message.rows;
        cache.grid = blankGrid(cache.cols, cache.rows);
      }
      applyRows(cache, wallRowPayload(message));
      cache.cursor = message.cursor;
      cache.hasFrame = true;
    } else if (message.t === 'delta') {
      applyRows(cache, wallRowPayload(message));
      cache.cursor = message.cursor;
      cache.hasFrame = true;
      if (!existed) this.askResync();
    } else if (message.t === 'resize') {
      cache.cols = Math.max(1, message.cols);
      cache.rows = Math.max(1, message.rows);
      cache.grid = blankGrid(cache.cols, cache.rows);
      cache.hasFrame = false;
    } else if (message.t === 'state') {
      const view = this.views.get(paneId);
      if (view) {
        view.state = message.state;
        view.app = message.app;
        view.cwd = message.cwd;
        this.scheduleRender();
      }
      return;
    } else {
      return;
    }

    const view = this.views.get(paneId);
    if (view) this.applyCache(view, cache);
    this.scheduleRender();
  }

  hitTest(x: number, y: number): VideoWallRegion | undefined {
    if (this.resetRegion && x >= this.resetRegion.x0 && x <= this.resetRegion.x1 && y >= this.resetRegion.y0 && y <= this.resetRegion.y1) return this.resetRegion;
    return this.regions.find(region => x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1);
  }

  regionForPane(paneId: string): VideoWallPaneRegion | undefined {
    const region = this.regions.find(candidate => candidate.kind === 'pane' && candidate.paneId === paneId);
    return region?.kind === 'pane' ? region : undefined;
  }

  setFocusedPane(paneId?: string): void {
    if (this.focusedPaneId === paneId) return;
    this.focusedPaneId = paneId;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    if (!this.surface) return;
    const { canvas, texture } = this.surface;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#010407';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const metrics = this.sectionMetrics()!;
    const { outer, gap, sectionWidth, sectionHeight } = metrics;
    const header = Math.max(26, Math.min(48, Math.round(sectionHeight * .065)));
    this.regions = [];
    let paneIndex = 0;

    for (let section = 0; section < 4; section++) {
      const x = outer + section * (sectionWidth + gap);
      const y = outer;
      const source = this.sectionSources[section];
      const paneId = source?.kind === 'pane'
        ? this.order[paneIndex++]
        : source ? undefined : this.order[paneIndex++];
      if (this.router?.sectionIndex === section) {
        this.drawRouter(ctx, { x, y, width: sectionWidth, height: sectionHeight }, this.router);
        continue;
      }
      const terminalSection = source?.kind === 'terminal' ? this.terminals.get(source.terminalId) : undefined;
      ctx.fillStyle = '#040a0f';
      ctx.fillRect(x, y, sectionWidth, sectionHeight);
      ctx.strokeStyle = terminalSection ? '#305b37' : '#183541';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, sectionWidth - 2, sectionHeight - 2);

      if (terminalSection) {
        if (terminalSection.image.complete && terminalSection.image.naturalWidth) {
          const inset = Math.max(3, outer * .45);
          this.drawImageContained(ctx, terminalSection.image, {
            x: x + inset,
            y: y + inset,
            width: sectionWidth - inset * 2,
            height: sectionHeight - inset * 2,
          });
        } else {
          ctx.fillStyle = '#a7d79a';
          ctx.font = `500 ${Math.max(14, Math.round(header * .45))}px "Cascadia Mono", Consolas, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`LOADING ${terminalSection.terminal.label}`, x + sectionWidth / 2, y + sectionHeight / 2);
        }
        this.regions.push({
          kind: 'terminal',
          terminalId: terminalSection.terminal.id,
          title: terminalSection.terminal.label,
          x0: x,
          y0: y,
          x1: x + sectionWidth,
          y1: y + sectionHeight,
        });
        continue;
      }

      const view = paneId ? this.views.get(paneId) : undefined;
      if (!view) {
        ctx.fillStyle = '#536d77';
        ctx.font = `500 ${Math.max(14, Math.round(header * .45))}px "Cascadia Mono", Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(source?.kind === 'pane' ? 'SOURCE UNAVAILABLE' : 'UNASSIGNED', x + sectionWidth / 2, y + sectionHeight / 2);
        if (source?.kind === 'pane') this.regions.push({
          kind: 'pane',
          paneId: source.paneId,
          title: source.paneId,
          x0: x,
          y0: y,
          x1: x + sectionWidth,
          y1: y + sectionHeight,
        });
        continue;
      }

      const focused = view.paneId === this.focusedPaneId;
      ctx.strokeStyle = focused ? '#f4fbff' : view.active ? '#42dcff' : '#183541';
      ctx.lineWidth = focused ? 4 : 2;
      ctx.strokeRect(x + 1, y + 1, sectionWidth - 2, sectionHeight - 2);
      ctx.fillStyle = focused ? '#12303c' : '#08151d';
      ctx.fillRect(x + 2, y + 2, sectionWidth - 4, header);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.max(12, Math.round(header * .46))}px "Cascadia Mono", Consolas, monospace`;
      ctx.fillStyle = focused ? '#ffffff' : '#bfeaf5';
      ctx.fillText(truncate(ctx, paneLabel(view), sectionWidth - header * 1.8), x + header * .35, y + header * .54);
      ctx.fillStyle = view.state === 'running' ? '#3ce49a' : view.state === 'busy' ? '#ffb454' : '#6d8791';
      ctx.beginPath();
      ctx.arc(x + sectionWidth - header * .48, y + header * .54, Math.max(3, header * .09), 0, Math.PI * 2);
      ctx.fill();

      const content = {
        x: x + 4,
        y: y + header + 4,
        width: sectionWidth - 8,
        height: sectionHeight - header - 8,
      };
      const live = view.shell === 'web' ? view.webLive === true : view.ptyLive === true;
      if (live && view.webCanvas?.width) this.drawWebPane(ctx, view.webCanvas, content);
      else {
        ctx.fillStyle = '#070a0f';
        ctx.fillRect(content.x, content.y, content.width, content.height);
        ctx.fillStyle = '#4e91a9';
        ctx.font = `500 ${Math.max(14, Math.round(header * .42))}px "Cascadia Mono", Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(view.shell === 'web' ? 'CONNECTING PIXELS' : 'CONNECTING PANE', content.x + content.width / 2, content.y + content.height / 2);
      }
      this.regions.push({ kind: 'pane', paneId: view.paneId, title: paneLabel(view), x0: x, y0: y, x1: x + sectionWidth, y1: y + sectionHeight });
    }

    // Keep the requested room-reset capability on the physical display, but
    // make it a small overlay inside the right section instead of a global UI.
    if (this.router) {
      this.resetRegion = undefined;
      texture.needsUpdate = true;
      return;
    }
    const resetWidth = Math.max(110, Math.round(sectionWidth * .18));
    const resetHeight = Math.max(30, Math.round(header * .72));
    const resetX = canvas.width - outer - resetWidth - 8;
    const resetY = outer + 8;
    this.resetRegion = { kind: 'reset', x0: resetX, y0: resetY, x1: resetX + resetWidth, y1: resetY + resetHeight };
    ctx.fillStyle = '#18070a';
    ctx.fillRect(resetX, resetY, resetWidth, resetHeight);
    ctx.strokeStyle = '#a83240';
    ctx.lineWidth = 2;
    ctx.strokeRect(resetX + 1, resetY + 1, resetWidth - 2, resetHeight - 2);
    ctx.fillStyle = '#ff9ca5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.max(11, Math.round(resetHeight * .4))}px "Cascadia Mono", Consolas, monospace`;
    ctx.fillText('RESET', resetX + resetWidth / 2, resetY + resetHeight / 2);

    texture.needsUpdate = true;
  }

  private drawRouter(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; width: number; height: number },
    router: RouterState,
  ): void {
    const scale = rect.height / 900;
    const pad = Math.max(16, 28 * scale);
    const titleHeight = Math.max(72, 92 * scale);
    const railWidth = Math.max(76, 92 * scale);
    const rowHeight = Math.max(48, 62 * scale);
    const rowGap = Math.max(5, 8 * scale);
    const listTop = rect.y + titleHeight + pad * .45;
    const listBottom = rect.y + rect.height - pad;
    const listHeight = listBottom - listTop;
    const visibleRows = Math.max(3, Math.floor((listHeight + rowGap) / (rowHeight + rowGap)));
    const listWidth = rect.width - pad * 2 - railWidth - pad * .45;
    const active = this.sectionSources[router.sectionIndex];
    const rows: Array<
      | { kind: 'terminal'; terminal: TerminalDefinition }
      | { kind: 'tab'; tab: VideoWallTabGroup }
      | { kind: 'pane'; pane: VideoWallPane }
    > = [...this.terminals.values()].map(entry => ({ kind: 'terminal' as const, terminal: entry.terminal }));
    for (const tab of this.tabs) {
      const visiblePanes = tab.panes.filter(pane => !isSelfPane(pane));
      if (!visiblePanes.length) continue;
      rows.push({ kind: 'tab', tab: { ...tab, panes: visiblePanes } });
      if (router.expandedTabId === tab.tabId) visiblePanes.forEach(pane => rows.push({ kind: 'pane', pane }));
    }
    const maxScroll = Math.max(0, rows.length - visibleRows);
    router.scroll = Math.max(0, Math.min(router.scroll, maxScroll));

    const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height);
    gradient.addColorStop(0, '#031c26');
    gradient.addColorStop(1, '#020c12');
    ctx.fillStyle = gradient;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = '#40dcff';
    ctx.lineWidth = Math.max(2, 4 * scale);
    ctx.strokeRect(rect.x + 3, rect.y + 3, rect.width - 6, rect.height - 6);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5f98b3';
    ctx.font = `500 ${Math.max(17, Math.round(27 * scale))}px "Cascadia Mono", Consolas, monospace`;
    ctx.fillText(`PANE PICKER · SECTION ${router.sectionIndex + 1}`, rect.x + pad, rect.y + titleHeight * .35);
    ctx.fillStyle = '#bcefff';
    ctx.font = `700 ${Math.max(15, Math.round(22 * scale))}px "Cascadia Mono", Consolas, monospace`;
    const sourceLabel = active?.kind === 'terminal'
      ? this.terminals.get(active.terminalId)?.terminal.label ?? active.terminalId
      : active?.kind === 'pane'
        ? paneLabel(this.availablePanes.find(pane => pane.paneId === active.paneId) ?? { paneId: active.paneId, title: '' })
        : 'UNASSIGNED';
    ctx.fillText(truncate(ctx, `CURRENT  ${sourceLabel}`, rect.width - pad * 3 - railWidth), rect.x + pad, rect.y + titleHeight * .72);

    const closeSize = Math.max(44, 55 * scale);
    const closeX = rect.x + rect.width - pad - closeSize;
    const closeY = rect.y + pad * .55;
    ctx.fillStyle = '#092631';
    ctx.fillRect(closeX, closeY, closeSize, closeSize);
    ctx.strokeStyle = '#42c8ff';
    ctx.strokeRect(closeX, closeY, closeSize, closeSize);
    ctx.fillStyle = '#d7f8ff';
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.max(20, Math.round(27 * scale))}px "Cascadia Mono", Consolas, monospace`;
    ctx.fillText('×', closeX + closeSize / 2, closeY + closeSize / 2);
    this.regions.push({ kind: 'router-close', sectionIndex: router.sectionIndex, x0: closeX, y0: closeY, x1: closeX + closeSize, y1: closeY + closeSize });

    let y = listTop;
    for (const row of rows.slice(router.scroll, router.scroll + visibleRows)) {
      const x = rect.x + pad;
      if (row.kind === 'terminal') {
        const selected = active?.kind === 'terminal' && active.terminalId === row.terminal.id;
        ctx.fillStyle = selected ? '#123523' : '#071720';
        ctx.fillRect(x, y, listWidth, rowHeight);
        ctx.strokeStyle = selected ? '#79dc55' : '#24502e';
        ctx.strokeRect(x, y, listWidth, rowHeight);
        ctx.fillStyle = selected ? '#d9ffcb' : '#a7d79a';
        ctx.textAlign = 'left';
        ctx.font = `500 ${Math.max(15, Math.round(21 * scale))}px "Cascadia Mono", Consolas, monospace`;
        ctx.fillText(truncate(ctx, `TERMINAL  ${row.terminal.label}`, listWidth - pad), x + pad * .55, y + rowHeight / 2);
        this.regions.push({ kind: 'router-terminal', sectionIndex: router.sectionIndex, terminalId: row.terminal.id, x0: x, y0: y, x1: x + listWidth, y1: y + rowHeight });
      } else if (row.kind === 'tab') {
        const expanded = router.expandedTabId === row.tab.tabId;
        ctx.fillStyle = expanded ? '#0b4253' : '#071720';
        ctx.fillRect(x, y, listWidth, rowHeight);
        ctx.strokeStyle = expanded ? '#42dcff' : '#17475b';
        ctx.strokeRect(x, y, listWidth, rowHeight);
        ctx.fillStyle = '#bcefff';
        ctx.textAlign = 'left';
        ctx.font = `500 ${Math.max(15, Math.round(21 * scale))}px "Cascadia Mono", Consolas, monospace`;
        ctx.fillText(truncate(ctx, row.tab.name, listWidth - pad), x + pad * .55, y + rowHeight / 2);
        this.regions.push({ kind: 'router-tab', sectionIndex: router.sectionIndex, tabId: row.tab.tabId, x0: x, y0: y, x1: x + listWidth, y1: y + rowHeight });
      } else {
        const selected = active?.kind === 'pane' && active.paneId === row.pane.paneId;
        const indent = pad * .8;
        ctx.fillStyle = selected ? '#0b2534' : '#08111a';
        ctx.fillRect(x + indent, y, listWidth - indent, rowHeight);
        ctx.strokeStyle = selected ? '#42c8ff' : '#173141';
        ctx.strokeRect(x + indent, y, listWidth - indent, rowHeight);
        ctx.fillStyle = selected ? '#e6f8ff' : '#8ebbd0';
        ctx.textAlign = 'left';
        ctx.font = `500 ${Math.max(14, Math.round(19 * scale))}px "Cascadia Mono", Consolas, monospace`;
        const kind = row.pane.shell === 'web' ? 'WEB' : 'PTY';
        ctx.fillText(truncate(ctx, `${kind}  ${paneLabel(row.pane)}`, listWidth - indent - pad), x + indent + pad * .55, y + rowHeight / 2);
        this.regions.push({ kind: 'router-pane', sectionIndex: router.sectionIndex, paneId: row.pane.paneId, x0: x + indent, y0: y, x1: x + listWidth, y1: y + rowHeight });
      }
      y += rowHeight + rowGap;
    }

    const railX = rect.x + rect.width - pad - railWidth;
    const buttonHeight = Math.max(54, 66 * scale);
    const downY = listBottom - buttonHeight;
    for (const [kind, buttonY, glyph] of [
      ['router-scroll-up', listTop, '▲'],
      ['router-scroll-down', downY, '▼'],
    ] as const) {
      ctx.fillStyle = '#0b3342';
      ctx.fillRect(railX, buttonY, railWidth, buttonHeight);
      ctx.strokeStyle = '#42c8ff';
      ctx.strokeRect(railX, buttonY, railWidth, buttonHeight);
      ctx.fillStyle = '#d7f8ff';
      ctx.textAlign = 'center';
      ctx.font = `700 ${Math.max(20, Math.round(29 * scale))}px "Cascadia Mono", Consolas, monospace`;
      ctx.fillText(glyph, railX + railWidth / 2, buttonY + buttonHeight / 2);
      this.regions.push({ kind, sectionIndex: router.sectionIndex, x0: railX, y0: buttonY, x1: railX + railWidth, y1: buttonY + buttonHeight });
    }
    const trackY = listTop + buttonHeight + rowGap;
    const trackHeight = Math.max(20, downY - rowGap - trackY);
    const trackWidth = Math.max(14, railWidth * .26);
    const trackX = railX + (railWidth - trackWidth) / 2;
    ctx.fillStyle = '#06141c';
    ctx.fillRect(trackX, trackY, trackWidth, trackHeight);
    const thumbHeight = Math.max(28, trackHeight * Math.min(1, visibleRows / Math.max(visibleRows, rows.length)));
    const thumbY = trackY + (trackHeight - thumbHeight) * (maxScroll ? router.scroll / maxScroll : 0);
    ctx.fillStyle = '#2c9fbd';
    ctx.fillRect(trackX, thumbY, trackWidth, thumbHeight);
  }

  private sectionMetrics(): { outer: number; gap: number; sectionWidth: number; sectionHeight: number } | undefined {
    if (!this.surface) return;
    const { canvas } = this.surface;
    const outer = Math.max(5, Math.round(canvas.height * .009));
    const gap = outer;
    return {
      outer,
      gap,
      sectionWidth: (canvas.width - outer * 2 - gap * 3) / 4,
      sectionHeight: canvas.height - outer * 2,
    };
  }

  private restoreSectionSources(): Array<SectionSource | undefined> {
    const sources: Array<SectionSource | undefined> = [undefined, undefined, undefined, undefined];
    try {
      const parsed = JSON.parse(localStorage.getItem(VideoWallController.sectionStorageKey) ?? 'null') as unknown;
      if (!Array.isArray(parsed)) return sources;
      for (let index = 0; index < 4; index++) {
        const source = parsed[index] as Partial<SectionSource> | undefined;
        if (source?.kind === 'terminal' && typeof source.terminalId === 'string') sources[index] = { kind: 'terminal', terminalId: source.terminalId };
        else if (source?.kind === 'pane' && typeof source.paneId === 'string') sources[index] = { kind: 'pane', paneId: source.paneId };
      }
    } catch { /* Ignore malformed legacy browser state. */ }
    return sources;
  }

  private persistSectionSources(): void {
    localStorage.setItem(VideoWallController.sectionStorageKey, JSON.stringify(this.sectionSources));
  }

  private drawImageContained(
    ctx: CanvasRenderingContext2D,
    source: HTMLImageElement,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    ctx.fillStyle = '#010407';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    const scale = Math.min(rect.width / source.naturalWidth, rect.height / source.naturalHeight);
    const width = source.naturalWidth * scale;
    const height = source.naturalHeight * scale;
    ctx.drawImage(source, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
  }

  private drawWebPane(
    ctx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    ctx.fillStyle = '#070a0f';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    const scale = Math.min(rect.width / source.width, rect.height / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    ctx.drawImage(source, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
  }

  private releaseWebStream(view: PaneView): void {
    view.webSocket?.close();
    view.webSocket = undefined;
    view.webStreamKey = undefined;
  }

  private releasePaneStream(view: PaneView): void {
    if (view.streamSession) view.streamSession.powered = false;
    view.webSocket?.close();
    view.webSocket = undefined;
    view.webStreamKey = undefined;
    view.ptyTerminal?.dispose();
    view.ptyTerminal = undefined;
    view.ptyLive = false;
  }

  /** Web panes get `/ws/pixels`. PTY panes (pwsh, etc.) get `/ws/pane` + xterm. */
  private syncPaneStream(view: PaneView, force = false): void {
    if (view.shell === 'web') {
      this.disposePtySession(view);
      this.syncWebPixels(view, force);
      return;
    }
    this.syncPtyStream(view, force);
  }

  private disposePtySession(view: PaneView): void {
    view.ptyTerminal?.dispose();
    view.ptyTerminal = undefined;
    view.ptyLive = false;
    if (view.webStreamKey?.startsWith('pty:')) {
      if (view.streamSession) view.streamSession.powered = false;
      view.webSocket?.close();
      view.webSocket = undefined;
      view.webStreamKey = undefined;
    }
  }

  private syncPtyStream(view: PaneView, force = false): void {
    const cols = Math.max(1, view.cols || 120);
    const rows = Math.max(1, view.rows || 40);
    const key = `pty:${view.paneId}`;
    if (!force && view.webStreamKey === key && view.webSocket && view.webSocket.readyState <= WebSocket.OPEN) return;

    this.releaseWebStream(view);
    view.webLive = false;
    // Fresh VT so the connect seed is the current screen, not leftover buffer.
    view.ptyTerminal?.dispose();
    view.ptyTerminal = new Terminal({ cols, rows, scrollback: 2000, convertEol: false, allowProposedApi: true });
    view.ptyLive = false;
    view.streamSession ??= { generation: 0, live: false, powered: true };
    view.streamSession.powered = true;
    view.webCanvas ??= document.createElement('canvas');
    if (view.webCanvas.width !== 1280 || view.webCanvas.height !== 800) {
      view.webCanvas.width = 1280;
      view.webCanvas.height = 800;
    }

    const { socket } = openContentSocket(view.streamSession, hyperiaWsUrl(`/ws/pane/${view.paneId}?scrollback=1`), {
      onText: message => {
        if (message.t !== 'meta' && message.t !== 'resize') return;
        const nextCols = Number(message.cols) || view.cols || cols;
        const nextRows = Number(message.rows) || view.rows || rows;
        view.cols = nextCols;
        view.rows = nextRows;
        // Resize the VT before any bytes that follow this control frame.
        view.ptyTerminal?.resize(nextCols, nextRows);
        this.rasterPty(view);
        this.scheduleRender();
      },
      onBinary: data => {
        if (!(data instanceof ArrayBuffer) || !view.ptyTerminal) return;
        view.ptyTerminal.write(new Uint8Array(data), () => {
          this.rasterPty(view);
          this.scheduleRender();
        });
      },
      onClose: () => {
        if (this.views.get(view.paneId) !== view) return;
        view.webStreamKey = undefined;
        window.setTimeout(() => {
          if (this.views.get(view.paneId) === view) this.syncPtyStream(view, true);
        }, 400);
      },
    });
    view.webSocket = socket;
    view.webStreamKey = key;
  }

  private rasterPty(view: PaneView): void {
    const terminal = view.ptyTerminal;
    const canvas = view.webCanvas;
    if (!terminal || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cols = terminal.cols;
    const rows = terminal.rows;
    const buffer = terminal.buffer.active;
    const cellH = Math.min((canvas.height - 36) / rows, (canvas.width - 44) / (cols * .6));
    const cellW = cellH * .6;
    const padX = (canvas.width - cellW * cols) / 2;
    const padY = (canvas.height - cellH * rows) / 2;
    const fontSize = Math.max(8, Math.floor(cellH * .86));
    ctx.fillStyle = '#070a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textBaseline = 'top';
    const cell = buffer.getNullCell();
    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) continue;
      for (let x = 0; x < cols; x++) {
        const current = line.getCell(x, cell);
        if (!current || current.getWidth() === 0) continue;
        let fg = numericColor(current.getFgColor(), current.isFgRGB(), '#d7e2ea');
        let bg = numericColor(current.getBgColor(), current.isBgRGB(), '#070a0f');
        if (current.isFgDefault()) fg = '#d7e2ea';
        if (current.isBgDefault()) bg = '#070a0f';
        if (current.isInverse()) [fg, bg] = [bg, fg];
        const px = padX + x * cellW;
        const py = padY + y * cellH;
        if (bg !== '#070a0f') {
          ctx.fillStyle = bg;
          ctx.fillRect(px, py, cellW + 1, cellH + 1);
        }
        const character = current.getChars();
        if (!character || current.isInvisible()) continue;
        ctx.globalAlpha = current.isDim() ? .55 : 1;
        ctx.font = `${current.isItalic() ? 'italic ' : ''}${current.isBold() ? 'bold ' : ''}${fontSize}px "Cascadia Mono", Consolas, monospace`;
        ctx.fillStyle = fg;
        ctx.fillText(character, px, py);
        ctx.globalAlpha = 1;
      }
    }
    view.ptyLive = true;
  }

  private syncWebPixels(view: PaneView, force = false): void {
    const width = 1280;
    const height = 800;
    const fps = 15;
    const key = `pixels:${view.paneId}:${width}x${height}@${fps}`;
    if (!force && view.webSocket && view.webStreamKey === key && view.webSocket.readyState <= WebSocket.OPEN) return;
    view.webSocket?.close();
    view.webStreamKey = key;
    view.webLive = false;
    view.webCanvas ??= document.createElement('canvas');
    view.webCanvas.width = width;
    view.webCanvas.height = height;
    const socket = new WebSocket(hyperiaWsUrl(`/ws/pixels/${view.paneId}?w=${width}&h=${height}&fps=${fps}`));
    socket.binaryType = 'arraybuffer';
    view.webSocket = socket;
    const generation = ++view.webFrame;
    socket.addEventListener('message', async event => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as { t?: string };
        if (message.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
        return;
      }
      const frameNumber = ++view.webFrame;
      const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      if (view.webSocket !== socket || socket.readyState > WebSocket.OPEN || frameNumber < generation) {
        bitmap.close();
        return;
      }
      const canvas = view.webCanvas!;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      view.webLive = true;
      this.scheduleRender();
    });
  }
}
