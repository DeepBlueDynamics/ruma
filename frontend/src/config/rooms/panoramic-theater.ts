import type { StationLayout } from '../../scene/layout';

export const panoramicTheaterRoom = {
  id: 'panoramic-theater',
  shell: {
    asset: '/assets/panoramic_command_theater_architecture.glb?v=20260828-open-shell',
    // The approved 1.5x enlargement is baked into the authored Blender scene.
    // Runtime room transforms remain identity so anchors and dimensions are in
    // real authored world units.
    scale: 1,
  },
  presentationScreen: 'Wall_Screen_2',
  screenFrameStyle: {
    color: 0x081017,
    emissive: 0x000000,
    emissiveIntensity: 0,
    roughness: .3,
    metalness: .16,
  },
  // Logical monitor bays = physical screens on that desk. The HUD draws one
  // selector per bay. Desk-2 has four stock assemblies; desk-1 hides 1 and 4
  // (MonScreen_2/3); desk-3 is the curved primary + small secondary.
  stationBays: {
    'operator-desk-1': 2,
    'operator-desk-2': 4,
    'operator-desk-3': 2,
  } as const,
  stationLayout: {
    kind: 'polar',
    stationIds: ['operator-desk-2', 'operator-desk-1', 'operator-desk-3'],
    count: 3,
    center: [0, 0],
    radius: 8,
    centerAngleDeg: -119,
    spacingDeg: 26,
  } satisfies StationLayout,
  overview: {
    radiusRatio: .3,
    heightRatio: .42,
    targetHeightRatio: .12,
  },
  resetControl: {
    azimuthOffsetDeg: 34,
    radiusRatio: .82,
    heightRatio: .72,
  },
  // 36 radial floor lines, 10° each. Line 0 = world +X, increasing toward +Z.
  floor: {
    sectors: 36,
  },
} as const;
