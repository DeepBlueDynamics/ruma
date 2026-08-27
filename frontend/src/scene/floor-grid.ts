import * as THREE from 'three';

/** 36 radial lines ⇒ 10° per line. Line 0 is world +X, increasing toward +Z. */
export const FLOOR_SECTORS = 36;

const RINGS = [
  { inner: 0.0525, outer: 4.1475 },
  { inner: 4.2525, outer: 8.3475 },
  { inner: 8.4525, outer: 12.6975 },
  { inner: 12.8025, outer: 17.1975 },
  { inner: 17.3025, outer: 21.7725 },
] as const;

const TILE_Y = 0.018;
const GAP_RATIO = 10.791633766386436 / 11.25;

export type FloorGridOptions = { sectors?: number };

function wedgeGeometry(inner: number, outer: number, start: number, end: number, segments = 16): THREE.BufferGeometry {
  // Use RingGeometry subdivided along theta to generate smooth circular arcs for the floor tiles
  const thetaLength = end - start;
  const geometry = new THREE.RingGeometry(inner, outer, segments, 1, start, thetaLength);
  // Orient to floor plane (Y-up) at TILE_Y elevation
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, TILE_Y, 0);
  return geometry;
}

function hideAuthoredSectors(room: THREE.Object3D): void {
  room.traverse(node => {
    if (/^Floor_Tile_R\d+_S\d+$/.test(node.name)) node.visible = false;
  });
}

function tileMaterial(room: THREE.Object3D): THREE.Material {
  let source: THREE.Material | undefined;
  room.traverse(node => {
    if (source || !(node instanceof THREE.Mesh) || node.name !== 'Floor_Tile_R00_S00') return;
    const material = node.material;
    source = Array.isArray(material) ? material[0] : material;
  });
  if (source) {
    const clone = source.clone();
    clone.side = THREE.DoubleSide;
    return clone;
  }
  return new THREE.MeshStandardMaterial({ color: 0x1a222b, roughness: .82, metalness: .08, side: THREE.DoubleSide });
}

/** Replace the authored 32-sector floor with `sectors` equal wedges (default 36). */
export function recutFloorGrid(room: THREE.Object3D, options: FloorGridOptions = {}): THREE.Group {
  const sectors = options.sectors ?? FLOOR_SECTORS;
  hideAuthoredSectors(room);
  const existing = room.getObjectByName('Floor_Grid_36');
  if (existing) existing.removeFromParent();

  const group = new THREE.Group();
  group.name = 'Floor_Grid_36';
  const material = tileMaterial(room);
  const pitch = (Math.PI * 2) / sectors;
  const span = pitch * GAP_RATIO;
  const inset = (pitch - span) / 2;

  for (let ring = 0; ring < RINGS.length; ring++) {
    const { inner, outer } = RINGS[ring];
    for (let sector = 0; sector < sectors; sector++) {
      const start = sector * pitch + inset;
      const mesh = new THREE.Mesh(wedgeGeometry(inner, outer, start, start + span), material);
      mesh.name = `Floor_Tile_R${String(ring).padStart(2, '0')}_L${String(sector).padStart(2, '0')}`;
      mesh.userData.semantic_role = 'floor.tile';
      mesh.userData.floorLine = sector;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      group.add(mesh);
    }
  }
  room.add(group);
  return group;
}
