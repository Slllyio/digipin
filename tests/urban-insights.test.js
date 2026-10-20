import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// UrbanInsights, Analysis and DigiPin are exposed by tests/setup.js.
const U = globalThis.UrbanInsights;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CELLS = path.join(__dirname, '../data/cells');
const CATALOG = JSON.parse(readFileSync(path.join(CELLS, 'catalog.json'), 'utf-8'));

// The real CellStore over the committed data/cells files (fetch reads from disk,
// .json.gz included), so the engine is tested on exactly what the app loads.
const ROOT = path.join(__dirname, '..');
let realStore = null;
async function store() {
    if (realStore) return realStore;
    globalThis.fetch = async (url) => {
        const f = path.join(ROOT, String(url).split('?')[0]);
        if (!existsSync(f)) return new Response('not found', { status: 404 });
        return new Response(readFileSync(f), { status: 200 });
    };
    await globalThis.CellStore.init();
    realStore = globalThis.CellStore;
    return realStore;
}

// Tiny hand-made store: one city "town" of 8 L6 cells under 34PLL, one hot pair.
const CELLS6 = ['34PLL2', '34PLL3', '34PLL4', '34PLL5', '34PLL6', '34PLL7', '34PLL8', '34PLL9'];
const bboxOf = (codes) => {
    const bs = codes.map(c => globalThis.DigiPin.decodePartial(c).bounds);
    return { west: Math.min(...bs.map(b => b.west)), south: Math.min(...bs.map(b => b.south)),
        east: Math.max(...bs.map(b => b.east)), north: Math.max(...bs.map(b => b.north)) };
};
const SPEC = { id: 'scores', title: 'Scores', level: 6, source: 'test', regions: [{ name: 'town', bbox: bboxOf(CELLS6), cells: 8 }],
    fields: [
        { key: 'livability', label: 'Livability', type: 'number', higherIs: 'better' },
        { key: 'green', label: 'Green', type: 'number', higherIs: 'better' },
        { key: 'walkability', label: 'Walkability', type: 'number', higherIs: 'better' },
        { key: 'safety', label: 'Safety', type: 'number', higherIs: 'better' },
        { key: 'flood_risk', label: 'Flood risk', type: 'number', higherIs: 'worse' },
        { key: 'population_proxy', label: 'Population', type: 'number' },
    ] };
const TABLE = { level: 6, cells: CELLS6, columns: {
    livability: [20, 22, 24, 30, 26, 28, 21, 23],
    green: [10, 10, 10, 50, 10, 10, 10, 10],
    walkability: [20, 20, 20, 20, 20, 20, 20, 20],
    safety: [30, 30, 30, 30, 30, 30, 30, 30],
    flood_risk: [30, 32, 31, 90, 33, 29, 30, 31],
    population_proxy: [10, 20, 30, 40, 50, 60, 0, 10],
} };
TABLE.index = new Map(CELLS6.map((c, i) => [c, i]));
const fake = { datasets: () => [SPEC], get: (id) => (id === 'scores' ? SPEC : null), load: async () => TABLE, generated: () => null };
const NOW = () => new Date('2026-10-20T12:00:00Z');

describe('UrbanInsights maths', () => {
    it('percentile counts ties half and quantile interpolates', () => {
        expect(U.percentile([1, 2, 2, 3], 2)).toBe(0.5);
        expect(U.quantile([0, 10], 0.25)).toBe(2.5);
        expect(U.stats([1, null, 3, 'x']).mean).toBe(2);
    });
    it('labels regions and neighbours a cell 8 ways', () => {
        expect(U.cityLabel('indore_pilot')).toBe('Indore');
        const n = U.neighbours('34PLL5');
        expect(n).toHaveLength(8);
        expect(n).not.toContain('34PLL5');
    });
});

describe('UrbanInsights.areaInsights() on a hand-made city', () => {
    it('flags the flooded, greener cell against its city', async () => {
        const r = await U.areaInsights({ code: '34PLL5' }, fake, { now: NOW, perDataset: 10 });
        expect(r.city).toBe('town');
        const flood = r.findings.find(f => f.key === 'flood_risk');
        expect(flood.kind).toBe('concern');
        expect(flood.title).toMatch(/2\.\d× the Town average/);
        expect(flood.sources).toEqual(['scores']);
        const green = r.findings.find(f => f.key === 'green');
        expect(green.kind).toBe('strength');
        // Composite drivers: livability names green as its top driver.
        const liv = r.findings.find(f => f.key === 'livability');
        expect(liv.drivers.parts[0].key).toBe('green');
        expect(r.headline).toMatch(/stands out for/);
    });
    it('finds no differences in a field that is flat everywhere', async () => {
        const r = await U.areaInsights({ code: '34PLL5' }, fake);
        expect(r.findings.find(f => f.key === 'walkability')).toBeUndefined();
    });
});

