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

describe('UrbanLenses league', () => {
    it('ranks a city on each metric, direction-aware', () => {
        const lg = { cities: {
            a: { label: 'A', metrics: { air: { label: 'PM', value: 40, unit: 'µg/m³', higherIs: 'worse' }, fifteen: { label: 'x', value: 80, unit: '%', higherIs: 'better' } } },
            b: { label: 'B', metrics: { air: { label: 'PM', value: 90, unit: 'µg/m³', higherIs: 'worse' }, fifteen: { label: 'x', value: 50, unit: '%', higherIs: 'better' } } },
        } };
        const r = L.leagueFor(lg, 'b');
        expect(r.find(x => x.id === 'air')).toMatchObject({ rank: 2, of: 2, best: { city: 'A', value: 40 } });
        expect(r.find(x => x.id === 'fifteen').rank).toBe(2);
        expect(L.leagueFor(lg, 'a').every(x => x.rank === 1)).toBe(true);
    });
    it('the committed league file covers every city with the current metrics', () => {
        const lg = JSON.parse(readFileSync(path.join(ROOT, 'data/lenses/league.json'), 'utf-8'));
        expect(lg.schema).toBe('digipin.lens-league/1');
        expect(Object.keys(lg.cities).length).toBeGreaterThanOrEqual(13);
        expect(L.leagueFor(lg, 'delhi').length).toBeGreaterThanOrEqual(8);
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

    it('walking network: a river with one far bridge cuts the clinic off from the far bank', () => {
        // N/E/S/W street grid; no links across the river between columns 2 and 3 except on the last row.
        const N = 1, E = 4, S = 16, W = 64;
        const links = codes.map((_, i) => {
            const r = Math.floor(i / SIZE), c = i % SIZE;
            let m = 0;
            if (r > 0) m |= N;                           // block rows run north → south
            if (r < SIZE - 1) m |= S;
            if (c > 0 && (c !== 3 || r === SIZE - 1)) m |= W;
            if (c < SIZE - 1 && (c !== 2 || r === SIZE - 1)) m |= E;
            return m;
        });
        const net = L.walkNet(fr.grid, Float64Array.from(links));
        expect(net.has).toBe(true);
        const r = net.reach(0, 2);
        expect(r.net).toBe(true);
        const d = new Map(Array.from({ length: r.len }, (_, t) => [r.js[t], r.ds[t]]));
        expect(d.get(0)).toBe(0);
        expect(d.get(2)).toBeCloseTo(2 * fr.grid.dx, 6);      // two blocks east, same as straight line
        expect(d.has(3)).toBe(false);                          // across the river: > 2 km round by the bridge
        expect(d.get(SIZE + 1)).toBeCloseTo(fr.grid.dx + fr.grid.dy, 6);   // Manhattan, not diagonal
        const Anet = L.e2sfca(fr.grid, health, pop, 2, net), Aeuc = L.e2sfca(fr.grid, health, pop, 2);
        expect(Aeuc[3]).toBeGreaterThan(0);
        expect(Anet[3]).toBe(0);
        expect(Anet.reduce((a, v, i) => a + v * pop[i], 0)).toBeCloseTo(2, 6);
        // Cells with no links fall back to the straight-line disk.
        const sparse = L.walkNet(fr.grid, Float64Array.from(links, (m, i) => (i === 5 ? 0 : m)));
        expect(sparse.reach(5, 1).net).toBe(false);
        // Pedestrian shed: the river halves what the corner cells reach.
        const frNet = L.frameFrom(codes, { 'population.population': pop, 'osm_walk.links': links });
        const shed = L.pedShed(frNet, 1);
        expect(shed[SIZE * 5 + 2]).toBeLessThan(shed[SIZE * 5 + 7]);
        expect(shed[SIZE * 5 + 7]).toBeLessThanOrEqual(1);
    });

    it('transit lens: SDG 11.2.1 coverage from a bus stop (500 m) and a station (1 km)', () => {
        const stops = new Array(n).fill(0), rapid = new Array(n).fill(0);
        stops[0] = 1;                                // a bus stop in the NW corner
        rapid[n - 1] = 1;                            // a station in the SE corner
        const f = L.frameFrom(codes, { 'population.population': pop, 'osm_transit.stops': stops, 'osm_transit.rapid': rapid });
        const r = L._lenses.transit(f, {});
        const m = r.columns.transit_m, k = r.columns.rapid_m;
        expect(m[0]).toBe(0);
        expect(m[1]).toBeCloseTo(1000 * f.grid.dx, 6);
        expect(k[n - 1]).toBe(0);
        const ok = i => m[i] <= 500 || k[i] <= 1000;
        const want = pop.reduce((a, p, i) => a + (ok(i) ? p : 0), 0);
        const total = pop.reduce((a, p) => a + p, 0);
        expect(r.metric.value).toBeCloseTo(100 * want / total, 1);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.metric.value).toBeLessThan(50);           // the middle of a 3 km block is out of reach
        expect(L._lenses.transit(fr, {})).toBeNull();       // no transit points → no lens
    });

    it('transit lens: GTFS frequency — residents near a bus every 10 min or better', () => {
        const stops = new Array(n).fill(0), rapid = new Array(n).fill(0);
        stops[0] = 1; stops[n - 1] = 1;
        const hw = codes.map((_, i) => (i === 0 ? 6 : i === n - 1 ? 30 : NaN));   // NW frequent, SE every 30 min
        const f = L.frameFrom(codes, { 'population.population': pop, 'osm_transit.stops': stops, 'osm_transit.rapid': rapid, 'bus_service.best_headway_min': hw });
        const r = L._lenses.transit(f, {});
        const st = r.stats.find(x => /every 10 min/.test(x.label));
        expect(st.raw).toBeGreaterThan(0);
        expect(st.raw).toBeLessThan(pop.reduce((a, b) => a + b, 0) / 2);
        expect(r.headline).toMatch(/bus every 10 minutes or better/);
        const plain = L._lenses.transit(L.frameFrom(codes, { 'population.population': pop, 'osm_transit.stops': stops, 'osm_transit.rapid': rapid }), {});
        expect(plain.stats.some(x => /every 10 min/.test(x.label))).toBe(false);
    });

    it('waterlog lens: counts residents of High cells and the poorest-fifth share', () => {
        const wl = codes.map((_, i) => (i % SIZE < 2 ? 70 : i % SIZE < 4 ? 50 : 10));    // two very high, two high columns
        const rwi = codes.map((_, i) => (i % SIZE < 2 ? -1 : 1));
        const f = L.frameFrom(codes, { 'population.population': pop, 'waterlogging.waterlogging_index': wl, 'wealth.rwi': rwi });
        const r = L._lenses.waterlog(f, {});
        const total = pop.reduce((a, b) => a + b, 0);
        const high = pop.filter((_, i) => i % SIZE < 4).reduce((a, b) => a + b, 0);
        expect(r.metric.value).toBeCloseTo(100 * high / total, 0);
        expect(r.columns.waterlog_people[0]).toBe(pop[0]);
        expect(r.columns.waterlog_people[SIZE - 1]).toBe(0);
        expect(r.headline).toMatch(/poorest fifth/);
        expect(L._lenses.waterlog(L.frameFrom(codes, { 'population.population': pop }), {})).toBeNull();
        // The flood lens takes its rain-pooling hazard from the same index.
        const fl = L._lenses.flood(f, {});
        expect(fl.columns.flood_hazard[0]).toBeCloseTo(35, 6);
        expect(fl.stats.some(s => /rain pools/.test(s.label))).toBe(true);
    });

    it('traffic lens: residents within 500 m of an over-capacity arterial', () => {
        const vc = codes.map((_, i) => (i === 0 ? 1.4 : i === n - 1 ? 0.3 : NaN));   // one jammed road NW, one quiet SE
        const sp = codes.map((_, i) => (i === 0 ? 8 : i === n - 1 ? 40 : NaN));
        const vkm = codes.map((_, i) => (i === 0 ? 3000 : i === n - 1 ? 1000 : NaN));
        const f = L.frameFrom(codes, { 'population.population': pop, 'traffic_load.peak_vc': vc, 'traffic_load.peak_speed_kmh': sp, 'traffic_load.daily_vkm': vkm });
        const r = L._lenses.traffic(f, {});
        expect(r.columns.traffic_vc[0]).toBe(1.4);
        expect(r.columns.traffic_vc[1]).toBe(1.4);                 // next cell (~244 m): still beside the jam
        expect(r.columns.traffic_vc[n - 1]).toBe(0.3);
        expect(Number.isNaN(r.columns.traffic_vc[Math.floor(SIZE / 2) * SIZE + 6])).toBe(true);   // no arterial within 500 m
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.headline).toMatch(/16 km\/h/);                    // (8·3000 + 40·1000) / 4000
        expect(L._lenses.traffic(L.frameFrom(codes, { 'population.population': pop }), {})).toBeNull();
        // Time of day: the NW road jams only in the evening.
        const am = codes.map((_, i) => (i === 0 ? 0.5 : i === n - 1 ? 0.3 : NaN));
        const ft = L.frameFrom(codes, { 'population.population': pop, 'traffic_load.peak_vc': vc,
            'traffic_load.am_vc': am, 'traffic_load.pm_vc': vc, 'traffic_load.mid_vc': am });
        const rt = L._lenses.traffic(ft, {});
        const st = (k) => rt.stats.find(x => x.label.includes(k));
        expect(st('morning').value).toMatch(/^0 /);
        expect(st('evening').value).not.toMatch(/^0 /);
        expect(rt.headline).toMatch(/morning or evening peak/);
    });

    it('noise lens: residents above the WHO road guideline and at 65 dB', () => {
        const ld = codes.map((_, i) => (i === 0 ? 70 : i === 1 ? 58 : i === n - 1 ? 45 : NaN));
        const nox = codes.map((_, i) => (i === 0 ? 12 : NaN));
        const f = L.frameFrom(codes, { 'population.population': pop, 'traffic_noise.lden_db': ld, 'traffic_noise.nox_kg_day': nox });
        const r = L._lenses.noise(f, {});
        const total = pop.reduce((a, b) => a + b, 0);
        expect(r.metric.value).toBeCloseTo(100 * (pop[0] + pop[1]) / total, 0);
        expect(r.columns.noise_lden[0]).toBe(70);
        expect(r.stats[1].raw).toBe(Math.round(pop[0]));
        expect(r.headline).toMatch(/WHO guideline of 53 dB/);
        expect(L._lenses.noise(L.frameFrom(codes, { 'population.population': pop }), {})).toBeNull();
    });

    it('ambulance lens: rush hour takes 10-minute hospital reach away; schools by noisy/jammed roads', () => {
        const night = codes.map((_, i) => (i === 0 ? 6 : i === 1 ? 8 : i === n - 1 ? 25 : NaN));
        const am = codes.map((_, i) => (i === 0 ? 7 : i === 1 ? 14 : i === n - 1 ? 30 : NaN));
        const pm = codes.map((_, i) => (i === 0 ? 9 : i === 1 ? 12 : i === n - 1 ? 28 : NaN));
        const sch = codes.map((_, i) => (i === 0 ? 2 : i === n - 1 ? 1 : 0));
        const ld = codes.map((_, i) => (i === 0 ? 70 : NaN));
        const f = L.frameFrom(codes, { 'population.population': pop, 'emergency_access.hospital_min_night': night,
            'emergency_access.hospital_min_am': am, 'emergency_access.hospital_min_pm': pm,
            'emergency_access.schools': sch, 'traffic_noise.lden_db': ld });
        const r = L._lenses.ambulance(f, {});
        const total = pop[0] + pop[1] + pop[n - 1];
        expect(r.columns.hosp_peak[0]).toBe(9);                    // worse of 09:00 and 18:00
        expect(r.columns.hosp_delay[1]).toBe(6);
        expect(r.metric.value).toBeCloseTo(100 * pop[0] / total, 0);
        expect(r.headline).toMatch(/against [\d.]+% at 3 am/);
        expect(r.headline).toMatch(/more than 20 minutes away/);
        const st = (k) => r.stats.find(x => x.label.includes(k));
        expect(st('65+ dB road noise').value).toMatch(/^2 of 3/);
        expect(L._lenses.ambulance(L.frameFrom(codes, { 'population.population': pop }), {})).toBeNull();
    });

    it('cutoff lens: a flooded column strands the far bank from the only clinic', () => {
        const rp = new Array(n).fill(0), depth = new Array(n).fill(0);
        for (let r = 0; r < SIZE; r++) { rp[r * SIZE + 3] = 100; depth[r * SIZE + 3] = 1; }   // column 3 floods
        const care = new Array(n).fill(0);
        care[0] = 1;
        const links = codes.map(() => 1 | 4 | 16 | 64);                     // N/E/S/W street grid
        const f = L.frameFrom(codes, { 'population.population': pop, 'water.flood_rp100_pct': rp, 'water.flood_rp100_depth_m': depth, 'osm_amenities.healthcare': care, 'osm_walk.links': links });
        const r = L._lenses.cutoff(f, {});
        const cls = r.columns.flood_access, dom = r.categories.flood_access.domain;
        expect(dom[cls[3]]).toBe('Flooded');
        expect(dom[cls[1]]).toBe('Unaffected');
        expect(dom[cls[4]]).toBe('Cut off from care');                   // ~1 km east of the clinic, across the water
        expect(dom[cls[n - 1]]).toBe('No care in reach anyway');
        expect(r.metric.value).toBeGreaterThan(0);
        // Shallow water (< 0.3 m) does not block.
        const f2 = L.frameFrom(codes, { 'population.population': pop, 'water.flood_rp100_pct': rp, 'water.flood_rp100_depth_m': depth.map(d => d * 0.1), 'osm_amenities.healthcare': care });
        expect(L._lenses.cutoff(f2, {})).toBeNull();
    });

    it('walkNet stop: the search halts at the nearest match', () => {
        const net = L.walkNet(fr.grid, null);
        const r = net.reach(SIZE * 2 + 2, 2, j => j === 0 || j === SIZE * 2 + 4);
        expect(r.hit).toBe(true);
        expect(r.js[r.len - 1]).toBe(SIZE * 2 + 4);                        // 2 cells east beats 2 diagonals NW
        const grid4 = L.walkNet(fr.grid, Float64Array.from(codes, () => 1 | 4 | 16 | 64));
        const q = grid4.reach(SIZE * 2 + 2, 2, j => j === 0 || j === SIZE * 2 + 4);
        expect(q.net && q.hit).toBe(true);
        expect(q.js[q.len - 1]).toBe(SIZE * 2 + 4);
        expect(q.ds[q.len - 1]).toBeCloseTo(2 * fr.grid.dx, 6);
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
        expect(ids).toEqual(expect.arrayContaining(['heat', 'flood', 'waterlog', 'noise', 'traffic', 'fifteen', 'health', 'air', 'lights', 'walk', 'sprawl', 'types', 'green', 'solar', 'confidence', 'seasons', 'burden']));
        const se = r.lenses.find(l => l.id === 'seasons');
        expect(se.series.lst.values.length).toBe(24);
        expect(se.headline).toMatch(/PM2\.5/);
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
