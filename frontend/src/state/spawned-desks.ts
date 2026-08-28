/**
 * Operator-spawned desk registry. Pure (no DOM) so the persistence and id
 * rules stay in the testable layer — `main.ts` only wires this to
 * `localStorage` and the scene graph.
 */
export const SPAWNED_DESKS_KEY = 'ops-room/spawned-desks-v1';

export type SpawnedDeskVariant = '3-up' | 'curved+side' | '4-up';

export type SpawnedDeskRecord = {
  /** `viewer{display}-desk-{k}` — k is a per-display ordinal starting at 1. */
  stationId: string;
  /** Room display (wall viewer) the desk was spawned in front of. */
  display: 1 | 2 | 3;
  variant: SpawnedDeskVariant;
};

const VARIANTS: readonly SpawnedDeskVariant[] = ['3-up', 'curved+side', '4-up'];
const STATION_ID = /^viewer([1-3])-desk-([1-9]\d*)$/;

export function spawnedDeskStationId(display: number, ordinal: number): string {
  return `viewer${display}-desk-${ordinal}`;
}

/** The per-display ordinal `k` baked into `viewer{n}-desk-{k}`, or 0. */
export function spawnedDeskOrdinal(stationId: string): number {
  const match = STATION_ID.exec(stationId);
  return match ? Number(match[2]) : 0;
}

/**
 * Normalize a persisted registry blob. Entries that are not a well-formed
 * record — bad station id, display outside 1..3, display/id mismatch, unknown
 * variant, duplicate station id — are dropped, never throw.
 */
export function normalizeSpawnedDesks(parsed: unknown): SpawnedDeskRecord[] {
  if (!Array.isArray(parsed)) return [];
  const records: SpawnedDeskRecord[] = [];
  const seen = new Set<string>();
  for (const entry of parsed as Array<{ stationId?: unknown; display?: unknown; variant?: unknown } | null>) {
    if (!entry || typeof entry !== 'object') continue;
    const stationId = typeof entry.stationId === 'string' ? entry.stationId : '';
    const match = STATION_ID.exec(stationId);
    if (!match || seen.has(stationId)) continue;
    const display = Number(match[1]) as 1 | 2 | 3;
    if (entry.display !== display) continue;
    if (!VARIANTS.includes(entry.variant as SpawnedDeskVariant)) continue;
    seen.add(stationId);
    records.push({ stationId, display, variant: entry.variant as SpawnedDeskVariant });
  }
  return records;
}

/** Smallest unused per-display ordinal, so removed slots get reused. */
export function nextSpawnedDeskStationId(records: readonly SpawnedDeskRecord[], display: number): string {
  const used = new Set(records.filter(record => record.display === display).map(record => spawnedDeskOrdinal(record.stationId)));
  let ordinal = 1;
  while (used.has(ordinal)) ordinal++;
  return spawnedDeskStationId(display, ordinal);
}