describe('UrbanInsights on the committed data', () => {
    it('ranks findings for an Indore neighbourhood with trends from the monthly series', async () => {
        const scores = await (await store()).load('scores');
        const city = U.cellsInRegion(CATALOG.datasets.find(d => d.id === 'scores'), scores, 'indore_pilot');
        const busiest = city.slice().sort((a, b) => scores.columns.population_proxy[b] - scores.columns.population_proxy[a])[0];
        const code5 = scores.cells[busiest].slice(0, 5);
        const r = await U.areaInsights({ code: code5 }, await store(), { now: NOW, limit: 12 });
        expect(r.cityLabel).toBe('Indore');
        expect(r.findings.length).toBeGreaterThan(2);
        for (const f of r.findings) {
            expect(f.sources.length).toBe(1);
            expect(CATALOG.datasets.some(d => d.id === f.sources[0])).toBe(true);
            expect(typeof f.detail).toBe('string');
        }
        // Salience is sorted.
        const s = r.findings.map(f => f.salience);
        expect(s).toEqual(s.slice().sort((a, b) => b - a));
        expect(r.sources.some(x => x.id === 'lst_monthly' && x.period)).toBe(true);
    });
    it('computes a year-on-year trend for monthly NO2 over Indore', async () => {
        const spec = CATALOG.datasets.find(d => d.id === 'no2_monthly');
        const t = await (await store()).load('no2_monthly');
        const idx = t.cells.map((_, i) => i);
        const tr = U.trendOf(spec, t, spec.fields[0], idx, idx);
        expect(tr.window).toBe(12);
        expect(tr.city.series).toHaveLength(spec.time.steps.length);
        expect(Number.isFinite(tr.city.yoy)).toBe(true);
    });
    it('builds the city dashboard with ranks and zones', async () => {
        const d = await U.cityDashboard(await store(), { now: NOW });
        expect(d.cities.length).toBe(CATALOG.datasets.find(x => x.id === 'scores').regions.length);
        expect(d.cities.map(c => c.rank)).toEqual(d.cities.map((_, i) => i + 1));
        const indore = d.cities.find(c => c.region === 'indore_pilot');
        expect(indore.indicators.livability.rank).toBeGreaterThan(0);
        expect(indore.zones.best.length).toBeGreaterThan(0);
        expect(indore.extras.some(e => e.dataset === 'lst_monthly')).toBe(true);
        expect(U.toText(d)).toMatch(/urban index/);
    });
    it('compares two cities', async () => {
        const r = await U.compare({ city: 'pune' }, { city: 'indore_pilot' }, await store());
        expect(r.rows.length).toBeGreaterThan(5);
        expect(r.wins.a + r.wins.b + r.wins.tie).toBe(r.directional);
        expect(r.summary).toMatch(/Pune|Indore/);
    });
    it('runs park, density and flood what-ifs', async () => {
        const scores = await (await store()).load('scores');
        const i = scores.cells.findIndex((c, k) => c.startsWith('34') && scores.columns.population_proxy[k] > 30);
        const code = scores.cells[i];
        const park = await U.whatIf({ type: 'park', code }, await store());
        const t = park.cells.find(c => c.target);
        expect(t.after.livability).toBeGreaterThan(t.before.livability);
        expect(t.delta).toBeCloseTo(Math.min(40, 100 - t.before.green) * 2 / 13, 1);
        const layer = U.toLayer(park);
        expect(layer.table.cells.length).toBe(park.cells.length);

        const dens = await U.whatIf({ type: 'density', code, factor: 2 }, await store(), { heights: { level: 8, cells: { [code + 'AA']: 6.4, [code + 'BB']: 9.6 } } });
        expect(dens.heights.blocks).toBe(2);
        expect(dens.metrics[0].after).toBeGreaterThan(dens.metrics[0].before);

        const flood = await U.whatIf({ type: 'flood', level: 'severe', city: 'indore_pilot' }, await store());
        expect(flood.cells.length).toBeGreaterThan(0);
        expect(flood.mobility).not.toBeNull();
        expect(flood.summary).toMatch(/severe event/);
    });
    it('writes cited evidence for DISHA', async () => {
        const scores = await (await store()).load('scores');
        const i = scores.cells.findIndex((c, k) => c.startsWith('34') && scores.columns.population_proxy[k] > 30);
        const c = globalThis.DigiPin.decodePartial(scores.cells[i]);
        const ev = await U.evidence(c.lat, c.lng, await store());
        expect(ev.text).toMatch(/\[C1\]/);
        expect(ev.citations[0].tag).toBe('C1');
        expect(ev.citations.every(x => x.title)).toBe(true);
    });
});

