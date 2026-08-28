import * as THREE from 'three';

/**
 * Camera framing for the three-screen wall unit. Pure math (no DOM, no scene
 * graph) so the pose derivation is testable — `main.ts` only feeds it the
 * measured screen boxes and the unit's bisector azimuth.
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

export type WallUnitPose = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
};

/**
 * Level camera pose on the wall unit's angular bisector that frames every
 * given box inside a `vFovDeg` vertical / aspect-derived horizontal frustum,
 * with the combined bounds centered. The camera sits on the far side of the
 * combined center, looking along the bisector toward the wall, at the minimum
 * distance where every box corner projects inside both half-angles.
 */
export function wallUnitFramingPose(
  boxes: readonly THREE.Box3[],
  bisectorAzimuthRad: number,
  vFovDeg: number,
  aspect: number,
  margin = 1.04,
): WallUnitPose | undefined {
  const union = new THREE.Box3().makeEmpty();
  for (const box of boxes) if (!box.isEmpty()) union.union(box);
  if (union.isEmpty()) return undefined;

  const target = union.getCenter(new THREE.Vector3());
  // Camera-to-wall look direction: along the bisector, level with the wall.
  const forward = new THREE.Vector3(Math.cos(bisectorAzimuthRad), 0, Math.sin(bisectorAzimuthRad));
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const tanV = Math.tan(THREE.MathUtils.degToRad(vFovDeg) / 2);
  const tanH = tanV * Math.max(0.1, aspect);

  // Minimum standoff so every corner p is inside both half-angles as seen
  // from the camera at `target - forward*distance`:
  //   |axis·(p-target)| <= tan(half) · (distance + forward·(p-target))
  //   ⇔ distance >= |axis·(p-target)| / tan(half) − forward·(p-target)
  let distance = 0.001;
  const corner = new THREE.Vector3();
  const offset = new THREE.Vector3();
  for (const box of boxes) {
    if (box.isEmpty()) continue;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          offset.copy(corner.set(x, y, z)).sub(target);
          const depth = forward.dot(offset);
          distance = Math.max(
            distance,
            Math.abs(offset.y) / tanV - depth,
            Math.abs(right.dot(offset)) / tanH - depth,
          );
        }
  }
  distance *= margin;
  return {
    position: target.clone().addScaledVector(forward, -distance),
    target,
    distance,
  };
}
