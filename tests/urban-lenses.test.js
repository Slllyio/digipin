import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// UrbanLenses, UrbanInsights and DigiPin are exposed by tests/setup.js.
const L = globalThis.UrbanLenses;
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

// A square block of L7 cells around a point: rows north→south, cols west→east.
function block(lat, lng, size) {
    const d = L.CELL_DEG;
    const codes = [];
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) codes.push(globalThis.DigiPin.encode(lat - r * d, lng + c * d).replace(/-/g, '').slice(0, 7));
    }
    return codes;
}

describe('UrbanLenses maths', () => {
    it('ranks with ties averaged and skips gaps', () => {
        const r = L.prank([10, 20, 20, NaN, 40], [0, 1, 2, 3, 4]);
        expect(r[0]).toBe(0);
        expect(r[1]).toBeCloseTo(0.5);
        expect(r[2]).toBeCloseTo(0.5);
        expect(Number.isNaN(r[3])).toBe(true);
        expect(r[4]).toBe(1);
    });

    it('gives Gini 0 for equal shares and near 1 when one cell has everything', () => {
        const idx = [0, 1, 2, 3];
        expect(L.gini([5, 5, 5, 5], null, idx)).toBeCloseTo(0, 6);
        expect(L.gini([0, 0, 0, 100], null, idx)).toBeCloseTo(0.75, 6);   // (n-1)/n for n=4
        // Weighted: the rich cell holds most people, so access is fairer.
        expect(L.gini([0, 0, 0, 100], [1, 1, 1, 97], idx)).toBeLessThan(0.1);
        const lz = L.lorenz([1, 2, 3, 4], null, idx, 4);
        expect(lz[0]).toEqual([0, 0]);
        expect(lz[4]).toEqual([1, 1]);
        expect(lz[2][1]).toBeCloseTo(0.3, 3);
    });

    it('k-means separates two blobs and names centroids', () => {
        const X = [];
        for (let i = 0; i < 40; i++) X.push([i % 2 ? 5 + (i % 5) * 0.1 : -5 - (i % 3) * 0.1, (i % 7) * 0.05]);
        const km = L.kmeans(X, 2, { seed: 3 });
        const a = km.labels[0], b = km.labels[1];
        expect(a).not.toBe(b);
        X.forEach((x, i) => expect(km.labels[i]).toBe(x[0] > 0 ? b : a));
        expect(L.silhouette(X, Array.from(km.labels), 2)).toBeGreaterThan(0.9);
        expect(L.archetypeName({ dens: 1, built: 1, height: 0, mix: 0.5, canopy: 0, lights: 0, jx: 1, growth: 0 })).toBe('Dense mixed core');
        expect(L.archetypeName({ dens: 0, built: 0, height: 0, mix: 0, canopy: 0, lights: 0, jx: 0, growth: 1.2 })).toBe('New growth edge');
    });

    it('AHP gives proportional weights and CR 0 for a consistent matrix', () => {
        const r = L.ahp([[1, 2, 4], [1 / 2, 1, 2], [1 / 4, 1 / 2, 1]]);
        expect(r.weights[0]).toBeCloseTo(4 / 7, 5);
        expect(r.weights[2]).toBeCloseTo(1 / 7, 5);
        expect(r.cr).toBeLessThan(1e-6);
        for (const P of Object.values(L.PRESETS)) expect(L.ahp(P.pairwise).cr).toBeLessThan(0.1);
    });

    it('fits OLS', () => {
        const x = [1, 2, 3, 4, 5], y = x.map(v => 2 + 3 * v);
        const f = L.ols(x, y, [0, 1, 2, 3, 4]);
        expect(f.a).toBeCloseTo(2);
        expect(f.b).toBeCloseTo(3);
        expect(f.r2).toBeCloseTo(1);
    });

    it('lays L7 cells on a lattice with ~244 m steps', () => {
        const codes = block(22.72, 75.86, 3);
        const g = L.grid(codes);
        expect(new Set(codes).size).toBe(9);
        expect(g.dy).toBeGreaterThan(0.23);
        expect(g.dy).toBeLessThan(0.26);
        expect(g.cellAt(4, -1, 0)).toBe(7);   // centre → one row south (rows run north→south in `block`)
        expect(g.cellAt(4, 0, 1)).toBe(5);
        expect(g.cellAt(0, 5, 5)).toBe(-1);
    });
});

