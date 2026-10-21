import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// IntelBrief, UrbanInsights, URLState and CellStore are exposed by tests/setup.js.
const B = globalThis.IntelBrief;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

describe('IntelBrief link params', () => {
    it('round-trips every tab state', () => {
        const states = [
            { tab: 'city', city: 'pune' },
            { tab: 'here', city: 'indore_pilot', a: { code: 'J8P7' } },
            { tab: 'compare', a: { city: 'pune' }, b: { bbox: { west: 75.8, south: 22.6, east: 75.9, north: 22.7 } } },
            { tab: 'whatif', city: 'pune', scenario: { type: 'park', code: '4P3JK8', boost: 40 } },
            { tab: 'whatif', scenario: { type: 'flood', level: 'severe' } },
            { tab: 'whatif', scenario: { type: 'density', code: '4P3JK8', factor: 2.5 } },
        ];
        for (const st of states) {
            const qs = new URLSearchParams(B.toParams(st)).toString();
            const back = B.parseParams(qs);
            expect(back.tab).toBe(st.tab);
            if (st.city) expect(back.city).toBe(st.city);
            if (st.a) expect(B.areaToken(back.a)).toBe(B.areaToken(st.a));
            if (st.b) expect(B.areaToken(back.b)).toBe(B.areaToken(st.b));
            if (st.scenario) expect(B.scenarioToken(back.scenario)).toBe(B.scenarioToken(st.scenario));
        }
    });

    it('drops malformed or hostile values', () => {
        expect(B.parseParams('intel=evil')).toBeNull();
        const st = B.parseParams('intel=here&ic=Pune%3Cx%3E&ia=p:ZZZ&ib=b:1,2,0,0&wi=park:<script>');
        expect(st).toEqual({ tab: 'here' });
        expect(B.parseScenarioToken('park:4P3JK8:999').boost).toBe(80);
        expect(B.parseScenarioToken('flood:tsunami')).toBeNull();
        expect(B.areaToken({ code: '4P3-JK8' })).toBe('p:4P3JK8');
    });

    it('URLState carries the Intel view', () => {
        const U = globalThis.URLState;
        const qs = U.stringify({ cell: '4P3JK852C9', intel: { tab: 'compare', a: { city: 'pune' }, b: { city: 'delhi' } } });
        expect(qs).toContain('intel=compare');
        const back = U.parse(`?${qs}`);
        expect(back.cell).toBe('4P3JK852C9');
        expect(back.intel.a).toEqual({ city: 'pune' });
        expect(back.intel.b).toEqual({ city: 'delhi' });
    });
});

