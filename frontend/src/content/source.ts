import * as THREE from 'three';
import { ATTR, cssColor } from '../hyperia/protocol';

export interface RenderTarget {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  markDirty(): void;
}

export interface ContentSource {
  readonly id: string;
  readonly kind: 'off' | 'boot' | 'terminal' | 'pixels' | 'overview';
  attach(target: RenderTarget): void;
  detach(): void;
  update(deltaTime: number): void;
}

export class OffSource implements ContentSource {
  readonly id = 'off-source';
  readonly kind = 'off';

  attach(target: RenderTarget): void {
    const { context, canvas, markDirty } = target;
    context.fillStyle = '#06090e';
    context.fillRect(0, 0, canvas.width, canvas.height);
    markDirty();
  }

  detach(): void {}

  update(_deltaTime: number): void {}
}

export class OverviewSource implements ContentSource {
  readonly id: string;
  readonly kind = 'overview';
  private target: RenderTarget | null = null;
  private view: OverviewView | null = null;

  constructor(paneId: string) {
    this.id = `overview:${paneId}`;
  }

  attach(target: RenderTarget): void {
    this.target = target;
    this.paint();
  }

  detach(): void {
    this.target = null;
  }

  update(_deltaTime: number): void {}

  apply(view: OverviewView): void {
    this.view = view;
    this.paint();
  }

  private paint(): void {
    if (!this.target) return;
    paintOverviewGrid(this.target, this.view);
    this.target.markDirty();
  }
}

export type OverviewView = {
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  grid: Array<Array<[string, string, string, number]>>;
  hasFrame: boolean;
  title?: string;
};

export function paintOverviewGrid(target: RenderTarget, view: OverviewView | null): void {
  const { context: ctx, canvas, markDirty } = target;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#070a0f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!view?.hasFrame) {
    ctx.fillStyle = '#4e91a9';
    ctx.font = `600 ${Math.max(14, Math.round(canvas.height * .04))}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(view?.title ? `WALL  ${view.title}` : 'WALL OVERVIEW', canvas.width / 2, canvas.height / 2);
    markDirty();
    return;
  }
  const cellH = Math.min(canvas.height / view.rows, canvas.width / (view.cols * .6));
  const cellW = cellH * .6;
  const gridW = cellW * view.cols;
  const gridH = cellH * view.rows;
  const padX = (canvas.width - gridW) / 2;
  const padY = (canvas.height - gridH) / 2;
  const fontSize = Math.max(4, Math.floor(cellH * .84));
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (let y = 0; y < view.rows; y++) for (let x = 0; x < view.cols; x++) {
    const cell = view.grid[y]?.[x] ?? ['', 'default', 'default', 0];
    let [character, foreground, background, attributes] = cell;
    let fg = cssColor(foreground, '#d7e2ea');
    let bg = cssColor(background, '#070a0f');
    if (attributes & ATTR.INVERSE) [fg, bg] = [bg, fg];
    const px = padX + x * cellW, py = padY + y * cellH;
    if (bg !== '#070a0f') { ctx.fillStyle = bg; ctx.fillRect(px, py, cellW + 1, cellH + 1); }
    if (!character) continue;
    ctx.globalAlpha = attributes & ATTR.DIM ? .55 : 1;
    ctx.font = `${attributes & ATTR.ITALIC ? 'italic ' : ''}${attributes & ATTR.BOLD ? '700 ' : ''}${fontSize}px "Cascadia Mono", Consolas, monospace`;
    ctx.fillStyle = fg;
    ctx.fillText(character, px, py);
    if (attributes & ATTR.UNDERLINE) ctx.fillRect(px, py + cellH * .88, cellW, Math.max(1, cellH * .07));
    ctx.globalAlpha = 1;
  }
  if (view.cursor.visible && view.cursor.x < view.cols && view.cursor.y < view.rows) {
    ctx.fillStyle = 'rgba(220,245,255,.8)';
    ctx.fillRect(padX + view.cursor.x * cellW, padY + (view.cursor.y + .88) * cellH, cellW, Math.max(1, cellH * .08));
  }
  markDirty();
}

export class BootSource implements ContentSource {
  readonly id = 'boot-source';
  readonly kind = 'boot';
  private target: RenderTarget | null = null;
  private time = 0;

  attach(target: RenderTarget): void {
    this.target = target;
  }

  detach(): void {
    this.target = null;
  }

  update(deltaTime: number): void {
    if (!this.target) return;
    this.time += deltaTime;
    const { context, canvas, markDirty } = this.target;

    context.fillStyle = '#0a0e17';
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Boot pulse ring
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const pulse = (Math.sin(this.time * 4) + 1) * 0.5;

    context.strokeStyle = `rgba(0, 229, 255, ${0.3 + pulse * 0.5})`;
    context.lineWidth = 4;
    context.beginPath();
    context.arc(centerX, centerY, 40 + pulse * 10, 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = '#00e5ff';
    context.font = '24px monospace';
    context.textAlign = 'center';
    context.fillText('INITIALIZING SYSTEM...', centerX, centerY + 80);

    markDirty();
  }
}
