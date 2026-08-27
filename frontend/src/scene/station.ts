import * as THREE from 'three';
import type { DisplaySurface } from '../display/surface';

export interface StationOptions {
  id: string;
  label: string;
  object: THREE.Object3D;
  monitorCount: number;
}

export class StationInstance {
  readonly id: string;
  readonly label: string;
  readonly object: THREE.Object3D;
  readonly monitorCount: number;
  /** Bay index (1-based) → session-bound glass. Not the material-stealing SurfaceDisplay class. */
  readonly displaySurfaces = new Map<number, DisplaySurface>();

  private heightPivot: THREE.Object3D | null = null;
  private currentHeightM = 0.72;
  private minHeightM = 0.65;
  private maxHeightM = 1.25;

  constructor(options: StationOptions) {
    this.id = options.id;
    this.label = options.label;
    this.object = options.object;
    this.monitorCount = options.monitorCount;

    this.object.traverse((child) => {
      if (child.name === 'Desk_Height_Pivot') {
        this.heightPivot = child;
      }
    });
  }

  /**
   * Set physical work-surface height in meters (clamped between min/max travel).
   */
  setHeight(meters: number): number {
    const clamped = Math.max(this.minHeightM, Math.min(this.maxHeightM, meters));
    this.currentHeightM = clamped;

    if (this.heightPivot) {
      const yOffset = clamped - 0.72;
      this.heightPivot.position.y = yOffset;
      this.object.updateMatrixWorld(true);
    }

    return clamped;
  }

  getHeight(): number {
    return this.currentHeightM;
  }

  registerDisplaySurface(bayIndex: number, surface: DisplaySurface): void {
    this.displaySurfaces.set(bayIndex, surface);
  }

  getDisplaySurface(bayIndex: number): DisplaySurface | undefined {
    return this.displaySurfaces.get(bayIndex);
  }

  dispose(): void {
    this.displaySurfaces.clear();
  }
}