describe('IntelBrief briefs', () => {
    it('builds a cited, script-free brief for a city and an area', async () => {
        const s = await store();
        const city = globalThis.UrbanInsights.cities(s).find(c => c.name === 'pune') || globalThis.UrbanInsights.cities(s)[0];
        const dash = await globalThis.UrbanInsights.cityDashboard(s);
        const row = dash.cities.find(c => c.region === city.name) || dash.cities[0];
        const zone = row.zones.best[0];
        const now = () => new Date('2026-10-21T08:00:00Z');
        const b = await B.build({ city: row.region, area: { code: zone.code, label: `Zone ${zone.digipin}` }, link: 'https://example.org/app.html?intel=city', now }, s);
        expect(b.schema).toBe('digipin.brief/1');
        expect(b.dashboard.row.region).toBe(row.region);
        expect(b.areaInsights.findings.length).toBeGreaterThan(0);
        const html = B.toHTML(b);
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('Key indicators');
        expect(html).toContain(`Zone ${zone.digipin}`);
        // Every in-page source anchor resolves to a source card.
        const refs = [...html.matchAll(/href="#src-([^"]+)"/g)].map(m => m[1]);
        const cards = new Set([...html.matchAll(/id="src-([^"]+)"/g)].map(m => m[1]));
        expect(refs.length).toBeGreaterThan(0);
        refs.forEach(r => expect(cards.has(r)).toBe(true));
        expect(html).toContain('href="https://example.org/app.html?cell=');
    }, 60000);
});

describe('Drawn areas and what changed', () => {
    it('polygon areas: point-in-polygon, km², link token, insights', async () => {
        const U = globalThis.UrbanInsights;
        const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
        expect(U.pointInPolygon(sq, 0.5, 0.5)).toBe(true);
        expect(U.pointInPolygon(sq, 1.5, 0.5)).toBe(false);
        expect(U.polygonKm2([[73.8, 18.5], [73.81, 18.5], [73.81, 18.51], [73.8, 18.51]])).toBeCloseTo(1.17, 1);
        const poly = [[73.83, 18.5], [73.88, 18.5], [73.87, 18.55], [73.84, 18.54]];
        const tok = B.areaToken({ polygon: poly });
        expect(tok.startsWith('g:')).toBe(true);
        expect(B.parseAreaToken(tok).polygon).toEqual(poly);
        expect(B.parseAreaToken('g:1,2;3,4')).toBeNull();
        const s = await store();
        const r = await U.areaInsights({ polygon: poly }, s, { limit: 5 });
        expect(r.area.kind).toBe('polygon');
        expect(r.city).toBe('pune');
        expect(r.coverage.length).toBeGreaterThan(3);
        // Fewer cells than the polygon's bounding box.
        const box = await U.areaInsights({ bbox: { west: 73.83, south: 18.5, east: 73.88, north: 18.55 } }, s, { limit: 5 });
        const n = (x) => Math.max(...x.coverage.map(c => c.cells));
        expect(n(r)).toBeLessThan(n(box));
    }, 60000);

    it('changes() ranks the latest step of every series against a year earlier', async () => {
        const U = globalThis.UrbanInsights;
        const s = await store();
        const r = await U.changes(s, { city: 'pune', limit: 6 });
        expect(r.kind).toBe('changes');
        expect(r.items.length).toBeGreaterThan(2);
        expect(r.latest).toMatch(/^\d{4}/);
        for (const x of r.items) {
            expect(x.delta).toBeCloseTo(x.latest - x.prev, 1);
            expect(s.get(x.dataset)).toBeTruthy();
            expect(r.sources.some(src => src.id === x.dataset)).toBe(true);
        }
        const sal = r.items.map(x => x.salience);
        expect([...sal].sort((a, b) => b - a)).toEqual(sal);
        expect(U.toText(r)).toContain('What changed in Pune');
    }, 60000);

    it('DISHA routes "what changed" questions', () => {
        const D = globalThis.DishaIntel;
        const cities = [{ name: 'pune', label: 'Pune' }];
        expect(D.match('What changed in Pune this month?', cities)).toEqual({ type: 'changes', city: 'pune' });
        expect(D.match("what's new here", cities)).toEqual({ type: 'changes' });
    });

    it('DISHA routes tour and briefing requests', () => {
        const D = globalThis.DishaIntel;
        const cities = [{ name: 'pune', label: 'Pune' }];
        expect(D.match('Give me a tour of Pune', cities)).toEqual({ type: 'tour', play: true, city: 'pune' });
        expect(D.match('city overview of Pune', cities)).toEqual({ type: 'tour', play: false, city: 'pune' });
        expect(D.match('Give me a full urban intelligence briefing', cities)).toBeNull();
        expect(D.match('fly me through the city', cities)).toEqual({ type: 'tour', play: true });
        expect(D.match('tourism potential in Pune', cities)?.type).not.toBe('tour');
    });
});

describe('Trees-for-heat and road-closure scenarios', () => {
    it('ols2 recovers a known plane', () => {
        const rows = [];
        for (let i = 0; i < 40; i++) { const x1 = i % 10, x2 = Math.floor(i / 10) * 3; rows.push([x1, x2, 5 - 0.5 * x1 + 2 * x2]); }
        const f = globalThis.UrbanInsights.ols2(rows);
        expect(f.b1).toBeCloseTo(-0.5, 6);
        expect(f.b2).toBeCloseTo(2, 6);
        expect(f.r2).toBeCloseTo(1, 6);
        expect(globalThis.UrbanInsights.ols2(rows.slice(0, 5))).toBeNull();
    });

    it('cool: city-fitted slope, cooler after, never past 100% cover', async () => {
        const U = globalThis.UrbanInsights;
        const s = await store();
        const r = await U.whatIf({ type: 'cool', code: '4FP3PP', trees: 20 }, s);
        expect(r.city).toBe('pune');
        expect(r.cells.length).toBeGreaterThan(5);
        for (const c of r.cells) {
            expect(c.after).toBeLessThanOrEqual(c.before);
            expect(c.tree0 + c.add).toBeLessThanOrEqual(100.01);
        }
        expect(r.sources.map(x => x.id)).toEqual(expect.arrayContaining(['surface_heat', 'land_cover']));
        expect(r.formula).toMatch(/fitted on Pune/);
        expect(U.toLayer(r).spec.fields[0].key).toBe('cooling_c');
    }, 60000);

    it('closure: diverts onto the surrounding roads and flags critical links', async () => {
        const U = globalThis.UrbanInsights;
        const s = await store();
        const r = await U.whatIf({ type: 'closure', code: '4FP49M' }, s);
        expect(r.cells.length).toBeGreaterThan(5);
        expect(r.cells.every(c => !c.code.startsWith('4FP49M'))).toBe(true);
        expect(r.cells.every(c => c.after >= c.before && c.after <= 100)).toBe(true);
        const jam = r.metrics.find(m => /congested/.test(m.label));
        expect(jam.after).toBeGreaterThanOrEqual(jam.before);
        await expect(U.whatIf({ type: 'closure', code: '4FP' }, s)).rejects.toThrow(/at least 6/);
    }, 60000);

    it('links and DISHA know the new scenarios', () => {
        expect(B.parseScenarioToken(B.scenarioToken({ type: 'cool', code: '4FP3PP', trees: 30 }))).toEqual({ type: 'cool', code: '4FP3PP', trees: 30 });
        expect(B.parseScenarioToken('closure:4FP3PPT')).toEqual({ type: 'closure', code: '4FP3PPT' });
        const D = globalThis.DishaIntel;
        expect(D.match('what if we plant trees here, 30% more', [])).toEqual({ type: 'whatif', scenario: 'cool', trees: 30 });
        expect(D.match('what happens if we close this road?', [])).toEqual({ type: 'whatif', scenario: 'closure' });
    });
});

describe('Plans (stacked what-ifs)', () => {
    it('runs each scenario, finds overlaps and trade-offs, and travels in links', async () => {
        const U = globalThis.UrbanInsights;
        const s = await store();
        const plan = [{ type: 'cool', code: '4FP3PP', trees: 20 }, { type: 'closure', code: '4FP3PP' }, { type: 'park', code: 'NOPE' }];
        const r = await U.runPlan(plan, s);
        expect(r.kind).toBe('plan');
        expect(r.items.filter(x => x.kind === 'whatif').length).toBe(2);
        expect(r.items[2].kind).toBe('error');
        const o = r.overlaps.find(x => x.code === '4FP3PP');
        expect(o && o.tradeOff).toBe(true);
        expect(r.summary).toMatch(/could not run/);
        await expect(U.runPlan([], s)).rejects.toThrow(/empty/);
        const qs = new URLSearchParams(B.toParams({ tab: 'whatif', plan: plan.slice(0, 2) })).toString();
        expect(B.parseParams(qs).plan).toEqual([{ type: 'cool', code: '4FP3PP', trees: 20 }, { type: 'closure', code: '4FP3PP' }]);
        const html = B.toHTML(await B.build({ city: 'pune', plan: r }, s));
        expect(html).toContain('Where they overlap');
        expect(html).not.toMatch(/<script/i);
    }, 60000);
});

describe('Scenarios through the lenses', () => {
    it('trees lower the site’s heat vulnerability; density thins healthcare access; flood reads exposure', async () => {
        const U = globalThis.UrbanInsights, S = globalThis.ScenarioLenses;
        const s = await store();
        const cool = await U.whatIf({ type: 'cool', code: '4FP3PP', trees: 30 }, s);
        const a = await S.impact(cool, s);
        const heat = a.lenses.find(l => l.id === 'heat');
        const site = heat.rows.find(x => /site/.test(x.label));
        expect(site.after).toBeLessThan(site.before);
        expect(heat.gini.before).toBeGreaterThan(0);
        expect(a.residents).toBeGreaterThan(0);
        const dens = await U.whatIf({ type: 'density', code: '4FP49M', factor: 3 }, s);
        const d = await S.impact(dens, s);
        const h = d.lenses.find(l => l.id === 'health').rows.find(x => /site/.test(x.label));
        expect(h.after).toBeLessThan(h.before);
        const fl = await U.whatIf({ type: 'flood', level: 'severe', city: 'pune' }, s);
        const f = await S.impact(fl, s);
        expect(f.lenses.every(l => l.read)).toBe(true);
        expect(f.summary).toMatch(/^Of the .* residents in the affected cells/);
        // A plan applies both changes to one frame.
        const both = await S.impact([cool, dens], s);
        expect(both.lenses.map(l => l.id)).toEqual(expect.arrayContaining(['heat', 'health', 'fifteen']));
        const html = B.toHTML(await B.build({ city: 'pune', whatif: cool, lens: a }, s));
        expect(html).toContain('Through the urban lenses');
    }, 120000);
});

describe('Zone leaderboard', () => {
    it('ranks a city’s zones best-first on any field', async () => {
        const U = globalThis.UrbanInsights;
        const s = await store();
        const fields = U.rankableFields(s, 'pune');
        expect(fields.some(f => f.dataset === 'scores' && f.key === 'livability')).toBe(true);
        const liv = await U.zoneRanking(s, { city: 'pune', dataset: 'scores', field: 'livability' });
        expect(liv.zones.length).toBeGreaterThan(5);
        expect(liv.zones[0].rank).toBe(1);
        expect(liv.zones[0].mean).toBeGreaterThanOrEqual(liv.zones[1].mean);
        const heat = await U.zoneRanking(s, { city: 'pune', dataset: 'surface_heat', field: 'lst_day_c' });
        expect(heat.higherIs).toBe('worse');
        expect(heat.zones[0].mean).toBeLessThanOrEqual(heat.zones[heat.zones.length - 1].mean);
        expect(heat.zones.every(z => z.code.length === 5 && z.cells >= 3)).toBe(true);
        await expect(U.zoneRanking(s, { city: 'pune', dataset: 'scores', field: 'nope' })).rejects.toThrow(/No field/);
    }, 60000);
});

describe('City tour', () => {
    it('builds overview → zones → heat → flood → change → end, each with a place and a layer', async () => {
        const s = await store();
        const stops = await globalThis.CityTour.buildStops('pune', s);
        const ids = stops.map(x => x.id);
        expect(ids[0]).toBe('overview');
        expect(ids).toEqual(expect.arrayContaining(['best', 'worst', 'heat', 'flood', 'end']));
        for (const st of stops) {
            expect(st.bounds && st.bounds.east > st.bounds.west).toBe(true);
            expect(st.caption.length).toBeGreaterThan(10);
            expect(['zones', 'cells']).toContain(st.layer.kind);
        }
        expect(stops.find(x => x.id === 'overview').caption).toMatch(/of 13 cities/);
        const best = stops.find(x => x.id === 'best'), worst = stops.find(x => x.id === 'worst');
        expect(best.layer.ranking.zones[0].mean).toBeGreaterThanOrEqual(worst.layer.ranking.zones.at(-1).mean);
    }, 60000);
});
