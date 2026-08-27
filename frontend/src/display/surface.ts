import * as THREE from 'three';
import type { ContentSource } from './content-source';

/** How the surface's UVs relate to the physical panel. */
export type UvMapping = 'authored' | 'cylindrical';

/** Texture-space correction so painted +X is the viewer's right and +Y is up. */
export type UvOrientation = { flipU: boolean; flipV: boolean };

/**
 * A physical panel: wall arc or desk monitor. Same type, different UV mapping.
 * Session/content state lives on ContentSource / MonitorSession, not here.
 */
export type DisplaySurface = {
  id: string;
  mesh: THREE.Mesh;
  mapping: UvMapping;
  /** Physical width / height of the glass. Texture canvas is sized to this. */
  panelAspect: number;
  orientation: UvOrientation;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  source: ContentSource;
};

export function canvasSizeForPanel(panelAspect: number, height: number): { width: number; height: number } {
  const aspect = Math.max(0.25, Math.min(8, panelAspect));
  return { width: Math.min(4096, Math.max(640, Math.round(height * aspect))), height };
}

/**
 * Authored desk/monitor faces: local X is width, local Y is height.
 * Do not use a world AABB — a yawed desk would inflate the box.
 */
export function measureAuthoredPanelAspect(mesh: THREE.Mesh): number {
  const position = mesh.geometry.getAttribute('position');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return Math.max(1e-6, maxX - minX) / Math.max(1e-6, maxY - minY);
}

/**
 * The authored wall screens ship with POSITION and NORMAL only — no TEXCOORD_0 —
 * which is why every previous attempt to map content onto them produced garbage.
 * Unwrap by azimuth so a texture lands on the curve undistorted. An authored
 * Blender unwrap can replace this later without changing anything downstream.
 */
export function measureCylindricalAspect(mesh: THREE.Mesh): { aspect: number; offsets: Float32Array; minOffset: number; span: number; minY: number; rise: number } {
  const position = mesh.geometry.getAttribute('position');
  const count = position.count;
  // Measure each vertex against the segment's own mean direction so an arc that
  // straddles the +/-PI seam still unwraps as one continuous span.
  let sumX = 0, sumZ = 0;
  for (let i = 0; i < count; i++) { sumX += position.getX(i); sumZ += position.getZ(i); }
  const middle = Math.atan2(sumZ, sumX);
  const offsets = new Float32Array(count);
  let minOffset = Infinity, maxOffset = -Infinity, minY = Infinity, maxY = -Infinity, radius = 0;
  for (let i = 0; i < count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const delta = Math.atan2(z, x) - middle;
    const wrapped = Math.atan2(Math.sin(delta), Math.cos(delta));
    offsets[i] = wrapped;
    minOffset = Math.min(minOffset, wrapped); maxOffset = Math.max(maxOffset, wrapped);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    radius += Math.hypot(x, z);
  }
  radius /= count;
  const span = Math.max(1e-6, maxOffset - minOffset), rise = Math.max(1e-6, maxY - minY);
  return { aspect: (radius * span) / rise, offsets, minOffset, span, minY, rise };
}

export function applyCylindricalUVs(mesh: THREE.Mesh): number {
  const position = mesh.geometry.getAttribute('position');
  const { aspect, offsets, minOffset, span, minY, rise } = measureCylindricalAspect(mesh);
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    // Azimuth increases to the right for a viewer standing inside and looking
    // out, so u needs no mirroring the way the desk panels do.
    uv[i * 2] = (offsets[i] - minOffset) / span;
    uv[i * 2 + 1] = (position.getY(i) - minY) / rise;
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return aspect;
}

export function measurePanelAspect(mesh: THREE.Mesh, mapping: UvMapping): number {
  return mapping === 'cylindrical' ? measureCylindricalAspect(mesh).aspect : measureAuthoredPanelAspect(mesh);
}

/**
 * Read the mesh UVs instead of taking a caller flag.
 * Canvas content is Y-down with u to the right; after Three's flipY, v=1 is the
 * painted top. A panel reads correctly when v increases with world Y and u
 * increases toward the viewer's right. Authored MonScreen quads have v=0 at the
 * top of the glass; the generated wall unwrap has v=0 at the bottom.
 */
