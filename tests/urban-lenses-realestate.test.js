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
        for (const id of ['since1951', 'challans', 'junctions', 'liquefy', 'vitals', 'streetdogs', 'floodspots', 'crashzones', 'schoolready', 'lakeoxygen', 'lakewater', 'wellwater', 'measuredair', 'waterstorage', 'treefelling', 'smallbiz', 'districtdev', 'districtincome', 'gwstress', 'tollring', 'wardcouncil', 'citycrime', 'rollrevision', 'spending', 'roaddeaths', 'mlaseats', 'healthnow', 'fringevillages', 'civicworks', 'feelslike', 'lowground', 'homes2011', 'licences', 'streetgrid', 'ptax', 'jobcount', 'tankbeds', 'hotdays', 'landvalue', 'buildhot', 'vacant', 'rentdemand', 'affordability', 'undervalued', 'redevelop', 'nextgrowth', 'housinggap', 'floodloss', 'encroach', 'feasible', 'metroboost', 'climate2050', 'streetheat', 'flood2050', 'solarhome', 'waterrisk', 'climategrade', 'riskygrowth', 'vitality', 'coolroof', 'change', 'airtrend', 'airdeaths', 'burning', 'ground', 'treeplant', 'farmloss', 'market', 'parkshare', 'mangrove', 'runoff', 'nighteconomy', 'catchment', 'sites', 'informal', 'ghost', 'floorspace', 'flightpath', 'services', 'anchors', 'lightning', 'recharge', 'stay', 'waterloss', 'dumps', 'heritage', 'landmix', 'reach', 'monthly', 'greenbelt', 'mosquito', 'buildingage', 'cooling', 'crowds', 'airport', 'gardens', 'powerlines', 'toilets', 'gated', 'drainage', 'cityfarms', 'tourism', 'coast', 'packed', 'techhubs', 'shadecare', 'cyclone', 'riders', 'summershade', 'builduse', 'railnoise', 'mothercare', 'events', 'marketfire', 'lakehealth', 'jobsmap', 'oldtall', 'critwater', 'quake', 'factoryhomes', 'refuge', 'firelanes', 'schoolsafe', 'hospitalsafe', 'stationload', 'walkups', 'treefall', 'gridflood', 'coaching', 'rainharvest', 'sitedust', 'hotelfire', 'quarries', 'heritagesafe', 'fuelsafe', 'carekit', 'coalplume', 'dumpsmoke', 'powercuts', 'wildedge', 'schoolgap', 'railgates', 'views', 'kilnsmoke', 'districthealth', 'floodagain', 'schoolstrain', 'slummap', 'turnout', 'treecensus', 'firereach', 'pondcensus', 'roadplan', 'lastrites', 'wellrisk', 'binreach', 'bigprojects', 'buildlimits', 'policereach', 'lakebuffer', 'parkreach', 'drainbuffer', 'birdlife', 'stormgap', 'watergap', 'stpnear', 'basics', 'sroload', 'pinsize', 'potholes', 'revvillage', 'bdalayout', 'watershedpave', 'studenthousing', 'vacant2017', 'landchange', 'wardfit', 'metrowait', 'landgrain', 'floodzones', 'gwdepth', 'gwprospect', 'homeswork', 'airmonitorgap', 'schooldrift', 'hotnights', 'newroads', 'raingaugegap', 'tbcare', 'servicecentres', 'recycling', 'publicland', 'daytime', 'sinking', 'nightshelters', 'greenchange', 'heatedup', 'coldnights', 'hillside', 'stillair', 'badairdays', 'floodnews', 'howbuilt']) expect(ids).toContain(id);
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

    it('jobsmap: jobs sum to resident workers, centres where floor space and places concentrate', () => {
        const k = v => codes.map(() => v);
        const hub = i => i === SIZE * 6 + 6;
        const f = L.frameFrom(codes, { ...base, 'built_up.volume_m3_m2': codes.map((_, i) => (hub(i) ? 10 : 1)), 'built_up.nonres_share_pct': codes.map((_, i) => (hub(i) ? 80 : 10)),
            'places.places': codes.map((_, i) => (hub(i) ? 500 : 5)) }, { city: 'delhi' });
        const r = L._lenses.jobsmap(f, {});
        const total = r.columns.jobs_est.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
        expect(total).toBeCloseTo(n * 1000 * 0.353, 0);
        expect(r.stats.find(x => /Employment centre 1/.test(x.label)).label).toContain(codes[SIZE * 6 + 6]);
        expect(r.columns.jobs_est[SIZE * 6 + 6]).toBeGreaterThan(50 * r.columns.jobs_est[0]);
        expect(L._lenses.jobsmap(L.frameFrom(codes, base), {})).toBeNull();
        void k;
    });

    it('lakehealth: joins water blocks into lakes and flags lost water, algae and weeds', () => {
        const lakeA = i => i === 0 || i === 1 || i === SIZE;            // three touching blocks, top-left
        const lakeB = i => i === SIZE * 10 + 10 || i === SIZE * 10 + 11; // two blocks, bottom-right
        const w0 = codes.map((_, i) => (lakeA(i) ? 80 : lakeB(i) ? 60 : 0));
        const w1 = codes.map((_, i) => (lakeA(i) ? 40 : lakeB(i) ? 60 : 0));
        const nd = codes.map((_, i) => (lakeA(i) ? 0.3 : lakeB(i) ? 0 : NaN));
        const wd = codes.map((_, i) => (lakeB(i) ? 50 : lakeA(i) ? 0 : NaN));
        const f = L.frameFrom(codes, { ...base, 'lakes.water_2019_pct': w0, 'lakes.water_now_pct': w1, 'lakes.chlorophyll_ndci': nd, 'lakes.weed_pct': wd }, { city: 'delhi' });
        const r = L._lenses.lakehealth(f, {});
        expect(r.stats[0].value).toMatch(/^2:/);
        expect(r.columns.lake_problems[0]).toBe(2);                    // lost half its water and algae-rich
        expect(r.columns.lake_problems[SIZE * 10 + 10]).toBe(1);       // weed-choked only
        expect(r.headline).toMatch(/1 are algae-rich, 1 are choked by weeds and 1 lost a fifth/);
        expect(L._lenses.lakehealth(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('treeplant: canopy gap in trees, room on open land, hot blocks first', () => {
        const k = v => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'vegetation.tree_canopy_pct': k(10), 'land_cover.grass_pct': codes.map((_, i) => (col(i) < 6 ? 20 : 0)),
            'land_cover.bare_pct': k(0), 'land_cover.shrub_pct': k(0), 'surface_heat.lst_day_c': codes.map((_, i) => (i < SIZE * 6 ? 44 : 40)) }, { city: 'delhi' });
        const r = L._lenses.treeplant(f, {});
        const gap = 0.2 * f.grid.cellKm2 * 1e6 / 50;
        expect(r.columns.trees_needed[0]).toBeCloseTo(gap, 3);
        expect(r.columns.plant_trees[0]).toBeCloseTo(0.5 * gap, 3);                      // half the 20% grass usable = 10% of the block
        expect(r.columns.plant_trees[SIZE - 1]).toBe(0);
        expect(r.stats.find(x => /Plant first 1/.test(x.label)).label).toMatch(new RegExp(codes.slice(0, SIZE * 6).filter((_, i) => i % SIZE < 6).join('|')));
        expect(L._lenses.treeplant(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('farmloss: farmland built over, the active edge and land likely urban by 2035', () => {
        const left = codes.map((_, i) => col(i) < 6);
        const f = L.frameFrom(codes, { ...base,
            'farmland.crop_2018_pct': codes.map(() => 80), 'farmland.crop_now_pct': left.map(l => (l ? 50 : 80)),
            'farmland.crop_built_pp': left.map(l => (l ? 30 : 0)), 'farmland.built_now_pct': left.map(l => (l ? 30 : 5)),
            'growth.urban_2035_pct': left.map(l => (l ? 80 : 10)) }, { city: 'delhi' });
        const r = L._lenses.farmloss(f, {});
        const km2 = f.grid.cellKm2;
        expect(r.columns.farm_built_ha[0]).toBeCloseTo(30 * km2, 6);
        expect(r.columns.farm_built_ha[SIZE - 1]).toBe(0);
        expect(r.columns.farm_edge[0]).toBe(1);
        expect(r.columns.farm_edge[SIZE - 1]).toBe(0);
        expect(r.metric.value).toBeCloseTo(0.3 * 72 * km2, 1);
        expect(r.stats.find(x => /Active edge/.test(x.label)).value).toMatch(/^72 blocks/);
        expect(r.headline).toMatch(/expects another [\d.]+ km² to go by 2035/);
        expect(L._lenses.farmloss(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('market: agents within 1 km, busiest blocks and emerging markets', () => {
        const f = L.frameFrom(codes, { ...base,
            'places.property_agents': codes.map((_, i) => (col(i) < 3 ? 4 : 0)),
            'land_value.value_index': codes.map((_, i) => (col(i) < 3 ? 30 : 70)) }, { city: 'delhi' });
        const r = L._lenses.market(f, {});
        expect(r.metric.value).toBe(4 * 3 * SIZE);
        expect(r.columns.agents_1km[0]).toBeGreaterThan(r.columns.agents_1km[SIZE - 1]);
        const em = codes.map((_, i) => i).filter(i => r.columns.market_emerging[i] === 1);
        expect(em.length).toBeGreaterThan(0);
        expect(em.every(i => col(i) < 3)).toBe(true);                         // busy and cheap: the agents' own strip
        expect(r.headline).toMatch(/estate agents and brokers/);
        expect(L._lenses.market(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('airdeaths: GEMM attributable deaths, share of NCD+LRI deaths and deaths avoided at the standard', () => {
        const pm = codes.map((_, i) => (col(i) < 6 ? 100 : 30));
        const f = L.frameFrom(codes, { ...base, 'air_trend.pm25_2022': pm }, { city: 'delhi' });
        const r = L._lenses.airdeaths(f, {});
        const rr = z => Math.exp(0.143 * Math.log(z / 1.6 + 1) / (1 + Math.exp(-(z - 15.5) / 36.8)));
        expect(r.columns.air_deaths[0]).toBeCloseTo(1000 * 0.005 * (1 - 1 / rr(97.6)), 6);
        expect(r.columns.air_deaths_per_lakh[0]).toBeGreaterThan(r.columns.air_deaths_per_lakh[SIZE - 1]);
        const avoided = 72 * 5 * (1 - rr(37.6) / rr(97.6));
        expect(r.stats.find(x => /avoided/.test(x.label)).value).toBe(`about ${Math.round(avoided)}`);
        expect(L._lenses.airdeaths(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('parkshare: park space per resident within 1 km, residents short, the gap to 10 m²', () => {
        const pk = codes.map((_, i) => (i === SIZE * 6 + 2 ? 200000 : 0));
        const f = L.frameFrom(codes, { ...base, 'parks.park_m2': pk, 'parks.big_park': pk.map(v => (v ? 1 : 0)) }, { city: 'delhi' });
        const r = L._lenses.parkshare(f, {});
        expect(r.metric.value).toBeCloseTo(200000 / (1000 * 144), 1);
        expect(r.columns.park_m2_per_resident[SIZE * 6 + 2]).toBeGreaterThan(0);
        expect(r.columns.park_m2_per_resident[SIZE - 1]).toBe(0);
        expect(r.columns.park_gap_m2[SIZE - 1]).toBe(10 * 1000);
        expect(r.headline).toMatch(/against WHO's 9 m²/);
        expect(L._lenses.parkshare(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('mangrove: area then and now, area lost, residents sheltered', () => {
        const m0 = codes.map((_, i) => (col(i) < 2 ? 80 : NaN)), m1 = codes.map((_, i) => (col(i) < 2 ? (i < SIZE * 6 ? 40 : 80) : NaN));
        const f = L.frameFrom(codes, { ...base, 'mangroves.mangrove_1996_pct': m0, 'mangroves.mangrove_2020_pct': m1,
            'mangroves.mangrove_lost_pct': codes.map((_, i) => (col(i) < 2 && i < SIZE * 6 ? 40 : col(i) < 2 ? 0 : NaN)) }, { city: 'mumbai' });
        const r = L._lenses.mangrove(f, {});
        const km2 = f.grid.cellKm2;
        expect(r.metric.value).toBeCloseTo((12 * 0.4 + 12 * 0.8) * km2, 1);
        expect(r.columns.mangrove_lost_ha[0]).toBeCloseTo(40 * km2, 6);
        expect(r.stats.find(x => /Mangrove loss 1/.test(x.label))).toBeTruthy();
        expect(L._lenses.mangrove(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('runoff: SCS curve number on the wettest day, the greening what-if, flood-first blocks', () => {
        const k = v => codes.map(() => v);
        const built = codes.map((_, i) => (col(i) < 6 ? 100 : 0));
        const f = L.frameFrom(codes, { ...base, 'land_cover.built_pct': built, 'land_cover.grass_pct': built.map(b => 100 - b),
            'rainfall.rain_max_day_mm': k(100), 'soil.sand_pct': k(40), 'soil.clay_pct': k(20),
            'waterlogging.waterlogging_index': codes.map((_, i) => (i === SIZE * 6 + 6 ? 60 : 10)) }, { city: 'delhi' });
        const r = L._lenses.runoff(f, {});
        const q = (p, cn) => { const S = 25400 / cn - 254; return (p - 0.2 * S) ** 2 / (p + 0.8 * S); };
        expect(r.columns.runoff_mm[0]).toBeCloseTo(q(100, 92), 6);                 // all built, soil group B
        expect(r.columns.runoff_mm[SIZE - 1]).toBeCloseTo(q(100, 61), 6);          // all grass, group B
        expect(r.stats.find(x => /Floods first 1/.test(x.label)).label).toContain(codes[SIZE * 6 + 6]);
        expect(r.headline).toMatch(/cut that by \d/);
        expect(L._lenses.runoff(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('nighteconomy: late-night light plus eateries, the night districts', () => {
        const bright = codes.map((_, i) => (i === SIZE * 5 + 5 ? 80 : 5));
        const f = L.frameFrom(codes, { ...base, 'nightlights.radiance': bright, 'places.food': codes.map((_, i) => (i === SIZE * 5 + 5 ? 40 : 0)),
            'places.leisure': codes.map(() => 0), 'places.lodging': codes.map(() => 0) }, { city: 'delhi' });
        const r = L._lenses.nighteconomy(f, {});
        expect(r.columns.night_district[SIZE * 5 + 5]).toBe(1);
        expect(r.columns.night_district[0]).toBe(0);
        expect(r.stats.find(x => /Night district 1/.test(x.label)).label).toContain(codes[SIZE * 5 + 5]);
        expect(L._lenses.nighteconomy(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('catchment: Huff draw splits residents across centres by shops over distance squared', () => {
        const a = SIZE * 2 + 2, b = SIZE * 9 + 9;
        const shop = codes.map((_, i) => (i === a ? 100 : i === b ? 10 : 1));
        const f = L.frameFrom(codes, { ...base, 'places.shopping': shop }, { city: 'delhi' });
        const r = L._lenses.catchment(f, {});
        expect(r.idx.sort()).toEqual([a, b].sort());
        expect(r.columns.huff_draw[a] + r.columns.huff_draw[b]).toBeCloseTo(144 * 1000, 0);
        expect(r.columns.huff_draw[a]).toBeGreaterThan(r.columns.huff_draw[b]);
        expect(r.columns.residents_per_shop[b]).toBeGreaterThan(r.columns.residents_per_shop[a]);
        expect(L._lenses.catchment(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('sites: stalled, building-up and newly cleared construction blocks', () => {
        const st = codes.map((_, i) => (i === 5 ? 3 : i === SIZE * 8 ? 2 : i === SIZE * 10 + 3 ? 1 : 0));
        const k = v => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'sites.site_status': st, 'sites.bare_now': k(40), 'sites.built_then': k(20), 'sites.built_now': codes.map((_, i) => (i === SIZE * 8 ? 40 : 20)) }, { city: 'delhi' });
        const r = L._lenses.sites(f, {});
        expect(r.metric.value).toBe(1);
        expect(r.headline).toMatch(/^1 blocks hold bare ground.*1 are building up fast and 1 were cleared/);
        expect(r.stats.find(x => /Stalled site 1/.test(x.label)).label).toContain(codes[5]);
        expect(L._lenses.sites(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('informal: small packed low-rise roofs in low-wealth blocks', () => {
        const left = codes.map((_, i) => col(i) < 4);
        const f = L.frameFrom(codes, { ...base,
            'building_stock.buildings_2023': left.map(l => (l ? 1500 : 100)), 'building_stock.cover_2023_pct': left.map(l => (l ? 50 : 30)),
            'building_stock.height_2023_m': left.map(l => (l ? 4 : 12)), 'wealth.wealth_quintile': left.map(l => (l ? 1 : 4)),
            }, { city: 'delhi' });
        const r = L._lenses.informal(f, {});
        expect(r.columns.informal_signs[0]).toBe(4);
        expect(r.columns.informal_signs[SIZE - 1]).toBe(0);
        expect(r.metric.value).toBeCloseTo(100 * 4 / 12, 0);
        expect(r.columns.footprint_m2[0]).toBeCloseTo(0.5 * f.grid.cellKm2 * 1e6 / 1500, 6);
        expect(L._lenses.informal(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('ghost: new-build blocks dark for their roof area with almost no businesses', () => {
        const k = v => codes.map(() => v);
        const g0 = SIZE * 3 + 3;
        const f = L.frameFrom(codes, { ...base, 'building_stock.buildings_2023': k(100), 'building_stock.new_buildings': codes.map((_, i) => (i === g0 ? 80 : 10)),
            'building_stock.cover_2023_pct': k(40), 'building_stock.height_2023_m': k(30), 'nightlights.radiance': codes.map((_, i) => (i === g0 ? 2 : 10 + (i % 7))),
            'places.places': codes.map((_, i) => (i === g0 ? 0 : 50)) }, { city: 'delhi' });
        const r = L._lenses.ghost(f, {});
        expect(r.columns.ghost_block[g0]).toBe(1);
        expect(codes.filter((_, i) => r.columns.ghost_block[i] === 1)).toHaveLength(1);
        expect(r.stats.find(x => /Possibly empty 1/.test(x.label)).label).toContain(codes[g0]);
        expect(L._lenses.ghost(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('floorspace: non-residential floor from roofs, storeys and the GHSL share, split by business mix', () => {
        const k = v => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'building_stock.cover_2023_pct': k(50), 'building_stock.height_2023_m': k(7),
            'building_dynamics.nonres_pct': codes.map((_, i) => (i === 0 ? 100 : 10)), 'places.offices': k(3), 'places.shopping': k(1), 'places.food': k(0) }, { city: 'delhi' });
        const r = L._lenses.floorspace(f, {});
        const m2 = f.grid.cellKm2 * 1e6;
        expect(r.columns.commercial_m2[0]).toBeCloseTo(0.5 * m2 * 2, 3);
        expect(r.columns.office_m2[0]).toBeCloseTo(0.75 * 0.5 * m2 * 2, 3);
        expect(r.stats.find(x => /Commercial district 1/.test(x.label)).label).toContain(codes[0]);
        expect(L._lenses.floorspace(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('flightpath: residents under the paths and the low overflight zone', () => {
        const up = codes.map((_, i) => (Math.floor(i / SIZE) === 5 ? 1 : 0));
        const f = L.frameFrom(codes, { ...base, 'flight_paths.under_path': up, 'flight_paths.path_km': codes.map((_, i) => (up[i] ? 1 + col(i) : NaN)),
            'flight_paths.runway_km': codes.map(() => 5) }, { city: 'delhi' });
        const r = L._lenses.flightpath(f, {});
        expect(r.metric.value).toBeCloseTo(100 / 12, 0);
        expect(r.stats[1].value).toBe('3,000');                      // cols 0-2: 1-3 km out
        expect(r.stats.find(x => /Most overflown 1/.test(x.label)).label).toContain(codes[SIZE * 5]);
        expect(L._lenses.flightpath(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('services: banks, clinics and schools within 1 km, deserts and gaps', () => {
        const one = i => (i === SIZE * 2 + 2 ? 3 : 0);
        const f = L.frameFrom(codes, { ...base, 'places.finance': codes.map((_, i) => one(i)), 'places.health': codes.map((_, i) => one(i)),
            'places.education': codes.map(() => 1) }, { city: 'delhi' });
        const r = L._lenses.services(f, {});
        expect(r.columns.services_missing[SIZE * 2 + 2]).toBe(0);
        expect(r.columns.services_missing[SIZE * 11 + 11]).toBe(2);
        expect(r.headline).toMatch(/and 0 have none of the three/);
        expect(r.stats.find(x => /Service gap 1/.test(x.label)).value).toMatch(/^no bank or ATM, clinic or pharmacy within 1 km/);
        expect(L._lenses.services(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('anchors: colleges, hospitals and offices nearby as within-city percentiles', () => {
        const at = j => codes.map((_, i) => (i === j ? 5 : 0));
        const mid = SIZE * 6 + 6;
        const f = L.frameFrom(codes, { ...base, 'places.colleges': at(mid), 'places.coaching': at(mid), 'places.hospitals': at(mid), 'places.offices': at(mid),
            'places.coworking': at(0), 'places.hostels': at(mid) }, { city: 'delhi' });
        const r = L._lenses.anchors(f, {});
        expect(r.columns.anchor_score[mid]).toBeGreaterThan(r.columns.anchor_score[SIZE * 11 + 11]);
        expect(r.stats.find(x => /Student hub 1/.test(x.label)).value).toMatch(/^10 within 2 km; 5 hostels$/);
        expect(L._lenses.anchors(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('lightning: ground strikes summed over lived-in blocks', () => {
        const f = L.frameFrom(codes, { ...base, 'lightning.cg_rate': codes.map(() => 2) });
        const r = L._lenses.lightning(f, {});
        expect(r.metric.value).toBe(2);
        expect(r.headline).toMatch(/2 per km²/);
        expect(r.stats[0].raw).toBe(Math.round(2 * f.grid.cellKm2 * codes.length));
        expect(L._lenses.lightning(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('recharge: sandy open ground recharges, built ground counts as lost', () => {
        const half = codes.map((_, i) => (i < codes.length / 2 ? 90 : 10));
        const f = L.frameFrom(codes, { ...base, 'land_cover.built_pct': half, 'land_cover.water_pct': codes.map(() => 0), 'rainfall.rain_annual_mm': codes.map(() => 1000),
            'soil.sand_pct': codes.map(() => 80), 'soil.clay_pct': codes.map(() => 5), 'terrain.slope_deg': codes.map(() => 1) });
        const r = L._lenses.recharge(f, {});
        const m2 = f.grid.cellKm2 * 1e6;
        expect(r.stats[0].raw).toBe(Math.round(codes.length / 2 * m2 * 0.22 * (0.1 + 0.9)));
        expect(r.metric.value).toBe(50);
        expect(Number.isNaN(r.columns.recharge_score[0])).toBe(true);
        expect(r.columns.recharge_score[codes.length - 1]).toBeGreaterThan(80);
        expect(L._lenses.recharge(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('stay: sights with no hotels nearby are a hotel gap', () => {
        const west = codes.map((_, i) => (col(i) < 4 ? (4 - col(i)) * 10 : 0)), east = codes.map((_, i) => (col(i) >= 8 ? 5 : 0));
        const f = L.frameFrom(codes, { ...base, 'places.culture': west, 'places.lodging': east, 'places.transport': east });
        const r = L._lenses.stay(f, {});
        expect(r.columns.stay_gap[0]).toBeGreaterThan(0);
        expect(r.columns.stay_gap[SIZE - 1]).toBeLessThan(0);
        expect(L._lenses.stay(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('waterloss: lost water area by decade and how much is built now', () => {
        const lost = codes.map((_, i) => (i < 10 ? 50 : 0)), yr = codes.map((_, i) => (i < 5 ? 1995 : i < 10 ? 2012 : NaN));
        const f = L.frameFrom(codes, { ...base, 'water_history.water_lost_pct': lost, 'water_history.lost_year': yr, 'land_cover.built_pct': codes.map((_, i) => (i < 5 ? 80 : 0)) });
        const r = L._lenses.waterloss(f, {});
        const a = 10 * 0.5 * f.grid.cellKm2;
        expect(r.stats[0].raw).toBeCloseTo(a, 2);
        expect(r.stats.find(x => x.label === 'Last seen 2010s')).toBeTruthy();
        expect(r.headline).toMatch(/50% of it lies in blocks that are now built-up/);
        expect(L._lenses.waterloss(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('dumps: people within 1 km of a mapped landfill or quarry', () => {
        const at = (j, k) => codes.map((_, i) => (i === j ? k : 0));
        const f = L.frameFrom(codes, { ...base, 'landuse.landfill_pct': at(0, 40), 'landuse.quarry_pct': codes.map(() => 0), 'landuse.brownfield_pct': at(5, 10) });
        const r = L._lenses.dumps(f, {});
        expect(r.metric.value).toBeGreaterThan(1000);
        expect(r.metric.value).toBeLessThan(1000 * codes.length);
        expect(r.columns.near_dump[codes.length - 1]).toBe(0);
        expect(r.stats.find(x => /Site 1/.test(x.label)).value).toMatch(/^landfill, /);
        expect(L._lenses.dumps(L.frameFrom(codes, { ...base, 'landuse.landfill_pct': codes.map(() => 0), 'landuse.quarry_pct': codes.map(() => 0) }), {})).toBeNull();
    });

    it('heritage: land and people inside the ASI prohibited and regulated areas', () => {
        const pro = codes.map((_, i) => (i === 0 ? 50 : 0)), reg = codes.map((_, i) => (i === 0 ? 50 : i === 1 ? 20 : 0));
        const f = L.frameFrom(codes, { ...base, 'heritage.prohibited_pct': pro, 'heritage.regulated_pct': reg, 'heritage.national': codes.map((_, i) => (i === 0 ? 1 : 0)),
            'built_up.built_pct': codes.map(() => 50) });
        const r = L._lenses.heritage(f, {});
        expect(r.stats[0].value).toBe('1');
        expect(r.stats.find(x => x.label.startsWith('Residents')).raw).toBe(1000 + 200);
        expect(r.metric.value).toBeCloseTo(1.2 * f.grid.cellKm2, 1);
        expect(r.stats.find(x => /zone 1/.test(x.label)).value).toBe('50% prohibited, 50% regulated; 50% built-up');
        expect(L._lenses.heritage(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('landmix: an even spread of uses scores high, homes beside industry are counted', () => {
        const q = k => codes.map((_, i) => (i % 4 === k ? 40 : 0));
        const f = L.frameFrom(codes, { ...base, 'landuse.residential_pct': q(0), 'landuse.commercial_pct': q(1), 'landuse.civic_pct': q(2), 'landuse.industrial_pct': q(3) });
        const r = L._lenses.landmix(f, {});
        expect(r.metric.value).toBeGreaterThan(95);
        expect(r.stats[2].raw).toBe(0);                                      // a tenth industrial nearby, under 20%
        const one = L.frameFrom(codes, { ...base, 'landuse.residential_pct': codes.map(() => 50), 'landuse.commercial_pct': codes.map(() => 0),
            'landuse.civic_pct': codes.map(() => 0), 'landuse.industrial_pct': codes.map(() => 0) });
        expect(L._lenses.landmix(one, {}).metric.value).toBe(0);
        const ind = L.frameFrom(codes, { ...base, 'landuse.residential_pct': codes.map(() => 50), 'landuse.commercial_pct': codes.map(() => 0),
            'landuse.civic_pct': codes.map(() => 0), 'landuse.industrial_pct': codes.map(() => 30) });
        expect(L._lenses.landmix(ind, {}).stats[2].raw).toBe(1000 * codes.length);
        expect(L._lenses.landmix(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('reach: services with none listed within their distance', () => {
        const at = (j, k) => codes.map((_, i) => (i === j ? k : 0));
        const mid = SIZE * 6 + 6;
        const cols = { grocers: at(mid, 3), pharmacies: at(mid, 1), preschools: at(mid, 1), post_offices: at(mid, 1), police: at(mid, 1), fire_stations: at(mid, 1) };
        const f = L.frameFrom(codes, { ...base, ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [`places.${k}`, v])) });
        const r = L._lenses.reach(f, {});
        expect(r.columns.services_lacking[mid]).toBe(0);
        expect(r.columns.services_lacking[0]).toBeGreaterThan(0);
        expect(r.stats[0].label).toBe('No grocer listed within 0.5 km');
        expect(r.stats[5].raw).toBe(0);                                        // a 3 km fire radius covers the 3 km grid
        expect(L._lenses.reach(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('monthly: latest three months against a year earlier flag new building and lights', () => {
        const steps = Array.from({ length: 24 }, (_, k) => `${2025 + Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}`);
        const f = L.frameFrom(codes, base);
        f.cols['construction_monthly.built_pct@series'] = codes.map((_, i) => steps.map((_, k) => (i === 0 && k >= 12 ? 70 : 20)));
        f.cols['nightlights_monthly.radiance@series'] = codes.map((_, i) => steps.map((_, k) => (i === 0 && k >= 12 ? 9 : 3)));
        f.steps = { construction_monthly: steps, nightlights_monthly: steps };
        const r = L._lenses.monthly(f, {});
        expect(r.columns.change_signs[0]).toBe(2);
        expect(r.columns.change_signs[1]).toBe(0);
        expect(r.stats[0].label).toBe('Blocks with new building (Oct 2026–Dec 2026 vs a year before)');
        expect(r.stats[0].raw).toBe(1);
        expect(r.headline).toMatch(/1 show two or more signs/);
        expect(L._lenses.monthly(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('greenbelt: building inside protected land and its eco-sensitive zone', () => {
        const prot = codes.map((_, i) => (i < 4 ? 100 : 0)), esz = codes.map((_, i) => (i >= 4 && i < 8 ? 100 : 0));
        const f = L.frameFrom(codes, { ...base, 'landuse.protected_pct': prot, 'landuse.esz_pct': esz, 'growth.built_2016_pct': codes.map(() => 5),
            'growth.built_2023_pct': codes.map((_, i) => (i === 0 ? 25 : 5)) });
        const r = L._lenses.greenbelt(f, {});
        const k = f.grid.cellKm2;
        expect(r.stats[1].raw).toBeCloseTo((0.25 + 3 * 0.05) * k, 3);
        expect(r.columns.protected_growth_pp[0]).toBe(20);
        expect(r.stats.find(x => /Building inside 1/.test(x.label)).value).toMatch(/^\+20 points/);
        expect(L._lenses.greenbelt(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('mosquito: warm wet months, standing water and crowding', () => {
        const steps = Array.from({ length: 13 }, (_, k) => `${2025 + Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}`);
        const f = L.frameFrom(codes, { ...base, 'waterlogging.waterlogging_index': codes.map((_, i) => (i === 0 ? 100 : 0)), 'population.density_km2': codes.map((_, i) => (i === 0 ? 50000 : 1000)) });
        const warm = steps.map((_, k) => (k >= 5 && k <= 10 ? 30 : 12));             // Jun–Nov warm
        f.cols['lst_monthly.lst_day_c@series'] = codes.map(() => warm);
        f.cols['lst_monthly.lst_night_c@series'] = codes.map(() => warm);
        f.cols['rain_monthly.rain_mm@series'] = codes.map(() => steps.map((_, k) => (k >= 5 && k <= 9 ? 100 : 0)));   // wet Jun–Oct, Nov by lag
        f.steps = { lst_monthly: steps, rain_monthly: steps };
        const r = L._lenses.mosquito(f, {});
        expect(r.columns.mosquito_months[0]).toBe(6);
        expect(r.stats[1].value).toBe('Jun, Jul, Aug, Sep, Oct, Nov');
        expect(r.columns.mosquito_risk[0]).toBeGreaterThan(r.columns.mosquito_risk[1]);
        expect(L._lenses.mosquito(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('buildingage: area built per epoch and the median build year', () => {
        const f = L.frameFrom(codes, base);
        f.cols['builtup_yearly.built_pct@series'] = codes.map((_, i) => (i < 72 ? [10, 20, 40, 40] : [0, 0, 10, 40]));
        f.steps = { builtup_yearly: ['1975', '1990', '2005', '2020'] };
        const r = L._lenses.buildingage(f, {});
        expect(r.columns.median_build_year[0]).toBe(1990);
        expect(r.columns.median_build_year[codes.length - 1]).toBe(2020);
        expect(r.columns.built_by_1990_pct[0]).toBe(50);
        expect(r.stats[0].label).toBe('Built by 1975');
        expect(L._lenses.buildingage(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('cooling: hot blocks with and without a candidate cooling centre nearby', () => {
        const z = codes.map(() => 0);
        const f = L.frameFrom(codes, { ...base, 'surface_heat.lst_day_c': codes.map((_, i) => (i < SIZE * 6 ? 45 : 35)),
            'places.libraries': codes.map((_, i) => (i === 0 ? 1 : 0)), 'places.malls': z, 'places.community_centres': z, 'places.worship': z });
        const r = L._lenses.cooling(f, {});
        expect(r.columns.cooling_gap[0]).toBe(1);
        expect(r.columns.cooling_gap[SIZE * 6 - 1]).toBe(2);
        expect(r.columns.cooling_gap[codes.length - 1]).toBe(0);
        expect(r.stats.some(x => /^Cooling centre site 1/.test(x.label))).toBe(true);
        expect(L._lenses.cooling(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('crowds: dense blocks among the busiest gathering clusters', () => {
        const z = codes.map(() => 0);
        const f = L.frameFrom(codes, { ...base, 'places.worship': codes.map((_, i) => (i === 0 ? 30 : 0)), 'places.malls': z, 'places.culture': z,
            'places.leisure': codes.map((_, i) => (i === SIZE * 6 + 6 ? 5 : 1)), 'places.police': z, 'places.fire_stations': z, 'population.density_km2': codes.map(() => 20000) });
        const r = L._lenses.crowds(f, {});
        expect(r.columns.gathering_places[0]).toBeGreaterThan(r.columns.gathering_places[codes.length - 1]);
        expect(r.stats.some(x => /^Crowd zone 1/.test(x.label))).toBe(true);
        expect(L._lenses.crowds(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('airport: rough peak and off-peak drive times from runway distance', () => {
        const f = L.frameFrom(codes, { ...base, 'flight_paths.runway_km': codes.map((_, i) => 1 + col(i)) });
        const r = L._lenses.airport(f, {});
        expect(r.columns.airport_peak_min[0]).toBe(Math.round(60 * 1.35 / 20));
        expect(r.columns.airport_offpeak_min[0]).toBe(Math.round(60 * 1.35 / 35));
        expect(r.stats[0].label).toBe('Within 30 min of the runway at peak');
        expect(L._lenses.airport(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('gardens: soil score, rain-garden drainage and open land', () => {
        const f = L.frameFrom(codes, { ...base, 'topsoil.ph': codes.map((_, i) => (i < SIZE * 6 ? 7 : 8.7)), 'topsoil.soc_g_kg': codes.map(() => 12),
            'topsoil.sand_pct': codes.map((_, i) => (col(i) < 6 ? 50 : 20)), 'topsoil.clay_pct': codes.map((_, i) => (col(i) < 6 ? 20 : 50)),
            'land_cover.grass_pct': codes.map(() => 20), 'land_cover.bare_pct': codes.map(() => 0), 'land_cover.shrub_pct': codes.map(() => 0) });
        const r = L._lenses.gardens(f, {});
        expect(r.columns.garden_score[0]).toBe(100);
        expect(r.columns.garden_score[codes.length - 1]).toBeLessThan(70);
        expect(r.columns.rain_garden[0]).toBe(1);
        expect(r.columns.rain_garden[codes.length - 1]).toBe(0);
        expect(L._lenses.gardens(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('powerlines: residents and built-up land inside right-of-way corridors', () => {
        const f = L.frameFrom(codes, { ...base, 'power_lines.corridor_pct': codes.map((_, i) => (col(i) === 3 ? 40 : 0)),
            'power_lines.line_km': codes.map((_, i) => (col(i) === 3 ? 0.25 : 0)), 'power_lines.max_kv': codes.map((_, i) => (col(i) === 3 ? 400 : null)),
            'power_lines.substations': codes.map(() => 0), 'built_up.built_pct': codes.map(() => 50) });
        const r = L._lenses.powerlines(f, {});
        const i = codes.findIndex((_, k) => col(k) === 3);
        expect(r.columns.corridor_people[i]).toBeCloseTo(base['population.population'][i] * 0.4);
        expect(r.columns.corridor_people[i + 1]).toBe(0);
        expect(r.stats[0].value).toBe(`${SIZE * 0.25} km`);
        expect(L._lenses.powerlines(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('toilets: homes and busy streets without a mapped public toilet', () => {
        const f = L.frameFrom(codes, { ...base, 'street_infra.toilets': codes.map((_, i) => (i === 0 ? 1 : 0)), 'street_infra.drinking_water': codes.map(() => 0),
            'places.shopping': codes.map((_, i) => (i === codes.length - 1 ? 50 : 1)), 'places.food': codes.map(() => 0) });
        const r = L._lenses.toilets(f, {});
        expect(r.columns.toilet_gap[0]).toBe(0);
        expect(r.columns.toilet_gap[codes.length - 1]).toBe(2);
        expect(r.headline).toMatch(/^Only 1 public toilets are mapped/);
        expect(L._lenses.toilets(L.frameFrom(codes, base), {})).toBeNull();
        const off = L._lenses.toilets(L.frameFrom(codes, { ...base, 'street_infra.toilets': codes.map(() => 0),
            'toilets_official.toilets': codes.map((_, i) => (i === 0 ? 3 : 0)), 'toilets_official.seats_women': codes.map((_, i) => (i === 0 ? 10 : 0)) }), {});
        expect(off.stats[0]).toEqual({ label: 'Public toilets mapped (the corporation list and OpenStreetMap)', value: '3' });
        expect(off.stats.some(s => /women's toilet seat/.test(s.label))).toBe(true);
    });

    it('gated: gate density and gated residents', () => {
        const f = L.frameFrom(codes, { ...base, 'street_infra.gates': codes.map((_, i) => (col(i) < 3 ? 20 : 0)) });
        const r = L._lenses.gated(f, {});
        expect(r.columns.gate_density[0]).toBeGreaterThan(20);
        expect(r.columns.gate_density[codes.length - 1]).toBe(0);
        expect(r.stats[0].value).toBe(String(20 * SIZE * 3));
        expect(L._lenses.gated(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('drainage: drain density, residents beside drains and wet blocks with no drain', () => {
        const f = L.frameFrom(codes, { ...base, 'drains.drain_km': codes.map((_, i) => (col(i) === 0 ? 10 : 0)), 'drains.drain_near_pct': codes.map((_, i) => (col(i) === 0 ? 50 : 0)),
            'drains.wastewater': codes.map(() => 0), 'waterlogging.waterlogging_index': codes.map(() => 60) });
        const r = L._lenses.drainage(f, {});
        expect(r.columns.drain_density[0]).toBeGreaterThan(0);
        expect(r.columns.beside_drain[0]).toBeCloseTo(base['population.population'][0] / 2);
        expect(r.columns.drain_density[codes.length - 1]).toBe(0);
        expect(r.stats.some(x => /^Drain needed 1/.test(x.label))).toBe(true);
        expect(L._lenses.drainage(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('cityfarms: mapped farmland and the share building up fast', () => {
        const f = L.frameFrom(codes, { ...base, 'landuse.farm_pct': codes.map((_, i) => (col(i) < 2 ? 80 : 0)),
            'growth.built_2016_pct': codes.map(() => 5), 'growth.built_2023_pct': codes.map((_, i) => (col(i) === 0 ? 25 : 7)) });
        const r = L._lenses.cityfarms(f, {});
        expect(r.columns.farm_pressure[0]).toBe(2);
        expect(r.columns.farm_pressure[1]).toBe(1);
        expect(r.columns.farm_pressure[5]).toBe(0);
        expect(r.stats[1].value).toMatch(/\(50%\)$/);
        expect(L._lenses.cityfarms(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('tourism: landmark pull, visitor magnets and hotel gaps', () => {
        const f = L.frameFrom(codes, { ...base, 'landmarks.pull': codes.map((_, i) => (i === 0 ? 100 : i === codes.length - 1 ? 80 : 0)),
            'landmarks.landmarks': codes.map((_, i) => (i === 0 || i === codes.length - 1 ? 1 : 0)),
            'places.lodging': codes.map((_, i) => (col(i) < 3 ? 5 : 0)), 'places.food': codes.map(() => 1) });
        const r = L._lenses.tourism(f, {});
        expect(r.columns.landmark_pull[0]).toBe(100);
        expect(r.stats[0].value).toBe('2');
        expect(r.stats.some(x => /^Visitor magnet 1/.test(x.label))).toBe(true);
        expect(L._lenses.tourism(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('coast: land made and lost near the coast, and the CRZ band', () => {
        const f = L.frameFrom(codes, { ...base, 'flood_future.coast_pct_2080_high': codes.map((_, i) => (col(i) === 0 ? 10 : 0)),
            'water_history.water_1990_pct': codes.map((_, i) => (col(i) === 0 ? 100 : col(i) === 1 ? 60 : 0)),
            'water_history.water_2020_pct': codes.map((_, i) => (col(i) === 0 ? 100 : col(i) === 2 ? 30 : 0)), 'built_up.built_pct': codes.map(() => 40) });
        const r = L._lenses.coast(f, {});
        expect(r.columns.coast_change[1]).toBe(60);
        expect(r.columns.coast_change[2]).toBe(-30);
        expect(r.stats.some(x => /^Made land 1/.test(x.label))).toBe(true);
        expect(L._lenses.coast(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('packed: roof cover over half the block, and tall packed blocks', () => {
        const f = L.frameFrom(codes, { ...base, 'building_stock.cover_2023_pct': codes.map((_, i) => (col(i) < 3 ? 60 : 20)),
            'building_stock.height_2023_m': codes.map((_, i) => (col(i) === 0 ? 15 : 6)), 'places.fire_stations': codes.map(() => 0) });
        const r = L._lenses.packed(f, {});
        expect(r.columns.roof_cover_pct[0]).toBe(60);
        expect(r.stats[1].value).toMatch(new RegExp(`in ${SIZE} blocks$`));
        expect(L._lenses.packed(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('techhubs: firm density, hub blocks and the commute shed', () => {
        const f = L.frameFrom(codes, { ...base, 'places.tech': codes.map((_, i) => (i === 0 ? 40 : 0)), 'places.coworking': codes.map(() => 0) });
        const r = L._lenses.techhubs(f, {});
        expect(r.columns.tech_firms_1km[0]).toBe(40);
        expect(r.stats[0].value).toBe('40');
        expect(r.stats.some(x => /^Tech hub 1/.test(x.label))).toBe(true);
        expect(L._lenses.techhubs(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('shadecare: traces the walk to the nearest clinic and scores shade along it', () => {
        const care = codes.map((_, i) => (i === 0 ? 3 : 0));
        const tree = codes.map((_, i) => (i === 1 ? 50 : 0));
        const f = L.frameFrom(codes, { ...base, 'places.health': care, 'vegetation.tree_canopy_pct': tree, 'surface_heat.lst_day_c': codes.map(() => 40),
            'osm_walk.links': codes.map(() => 255) });
        const r = L._lenses.shadecare(f, {});
        expect(r.columns.care_walk_exposed_pct[0]).toBe(0);
        expect(r.columns.care_walk_exposed_pct[1]).toBe(100);
        expect(r.columns.care_walk_exposed_pct[2]).toBe(50);
        expect(r.columns.care_walk_m[2]).toBeGreaterThan(r.columns.care_walk_m[1]);
        expect(r.stats.find(x => /^Shade trees first 1/.test(x.label)).label).toContain(codes[0]);
        expect(L._lenses.shadecare(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('cyclone: 50-year wind, IMD class and the classes residents reach', () => {
        const rl = codes.map((_, i) => (col(i) < 7 ? 130 : 100));
        const f = L.frameFrom(codes, { ...base, 'cyclones.wind_rl50_kmh': rl, 'cyclones.wind_max_kmh': codes.map((_, i) => (i === 5 ? 160 : 120)),
            'cyclones.gale_years': codes.map(() => 12), 'cyclones.storms_200km': codes.map(() => 25) });
        const r = L._lenses.cyclone(f, {});
        expect(r.headline).toMatch(/very severe cyclonic storm strength/);
        expect(r.stats[1].value).toBe(`160 km/h at ${codes[5]} (very severe cyclonic storm strength)`);
        expect(r.stats.find(x => /very severe cyclonic storm strength \(118/.test(x.label)).value).toMatch(/\(58.3%\)$/);
        expect(r.stats.find(x => /reaches severe cyclonic storm strength/.test(x.label)).value).toMatch(/\(100%\)$/);
        const calm = L._lenses.cyclone(L.frameFrom(codes, { ...base, 'cyclones.wind_rl50_kmh': codes.map(() => 40), 'cyclones.wind_max_kmh': codes.map(() => 45),
            'cyclones.gale_years': codes.map(() => 0) }), {});
        expect(calm.headline).toMatch(/^No cyclone brought gale-force wind/);
        expect(L._lenses.cyclone(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('riders: delivery hubs and rest stops where toilets and water are missing', () => {
        const food = codes.map((_, i) => (i === 0 ? 60 : 1));
        const f = L.frameFrom(codes, { ...base, 'places.food': food, 'places.grocers': codes.map(() => 0),
            'street_infra.toilets': codes.map(() => 0), 'street_infra.drinking_water': codes.map(() => 0) });
        const r = L._lenses.riders(f, {});
        expect(r.columns.delivery_places_1km[0]).toBeGreaterThanOrEqual(60);
        expect(r.metric.value).toBe(100);
        const d = r.columns.delivery_places_1km, top = d.indexOf(Math.max(...d));
        expect(r.stats.find(x => /^Rider rest stop 1/.test(x.label)).label).toContain(codes[top]);
        expect(L._lenses.riders(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('summershade: canopy in leaf in the hot months and where shade drops away', () => {
        const leafy = codes.map((_, i) => (col(i) < 6 ? 20 : 80));
        const f = L.frameFrom(codes, { ...base, 'tree_season.summer_leafy_pct': leafy, 'tree_season.tree_phen_sd': codes.map(() => 0.05),
            'vegetation.tree_canopy_pct': codes.map(() => 20), 'surface_heat.lst_day_c': codes.map((_, i) => (col(i) < 3 ? 42 : 38)) });
        const r = L._lenses.summershade(f, {});
        expect(r.metric.value).toBe(50);
        expect(r.stats[2].value).toMatch(/\(50%\)$/);
        expect(r.stats.find(x => /^Add evergreen shade 1/.test(x.label)).value).toMatch(/20% of it in leaf in summer; 42 °C/);
        expect(L._lenses.summershade(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('builduse: learns uses from mapped blocks and labels the rest', () => {
        const ind = i => col(i) >= 6;
        const cols = { ...base, 'landuse.mapped_pct': codes.map((_, i) => (i % 2 ? 100 : 0)),
            'landuse.residential_pct': codes.map((_, i) => (ind(i) ? 0 : 90)), 'landuse.industrial_pct': codes.map((_, i) => (ind(i) ? 90 : 0)),
            'landuse.commercial_pct': codes.map(() => 0), 'landuse.civic_pct': codes.map(() => 0), 'landuse.military_pct': codes.map(() => 0),
            'building_stock.cover_2023_pct': codes.map(() => 30), 'building_stock.height_2023_m': codes.map((_, i) => (ind(i) ? 12 : 6)) };
        for (let k = 0; k < 12; k++) cols[`embeddings.e${k}`] = codes.map((_, i) => (ind(i) ? 1 : -1) + 0.01 * ((i * (k + 3)) % 7));
        const r = L._lenses.builduse(L.frameFrom(codes, cols), {});
        expect(r.stats[1].value).toMatch(/^100%/);
        expect(r.columns.use_class[0]).toBe(1);
        expect(r.columns.use_class[SIZE - 1]).toBe(3);
        expect(r.columns.nonres_prob_pct[SIZE - 1]).toBeGreaterThan(90);
        expect(L._lenses.builduse(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('rescore: a new metro station shortens walks near it and re-runs the lenses that read them', async () => {
        const walk = codes.map(() => 30);
        const f = L.frameFrom(codes, { ...base, 'rail_access.metro_walk_min': walk, 'rail_access.metro_stations': codes.map(() => 0) }, { city: 'delhi' });
        const r = await L.rescore('delhi', null, { edits: [{ kind: 'metro', code: codes[SIZE * 6 + 6] }], only: ['metro'], frame: f });
        expect(r.edits[0].code).toBe(codes[SIZE * 6 + 6]);
        expect(f.cols['rail_access.metro_walk_min'][SIZE * 6 + 6]).toBe(30);
        const m = r.lenses.find(x => x.id === 'metro');
        expect(m.local.after).toBeLessThan(m.local.before);
        expect(m.local.residentsChanged).toBeGreaterThan(0);
        await expect(L.rescore('delhi', null, { edits: [{ kind: 'tram', code: codes[0] }], only: ['metro'], frame: f })).rejects.toThrow(/Unknown edit/);
    });

    it('railnoise: residents within 50 and 150 m of a mainline track', () => {
        const f = L.frameFrom(codes, { ...base, 'railways.rail_near_pct': codes.map((_, i) => (col(i) === 0 ? 100 : 0)),
            'railways.rail_band_pct': codes.map((_, i) => (col(i) < 2 ? 100 : 0)), 'railways.rail_km': codes.map((_, i) => (col(i) === 0 ? 0.25 : 0)) });
        const r = L._lenses.railnoise(f, {});
        expect(r.metric.value).toBe(16.7);
        expect(r.stats[1].value).toBe('12,000 (8.3%)');
        expect(r.stats.some(x => /^Noise barrier/.test(x.label))).toBe(true);
        expect(L._lenses.railnoise(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('mothercare: under-5s far from maternity and children\'s doctors', () => {
        const f = L.frameFrom(codes, { ...base, 'demographics.under5': codes.map(() => 100),
            'places.obgyn': codes.map((_, i) => (i === 0 ? 10 : 0)), 'places.paediatric': codes.map((_, i) => (i === 0 ? 5 : 0)) });
        const r = L._lenses.mothercare(f, {});
        expect(r.columns.mch_gap[0]).toBe(0);
        expect(r.columns.mch_gap[n - 1]).toBe(2);
        expect(r.stats[0].value).toBe('10');
        expect(r.stats.some(x => /^Mother-and-child clinic 1/.test(x.label))).toBe(true);
        expect(L._lenses.mothercare(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('events: banquet-hall clusters, residents beside them and thin roads', () => {
        const f = L.frameFrom(codes, { ...base, 'places.events': codes.map((_, i) => (i === 0 ? 40 : 0)),
            'osm_roads.major_km_km2': codes.map((_, i) => (col(i) < 2 ? 1 : 4)) });
        const r = L._lenses.events(f, {});
        expect(r.columns.event_venues_1km[0]).toBe(40);
        expect(r.stats[0].value).toBe('40');
        expect(r.stats.find(x => /thinner main roads/.test(x.label)).value).toMatch(/^[1-9]\d* of /);
        expect(L._lenses.events(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('marketfire: busy markets, packed blocks and fire-station reach', () => {
        const shops = codes.map((_, i) => (i === 0 ? 200 : 1));
        const f = L.frameFrom(codes, { ...base, 'places.shopping': shops, 'places.food': codes.map(() => 0),
            'building_stock.cover_2023_pct': codes.map((_, i) => (col(i) < 3 ? 60 : 20)),
            'places.fire_stations': codes.map((_, i) => (i === n - 1 ? 6 : 0)) });
        const r = L._lenses.marketfire(f, {});
        expect(r.columns.market_fire[0]).toBe(3);
        expect(r.stats.find(x => x.label === 'Fire stations listed').value).toBe('6');
        expect(r.stats.some(x => /^Fire audit 1/.test(x.label))).toBe(true);
        expect(L._lenses.marketfire(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('oldtall: old blocks, tall buildings, floors added and rebuilt blocks left out', () => {
        const f = L.frameFrom(codes, { ...base, 'building_dynamics.settled_year': codes.map((_, i) => (col(i) < 6 ? 1985 : 2010)),
            'building_stock.height_2023_m': codes.map((_, i) => (col(i) < 3 ? 15 : 6)),
            'building_dynamics.height_change_m': codes.map((_, i) => (i === 0 ? 2 : i === 1 ? 8 : 0)) }, { city: 'delhi' });
        const r = L._lenses.oldtall(f, {});
        expect(r.columns.audit_due[0]).toBe(3);
        expect(r.columns.audit_due[1]).toBe(1);
        expect(r.columns.audit_due[SIZE * 11 + 11]).toBe(0);
        expect(r.stats.find(x => /floors added\)$/.test(x.label)).value).toBe('1 blocks');
        expect(r.headline).toMatch(/seismic zone IV/);
        expect(r.stats.some(x => /^Audit 1/.test(x.label))).toBe(true);
        expect(L._lenses.oldtall(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('critwater: emergency services on flood-prone and waterlogged ground, stranded residents', () => {
        const f = L.frameFrom(codes, { ...base, 'places.hospitals': codes.map((_, i) => (i === 0 || i === n - 1 ? 2 : 0)),
            'places.fire_stations': codes.map((_, i) => (i === 1 ? 1 : 0)), 'places.police': codes.map((_, i) => (i > 50 && i < 54 ? 1 : 0)),
            'flood_future.any_pct_now': codes.map((_, i) => (col(i) < 3 ? 80 : 0)),
            'waterlogging.waterlogging_index': codes.map((_, i) => (i === n - 1 ? 70 : 10)) });
        const r = L._lenses.critwater(f, {});
        expect(r.columns.facility_wet[0]).toBe(2);
        expect(r.columns.facility_wet[n - 1]).toBe(1);
        expect(r.stats[0].value).toBe('2 / 2 of 4');
        expect(r.metric.value).toBe(100);
        expect(r.stats.some(x => /^Flood-proof 1/.test(x.label))).toBe(true);
        expect(L._lenses.critwater(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('quake: soft, sandy ground and tall buildings, with the seismic zone', () => {
        const f = L.frameFrom(codes, { ...base, 'terrain.hand_m': codes.map((_, i) => (col(i) < 4 ? 1 : 10)),
            'soil.sand_pct': codes.map((_, i) => (col(i) < 2 ? 60 : 20)), 'building_stock.height_2023_m': codes.map((_, i) => (i === 0 ? 20 : 6)) }, { city: 'delhi' });
        const r = L._lenses.quake(f, {});
        expect(r.columns.quake_ground[0]).toBe(3);
        expect(r.columns.quake_ground[3]).toBe(1);
        expect(r.columns.quake_ground[SIZE * 11 + 11]).toBe(0);
        expect(r.headline).toMatch(/^Seismic zone IV\./);
        expect(r.stats.some(x => /^Check 1/.test(x.label))).toBe(true);
        expect(L._lenses.quake(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('factoryhomes: industry next to homes, mixed blocks and thermal hotspots', () => {
        const f = L.frameFrom(codes, { ...base, 'landuse.industrial_pct': codes.map((_, i) => (i === 0 || i === 1 ? 50 : 0)),
            'landuse.residential_pct': codes.map((_, i) => (i === 1 ? 0 : 60)), 'fires.fire_days_yr': codes.map((_, i) => (i === 0 ? 3 : 0)) });
        const r = L._lenses.factoryhomes(f, {});
        expect(r.columns.factory_homes[0]).toBe(3);
        expect(r.columns.factory_homes[2]).toBe(1);
        expect(r.columns.factory_homes[SIZE * 11 + 11]).toBe(0);
        expect(r.stats[0].value).toBe('2');
        expect(r.stats.some(x => /^Inspect 1/.test(x.label))).toBe(true);
        expect(L._lenses.factoryhomes(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('refuge: storm-surge zone residents and the schools or halls within 1 km', () => {
        const f = L.frameFrom(codes, { ...base, 'flood_future.coast_pct_now': codes.map((_, i) => (col(i) < 2 ? 80 : 0)),
            'emergency_access.schools': codes.map((_, i) => (i === 0 ? 1 : 0)) });
        const r = L._lenses.refuge(f, {});
        expect(r.columns.refuge_gap[0]).toBe(1);
        expect(r.columns.refuge_gap[SIZE * 11]).toBe(2);
        expect(r.columns.refuge_gap[SIZE * 11 + 11]).toBe(0);
        expect(r.stats.some(x => /^Shelter 1/.test(x.label))).toBe(true);
        expect(L._lenses.refuge(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('firelanes: packed blocks far from main roads and fire stations', () => {
        const f = L.frameFrom(codes, { ...base, 'building_stock.cover_2023_pct': codes.map((_, i) => (col(i) < 6 ? 70 : 20)),
            'osm_roads.major_km_km2': codes.map((_, i) => (col(i) === 11 ? 5 : 0)), 'osm_roads.secondary_km_km2': codes.map(() => 0),
            'places.fire_stations': codes.map((_, i) => (i === n - 1 ? 6 : 0)) });
        const r = L._lenses.firelanes(f, {});
        expect(r.columns.fire_lanes[0]).toBe(3);
        expect(r.columns.fire_lanes[SIZE * 11 + 11]).toBe(0);
        expect(r.stats.some(x => /^Fire access 1/.test(x.label))).toBe(true);
        expect(L._lenses.firelanes(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('schoolsafe: hazards counted at blocks with schools', () => {
        const f = L.frameFrom(codes, { ...base, 'emergency_access.schools': codes.map((_, i) => (i < SIZE ? 1 : 0)),
            'flood_future.any_pct_now': codes.map((_, i) => (col(i) < 3 ? 80 : 0)), 'traffic_noise.lden_db': codes.map((_, i) => (col(i) < 1 ? 75 : 55)),
            'terrain.hand_m': codes.map(() => 10) }, { city: 'delhi' });
        const r = L._lenses.schoolsafe(f, {});
        expect(r.columns.school_hazards[0]).toBe(2);
        expect(r.columns.school_hazards[5]).toBe(0);
        expect(r.metric.value).toBe(8.3);
        expect(r.stats.some(x => /^School check 1/.test(x.label))).toBe(true);
        expect(L._lenses.schoolsafe(L.frameFrom(codes, base), {})).toBeNull();
        const m = L._lenses.heritagesafe(L.frameFrom(codes, { ...base, 'heritage.national': codes.map((_, i) => (i < SIZE ? 1 : 0)), 'heritage.local': codes.map((_, i) => (i < SIZE ? 1 : 0)), 'flood_future.any_pct_now': codes.map(() => 90) }), {});
        expect(m.columns.heritage_hazards[0]).toBe(1);
        expect(m.stats[0]).toEqual({ label: 'Monuments mapped', value: '24' });
        const h = L._lenses.hospitalsafe(L.frameFrom(codes, { ...base, 'places.hospitals': codes.map((_, i) => (i < SIZE ? 2 : 0)), 'flood_future.any_pct_now': codes.map(() => 90) }), {});
        expect(h.columns.hospital_hazards[0]).toBe(1);
        expect(h.stats[0]).toEqual({ label: 'Hospitals mapped', value: '24' });
    });

    it('stationload: residents assigned to their nearest suburban station', () => {
        const f = L.frameFrom(codes, { ...base, 'rail_access.rail_stations': codes.map((_, i) => (i === 0 || i === 11 || i === n - 1 ? 1 : 0)) });
        const r = L._lenses.stationload(f, {});
        expect(r.stats[0].value).toBe('3');
        expect(r.columns.station_load[0]).toBeGreaterThan(0);
        expect(r.columns.station_load[1]).toBe(r.columns.station_load[0]);
        expect(r.stats.some(x => /^Crowded station 1/.test(x.label))).toBe(true);
        expect(L._lenses.stationload(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('walkups: older residents in 3-5 storey blocks and pharmacy reach', () => {
        const f = L.frameFrom(codes, { ...base, 'demographics.elderly_60plus': codes.map(() => 100),
            'building_stock.height_2023_m': codes.map((_, i) => (col(i) < 6 ? 12 : 20)), 'places.pharmacies': codes.map((_, i) => (i === n - 1 ? 1 : 0)) });
        const r = L._lenses.walkups(f, {});
        expect(r.columns.elderly_walkup[0]).toBe(100);
        expect(r.columns.elderly_walkup[11]).toBe(0);
        expect(r.metric.value).toBe(50);
        expect(r.stats.some(x => /^Walk-up 1/.test(x.label))).toBe(true);
        expect(L._lenses.walkups(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('treefall: tall canopy over busy main roads', () => {
        const f = L.frameFrom(codes, { ...base, 'vegetation.canopy_m': codes.map((_, i) => (col(i) < 3 ? 6 : 0.5)),
            'vegetation.tree_canopy_pct': codes.map((_, i) => (col(i) < 3 ? 50 : 5)), 'osm_roads.major_km_km2': codes.map((_, i) => (i < SIZE * 6 ? 10 : 0)),
            'osm_roads.secondary_km_km2': codes.map(() => 0) });
        const r = L._lenses.treefall(f, {});
        expect(r.columns.tree_fall[0]).toBe(2);
        expect(r.columns.tree_fall[SIZE * 11]).toBe(1);
        expect(r.columns.tree_fall[11]).toBe(0);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(L._lenses.treefall(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('gridflood: wet substations and the residents nearest to them', () => {
        const f = L.frameFrom(codes, { ...base, 'power_lines.substations': codes.map((_, i) => (i === 0 || i === 11 || i === n - 1 ? 1 : 0)),
            'flood_future.any_pct_now': codes.map((_, i) => (col(i) < 2 ? 80 : 0)) });
        const r = L._lenses.gridflood(f, {});
        expect(r.columns.substation_wet[0]).toBe(2);
        expect(r.columns.substation_wet[1]).toBe(2);
        expect(r.columns.substation_wet[10]).toBe(0);
        expect(r.stats[1].value).toBe('1 / 0');
        expect(r.stats.some(x => /^Raise or wall 1/.test(x.label))).toBe(true);
        expect(L._lenses.gridflood(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('coaching: coaching hubs with waterlogging, packed lanes and fire-station flags', () => {
        const f = L.frameFrom(codes, { ...base, 'places.coaching': codes.map((_, i) => (i === 0 ? 30 : i === n - 1 ? 1 : 0)),
            'waterlogging.waterlogging_index': codes.map((_, i) => (col(i) < 2 ? 70 : 10)), 'building_stock.cover_2023_pct': codes.map(() => 20) });
        const r = L._lenses.coaching(f, {});
        expect(r.columns.coaching_hub[0]).toBe(2);
        expect(r.columns.coaching_hub[n - 1]).toBe(0);
        expect(r.stats[1].value).toBe(String(r.idx.filter(i => r.columns.coaching_hub[i] >= 2).length));
        expect(r.stats.some(x => /^Hub 1/.test(x.label))).toBe(true);
        expect(L._lenses.coaching(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('rainharvest: roof rain a year and per resident', () => {
        const f = L.frameFrom(codes, { ...base, 'building_stock.cover_2023_pct': codes.map(() => 50), 'rainfall.rain_annual_mm': codes.map(() => 1000) });
        const r = L._lenses.rainharvest(f, {});
        const km2 = f.grid.cellKm2;
        expect(r.columns.harvest_m3[0]).toBeCloseTo(0.5 * km2 * 1e6 * 0.8, 0);
        expect(r.columns.harvest_lpd[0]).toBeCloseTo(0.5 * km2 * 1e6 * 0.8 * 1000 / 365 / 1000, 1);
        expect(r.stats.some(x => /^Harvest 1/.test(x.label))).toBe(true);
        expect(L._lenses.rainharvest(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('sitedust: construction sites near schools and hospitals, hot sites', () => {
        const f = L.frameFrom(codes, { ...base, 'sites.site_status': codes.map((_, i) => (i === 0 ? 2 : i === 5 ? 3 : 0)),
            'emergency_access.schools': codes.map((_, i) => (i === 1 ? 1 : 0)), 'surface_heat.uhi_anomaly_c': codes.map((_, i) => (i === 0 ? 3 : 0)) });
        const r = L._lenses.sitedust(f, {});
        expect(r.columns.site_dust[0]).toBe(3);
        expect(r.columns.site_dust[5]).toBe(1);
        expect(r.columns.site_dust[SIZE * 11]).toBe(0);
        expect(r.stats[0].value).toBe('2');
        expect(L._lenses.sitedust(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('hotelfire: hotel clusters flagged for packed blocks, deep lanes and old stock', () => {
        const f = L.frameFrom(codes, { ...base, 'places.lodging': codes.map((_, i) => (i === 0 ? 60 : i === n - 1 ? 1 : 0)),
            'building_stock.cover_2023_pct': codes.map((_, i) => (col(i) < 2 ? 70 : 20)), 'building_dynamics.settled_year': codes.map(() => 1985) });
        const r = L._lenses.hotelfire(f, {});
        expect(r.columns.hotel_fire[0]).toBe(3);
        expect(r.columns.hotel_fire[n - 1]).toBe(0);
        expect(r.stats.some(x => /^Hotel audit 1/.test(x.label))).toBe(true);
        expect(L._lenses.hotelfire(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('quarries: residents near quarries and flooded pits', () => {
        const f = L.frameFrom(codes, { ...base, 'landuse.quarry_pct': codes.map((_, i) => (i === 0 ? 60 : 0)),
            'land_cover.water_pct': codes.map((_, i) => (i === 0 ? 20 : 0)), 'demographics.children_pct': codes.map(() => 20) });
        const r = L._lenses.quarries(f, {});
        expect(r.columns.quarry_near[0]).toBe(2);
        expect(r.columns.quarry_near[SIZE * 11 + 11]).toBe(0);
        expect(r.stats[0].value).toBe('1, 1 holding water');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(L._lenses.quarries(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('fuelsafe: fuel stations flagged for schools, packed blocks and floods', () => {
        const f = L.frameFrom(codes, { ...base, 'places.fuel': codes.map((_, i) => (i < 6 ? 1 : 0)),
            'emergency_access.schools': codes.map((_, i) => (i === 0 ? 1 : 0)), 'flood_future.any_pct_now': codes.map((_, i) => (i < 2 ? 80 : 0)) });
        const r = L._lenses.fuelsafe(f, {});
        expect(r.columns.fuel_flags[0]).toBe(2);
        expect(r.columns.fuel_flags[1]).toBe(1);
        expect(r.columns.fuel_flags[5]).toBe(0);
        expect(r.stats[0].value).toBe('6');
        expect(L._lenses.fuelsafe(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('carekit: lab, dentist and eye clinic reach', () => {
        const f = L.frameFrom(codes, { ...base, 'places.diagnostics': codes.map((_, i) => (col(i) === 0 ? 1 : 0)),
            'places.dental': codes.map(() => 1), 'places.eyecare': codes.map(() => 0) });
        const r = L._lenses.carekit(f, {});
        const g = r.columns.care_gaps;
        expect(g[codes.findIndex((_, i) => col(i) === 0)]).toBe(1);
        expect(Math.max(...g.filter(Number.isFinite))).toBe(2);
        expect(r.stats[0].value).toBe(`12 / ${codes.length} / 0`);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(L._lenses.carekit(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('coalplume: downwind coal index and residents near plants', () => {
        const f = L.frameFrom(codes, { ...base, 'power_plants.coal_plume': codes.map((_, i) => col(i)),
            'power_plants.coal_km': codes.map((_, i) => 5 + 3 * col(i)), 'power_plants.coal_mw_50km': codes.map(() => 1000) });
        const r = L._lenses.coalplume(f, {});
        expect(r.columns.coal_plume[codes.findIndex((_, i) => col(i) === 11)]).toBe(11);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats[0].value).toBe('1,000 MW');
        expect(L._lenses.coalplume(L.frameFrom(codes, { ...base, 'power_plants.coal_plume': codes.map(() => 0) }), {})).toBeNull();
    });

    it('floodagain: residents in repeat-flood blocks', () => {
        const f = L.frameFrom(codes, { ...base, 'flood_reports.flood_events': codes.map((_, i) => (col(i) < 3 ? 2 : col(i) < 6 ? 1 : 0)),
            'flood_reports.flood_spots': codes.map((_, i) => (col(i) < 6 ? 3 : 0)), 'flood_reports.flooded_2015_pct': codes.map((_, i) => (col(i) < 3 ? 100 : 0)) });
        const r = L._lenses.floodagain(f, {});
        expect(r.metric.value).toBeCloseTo(25, 0);
        expect(r.stats.some(s => /^Drain audit 1: /.test(s.label))).toBe(true);
        expect(L._lenses.floodagain(L.frameFrom(codes, { ...base, 'flood_reports.flood_events': codes.map(() => 0) }), {})).toBeNull();
    });

    it('howbuilt: residents in unplanned and informal blocks', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'urban_form.res_atomistic_pct': two(70, 5), 'urban_form.res_informal_pct': two(20, 5), 'urban_form.res_formal_pct': two(10, 85),
            'urban_form.res_project_pct': two(0, 5), 'urban_form.ulu_road_pct': two(8, 16) });
        const r = L._lenses.howbuilt(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.metric.value).toBeLessThan(100);
        expect(r.stats.find(s => /^Road share/.test(s.label)).value).toBe('8% vs 16%');
        expect(r.stats.some(s => /^Unplanned area 1: /.test(s.label))).toBe(true);
        expect(L._lenses.howbuilt(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('floodnews: residents near repeatedly reported flood spots', () => {
        const f = L.frameFrom(codes, { ...base, 'news_floods.flood_news_days': codes.map((_, i) => (i === 0 ? 5 : i === 40 ? 1 : 0)), 'news_floods.flood_news_recent': codes.map((_, i) => (i === 0 ? 2 : 0)) });
        const r = L._lenses.floodnews(f, {});
        expect(r.stats[0].value).toBe('2');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Repeat flood spot 1: /.test(s.label))).toBe(true);
        expect(L._lenses.floodnews(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('badairdays: days above the PM2.5 standard', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'pm25_days.days_over_60': two(150, 40), 'pm25_days.days_over_90': two(60, 0), 'pm25_days.days_over_60_change': two(-20, -10) });
        const r = L._lenses.badairdays(f, {});
        expect(r.metric.value).toBeGreaterThan(40);
        expect(r.metric.value).toBeLessThan(150);
        expect(r.stats.some(s => /^Worst air 1: /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/fewer than in 2017/);
        expect(L._lenses.badairdays(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('feelslike: outdoor heat stress months', () => {
        const f = L.frameFrom(codes, { ...base, 'feels_like.utci_vstrong_months': codes.map((_, i) => (col(i) < 6 ? 3 : 1)), 'feels_like.utci_strong_months': codes.map(() => 6),
            'feels_like.utci_amj_c': codes.map((_, i) => (col(i) < 6 ? 40 : 37)), 'feels_like.utci_vstrong_months_then': codes.map(() => 1.5) });
        const r = L._lenses.feelslike(f, {});
        expect(r.metric.value).toBeGreaterThan(37);
        expect(r.stats.some(s => /^Hottest to be outdoors 1: /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/very strong heat stress/);
        expect(L._lenses.feelslike(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('lowground: residents on ground near sea level', () => {
        const f = L.frameFrom(codes, { ...base, 'low_ground.ground_m': codes.map((_, i) => (col(i) < 6 ? 2 : 8)), 'low_ground.below2_pct': codes.map((_, i) => (col(i) < 6 ? 60 : 0)),
            'low_ground.below3_pct': codes.map((_, i) => (col(i) < 6 ? 90 : 0)), 'low_ground.below5_pct': codes.map((_, i) => (col(i) < 6 ? 100 : 10)) });
        const r = L._lenses.lowground(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Low and lived-in 1: /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/above mean sea level/);
        expect(L._lenses.lowground(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('homes2011: Census 2011 crowding and amenities by ward', () => {
        const w = i => 1 + Math.floor(col(i) / 2);
        const f = L.frameFrom(codes, { ...base, 'census_homes.c11_ward_no': codes.map((_, i) => w(i)), 'census_homes.c11_households': codes.map((_, i) => 1000 * w(i)),
            'census_homes.c11_hh_size': codes.map(() => 4.5), 'census_homes.c11_one_room_pct': codes.map((_, i) => 40 + 5 * w(i)),
            'census_homes.c11_no_latrine_pct': codes.map((_, i) => 10 * w(i)), 'census_homes.c11_car_pct': codes.map((_, i) => 30 - 3 * w(i)) });
        const r = L._lenses.homes2011(f, {});
        expect(r.metric.value).toBeGreaterThan(40);
        expect(r.stats.some(s => /^Most crowded 1: F\/N ward/.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/lived in one room or less/);
        expect(L._lenses.homes2011(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('spending: HCES city figures', () => {
        const k = (v) => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'hces.hc_mpce': k(8542), 'hces.hc_mpce_median': k(7130), 'hces.hc_food_pct': k(39.5), 'hces.hc_rent_pct': k(6.4),
            'hces.hc_renters_pct': k(36.6), 'hces.hc_rent': k(6096), 'hces.hc_top_bottom': k(3.8), 'hces.hc_gini': k(0.278), 'hces.hc_households': k(3049) });
        const r = L._lenses.spending(f, {});
        expect(r.headline).toBe('Urban households here spent ₹8,542 a month per person in 2023-24 (the middle person ₹7,130); food took 40% and rent 6%, with 37% of households renting at ₹6,096 a month on average. The richest fifth consumed 3.8 times as much per person as the poorest fifth.');
        expect(L._lenses.spending(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('roaddeaths: MoRTH city figures', () => {
        const k = (v) => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'city_road_deaths.rd_killed_2024': k(894), 'city_road_deaths.rd_killed_2023': k(912), 'city_road_deaths.rd_crashes_2024': k(4780),
            'city_road_deaths.rd_rank_killed_2024': k(2), 'city_road_deaths.rd_per100': k(18.7), 'city_road_deaths.rd_per100_median': k(28.1),
            'city_road_deaths.rd_twowheeler_pct': k(52), 'city_road_deaths.rd_pedestrian_pct': k(28), 'city_road_deaths.rd_speeding_pct': k(87) });
        const r = L._lenses.roaddeaths(f, {});
        expect(r.headline).toBe('894 people died on the roads in the police city in 2024 (down 2% on 2023), the 2nd most of 50 large cities; 18.7 died per 100 crashes, fewer than the 50-city median of 28.1. Two-wheeler riders were 52% of the dead and pedestrians 28%; police put 87% of deaths down to over-speeding.');
        expect(r.metric.value).toBe(18.7);
        expect(L._lenses.roaddeaths(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('since1951: city temperatures since 1951', () => {
        const k = (v) => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'city_climate.cc_tmax_change': k(-0.21), 'city_climate.cc_tmin_change': k(0.47), 'city_climate.cc_hot_then': k(18.2),
            'city_climate.cc_hot_now': k(15.7), 'city_climate.cc_warm_nights_now': k(16.7), 'city_climate.cc_40_then': k(42.1), 'city_climate.cc_40_now': k(37.9) }, { city: 'delhi' });
        const r = L._lenses.since1951(f, {});
        expect(r.headline).toMatch(/^Compared with 1951-1980, the 1991-2020 average daily high here is -0.2 °C and the daily low \+0.5 °C\. Days that used to be the hottest 5% \(about 18 a year\) now come 16 times a year, and warm nights 17 times\. The warming here is mostly at night/);
        expect(r.stats[4].value).toBe('42 → 38');
        expect(L._lenses.since1951(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('challans: Mumbai traffic violations by police station', () => {
        const by = (a, b) => codes.map((_, i) => (col(i) < 8 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'traffic_challans.tc_per_1000': by(150, 40), 'traffic_challans.tc_helmet_pct': by(60, 60),
            'traffic_challans.tc_obstruct_pct': by(15, 15), 'traffic_challans.tc_signal_pct': by(2, 2), 'traffic_challans.tc_wrongway_pct': by(3, 3) }, { city: 'mumbai' });
        const r = L._lenses.challans(f, {});
        expect(r.headline).toMatch(/and 67% of residents live where they booked 100 or more; riding without a helmet made up 60% of bookings and obstruction 15%\./);
        expect(r.metric.value).toBe(67);
        expect(L._lenses.challans(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('junctions: counted junction traffic (BBMP surveys)', () => {
        const by = (a, b) => codes.map((_, i) => (col(i) < 8 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'junction_counts.jc_peak_veh': by(15026, 8000), 'junction_counts.jc_km': by(0.4, 1.5), 'junction_counts.jc_daily_veh': by(238685, 119980) }, { city: 'bengaluru' });
        const r = L._lenses.junctions(f, {});
        expect(r.headline).toMatch(/^67% of residents within 2 km of a counted junction live nearest one that carried 12,000 or more vehicles/);
        expect(r.headline).toMatch(/the busiest near here counted 15,026\./);
        expect(r.metric.value).toBe(67);
        expect(L._lenses.junctions(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('liquefy: Greater Chennai liquefaction susceptibility', () => {
        const by = (a, b) => codes.map((_, i) => (col(i) < 8 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'liquefaction.lq_likely_pct': by(80, 10), 'liquefaction.lq_possible_pct': by(10, 20), 'liquefaction.sh_high_pct': by(60, 0) }, { city: 'chennai' });
        const r = L._lenses.liquefy(f, {});
        expect(r.headline).toMatch(/residents here \(67%\) live in blocks mostly on ground a published assessment rates likely to liquefy in a strong earthquake, and 67% in blocks mostly in its high seismic hazard class\./);
        expect(L._lenses.liquefy(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('vitals: city birth and death registers', () => {
        const k = (v) => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'city_vitals.vs_excess_2021_pct': k(42.3), 'city_vitals.vs_excess_2021': k(25945), 'city_vitals.vs_excess_2020_pct': k(23.1),
            'city_vitals.vs_births': k(144115), 'city_vitals.vs_deaths': k(57918), 'city_vitals.vs_births_change_pct': k(-1.4), 'city_vitals.vs_year': k(2024),
            'city_vitals.vs_girls_per_1000': k(940) }, { city: 'bengaluru' });
        const r = L._lenses.vitals(f, {});
        expect(r.headline).toBe('BBMP registered 25,945 more deaths in 2021 than in an average year before COVID (+42% on 2017-19). Births registered in 2024 were 1% below that baseline, with 940 girls born per 1,000 boys.');
        expect(L._lenses.vitals(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('streetdogs: BMC street dog survey by ward', () => {
        const by = (a, b) => codes.map((_, i) => (col(i) < 8 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'street_dogs.sd_per_km': by(12, 3), 'street_dogs.sd_per_km_2014': by(15, 6), 'street_dogs.sd_sterilised_pct': by(50, 80),
            'street_dogs.sd_roaming': by(3000, 600), 'street_dogs.sd_ward_no': by(18, 1) }, { city: 'mumbai' });
        const r = L._lenses.streetdogs(f, {});
        expect(r.headline).toMatch(/^BMC's 2024 survey counted 9 roaming dogs per km of street in the wards here \(residents-weighted\), down from 12 in 2014\. .+ residents \(67%\) live in wards where fewer than 60% of the dogs were sterilised\.$/);
        expect(r.stats[4].value).toMatch(/^3,600 \(/);
        expect(L._lenses.streetdogs(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('floodspots: wards listed as waterlogged across monsoons', () => {
        const by = (a, b) => codes.map((_, i) => (col(i) < 8 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'flood_spots.fs_years': by(5, 1), 'flood_spots.fs_ward': by(7, 9), 'flood_spots.fs_2015': by(1, 1),
            'flood_spots.fs_2021': by(4, 2), 'flood_spots.fs_2024': by(2, 0) }, { city: 'chennai' });
        const r = L._lenses.floodspots(f, {});
        expect(r.headline).toMatch(/residents here \(67%\) live in wards where the corporation listed a waterlogged street or colony after at least 4 of the 9 north-east monsoons from 2015 to 2024, and 67% in wards with a spot listed after the 2024 rains\. In these wards the list shrank from 6 spots after the 2021 rains to 2 after 2024\./);
        expect(r.stats[4].value).toBe('Ward 7, 5 of 9 monsoons');
        expect(L._lenses.floodspots(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('crashzones: residents near listed accident-prone junctions', () => {
        const f = L.frameFrom(codes, { ...base, 'crash_zones.cz_km': codes.map((_, i) => (col(i) < 8 ? 0.3 : 2.4)), 'crash_zones.cz_1km': codes.map(() => 1) }, { city: 'delhi' });
        const r = L._lenses.crashzones(f, {});
        expect(r.headline).toMatch(/residents here \(67%\) live within 500 m of a junction the Delhi Traffic Police lists as accident-prone, and 67% within 1 km\. The middle resident's nearest such junction is 0\.3 km away\./);
        expect(L._lenses.crashzones(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('schoolready: school safety audit shares by PIN code', () => {
        const f = L.frameFrom(codes, { ...base, 'school_safety.ss_audit_pct': codes.map((_, i) => (col(i) < 8 ? 20 : 90)), 'school_safety.ss_cctv_pct': codes.map(() => 70),
            'school_safety.ss_plan_pct': codes.map(() => 80) });
        const r = L._lenses.schoolready(f, {});
        expect(r.headline).toMatch(/^In the PIN codes here, \d+% of schools report a structural safety audit of their building, 70% have CCTV and 80% a disaster management plan\. .* residents \(67%\) live in PIN codes where fewer than half the schools have had an audit\.$/);
        expect(L._lenses.schoolready(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('lakeoxygen: lakes that never reached fish oxygen', () => {
        const f = L.frameFrom(codes, { ...base, 'lake_oxygen.lo_do_max': codes.map((_, i) => (col(i) < 8 ? 2.4 : 6.2)), 'lake_oxygen.lo_do_min': codes.map(() => 0.3),
            'lake_oxygen.lo_fc_max': codes.map(() => 120), 'lake_oxygen.lo_dead_2km': codes.map(() => 1) });
        const r = L._lenses.lakeoxygen(f, {});
        expect(r.headline).toMatch(/residents here live within 2 km of a lake the pollution board sampled in 2021\. For .* of them \(67%\) the nearest lake never reached 4 mg\/L of dissolved oxygen, the least fish need, in any sample, and 100% live nearest one that fell below it at least once\./);
        expect(L._lenses.lakeoxygen(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('lakewater: class E share at the nearest monitored lake', () => {
        const f = L.frameFrom(codes, { ...base, 'lake_water.lw_e_share': codes.map((_, i) => (col(i) < 8 ? 86 : 14)), 'lake_water.lw_do': codes.map(() => 3),
            'lake_water.lw_fc': codes.map(() => 2400), 'lake_water.lw_e_lakes_2km': codes.map(() => 1) });
        const r = L._lenses.lakewater(f, {});
        expect(r.headline).toMatch(/residents here live within 2 km of a lake KSPCB samples every month\. For .* of them \(67%\) the nearest lake was class E, fit only for irrigation and industrial cooling, in most samples, and the middle resident's lake carried 2,400 faecal coliform per 100 ml, a sign of sewage\./);
        expect(L._lenses.lakewater(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('wellwater: nitrate at the nearest observation well', () => {
        const f = L.frameFrom(codes, { ...base, 'well_quality.wq_no3': codes.map((_, i) => (col(i) < 8 ? 88 : 20)), 'well_quality.wq_no3_prev': codes.map(() => 50),
            'well_quality.wq_km': codes.map(() => 3), 'well_quality.wq_th': codes.map(() => 400) });
        const r = L._lenses.wellwater(f, {});
        expect(r.headline).toMatch(/residents here \(67%\) live nearest a government observation well whose groundwater had more nitrate than the 45 mg\/L drinking-water limit in 2018-19; the middle resident's well read 88 mg\/L, 3 km away\./);
        expect(L._lenses.wellwater(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('measuredair: nearest-station PM2.5 and PM10', () => {
        const f = L.frameFrom(codes, { ...base, 'air_measured.am_pm25': codes.map((_, i) => (col(i) < 8 ? 35.7 : 25.1)), 'air_measured.am_pm10': codes.map(() => 80),
            'air_measured.am_km': codes.map((_, i) => (col(i) < 8 ? 2 : 7)), 'air_measured.am_pm10_months_over': codes.map((_, i) => (col(i) < 8 ? 12 : 5)), 'air_measured.am_months': codes.map(() => 12) });
        const r = L._lenses.measuredair(f, {});
        expect(r.headline).toMatch(/averaged \d+(\.\d)? µg\/m³ of PM2\.5 and 80 µg\/m³ of PM10, within the national PM2\.5 standard of 40 but \d+ times the WHO guideline\. .* residents \(67%\) live nearest a station whose PM10 was over the national standard in every month measured, and 33% live more than 5 km from any station\.$/);
        const delhi = L.frameFrom(codes, { ...base, 'air_measured.am_pm25': codes.map(() => 100), 'air_measured.am_pm10': codes.map(() => 200),
            'air_measured.am_km': codes.map(() => 2), 'air_measured.am_pm10_months_over': codes.map(() => 12), 'air_measured.am_months': codes.map(() => 12) });
        expect(L._lenses.measuredair(delhi, {}).headline).toMatch(/above the national PM2\.5 standard of 40 and 20 times the WHO guideline\./);
        expect(L._lenses.measuredair(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('waterstorage: Metrowater tank storage per resident', () => {
        const f = L.frameFrom(codes, { ...base, 'water_storage.ws_tank_km': codes.map((_, i) => (col(i) < 8 ? 1 : 4)), 'water_storage.ws_l_per_res': codes.map((_, i) => (col(i) < 8 ? 40 : 5)),
            'water_storage.ws_fill_km': codes.map(() => 2) });
        const r = L._lenses.waterstorage(f, {});
        expect(r.headline).toMatch(/tanks within 2 km hold \d+ litres per person living around them \(5 litres for the worst-served tenth\)\. .* residents \(33%\) are more than 3 km from any tank\.$/);
        expect(L._lenses.waterstorage(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('treefelling: trees in felling notices near residents', () => {
        const f = L.frameFrom(codes, { ...base, 'tree_felling.tf_trees_2km': codes.map((_, i) => (col(i) < 8 ? 1200 : 0)), 'tree_felling.tf_km': codes.map((_, i) => (col(i) < 8 ? 1 : 4)),
            'tree_felling.tf_trees_nearest': codes.map(() => 2184), 'tree_felling.tf_kind_nearest': codes.map(() => 1) });
        const r = L._lenses.treefelling(f, {});
        expect(r.headline).toMatch(/residents here \(67%\) live within 2 km of a project the Forest Department has cleared to fell trees, most often for metro\. The worst-hit block has 1,200 trees/);
        expect(L._lenses.treefelling(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('districtdev: district banking, power and child health', () => {
        const left = i => col(i) < 8;
        const f = L.frameFrom(codes, { ...base, 'district_dev.dd_banks_lakh': codes.map((_, i) => (left(i) ? 15.1 : 38.9)), 'district_dev.dd_atms_lakh': codes.map((_, i) => (left(i) ? 27 : 88)),
            'district_dev.dd_deposit_pc': codes.map(() => 1267663), 'district_dev.dd_credit_pc': codes.map(() => 1811215), 'district_dev.dd_elec_home_kwh': codes.map(() => 812.5),
            'district_dev.dd_schools_lakh': codes.map(() => 24), 'district_dev.dd_imr': codes.map(() => 5.1), 'district_dev.dd_underweight_pct': codes.map(() => 7.9) });
        const r = L._lenses.districtdev(f, {});
        expect(r.headline).toMatch(/^Most residents here live in a district with 15\.1 bank branches and 27 ATMs per lakh people, deposits of ₹12,67,663 and loans of ₹18,11,215 per head, homes using 813 kWh of electricity per head a year, 24 schools per lakh people; 5\.1 infant deaths per 1,000 births and 7\.9% of under-fives underweight\. The 2 districts in view average/);
        expect(L._lenses.districtdev(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('smallbiz: district MSMEs, eShram and Class 10 results', () => {
        const f = L.frameFrom(codes, { ...base, 'district_dev.dd_msme_units': codes.map(() => 633664), 'district_dev.dd_msme_jobs': codes.map(() => 5099692),
            'district_dev.dd_sslc_pass_pct': codes.map(() => 82), 'district_dev.dd_sslc_pass_2024': codes.map(() => 90.2), 'district_dev.dd_eshram_pct': codes.map(() => 19.1) });
        const r = L._lenses.smallbiz(f, {});
        expect(r.headline).toBe('Most residents here live in a district with 6.3 lakh registered micro, small and medium enterprises reporting 51 lakh jobs; 82% of Class 10 students passed in 2025 (90.2% in 2024), and 19% of its target of unorganised workers have signed up to eShram.');
        expect(L._lenses.smallbiz(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('districtincome: district per capita income and state rank', () => {
        const left = i => col(i) < 8;
        const f = L.frameFrom(codes, { ...base, 'district_income.di_pci': codes.map((_, i) => (left(i) ? 855960 : 349559)), 'district_income.di_year': codes.map(() => 2024),
            'district_income.di_rank': codes.map((_, i) => (left(i) ? 1 : 7)), 'district_income.di_districts': codes.map(() => 31), 'district_income.di_pci_median': codes.map(() => 280000) });
        const r = L._lenses.districtincome(f, {});
        expect(r.headline).toBe('Most residents here live in a district with a per capita income of ₹8,55,960 a year (2024-25), rank 1 of 31 in the state and 3.1 times the state\'s median district. Across the 2 districts in view it averages ₹6,87,160.');
        const g = L._lenses.districtincome(L.frameFrom(codes, { ...base, 'district_income.di_pci': codes.map(() => 517875), 'district_income.di_year': codes.map(() => 2024),
            'district_income.di_rank': codes.map(() => 1), 'district_income.di_districts': codes.map(() => 35), 'district_income.di_growth_pct': codes.map(() => 9.6), 'district_income.di_growth_from': codes.map(() => 2021) }), {});
        expect(g.headline).toBe('Most residents here live in a district with a per capita income of ₹5,17,875 a year (2024-25), rank 1 of 35 in the state; its economy grew 9.6% a year in real terms from 2021-22.');
        expect(L._lenses.districtincome(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('gwstress: district groundwater extraction', () => {
        const f = L.frameFrom(codes, { ...base, 'gw_district.gw_stage_pct': codes.map((_, i) => (col(i) < 6 ? 177 : 67)), 'gw_district.gw_class': codes.map((_, i) => (col(i) < 6 ? 4 : 1)),
            'gw_district.gw_domestic_pct': codes.map(() => 30) });
        const r = L._lenses.gwstress(f, {});
        expect(r.headline).toBe('Districts here pump 122% of the groundwater their aquifers recharge in a year (residents-weighted); 50% of residents live in over-exploited districts, where more is drawn than recharged, and homes take 30% of what is pumped.');
        expect(L._lenses.gwstress(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('tollring: nearest toll plaza and car fees', () => {
        const f = L.frameFrom(codes, { ...base, 'tolls.toll_km': codes.map((_, i) => col(i)), 'tolls.toll_car': codes.map(() => 120), 'tolls.toll_car_month': codes.map(() => 3000),
            'tolls.toll_code': codes.map((_, i) => (col(i) < 6 ? 1 : 2)), 'tolls.tolls_25km': codes.map(() => 3) });
        const r = L._lenses.tollring(f, {});
        expect(r.headline).toMatch(/^The middle resident lives 5(\.0)? km from a toll plaza, and 50% live within 5 km of one; a car pays ₹120 a trip at the nearest plaza on average, or ₹3,000 for a monthly pass\.$/);
        expect(r.stats.filter(s => /^Nearest plaza for most residents/.test(s.label))).toHaveLength(2);
        expect(L._lenses.tollring(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('wardcouncil: ward parties, split seats and the MLA match', () => {
        // Six four-member wards: four BJP (one split 3-1), two INC; the MLA is BJP everywhere.
        const ward = codes.map((_, i) => 1 + (i % 6));
        const f = L.frameFrom(codes, { ...base, 'population.population': codes.map(() => 2000), 'ward_results.corp_ward_no': ward,
            'ward_results.corp_party_id': ward.map(w => (w <= 4 ? 1 : 2)), 'ward_results.corp_seats': ward.map(() => 4), 'ward_results.corp_lead_seats': ward.map(w => (w === 1 ? 3 : 4)),
            'ward_results.corp_year': codes.map(() => 2026), 'assembly_results.mla_party_id': codes.map(() => 1) });
        const r = L._lenses.wardcouncil(f, {});
        expect(r.headline).toBe("At the 2026 corporation election, BJP won 4 of the 6 wards in view, home to 67% of residents, and INC 2; 1 multi-member ward splits its seats between parties, and 33% of residents have a ward party different from their MLA's.");
        expect(r.stats[0].value).toBe('6 / 24');
        expect(L._lenses.wardcouncil(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('citycrime: NCRB metropolitan-city figures', () => {
        const k = (v) => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'city_crime.cr_total_2022': k(46187), 'city_crime.cr_total_2023': k(68520), 'city_crime.cr_total_2024': k(57555),
            'city_crime.cr_rate': k(677.2), 'city_crime.cr_rate_median': k(775.3), 'city_crime.cr_chargesheet_pct': k(54.4), 'city_crime.cr_cyber_2022': k(9940), 'city_crime.cr_cyber_2024': k(17561) });
        const r = L._lenses.citycrime(f, {});
        expect(r.headline).toBe('Police registered 57,555 cognizable crimes in the city in 2024 (up 25% on 2022), 677 per lakh people, close to the 19-city median of 775; 54% of cases were charge-sheeted. Cyber crime cases numbered 17,561, 1.8 times 2022\'s.');
        expect(L._lenses.citycrime(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('rollrevision: electors cut by the 2026 revision', () => {
        // Four seats of 200,000 electors in 2024, cut by 10, 20, 30 and 40%.
        const seat = codes.map((_, i) => 1 + (i % 4));
        const f = L.frameFrom(codes, { ...base, 'population.population': codes.map(() => 2000), 'roll_revision.sir_ac': seat,
            'roll_revision.sir_electors_2024': seat.map(() => 200000), 'roll_revision.sir_electors': seat.map(s => 200000 * (1 - 0.1 * s)),
            'roll_revision.sir_change_pct': seat.map(s => -10 * s), 'roll_revision.sir_women_per_1000': seat.map(() => 1050), 'roll_revision.sir_deleted_pct': seat.map(() => 30) });
        const r = L._lenses.rollrevision(f, {});
        expect(r.metric.value).toBe(-25);
        expect(r.headline).toMatch(/^The 4 assembly seats in view had .+ electors in 2024 and .+ on the final roll after the 2026 revision \(-25%\); cuts ran from 10% to 40% a seat, and 30% of the old roll was struck off at the draft stage\.$/);
        expect(r.stats.some(s => /^Biggest cut 1: seat 4, /.test(s.label) && s.value === '-40%')).toBe(true);
        expect(L._lenses.rollrevision(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('mlaseats: party, close seats and split with the MP', () => {
        // Six seats: four BJP (one won by 2 points), two INC; the INC seats sit under a BJP MP.
        const seat = codes.map((_, i) => 1 + (i % 6));
        const party = seat.map(s => (s <= 4 ? 1 : 2)), margin = seat.map(s => (s === 1 ? 2 : 10 + s));
        const f = L.frameFrom(codes, { ...base, 'population.population': codes.map(() => 2000),
            'assembly_results.mla_ac': seat, 'assembly_results.mla_party_id': party, 'assembly_results.mla_margin_pct': margin,
            'assembly_results.mla_year': codes.map(() => 2025), 'assembly_results.mp_party_id': codes.map(() => 1) });
        const r = L._lenses.mlaseats(f, {});
        expect(r.headline).toMatch(/^At the 2025 assembly election, BJP won 4 of the 6 seats in view, home to 67% of residents, and INC 2; 1 seat was won by under 5 points \(closest 2\), and 33% of residents have an MLA from a different party than their 2024 MP\.$/);
        expect(r.stats.some(s => /^Closest seat 1: BJP held it/.test(s.label) && s.value === '2 points')).toBe(true);
        expect(L._lenses.mlaseats(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('healthnow: NFHS-6 state figures against NFHS-5', () => {
        const k = (v) => codes.map(() => v);
        const f = L.frameFrom(codes, { ...base, 'nfhs6.n5_sugar_women': k(14), 'nfhs6.n6_sugar_women': k(22), 'nfhs6.n6u_sugar_women': k(26),
            'nfhs6.n5_women_obese': k(30), 'nfhs6.n6_women_obese': k(41), 'nfhs6.n6u_women_obese': k(52), 'nfhs6.n5_stunted': k(35), 'nfhs6.n6_stunted': k(26), 'nfhs6.n6u_stunted': k(19),
            'nfhs6.n5_insurance': k(32), 'nfhs6.n6_insurance': k(63), 'nfhs.stunted_pct': k(31) });
        const r = L._lenses.healthnow(f, {});
        expect(r.metric.value).toBe(26);
        expect(r.headline).toMatch(/^Across the state, women overweight or obese rose from 30% to 41% \(52% in its towns and cities\) and women with raised blood sugar from 14%/);
        expect(r.headline).toMatch(/children under 5 stunted fell from 35% to 26%; 63% of households/);
        expect(r.stats.some(s => /^Children under 5 stunted/.test(s.label) && /\/ 31%$/.test(s.value))).toBe(true);
        expect(L._lenses.healthnow(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('fringevillages: services in the fringe villages against new floor space', () => {
        const vno = i => 1 + Math.floor(col(i) / 1);
        const f = L.frameFrom(codes, { ...base, 'village_services.ma_village_no': codes.map((_, i) => vno(i)), 'village_services.ma_households': codes.map(() => 500),
            'village_services.ma_piped_pct': codes.map((_, i) => 10 * col(i)), 'village_services.ma_kuccha_pct': codes.map(() => 5), 'village_services.ma_no_latrine_pct': codes.map(() => 2),
            'village_services.ma_drain': codes.map((_, i) => (col(i) < 3 ? 5 : 1)), 'village_services.ma_bus': codes.map((_, i) => (col(i) < 2 ? 0 : 1)),
            're_supply.new_floor_m2': codes.map((_, i) => 1000 * (SIZE - col(i))) });
        const r = L._lenses.fringevillages(f, {});
        expect(r.metric.value).toBe(55);
        expect(r.headline).toMatch(/3 villages had open kuccha drains or none; 5 of the 5 villages/);
        expect(r.stats.some(s => /^Rank match by village/.test(s.label) && s.value === -1)).toBe(true);
        expect(L._lenses.fringevillages(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('civicworks: constituency work orders per resident a year', () => {
        const a = i => 150 + Math.floor(col(i) / 2);
        const f = L.frameFrom(codes, { ...base, 'work_orders.wo_ac': codes.map((_, i) => a(i)), 'work_orders.wo_total_cr': codes.map((_, i) => 100 * (1 + Math.floor(col(i) / 2))),
            'work_orders.wo_roads_cr': codes.map((_, i) => 60 * (1 + Math.floor(col(i) / 2))), 'work_orders.wo_drains_cr': codes.map(() => 10) });
        const r = L._lenses.civicworks(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Most per resident 1: Dasarahalli/.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/60% went to roads/);
        expect(L._lenses.civicworks(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('licences: trade licences by pincode, growth and coverage', () => {
        const p = i => 560001 + Math.floor(col(i) / 2);
        const f = L.frameFrom(codes, { ...base, 'trade_licences.tl_pin': codes.map((_, i) => p(i)), 'trade_licences.tl_fy': codes.map(() => 500),
            'trade_licences.tl_new_then': codes.map((_, i) => 50 + col(i)), 'trade_licences.tl_new_now': codes.map((_, i) => 60 + 10 * col(i)),
            'trade_licences.tl_food_pct': codes.map(() => 60), 'places.places': codes.map(() => 10) });
        const r = L._lenses.licences(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Fastest-growing 1: 560006/.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/current licences per 100 businesses/);
        expect(L._lenses.licences(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('streetgrid: intersections per km² around homes and cut-off streets', () => {
        const f = L.frameFrom(codes, { ...base, 'street_grid.intersections': codes.map((_, i) => (col(i) < 6 ? 0 : 20)), 'street_grid.dead_ends': codes.map((_, i) => (col(i) < 6 ? 3 : 1)) });
        const r = L._lenses.streetgrid(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Cut-off streets 1: /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/fewer than 50/);
        expect(L._lenses.streetgrid(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('ptax: ward property tax per resident against land value', () => {
        const w = i => 1 + col(i);
        const f = L.frameFrom(codes, { ...base, 'property_tax.pt_ward': codes.map((_, i) => w(i)), 'property_tax.pt_res_demand_lakh': codes.map((_, i) => 10 * w(i)),
            'property_tax.pt_collect_pct': codes.map((_, i) => 80 + w(i)), 'property_tax.pt_res_growth_pct': codes.map((_, i) => 5 * w(i)) });
        const r = L._lenses.ptax(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Rank match with the land value index/.test(s.label) && /^1 \//.test(s.value))).toBe(true);
        expect(r.stats.some(s => /^Lowest collection 1: ward 1,/.test(s.label))).toBe(true);
        expect(L._lenses.ptax(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('jobcount: ward workers from the Economic Census, density and sector mix', () => {
        const w = i => 1 + Math.floor(col(i) / 2);
        const f = L.frameFrom(codes, { ...base, 'econ_census.ec_ward': codes.map((_, i) => w(i)), 'econ_census.ec_workers': codes.map((_, i) => 1000 * w(i)),
            'econ_census.ec_estabs': codes.map((_, i) => 400 * w(i)), 'econ_census.mfg_pct': codes.map(() => 30), 'econ_census.trade_pct': codes.map(() => 40),
            'econ_census.women_pct': codes.map(() => 12), 'econ_census.home_pct': codes.map(() => 25) });
        const r = L._lenses.jobcount(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Workers in manufacturing \/ trade/.test(s.label) && s.value === '30% / 40%')).toBe(true);
        expect(r.stats.some(s => /^Densest jobs 1: ward /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/only 12% were women/);
        expect(L._lenses.jobcount(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('tankbeds: residents on built-up tank beds, tank status and waterlogging', () => {
        const f = L.frameFrom(codes, { ...base, 'tank_beds.tankbed_pct': codes.map((_, i) => (col(i) > 8 ? 60 : 0)), 'tank_beds.tankbed_built_pct': codes.map((_, i) => (col(i) > 8 ? 40 : 0)),
            'tank_beds.tanks': codes.map((_, i) => (col(i) > 8 ? 1 : 0)), 'tank_beds.tanks_lost': codes.map((_, i) => (col(i) > 10 ? 1 : 0)),
            'waterlogging.waterlogging_index': codes.map((_, i) => (col(i) > 8 ? 50 : 20)) });
        const r = L._lenses.tankbeds(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Satellite waterlogging index/.test(s.label) && s.value === '50 / 20')).toBe(true);
        expect(r.stats.some(s => /^Homes on a tank bed 1: /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/2.5× the waterlogging/);
        expect(L._lenses.tankbeds(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('hotdays: resident-weighted days at 40 °C, decade change and hottest homes', () => {
        const f = L.frameFrom(codes, { ...base, 'air_heat.days40_now': codes.map((_, i) => (col(i) > 8 ? 55 : 40)), 'air_heat.days40_then': codes.map(() => 42),
            'air_heat.nights28_now': codes.map(() => 20), 'air_heat.nights28_then': codes.map(() => 15) });
        const r = L._lenses.hotdays(f, {});
        expect(r.metric.value).toBeGreaterThan(40);
        expect(r.stats.some(s => /^Nights a year that stay at 28/.test(s.label) && /15 → 20/.test(s.value))).toBe(true);
        expect(r.stats.some(s => /^Hottest homes 1: /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/more than in 2005-2014/);
        expect(L._lenses.hotdays(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('nightshelters: shelters against the NULM norm and station blocks without one', () => {
        const f = L.frameFrom(codes, { ...base, 'night_shelters.shelters': codes.map((_, i) => (i === 0 ? 1 : 0)), 'night_shelters.for_women': codes.map((_, i) => (i === 0 ? 1 : 0)),
            'rail_access.rail_stations': codes.map((_, i) => (i === codes.length - 1 ? 1 : 0)) });
        const r = L._lenses.nightshelters(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Shelters needed at the NULM norm/.test(s.label))).toBe(true);
        expect(r.stats.some(s => /^Shelter to add 1: /.test(s.label))).toBe(true);
        expect(L._lenses.nightshelters(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('greenchange: residents in blocks that browned against the city', () => {
        const f = L.frameFrom(codes, { ...base, 'green_change.green_rel_change': codes.map((_, i) => (col(i) > 8 ? -0.2 : 0.15)),
            'green_change.ndvi_2000s': codes.map(() => 0.3), 'green_change.ndvi_2020s': codes.map(() => 0.2),
            'heat_change.heat_rel_change_c': codes.map((_, i) => (col(i) > 8 ? 2 : -1)) });
        const r = L._lenses.greenchange(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Surface heat change against the city: browned/.test(s.label))).toBe(true);
        expect(r.stats.some(s => /^Lost green 1: /.test(s.label))).toBe(true);
        expect(L._lenses.greenchange(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('heatedup: residents in blocks that warmed against the city', () => {
        const f = L.frameFrom(codes, { ...base, 'heat_change.heat_rel_change_c': codes.map((_, i) => (col(i) > 8 ? 3 : -0.5)),
            'heat_change.lst_2020s_c': codes.map(() => 40), 'built_up.built_change_pct': codes.map((_, i) => (col(i) > 5 ? 30 : 1)) });
        const r = L._lenses.heatedup(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Change against the city, homes built over since 2000/.test(s.label))).toBe(true);
        expect(r.stats.some(s => /^Heated up 1: /.test(s.label))).toBe(true);
        expect(L._lenses.heatedup(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('coldnights: residents in winter cold pockets', () => {
        const f = L.frameFrom(codes, { ...base, 'winter_nights.winter_lst_c': codes.map((_, i) => (col(i) > 8 ? 9 : 12)),
            'winter_nights.winter_anomaly_c': codes.map((_, i) => (col(i) > 8 ? -3 : 0)), 'urban_form.res_atomistic_pct': codes.map((_, i) => (col(i) > 9 ? 80 : 10)) });
        const r = L._lenses.coldnights(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^…of them in mostly unplanned/.test(s.label))).toBe(true);
        expect(r.stats.some(s => /^Cold pocket 1: /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/cold pockets 1 °C or more colder still/);
        expect(L._lenses.coldnights(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('hillside: residents and slum residents on steep ground', () => {
        const f = L.frameFrom(codes, { ...base, 'terrain.slope_deg': codes.map((_, i) => (col(i) > 8 ? 16 : 2)), 'slums_mapped.slum_pct': codes.map((_, i) => (col(i) > 9 ? 60 : 0)),
            'landslides.landslides': codes.map((_, i) => (i === codes.length - 1 ? 1 : 0)) });
        const r = L._lenses.hillside(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => s.label === 'Recorded landslides, 1970-2019 (NASA catalog)')).toBe(true);
        expect(r.stats.some(s => /^Hillside to check 1: /.test(s.label))).toBe(true);
        expect(L._lenses.hillside(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('sinking: residents where subsidence is likely', () => {
        const f = L.frameFrom(codes, { ...base, 'subsidence.subsid_prob_pct': codes.map((_, i) => (col(i) > 8 ? 80 : 30)) });
        const r = L._lenses.sinking(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Sinking hotspot 1: /.test(s.label))).toBe(true);
        expect(L._lenses.sinking(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('daytime: magnets and bedroom blocks from ambient vs resident population', () => {
        const f = L.frameFrom(codes, { ...base, 'ambient_pop.ambient_pop': codes.map((_, i) => (col(i) < 4 ? 5000 : 200)) });
        const r = L._lenses.daytime(f, {});
        expect(r.stats[0].label).toBe('Share of daytime people in the busiest 5% of blocks');
        expect(r.stats.some(s => /^Daytime magnet 1: /.test(s.label))).toBe(true);
        expect(L._lenses.daytime(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('publicland: corporation land, vacant plots and plots to put to use', () => {
        const f = L.frameFrom(codes, { ...base, 'public_land.gba_plots': codes.map((_, i) => (i < 3 ? 1 : 0)), 'public_land.gba_land_m2': codes.map((_, i) => (i < 3 ? 500 : 0)),
            'public_land.vacant_plots': codes.map((_, i) => (i === 2 ? 1 : 0)), 'public_land.vacant_m2': codes.map((_, i) => (i === 2 ? 500 : 0)), 'public_care.primary': codes.map(() => 0) });
        const r = L._lenses.publicland(f, {});
        expect(r.stats[1].value).toBe('1 (0.1 ha)');
        expect(r.stats.some(s => /^Vacant plot to put to use 1: /.test(s.label))).toBe(true);
        expect(L._lenses.publicland(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('recycling: residents far from a drop-off centre and next to processing sites', () => {
        const f = L.frameFrom(codes, { ...base, 'waste_recovery.recovery_centres': codes.map((_, i) => (i === 0 ? 1 : 0)), 'waste_recovery.processing_sites': codes.map((_, i) => (i === 5 ? 1 : 0)) });
        const r = L._lenses.recycling(f, {});
        expect(r.stats[0].value).toBe('1');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Residents within about 250 m of a processing site/.test(s.label))).toBe(true);
        expect(r.stats.some(s => /^New drop-off centre 1: /.test(s.label))).toBe(true);
        expect(L._lenses.recycling(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('servicecentres: residents far from a citizen service centre', () => {
        const f = L.frameFrom(codes, { ...base, 'service_centres.csc': codes.map((_, i) => (i === 0 ? 1 : 0)) });
        const r = L._lenses.servicecentres(f, {});
        expect(r.stats[0].value).toBe('1');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^New centre 1: /.test(s.label))).toBe(true);
        expect(L._lenses.servicecentres(L.frameFrom(codes, base), {})).toBeNull();
        const a = L._lenses.servicecentres(L.frameFrom(codes, { ...base, 'service_centres.aadhaar': codes.map((_, i) => (i === 0 ? 2 : 0)) }), {});
        expect(a.stats[0]).toEqual({ label: 'Aadhaar enrolment centres on the map', value: '2' });
    });

    it('tbcare: residents and slum residents far from a TB unit', () => {
        const f = L.frameFrom(codes, { ...base, 'tb_care.tb_units': codes.map((_, i) => (i === 0 ? 1 : 0)), 'slums_mapped.slum_pct': codes.map((_, i) => (col(i) > 8 ? 50 : 0)) });
        const r = L._lenses.tbcare(f, {});
        expect(r.stats[0].value).toBe('1');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^New TB unit 1: /.test(s.label))).toBe(true);
        expect(L._lenses.tbcare(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('raingaugegap: residents far from a rain gauge', () => {
        const f = L.frameFrom(codes, { ...base, 'rain_gauges.rain_gauges': codes.map((_, i) => (i === 0 ? 1 : 0)), 'flood_reports.flood_spots': codes.map((_, i) => (col(i) > 8 ? 2 : 0)) });
        const r = L._lenses.raingaugegap(f, {});
        expect(r.stats[0].value).toBe('1');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^New gauge 1: /.test(s.label))).toBe(true);
        expect(L._lenses.raingaugegap(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('newroads: residents along planned elevated corridors', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'new_roads.newroad_dist_m': two(100, 1500), 'new_roads.newroad_len_m': two(250, 0), 'new_roads.newroad_ref': two(2, 2) });
        f.city = 'bengaluru';
        const r = L._lenses.newroads(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Most residents nearby 1: Yeshwanthapura/.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/Yeshwanthapura–Old Madras Road elevated corridor/);
        expect(L._lenses.newroads(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('hotnights: residents where streets stay hot at night', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'night_heat.night_lst_c': two(27, 23), 'night_heat.night_anomaly_c': two(3, -1), 'demographics.elderly_60plus': two(50, 50), 'pm_heat.pm_lst_c': two(40, 45) });
        const r = L._lenses.hotnights(f, {});
        expect(r.stats.find(s => /hottest-night blocks vs the rest/.test(s.label) && /cooling/i.test(s.label)).value).toBe('13 vs 22 °C');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.metric.value).toBeLessThan(100);
        expect(r.stats.some(s => /^Hot night 1: /.test(s.label))).toBe(true);
        expect(r.headline).toMatch(/aged 60 and over/);
        expect(L._lenses.hotnights(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('stillair: residents where the wind barely reaches the street', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'wind.wind10_ms': two(1.6, 3), 'wind.wind_kept_pct': two(40, 58), 'traffic_noise.pm25_exhaust_g_day': two(50, 5) });
        const r = L._lenses.stillair(f, {});
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats[2].value).toBe('1.6 m/s');
        expect(r.stats.some(s => /^Trapped air 1: /.test(s.label))).toBe(true);
        expect(L._lenses.stillair(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('schooldrift: children where families are leaving government schools', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'schools_udise.govt_share_pct': two(30, 60), 'schools_udise.govt_share_change_pp': two(-8, 6) });
        const r = L._lenses.schooldrift(f, {});
        expect(r.stats[0].value).toBe('2');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.filter(s => /^Leaving /.test(s.label))).toHaveLength(1);
        expect(r.stats.filter(s => /^Returning /.test(s.label))).toHaveLength(1);
        expect(L._lenses.schooldrift(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('schoolstrain: children where government schools are overcrowded', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'schools_udise.pupils_per_teacher': two(42, 25), 'schools_udise.repair_pct': two(12, 2),
            'schools_udise.schools': two(40, 30), 'schools_udise.govt_pct': two(50, 30), 'schools_udise.girls_toilet_pct': two(80, 100) });
        const r = L._lenses.schoolstrain(f, {});
        expect(r.stats[0].value).toBe('2');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^School area 1, around /.test(s.label))).toBe(true);
        expect(r.stats.filter(s => /^School area/.test(s.label))).toHaveLength(1);
        expect(L._lenses.schoolstrain(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('slummap: residents in mapped slum blocks and notified status', () => {
        const f = L.frameFrom(codes, { ...base, 'slums_mapped.slum_pct': codes.map((_, i) => (col(i) < 3 ? 60 : 0)),
            'slums_mapped.slums': codes.map((_, i) => (col(i) < 3 ? 1 : 0)), 'slums_mapped.notified_pct': codes.map((_, i) => (col(i) < 3 ? 0 : NaN)) });
        const r = L._lenses.slummap(f, {});
        expect(r.metric.value).toBeCloseTo(25, 0);
        expect(r.stats[2].label).toMatch(/non-notified/);
        expect(r.stats.some(s => /^Slum block 1: /.test(s.label))).toBe(true);
        expect(L._lenses.slummap(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('turnout: residents by assembly-segment turnout', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 3 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'elections_2024.turnout_pct': two(45, 60), 'elections_2024.nota_pct': two(1.5, 0.8),
            'elections_2024.pc_margin_pct': two(1, 10) });
        const r = L._lenses.turnout(f, {});
        expect(r.stats[0].value).toBe('2');
        expect(r.stats[2].value).toMatch(/\(25%\)/);
        expect(r.stats.find(s => s.label.startsWith('Low turnout 1')).value).toMatch(/^45% turnout, NOTA 1.5%/);
        expect(L._lenses.turnout(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('firereach: distance to the nearest fire station and new-station picks', () => {
        const S = 30, big = block(28.6, 77.2, S), ones = big.map(() => 1000);
        const fire = big.map((_, i) => ([0, 2, S * 2, S * 2 + 2, S + 1].includes(i) ? 1 : 0));
        const r = L._lenses.firereach(L.frameFrom(big, { 'population.population': ones, 'places.fire_stations': fire }), {});
        expect(r.stats[0].value).toBe('5');
        expect(r.columns.fire_km[0]).toBe(0);
        expect(r.columns.fire_km[S * S - 1]).toBeGreaterThan(5);
        expect(r.stats[3].value).not.toMatch(/\(0%\)/);
        expect(r.stats.some(s => /^New station 1: /.test(s.label))).toBe(true);
        const few = big.map((_, i) => (i === 0 ? 1 : 0));
        expect(L._lenses.firereach(L.frameFrom(big, { 'population.population': ones, 'places.fire_stations': few }), {})).toBeNull();
    });

    it('pondcensus: disused and encroached water bodies near residents', () => {
        const at = new Set([0, 3, 6, 9, SIZE * 6, SIZE * 6 + 6]);
        const f = L.frameFrom(codes, { ...base, 'water_bodies.bodies': codes.map((_, i) => (at.has(i) ? 2 : 0)),
            'water_bodies.not_in_use': codes.map((_, i) => (i === 0 ? 2 : i === 3 ? 1 : 0)), 'water_bodies.encroached': codes.map((_, i) => (i === 6 ? 1 : 0)),
            'water_bodies.public_pct': codes.map((_, i) => (at.has(i) ? 100 : NaN)) });
        const r = L._lenses.pondcensus(f, {});
        expect(r.stats[0].value).toBe('12');
        expect(r.stats[1].value).toBe('3 (25%)');
        expect(r.stats[2].value).toBe('1 (8.3%)');
        expect(r.columns.ponds_lost[0]).toBe(2);
        expect(r.metric.value).toBeCloseTo(33.3, 1);
        expect(r.stats.find(s => /^Revive 1: /.test(s.label)).value).toMatch(/^2 of 2/);
        expect(L._lenses.pondcensus(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('wellrisk: public borewells where sewers are missing or thin', () => {
        const wells = codes.map((_, i) => (i % 2 === 0 && i < SIZE * 6 ? 1 : 0));
        const sw = codes.map((_, i) => (col(i) < 6 ? 2000 : 0));
        const f = L.frameFrom(codes, { ...base, 'borewells.borewells': wells, 'sewers.sewer_m': sw, 'osm_roads.road_km_km2': codes.map(() => 10) });
        const r = L._lenses.wellrisk(f, {});
        expect(r.stats[0].value).toBe('36');
        expect(r.columns.well_risk[0]).toBe(0);
        expect(r.columns.well_risk[10]).toBeGreaterThan(0);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(L._lenses.wellrisk(L.frameFrom(codes, { ...base, 'borewells.borewells': wells }), {})).toBeNull();
    });

    it('metrowait: residents near a station and the peak wait', () => {
        const hw = codes.map((_, i) => (i === 0 ? 4 : i === 5 ? 8 : i === 11 ? 6 : NaN)), dep = codes.map((_, i) => ([0, 5, 11].includes(i) ? 30 : NaN));
        const r = L._lenses.metrowait(L.frameFrom(codes, { ...base, 'metro_service.best_headway_min': hw, 'metro_service.peak_departures_hr': dep }), {});
        expect(r.columns.metro_wait_min[0]).toBe(4);
        expect(r.stats[0].value).toBe('3');
        expect(L._lenses.metrowait(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('airmonitorgap: residents far from an air quality station', () => {
        const mon = codes.map((_, i) => (i === 0 ? 1 : 0));
        const r = L._lenses.airmonitorgap(L.frameFrom(codes, { ...base, 'air_monitors.monitors': mon, 'air_monitors.continuous': mon, 'air_quality.pm25_ugm3': codes.map(() => 40) }), {});
        expect(r.columns.monitors_2km[0]).toBe(1);
        expect(r.stats[0].value).toBe('1 (1 continuous)');
        expect(L._lenses.airmonitorgap(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('homeswork: non-residential share and homes far from workplaces', () => {
        const non = codes.map((_, i) => (col(i) === 0 ? 80 : 0)), built = codes.map(() => 40);
        const r = L._lenses.homeswork(L.frameFrom(codes, { ...base, 'built_class.nonres_pct': non, 'built_class.built_pct': built, 'built_class.tall_pct': codes.map(() => 10) }), {});
        expect(r.columns.nonres_pct[0]).toBe(80);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Workplace cluster 1: /.test(s.label))).toBe(true);
        expect(L._lenses.homeswork(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('gwdepth: ward well depth before and after the monsoon', () => {
        const may = codes.map((_, i) => (col(i) < 6 ? 3 : 10)), dec = codes.map(() => 2), chg = codes.map((_, i) => (col(i) < 6 ? -0.5 : 1.5));
        const r = L._lenses.gwdepth(L.frameFrom(codes, { ...base, 'groundwater_local.gw_may_m': may, 'groundwater_local.gw_dec_m': dec, 'groundwater_local.gw_change_m': chg }), {});
        expect(r.columns.gw_may_m[11]).toBe(10);
        expect(r.stats.some(s => /^Deepest ward well 1, at /.test(s.label))).toBe(true);
        expect(r.stats[2].value).toMatch(/%\)$/);
        expect(L._lenses.gwdepth(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('gwprospect: residents by groundwater prospect class', () => {
        const pr = codes.map((_, i) => (col(i) < 6 ? 1 : 4));
        const r = L._lenses.gwprospect(L.frameFrom(codes, { ...base, 'groundwater_local.gw_prospect': pr }), {});
        expect(r.columns.gw_prospect[0]).toBe(1);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Poor prospects, many residents 1: /.test(s.label))).toBe(true);
        expect(L._lenses.gwprospect(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('floodzones: residents in hazard zones and flood return periods', () => {
        const vh = codes.map((_, i) => (col(i) < 3 ? 100 : 0)), r5 = codes.map((_, i) => (col(i) < 2 ? 100 : 0)), r100 = codes.map((_, i) => (col(i) < 6 ? 100 : 0));
        const f = L.frameFrom(codes, { ...base, 'flood_zones.hazard_vhigh_pct': vh, 'flood_zones.hazard_high_pct': codes.map(() => 0), 'flood_zones.rp5_pct': r5, 'flood_zones.rp100_pct': r100,
            'flood_zones.flood_rp_years': codes.map((_, i) => (col(i) < 2 ? 5 : col(i) < 6 ? 100 : NaN)), 'flood_zones.hazard_index': codes.map(() => 2) });
        const r = L._lenses.floodzones(f, {});
        expect(r.columns.flood_chance_pct[0]).toBe(20);
        expect(r.columns.flood_chance_pct[11]).toBe(0);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Floods often 1: /.test(s.label))).toBe(true);
        expect(L._lenses.floodzones(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('landgrain: parcel size, public land and easy assembly', () => {
        const size = codes.map((_, i) => (col(i) < 6 ? 500 : 20000)), cnt = codes.map((_, i) => (col(i) < 6 ? 20 : 1));
        const f = L.frameFrom(codes, { ...base, 'cadastre.parcel_m2': size, 'cadastre.parcels': cnt, 'cadastre.public_pct': codes.map((_, i) => (i === 11 ? 80 : 0)), 'built_up.built_pct': codes.map(() => 10) });
        const r = L._lenses.landgrain(f, {});
        expect(r.columns.parcels_per_ha[0]).toBe(20);
        expect(r.columns.parcels_per_ha[11]).toBe(0.5);
        expect(r.metric.value).toBe(20000);
        expect(r.stats.some(s => /^Easy assembly 1: /.test(s.label))).toBe(true);
        expect(r.stats.some(s => /^Public land 1: /.test(s.label))).toBe(true);
        expect(L._lenses.landgrain(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('wardfit: offices a ward deals with', () => {
        const pw = codes.map((_, i) => (col(i) < 6 ? 2 : 5)), wt = codes.map((_, i) => (col(i) < 6 ? 1 : 3));
        const r = L._lenses.wardfit(L.frameFrom(codes, { ...base, 'service_areas.ward_power_units': pw, 'service_areas.ward_water_units': wt }), {});
        expect(r.columns.ward_offices[11]).toBe(8);
        expect(r.stats.some(s => /^Most split ward 1, at /.test(s.label))).toBe(true);
        expect(L._lenses.wardfit(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('landchange: open land converted between the 2011 and 2017 maps', () => {
        const f11 = codes.map((_, i) => (col(i) < 6 ? 80 : 0)), r11 = codes.map((_, i) => (col(i) < 6 ? 20 : 100));
        const f17 = codes.map((_, i) => (col(i) < 3 ? 80 : 10)), r17 = codes.map((_, i) => (col(i) < 3 ? 20 : 90));
        const r = L._lenses.landchange(L.frameFrom(codes, { ...base, 'landuse_2011.farm_pct': f11, 'landuse_2011.residential_pct': r11, 'landuse_2017.farm_pct': f17, 'landuse_2017.residential_pct': r17 }), {});
        expect(r.columns.converted_pct[0]).toBe(0);
        expect(r.columns.converted_pct[4]).toBe(70);
        expect(r.stats.some(s => /^Most converted 1: /.test(s.label))).toBe(true);
        expect(L._lenses.landchange(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('vacant2017: 2017 vacant land against building since', () => {
        const vac = codes.map((_, i) => (col(i) < 6 ? 60 : 0)), res = codes.map((_, i) => (col(i) < 6 ? 30 : 90)), fresh = codes.map((_, i) => (col(i) < 3 ? 0 : 40));
        const r = L._lenses.vacant2017(L.frameFrom(codes, { ...base, 'landuse_2017.vacant_pct': vac, 'landuse_2017.residential_pct': res, 'building_stock.new_buildings': fresh }), {});
        expect(r.columns.vacant_2017_pct[0]).toBe(60);
        expect(r.stats.some(s => /^Still open since 2017 1: /.test(s.label))).toBe(true);
        expect(L._lenses.vacant2017(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('studenthousing: college pull against listed hostels', () => {
        const uni = codes.map((_, i) => (i === 0 ? 2 : 0)), eng = codes.map((_, i) => (i === 1 ? 1 : 0)), all = codes.map((_, i) => (i === 0 ? 2 : i === 1 ? 1 : 0));
        const r = L._lenses.studenthousing(L.frameFrom(codes, { ...base, 'colleges.colleges': all, 'colleges.university': uni, 'colleges.engineering': eng, 'places.hostels': codes.map(() => 0) }), {});
        expect(r.columns.student_gap[0]).toBeCloseTo(8, 5);
        expect(r.stats.some(s => /^College cluster 1: /.test(s.label))).toBe(true);
        expect(L._lenses.studenthousing(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('watershedpave: built-over share per micro-watershed with ICM classes', () => {
        const mid = codes.map((_, i) => (col(i) < 4 ? 1 : col(i) < 8 ? 2 : 3)), bp = codes.map((_, i) => (col(i) < 4 ? 5 : col(i) < 8 ? 40 : 70));
        const L1 = L.frameFrom(codes, { ...base, 'watersheds.mws_id': mid, 'watersheds.mws_km2': codes.map(() => 0.001), 'built_up.built_pct': bp });
        const r = L._lenses.watershedpave(L1, {});
        expect(r.metric.value).toBeCloseTo(66.7, 1);
        expect(r.columns.mws_built_pct[0]).toBe(5);
        expect(r.stats[0].value).toMatch(/^1 of 3/);
        expect(L._lenses.watershedpave(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('bdalayout: build-out per BDA layout', () => {
        const lid = codes.map((_, i) => (col(i) < 6 ? 63 : 0)), bp = codes.map((_, i) => (col(i) < 3 ? 10 : 30));
        const r = L._lenses.bdalayout(L.frameFrom(codes, { ...base, 'bda_layouts.layout_id': lid, 'built_up.built_pct': bp }), {});
        expect(r.metric.value).toBe(20);
        expect(r.columns.layout_built_pct[0]).toBe(20);
        expect(Number.isNaN(r.columns.layout_built_pct[11])).toBe(true);
        expect(L._lenses.bdalayout(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('revvillage: residents per revenue village', () => {
        const vid = codes.map((_, i) => (col(i) < 4 ? 1 : col(i) < 8 ? 2 : 0)), town = codes.map((_, i) => (col(i) >= 8 ? 1 : 0)), a = codes.map(() => 3);
        const r = L._lenses.revvillage(L.frameFrom(codes, { ...base, 'villages.village_id': vid, 'villages.village_km2': a, 'villages.in_town': town }), {});
        expect(r.stats[0].value).toBe('2');
        expect(Number.isNaN(r.columns.village_people[11])).toBe(true);
        expect(r.stats.some(s => /^Most lived-in village 1, near /.test(s.label))).toBe(true);
        expect(L._lenses.revvillage(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('potholes: complaints per km of street and share fixed', () => {
        const rep = codes.map((_, i) => (col(i) < 6 ? 4 : 0)), fx = codes.map((_, i) => (col(i) < 3 ? 2 : 0)), road = codes.map(() => 10);
        const r = L._lenses.potholes(L.frameFrom(codes, { ...base, 'potholes.reports': rep, 'potholes.fixed': fx, 'osm_roads.road_km_km2': road }), {});
        expect(r.metric.value).toBe(25);
        expect(r.columns.pothole_per_km[0]).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Pothole cluster 1: /.test(s.label))).toBe(true);
        expect(L._lenses.potholes(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('pinsize: residents per pincode', () => {
        const pin = codes.map((_, i) => (col(i) < 6 ? 560001 : 560002)), a = codes.map(() => 4.5);
        const r = L._lenses.pinsize(L.frameFrom(codes, { ...base, 'pincodes.pincode': pin, 'pincodes.pin_km2': a }), {});
        expect(r.stats[0].value).toBe('2');
        expect(r.columns.pin_people[0]).toBeGreaterThanOrEqual(0);
        expect(r.stats.some(s => /^Most crowded pincode 1: 56000[12]/.test(s.label))).toBe(true);
        expect(L._lenses.pinsize(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('sroload: residents per sub-registrar office and distance to it', () => {
        const sid = codes.map((_, i) => (col(i) < 6 ? 101 : 102)), d = codes.map((_, i) => (col(i) === 11 ? 12 : col(i) * 0.5));
        const r = L._lenses.sroload(L.frameFrom(codes, { ...base, 'registration.sro_id': sid, 'registration.sro_km': d }), {});
        expect(r.stats[0].value).toBe('2');
        expect(r.columns.sro_km[11]).toBe(12);
        expect(r.stats.some(s => /^Far from its office 1: /.test(s.label))).toBe(true);
        expect(L._lenses.sroload(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('basics: residents short of two or more mapped networks', () => {
        const sw = codes.map((_, i) => (col(i) < 3 ? 500 : 0)), bins = codes.map((_, i) => (col(i) < 2 ? 1 : 0));
        const r = L._lenses.basics(L.frameFrom(codes, { ...base, 'sewers.sewer_m': sw, 'waste_bins.bins': bins }), {});
        expect(r.columns.basics_missing[0]).toBe(0);
        expect(r.columns.basics_missing[5]).toBe(2);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Most underserved 1: /.test(s.label))).toBe(true);
        expect(L._lenses.basics(L.frameFrom(codes, { ...base, 'sewers.sewer_m': sw }), {})).toBeNull();
    });

    it('stpnear: residents beside sewage treatment plants and capacity against sewage made', () => {
        const st = codes.map((_, i) => (i === 0 ? 1 : 0)), cap = codes.map((_, i) => (i === 0 ? 1 : 0));
        const r = L._lenses.stpnear(L.frameFrom(codes, { ...base, 'stps.stps': st, 'stps.capacity_mld': cap }), {});
        expect(r.columns.stp_near[0]).toBe(2);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Sewage made by /.test(s.label))).toBe(true);
        expect(r.stats.some(s => /^Most hemmed-in plant 1: /.test(s.label))).toBe(true);
        expect(L._lenses.stpnear(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('watergap: residents with no water line nearby, judged inside the corporation', () => {
        const wp = codes.map((_, i) => (col(i) < 3 ? 2000 : 0)), inArea = codes.map((_, i) => (col(i) < 6 ? 1 : 0));
        const f = L.frameFrom(codes, { ...base, 'water_lines.pipe_m': wp, 'water_lines.in_area': inArea, 'osm_roads.road_km_km2': codes.map(() => 10) });
        const r = L._lenses.watergap(f, {});
        expect(r.columns.water_cover_pct[0]).toBeGreaterThan(0);
        expect(r.columns.water_cover_pct[5]).toBe(0);
        expect(Number.isNaN(r.columns.water_cover_pct[7])).toBe(true);
        expect(r.stats.some(s => /^Water line next 1: /.test(s.label))).toBe(true);
        expect(L._lenses.watergap(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('stormgap: few storm drains on wet streets', () => {
        const swd = codes.map((_, i) => (col(i) < 2 ? 5000 : 0)), wl = codes.map((_, i) => (col(i) >= 3 ? 80 : 20));
        const f = L.frameFrom(codes, { ...base, 'storm_drains.swd_m': swd, 'osm_roads.road_km_km2': codes.map(() => 10), 'waterlogging.waterlogging_index': wl });
        const r = L._lenses.stormgap(f, {});
        expect(r.columns.storm_cover_pct[0]).toBe(100);
        expect(r.columns.storm_cover_pct[3]).toBe(0);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Drain next 1: /.test(s.label))).toBe(true);
        expect(L._lenses.stormgap(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('birdlife: rarefied bird richness and unsurveyed blocks', () => {
        const rich = codes.map((_, i) => (col(i) < 6 ? 40 + col(i) : NaN)), rec = codes.map((_, i) => (col(i) < 6 ? 2000 : 5));
        const r = L._lenses.birdlife(L.frameFrom(codes, { ...base, 'birds.records': rec, 'birds.species': rec.map(x => (x > 100 ? 120 : 3)), 'birds.rich200': rich }), {});
        expect(r.columns.bird_rich[0]).toBe(40);
        expect(Number.isNaN(r.columns.bird_rich[11])).toBe(true);
        expect(r.metric.value).toBeGreaterThan(39);
        expect(r.stats.some(s => /^Bird hotspot 1: /.test(s.label))).toBe(true);
        expect(L._lenses.birdlife(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('drainbuffer: building inside storm-water drain buffers', () => {
        const bf = codes.map((_, i) => (col(i) < 2 ? 40 : 0)), built = codes.map(() => 25);
        const r = L._lenses.drainbuffer(L.frameFrom(codes, { ...base, 'built_up.built_pct': built, 'drain_buffers.buffer_pct': bf, 'drain_buffers.buffer_ngt_pct': bf, 'drain_buffers.primary_m': codes.map((_, i) => (col(i) === 0 ? 250 : 0)) }), {});
        expect(r.metric.value).toBe(25);
        expect(r.columns.drain_built[0]).toBe(25);
        expect(r.stats.some(s => /^Most built drain buffer 1: /.test(s.label))).toBe(true);
        expect(L._lenses.drainbuffer(L.frameFrom(codes, { ...base, 'built_up.built_pct': built }), {})).toBeNull();
    });

    it('parkreach: park reach and open spaces to develop', () => {
        const pk = codes.map((_, i) => (col(i) === 0 && i < 5 * SIZE ? 1 : 0)), os = codes.map((_, i) => (col(i) === 8 && i % 2 === 0 ? 1 : 0));
        const r = L._lenses.parkreach(L.frameFrom(codes, { ...base, 'parks_official.parks': pk, 'parks_official.playgrounds': pk.map(() => 0), 'parks_official.open_spaces': os }), {});
        expect(r.columns.park_near[0]).toBe(1);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Open space to develop 1: /.test(s.label))).toBe(true);
        const area = codes.map((_, i) => (col(i) < 4 ? 1 : 0));
        const r3 = L._lenses.parkreach(L.frameFrom(codes, { ...base, 'parks_official.parks': pk, 'parks_official.in_area': area }), {});
        expect(r3.idx.every(i => col(i) < 4)).toBe(true);
        const r2 = L._lenses.parkreach(L.frameFrom(codes, { ...base, 'parks_official.parks': pk }), {});
        expect(r2.stats.some(s => /^New park 1: /.test(s.label))).toBe(true);
        expect(L._lenses.parkreach(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('lakebuffer: building inside the 30 m lake buffer', () => {
        const b30 = codes.map((_, i) => (col(i) === 0 ? 20 : 0)), built = codes.map(() => 50);
        const r = L._lenses.lakebuffer(L.frameFrom(codes, { ...base, 'built_up.built_pct': built, 'lake_buffers.buffer30_pct': b30, 'lake_buffers.buffer75_pct': b30.map(x => 2 * x), 'lake_buffers.lake_pct': codes.map(() => 0) }), {});
        expect(r.metric.value).toBe(50);
        expect(r.columns.buffer_built[0]).toBe(20);
        expect(r.stats.some(s => /^Most built buffer 1: /.test(s.label))).toBe(true);
        expect(L._lenses.lakebuffer(L.frameFrom(codes, { ...base, 'built_up.built_pct': built }), {})).toBeNull();
    });

    it('policereach: distance to police stations, judged inside the mapped area', () => {
        const S = 30, big = block(19.0, 72.85, S), ones = big.map(() => 1000);
        const ps = big.map((_, i) => ([0, 2, S * 2, S * 2 + 2, S + 1].includes(i) ? 1 : 0));
        const r = L._lenses.policereach(L.frameFrom(big, { 'population.population': ones, 'police_official.stations': ps }), {});
        expect(r.stats[0].value).toBe('5');
        expect(r.columns.police_km[0]).toBe(0);
        expect(r.metric.value).toBeGreaterThan(0);
        const area = big.map((_, i) => (Math.floor(i / S) < 4 && i % S < 4 ? 1 : 0));
        const r2 = L._lenses.policereach(L.frameFrom(big, { 'population.population': ones, 'police_official.stations': ps, 'police_official.in_area': area }), {});
        expect(r2.idx.length).toBe(16);
        expect(L._lenses.policereach(L.frameFrom(big, { 'population.population': ones }), {})).toBeNull();
    });

    it('buildlimits: residents inside coastal and eco-sensitive limits', () => {
        const crz = codes.map((_, i) => (col(i) === 0 ? 100 : col(i) === 1 ? 50 : 0));
        const r = L._lenses.buildlimits(L.frameFrom(codes, { ...base, 'eco_limits.crz_pct': crz }), {});
        const pop = base['population.population'], total = pop.reduce((a, b) => a + b, 0);
        const inside = codes.reduce((a, _, i) => a + pop[i] * crz[i] / 100, 0);
        expect(r.metric.value).toBeCloseTo(100 * inside / total, 0);
        expect(r.columns.limit_pct[0]).toBe(100);
        expect(r.stats.some(s => /Coastal Regulation Zone/.test(s.label))).toBe(true);
        expect(L._lenses.buildlimits(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('bigprojects: large projects with environmental clearance nearby', () => {
        const pj = codes.map((_, i) => (col(i) < 2 && i % 3 === 0 ? 1 : 0));
        const f = L.frameFrom(codes, { ...base, 'big_projects.projects': pj, 'big_projects.residential': pj, 'big_projects.commercial': codes.map(() => 0) });
        const r = L._lenses.bigprojects(f, {});
        expect(r.stats[0].value).toBe(String(pj.reduce((a, b) => a + b, 0)));
        expect(r.stats[2].value).toBe('0');
        expect(r.columns.projects_2km.some(v => v > 0)).toBe(true);
        expect(r.stats.some(s => /^Cluster 1: /.test(s.label))).toBe(true);
        expect(L._lenses.bigprojects(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('binreach: residents with no public bin nearby', () => {
        const f = L.frameFrom(codes, { ...base, 'waste_bins.bins': codes.map((_, i) => (col(i) < 3 && i % 2 === 0 ? 2 : 0)) });
        const r = L._lenses.binreach(f, {});
        expect(r.stats[0].value).toBe('48');
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats.some(s => /^Bins needed 1: /.test(s.label))).toBe(true);
        expect(L._lenses.binreach(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('lastrites: distance to cremation and burial grounds', () => {
        const S = 30, big = block(28.6, 77.2, S), ones = big.map(() => 1000);
        const fs = big.map((_, i) => ([0, 2, S * 2, S * 2 + 2, S + 1].includes(i) ? 1 : 0));
        const r = L._lenses.lastrites(L.frameFrom(big, { 'population.population': ones, 'funeral_sites.sites': fs, 'funeral_sites.electric': big.map((_, i) => (i === 0 ? 1 : 0)) }), {});
        expect(r.stats[0].value).toBe('5');
        expect(r.stats[3].value).toBe('1');
        expect(r.columns.funeral_km[0]).toBe(0);
        expect(r.stats.some(s => /^New site 1: /.test(s.label))).toBe(true);
        expect(L._lenses.lastrites(L.frameFrom(big, { 'population.population': ones, 'funeral_sites.sites': big.map((_, i) => (i === 0 ? 1 : 0)) }), {})).toBeNull();
    });

    it('roadplan: planned road widths and new links through homes', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'road_plan.plan_km': two(0.3, 0.2), 'road_plan.wide_km': two(0.3, 0),
            'road_plan.link_km': codes.map((_, i) => (i === 0 ? 0.25 : 0)), 'road_plan.max_width_m': two(30, 12) });
        const r = L._lenses.roadplan(f, {});
        expect(r.columns.planned_width_m[0]).toBe(30);
        expect(r.metric.value).toBe(50);
        expect(r.stats[4].value).toMatch(/^1,000 /);
        expect(r.stats.find(s => /^New link through homes 1: /.test(s.label)).value).toMatch(/^250 m/);
        expect(L._lenses.roadplan(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('treecensus: trees per 100 residents, invasive and single-species blocks', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'tree_census.trees': two(50, 300), 'tree_census.top_share': two(60, 20),
            'tree_census.invasive_pct': two(30, 5), 'tree_census.big_trees': two(1, 10), 'tree_census.poor_pct': two(10, 10) });
        const r = L._lenses.treecensus(f, {});
        expect(r.columns.trees_per_100[0]).toBe(5);
        expect(r.columns.trees_per_100[11]).toBe(30);
        expect(r.metric.value).toBeCloseTo(17.5, 1);
        expect(r.stats[2].value).toMatch(/\(50%\)/);
        expect(r.stats[3].value).toBe('72');
        expect(r.stats[4].value).toBe('72');
        expect(r.stats.some(s => /^Plant here 1: /.test(s.label))).toBe(true);
        expect(L._lenses.treecensus(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('districthealth: residents by NFHS-5 district', () => {
        const two = (a, b) => codes.map((_, i) => (col(i) < 6 ? a : b));
        const f = L.frameFrom(codes, { ...base, 'nfhs.stunted_pct': two(35, 20), 'nfhs.women_anaemia_pct': two(55, 40),
            'nfhs.bp_women_pct': two(20, 30), 'nfhs.bp_men_pct': two(24, 30), 'nfhs.insurance_pct': two(15, 40) });
        const r = L._lenses.districthealth(f, {});
        expect(r.stats[0].value).toBe('2');
        expect(r.stats.filter(s => /^District \d, around /.test(s.label))).toHaveLength(2);
        expect(r.metric.value).toBeCloseTo(27.5, 0);
        expect(L._lenses.districthealth(L.frameFrom(codes, { ...base }), {})).toBeNull();
    });

    it('kilnsmoke: upwind brick-kiln index and residents near kilns', () => {
        const f = L.frameFrom(codes, { ...base, 'brick_kilns.kiln_smoke': codes.map((_, i) => col(i)),
            'brick_kilns.kiln_km': codes.map((_, i) => 1 + col(i)), 'brick_kilns.kilns_10km': codes.map((_, i) => 40 - col(i)) });
        const r = L._lenses.kilnsmoke(f, {});
        expect(r.columns.kiln_smoke[codes.findIndex((_, i) => col(i) === 11)]).toBe(11);
        expect(r.stats[0].value).toBe('40');
        expect(r.stats.some(s => /^Kiln inspection 1: /.test(s.label))).toBe(true);
        expect(L._lenses.kilnsmoke(L.frameFrom(codes, { ...base, 'brick_kilns.kiln_smoke': codes.map(() => 0) }), {})).toBeNull();
    });

    it('dumpsmoke: residents downwind of landfills', () => {
        const f = L.frameFrom(codes, { ...base, 'downwind.landfill_smoke': codes.map((_, i) => (col(i) < 3 ? 5 : 0)),
            'downwind.landfill_upwind': codes.map((_, i) => (col(i) < 3 ? 40 : 0)), 'downwind.industry_smoke': codes.map((_, i) => col(i)) });
        const r = L._lenses.dumpsmoke(f, {});
        expect(r.metric.value).toBeCloseTo(25, 0);
        expect(r.columns.landfill_smoke[codes.findIndex((_, i) => col(i) === 0)]).toBe(5);
        expect(L._lenses.dumpsmoke(L.frameFrom(codes, { ...base, 'downwind.landfill_smoke': codes.map(() => 0) }), {})).toBeNull();
    });

    it('powercuts: blocks dark while the city stays lit', () => {
        const f = L.frameFrom(codes, { ...base, 'blackouts.dark_nights_pct': codes.map((_, i) => (col(i) < 6 ? 12 : 1)) });
        const r = L._lenses.powercuts(f, {});
        expect(r.metric.value).toBeCloseTo(50, 0);
        expect(r.stats[0].value).toBe('6.5%');
        expect(L._lenses.powercuts(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('wildedge: homes next to large forest', () => {
        const f = L.frameFrom(codes, { ...base, 'land_cover.tree_pct': codes.map((_, i) => (col(i) < 6 ? 90 : 10)) });
        const r = L._lenses.wildedge(f, {});
        expect(Array.from(r.columns.forest_edge).filter(x => x === 2).length).toBeGreaterThan(10);
        expect(r.columns.forest_edge[codes.findIndex((_, i) => col(i) === 7)]).toBe(1);
        expect(r.columns.forest_edge[codes.findIndex((_, i) => col(i) === 11)]).toBe(0);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(L._lenses.wildedge(L.frameFrom(codes, { ...base, 'land_cover.tree_pct': codes.map(() => 10) }), {})).toBeNull();
    });

    it('schoolgap: children 5-14 against schools within 1 and 3 km', () => {
        const f = L.frameFrom(codes, { ...base, 'demographics.school_age': codes.map(() => 100),
            'emergency_access.schools': codes.map((_, i) => (col(i) === 0 ? 1 : 0)) });
        const r = L._lenses.schoolgap(f, {});
        expect(r.columns.school_gap[codes.findIndex((_, i) => col(i) === 0)]).toBe(0);
        expect(r.columns.school_gap[codes.findIndex((_, i) => col(i) === 11)]).toBe(1);
        expect(r.metric.value).toBeGreaterThan(0);
        expect(r.stats[1].value).toBe('12');
        expect(L._lenses.schoolgap(L.frameFrom(codes, { ...base, 'demographics.school_age': codes.map(() => 100) }), {})).toBeNull();
    });

    it('railgates: level crossings on main roads in heavy traffic', () => {
        const f = L.frameFrom(codes, { ...base, 'level_crossings.crossings': codes.map((_, i) => (i < 4 ? 1 : 0)),
            'level_crossings.crossings_main': codes.map((_, i) => (i < 2 ? 1 : 0)), 'traffic_load.peak_pcu': codes.map((_, i) => (i === 0 ? 5000 : i)) });
        const r = L._lenses.railgates(f, {});
        expect(r.columns.rail_gate[0]).toBe(3);
        expect(r.columns.rail_gate[1]).toBe(2);
        expect(r.columns.rail_gate[3]).toBe(1);
        expect(r.metric.value).toBe(2);
        expect(L._lenses.railgates(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('views: tower blocks near open water or a big park', () => {
        const f = L.frameFrom(codes, { ...base, 'building_stock.height_2023_m': codes.map(() => 25),
            'water.permanent_water_pct': codes.map((_, i) => (col(i) === 11 ? 80 : 0)), 'parks.park_pct': codes.map(() => 0) });
        const r = L._lenses.views(f, {});
        expect(r.columns.view_kind[codes.findIndex((_, i) => col(i) === 10)]).toBe(2);
        expect(r.columns.view_kind[codes.findIndex((_, i) => col(i) === 0)]).toBe(0);
        expect(L._lenses.views(L.frameFrom(codes, { ...base, 'building_stock.height_2023_m': codes.map(() => 5), 'water.permanent_water_pct': codes.map(() => 0) }), {})).toBeNull();
    });

    it('ground: expansive clay, low wet land, slopes and the seismic zone', () => {
        const clay = codes.map((_, i) => (col(i) < 6 ? 50 : 20));
        const hand = codes.map((_, i) => (i < SIZE * 6 ? 0.5 : 10));
        const f = L.frameFrom(codes, { ...base, 'subsoil.clay_60cm_pct': clay, 'terrain.hand_m': hand, 'terrain.slope_deg': codes.map(() => 2) }, { city: 'delhi' });
        const r = L._lenses.ground(f, {});
        expect(r.headline).toMatch(/^Seismic zone IV\. 50% of the land sits on expansive clay/);
        expect(r.columns.ground_issues[0]).toBe(2);
        expect(r.columns.ground_issues[SIZE * 11 + 11]).toBe(0);
        expect(r.stats.find(x => /swells most/.test(x.label)).value).toBe('25% of land');
        expect(L._lenses.ground(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('burning: frequent fire blocks, residents in the smoke, steady heat sources apart', () => {
        const fd = codes.map((_, i) => (i === 0 ? 5 : i === SIZE * 6 + 6 ? 40 : 0));
        const f = L.frameFrom(codes, { ...base, 'fires.fire_days_yr': fd, 'fires.winter_fire_days_yr': codes.map((_, i) => (i === 0 ? 4 : 0)), 'land_cover.crop_pct': codes.map((_, i) => (i === 0 ? 60 : 0)) }, { city: 'delhi' });
        const r = L._lenses.burning(f, {});
        expect(r.stats[0].value).toBe('1');
        expect(r.headline).toMatch(/80% of those fire days fall in October–February/);
        expect(r.stats.some(x => /Steady heat sources/.test(x.label) && x.value === '1 blocks')).toBe(true);
        expect(r.stats.find(x => /Burning hotspot 1/.test(x.label)).value).toMatch(/crop-residue/);
        expect(L._lenses.burning(L.frameFrom(codes, base), {})).toBeNull();
    });

    it('airtrend: NO₂ change for residents, flat band, PM2.5 trend and SO₂ hotspots', () => {
        const k = v => codes.map(() => v);
        const dn = codes.map((_, i) => (col(i) < 6 ? 20 : -20));
        const f = L.frameFrom(codes, { ...base, 'air_trend.no2_change_pct': dn, 'air_trend.no2_2019': k(50), 'air_trend.no2_latest': k(50),
            'air_trend.pm25_2012': k(80), 'air_trend.pm25_2022': k(60), 'air_trend.so2_umol_m2': codes.map((_, i) => (i === 7 ? 500 : 20)) }, { city: 'delhi' });
        const r = L._lenses.airtrend(f, {});
        expect(r.headline).toMatch(/roughly flat/);
        expect(r.stats[1].value).toMatch(/\(50%\) \/ .*\(50%\)/);
        expect(r.stats.some(x => /PM2\.5/.test(x.label) && /80 → 60/.test(x.value))).toBe(true);
        expect(r.stats.find(x => /SO₂ hotspot 1/.test(x.label)).label).toContain(codes[7]);
        expect(r.stats.some(x => /haze is made of/.test(x.label))).toBe(false);
        const h = L._lenses.airtrend(L.frameFrom(codes, { ...base, 'air_trend.no2_change_pct': dn, 'haze_mix.dust_share_pct': k(27), 'haze_mix.smoke_share_pct': k(22),
            'haze_mix.sulphate_share_pct': k(32), 'haze_mix.seasalt_share_pct': k(1), 'haze_mix.dust_days_yr': k(78) }, { city: 'delhi' }), {});
        expect(h.stats.find(x => /haze is made of/.test(x.label)).value).toBe('dust 27%, smoke 22%, sulphate 32%; the rest is mostly nitrate and ammonium');
        expect(h.stats.find(x => /Dust-haze days/.test(x.label)).value).toBe('78');
        expect(L._lenses.airtrend(L.frameFrom(codes, base), {})).toBeNull();
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
        const t = UrbanLenses.lookalikeText({ fromCity: 'delhi', toCity: 'pune', ref: { code: '39J4M98' }, matches: [{ code: '4FP493F', similarity: 72, people: 1200 }] });
        expect(t).toMatch(/look most like 39J4M98/);
        expect(t).toMatch(/1\. 4FP493F: 72% match/);
        expect(UrbanLenses.lookalikeText(null)).toMatch(/no satellite embedding/);
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
        expect(r.headline).toMatch(/45% of the city's roof area reads dark/);
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

    it('similarEverywhereText(): one best match per city, most similar first', () => {
        const t = RE.similarEverywhereText({ fromCity: 'delhi', ref: { code: '39J4M98' }, matches: [{ city: 'pune', code: '4FP4C73', similarity: 91, differs: [] }, { city: 'mumbai', code: '4FK5CM7', similarity: 84, differs: ['hotter'] }] });
        expect(t.split('\n')[0]).toMatch(/most like 39J4M98/);
        expect(t).toMatch(/2\. .*4FK5CM7: 84% similar; hotter/);
        expect(RE.similarEverywhereText(null)).toMatch(/outside the populated blocks/);
    });

    it('similarText(): reference profile and ranked matches', () => {
        const t = RE.similarText({ fromCity: 'delhi', toCity: 'pune', ref: { code: '39J4M98', profile: [{ label: 'land value', pct: 98 }, { label: 'density', pct: 50 }, { label: 'wealth', pct: 3 }] },
            matches: [{ code: '4FP4C73', similarity: 94, differs: [] }, { code: '4FP493F', similarity: 90, differs: ['more high-rise'] }] });
        expect(t).toMatch(/land value 98th percentile, wealth 3rd percentile, density 50th percentile/);
        expect(t).toMatch(/2\. 4FP493F: 90% similar; more high-rise/);
        expect(RE.similarText(null)).toMatch(/Click a block/);
    });
});
