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
    const LENSES = ['landvalue', 'buildhot', 'vacant', 'rentdemand', 'affordability', 'undervalued', 'redevelop', 'nextgrowth', 'housinggap', 'floodloss', 'encroach', 'feasible', 'metroboost', 'climate2050'];
    const EXTRA = ['land_value.prem_jobs_pct', 'land_value.prem_metro_pct', 'land_value.prem_amenity_pct', 'land_value.prem_neigh_pct',
        'land_value.prem_green_pct', 'land_value.prem_risk_pct', 'land_value.prem_noise_pct', 're_supply.far_now', 're_supply.headroom_m2',
        'building_dynamics.settled_year', 'building_dynamics.highrise_pct', 'building_dynamics.nonres_pct', 'building_dynamics.accel',
        'building_dynamics.dw_built_change', 'building_dynamics.height_change_m', 'traffic_noise.lden_db', 'wealth.rwi'];
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
            sec('Neighbourhood', [
                row('First settled', fin(v.settled) ? (v.settled <= 1985 ? 'by 1985' : `around ${Math.round(v.settled)}`) : null),
                row('High-rise share / non-residential share', fin(v.highrise) || fin(v.nonres) ? `${r1(v.highrise) ?? '–'}% / ${r1(v.nonres) ?? '–'}%` : null),
                row('Height change 2016→2023', fin(v.dh) ? `${v.dh > 0 ? '+' : ''}${r1(v.dh, 1)} m` : null),
                row('Wealth', fin(v.wealthPct) ? `${th(v.wealthPct)} percentile` : null),
                row('Rental demand vs price', fin(v.yieldGap) ? `${v.yieldGap > 0 ? '+' : ''}${r1(v.yieldGap)} points` : null, 'job-reach rank minus land-value rank; high = strong rent for the price'),
                row('Price-income gap', fin(v.priceGap) ? `${v.priceGap > 0 ? '+' : ''}${r1(v.priceGap)} points` : null, 'land-value rank minus wealth rank; high = displacement pressure'),
            ]),
            sec('Risk', [
                row('Expected flood and waterlogging damage', fin(v.loss) ? `${rs(v.loss * 1e5)} a year (${r1(v.lossPct, 2)}% of building value)` : 'none modelled'),
                row('1-in-100-year floodplain', fin(v.flood) ? `${r1(v.flood)}% of the block` : null),
                row('Waterlogging index', fin(v.wlog) ? `${r1(v.wlog)} / 100` : null),
                row('Road noise', fin(v.noise) ? `${r1(v.noise)} dB Lden` : null),
                row('Days at 40 °C or more a year: now → 2050', fin(v.hot0) && fin(v.hot1) ? `${r1(v.hot0)} → ${r1(v.hot1)}${fin(v.hot2) ? ` (${r1(v.hot2)} on the high-emissions path)` : ''}` : null, 'six-model CMIP6 ensemble, SSP2-4.5; city-scale, misses the heat island'),
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
        if (fin(v.upside) && v.upside >= 25) strengths.push('priced below its access');
        if (fin(v.yieldGap) && v.yieldGap >= 30) strengths.push('rental demand high for the price');
        if (fin(v.accel) && v.accel >= 1.5) strengths.push('building speeding up');
        if (fin(v.redevGain) && v.redevGain > 0 && fin(v.far) && v.far >= 0.5) strengths.push('rebuilding to the base FAR pays');
        if (fin(v.lossPct) && v.lossPct >= 0.5) risks.push(`flood damage ≈ ${r1(v.lossPct, 1)}% of building value a year`);
        else if (fin(v.flood) && v.flood >= 30) risks.push('in the 1-in-100-year floodplain');
        if (fin(v.wlog) && v.wlog >= 65) risks.push('very high waterlogging');
        if (fin(v.noise) && v.noise >= 70) risks.push('loud road noise');
        if (fin(v.encroach) && v.encroach >= 2) risks.push('encroachment flags');
        if (fin(v.hot1) && v.hot1 >= 45) risks.push(`about ${Math.round(v.hot1)} days a year at 40 °C by 2050`);
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
            jobsPct: pct(c['job_access.jobs_car_pct'], idx, i), metro: at('rail_access.metro_walk_min'),
            newFloor: at('re_supply.new_floor_m2'), accel: at('building_dynamics.accel'), dw: at('building_dynamics.dw_built_change'),
            far: at('re_supply.far_now'), headroom: at('re_supply.headroom_m2'), vacant: at('re_supply.vacant_ha'), gap: col('housinggap', 'housing_gap'),
            settled: at('building_dynamics.settled_year'), highrise: at('building_dynamics.highrise_pct'), nonres: at('building_dynamics.nonres_pct'),
            dh: at('building_dynamics.height_change_m'), wealthPct: pct(c['wealth.rwi'], idx, i),
            yieldGap: col('rentdemand', 'yield_gap'), priceGap: col('affordability', 'price_income_gap'),
            loss: col('floodloss', 'flood_loss'), lossPct: col('floodloss', 'flood_loss_pct'), flood: at('water.flood_rp100_pct'),
            wlog: at('waterlogging.waterlogging_index'), noise: at('traffic_noise.lden_db'), encroach: col('encroach', 'encroach_score'),
            upside: col('undervalued', 'upside'), growth: col('nextgrowth', 'growth_score'),
            hot0: at('climate_future.hot_days_now'), hot1: at('climate_future.hot_days_2050'), hot2: at('climate_future.hot_days_2050_high'),
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
        return { schema: SCHEMA, code, city, cityLabel: UrbanInsights.cityLabel(city), generatedAt: new Date().toISOString().slice(0, 10),
            ...model, comparables: comps ? comps.matches : [], sources: (fr.sources || []).map(s => s.title || s.id) };
    }

    function text(m) {
        const lines = [`Property report · ${DigiPin.format(m.code)} · ${m.cityLabel} (${m.generatedAt})`, m.verdict];
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
<body><h1>Property report · ${esc(DigiPin.format(m.code))}</h1><div class="sub">${esc(m.cityLabel)} · ${esc(m.generatedAt)}</div><div class="v">${esc(m.verdict)}</div>${secs}${comps}
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