export function measureUvOrientation(mesh: THREE.Mesh): UvOrientation {
  mesh.updateWorldMatrix(true, false);
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  if (!position || !uv) return { flipU: false, flipV: false };

  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const mid = new THREE.Vector3(), centroid = new THREE.Vector3();
  const triangles: Array<{ ia: number; ib: number; ic: number; mid: THREE.Vector3 }> = [];
  const visit = (ia: number, ib: number, ic: number) => {
    p0.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
    p1.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
    p2.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
    mid.copy(p0).add(p1).add(p2).multiplyScalar(1 / 3);
    centroid.add(mid);
    triangles.push({ ia, ib, ic, mid: mid.clone() });
  };
  const index = geometry.index;
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) visit(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) visit(i, i + 1, i + 2);
  }
  if (!triangles.length) return { flipU: false, flipV: false };
  centroid.multiplyScalar(1 / triangles.length);

  // A curved wall's Pu averages to nonsense; read the triangle at the panel
  // center, which is also where the operator is looking.
  let best = triangles[0], bestDist = Infinity;
  for (const triangle of triangles) {
    const dist = triangle.mid.distanceToSquared(centroid);
    if (dist < bestDist) { bestDist = dist; best = triangle; }
  }
  const du1 = uv.getX(best.ib) - uv.getX(best.ia), dv1 = uv.getY(best.ib) - uv.getY(best.ia);
  const du2 = uv.getX(best.ic) - uv.getX(best.ia), dv2 = uv.getY(best.ic) - uv.getY(best.ia);
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-8) return { flipU: false, flipV: false };
  p0.fromBufferAttribute(position, best.ia).applyMatrix4(mesh.matrixWorld);
  p1.fromBufferAttribute(position, best.ib).applyMatrix4(mesh.matrixWorld);
  p2.fromBufferAttribute(position, best.ic).applyMatrix4(mesh.matrixWorld);
  const e1 = new THREE.Vector3().subVectors(p1, p0);
  const e2 = new THREE.Vector3().subVectors(p2, p0);
  const pu = e1.clone().multiplyScalar(dv2).addScaledVector(e2, -dv1).divideScalar(det);
  const pv = e1.clone().multiplyScalar(-du2).addScaledVector(e2, du1).divideScalar(det);

  const worldUp = new THREE.Vector3(0, 1, 0);
  const lookDir = new THREE.Vector3();
  const normalAttr = geometry.getAttribute('normal');
  if (normalAttr) {
    const n = new THREE.Vector3(), nSum = new THREE.Vector3();
    for (let i = 0; i < normalAttr.count; i++) {
      n.fromBufferAttribute(normalAttr, i).transformDirection(mesh.matrixWorld);
      if (n.lengthSq() > 1e-10) nSum.add(n.normalize());
    }
    nSum.multiplyScalar(1 / Math.max(1, normalAttr.count));
    // Desk glass has coherent facing (+Z toward the operator). The wall arcs
    // were authored with canceling ±Y normals, so fall back to "from room
    // origin toward the panel" — the operator stands inside and looks out.
    if (nSum.length() > 0.4) lookDir.copy(nSum).normalize().negate();
  }
  if (lookDir.lengthSq() < 1e-8) lookDir.copy(centroid).setY(0);
  if (lookDir.lengthSq() < 1e-8) lookDir.set(0, 0, 1);
  lookDir.normalize();
  const viewerRight = new THREE.Vector3().crossVectors(lookDir, worldUp);
  if (viewerRight.lengthSq() < 1e-8) viewerRight.set(1, 0, 0).transformDirection(mesh.matrixWorld);
  viewerRight.normalize();

  return {
    flipU: pu.dot(viewerRight) < 0,
    flipV: pv.dot(worldUp) < 0,
  };
}

export function configurePanelTexture(texture: THREE.CanvasTexture, orientation: UvOrientation = { flipU: false, flipV: false }): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // The historic MonScreen transform (rot=π, repeat.x=-1) is exactly flip-V.
  // Keep that bit-identical so those panels do not shift.
  if (orientation.flipV && !orientation.flipU) {
    texture.center.set(0.5, 0.5);
    texture.rotation = Math.PI;
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.set(-1, 1);
  } else if (orientation.flipU && orientation.flipV) {
    texture.center.set(0.5, 0.5);
    texture.rotation = Math.PI;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.repeat.set(1, 1);
  } else if (orientation.flipU) {
    texture.center.set(0.5, 0.5);
    texture.rotation = 0;
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.set(-1, 1);
  } else {
    texture.center.set(0, 0);
    texture.rotation = 0;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.repeat.set(1, 1);
  }
  texture.needsUpdate = true;
}

function ensureCanvasSize(canvas: HTMLCanvasElement, panelAspect: number, height: number): void {
  const size = canvasSizeForPanel(panelAspect, height);
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
}

export function createDisplaySurface(mesh: THREE.Mesh, options: {
  id?: string;
  mapping: UvMapping;
  canvasHeight?: number;
  canvas?: HTMLCanvasElement;
  texture?: THREE.CanvasTexture;
  source?: ContentSource;
}): DisplaySurface {
  const mapping = options.mapping;
  const panelAspect = mapping === 'cylindrical' ? applyCylindricalUVs(mesh) : measureAuthoredPanelAspect(mesh);
  const height = options.canvasHeight ?? 900;
  const canvas = options.canvas ?? document.createElement('canvas');
  ensureCanvasSize(canvas, panelAspect, height);
  const texture = options.texture ?? new THREE.CanvasTexture(canvas);
  if (options.texture && options.texture.image !== canvas) texture.image = canvas;
  const orientation = measureUvOrientation(mesh);
  configurePanelTexture(texture, orientation);
  mesh.material = new THREE.MeshBasicMaterial({
    map: texture,
    side: mapping === 'cylindrical' ? THREE.DoubleSide : THREE.FrontSide,
    toneMapped: false,
  });
  return {
    id: options.id ?? mesh.name,
    mesh,
    mapping,
    panelAspect,
    orientation,
    canvas,
    texture,
    source: options.source ?? { kind: 'none' },
  };
}
