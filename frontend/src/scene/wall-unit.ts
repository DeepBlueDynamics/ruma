import * as THREE from 'three';

/**
 * Wall-arc math shared by camera framing and spawned-desk placement. Pure
 * (no DOM) so the azimuth derivation is testable — callers feed it meshes.
 */

/**
 * Mean azimuth (radians about the room's vertical axis) of a wall arc's
 * world-space vertices. Mirrors the cylindrical-unwrap middle used by
 * `measureCylindricalAspect`, but in world space so a transformed room still
 * reads correctly.
 */
export function meshMiddleAzimuth(mesh: THREE.Mesh): number {
  mesh.updateWorldMatrix(true, false);
  const position = mesh.geometry.getAttribute('position');
  const point = new THREE.Vector3();
  let sumX = 0, sumZ = 0;
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    sumX += point.x;
    sumZ += point.z;
  }
  return Math.atan2(sumZ, sumX);
}

