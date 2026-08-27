import * as THREE from 'three';

type HousingPair = {
  panel: RegExp;
  screenName(panelName: string): string;
};

const HOUSING_PAIRS: HousingPair[] = [
  { panel: /^MonPanel_(\d+)$/, screenName: name => name.replace('MonPanel_', 'MonScreen_') },
  { panel: /^CurvedMon_Panel$/, screenName: () => 'CurvedMon_Screen' },
  { panel: /^Monitor_Panel$/, screenName: () => 'Monitor_ScreenFace' },
];

export type OpenedMonitorHousing = {
  panelName: string;
  screenName: string;
  removedTriangles: number;
};

/**
 * Remove only the housing triangles that face a monitor's display glass.
 *
 * The authored assets use a closed panel behind a separate screen surface.
 * Keeping that panel's front cap lets the cap show through at grazing angles
 * and through transmissive display materials. The rear cap and the four edge
 * walls are real housing and stay untouched.
 *
 * Geometry is cloned before editing because AssetCache instances intentionally
 * share immutable source geometry.
 */
export function openMonitorHousingFronts(root: THREE.Object3D): OpenedMonitorHousing[] {
  root.updateWorldMatrix(true, true);
  const opened: OpenedMonitorHousing[] = [];

  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const pair = HOUSING_PAIRS.find(candidate => candidate.panel.test(object.name));
    if (!pair) return;
    const screenName = pair.screenName(object.name);
    const screen = root.getObjectByName(screenName);
    if (!(screen instanceof THREE.Mesh)) return;

    const geometry = object.geometry.clone();
    const position = geometry.getAttribute('position');
    if (!(position instanceof THREE.BufferAttribute) || position.count < 3) return;

    geometry.computeBoundingBox();
    const panelCenter = geometry.boundingBox!.getCenter(new THREE.Vector3());
    const screenCenterWorld = new THREE.Box3().setFromObject(screen).getCenter(new THREE.Vector3());
    const screenCenterLocal = object.worldToLocal(screenCenterWorld.clone());
    const towardScreen = screenCenterLocal.sub(panelCenter).normalize();
    if (towardScreen.lengthSq() < 0.5) return;

    const sourceIndex = geometry.index;
    const triangleCount = sourceIndex ? Math.floor(sourceIndex.count / 3) : Math.floor(position.count / 3);
    const retained: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const normal = new THREE.Vector3();
    let removedTriangles = 0;

    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const offset = triangle * 3;
      const ia = sourceIndex ? sourceIndex.getX(offset) : offset;
      const ib = sourceIndex ? sourceIndex.getX(offset + 1) : offset + 1;
      const ic = sourceIndex ? sourceIndex.getX(offset + 2) : offset + 2;
      a.fromBufferAttribute(position, ia);
      b.fromBufferAttribute(position, ib);
      c.fromBufferAttribute(position, ic);
      edge1.subVectors(b, a);
      edge2.subVectors(c, a);
      normal.crossVectors(edge1, edge2).normalize();

      // Curved front caps still point predominantly toward their glass. Edge
      // walls are near-perpendicular and the rear cap points away.
      if (normal.dot(towardScreen) > 0.45) {
        removedTriangles++;
        continue;
      }
      retained.push(ia, ib, ic);
    }

    if (!removedTriangles || retained.length === 0) return;
    geometry.setIndex(retained);
    geometry.clearGroups();
    geometry.addGroup(0, retained.length, 0);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    object.geometry = geometry;
    opened.push({ panelName: object.name, screenName, removedTriangles });
  });

  return opened;
}
