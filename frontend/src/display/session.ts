import * as THREE from 'three';
import { Terminal } from '@xterm/xterm';
import type { ContentSource } from './content-source';
import { DESIGN_CONTENT_ASPECT } from './content-source';
import { configurePanelTexture, createDisplaySurface, type DisplaySurface, type UvMapping } from './surface';

export type ContentRect = { x: number; y: number; width: number; height: number };

export type MonitorSession = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  terminal: Terminal;
  cols: number;
  rows: number;
  paneId: string;
  live: boolean;
  socket?: WebSocket;
  generation: number;
  pixelFrame: number;
  powered: boolean;
  /** Physical panel width/height, derived from the bound screen mesh. */
  panelAspect: number;
  /** Bumped when the canvas is resized so in-flight boot paints stop. */
  rasterEpoch: number;
  source: ContentSource;
  surface?: DisplaySurface;
};

export function letterboxRect(containerW: number, containerH: number, contentAspect: number): ContentRect {
  const containerAspect = containerW / Math.max(1e-6, containerH);
  if (containerAspect > contentAspect) {
    const width = containerH * contentAspect;
    return { x: (containerW - width) / 2, y: 0, width, height: containerH };
  }
  const height = containerW / contentAspect;
  return { x: 0, y: (containerH - height) / 2, width: containerW, height };
}

export function sessionContentRect(session: MonitorSession, contentAspect = DESIGN_CONTENT_ASPECT): ContentRect {
  return letterboxRect(session.canvas.width, session.canvas.height, contentAspect);
}

export function fillBezel(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, color = '#01070b'): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

export function drawContained(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource & { width: number; height: number },
  destW: number,
  destH: number,
): ContentRect {
  const rect = letterboxRect(destW, destH, source.width / Math.max(1, source.height));
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
  return rect;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export function createMonitorSession(): MonitorSession {
  const canvas = document.createElement('canvas');
  canvas.width = 1440;
  canvas.height = 900;
  const texture = new THREE.CanvasTexture(canvas);
  configurePanelTexture(texture);
  return {
    canvas,
    texture,
    terminal: new Terminal({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, scrollback: 2000, convertEol: false, allowProposedApi: true }),
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    paneId: '',
    live: false,
    generation: 0,
    pixelFrame: 0,
    powered: false,
    panelAspect: DESIGN_CONTENT_ASPECT,
    rasterEpoch: 0,
    source: { kind: 'none' },
  };
}

/** Bind a session's canvas to a screen mesh and size it to the real glass. */
export function bindSessionSurface(session: MonitorSession, mesh: THREE.Mesh, options?: {
  mapping?: UvMapping;
}): DisplaySurface {
  const surface = createDisplaySurface(mesh, {
    mapping: options?.mapping ?? 'authored',
    canvas: session.canvas,
    texture: session.texture,
    source: session.source,
  });
  session.panelAspect = surface.panelAspect;
  session.surface = surface;
  session.rasterEpoch++;
  return surface;
}
