export type Color = 'default' | `idx:${number}` | `#${string}`;
export type Cell = [character: string, foreground: Color, background: Color, attributes: number];
export type GridRow = { y: number; cells: Cell[] };
export type Cursor = { x: number; y: number; visible: boolean };

/** Cell attrs bitfield — wall and `/ws/tab` share this packing. */
export const ATTR = {
  BOLD: 1,
  ITALIC: 2,
  UNDERLINE: 4,
  INVERSE: 8,
  DIM: 16,
  STRIKE: 32,
} as const;

/** VS Code-ish 16-color theme used for `idx:0`–`idx:15`. Cube/grey follow xterm 256. */
const ANSI16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

function paletteIndex(index: number, fallback: string): string {
  if (!Number.isFinite(index) || index < 0) return fallback;
  const n = Math.min(255, Math.floor(index));
  if (n < 16) return ANSI16[n] ?? fallback;
  if (n < 232) {
    const cube = n - 16;
    const component = (value: number) => value === 0 ? 0 : 55 + value * 40;
    return `rgb(${component(Math.floor(cube / 36))} ${component(Math.floor(cube % 36 / 6))} ${component(cube % 6)})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey} ${grey} ${grey})`;
}

/**
 * Map a wall/tab cell color onto CSS.
 * Wire values: `"default"` | `"idx:N"` (0–255, theme-mapped) | `"#rrggbb"` (as-is).
 */
export function cssColor(color: Color | string | number | null | undefined, fallback: string): string {
  if (color == null || color === '' || color === 'default') return fallback;
  if (typeof color === 'number') return paletteIndex(color, fallback);
  const raw = String(color).trim();
  if (!raw || raw.toLowerCase() === 'default') return fallback;
  if (raw.charAt(0) === '#') {
    if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw)) return raw.slice(0, 7);
    if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
      const [, r, g, b] = raw;
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    return fallback;
  }
  const indexed = raw.match(/^(?:idx:)?(?:idx\()?(\d{1,3})\)?$/i);
  if (indexed) return paletteIndex(Number(indexed[1]), fallback);
  return fallback;
}

export function normalizeColor(value: unknown): Color {
  if (value == null || value === '' || value === 'default') return 'default';
  if (typeof value === 'number' && Number.isFinite(value)) return `idx:${Math.min(255, Math.max(0, Math.floor(value)))}`;
  const raw = String(value).trim();
  if (!raw || raw.toLowerCase() === 'default') return 'default';
  if (raw.charAt(0) === '#') return raw as Color;
  const indexed = raw.match(/^(?:idx:)?(?:idx\()?(\d{1,3})\)?$/i);
  if (indexed) return `idx:${Number(indexed[1])}`;
  return 'default';
}

export function normalizeCell(cell: unknown): Cell {
  if (typeof cell === 'string') return [cell, 'default', 'default', 0];
  if (!Array.isArray(cell) || cell.length < 1) return ['', 'default', 'default', 0];
  return [
    String(cell[0] ?? ''),
    normalizeColor(cell[1]),
    normalizeColor(cell[2]),
    Number(cell[3]) || 0,
  ];
}

function normalizeCellList(cells: unknown): Cell[] {
  return Array.isArray(cells) ? cells.map(normalizeCell) : [];
}

/**
 * Wall `frame`/`delta` rows are usually `{ y, cells }`, but keyframes sometimes
 * omit `y` (implicit index) or use `row`. Never treat numeric `rows` (height)
 * as grid data. `/ws/tab` uses the same packing.
 */
export function normalizeGridRows(changes: unknown): GridRow[] {
  if (!Array.isArray(changes)) return [];
  return changes.map((row, index) => {
    if (Array.isArray(row)) return { y: index, cells: normalizeCellList(row) };
    if (!row || typeof row !== 'object') return { y: index, cells: [] };
    const rec = row as { y?: unknown; row?: unknown; cells?: unknown };
    const y = Number.isInteger(rec.y) ? Number(rec.y)
      : Number.isInteger(rec.row) ? Number(rec.row)
      : index;
    return { y, cells: normalizeCellList(rec.cells) };
  });
}

/**
 * Sidecar v0.17.9+ pane entries carry a stable `name` (codename) plus a
 * volatile OSC `title`. Until then `name` is absent — fall back to `title`.
 * Labels always prefer `name`; never let a later title shadow it.
 */
export function paneChrome(input: {
  name?: unknown;
  title?: unknown;
  paneId: string;
}): { name: string; title: string; namedFromLayout: boolean } {
  const layoutName = typeof input.name === 'string' ? input.name.trim() : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const namedFromLayout = layoutName.length > 0;
  const name = layoutName || title || input.paneId.slice(0, 8);
  return { name, title, namedFromLayout };
}

export function wallRowPayload(message: WallMessage): GridRow[] {
  if (message.t !== 'frame' && message.t !== 'delta') return [];
  return normalizeGridRows(message.rows_data);
}

export type Pane = {
  paneId: string;
  title: string;
  cols: number;
  rows: number;
  active: boolean;
  state: 'running' | 'idle' | 'busy';
  app: string;
  cwd: string;
};

export type WallMessage =
  | { t: 'hello'; v: 1; mode: 'wall'; serverVersion: string; heartbeatMs: number }
  | { t: 'topology'; windows: unknown[] }
  | { t: 'frame'; paneId: string; cols: number; rows: number; cursor: Cursor; rows_data: GridRow[] }
  | { t: 'delta'; paneId: string; cursor: Cursor; rows_data: GridRow[] }
  | { t: 'resize'; paneId: string; cols: number; rows: number }
  | { t: 'state'; paneId: string; state: Pane['state']; app: string; cwd: string }
  | { t: 'topo'; op: 'add' | 'remove' | 'activate'; paneId: string }
  | { t: 'resync' }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string }
  | { t: 'bye'; reason: string };

