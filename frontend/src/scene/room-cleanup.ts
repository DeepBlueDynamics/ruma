import * as THREE from 'three';

const PROTECTED_FLOOR_OR_SCREEN = /^(Floor|Dais|Room_Floor|Wall_Screen_[1-3]($|_Frame$|_LightRail$))/i;

/**
 * Remove/hide all room wall, ceiling, backdrop, and enclosure structure meshes,
 * while preserving ONLY the floor/dais and presentation screens, frames & light rails intact.
 */
export function removeRoomWallsAndCeiling(room: THREE.Object3D): string[] {
  const removed: string[] = [];
  room.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;

    const name = node.name || '';
    const role = typeof node.userData?.semantic_role === 'string' ? node.userData.semantic_role : '';

    // Keep floor/dais and screen glass, frames, and light rails intact
    if (
      PROTECTED_FLOOR_OR_SCREEN.test(name) ||
      role === 'floor' ||
      role === 'dais' ||
      role === 'screen.frame' ||
      role === 'screen.lightRail' ||
      role === 'screen.glass' ||
      role === 'presentation.screen'
    ) {
      return;
    }

    // Hide all wall, ceiling, backdrop, pillar, and architectural enclosure meshes
    node.visible = false;
    removed.push(name || node.type);
  });

  console.info('room-walls-and-ceiling-purged', { count: removed.length, removed });
  return removed;
}
