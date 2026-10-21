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
});
