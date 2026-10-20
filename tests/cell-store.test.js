import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// CellStore + DigiPin are exposed by tests/setup.js.
const CS = globalThis.CellStore;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARITY = JSON.parse(readFileSync(path.join(__dirname, '../pipeline/cells/tests/bin_parity.json'), 'utf-8'));

const SPEC = {
    id: 'traffic', title: 'Traffic', level: 7, group: 'Cell Data',
    fields: [
        { key: 'risk', label: 'Risk', type: 'number', agg: 'max', domain: [0, 100], ramp: 'reds' },
        { key: 'los', label: 'LOS', type: 'category', agg: 'max', domain: ['A', 'F'] },
    ],
    default: { field: 'risk', extrude: false, heightM: 300 },
    regions: [{ name: 'indore_pilot', json: 'traffic/indore_pilot.json', parquet: 'traffic/indore_pilot.parquet' }],
};
const CODE = CS.cellCode(7, 22.7196, 75.8577);
const TABLE = { version: 1, level: 7, fields: ['risk', 'los'], cells: [CODE], columns: { risk: [80], los: ['F'] } };
const CATALOG = { version: 1, datasets: [SPEC] };

function mockFetch(routes) {
    return vi.fn(async (url) => {
        for (const [frag, body] of routes) {
            if (String(url).includes(frag)) {
                return body === 404 ? new Response('nf', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
            }
        }
        return new Response('nf', { status: 404 });
    });
}

beforeEach(() => { delete window.DIGIPIN_CONFIG; });
afterEach(() => { vi.restoreAllMocks(); });

describe('CellStore.binRecords() — parity with pipeline/cells/store.py', () => {
    for (const c of PARITY.cases) {
        it(`level ${c.level} matches the committed Python output`, () => {
            const t = CS.binRecords(PARITY.records, c.level, PARITY.fields);
            expect(t.cells).toEqual(c.cells);
            for (const [k, col] of Object.entries(c.columns)) {
                col.forEach((v, i) => {
                    if (typeof v === 'number') expect(t.columns[k][i]).toBeCloseTo(v, 9);
                    else expect(t.columns[k][i]).toEqual(v);
                });
            }
        });
    }
});

describe('CellStore.cellCode()', () => {
    it('truncates an existing code to its parent cell', () => {
        expect(CS.cellCode(6, null, null, '34P-LLM-PKT9')).toBe('34PLLM');
        expect(CS.cellCode(8, null, null, '34PLLM')).toBeNull();
    });
    it('encodes points and rejects ones outside India', () => {
        const full = DigiPin.encode(22.7196, 75.8577).replace(/-/g, '');
        expect(CS.cellCode(7, 22.7196, 75.8577)).toBe(full.slice(0, 7));
        expect(CS.cellCode(7, 1, 75)).toBeNull();
        expect(CS.cellCode(7, null, 75)).toBeNull();
    });
});

describe('CellStore.dataDomain()', () => {
    it('numbers → [min,max], categories → sorted uniques, booleans → null', () => {
        expect(CS.dataDomain({ type: 'number' }, [3, null, -1, 9])).toEqual([-1, 9]);
        expect(CS.dataDomain({ type: 'category' }, ['b', 'a', 'b', null])).toEqual(['a', 'b']);
        expect(CS.dataDomain({ type: 'boolean' }, [true])).toBeNull();
        expect(CS.dataDomain({ type: 'number' }, [null])).toBeNull();
    });
});

describe('CellStore catalog + load', () => {
    it('stays disabled when catalog.json 404s', async () => {
        globalThis.fetch = mockFetch([]);
        expect(await CS.init()).toBe(false);
        expect(CS.get('traffic')).toBeNull();
    });

    it('honours the kill switch without fetching', async () => {
        window.DIGIPIN_CONFIG = { cellStore: false };
        globalThis.fetch = vi.fn();
        expect(await CS.init()).toBe(false);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('loads the registry and a dataset table, and looks up a row by point', async () => {
        globalThis.fetch = mockFetch([['catalog.json', CATALOG], ['traffic/indore_pilot.json', TABLE]]);
        expect(await CS.init()).toBe(true);
        expect(CS.datasets().map(d => d.id)).toContain('traffic');
        expect(CS.field(CS.get('traffic'), 'los').type).toBe('category');
        const row = await CS.rowAt('traffic', 22.7196, 75.8577);
        expect(row).toEqual({ digipin: DigiPin.format(CODE), risk: 80, los: 'F' });
        expect(await CS.rowAt('traffic', 22.9, 75.99)).toBeNull();
    });

    it('versions region files by the catalog build stamp (no stamp, no query)', async () => {
        globalThis.fetch = mockFetch([['catalog.json', { ...CATALOG, generated: '2026-10-20T19:37:12Z' }]]);
        await CS.init();
        expect(CS.tableUrl({ json: 'traffic/indore_pilot.json' }))
            .toBe('data/cells/traffic/indore_pilot.json?v=2026-10-20T19%3A37%3A12Z');
        globalThis.fetch = mockFetch([['catalog.json', { ...CATALOG, generated: undefined }]]);
        await CS.init();
        expect(CS.tableUrl({ json: 'a.json' })).toBe('data/cells/a.json');
    });

    it('honours a cellsBase override', async () => {
        window.DIGIPIN_CONFIG = { cellsBase: 'https://cdn.example.com/cells/' };
        const f = mockFetch([['catalog.json', CATALOG]]);
        globalThis.fetch = f;
        await CS.init();
        expect(f.mock.calls[0][0]).toBe('https://cdn.example.com/cells/catalog.json');
    });
});

describe('CellStore.register() — runtime datasets', () => {
    it('registers a binned table with data-derived domains and survives re-init', async () => {
        const fields = [{ key: 'count', label: 'Count', type: 'number', agg: 'count' }];
        const t = CS.binRecords([{ lat: 22.72, lng: 75.85 }, { lat: 22.72, lng: 75.85 }], 8, fields);
        const spec = CS.register({ id: 'user_demo', title: 'Demo', level: 8, fields }, t);
        expect(spec.group).toBe('Ingested data');
        expect(spec.fields[0].domain).toEqual([2, 2]);
        expect(spec.default.field).toBe('count');
        expect(CS.isLocal('user_demo')).toBe(true);
        globalThis.fetch = mockFetch([]);
        await CS.init();
        expect((await CS.load('user_demo')).cells).toEqual(t.cells);
        expect(CS.unregister('user_demo')).toBe(true);
        expect(CS.get('user_demo')).toBeNull();
    });
});

describe('CellStore.toGeoJSON()', () => {
    it('emits one rectangle per non-null cell, with the row as properties', () => {
        const table = { level: 7, cells: [CODE, CODE.slice(0, 6) + 'C'], columns: { risk: [80, null], los: ['F', 'A'] } };
        const fc = CS.toGeoJSON(SPEC, table, 'risk');
        expect(fc.features).toHaveLength(1);
        const f = fc.features[0];
        expect(f.properties).toMatchObject({ risk: 80, los: 'F', digipin: DigiPin.format(CODE) });
        const ring = f.geometry.coordinates[0];
        expect(ring).toHaveLength(5);
        expect(ring[0]).toEqual(ring[4]);
        const b = DigiPin.decodePartial(CODE).bounds;
        expect(ring[0]).toEqual([b.west, b.south]);
        // No field filter → every cell; a far-away bbox → none.
        expect(CS.toGeoJSON(SPEC, table, null).features).toHaveLength(2);
        expect(CS.toGeoJSON(SPEC, table, null, { south: 10, north: 11, west: 70, east: 71 }).features).toHaveLength(0);
    });
});

describe('CellStore SQL view wiring', () => {
    it('builds one UNION ALL view per dataset over its parquet regions', () => {
        const stmts = CS.viewStatements([
            { view: 'traffic', file: 'traffic__a.parquet' },
            { view: 'traffic', file: 'traffic__b.parquet' },
            { view: 'scores', file: 'scores__a.parquet' },
        ]);
        expect(stmts).toEqual([
            `CREATE OR REPLACE VIEW "traffic" AS SELECT * FROM read_parquet('traffic__a.parquet') UNION ALL SELECT * FROM read_parquet('traffic__b.parquet')`,
            `CREATE OR REPLACE VIEW "scores" AS SELECT * FROM read_parquet('scores__a.parquet')`,
        ]);
    });

    it('lists parquet sources from the catalog as absolute URLs', async () => {
        globalThis.fetch = mockFetch([['catalog.json', CATALOG]]);
        await CS.init();
        const [s] = CS.sqlSources();
        expect(s.view).toBe('traffic');
        expect(s.file).toBe('traffic__indore_pilot.parquet');
        expect(s.url).toMatch(/^https?:\/\/.*data\/cells\/traffic\/indore_pilot\.parquet$/);
    });
});
