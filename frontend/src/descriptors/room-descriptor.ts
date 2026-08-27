export interface ShellConfig {
  asset: string;
  scale?: number;
}

export interface StationSlotConfig {
  bay: string;
  device: string;
  widthM?: number;
}

export interface StationPlacementConfig {
  anchor?: string;
  position?: [number, number, number];
  rotationY?: number;
}

export interface StationConfig {
  id: string;
  label: string;
  prefab: string;
  placement: StationPlacementConfig;
  bays: StationSlotConfig[];
}

export interface WallDisplayConfig {
  id: string;
  nodes: string[];
  mode: 'spanned' | 'tiled' | 'single';
}

export interface ViewConfig {
  anchor?: string;
  position?: [number, number, number];
  target?: [number, number, number];
  fovDeg?: number;
}

export interface RoomDescriptor {
  schema: string;
  id: string;
  label: string;
  shell: ShellConfig;
  presentationScreen?: string;
  stations: StationConfig[];
  wallDisplays?: WallDisplayConfig[];
  views?: Record<string, ViewConfig>;
}

export function validateRoomDescriptor(descriptor: unknown): RoomDescriptor {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('Invalid room descriptor: Must be an object.');
  }
  const obj = descriptor as Partial<RoomDescriptor>;
  if (typeof obj.id !== 'string') throw new Error('Invalid room descriptor: Missing "id".');
  if (!obj.shell?.asset || typeof obj.shell.asset !== 'string') {
    throw new Error('Invalid room descriptor: Missing "shell.asset".');
  }
  if (!Array.isArray(obj.stations)) {
    throw new Error('Invalid room descriptor: Missing "stations" array.');
  }
  return obj as RoomDescriptor;
}
