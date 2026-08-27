export interface MonitorBayState {
  bayIndex: number;
  /** Stable slot id (`m1`…`m4`). Survives bay reordering better than array position. */
  bayId: string;
  paneId: string;
  powered: boolean;
}

export interface StationState {
  stationId: string;
  heightM: number;
  selectedMonitor: number;
  expandedTabId: string;
  hudScroll: number;
  bays: MonitorBayState[];
}

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

export interface RoomState {
  roomId: string;
  selectedStationId: string;
  camera?: CameraState;
  stations: Record<string, StationState>;
}

export interface OpsRoomStateV3 {
  version: 3;
  activeRoomId: string;
  rooms: Record<string, RoomState>;
}

const STORAGE_KEY_V3 = 'ops-room-store-v3';

export function bayIdForIndex(bayIndex: number): string {
  return `m${bayIndex}`;
}

export function emptyBay(bayIndex: number): MonitorBayState {
  return { bayIndex, bayId: bayIdForIndex(bayIndex), paneId: '', powered: false };
}

export function bayByIndex(station: StationState, bayIndex: number): MonitorBayState | undefined {
  return station.bays.find(bay => bay.bayIndex === bayIndex);
}

/**
 * Canonical bay list keyed by `bayIndex`. Pads up to `monitorCount` and never
 * drops a higher-index bay that already exists (desk-2 is four slots; a stale
 * two-bay blob must grow, not the other way around).
 */
export function normalizeBays(
  bays: ReadonlyArray<Partial<MonitorBayState> & { bayIndex?: number }>,
  monitorCount: number,
): MonitorBayState[] {
  const byIndex = new Map<number, MonitorBayState>();
  bays.forEach((bay, ordinal) => {
    const bayIndex = Number.isInteger(bay.bayIndex) && (bay.bayIndex as number) >= 1
      ? (bay.bayIndex as number)
      : ordinal + 1;
    byIndex.set(bayIndex, {
      bayIndex,
      bayId: typeof bay.bayId === 'string' && bay.bayId ? bay.bayId : bayIdForIndex(bayIndex),
      paneId: typeof bay.paneId === 'string' ? bay.paneId : '',
      powered: bay.powered === true,
    });
  });
  const highest = Math.max(monitorCount, ...byIndex.keys(), 0);
  const next: MonitorBayState[] = [];
  for (let index = 1; index <= highest; index++) next.push(byIndex.get(index) ?? emptyBay(index));
  return next;
}

function ensureBays(station: StationState, monitorCount: number): boolean {
  const next = normalizeBays(station.bays, monitorCount);
  const changed = next.length !== station.bays.length || next.some((bay, i) => {
    const prev = station.bays[i];
    return !prev
      || prev.bayIndex !== bay.bayIndex
      || prev.bayId !== bay.bayId
      || prev.paneId !== bay.paneId
      || prev.powered !== bay.powered;
  });
  station.bays = next;
  return changed;
}

function blankStation(stationId: string, monitorCount: number): StationState {
  return {
    stationId,
    heightM: 0.72,
    selectedMonitor: 1,
    expandedTabId: '',
    hudScroll: 0,
    bays: Array.from({ length: Math.max(1, monitorCount) }, (_, i) => emptyBay(i + 1)),
  };
}

export class StateStoreV3 {
  private static instance: StateStoreV3;
  private state: OpsRoomStateV3;

  private constructor() {
    this.state = this.loadAndMigrate();
  }

  static getInstance(): StateStoreV3 {
    if (!StateStoreV3.instance) {
      StateStoreV3.instance = new StateStoreV3();
    }
    return StateStoreV3.instance;
  }

  getState(): OpsRoomStateV3 {
    return this.state;
  }

  getRoomState(roomId: string): RoomState {
    if (!this.state.rooms[roomId]) {
      this.state.rooms[roomId] = {
        roomId,
        selectedStationId: 'operator-desk-1',
        stations: {},
      };
    }
    return this.state.rooms[roomId];
  }

