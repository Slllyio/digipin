#!/usr/bin/env node
/**
 * Precompute every lens's headline metric for every city into
 * data/lenses/league.json, so the Lenses tab can rank a city against the
 * other 12 without running 13 cities in the browser.
 *
 *   node scripts/build_lens_league.js
 *
 * Loads the same browser modules the app uses (js/digipin.js, cell-store,
 * urban-insights, urban-lenses) and reads data/cells from disk.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
globalThis.window = globalThis;
globalThis.fetch = async (url) => {
    const f = path.join(ROOT, String(url).split('?')[0]);
    if (!fs.existsSync(f)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(f), { status: 200 });
};
for (const [file, name] of [['js/digipin.js', 'DigiPin'], ['js/analysis.js', 'Analysis'], ['js/cell-store.js', 'CellStore'],
    ['js/urban-insights.js', 'UrbanInsights'], ['js/urban-lenses.js', 'UrbanLenses'], ['js/urban-lenses-mobility.js', 'UrbanLensesMobility'], ['js/urban-lenses-realestate.js', 'UrbanLensesRealEstate'], ['js/urban-lenses-environment.js', 'UrbanLensesEnvironment'], ['js/urban-lenses-planning.js', 'UrbanLensesPlanning']]) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf-8') + `\nif (typeof ${name} !== 'undefined') globalThis.${name} = ${name};`;
    vm.runInThisContext(code, { filename: file });
}

(async () => {
    const S = globalThis.CellStore, L = globalThis.UrbanLenses, U = globalThis.UrbanInsights;
    await S.init();
    const pop = S.get('population');
    const out = { schema: 'digipin.lens-league/1', generated: new Date().toISOString().slice(0, 10), cities: {} };
    for (const r of pop.regions) {
        const t = Date.now();
        const res = await L.run(r.name, S, { hotspots: false });
        const row = { label: U.cityLabel(r.name), residents: res.residents, metrics: {} };
        for (const l of res.lenses) if (l.metric && l.metric.value != null) row.metrics[l.id] = l.metric;
        const summ = path.join(ROOT, 'data/traffic', r.name, 'summary.json');
        const rf = fs.existsSync(summ) && JSON.parse(fs.readFileSync(summ, 'utf-8')).road_flood;
        if (rf && rf.pct_high_or_worse != null) row.metrics.monsoon = { label: 'Arterial km prone to monsoon waterlogging', value: rf.pct_high_or_worse, unit: '%', higherIs: 'worse' };
        out.cities[r.name] = row;
        process.stdout.write(`${r.name}: ${Object.keys(row.metrics).length} metrics, ${Date.now() - t} ms\n`);
    }
    const file = path.join(ROOT, 'data/lenses/league.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
    process.stdout.write(`wrote ${path.relative(ROOT, file)}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
