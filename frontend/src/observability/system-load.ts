import type { WebGLRenderer } from 'three';

type ChromePerformance = Performance & {
  memory?: {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
};

type LoadSnapshot = {
  fps: number;
  frameMs: number;
  maxFrameMs: number;
  longFrames: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  programs: number;
  heapMb?: number;
  heapLimitMb?: number;
};

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export class SystemLoadTracker {
  private sampleStart = performance.now();
  private lastFrame = this.sampleStart;
  private lastReport = this.sampleStart;
  private frames = 0;
  private frameTotal = 0;
  private maxFrame = 0;
  private longFrames = 0;

  constructor(private readonly element: HTMLElement) {}

  update(now: number, renderer: WebGLRenderer): void {
    const delta = Math.max(0, now - this.lastFrame);
    this.lastFrame = now;
    if (delta > 0 && delta < 1000) {
      this.frames++;
      this.frameTotal += delta;
      this.maxFrame = Math.max(this.maxFrame, delta);
      if (delta >= 50) this.longFrames++;
    }
    const elapsed = now - this.sampleStart;
    if (elapsed < 750) return;

    const memory = (performance as ChromePerformance).memory;
    const snapshot: LoadSnapshot = {
      fps: this.frames * 1000 / Math.max(1, elapsed),
      frameMs: this.frameTotal / Math.max(1, this.frames),
      maxFrameMs: this.maxFrame,
      longFrames: this.longFrames,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
      programs: renderer.info.programs?.length ?? 0,
      heapMb: memory ? memory.usedJSHeapSize / 1_048_576 : undefined,
      heapLimitMb: memory ? memory.jsHeapSizeLimit / 1_048_576 : undefined,
    };
    const level = snapshot.fps < 25 || snapshot.maxFrameMs > 100
      ? 'critical'
      : snapshot.fps < 48 || snapshot.maxFrameMs > 50 ? 'warn' : 'ok';
    this.element.dataset.level = level;
    this.element.innerHTML = `
      <div class="load-title"><span>SYSTEM LOAD</span><strong>${snapshot.fps.toFixed(0)} FPS</strong></div>
      <div class="load-grid">
        <span>FRAME</span><b>${snapshot.frameMs.toFixed(1)} ms</b>
        <span>MAX</span><b>${snapshot.maxFrameMs.toFixed(1)} ms</b>
        <span>LONG</span><b>${snapshot.longFrames}</b>
        <span>DRAW</span><b>${snapshot.drawCalls}</b>
        <span>TRIS</span><b>${compact(snapshot.triangles)}</b>
        <span>GPU RES</span><b>${snapshot.textures}T · ${snapshot.geometries}G</b>
        <span>SHADERS</span><b>${snapshot.programs}</b>
        <span>JS HEAP</span><b>${snapshot.heapMb === undefined ? 'N/A' : `${snapshot.heapMb.toFixed(0)} / ${snapshot.heapLimitMb?.toFixed(0)} MB`}</b>
      </div>`;

    if (now - this.lastReport >= 10_000) {
      this.lastReport = now;
      console.info('system-load-snapshot', snapshot);
    }
    this.sampleStart = now;
    this.frames = 0;
    this.frameTotal = 0;
    this.maxFrame = 0;
    this.longFrames = 0;
  }
}