  getStationState(roomId: string, stationId: string, monitorCount = 2): StationState {
    const roomState = this.getRoomState(roomId);
    if (!roomState.stations[stationId]) {
      roomState.stations[stationId] = blankStation(stationId, monitorCount);
      this.save();
      return roomState.stations[stationId];
    }
    if (ensureBays(roomState.stations[stationId], monitorCount)) this.save();
    return roomState.stations[stationId];
  }

  /** Pad/rewrite a station's bay slots to at least `monitorCount` (desk-2 = 4). */
  ensureStationBays(roomId: string, stationId: string, monitorCount: number): StationState {
    return this.getStationState(roomId, stationId, monitorCount);
  }

  updateStationState(
    roomId: string,
    stationId: string,
    update: Partial<StationState>,
    monitorCount?: number,
  ): void {
    const hinted = monitorCount ?? update.bays?.length;
    const current = this.getStationState(roomId, stationId, hinted && hinted > 0 ? hinted : 2);
    const incomingBays = update.bays;
    Object.assign(current, update);
    if (incomingBays) {
      current.bays = normalizeBays(incomingBays, hinted && hinted > 0 ? hinted : incomingBays.length);
    } else {
      ensureBays(current, hinted && hinted > 0 ? hinted : current.bays.length);
    }
    this.save();
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(this.state));
    } catch (err) {
      console.warn('StateStoreV3: Failed to persist to localStorage', err);
    }
  }

  private loadAndMigrate(): OpsRoomStateV3 {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_V3);
      if (raw) {
        const parsed = JSON.parse(raw) as OpsRoomStateV3;
        if (parsed.version === 3 && parsed.rooms) {
          for (const room of Object.values(parsed.rooms)) {
            for (const station of Object.values(room.stations ?? {})) {
              ensureBays(station, station.bays?.length ?? 2);
            }
          }
          return parsed;
        }
      }
    } catch { /* Fall through to migration */ }

    const migrated: OpsRoomStateV3 = {
      version: 3,
      activeRoomId: 'panoramic-theater',
      rooms: {
        'panoramic-theater': {
          roomId: 'panoramic-theater',
          selectedStationId: localStorage.getItem('ops-room-selected-desk-v1') || 'operator-desk-1',
          stations: {},
        },
      },
    };

    const targetRoom = migrated.rooms['panoramic-theater'];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('ops-room-station-')) continue;

      try {
        const stationId = key.replace('ops-room-station-', '').replace(/-v\d+$/, '');
        const val = JSON.parse(localStorage.getItem(key) ?? '{}') as {
          targets?: unknown;
          powered?: unknown;
          heightM?: unknown;
          heightMetres?: unknown;
          selectedMonitor?: unknown;
          expandedTabId?: unknown;
          hudScroll?: unknown;
        };
        const targets: string[] = Array.isArray(val.targets) ? val.targets.filter((id): id is string => typeof id === 'string') : [];
        const powered: boolean[] = Array.isArray(val.powered) ? val.powered.map(flag => flag === true) : [];
        const heightM = typeof val.heightM === 'number' ? val.heightM
          : typeof val.heightMetres === 'number' ? val.heightMetres
          : 0.72;
        // Desk-2's v2 blob is four targets; never coerce it down to two.
        const monitorCount = Math.max(targets.length, powered.length, stationId === 'operator-desk-2' ? 4 : 2);

        targetRoom.stations[stationId] = {
          stationId,
          heightM,
          selectedMonitor: typeof val.selectedMonitor === 'number' ? val.selectedMonitor : 1,
          expandedTabId: typeof val.expandedTabId === 'string' ? val.expandedTabId : '',
          hudScroll: typeof val.hudScroll === 'number' ? val.hudScroll : 0,
          bays: normalizeBays(
            targets.map((paneId, idx) => ({
              bayIndex: idx + 1,
              paneId,
              powered: powered[idx] === true,
            })),
            monitorCount,
          ),
        };
      } catch { /* Ignore malformed v2 keys */ }
    }

    return migrated;
  }
}
