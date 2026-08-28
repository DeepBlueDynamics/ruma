/**
 * Wall-section content sources. Pure (no DOM) so the persistence/migration
 * rules stay in the testable layer — `VideoWallController` only wires this to
 * `localStorage`.
 *
 * `null` is a real state: the section is powered but disconnected, and the
 * wall renders its on-surface source picker there.
 */
export const WALL_SECTION_COUNT = 4;

export type SectionSource =
  | { kind: 'pane'; paneId: string }
  | { kind: 'tab'; tabId: string }
  | null;

/**
 * Normalize a persisted sections blob into exactly four slots. Anything that
 * is not a well-formed pane/tab source — including the retired
 * `{kind:'terminal'}` placeholder-catalog entries — degrades to `null`
 * (disconnected), never throws.
 */
export function normalizeSectionSources(parsed: unknown): SectionSource[] {
  const sources: SectionSource[] = Array.from({ length: WALL_SECTION_COUNT }, () => null);
  if (!Array.isArray(parsed)) return sources;
  for (let index = 0; index < WALL_SECTION_COUNT; index++) {
    const entry = parsed[index] as { kind?: unknown; paneId?: unknown; tabId?: unknown } | null | undefined;
    if (!entry || typeof entry !== 'object') continue;
    if (entry.kind === 'pane' && typeof entry.paneId === 'string' && entry.paneId) {
      sources[index] = { kind: 'pane', paneId: entry.paneId };
    } else if (entry.kind === 'tab' && typeof entry.tabId === 'string' && entry.tabId) {
      sources[index] = { kind: 'tab', tabId: entry.tabId };
    }
  }
  return sources;
}
