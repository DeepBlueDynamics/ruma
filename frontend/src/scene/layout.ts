import * as THREE from 'three';

export type PolarStationLayout = {
  kind: 'polar';
  stationIds: string[];
  count: number;
  center: [number, number];
  radius: number;
  centerAngleDeg: number;
  spacingDeg: number;
};

export type GridStationLayout = {
  kind: 'grid';
  stationIds: string[];
  origin: [number, number];
  rows: number;
  columns: number;
  pitch: [number, number];
};

export type StationLayout = PolarStationLayout | GridStationLayout;
export type StationPlacement = { id: string; position: THREE.Vector3 };

export function polar(layout: PolarStationLayout): StationPlacement[] {
  if (layout.count <= 0 || layout.radius <= 0) return [];
  const stationIds = layout.stationIds.slice(0, layout.count);
  const count = stationIds.length;
  const firstAngle = layout.centerAngleDeg - layout.spacingDeg * (count - 1) / 2;
  return stationIds.map((id, index) => {
    const angle = THREE.MathUtils.degToRad(firstAngle + index * layout.spacingDeg);
    return { id, position: new THREE.Vector3(layout.center[0] + Math.cos(angle) * layout.radius, 0, layout.center[1] + Math.sin(angle) * layout.radius) };
  });
}

export function grid(layout: GridStationLayout): StationPlacement[] {
  const capacity = Math.max(0, layout.rows) * Math.max(0, layout.columns);
  return layout.stationIds.slice(0, capacity).map((id, index) => {
    const row = Math.floor(index / layout.columns);
    const column = index % layout.columns;
    const x = layout.origin[0] + (column - (layout.columns - 1) / 2) * layout.pitch[0];
    const z = layout.origin[1] + (row - (layout.rows - 1) / 2) * layout.pitch[1];
    return { id, position: new THREE.Vector3(x, 0, z) };
  });
}

export function buildStationLayout(layout: StationLayout): Map<string, StationPlacement> {
  const placements = layout.kind === 'polar' ? polar(layout) : grid(layout);
  return new Map(placements.map(placement => [placement.id, placement]));
}

export function sampleSurfaceNormalAtStation(
  surface: THREE.Mesh,
  stationPosition: THREE.Vector3,
  roomCenter: THREE.Vector3,
): THREE.Vector3 | undefined {
  const positions = surface.geometry.getAttribute('position');
  const normals = surface.geometry.getAttribute('normal');
  if (!positions || !normals) return undefined;

  surface.updateWorldMatrix(true, false);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(surface.matrixWorld);
  const stationAngle = Math.atan2(stationPosition.z - roomCenter.z, stationPosition.x - roomCenter.x);
  const local = new THREE.Vector3();
  const world = new THREE.Vector3();
  const candidateNormal = new THREE.Vector3();
  let bestScore = Infinity;
  let bestPoint: THREE.Vector3 | undefined;
  let bestNormal: THREE.Vector3 | undefined;

  for (let index = 0; index < positions.count; index++) {
    local.fromBufferAttribute(positions, index);
    world.copy(local).applyMatrix4(surface.matrixWorld);
    const angle = Math.atan2(world.z - roomCenter.z, world.x - roomCenter.x);
    const angularDistance = Math.abs(Math.atan2(Math.sin(angle - stationAngle), Math.cos(angle - stationAngle)));
    if (angularDistance >= bestScore) continue;
    candidateNormal.fromBufferAttribute(normals, index).applyMatrix3(normalMatrix).normalize();
    bestScore = angularDistance;
    bestPoint = world.clone();
    bestNormal = candidateNormal.clone();
  }

  if (!bestPoint || !bestNormal) return undefined;
  bestNormal.y = 0;
  if (bestNormal.lengthSq() < 1e-8) return undefined;
  bestNormal.normalize();
  // Always use the face directed into the occupied room, toward the station.
  const surfaceToStation = stationPosition.clone().sub(bestPoint); surfaceToStation.y = 0;
  if (bestNormal.dot(surfaceToStation) < 0) bestNormal.negate();
  return bestNormal;
}

export function yawFromSurfaceNormal(normal: THREE.Vector3): number {
  // Authored station +Z is the seated/operator side.
  return Math.atan2(normal.x, normal.z);
}
