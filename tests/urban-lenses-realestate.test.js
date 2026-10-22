import { describe, it, expect } from 'vitest';

// UrbanLenses + UrbanLensesRealEstate are exposed by tests/setup.js.
const L = globalThis.UrbanLenses;
const RE = globalThis.UrbanLensesRealEstate;

function block(lat, lng, size) {
    const d = L.CELL_DEG, codes = [];
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) codes.push(globalThis.DigiPin.encode(lat - r * d, lng + c * d).replace(/-/g, '').slice(0, 7));
    return codes;
}

describe('Real-estate lenses on a hand-made grid', () => {
    const SIZE = 12;
    const codes = block(28.6, 77.2, SIZE);
    const n = codes.length;
    const pop = new Array(n).fill(1000);
    const col = i => i % SIZE;
    // Land value rises west → east; job reach rises too but is flat in the east half.
    const vi = codes.map((_, i) => 40 + 20 * col(i));
    const car = codes.map((_, i) => 10 + 3 * Math.min(col(i), 6) + (col(i) < 3 ? 30 : 0));
    const tr = car.map(v => v / 2);
    const base = { 'population.population': pop, 'land_value.value_index': vi, 'job_access.jobs_car_pct': car, 'job_access.jobs_transit_pct': tr };

    it('registers six lenses after the mobility set', () => {
        const ids = L.catalog().map(c => c.id);
        for (const id of ['landvalue', 'buildhot', 'vacant', 'rentdemand', 'affordability', 'undervalued', 'redevelop', 'nextgrowth', 'housinggap']) expect(ids).toContain(id);
    });

    it('landvalue: spread between the dearest and cheapest tenth, and the driver gap', () => {
        const jobs = codes.map((_, i) => col(i) * 5);
        const f = L.frameFrom(codes, { ...base, 'land_value.prem_jobs_pct': jobs });
        const r = L._lenses.landvalue(f, {});
        expect(r.metric.value).toBeGreaterThan(3);
        expect(r.headline).toMatch(/job reach/i);
        expect(r.stats.some(s => s.label.startsWith('Dearest pocket 1'))).toBe(true);
        expect(r.columns.land_rate_rs).toBeUndefined();                       // no rupee fit outside Delhi frames
        expect(L._lenses.landvalue(L.frameFrom(codes, { 'population.population': pop }), {})).toBeNull();
    });

    it('rate(): Delhi circle-rate knots interpolate in logs and clamp at the ends', () => {
        const kn = RE.RATE_KNOTS.delhi;
        expect(RE.rate('delhi', 1)).toBe(kn[0][1]);
        expect(RE.rate('delhi', 1e6)).toBe(kn[kn.length - 1][1]);
        expect(RE.rate('delhi', 160)).toBeGreaterThan(RE.rate('delhi', 100));
        expect(RE.rate('mumbai', 100)).toBeNull();
    });

    it('buildhot and vacant: totals, metro share and homes', () => {
        const nf = codes.map((_, i) => (i < SIZE ? 10000 : 0));
        const br = nf.map(v => v / 7);
        const mw = codes.map((_, i) => (i < SIZE / 2 ? 5 : 30));
        const vh = codes.map((_, i) => (i === 0 ? 2 : 0));
        const f = L.frameFrom(codes, { ...base, 're_supply.new_floor_m2': nf, 're_supply.build_rate': br, 're_supply.vacant_ha': vh, 'rail_access.metro_walk_min': mw });
        const b = L._lenses.buildhot(f, {});
        expect(b.metric.value).toBe(50);
        expect(b.stats[0].value).toMatch(/^0\.1 km²/);
        const v = L._lenses.vacant(f, {});
        expect(v.metric.value).toBe(0);                                      // 2 ha = 0.02 km², rounds to 0
        expect(v.stats[1].value).toMatch(/about/);
        expect(v.stats.find(s => s.label.startsWith('Best-located vacant land 1')).label).toContain(codes[0]);
    });

    it('rentdemand and undervalued: strong access on cheap land', () => {
        const f = L.frameFrom(codes, base);
        const r = L._lenses.rentdemand(f, {});
        expect(r.metric.value).toBeGreaterThan(0);                            // west columns: high reach, low value
        expect(r.stats.find(s => s.label.startsWith('Rental hotspot 1')).value).toMatch(/percentile/);
        const u = L._lenses.undervalued(f, {});
        expect(u.stats[0].raw).toBeGreaterThan(0);
        expect(u.columns.upside[0]).toBeGreaterThan(u.columns.upside[SIZE - 1]);
    });

    it('affordability: dear land with poor neighbours', () => {
        const rwi = codes.map((_, i) => (col(i) >= SIZE - 2 ? -1 : 0.1 * col(i)));
        const f = L.frameFrom(codes, { ...base, 'wealth.rwi': rwi });
        const r = L._lenses.affordability(f, {});
        expect(r.metric.value).toBeGreaterThan(5);
        expect(r.stats.find(s => s.label.startsWith('Pressure pocket 1')).value).toMatch(/1st|2nd|3rd|\dth/);
        expect(L._lenses.affordability(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('redevelop: old blocks getting taller', () => {
        const dh = codes.map((_, i) => (i < SIZE ? 3 : 0.2));
        const sy = codes.map((_, i) => (i < 2 * SIZE ? 1985 : 2010));
        const f = L.frameFrom(codes, { ...base, 'building_dynamics.height_change_m': dh, 'building_dynamics.settled_year': sy });
        const r = L._lenses.redevelop(f, {});
        expect(r.metric.value).toBe(50);                                     // 12 of 24 old blocks
        expect(r.stats.find(s => s.label.startsWith('Redevelopment hotspot 1')).value).toMatch(/\+3 m/);
        expect(Number.isNaN(r.columns.height_change[n - 1])).toBe(true);     // new blocks left out
        expect(L._lenses.redevelop(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('nextgrowth: projected gain, recent building and pace', () => {
        const pg = codes.map((_, i) => (i === 0 ? 30 : 1));
        const dw = codes.map((_, i) => (i === 0 ? 20 : 0));
        const f = L.frameFrom(codes, { ...base, 'building_dynamics.proj_gain_pp': pg, 'building_dynamics.dw_built_change': dw });
        const r = L._lenses.nextgrowth(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.columns.growth_score[0]).toBe(40);
        expect(r.stats.find(s => s.label.startsWith('Growth frontier 1')).label).toContain(codes[0]);
        expect(r.stats.some(s => s.label.startsWith('Growth frontier 2'))).toBe(false);
    });

    it('housinggap: projected households against the building pace', () => {
        const p30 = pop.map((p, i) => (i < SIZE ? p + 4300 : p));         // +1,000 households on the top row
        const nf = codes.map((_, i) => (i === n - 1 ? 1.5 * 50 / 0.7 * 100 : 0)); // 100 homes, bottom corner
        const f = L.frameFrom(codes, { ...base, 'population.projected_2030': p30, 're_supply.new_floor_m2': nf });
        const r = L._lenses.housinggap(f, {});
        expect(r.metric.value).toBe(0.01);                                    // 75 homes for 12,000 households, rounded
        expect(r.headline).toMatch(/only/);
        expect(r.columns.housing_gap[0]).toBeGreaterThan(200);
        expect(r.stats.find(s => s.label.startsWith('Shortfall pocket 1')).value).toMatch(/no vacant land/);
        expect(L._lenses.housinggap(L.frameFrom(codes, base), {})).toBeNull();
    });
});
