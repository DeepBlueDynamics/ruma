/** What is currently painted onto a DisplaySurface. Room config never sets this. */
export type ContentSource =
  | { kind: 'none' }
  | { kind: 'off' }
  | { kind: 'boot' }
  | { kind: 'pty'; paneId: string }
  | { kind: 'web-pixels'; paneId: string }
  | { kind: 'wall-status' };

export const DESIGN_CONTENT_ASPECT = 16 / 10;
