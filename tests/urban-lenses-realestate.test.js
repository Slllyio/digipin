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
        for (const id of ['landvalue', 'buildhot', 'vacant', 'rentdemand', 'affordability', 'undervalued', 'redevelop', 'nextgrowth', 'housinggap', 'floodloss', 'encroach', 'feasible', 'metroboost', 'climate2050', 'streetheat', 'flood2050', 'solarhome', 'waterrisk', 'climategrade', 'riskygrowth', 'vitality', 'coolroof', 'change']) expect(ids).toContain(id);
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

    it('damage() and ead(): JRC curve, protection standard', () => {
        expect(RE.damage(0)).toBe(0);
        expect(RE.damage(0.25)).toBeCloseTo(0.165, 3);
        expect(RE.damage(10)).toBe(1);
        expect(RE.ead(0, 100, 2)).toBeCloseTo((0.1 - 0.01) * 50 + 1, 6);    // unprotected: 10→100 trapezoid + tail
        expect(RE.ead(50, 100, 100)).toBeCloseTo(1, 6);                      // protected to 100-yr: only the tail
        expect(RE.ead(50, 100, 25)).toBeLessThan(RE.ead(50, 100, 2));
    });

    it('floodloss: buildings in the floodplain lose money every year', () => {
        const cover = codes.map(() => 30), f100 = codes.map((_, i) => (i < SIZE ? 100 : 0));
        const f10 = f100.map(v => v / 2), dm = f100.map(v => v / 100 * 1.5);
        const f = L.frameFrom(codes, { ...base, 'building_stock.cover_2023_pct': cover, 'water.flood_rp100_pct': f100, 'water.flood_rp10_pct': f10, 'water.flood_rp100_depth_m': dm });
        const r = L._lenses.floodloss(f, {});
        expect(r.idx).toHaveLength(SIZE);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats[0].value).toMatch(/crore/);
        expect(L._lenses.floodloss(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('encroach: former water built up, floodplain building', () => {
        const wl = codes.map((_, i) => (i === 0 ? 40 : 0)), wb = codes.map((_, i) => (i === 0 ? 20 : 0));
        const fn = codes.map((_, i) => (i === n - 1 ? 5 : 0));
        const f = L.frameFrom(codes, { ...base, 'encroachment.water_lost_pct': wl, 'encroachment.water_built_pct': wb, 'encroachment.flood_new_pct': fn });
        const r = L._lenses.encroach(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.filter(s => s.label.startsWith('Encroachment hotspot'))).toHaveLength(2);
        expect(r.headline).toMatch(/floodplain/);
    });

    it('feasibility(): residual land value and break-even price', () => {
        const f = RE.feasibility({ price: 100000, far: 2, farNow: 1 });
        expect(f.gdv).toBe(250000);                                          // 2 × 1.25 × ₹1 lakh
        expect(f.build).toBeCloseTo(2 * 1.4 * 22000 * 1.15, 6);
        expect(f.rlv).toBeCloseTo(250000 - 70840 - 50000, 6);
        expect(f.euv).toBeCloseTo(1 * 1.25 * 100000 * 0.6, 6);
        expect(RE.feasibility({ price: f.breakEvenPrice, far: 2 }).rlv).toBeCloseTo(0, 6);
        const tall = RE.feasibility({ price: 100000, far: 4 });                 // 8 storeys: +12% build cost
        expect(tall.build).toBeCloseTo(4 * 1.4 * 22000 * 1.12 * 1.15, 6);
        expect(RE.feasibility({ price: tall.breakEvenPrice, far: 4 }).rlv).toBeCloseTo(0, 6);
        expect(RE.feasibility({ price: null, far: 2 })).toBeNull();
        expect(RE.blockPrice('delhi', 200)).toBeCloseTo(2 * 8900 * 10.764, 6);
        expect(RE.blockPrice('nowhere', 100)).toBeNull();
    });

    it('feasible: viable share, rebuild candidates and TOD uplift', () => {
        const fn = codes.map((_, i) => (col(i) === 0 ? 0.6 : 1.8)), mw = codes.map((_, i) => (i < SIZE ? 5 : 40));
        const vh = codes.map((_, i) => (i < SIZE ? 0.5 : 0));
        const f = L.frameFrom(codes, { ...base, 're_supply.far_now': fn, 'rail_access.metro_walk_min': mw, 're_supply.vacant_ha': vh }, { city: 'delhi' });
        const r = L._lenses.feasible(f, {});
        expect(r.metric.value).toBe(100);
        expect(r.headline).toMatch(/FAR of 2/);
        expect(r.stats.find(s => s.label.startsWith('Redevelopment candidate 1')).value).toMatch(/FAR now 1.8/);           // dear east blocks pay to rebuild even at FAR 1.8
        expect(r.columns.redev_gain[0]).toBeLessThan(0);                       // cheap west block at FAR 0.6 does not
        expect(r.stats.some(s => /TOD/.test(s.label))).toBe(true);
        expect(r.columns.tod_uplift[SIZE - 1]).toBeGreaterThan(0);              // dear block: FAR 4 pays
        expect(r.columns.tod_uplift[0]).toBeLessThan(0);                       // cheap block: 8 storeys cost more than they sell for
        expect(Number.isNaN(r.columns.tod_uplift[n - 1])).toBe(true);
        expect(L._lenses.feasible(L.frameFrom(codes, base), {})).toBeNull();   // no city price
    });

    it('metroboost: residents newly within a walk of an upcoming station', () => {
        const fw = codes.map((_, i) => (i < SIZE ? 5 : i < 2 * SIZE ? 15 : NaN)), up = fw.map(v => (v === 5 ? 10.5 : v === 15 ? 3 : NaN));
        const now = codes.map(() => 40), fn = codes.map(() => 1);
        const f = L.frameFrom(codes, { ...base, 'metro_future.future_walk_min': fw, 'metro_future.value_uplift_pct': up, 'rail_access.metro_walk_min': now, 're_supply.far_now': fn }, { city: 'bengaluru' });
        const r = L._lenses.metroboost(f, {});
        expect(r.idx).toHaveLength(2 * SIZE);
        expect(r.metric.value).toBe(SIZE * 1000);                              // the top row's residents
        expect(r.headline).toMatch(/TOD FAR/);
        expect(r.stats.find(s => /Value added/.test(s.label)).value).toMatch(/crore/);
        expect(L._lenses.metroboost(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('climate2050: resident-weighted hot days and warm nights, now and 2050', () => {
        const h0 = codes.map(() => 20), h1 = codes.map((_, i) => (i < SIZE ? 60 : 30)), w0 = codes.map(() => 10), w1 = codes.map(() => 30);
        const f = L.frameFrom(codes, { ...base, 'climate_future.hot_days_now': h0, 'climate_future.hot_days_2050': h1, 'climate_future.hot_days_2050_high': h1.map(v => v + 5),
            'climate_future.warm_nights_now': w0, 'climate_future.warm_nights_2050': w1, 'climate_future.tmax_rise_c': codes.map(() => 1.5), 'climate_future.wettest_day_change_pct': codes.map(() => 8) });
        const r = L._lenses.climate2050(f, {});
        expect(r.metric.value).toBeGreaterThan(30);
        expect(r.metric.value).toBeLessThan(60);
        expect(r.columns.heat_added[0]).toBe(60);                               // +40 hot days, +20 warm nights
        expect(r.headline).toMatch(/2050/);
        expect(r.stats.find(s => /Wettest|wettest/.test(s.label)).value).toBe('+8%');
        expect(r.stats.find(s => /30 or more/.test(s.label)).value).toMatch(/\d/);
        expect(L._lenses.climate2050(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('streetheat: block heat island shifts the 2050 counts', () => {
        const uhi = codes.map((_, i) => (i < SIZE ? 6 : i < 2 * SIZE ? -4 : 0));      // hot row +1.8 °C air, cool row −1.2 °C
        const f = L.frameFrom(codes, { ...base, 'climate_future.hot_days_now': codes.map(() => 20), 'climate_future.hot_days_2050': codes.map(() => 30),
            'climate_future.hot_days_per_c_2050': codes.map(() => 10), 'climate_future.warm_nights_2050': codes.map(() => 40), 'climate_future.warm_nights_per_c_2050': codes.map(() => 8),
            'climate_future.cdd_now': codes.map(() => 1000), 'climate_future.cdd_2050': codes.map(() => 1300), 'climate_future.cooling_days_2050': codes.map(() => 200),
            'surface_heat.uhi_anomaly_c': uhi, 'surface_heat.modis_night_c': codes.map(() => 25), 'vegetation.tree_canopy_pct': codes.map(() => 2) });
        const r = L._lenses.streetheat(f, {});
        expect(r.columns.hot_2050_block[0] - r.columns.hot_2050_block[SIZE]).toBeCloseTo(30);   // 10 days/°C × 0.3 × (6 − −4)
        expect(r.columns.hot_2050_block[0]).toBeGreaterThan(30);
        expect(r.columns.warm_2050_block[0]).toBe(40);                          // flat night anomaly
        expect(r.metric.value).toBeGreaterThanOrEqual(r.stats[0].value.split(' vs ')[1] * 1);
        expect(r.stats.find(s => /Cooling need/.test(s.label)).value).toMatch(/\+\d+%/);
        expect(r.stats.find(s => /tree canopy/.test(s.label)).value).toMatch(/100%/);
        expect(L._lenses.streetheat(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('flood2050: residents in the 100-year river or sea flood zone, now and 2050', () => {
        const now = codes.map((_, i) => (i < SIZE ? 50 : 0)), fut = codes.map((_, i) => (i < SIZE ? 100 : i < 2 * SIZE ? 50 : 0));
        const zero = codes.map(() => 0);
        const f = L.frameFrom(codes, { ...base, 'flood_future.any_pct_now': now, 'flood_future.any_pct_2050': fut, 'flood_future.river_pct_now': now, 'flood_future.river_pct_2050': fut,
            'flood_future.river_pct_2050_high': fut, 'flood_future.coast_pct_now': zero, 'flood_future.coast_pct_2050': zero, 'flood_future.coast_pct_2050_high': zero });
        const r = L._lenses.flood2050(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.columns.flood_added_pct[SIZE]).toBe(50);
        expect(r.headline).toMatch(/up from/);
        expect(r.stats.some(s => /Coastal/.test(s.label))).toBe(false);          // no sea here
        const dry = L.frameFrom(codes, { ...base, 'flood_future.any_pct_now': zero, 'flood_future.any_pct_2050': zero });
        expect(L._lenses.flood2050(dry, {}).headline).toMatch(/^No residents/);
        expect(L._lenses.flood2050(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('change: strongly changed land against the city median, hotspots named by what changed', () => {
        const c8 = codes.map((_, i) => (i === 0 || i === SIZE * 11 + 11 ? 0.2 : 0.02));
        const c2 = codes.map((_, i) => (i === 5 ? 0.1 : 0.01));
        const nb = codes.map((_, i) => (i === 0 ? 300 : 0));
        const f = L.frameFrom(codes, { ...base, 'embeddings.change_8yr': c8, 'embeddings.change_2yr': c2, 'building_stock.new_buildings': nb }, { city: 'delhi' });
        const r = L._lenses.change(f, {});
        expect(r.stats.find(x => /changed strongly since 2017/.test(x.label)).value).toMatch(/\(1\.4% of blocks\)/);
        expect(r.headline).toMatch(/50% of it gained 20 or more new buildings/);
        expect(r.headline).toMatch(/1 blocks are changing fast/);
        expect(r.stats.some(x => /hotspot/.test(x.label) && /300 new buildings/.test(x.value))).toBe(true);
        expect(L._lenses.change(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('lookalikeText lists matches and handles a missing block', () => {
        const t = RE.lookalikeText({ fromCity: 'delhi', toCity: 'pune', ref: { code: '39J4M98' }, matches: [{ code: '4FP493F', similarity: 72, people: 1200 }] });
        expect(t).toMatch(/look most like 39J4M98/);
        expect(t).toMatch(/1\. 4FP493F: 72% match/);
        expect(RE.lookalikeText(null)).toMatch(/no satellite embedding/);
    });

    it('coolroof: dark roof area, residents under dark roofs, priority for hot poor low-rise blocks', () => {
        const k = v => codes.map(() => v);
        const dark = codes.map((_, i) => (col(i) < 6 ? 80 : 10));
        const lst = codes.map((_, i) => (i < SIZE * 6 ? 44 : 40));
        const f = L.frameFrom(codes, { ...base, 'roofs.roof_albedo': dark.map(d => (d > 50 ? 0.12 : 0.25)), 'roofs.dark_roof_pct': dark,
            'building_stock.cover_2023_pct': k(50), 'building_stock.height_2023_m': k(4), 'surface_heat.lst_day_c': lst, 'wealth.rwi': k(-0.2) }, { city: 'delhi' });
        const r = L._lenses.coolroof(f, {});
        expect(r.columns.cool_priority[0]).toBeGreaterThan(r.columns.cool_priority[SIZE - 1]);   // dark west beats light east
        expect(r.columns.cool_priority[0]).toBeGreaterThan(r.columns.cool_priority[SIZE * 11]);  // hot north beats cool south
        expect(r.metric.value).toBe(Math.round(n * 1000 * 0.45));
        expect(r.headline).toMatch(/45% of the city's roof area is dark/);
        expect(L._lenses.coolroof(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('solarhome: roof per household, payback after subsidy, AC cover', () => {
        const cover = codes.map((_, i) => (i < SIZE ? 60 : 1));                   // roomy top row, almost no roof elsewhere
        const f = L.frameFrom(codes, { ...base, 'building_stock.cover_2023_pct': cover, 'climate_future.cdd_2050': codes.map(() => 1500) }, { city: 'delhi' });
        const r = L._lenses.solarhome(f, {});
        expect(r.columns.home_kwp[0]).toBeGreaterThan(r.columns.home_kwp[SIZE]);
        expect(r.columns.home_kwp.every(v => Number.isNaN(v) || v <= 3)).toBe(true);
        const k = r.columns.home_kwp[0], pay = r.columns.payback_yr[0];
        if (k >= 1) { expect(pay).toBeGreaterThan(2); expect(pay).toBeLessThan(8); }
        expect(Number.isNaN(r.columns.payback_yr[SIZE])).toBe(true);           // under 1 kW: no system
        expect(r.headline).toMatch(/community solar/);
        expect(L._lenses.solarhome(L.frameFrom(codes, base, { city: 'delhi' }), {})).toBeNull();
    });

    it('waterrisk: basin stress now, 2030 → 2050 and groundwater decline', () => {
        const k = v => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'water_risk.water_stress_pct': k(250), 'water_risk.water_stress_2030_pct': k(90), 'water_risk.water_stress_2050_pct': k(120),
            'water_risk.groundwater_decline_cm_yr': k(10), 'water_risk.drought_risk': k(4) });
        const r = L._lenses.waterrisk(f, {});
        expect(r.metric.value).toBe(120);
        expect(r.headline).toMatch(/withdraws 2.5 times its renewable water/);
        expect(r.stats.find(s => /2030/.test(s.label)).value).toBe('90% → 1.2 times');
        expect(r.stats.find(s => /Groundwater/.test(s.label)).value).toMatch(/2.4 m more by 2050/);
        expect(L._lenses.waterrisk(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('climategrade: heat, flood and water on fixed scales, graded A–E', () => {
        const k = v => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'climate_future.hot_days_2050': k(60), 'climate_future.hot_days_per_c_2050': k(5), 'climate_future.warm_nights_2050': k(90),
            'surface_heat.uhi_anomaly_c': k(0), 'humid_heat.humid_heat_days': k(60), 'flood_future.any_pct_2050': codes.map((_, i) => (i < SIZE ? 100 : 0)),
            'water_risk.water_stress_2050_pct': k(100), 'water_risk.groundwater_decline_cm_yr': k(15) });
        const r = L._lenses.climategrade(f, {});
        expect(r.columns.climate_score[0]).toBeCloseTo(100);                      // worst on every part
        expect(r.columns.climate_score[SIZE]).toBeCloseTo(65);                    // dry: 40 + 25
        expect(RE.climateGrade(10)).toBe('A');
        expect(RE.climateGrade(64.9)).toBe('D');
        expect(RE.climateGrade(65)).toBe('E');
        expect(r.headline).toMatch(/grades E/);
        expect(L._lenses.climategrade(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('riskygrowth: new floor area in the 2050 flood zone and the tilt against land', () => {
        const nf = codes.map((_, i) => (i < SIZE ? 1000 : 10)), fl = codes.map((_, i) => (i < SIZE ? 100 : 0));
        const f = L.frameFrom(codes, { ...base, 're_supply.new_floor_m2': nf, 'flood_future.any_pct_2050': fl });
        const r = L._lenses.riskygrowth(f, {});
        expect(r.columns.risky_floor_m2[0]).toBe(1000);
        expect(r.columns.risky_floor_m2[SIZE]).toBe(0);
        expect(r.metric.value).toBeGreaterThan(50);
        expect(r.headline).toMatch(/drifting toward flood land/);
        const dry = L.frameFrom(codes, { ...base, 're_supply.new_floor_m2': nf, 'flood_future.any_pct_2050': codes.map(() => 0) });
        expect(L._lenses.riskygrowth(dry, {}).headline).toMatch(/^Almost none/);
        expect(L._lenses.riskygrowth(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('vitality: places per block, high streets and retail gaps', () => {
        const pl = codes.map((_, i) => (i === 0 ? 300 : i < SIZE ? 30 : 0)), shop = pl.map(v => v / 2), food = pl.map(v => v / 4);
        const f = L.frameFrom(codes, { ...base, 'places.places': pl, 'places.shopping': shop, 'places.food': food, 'places.branded_pct': codes.map(() => 10) });
        const r = L._lenses.vitality(f, {});
        expect(r.columns.places_km2[0]).toBeGreaterThan(r.columns.places_km2[1]);
        expect(r.stats.some(s => /^High street 1/.test(s.label))).toBe(true);
        expect(r.stats.find(s => /chains/.test(s.label)).value).toBe('10%');
        expect(r.headline).toMatch(/high streets/);
        expect(L._lenses.vitality(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('farText(): base vs asked FAR, rebuild and homes', () => {
        const t = RE.farText({ ok: true, code: '39J4M98', far: 3, base: 2, farNow: 1.2, price: 95800, metro: 6, rough: false,
            rlvBase: 120000, rlv: 170000, gainBase: 30000, gain: 80000, homesHa: 1000, storeys: 6, costM2: 23320 });
        const lines = t.split('\n');
        expect(lines[0]).toBe('At FAR 3 instead of the base 2, the plot is worth ₹1.7 lakh per m² to a developer (+₹50,000, +42%).');
        expect(lines[2]).toMatch(/^Rebuilding the existing floors \(FAR 1.2 now\) pays/);
        expect(lines[3]).toMatch(/1,000 more homes a hectare/);
        expect(lines[4]).toMatch(/inside a TOD zone/);
        expect(RE.farText({ ok: false, code: '39J4M98', why: 'No price anchor for this city.' })).toMatch(/No price anchor/);
    });

    it('reScorecard(): rank-based pillars, capped housing pace, neutral metrics given a direction', () => {
        const city = (label, hg, fl, fe) => ({ label, metrics: { housinggap: { label: 'pace', unit: '×', higherIs: 'better', value: hg },
            floodloss: { label: 'flood', unit: '%/yr', higherIs: 'worse', value: fl }, feasible: { label: 'viable', unit: '%', higherIs: null, value: fe } } });
        const sc = RE.reScorecard({ generated: 'x', cities: { a: city('A', 9.8, 0.1, 90), b: city('B', 1.6, 0.3, 50), c: city('C', 0.6, 0.2, 70) } });
        expect(sc.kind).toBe('realestate');
        const by = Object.fromEntries(sc.cities.map(r => [r.city, r]));
        expect(by.a.scores.housinggap).toBe(by.b.scores.housinggap);          // both capped at 1.5×: a tie
        expect(by.c.scores.housinggap).toBe(0);
        expect(by.a.scores.floodloss).toBe(100);
        expect(by.a.scores.feasible).toBe(100);                               // neutral on the map, better here
        expect(sc.cities[0].city).toBe('a');
        expect(RE.reScorecardText(sc, 'b')).toMatch(/^B ranks \d of 3 on real estate/);
        expect(RE.reScorecard({ cities: { a: city('A', 1, 1, 1) } })).toBeNull();
    });

    it('similarText(): reference profile and ranked matches', () => {
        const t = RE.similarText({ fromCity: 'delhi', toCity: 'pune', ref: { code: '39J4M98', profile: [{ label: 'land value', pct: 98 }, { label: 'density', pct: 50 }, { label: 'wealth', pct: 3 }] },
            matches: [{ code: '4FP4C73', similarity: 94, differs: [] }, { code: '4FP493F', similarity: 90, differs: ['more high-rise'] }] });
        expect(t).toMatch(/land value 98th percentile, wealth 3rd percentile, density 50th percentile/);
        expect(t).toMatch(/2\. 4FP493F: 90% similar; more high-rise/);
        expect(RE.similarText(null)).toMatch(/Click a block/);
    });
});