describe('UrbanLenses methods on a hand-made grid', () => {
    const SIZE = 12;
    const codes = block(22.72, 75.86, SIZE);
    const n = codes.length;
    const pop = new Array(n).fill(1000);
    const health = new Array(n).fill(0);
    health[0] = 2;                                   // one clinic in the NW corner
    const fr = L.frameFrom(codes, { 'population.population': pop, 'population.density_km2': pop, 'osm_amenities.healthcare': health });

    it('E2SFCA: access falls with distance from the only clinic and integrates to supply', () => {
        const A = L.e2sfca(fr.grid, health, pop, 2);
        expect(A[0]).toBeGreaterThan(A[1]);
        expect(A[1]).toBeGreaterThan(A[SIZE * 4 + 4]);
        expect(A[n - 1]).toBe(0);                    // far corner: out of the 2 km catchment
        // Σ A·P = total supply (each facility's ratio is fully shared out).
        const s = A.reduce((a, v, i) => a + v * pop[i], 0);
        expect(s).toBeCloseTo(2, 6);
    });

    it('health lens counts the people beyond the catchment', () => {
        const r = L._lenses.health(fr, {});
        expect(r.stats[1].raw).toBeGreaterThan(0);
        expect(r.headline).toMatch(/no mapped healthcare within 2 km/);
    });

    it('Gi* and Moran find a planted hot block and no structure in noise', () => {
        const v = new Array(n).fill(0).map((_, i) => ((i * 7919) % 13) / 13);
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) v[r * SIZE + c] = 10;
        const idx = [...Array(n).keys()];
        const hs = L.hotspots(fr.grid, v, idx, { permutations: 99 });
        expect(hs.moranI).toBeGreaterThan(0.3);
        expect(hs.z).toBeGreaterThan(2.58);
        expect(hs.hot).toContain(SIZE + 1);
        expect(hs.lisa[SIZE + 1]).toBe(1);           // High-High
        expect(hs.cold).not.toContain(SIZE + 1);
    });

    it('LEI classes new built-up as infill, edge or leapfrog', () => {
        const b16 = new Array(n).fill(0), b23 = new Array(n).fill(0);
        // An old core in the NW 5×5; one infill cell inside it, one edge cell
        // beside it, one leapfrog cell in the far SE corner.
        for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) { b16[r * SIZE + c] = 60; b23[r * SIZE + c] = 60; }
        const infill = 2 * SIZE + 2, edge = 2 * SIZE + 5, far = n - 1;
        b16[infill] = 10; b23[infill] = 50;
        b23[edge] = 30;
        b23[far] = 30;
        const f3 = L.frameFrom(codes, { 'population.population': pop, 'population.density_km2': pop, 'growth.built_2016_pct': b16, 'growth.built_2023_pct': b23 });
        const r = L._lenses.sprawl(f3, {});
        expect(r.columns.lei[infill]).toBeGreaterThanOrEqual(50);
        expect(r.columns.lei[edge]).toBeGreaterThan(2);
        expect(r.columns.lei[edge]).toBeLessThan(50);
        expect(r.columns.lei[far]).toBe(0);
        expect(r.headline).toMatch(/infill/);
    });

    it('15-minute completeness counts essentials in walking reach', () => {
        const cols = { 'population.population': pop, 'population.density_km2': pop };
        for (const k of L.ESSENTIALS) cols[`osm_amenities.${k}`] = new Array(n).fill(0);
        for (const k of L.ESSENTIALS) cols[`osm_amenities.${k}`][0] = 1;      // all in the NW corner
        const f2 = L.frameFrom(codes, cols);
        const r = L._lenses.fifteen(f2, {});
        expect(r.columns.fifteen_min[0]).toBe(100);
        expect(r.columns.fifteen_min[n - 1]).toBe(0);
        expect(r.columns.mix[0]).toBeCloseTo(100, 6);                          // one of each: maximal entropy
    });
});

describe('UrbanLenses on committed city data', () => {
    it('runs every lens for Indore, in people, with equity and clusters', async () => {
        const r = await L.run('indore_pilot', await store());
        expect(r.schema).toBe('digipin.lenses/1');
        expect(r.residents).toBeGreaterThan(1e6);
        const ids = r.lenses.map(l => l.id);
        expect(ids).toEqual(expect.arrayContaining(['heat', 'flood', 'fifteen', 'health', 'air', 'lights', 'walk', 'sprawl', 'types', 'green', 'solar', 'confidence', 'burden']));
        const sp = r.lenses.find(l => l.id === 'sprawl');
        expect(sp.headline).toMatch(/infill/);
        expect(sp.fit.gradient).toBeGreaterThan(0);              // density falls away from the centre
        for (const l of r.lenses) {
            expect(l.headline.length).toBeGreaterThan(20);
            expect(l.sources).toContain('population');
            if (l.hotspots && l.hotspots.moranI != null) {
                expect(l.hotspots.moranI).toBeGreaterThan(-1);
                expect(l.hotspots.moranI).toBeLessThan(1.05);
            }
        }
        const heat = r.lenses.find(l => l.id === 'heat');
        expect(heat.equity.gini).toBeGreaterThan(0);
        expect(heat.equity.lorenz).toHaveLength(11);
        const cl = L.clusters(r, 'health');
        expect(cl.HH.length + cl.LL.length).toBeGreaterThan(0);
        const layer = L.toLayer(r);
        expect(layer.spec.fields.map(f => f.key)).toEqual(expect.arrayContaining(['hvi', 'flood_people', 'fifteen_min', 'health_access', 'pm25', 'ntl_resid', 'walk_index', 'lei', 'archetype', 'burden']));
        const arch = layer.spec.fields.find(f => f.key === 'archetype');
        expect(arch.type).toBe('category');
        expect(arch.domain.length).toBeGreaterThanOrEqual(4);
        expect(arch.domain).toContain(layer.table.columns.archetype.find(v => v != null));
        expect(layer.table.cells.length).toBe(r.cells);
        expect(L.toText(r)).toMatch(/Heat vulnerability/);
    }, 60000);

    it('exposes one lens and siting through the stable lens() contract', async () => {
        const st = await store();
        const h = await L.lens('heat', 'indore_pilot', st);
        expect(h.schema).toBe('digipin.lens/1');
        expect(h.layer.spec.fields.map(f => f.key)).toEqual(['hvi']);
        expect(h.findings.length).toBeGreaterThan(2);
        expect(h.sources.map(x => x.id)).toContain('surface_heat');
        expect(h.text).toMatch(/Heat vulnerability/);
        const s2 = await L.lens('siting', 'indore_pilot', st, { preset: 'clinic', sites: 5 });
        expect(s2.sites).toHaveLength(5);
        expect(s2.consistency).toBeLessThan(0.1);
        expect(s2.weights.reduce((a, w) => a + w.weight, 0)).toBeCloseTo(1, 2);
        expect(s2.layer.table.cells.length).toBeGreaterThan(1000);
        await expect(L.lens('nope', 'indore_pilot', st)).rejects.toThrow(/Unknown lens/);
        expect(L.catalog().map(c => c.id)).toContain('siting');
    }, 60000);
});
