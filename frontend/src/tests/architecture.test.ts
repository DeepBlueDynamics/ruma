import { describe, it } from 'vitest';

import { AssetCache } from '../assets/cache';
import { BootSource, OffSource } from '../content/source';
import { RoomDescriptor, validateRoomDescriptor } from '../descriptors/room-descriptor';
import { normalizeSectionSources, WALL_SECTION_COUNT } from '../display/section-source';
import { cssColor, normalizeCell, normalizeGridRows, paneChrome } from '../hyperia/protocol';
import { packTabTiles } from '../hyperia/tab-stream';
import { panoramicTheaterRoom } from '../config/rooms/panoramic-theater';
import { normalizeBays, StateStoreV3 } from '../state/store';
import { nextSpawnedDeskStationId, normalizeClosedDesks, normalizeSpawnedDesks, spawnedDeskOrdinal } from '../state/spawned-desks';

/**
 * These assertions used to be `console.assert`, which neither throws nor sets a
 * non-zero exit code — the suite could not fail. `assert` below throws, and the
 * checks are driven by both entry points: `vitest run` (CI) and
 * `window.runArchitectureTests()` (the browser console).
 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Check {
  name: string;
  run: () => void;
}

export const architectureChecks: Check[] = [
  {
    name: 'RoomDescriptor validation',
    run: () => {
      const validDescriptor: RoomDescriptor = {
        schema: 'ops-room/room@1',
        id: 'test-room',
        label: 'Test Operations Room',
        shell: { asset: '/assets/test_room.glb', scale: 1 },
        stations: [
          {
            id: 'station-1',
            label: 'Station 1',
            prefab: 'standing-desk',
            placement: { position: [0, 0, 0] },
            bays: [{ bay: '1', device: 'builtin-flat' }],
          },
        ],
      };

      const validated = validateRoomDescriptor(validDescriptor);
      assert(validated.id === 'test-room', 'RoomDescriptor ID mismatch');
    },
  },
  {
    name: 'StateStoreV3 persistence and migration',
    run: () => {
      const store = StateStoreV3.getInstance();
      const roomState = store.getRoomState('test-room');
      assert(roomState.roomId === 'test-room', 'RoomState ID mismatch');

      store.updateStationState('test-room', 'station-1', { heightM: 0.95 });
      const stationState = store.getStationState('test-room', 'station-1');
      assert(stationState.heightM === 0.95, 'Station height update mismatch');
    },
  },
  {
    name: 'ContentSource lifecycles',
    run: () => {
      const offSource = new OffSource();
      const bootSource = new BootSource();
      assert(offSource.kind === 'off', 'OffSource kind mismatch');
      assert(bootSource.kind === 'boot', 'BootSource kind mismatch');
    },
  },
  {
    name: 'AssetCache singleton',
    run: () => {
      assert(AssetCache.getInstance() === AssetCache.getInstance(), 'AssetCache singleton mismatch');
    },
  },
  {
    name: 'Desk-2 four-bay StateStoreV3 slots',
    run: () => {
      // A stale 2-bay blob pads up to four; normalizeBays must never shrink.
      const padded = normalizeBays(
        [{ paneId: 'pane-a', powered: true }, { paneId: 'pane-b', powered: false }],
        4,
      );
      assert(padded.length === 4, 'desk-2 bay pad length');
      assert(padded[0].bayId === 'm1' && padded[3].bayId === 'm4', 'bayId');
      assert(
        padded[0].paneId === 'pane-a' && padded[2].paneId === '' && padded[3].paneId === '',
        'padded pane ids',
      );

      const storeDesk2 = StateStoreV3.getInstance()
        .getStationState('panoramic-theater', 'operator-desk-2', 4);
      assert(storeDesk2.bays.length >= 4, 'operator-desk-2 must expose 4 bays');
      assert(storeDesk2.bays.every((bay, i) => bay.bayIndex === i + 1), 'bayIndex sequence');

      assert(panoramicTheaterRoom.stationBays['operator-desk-1'] === 2, 'desk-1 is two monitors');
      assert(panoramicTheaterRoom.stationBays['operator-desk-2'] === 4, 'desk-2 is four monitors');
      assert(panoramicTheaterRoom.stationBays['operator-desk-3'] === 2, 'desk-3 is two monitors');
    },
  },
  {
    name: 'Wall sections restore as the pane/tab/null source union',
    run: () => {
      // Legacy placeholder-catalog blobs ('terminal:*') must degrade to a
      // disconnected (picker) section — never crash, never survive as a source.
      const migrated = normalizeSectionSources([
        { kind: 'terminal', terminalId: 'terminal:legacy.left' },
        { kind: 'pane', paneId: 'pane-a' },
        { kind: 'tab', tabId: 'tab-b' },
        { kind: 'terminal', terminalId: 'terminal:legacy.war' },
      ]);
      assert(migrated.length === WALL_SECTION_COUNT, 'sections are always 4 slots');
      assert(migrated[0] === null, 'legacy terminal entry must migrate to disconnected');
      assert(migrated[1]?.kind === 'pane' && migrated[1].paneId === 'pane-a', 'pane source survives');
      assert(migrated[2]?.kind === 'tab' && migrated[2].tabId === 'tab-b', 'tab source survives');
      assert(migrated[3] === null, 'legacy terminal entry must migrate to disconnected');
    },
  },
  {
    name: 'Wall sections seed four disconnected slots',
    run: () => {
      assert(WALL_SECTION_COUNT === 4, 'main screen has four sections');
      const seeded = normalizeSectionSources(null);
      assert(seeded.length === 4 && seeded.every(source => source === null), 'fresh seed is four disconnected sections');
      const garbage = normalizeSectionSources([{ kind: 'pane' }, 'nonsense', 17, { kind: 'tab', tabId: '' }, { kind: 'pane', paneId: 'extra' }]);
      assert(garbage.length === 4, 'oversized blobs clamp to four slots');
      assert(garbage.every(source => source === null), 'malformed entries degrade to disconnected');
    },
  },
  {
    name: 'Spawned-desk registry normalization',
    run: () => {
      // Malformed, duplicate, mismatched and unknown-variant entries degrade
      // to nothing — a bad blob must never crash boot or spawn ghosts.
      const records = normalizeSpawnedDesks([
        { stationId: 'viewer2-desk-1', display: 2, variant: '3-up' },
        { stationId: 'viewer2-desk-1', display: 2, variant: '4-up' },          // duplicate id
        { stationId: 'viewer1-desk-2', display: 3, variant: '4-up' },          // display/id mismatch
        { stationId: 'viewer3-desk-1', display: 3, variant: 'mega-wall' },     // unknown variant
        { stationId: 'operator-desk-1', display: 1, variant: '3-up' },         // not a spawned id
        { stationId: 'viewer1-desk-0', display: 1, variant: '3-up' },          // ordinals start at 1
        'nonsense', 17, null,
        { stationId: 'viewer1-desk-3', display: 1, variant: 'curved+side' },
      ]);
      assert(records.length === 2, 'only well-formed unique records survive');
      assert(records[0].stationId === 'viewer2-desk-1' && records[0].variant === '3-up', 'first writer wins on duplicates');
      assert(records[1].stationId === 'viewer1-desk-3', 'valid record survives among garbage');

      assert(normalizeSpawnedDesks(null).length === 0 && normalizeSpawnedDesks('{}').length === 0, 'non-array blobs degrade to empty');

      // Ids reuse the smallest free per-display ordinal.
      assert(nextSpawnedDeskStationId(records, 1) === 'viewer1-desk-1', 'display 1 reuses ordinal 1');
      assert(nextSpawnedDeskStationId(records, 2) === 'viewer2-desk-2', 'display 2 skips its live desk');
      assert(spawnedDeskOrdinal('viewer1-desk-3') === 3 && spawnedDeskOrdinal('garbage') === 0, 'ordinal parsing');
    },
  },
  {
    name: 'Closed built-in desks normalize to unique operator-desk ids',
    run: () => {
      assert(normalizeClosedDesks(null).length === 0 && normalizeClosedDesks('junk').length === 0, 'non-array blobs degrade to empty');
      const cleaned = normalizeClosedDesks(['operator-desk-1', 'operator-desk-1', 'viewer1-desk-1', 42, 'operator-desk-3']);
      assert(cleaned.length === 2 && cleaned.includes('operator-desk-1') && cleaned.includes('operator-desk-3'),
        'dedupes and drops non-builtin entries');
    },
  },
  {
    name: 'Wall grid row normalization',
    run: () => {
      // Wall keyframes may omit y — the row index is then implicit.
      const rows = normalizeGridRows([
        { cells: [['A', 'default', 'default', 0]] },
        { y: 3, cells: [['B', 'default', 'default', 0]] },
        [['C', 'default', 'default', 0]],
      ]);
      assert(rows[0].y === 0 && rows[1].y === 3 && rows[2].y === 2, 'row y normalization');
    },
  },
  {
    name: 'Cell color mapping',
    run: () => {
      // default | idx:N | #rrggbb — the wall and /ws/tab encodings are identical.
      assert(cssColor('default', '#d7e2ea') === '#d7e2ea', 'default fg');
      assert(cssColor('idx:1', '#fff') === '#cd3131', 'idx:1');
      assert(cssColor('#00ff88', '#fff') === '#00ff88', 'truecolor');
      assert(cssColor('#0f8', '#fff') === '#00ff88', 'short hex');

      const cell = normalizeCell(['A', 'idx:4', '#112233', 7]);
      assert(
        cell[0] === 'A' && cell[1] === 'idx:4' && cell[2] === '#112233' && cell[3] === 7,
        'normalizeCell',
      );
    },
  },
  {
    name: 'Pane name vs title',
    run: () => {
      // layout.name is stable; title is an OSC fallback only.
      const withName = paneChrome({
        name: 'Brave Skink 🥐',
        title: 'nvim',
        paneId: '1bdec296-db04-40db-bb85-f1796d9a2961',
      });
      assert(
        withName.namedFromLayout && withName.name === 'Brave Skink 🥐' && withName.title === 'nvim',
        'name vs title',
      );

      const pre179 = paneChrome({
        title: 'Brave Skink 🥐',
        paneId: '1bdec296-db04-40db-bb85-f1796d9a2961',
      });
      assert(!pre179.namedFromLayout && pre179.name === 'Brave Skink 🥐', 'title fallback');

      const empty = paneChrome({ paneId: '1bdec296-db04-40db-bb85-f1796d9a2961' });
      assert(empty.name === '1bdec296', 'uuid-slice fallback');
    },
  },
  {
    name: 'Tab tile packing gives every pane its own tile',
    run: () => {
      // NOTE: packTabTiles (tab-stream.ts:152) deliberately DISCARDS the BSP
      // rects and lays every pane out as a full-width row. The assertions below
      // are the invariants that survive that choice — every pane keeps a tile,
      // no two tiles coincide, nothing leaves the 0..100 box. If someone
      // restores BSP-faithful packing, the strategy check further down fires and
      // forces the decision to be made on purpose.
      const input = [
        { paneId: 'skink', x: 0, y: 0, w: 50, h: 31 },
        { paneId: 'snake', x: 50, y: 50, w: 50, h: 50 },
        { paneId: 'koi', x: 0, y: 0, w: 100, h: 100 },
        { paneId: 'louse', x: 0, y: 0, w: 100, h: 100 },
        { paneId: 'prawn', x: 0, y: 31, w: 50, h: 69 },
        { paneId: 'toucan', x: 50, y: 0, w: 50, h: 50 },
        { paneId: 'rabbit', x: 0, y: 0, w: 100, h: 100 },
      ];
      const packed = packTabTiles(input);
      const byId = Object.fromEntries(packed.map(pane => [pane.paneId, pane]));

      assert(packed.length === input.length, 'expected a tile per pane');
      for (const pane of input) {
        assert(Boolean(byId[pane.paneId]), `pane ${pane.paneId} lost its tile`);
      }

      const rects = new Set(packed.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
      assert(rects.size === input.length, 'two panes share a tile origin');

      for (const p of packed) {
        assert(p.w > 0 && p.h > 0, `tile ${p.paneId} has no area`);
        assert(p.x >= 0 && p.y >= 0, `tile ${p.paneId} starts outside the tab`);
        assert(p.x + p.w <= 100.001, `tile ${p.paneId} overflows horizontally`);
        assert(p.y + p.h <= 100.001, `tile ${p.paneId} overflows vertically`);
      }
    },
  },
  {
    name: 'Repairs the live Protocol Volatile Lobster tab layout',
    run: () => {
      // Captured from Hyperia sidecar 0.17.38 on 2026-08-26, window 2267x1384.
      // The tab really is two columns: three panes stacked left, two right.
      // The sidecar reported it as four quadrants — the left column's rects
      // still describe the two-pane column it was before Afraid Rabbit joined,
      // and Rabbit itself got the full-tab default. Hyperia's own tab_image
      // drew four boxes for five panes and painted two labels on one rect.
      const packed = packTabTiles([
        { paneId: 'ostrich', x: 0, y: 0, w: 50, h: 50, cols: 136, rows: 20 },
        { paneId: 'scallop', x: 0, y: 50, w: 50, h: 50, cols: 136, rows: 20 },
        { paneId: 'rabbit', x: 0, y: 0, w: 100, h: 100, cols: 136, rows: 20 },
        { paneId: 'sparrow', x: 50, y: 0, w: 50, h: 50, cols: 136, rows: 32 },
        { paneId: 'chimp', x: 50, y: 50, w: 50, h: 50, cols: 136, rows: 32 },
      ]);
      const byId = Object.fromEntries(packed.map(pane => [pane.paneId, pane]));

      assert(packed.length === 5, 'lost a pane');

      // Two columns, not one stack of five.
      const xs = new Set(packed.map(p => Math.round(p.x)));
      assert(xs.has(0) && xs.has(50) && xs.size === 2, 'did not recover two columns');
      assert(packed.every(p => Math.round(p.w) === 50), 'columns are not half width');

      // Rabbit belongs to the left column: its 20-row cadence matches the
      // 20-row panes, not the 32-row ones. Matching on cols alone cannot tell
      // the columns apart here — both are 136 wide.
      assert(Math.round(byId.rabbit.x) === 0, 'Rabbit was slotted into the wrong column');

      // Left column divides three ways, right column two ways.
      for (const id of ['ostrich', 'scallop', 'rabbit']) {
        assert(Math.abs(byId[id].h - (100 / 3 - .4)) < 1, `left column pane ${id} is not a third`);
      }
      for (const id of ['sparrow', 'chimp']) {
        assert(Math.abs(byId[id].h - (50 - .4)) < 1, `right column pane ${id} is not a half`);
      }

      // The thing the sidecar got wrong: nothing may share a rect.
      const origins = new Set(packed.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
      assert(origins.size === 5, 'two panes still share an origin');
      for (const p of packed) {
        assert(p.x + p.w <= 100.001 && p.y + p.h <= 100.001, `tile ${p.paneId} overflows`);
      }
    },
  },
  {
    name: 'Reconstruction lands on the rect the buggy walker did set',
    run: () => {
      // Live capture, sidecar 0.17.38, 2026-08-26. Left column rows 22/20/17,
      // right 32/32. Rabbit is the 3rd stack child children[0..1] never reached.
      //
      // Ostrich IS ground truth: it is children[0] of the left group, so the
      // walker set its rect correctly at h=37. Scallop's h=63 is children[1]
      // holding the un-split remainder — the pre-split union of Scallop+Rabbit.
      // The reconstruction has to reproduce both.
      const packed = packTabTiles([
        { paneId: 'ostrich', x: 0, y: 0, w: 50, h: 37, cols: 136, rows: 22 },
        { paneId: 'scallop', x: 0, y: 37, w: 50, h: 63, cols: 136, rows: 20 },
        { paneId: 'rabbit', x: 0, y: 0, w: 100, h: 100, cols: 136, rows: 17 },
        { paneId: 'sparrow', x: 50, y: 0, w: 50, h: 50, cols: 136, rows: 32 },
        { paneId: 'chimp', x: 50, y: 50, w: 50, h: 50, cols: 136, rows: 32 },
      ]);
      const byId = Object.fromEntries(packed.map(pane => [pane.paneId, pane]));
      assert(packed.length === 5, 'lost a pane');

      // Tolerance 1.0 is deliberate: rows-only division is off by 0.29 here,
      // equal thirds by 3.67. This check exists to fail if the division stops
      // following row counts.
      assert(Math.abs(byId.ostrich.h - 37) < 1, `ostrich height ${byId.ostrich.h.toFixed(2)} != ~37`);
      assert(Math.abs(byId.scallop.y - 37) < 1, `scallop starts at ${byId.scallop.y.toFixed(2)}, not the real divider`);

      const union = byId.scallop.h + byId.rabbit.h + .4;
      assert(Math.abs(union - 63) < 1, `scallop+rabbit ${union.toFixed(2)} != ~63`);

      assert(byId.rabbit.h < byId.scallop.h && byId.scallop.h < byId.ostrich.h,
        'heights must follow row counts 22 > 20 > 17');
    },
  },
  {
    name: 'Refuses to invent a layout when the columns cannot be reconciled',
    run: () => {
      // Two placed columns of two panes each (rows 20/20 and 32/32) plus an
      // unplaced pane of 30 rows. By row cadence it lands in the 32-row column,
      // making that column 3 panes / 94 rows against 2 panes / 40 rows — which
      // requires NEGATIVE per-pane chrome, i.e. it is not a real column layout.
      // The right answer is to give up and stack, not to produce a confident
      // wrong grid.
      const packed = packTabTiles([
        { paneId: 'l1', x: 0, y: 0, w: 50, h: 50, cols: 136, rows: 20 },
        { paneId: 'l2', x: 0, y: 50, w: 50, h: 50, cols: 136, rows: 20 },
        { paneId: 'r1', x: 50, y: 0, w: 50, h: 50, cols: 136, rows: 32 },
        { paneId: 'r2', x: 50, y: 50, w: 50, h: 50, cols: 136, rows: 32 },
        { paneId: 'odd', x: 0, y: 0, w: 100, h: 100, cols: 136, rows: 30 },
      ]);
      assert(packed.length === 5, 'lost a pane');
      assert(packed.every(pane => pane.x === 0 && pane.w === 100),
        'expected the row-stack fallback, not a reconstructed grid');
      assert(new Set(packed.map(pane => pane.y.toFixed(1))).size === 5, 'two panes share a row');
    },
  },
  {
    name: 'Valid rects pass through untouched (Hyperia 0.17.40+)',
    run: () => {
      // Once the BSP walker visits every child, nothing needs repairing and the
      // fast path must return the sidecar's own geometry unchanged.
      const input = [
        { paneId: 'a', x: 0, y: 0, w: 50, h: 33.3, cols: 136, rows: 22 },
        { paneId: 'b', x: 0, y: 33.3, w: 50, h: 33.3, cols: 136, rows: 20 },
        { paneId: 'c', x: 0, y: 66.6, w: 50, h: 33.4, cols: 136, rows: 17 },
        { paneId: 'd', x: 50, y: 0, w: 50, h: 50, cols: 136, rows: 32 },
        { paneId: 'e', x: 50, y: 50, w: 50, h: 50, cols: 136, rows: 32 },
      ];
      const packed = packTabTiles(input);
      const byId = Object.fromEntries(packed.map(pane => [pane.paneId, pane]));
      for (const pane of input) {
        const out = byId[pane.paneId];
        assert(out.x === pane.x && out.y === pane.y && out.w === pane.w && out.h === pane.h,
          `pane ${pane.paneId} was rewritten when its rect was already valid`);
      }
    },
  },
  {
    name: 'splitLabel decides column order when the feed carries it',
    run: () => {
      // Not sent by 0.17.38, but authoritative when present — it removes the
      // one thing the repair cannot otherwise know: where in the column the
      // unpositioned pane actually sits.
      const packed = packTabTiles([
        { paneId: 'top', x: 0, y: 0, w: 50, h: 50, cols: 136, rows: 20, splitLabel: 'a' },
        { paneId: 'mid', x: 0, y: 0, w: 100, h: 100, cols: 136, rows: 20, splitLabel: 'b' },
        { paneId: 'bot', x: 0, y: 50, w: 50, h: 50, cols: 136, rows: 20, splitLabel: 'c' },
        { paneId: 'right', x: 50, y: 0, w: 50, h: 100, cols: 136, rows: 32, splitLabel: 'd' },
      ]);
      const byId = Object.fromEntries(packed.map(pane => [pane.paneId, pane]));
      assert(byId.top.y < byId.mid.y && byId.mid.y < byId.bot.y,
        'splitLabel order ignored — repaired pane was appended instead of placed');
    },
  },
  {
    name: 'Falls back to a row stack when the rects cannot be repaired',
    run: () => {
      // Every rect is the full-tab default, so there is nothing to anchor a
      // column to. Better an ugly stack than a hidden pane.
      const packed = packTabTiles([
        { paneId: 'a', x: 0, y: 0, w: 100, h: 100, cols: 80, rows: 24 },
        { paneId: 'b', x: 0, y: 0, w: 100, h: 100, cols: 80, rows: 24 },
        { paneId: 'c', x: 0, y: 0, w: 100, h: 100, cols: 80, rows: 24 },
      ]);
      assert(packed.length === 3, 'hid a pane');
      assert(packed.every(p => p.x === 0 && p.w === 100), 'expected the full-width fallback');
      assert(new Set(packed.map(p => p.y.toFixed(1))).size === 3, 'still stacking at one rect');
    },
  },
  {
    name: 'Tab tile packing is a uniform full-width row stack',
    run: () => {
      // The fallback path: no cols/rows on these panes, so the layout cannot be
      // reconstructed and packTabTiles lays out uniform full-width rows.
      const packed = packTabTiles([
        { paneId: 'a', x: 0, y: 0, w: 50, h: 31 },
        { paneId: 'b', x: 50, y: 0, w: 50, h: 69 },
        { paneId: 'c', x: 0, y: 31, w: 50, h: 69 },
      ]);

      assert(packed.every(p => p.x === 0 && p.w === 100), 'rows are not full width');
      const heights = new Set(packed.map(p => p.h.toFixed(6)));
      assert(heights.size === 1, 'rows are not uniform height');
      const ys = packed.map(p => p.y);
      assert(ys.every((y, i) => i === 0 || y > ys[i - 1]), 'rows are not in order');
    },
  },
  {
    name: 'Full-tab collisions auto-grid by paneId',
    run: () => {
      // 2+ panes sharing the default full-tab rect must auto-grid, never hide.
      const stuck = packTabTiles([
        { paneId: 'prawn', x: 0, y: 0, w: 100, h: 100 },
        { paneId: 'koi', x: 0, y: 0, w: 100, h: 100 },
        { paneId: 'rabbit', x: 0, y: 0, w: 100, h: 100 },
      ]);

      assert(stuck.length === 3, 'hidden a received pane');
      const stuckKeys = new Set(stuck.map(pane => `${pane.x.toFixed(1)},${pane.y.toFixed(1)}`));
      assert(stuckKeys.size === 3, 'still stacking at one rect');
      assert(stuck.every(pane => pane.w < 100 || pane.h < 100), 'left a full-tab stack');
    },
  },
];

describe('architecture', () => {
  for (const check of architectureChecks) {
    it(check.name, check.run);
  }
});

/** Browser entry point: `window.runArchitectureTests()`. Throws on first failure. */
export function runArchitectureTests(): void {
  console.log('--- Running Architecture Integration Tests ---');
  for (const check of architectureChecks) {
    check.run();
    console.log(`✔ ${check.name}`);
  }
  console.log('--- All Architecture Tests Passed Successfully! ---');
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).runArchitectureTests = runArchitectureTests;
}
