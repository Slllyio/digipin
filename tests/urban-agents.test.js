import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// UrbanAgents, UrbanLenses, UrbanInsights and DigiPin are exposed by tests/setup.js.
const A = globalThis.UrbanAgents;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

// Rajwada, central Indore, as a level-5 neighbourhood.
const HOOD = { code: globalThis.DigiPin.encode(22.7186, 75.8553).replace(/-/g, '').slice(0, 5) };

describe('UrbanAgents catalogue and plans', () => {
    it('offers the fourteen agents with unique ids', () => {
        const ids = A.TEMPLATES.map(t => t.id);
        expect(ids).toEqual(['brief', 'site', 'flood', 'heat', 'access', 'growth', 'changes', 'air', 'green', 'solar', 'risk', 'programme', 'compare', 'health']);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('plans before running, with defaults filled and bad params replaced', () => {
        const p = A.plan({ agent: 'site', params: { use: 'nonsense' } });
        expect(p.params.use).toBe('clinic');
        expect(p.steps.map(s => s.tool)).toEqual(['loadData', 'rankSites', 'pickSites', 'layer']);
        expect(p.steps[1].detail).toContain('healthcare_access');
        expect(A.plan({ agent: 'site', params: { use: 'park' } }).steps[1].label).toContain('park');
        expect(() => A.plan({ agent: 'nope' })).toThrow(/Unknown agent/);
    });
});

describe('UrbanAgents helpers', () => {
    it('ranks within a set, averaging ties', () => {
        const r = A.prank([5, 1, 5, 9], [0, 1, 2, 3]);
        expect(r[1]).toBe(0);
        expect(r[0]).toBeCloseTo(0.5);
        expect(r[2]).toBeCloseTo(0.5);
        expect(r[3]).toBe(1);
    });

    it('spreads picks one per parent cell', () => {
        const picks = A.spread([{ code: 'AB1' }, { code: 'AB2' }, { code: 'AC1' }, { code: 'AD1' }], 2, 2);
        expect(picks.map(p => p.code)).toEqual(['AB1', 'AC1']);
    });

    it('tests cell membership for prefix, bbox and polygon areas', () => {
        const code = globalThis.DigiPin.encode(22.7186, 75.8553).replace(/-/g, '');
        expect(A.inArea(code.slice(0, 7), { kind: 'prefix', code: code.slice(0, 5) })).toBe(true);
        expect(A.inArea('2222222', { kind: 'prefix', code: code.slice(0, 5) })).toBe(false);
        const bbox = { west: 75.85, south: 22.71, east: 75.86, north: 22.73 };
        expect(A.inArea(code.slice(0, 8), { kind: 'bbox', bbox })).toBe(true);
        const ring = [[75.80, 22.70], [75.80, 22.74], [75.84, 22.74], [75.84, 22.70]];
        expect(A.inArea(code.slice(0, 8), { kind: 'polygon', bbox: { west: 75.8, south: 22.7, east: 75.84, north: 22.74 }, polygon: ring })).toBe(false);
    });
});

describe('UrbanAgents runs on the committed store', () => {
    it('site suitability ranks cells inside the area, one site per neighbourhood, with a layer', async () => {
        const s = await store();
        const steps = [];
        const { report, layer } = await A.run({ agent: 'site', area: HOOD, params: { use: 'clinic' } }, s, { onStep: (x) => steps.push(`${x.tool}:${x.status}`) });
        expect(report.schema).toBe('digipin.agent-report/1');
        expect(report.summary).toMatch(/best clinic site/);
        expect(report.findings.length).toBeGreaterThan(0);
        for (const f of report.findings) expect(f.cells[0].startsWith(HOOD.code)).toBe(true);
        expect(report.findings.length).toBeGreaterThan(1);
        const parents = report.findings.map(f => f.cells[0].slice(0, 6));
        expect(new Set(parents).size).toBe(parents.length);
        expect(layer.spec.id).toBe('agent_site');
        expect(layer.table.cells.every(c => c.startsWith(HOOD.code))).toBe(true);
        const vals = layer.table.columns.suitability;
        expect(vals.every(v => v >= 0 && v <= 100)).toBe(true);
        expect(steps).toEqual(['loadData:running', 'loadData:done', 'rankSites:running', 'rankSites:done', 'pickSites:running', 'pickSites:done', 'layer:running', 'layer:done']);
        expect(report.steps.every(x => x.status === 'done')).toBe(true);
        expect(report.sources.map(x => x.id)).toContain('scores');
        expect(JSON.parse(JSON.stringify(report))).toEqual(report);   // plain JSON: savable and shareable
    }, 60000);

    it('heat vulnerability slices the city lens to the area', async () => {
        const s = await store();
        const { report, layer } = await A.run({ agent: 'heat', area: HOOD }, s);
        expect(report.summary).toMatch(/most heat-vulnerable tenth/);
        expect(report.metrics[0].label).toBe('Residents in the area');
        expect(layer.spec.fields[0].key).toBe('hvi');
        expect(layer.table.cells.every(c => c.startsWith(HOOD.code))).toBe(true);
        expect(report.findings.filter(f => f.kind === 'concern').length).toBeGreaterThan(0);
    }, 60000);

    it('city-wide access ignores near-empty cells when naming the worst gaps', async () => {
        const s = await store();
        const { report } = await A.run({ agent: 'access', area: { city: 'indore_pilot' } }, s);
        const gaps = report.findings.filter(f => f.kind === 'concern');
        expect(gaps.length).toBeGreaterThan(0);
        for (const g of gaps) expect(Number(g.detail.match(/^([\d,]+) residents/)[1].replace(/,/g, ''))).toBeGreaterThanOrEqual(50);
        expect(report.metrics.find(m => m.label === 'In the least walkable tenth').value).not.toMatch(/^0 /);
    }, 60000);

    it('marks a failing step failed and rethrows', async () => {
        const s = await store();
        const steps = [];
        await expect(A.run({ agent: 'site', area: { code: '22222' } }, s, { onStep: (x) => steps.push(`${x.tool}:${x.status}`) })).rejects.toThrow();
        expect(steps.filter(x => x.endsWith(':failed'))).toHaveLength(1);
        expect(steps).not.toContain('layer:done');
        await expect(A.run({ agent: 'brief', area: null }, s)).rejects.toThrow(/Pick an area/);
    }, 60000);

    it('every agent produces a report for a neighbourhood', async () => {
        const s = await store();
        for (const t of A.TEMPLATES) {
            const { report } = await A.run({ agent: t.id, area: HOOD }, s);
            expect(report.summary, t.id).toBeTruthy();
            expect(report.steps.some(x => x.status === 'failed'), t.id).toBe(false);
            expect(A.toText(report)).toContain(report.title);
        }
    }, 120000);
});

describe('Lens-backed agents', () => {
    it('slice air, green, solar and compound risk to a neighbourhood', async () => {
        const s = await store();
        const out = {};
        for (const id of ['air', 'green', 'solar', 'risk']) {
            const { report, layer } = await A.run({ agent: id, area: HOOD }, s);
            out[id] = report;
            expect(layer && layer.table.cells.length, id).toBeGreaterThan(0);
            expect(layer.table.cells.every(c => A.inArea(c, { kind: 'prefix', code: HOOD.code })), id).toBe(true);
            if (process.env.AGENT_DEBUG) console.log(id, report.summary, report.metrics, report.findings.slice(0, 2));
        }
        expect(out.air.summary).toMatch(/PM2\.5|µg\/m³/);
        expect(out.solar.summary).toMatch(/MWh\/yr/);
        expect(out.solar.findings[0].kind).toBe('strength');
        expect(out.green.metrics[0].label).toBe('Residents in the area');
    }, 60000);

    it('programme siting keeps sites inside the area or falls back to the city', async () => {
        const s = await store();
        const city = await A.run({ agent: 'programme', area: { city: 'indore_pilot' }, params: { preset: 'ev_charging' } }, s);
        expect(city.report.findings.length).toBeGreaterThan(0);
        expect(city.report.summary).toMatch(/EV charging hub/);
        expect(city.report.metrics.some(m => m.label.startsWith('Weight:'))).toBe(true);
        const hood = await A.run({ agent: 'programme', area: HOOD, params: { preset: 'cool_roofs' } }, s);
        expect(hood.report.summary).toMatch(/cool-roof/);
        if (process.env.AGENT_DEBUG) console.log(city.report.summary, hood.report.summary, hood.report.metrics);
    }, 60000);
});

describe('Compare agent', () => {
    it('compares a neighbourhood with its own city and a city with another', async () => {
        const s = await store();
        const own = await A.run({ agent: 'compare', area: HOOD, params: { vs: 'own' } }, s);
        expect(own.report.summary).toMatch(/ahead|evenly matched/);
        expect(own.report.metrics.find(m => m.label === 'Fields compared').value).not.toBe('0');
        expect(own.report.findings.length).toBeGreaterThan(0);
        const other = A.plan({ agent: 'compare', params: { vs: 'pune' } });
        expect(other.params.vs).toBe('pune');
        expect(A.plan({ agent: 'compare', params: { vs: 'Bad City!' } }).params.vs).toBe('own');
        await expect(A.run({ agent: 'compare', area: { city: 'indore_pilot' }, params: { vs: 'own' } }, s)).rejects.toThrow(/another city/);
        const cities = globalThis.UrbanInsights.cities(s).map(c => c.name).filter(n => n !== 'indore_pilot');
        const vsCity = await A.run({ agent: 'compare', area: { city: 'indore_pilot' }, params: { vs: cities[0] } }, s);
        expect(vsCity.report.summary.length).toBeGreaterThan(20);
        if (process.env.AGENT_DEBUG) console.log(own.report.summary, own.report.findings.slice(0, 3), vsCity.report.summary);
    }, 90000);
});

describe('Data health agent (Pipeline Steward)', () => {
    const NOW = Date.parse('2026-10-21T12:00:00Z');
    const iso = (h) => new Date(NOW - h * 36e5).toISOString();

    it('grades feeds with the steward windows', () => {
        expect(A.gradeFeed('usgs_earthquakes', { generated_at_iso: iso(1), records: [{}] }, NOW).status).toBe('ok');
        expect(A.gradeFeed('usgs_earthquakes', { generated_at_iso: iso(8), records: [{}] }, NOW).status).toBe('warn');
        expect(A.gradeFeed('imd_cityforecast', { generated_at_iso: iso(8), records: [{}] }, NOW).status).toBe('ok');
        const dead = A.gradeFeed('ncs_earthquakes', { generated_at_iso: iso(24 * 9), records: [{}] }, NOW);
        expect(dead.status).toBe('fail');
        expect(dead.issues[0]).toMatch(/9d ago; the feed looks dead/);
        const empty = A.gradeFeed('openaq_india', { generated_at_iso: iso(1), records: [] }, NOW);
        expect(empty).toMatchObject({ status: 'warn', rows: 0, issues: ['snapshot is empty'] });
        expect(A.gradeFeed('x', null, NOW).status).toBe('fail');
    });

    it('runs without an area, re-checks live snapshots and keeps steward-only findings', async () => {
        const files = {
            'data/steward/report.json': {
                status: 'warn', generated_at: iso(3),
                sources: { a_feed: { required_env: [] }, b_feed: { required_env: ['B_KEY'] }, c_feed: { required_env: [] } },
                findings: [
                    { source: 'a_feed', check: 'freshness', severity: 'warn', message: 'old', hint: 'check the scraper' },
                    { source: 'c_feed', check: 'wiring', severity: 'warn', message: 'not in the scrape matrix', hint: 'add it to the workflow' },
                ],
            },
            'data/realtime/a_feed/latest.json': { generated_at_iso: iso(30), records: [{}, {}] },
            'data/realtime/b_feed/latest.json': { generated_at_iso: iso(1), records: [] },
            'data/realtime/c_feed/latest.json': { generated_at_iso: iso(1), records: [{}] },
        };
        const fake = async (url) => (files[url] ? { ok: true, json: async () => files[url] } : { ok: false });
        const steps = [];
        const { report, layer } = await A.run({ agent: 'health' }, {}, { fetch: fake, now: () => NOW, onStep: s => steps.push(s.status) });
        expect(layer).toBeNull();
        expect(report.area.label).toBe('All live feeds');
        expect(report.summary).toBe('2 of 3 live feeds need attention; worst is a_feed (last refreshed 30h ago, older than the 6h window).');
        const titles = report.findings.map(f => f.title);
        expect(titles[0]).toMatch(/^a_feed: last refreshed 30h ago/);
        expect(report.findings[0].detail).toBe('check the scraper');
        expect(report.findings.find(f => f.title.startsWith('b_feed')).detail).toContain('B_KEY');
        expect(titles).toContain('c_feed: not in the scrape matrix');
        expect(titles.at(-1)).toBe('Healthy: c_feed');
        expect(report.metrics.find(m => m.label === 'Steward report age').value).toBe('3h');
        expect(report.steps.every(s => s.status === 'done')).toBe(true);
    });

    it('fails clearly when the steward has never run and no feeds are known', async () => {
        await expect(A.run({ agent: 'health' }, {}, { fetch: async () => ({ ok: false }), now: () => NOW })).rejects.toThrow(/steward has not run/);
    });
});
