import { Terminal } from '@xterm/xterm';
import type { ContentSource, RenderTarget } from '../content/source';
import { openContentSocket } from '../hyperia/stream';

/** Focused PTY bytes painted onto a DisplaySurface. Socket is owned by StreamBroker. */
export class FocusedPtySource implements ContentSource {
  readonly id: string;
  readonly kind = 'terminal' as const;
  private target: RenderTarget | null = null;
  private readonly terminal: Terminal;
  private cols: number;
  private rows: number;

  constructor(readonly paneId: string, cols = 120, rows = 40) {
    this.id = `pty:${paneId}`;
    this.cols = cols;
    this.rows = rows;
    this.terminal = new Terminal({ cols, rows, scrollback: 2000, convertEol: false, allowProposedApi: true });
  }

  attach(target: RenderTarget): void {
    this.target = target;
  }

  detach(): void {
    this.target = null;
  }

  update(_deltaTime: number): void {}

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.terminal.resize(cols, rows);
    this.paint();
  }

  write(bytes: Uint8Array): void {
    this.terminal.write(bytes, () => this.paint());
  }

  paint(): void {
    if (!this.target) return;
    const { canvas, context: ctx, markDirty } = this.target;
    const buffer = this.terminal.buffer.active;
    const cellH = Math.min((canvas.height - 36) / this.rows, (canvas.width - 44) / (this.cols * .6));
    const cellW = cellH * .6;
    const padX = (canvas.width - cellW * this.cols) / 2;
    const padY = (canvas.height - cellH * this.rows) / 2;
    const fontSize = Math.max(8, Math.floor(cellH * .86));
    ctx.fillStyle = '#070a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textBaseline = 'top';
    const cell = buffer.getNullCell();
    for (let y = 0; y < this.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) continue;
      for (let x = 0; x < this.cols; x++) {
        const current = line.getCell(x, cell);
        if (!current || current.getWidth() === 0) continue;
        const character = current.getChars();
        if (!character || current.isInvisible()) continue;
        ctx.globalAlpha = current.isDim() ? .55 : 1;
        ctx.font = `${current.isItalic() ? 'italic ' : ''}${current.isBold() ? 'bold ' : ''}${fontSize}px "Cascadia Mono", Consolas, monospace`;
        ctx.fillStyle = '#d7e2ea';
        ctx.fillText(character, padX + x * cellW, padY + y * cellH);
        ctx.globalAlpha = 1;
      }
    }
    markDirty();
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

/** Focused web-pixel JPEGs painted onto a DisplaySurface. */
export class FocusedPixelsSource implements ContentSource {
  readonly id: string;
  readonly kind = 'pixels' as const;
  private target: RenderTarget | null = null;

  constructor(readonly paneId: string) {
    this.id = `pixels:${paneId}`;
  }

  attach(target: RenderTarget): void {
    this.target = target;
  }

  detach(): void {
    this.target = null;
  }

  update(_deltaTime: number): void {}

  draw(bitmap: ImageBitmap): void {
    if (!this.target) { bitmap.close(); return; }
    const { canvas, context: ctx, markDirty } = this.target;
    ctx.fillStyle = '#070a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    ctx.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    bitmap.close();
    markDirty();
  }
}

export { openContentSocket };
