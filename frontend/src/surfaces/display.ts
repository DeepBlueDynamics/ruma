import * as THREE from 'three';
import type { ContentSource, RenderTarget } from '../content/source';

export interface DisplaySurfaceOptions {
  id: string;
  mesh: THREE.Mesh;
  resolution?: { width: number; height: number };
}

export class DisplaySurface implements RenderTarget {
  readonly id: string;
  readonly mesh: THREE.Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  private currentSource: ContentSource | null = null;

  constructor(options: DisplaySurfaceOptions) {
    this.id = options.id;
    this.mesh = options.mesh;

    const width = options.resolution?.width ?? 1024;
    const height = options.resolution?.height ?? 512;

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;

    this.context = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    // Assign material to mesh
    const screenMaterial = new THREE.MeshBasicMaterial({
      map: this.texture,
      toneMapped: false,
    });
    this.mesh.material = screenMaterial;
  }

  setSource(source: ContentSource | null): void {
    if (this.currentSource === source) return;

    if (this.currentSource) {
      this.currentSource.detach();
    }

    this.currentSource = source;

    if (this.currentSource) {
      this.currentSource.attach(this);
    }
  }

  getSource(): ContentSource | null {
    return this.currentSource;
  }

  markDirty(): void {
    this.texture.needsUpdate = true;
  }

  update(deltaTime: number): void {
    if (this.currentSource) {
      this.currentSource.update(deltaTime);
    }
  }

  /** World-space sphere of this screen mesh only (no descendants, ignore `visible`). */
  worldSphere(target = new THREE.Sphere()): THREE.Sphere {
    this.mesh.updateWorldMatrix(true, false);
    const geometry = this.mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (geometry.boundingSphere) {
      target.copy(geometry.boundingSphere).applyMatrix4(this.mesh.matrixWorld);
      target.radius = Math.max(0.05, target.radius);
      return target;
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
    box.applyMatrix4(this.mesh.matrixWorld);
    box.getCenter(target.center);
    target.radius = Math.max(0.05, box.getSize(new THREE.Vector3()).length() * .5);
    return target;
  }

  dispose(): void {
    if (this.currentSource) {
      this.currentSource.detach();
      this.currentSource = null;
    }
    this.texture.dispose();
  }
}
