/**
 * PropertyReport — a one-click real-estate due-diligence report for any block.
 *
 * build() runs the real-estate lenses on the block's city (js/urban-lenses-realestate.js)
 * and reads one block out of them: land value and what drives it, access, supply and
 * momentum, neighbourhood, risks (flood damage, waterlogging, noise, encroachment),
 * outlook and comparable blocks. html() renders a self-contained printable document
 * (no scripts, no network); text() gives the same as plain text for DISHA and copy.
 *
 *   const m = await PropertyReport.build('delhi', 28.55, 77.20, CellStore);
 *   PropertyReport.open(m);           // new tab → Print → Save as PDF
 */
const PropertyReport = (() => {
    'use strict';
    const SCHEMA = 'digipin.property/1';
    const LENSES = ['landvalue', 'buildhot', 'vacant', 'rentdemand', 'affordability', 'undervalued', 'redevelop', 'nextgrowth', 'housinggap', 'floodloss', 'encroach', 'feasible', 'metroboost', 'climate2050', 'streetheat', 'flood2050', 'solarhome', 'waterrisk', 'climategrade', 'vitality', 'coolroof', 'jobsmap'];
    const EXTRA = ['land_value.prem_jobs_pct', 'land_value.prem_metro_pct', 'land_value.prem_amenity_pct', 'land_value.prem_neigh_pct',
        'land_value.prem_green_pct', 'land_value.prem_risk_pct', 'land_value.prem_noise_pct', 're_supply.far_now', 're_supply.headroom_m2',
        'building_dynamics.settled_year', 'building_dynamics.highrise_pct', 'building_dynamics.nonres_pct', 'building_dynamics.accel',
        'building_dynamics.dw_built_change', 'building_dynamics.height_change_m', 'traffic_noise.lden_db', 'wealth.rwi',
        'air_trend.no2_change_pct', 'air_trend.pm25_2022', 'haze_mix.dust_share_pct', 'haze_mix.smoke_share_pct', 'haze_mix.sulphate_share_pct',
        'haze_mix.dust_days_yr', 'subsoil.clay_60cm_pct', 'flight_paths.under_path', 'flight_paths.path_km',
        'lightning.cg_rate', 'heritage.prohibited_pct', 'heritage.regulated_pct', 'heritage.monument_m', 'power_lines.corridor_pct', 'power_lines.max_kv',
        'power_plants.coal_km', 'power_plants.coal_plume', 'downwind.landfill_upwind', 'blackouts.dark_nights_pct', 'level_crossings.crossings',
        'brick_kilns.kilns_10km', 'brick_kilns.kiln_km', 'nfhs.stunted_pct', 'nfhs.women_anaemia_pct', 'nfhs.bp_men_pct', 'nfhs.bp_women_pct',
        'nfhs.insurance_pct'];
    const DRIVERS = { jobs: 'Job reach', metro: 'Metro walk', amenity: 'Shops and services', neigh: 'Neighbourhood and plot size',
        green: 'Green cover', risk: 'Flood and waterlogging', noise: 'Road noise' };

    const fin = v => typeof v === 'number' && Number.isFinite(v);
    const r1 = (v, d = 0) => (fin(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
    const th = n => { const t = n % 100; return `${n}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`; };
    const rs = v => (!fin(v) ? '–' : v >= 1e7 ? `₹${r1(v / 1e7, 1)} crore` : v >= 1e5 ? `₹${r1(v / 1e5, 1)} lakh` : `₹${Math.round(v).toLocaleString('en-IN')}`);

    /** Percentile (0–100) of values[i] among finite values over idx. */
    function pct(values, idx, i) {
        if (!values || !fin(values[i])) return null;
        let below = 0, n = 0;
        for (const j of idx) { if (!fin(values[j])) continue; n++; if (values[j] < values[i]) below++; }
        return n ? Math.round(100 * below / n) : null;
    }

    /**
     * Pure assembly from per-block values (unit-tested). `v` maps short keys to numbers or null;
     * returns { sections, strengths, risks, verdict }.
     */
    function assemble(v) {
        const row = (label, value, note) => (value == null || value === '' ? null : { label, value: String(value), note: note || '' });
        const sec = (title, rows) => ({ title, rows: rows.filter(Boolean) });
        const drivers = Object.entries(DRIVERS).map(([k, label]) => ({ label, p: v[`prem_${k}`] })).filter(d => fin(d.p) && Math.abs(d.p) >= 0.5)
            .sort((a, b) => Math.abs(b.p) - Math.abs(a.p));
        const sections = [
            sec('Land value', [
                row('Value index (100 = the city\'s median home)', fin(v.value) ? `${r1(v.value)} (${th(v.valuePct)} percentile)` : null),
                row('Circle-rate equivalent', fin(v.rate) ? `${rs(v.rate)} per m²` : null, 'Delhi 2014 categories, rank-matched; a government floor, not a market price'),
                row('What moves it', drivers.length ? drivers.slice(0, 4).map(d => `${d.label} ${d.p > 0 ? '+' : ''}${r1(d.p)}%`).join(', ') : null),
                row('City price trend', fin(v.hpi) ? `${v.hpi > 0 ? '+' : ''}${v.hpi}% a year` : null, v.hpiNote),
            ]),
            sec('Access', [
                row('Job reach', fin(v.jobsPct) ? `${th(v.jobsPct)} percentile in the city` : null),
                row('Jobs within 3 km per resident worker', fin(v.jobRatio) ? `${r1(v.jobRatio, 1)}${v.jobRatio < 0.5 ? ' (a bedroom area: most people commute out)' : v.jobRatio >= 1.5 ? ' (an employment hub)' : ''}` : null, 'estimated from floor space and businesses'),
                row('Walk to metro', fin(v.metro) ? (v.metro > 60 ? 'over an hour' : `${r1(v.metro)} min`) : null),
                row('Upcoming metro station', fin(v.futureWalk) ? `${r1(v.futureWalk)} min walk once it opens, about +${r1(v.metroUp, 1)}% land value` : null, 'Wikidata stations under construction or proposed'),
            ]),
            sec('Supply and momentum', [
                row('Floor area built 2016–2023 (this block)', fin(v.newFloor) ? `${Math.round(v.newFloor).toLocaleString('en-IN')} m²` : null),
                row('Construction pace vs the city', fin(v.accel) ? `${r1(v.accel, 1)}×` : null, '2020–23 pace ÷ 2016–20, relative to the median block'),
                row('Built area change since 2023 (Sentinel-2)', fin(v.dw) ? `${v.dw > 0 ? '+' : ''}${r1(v.dw)} points` : null),
                row('Floor area ratio now / headroom', fin(v.far) ? `${r1(v.far, 1)}${fin(v.headroom) ? ` / ${Math.round(v.headroom).toLocaleString('en-IN')} m² under the base FAR` : ''}` : null),
                row('Vacant buildable land', fin(v.vacant) && v.vacant > 0 ? `${r1(v.vacant, 1)} ha` : null),
                row('Housing need vs pace within 1 km to 2030', fin(v.gap) ? (v.gap > 0 ? `${Math.round(v.gap).toLocaleString('en-IN')} homes short` : `${Math.round(-v.gap).toLocaleString('en-IN')} homes surplus`) : null),
            ]),
            sec('Development feasibility', [
                row('Indicative new-home price here', fin(v.price) ? `${rs(v.price / 10.764)} per sq ft` : null, v.priceNote),
                row(`Residual land value at the base FAR${fin(v.baseFar) ? ` of ${v.baseFar}` : ''}`, fin(v.rlv) ? `${v.rlv < 0 ? '−' : ''}${rs(Math.abs(v.rlv) * 1e3)} per m² of plot` : null, 'sales − build cost − 20% margin; what a developer can pay for land'),
                row('Rebuilding vs selling the existing floors', fin(v.redevGain) && fin(v.far) && v.far >= 0.5 ? `${v.redevGain > 0 ? 'pays, +' : 'does not pay, '}${rs(Math.abs(v.redevGain) * 1e3)} per m² of plot` : null),
                row('Extra value at a metro TOD FAR of 4', fin(v.tod) ? `+${rs(v.tod * 1e3)} per m² of plot` : null),
            ]),
            sec('Energy', [
                row('Rooftop solar per home', fin(v.homeKw) ? (v.homeKw >= 1 ? `${r1(v.homeKw, 1)} kW` : `${r1(v.homeKw, 1)} kW: too little roof per home, look at society or community solar`) : null, 'roof share per household, up to 3 kW'),
                row('Payback after PM Surya Ghar subsidy', fin(v.payback) ? `about ${r1(v.payback, 1)} years at ₹7/kWh` : null),
                row('Roof albedo / dark roofs', fin(v.roofAlb) ? `${r1(v.roofAlb, 2)} / ${Math.round(v.darkRoof ?? 0)}% of roof area` : null, 'share of sunlight roofs reflect; a cool roof reaches 0.65'),
                row('Share of one AC\'s 2050 summer it could cover', fin(v.acCover) ? `${Math.round(v.acCover)}%` : null, 'annual output against use; storage ignored'),
            ]),
            sec('Neighbourhood', [
                row('First settled', fin(v.settled) ? (v.settled <= 1985 ? 'by 1985' : `around ${Math.round(v.settled)}`) : null),
                row('High-rise share / non-residential share', fin(v.highrise) || fin(v.nonres) ? `${r1(v.highrise) ?? '–'}% / ${r1(v.nonres) ?? '–'}%` : null),
                row('Height change 2016→2023', fin(v.dh) ? `${v.dh > 0 ? '+' : ''}${r1(v.dh, 1)} m` : null),
                row('Businesses and services in the block (Overture)', fin(v.places) && v.places > 0 ? `${Math.round(v.places)}: ${Math.round(v.shops ?? 0)} shops, ${Math.round(v.food ?? 0)} eateries, ${Math.round(v.clinics ?? 0)} health, ${Math.round(v.schools ?? 0)} education${fin(v.brandPct) && v.brandPct > 0 ? `; ${Math.round(v.brandPct)}% chains` : ''}` : null, 'listed places only; informal shops under-counted'),
                row('Wealth', fin(v.wealthPct) ? `${th(v.wealthPct)} percentile` : null),
                row('Rental demand vs price', fin(v.yieldGap) ? `${v.yieldGap > 0 ? '+' : ''}${r1(v.yieldGap)} points` : null, 'job-reach rank minus land-value rank; high = strong rent for the price'),
                row('Price-income gap', fin(v.priceGap) ? `${v.priceGap > 0 ? '+' : ''}${r1(v.priceGap)} points` : null, 'land-value rank minus wealth rank; high = displacement pressure'),
            ]),
            sec('Risk', [
                row('Climate 2050 grade', fin(v.cscore) ? `${UrbanLenses.climateGrade ? UrbanLenses.climateGrade(v.cscore) : ''} (${Math.round(v.cscore)}/100; heat, flood and water combined)` : null, 'A lowest risk, E highest'),
                row('Expected flood and waterlogging damage', fin(v.loss) ? `${rs(v.loss * 1e5)} a year (${r1(v.lossPct, 2)}% of building value)` : 'none modelled'),
                row('1-in-100-year floodplain', fin(v.flood) ? `${r1(v.flood)}% of the block` : null),
                row('100-year river or sea flood by 2050 (WRI Aqueduct, 1 km)', fin(v.flood50) ? `${r1(v.flood50)}% of the area${fin(v.flood50now) ? ` (now ${r1(v.flood50now)}%)` : ''}` : null, 'no defences modelled; coarse, reads high'),
                row('Water stress (basin, WRI Aqueduct)', fin(v.wstress) ? `${v.wstress >= 100 ? `${r1(v.wstress / 100, 1)} times renewable supply` : `${Math.round(v.wstress)}% of renewable supply`}${fin(v.wstress50) ? `; ${v.wstress50 >= 100 ? `${r1(v.wstress50 / 100, 1)} times` : `${Math.round(v.wstress50)}%`} by 2050` : ''}` : null, 'city-wide; over 80% is extremely high'),
                row('Humid-heat days (wet-bulb 28 °C or more): now → 2050', fin(v.hum0) && fin(v.hum1) ? `${Math.round(v.hum0)} → ${Math.round(v.hum1)} a year` : null, 'sweat stops cooling the body; city-scale'),
                row('Air: NO₂ since 2019 / PM2.5 2022', fin(v.no2chg) || fin(v.pm22) ? `${fin(v.no2chg) ? `${v.no2chg >= 0 ? '+' : ''}${Math.round(v.no2chg)}%` : '–'} / ${fin(v.pm22) ? `${Math.round(v.pm22)} µg/m³` : '–'}` : null, 'satellite; India\'s annual standard is 40 µg/m³'),
                row('Under a flight path', fin(v.fpath) ? (v.fpath ? `yes, ${fin(v.fpkm) ? `${v.fpkm.toFixed(1)} km from the runway end` : 'within 10 km of a runway end'}` : 'no') : null, 'OpenStreetMap runways; likely overflight, not measured noise'),
                row('Power line corridor', fin(v.pwr) ? (v.pwr > 0 ? `${Math.round(v.pwr)}% of the block inside a ${fin(v.pkv) ? `${Math.round(v.pkv)} kV ` : ''}line's right-of-way: no building under the wires` : 'a high-voltage line crosses the block, outside its right-of-way here') : 'no high-voltage line mapped in the block', 'OpenStreetMap lines; underground lines not shown'),
                row('District health (NFHS-5)', fin(v.stunt) ? `children stunted ${r1(v.stunt, 1)}%${fin(v.anaem) ? `, women anaemic ${r1(v.anaem, 1)}%` : ''}${fin(v.bp) ? `, adults with raised BP ${r1(v.bp, 1)}%` : ''}${fin(v.insured) ? `, households insured ${r1(v.insured, 1)}%` : ''}` : null, 'District averages from the 2019-21 survey, not this block'),
                row('Brick kilns within 10 km', fin(v.kilns) && v.kilns > 0 ? `${v.kilns}${fin(v.kilnkm) ? `; nearest ${r1(v.kilnkm, 1)} km` : ''}` : null, 'IGP brick kiln inventory (Gangetic plain only); kilns fire November to June'),
                row('Nearest coal power plant', fin(v.coalkm) ? `${r1(v.coalkm)} km${fin(v.coalpl) ? `; upwind coal index ${r1(v.coalpl, 1)}` : ''}` : null, 'WRI power plant database; the index weighs MW by how often the wind blows from each plant'),
                row('Landfill upwind', fin(v.fillup) && v.fillup > 0 ? `${Math.round(v.fillup)}% of the wind blows from a mapped landfill within 3 km` : null, 'smoke when it burns, odour most days'),
                row('Night-time power cuts', fin(v.dark) ? `dark on ${r1(v.dark, 1)}% of clear nights while the city stayed lit` : null, 'NASA Black Marble 2023–24, ~1 km; misses evening load-shedding'),
                row('Railway level crossing', fin(v.lcx) && v.lcx > 0 ? `${Math.round(v.lcx)} in the block: gate waits and trains' horns` : null),
                row('Monument limits (ASI)', fin(v.hpro) ? (v.hpro > 0 ? `${Math.round(v.hpro)}% of the block within 100 m of a national monument: no new construction` : v.hreg > 0 ? `${Math.round(v.hreg)}% within 100–300 m: NMA permission and height limits` : `none; nearest national monument ${fin(v.hm) ? `${(v.hm / 1000).toFixed(1)} km` : 'far'} away`) : null, 'Wikidata points, not notified boundaries; confirm with ASI'),
                row('Lightning ground strikes', fin(v.cg) ? `${v.cg.toFixed(1)} per km² a year` : null, 'NASA LIS/OTD 1995–2014, regional scale'),
                row('Haze mix: dust / smoke / sulphate', fin(v.dust) ? `${Math.round(v.dust)}% / ${Math.round(v.smoke)}% / ${Math.round(v.sulph)}%${fin(v.dustd) ? `; ${Math.round(v.dustd)} dust-haze days a year` : ''}` : null, 'CAMS model, city scale'),
                row('Ground: clay at 60 cm / seismic zone', fin(v.clay60) || v.zone ? `${fin(v.clay60) ? `${Math.round(v.clay60)}%${v.clay60 >= 40 ? ' (expansive black cotton soil: deeper or piled footings)' : ''}` : '–'} / ${v.zone ? `zone ${v.zone}` : '–'}` : null, 'model soil map; get a soil test'),
                row('Groundwater table', fin(v.gwd) && v.gwd > 0 ? `falling about ${r1(v.gwd, 1)} cm a year (1990–2014 trend)` : null, 'borewells go deeper'),
                row('Waterlogging index', fin(v.wlog) ? `${r1(v.wlog)} / 100` : null),
                row('Road noise', fin(v.noise) ? `${r1(v.noise)} dB Lden` : null),
                row('Days at 40 °C or more a year: now → 2050', fin(v.hot0) && fin(v.hot1) ? `${r1(v.hot0)} → ${r1(v.hot1)}${fin(v.hot2) ? ` (${r1(v.hot2)} on the high-emissions path)` : ''}` : null, 'six-model CMIP6 ensemble, SSP2-4.5; city-scale, misses the heat island'),
                row('… with this block\'s own heat island', fin(v.hotBlock) ? `${r1(v.hotBlock)} days at 40 °C by 2050 (air ${v.islandC >= 0 ? '+' : ''}${r1(v.islandC, 1)} °C vs the city average by day)` : null),
                row('Cooling need by 2050', fin(v.cddBlock) ? `${Math.round(v.cddBlock)} degree-days above 24 °C${fin(v.cdd0) ? ` (now ${Math.round(v.cdd0)})` : ''}` : null, 'drives air-conditioning hours and power bills'),
                row('Nights at 28 °C or more a year: now → 2050', fin(v.warm0) && fin(v.warm1) ? `${r1(v.warm0)} → ${r1(v.warm1)}` : null),
                row('Wettest day of the year by 2050', fin(v.rx) ? `${v.rx >= 0 ? '+' : ''}${r1(v.rx)}%` : null),
                row('Encroachment flags', fin(v.encroach) && v.encroach > 0 ? `score ${r1(v.encroach, 1)}` : null, 'former water, floodplain or tree loss built up'),
            ]),
            sec('Outlook', [
                row('Undervalued for its access', fin(v.upside) ? `${v.upside > 0 ? '+' : ''}${r1(v.upside)} points` : null, 'access rank minus value rank plus momentum'),
                row('Growth signal (2030 projection + recent building)', fin(v.growth) ? `${r1(v.growth, 1)} points` : null),
            ]),
        ].filter(s => s.rows.length);
        const strengths = [], risks = [];
        if (fin(v.valuePct) && v.valuePct >= 80) strengths.push('top-fifth land value');
        if (fin(v.jobsPct) && v.jobsPct >= 70) strengths.push('strong job reach');
        if (fin(v.metro) && v.metro <= 10) strengths.push('metro within a 10-minute walk');
        else if (fin(v.futureWalk) && v.futureWalk <= 10) strengths.push('a metro station coming within a 10-minute walk');
        if (fin(v.places) && v.places >= 50) strengths.push('a busy commercial block');
        if (fin(v.upside) && v.upside >= 25) strengths.push('priced below its access');
        if (fin(v.yieldGap) && v.yieldGap >= 30) strengths.push('rental demand high for the price');
        if (fin(v.accel) && v.accel >= 1.5) strengths.push('building speeding up');
        if (fin(v.homeKw) && v.homeKw >= 2 && fin(v.payback) && v.payback <= 5) strengths.push('room for rooftop solar that pays back within 5 years');
        if (fin(v.redevGain) && v.redevGain > 0 && fin(v.far) && v.far >= 0.5) strengths.push('rebuilding to the base FAR pays');
        if (fin(v.lossPct) && v.lossPct >= 0.5) risks.push(`flood damage ≈ ${r1(v.lossPct, 1)}% of building value a year`);
        else if (fin(v.flood) && v.flood >= 30) risks.push('in the 1-in-100-year floodplain');
        if (fin(v.wlog) && v.wlog >= 65) risks.push('very high waterlogging');
        if (fin(v.noise) && v.noise >= 70) risks.push('loud road noise');
        if (fin(v.encroach) && v.encroach >= 2) risks.push('encroachment flags');
        if (fin(v.fillup) && v.fillup >= 30) risks.push('downwind of a landfill');
        if (fin(v.dark) && v.dark >= 5) risks.push('frequent night power cuts');
        if (fin(v.coalkm) && v.coalkm <= 10) risks.push('a coal power plant within 10 km');
        if (fin(v.kilnkm) && v.kilnkm <= 3) risks.push('a brick kiln within 3 km');
        if (fin(v.hotBlock ?? v.hot1) && (v.hotBlock ?? v.hot1) >= 45) risks.push(`about ${Math.round(v.hotBlock ?? v.hot1)} days a year at 40 °C by 2050`);
        if (fin(v.cscore) && v.cscore >= 50) risks.push(`climate 2050 grade ${UrbanLenses.climateGrade ? UrbanLenses.climateGrade(v.cscore) : 'D or E'}`);
        if (fin(v.gwd) && v.gwd >= 10) risks.push('groundwater falling fast');
        if (fin(v.clay60) && v.clay60 >= 40) risks.push('expansive clay: budget for a soil test and deeper footings');
        if (fin(v.darkRoof) && v.darkRoof >= 60) risks.push('mostly dark roofs: a cool-roof coating would cool top floors');
        if (fin(v.priceGap) && v.priceGap >= 50) risks.push('displacement pressure');
        if (fin(v.gap) && v.gap < -2000) risks.push('local oversupply');
        const verdict = `${strengths.length ? `Strengths: ${strengths.join(', ')}.` : 'No standout strengths.'} ${risks.length ? `Watch: ${risks.join(', ')}.` : 'No major risk flags.'}`;
        return { sections, strengths, risks, verdict };
    }

    async function build(city, lat, lng, store) {
        if (typeof UrbanLenses === 'undefined') throw new Error('The lenses module did not load.');
        const code = DigiPin.encode(lat, lng).replace(/-/g, '').slice(0, 7);
        const fr = await UrbanLenses.frame(city, store, [...new Set([...UrbanLenses.allNeeds(LENSES), ...EXTRA])]);
        const g = fr.grid, c = fr.cols, i = g.codes.indexOf(code);
        if (i < 0) throw new Error(`${DigiPin.format(code)} is outside the populated blocks of ${UrbanInsights.cityLabel(city)}.`);
        const idx = [];
        for (let j = 0; j < g.n; j++) idx.push(j);
        const out = {};
        for (const id of LENSES) {
            try { out[id] = UrbanLenses._lenses[id](fr, {}); } catch { out[id] = null; }
        }
        const col = (id, key) => (out[id] && out[id].columns[key] ? out[id].columns[key][i] : null);
        const at = k => (c[k] && fin(c[k][i]) ? c[k][i] : null);
        const vi = at('land_value.value_index');
        const anchor = await fetch(`data/realestate/${city}.json`).then(x => (x.ok ? x.json() : null)).catch(() => null);
        const a = anchor && anchor.anchor;
        const v = {
            value: vi, valuePct: pct(c['land_value.value_index'], idx, i), rate: UrbanLenses.landRate ? UrbanLenses.landRate(city, vi) : null,
            hpi: a ? a.hpi_yoy_pct : null, hpiNote: a ? `NHB RESIDEX ${a.period}${a.scope === 'city' ? '' : ' (50-city composite)'}` : '',
            jobsPct: pct(c['job_access.jobs_car_pct'], idx, i), jobRatio: col('jobsmap', 'jobs_per_worker_3km'), metro: at('rail_access.metro_walk_min'),
            newFloor: at('re_supply.new_floor_m2'), accel: at('building_dynamics.accel'), dw: at('building_dynamics.dw_built_change'),
            far: at('re_supply.far_now'), headroom: at('re_supply.headroom_m2'), vacant: at('re_supply.vacant_ha'), gap: col('housinggap', 'housing_gap'),
            settled: at('building_dynamics.settled_year'), highrise: at('building_dynamics.highrise_pct'), nonres: at('building_dynamics.nonres_pct'),
            dh: at('building_dynamics.height_change_m'), wealthPct: pct(c['wealth.rwi'], idx, i),
            yieldGap: col('rentdemand', 'yield_gap'), priceGap: col('affordability', 'price_income_gap'),
            loss: col('floodloss', 'flood_loss'), lossPct: col('floodloss', 'flood_loss_pct'), flood: at('water.flood_rp100_pct'),
            wlog: at('waterlogging.waterlogging_index'), noise: at('traffic_noise.lden_db'), encroach: col('encroach', 'encroach_score'),
            upside: col('undervalued', 'upside'), growth: col('nextgrowth', 'growth_score'),
            hot0: at('climate_future.hot_days_now'), hot1: at('climate_future.hot_days_2050'), hot2: at('climate_future.hot_days_2050_high'),
            places: at('places.places'), shops: at('places.shopping'), food: at('places.food'), clinics: at('places.health'), schools: at('places.education'), brandPct: at('places.branded_pct'),
            cscore: col('climategrade', 'climate_score'),
            wstress: at('water_risk.water_stress_pct'), wstress50: at('water_risk.water_stress_2050_pct'), gwd: at('water_risk.groundwater_decline_cm_yr'),
            homeKw: col('solarhome', 'home_kwp'), payback: col('solarhome', 'payback_yr'), acCover: col('solarhome', 'ac_2050_covered_pct'),
            clay60: at('subsoil.clay_60cm_pct'), zone: UrbanLenses.SEISMIC_ZONE ? UrbanLenses.SEISMIC_ZONE[city] : null,
            hum0: at('humid_future.humid_days_now'), hum1: at('humid_future.humid_days_2050'), no2chg: at('air_trend.no2_change_pct'), pm22: at('air_trend.pm25_2022'),
            kilns: at('brick_kilns.kilns_10km'), stunt: at('nfhs.stunted_pct'), anaem: at('nfhs.women_anaemia_pct'), insured: at('nfhs.insurance_pct'),
            bp: fin(at('nfhs.bp_men_pct')) && fin(at('nfhs.bp_women_pct')) ? (at('nfhs.bp_men_pct') + at('nfhs.bp_women_pct')) / 2 : null, kilnkm: at('brick_kilns.kiln_km'), fpath: at('flight_paths.under_path'), fpkm: at('flight_paths.path_km'), dust: at('haze_mix.dust_share_pct'), smoke: at('haze_mix.smoke_share_pct'), sulph: at('haze_mix.sulphate_share_pct'), dustd: at('haze_mix.dust_days_yr'), cg: at('lightning.cg_rate'), hpro: at('heritage.prohibited_pct'), hreg: at('heritage.regulated_pct'), hm: at('heritage.monument_m'), pwr: at('power_lines.corridor_pct'), pkv: at('power_lines.max_kv'), coalkm: at('power_plants.coal_km'), coalpl: at('power_plants.coal_plume'), fillup: at('downwind.landfill_upwind'), dark: at('blackouts.dark_nights_pct'), lcx: at('level_crossings.crossings'),
            roofAlb: at('roofs.roof_albedo'), darkRoof: at('roofs.dark_roof_pct'),
            flood50: at('flood_future.any_pct_2050'), flood50now: at('flood_future.any_pct_now'),
            hotBlock: col('streetheat', 'hot_2050_block'), cddBlock: col('streetheat', 'cdd_2050_block'), islandC: col('streetheat', 'heat_island_air_c'), cdd0: at('climate_future.cdd_now'),
            warm0: at('climate_future.warm_nights_now'), warm1: at('climate_future.warm_nights_2050'), rx: at('climate_future.wettest_day_change_pct'),
            futureWalk: at('metro_future.future_walk_min'), metroUp: at('metro_future.value_uplift_pct'),
            rlv: col('feasible', 'rlv'), redevGain: col('feasible', 'redev_gain'), tod: col('feasible', 'tod_uplift'),
            price: UrbanLenses.blockPrice ? UrbanLenses.blockPrice(city, vi) : null, baseFar: UrbanLenses.RE_BASE_FAR ? UrbanLenses.RE_BASE_FAR[city] : null,
            priceNote: 'city-average price (ANAROCK Q3 2025, rough for smaller cities) × value index',
        };
        for (const k of Object.keys(DRIVERS)) v[`prem_${k}`] = at(`land_value.prem_${k}_pct`);
        let comps = null;
        try { comps = UrbanLenses.similar ? await UrbanLenses.similar({ fromCity: city, lat, lng, k: 3 }, store) : null; } catch { comps = null; }
        const model = assemble(v);
        let where = null;
        try { where = UrbanLenses.places ? (await UrbanLenses.places(city, store)).get(code) || null : null; } catch { where = null; }
        const place = where ? [where.label, where.pin ? `PIN ${where.pin}` : '', where.ward ? `${where.body ? `${where.body} ` : ''}ward ${where.ward}` : '',
            where.assembly ? `${where.assembly} assembly${where.lokSabha ? `, ${where.lokSabha} Lok Sabha` : ''}` : ''].filter(Boolean).join(' · ') || null : null;
        return { schema: SCHEMA, code, city, place, cityLabel: UrbanInsights.cityLabel(city), generatedAt: new Date().toISOString().slice(0, 10),
            ...model, comparables: comps ? comps.matches : [], sources: (fr.sources || []).map(s => s.title || s.id) };
    }

    function text(m) {
        const lines = [`Property report · ${DigiPin.format(m.code)}${m.place ? ` · ${m.place}` : ''} · ${m.cityLabel} (${m.generatedAt})`, m.verdict];
        for (const s of m.sections) {
            lines.push('', s.title);
            for (const r of s.rows) lines.push(`- ${r.label}: ${r.value}${r.note ? ` (${r.note})` : ''}`);
        }
        if (m.comparables.length) lines.push('', `Comparable blocks: ${m.comparables.map(x => `${x.code} (${x.similarity}% similar)`).join(', ')}`);
        lines.push('', 'Indicative screen from open satellite and map data; not a valuation. Check title, zoning and a local valuer before buying.');
        return lines.join('\n');
    }

    const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function html(m) {
        const secs = m.sections.map(s => `<h2>${esc(s.title)}</h2><table>${s.rows.map(r => `<tr><th>${esc(r.label)}</th><td>${esc(r.value)}${r.note ? `<div class="n">${esc(r.note)}</div>` : ''}</td></tr>`).join('')}</table>`).join('');
        const comps = m.comparables.length ? `<h2>Comparable blocks</h2><ul>${m.comparables.map(x => `<li>${esc(x.code)}: ${x.similarity}% similar${x.differs.length ? `; ${esc(x.differs.join(', '))}` : ''}</li>`).join('')}</ul>` : '';
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Property report ${esc(DigiPin.format(m.code))}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fff;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px}
.sub{color:#666}.v{background:#f4f6f8;border-radius:8px;padding:10px 12px;margin:14px 0}table{width:100%;border-collapse:collapse}th{text-align:left;font-weight:500;color:#444;width:45%;padding:4px 8px 4px 0;vertical-align:top}td{padding:4px 0}.n{color:#777;font-size:12px}.f{color:#777;font-size:12px;margin-top:24px}@media print{body{margin:0}}</style></head>
<body><h1>Property report · ${esc(DigiPin.format(m.code))}</h1><div class="sub">${m.place ? `${esc(m.place)} · ` : ''}${esc(m.cityLabel)} · ${esc(m.generatedAt)}</div><div class="v">${esc(m.verdict)}</div>${secs}${comps}
<div class="f">Indicative screen from open satellite and map data (${esc(m.sources.slice(0, 12).join('; '))}); not a valuation. Check title, zoning and a local valuer before buying. Generated by DigiPin.</div></body></html>`;
    }

    function open(m) {
        const url = URL.createObjectURL(new Blob([html(m)], { type: 'text/html' }));
        const w = window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return !!w;
    }

    return { SCHEMA, LENSES, assemble, build, text, html, open, pct };
})();

if (typeof window !== 'undefined') {
    window.PropertyReport = PropertyReport;
}
