/**
 * Level of detail over the DIGIPIN hierarchy: CellStore.rollup/loadAt and
 * CellLayers.targetLevel / fieldAtLevel / levelOptions.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const CS = globalThis.CellStore;
const CL = globalThis.CellLayers;
const D = globalThis.DigiPin;

const SPEC = {
    id: 'demo', title: 'Demo', level: 7,
    fields: [
        { key: 'risk', type: 'number', agg: 'max', domain: [0, 100] },
        { key: 'avg', type: 'number', agg: 'mean', domain: [0, 10] },
        { key: 'stops', type: 'number', agg: 'sum', domain: [0, 5] },
        { key: 'n', type: 'number', agg: 'count', domain: [0, 3] },
        { key: 'cls', type: 'category', agg: 'mode', domain: ['a', 'b'] },
        { key: 'flag', type: 'boolean', agg: 'any' },
    ],
};

// Four L7 cells: three share an L6 parent, one sits in a different parent.
const p6 = D.encodeLevel(22.7196, 75.8577, 6);
const kids = D.children(p6);
const other6 = D.neighbor(p6, 'e');
const TABLE = {
    level: 7,
    cells: [kids[0], kids[1], kids[2], D.children(other6)[0]],
    columns: {
        risk: [10, 90, null, 40],
        avg: [2, 4, 9, 1],
        stops: [1, 2, 3, 4],
        n: [1, 1, 2, 5],
        cls: ['a', 'b', 'b', 'a'],
        flag: [false, true, false, false],
    },
};

describe('CellStore.rollup', () => {
    it('aggregates children into parents with each field\'s agg', () => {
        const t = CS.rollup(SPEC, TABLE, 6);
        expect(t.level).toBe(6);
        expect(t.nativeLevel).toBe(7);
        expect(t.cells).toEqual([p6, other6].sort());
        const i = t.cells.indexOf(p6);
        expect(t.counts[i]).toBe(3);
        expect(t.columns.risk[i]).toBe(90);      // max, null ignored
        expect(t.columns.avg[i]).toBe(5);        // equal-area mean of 2, 4, 9
        expect(t.columns.stops[i]).toBe(6);      // sum
        expect(t.columns.n[i]).toBe(4);          // counts add up
        expect(t.columns.cls[i]).toBe('b');      // mode
        expect(t.columns.flag[i]).toBe(true);    // any
        const j = t.cells.indexOf(other6);
        expect(t.counts[j]).toBe(1);
        expect(t.columns.risk[j]).toBe(40);
    });

    it('rolls straight up several levels', () => {
        const t = CS.rollup(SPEC, TABLE, 4);
        expect(t.cells).toEqual([...new Set(TABLE.cells.map(c => c.slice(0, 4)))].sort());
        expect(t.counts.reduce((a, b) => a + b, 0)).toBe(4);
    });

    it('returns the table unchanged at or below its own level', () => {
        expect(CS.rollup(SPEC, TABLE, 7)).toBe(TABLE);
        expect(CS.rollup(SPEC, TABLE, 9)).toBe(TABLE);
    });

    it('toGeoJSON carries the rolled level and child count', () => {
        const fc = CS.toGeoJSON(SPEC, CS.rollup(SPEC, TABLE, 6), 'risk');
        const f = fc.features.find(x => x.properties.digipin === D.format(p6));
        expect(f.properties.level).toBe(6);
        expect(f.properties.cells).toBe(3);
        const ring = f.geometry.coordinates[0];
        const b = D.cellBounds(p6).bounds;
        expect(ring[0]).toEqual([b.west, b.south]);
    });
});

describe('CellStore.loadAt + rowAt(level)', () => {
    beforeEach(() => {
        CS.register({ ...SPEC, id: 'lod_demo' }, JSON.parse(JSON.stringify(TABLE)));
    });

    it('serves the native table or a cached roll-up', async () => {
        const native = await CS.loadAt('lod_demo', 7);
        expect(native.level).toBe(7);
        const a = await CS.loadAt('lod_demo', 6);
        const b = await CS.loadAt('lod_demo', 6);
        expect(a.level).toBe(6);
        expect(a).toBe(b);
    });

    it('rowAt with a level returns the parent row', async () => {
        const c = D.cellBounds(kids[0]);
        const row = await CS.rowAt('lod_demo', c.lat, c.lng, 6);
        expect(row.digipin).toBe(D.format(p6));
        expect(row.level).toBe(6);
        expect(row.cells).toBe(3);
        expect(row.risk).toBe(90);
        const fine = await CS.rowAt('lod_demo', c.lat, c.lng);
        expect(fine.risk).toBe(10);
    });

});

describe('CellLayers level of detail', () => {
    it('targetLevel follows the zoom, never finer than the data', () => {
        expect(CL.targetLevel(SPEC, 17)).toBe(7);    // native cap
        expect(CL.targetLevel(SPEC, 13)).toBe(7);    // grid L6 + 1
        expect(CL.targetLevel(SPEC, 11)).toBe(6);
        expect(CL.targetLevel(SPEC, 9)).toBe(5);
        expect(CL.targetLevel(SPEC, 3)).toBe(2);
        expect(CL.targetLevel(SPEC, 9, 7)).toBe(7);  // pinned
        expect(CL.targetLevel(SPEC, 9, 9)).toBe(7);  // pin clamped to native
    });

    it('fieldAtLevel re-derives sum/count domains for roll-ups only', () => {
        const rolled = CS.rollup(SPEC, TABLE, 6);
        const stops = SPEC.fields[2];
        expect(CL.fieldAtLevel(stops, rolled).domain).toEqual([4, 6]);
        expect(CL.fieldAtLevel(stops, TABLE)).toBe(stops);
        expect(CL.fieldAtLevel(SPEC.fields[0], rolled)).toBe(SPEC.fields[0]);
    });

    it('levelOptions + levelNote describe the shown level', () => {
        const opts = CL.levelOptions(SPEC, { level: 6, pinned: null });
        expect(opts[0]).toMatchObject({ value: 0, selected: true });
        expect(opts.map(o => o.value)).toEqual([0, 7, 6, 5, 4, 3]);
        expect(opts[1].label).toContain('native');
        expect(CL.levelNote(SPEC, { level: 6 })).toBe('DIGIPIN L6 · ~978 m cells · rolled up from L7');
        expect(CL.levelNote(SPEC, { level: 7 })).toBe('DIGIPIN L7 · ~245 m cells');
    });
});

describe('CellStore.rollup (temporal)', () => {
    it('aggregates each time step separately', () => {
        const spec = { id: 't', level: 7, time: { steps: ['2016', '2023'] },
            fields: [{ key: 'b', type: 'number', agg: 'mean' }, { key: 's', type: 'number', agg: 'sum' }] };
        const table = { level: 7, cells: [kids[0], kids[1]], columns: { b: [[10, 20], [30, null]], s: [[1, 2], [3, 4]] } };
        const t = CS.rollup(spec, table, 6);
        expect(t.columns.b[0]).toEqual([20, 20]);
        expect(t.columns.s[0]).toEqual([4, 6]);
    });
});

describe('CellStore.viewParts', () => {
    const indore = { south: 22.6, north: 22.85, west: 75.75, east: 76.0 };
    const delhi = { south: 28.4, north: 28.9, west: 76.8, east: 77.4 };
    const shardKeys = D.cover(indore, 4);
    const spec = {
        id: 'v', level: 7, fields: [], regions: [
            { name: 'indore', bbox: indore, json: 'v/indore/{prefix}.json', shards: { prefixLen: 4, keys: shardKeys } },
            { name: 'delhi', bbox: delhi, json: 'v/delhi.json' },
        ],
    };

    it('drops regions whose bbox misses the view', () => {
        const parts = CS.viewParts(spec, delhi);
        expect(parts).toHaveLength(1);
        expect(parts[0].url).toContain('v/delhi.json');
    });

    it('keeps only the shards under the view', () => {
        const small = { south: 22.72, north: 22.73, west: 75.85, east: 75.86 };
        const parts = CS.viewParts(spec, small);
        expect(parts.map(p => p.key)).toEqual([D.encodeLevel(22.725, 75.855, 4)]);
    });

    it('with no bbox, every part', () => {
        expect(CS.viewParts(spec, null)).toHaveLength(shardKeys.length + 1);
    });
});
