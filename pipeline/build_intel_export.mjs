/**
 * build_intel_export.mjs — precompute the Intelligence-as-a-Service artifact.
 *
 * Reuses the SAME browser intelligence modules (no duplicated math) by loading the
 * IIFE globals into Node, reads the precomputed score shards, and emits one compact
 * per-region JSON keyed by DigiPin code:
 *
 *   data/intel/<region>/intel.json   { schema, region, level, fields, cells:{ code:{c,ix,ut,pr} } }
 *   data/intel/manifest.json         { regions:[{ name, level, count, path }] }
 *
 * Each cell carries: c=[lng,lat], ix=indices{id:value}, ut=utilities (electricity
 * kWh, water kL, waste kg, solar kWh, supply-stress), pr=priority{goal:value}.
 * This is the fetchable IaaS payload a ULB system can join on the DigiPin cell.
 *
 * Run (from repo root):  node pipeline/build_intel_export.mjs [region]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = process.cwd();

function load(rel, names) {
    let code = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const n of names) code += `\nif (typeof ${n} !== 'undefined') globalThis.${n} = ${n};`;
    vm.runInThisContext(code, { filename: rel });
}
load('js/digipin.js', ['DigiPin']);
load('js/feature-store.js', ['DigiPinIntel']);          // field labels for drivers
load('js/intelligence-indices.js', ['IntelIndices']);
load('js/utility-estimates.js', ['UtilityEstimates']);
load('js/priority-analysis.js', ['PriorityAnalysis']);

function areaKm2(b) {
    const lat = (b.north + b.south) / 2;
    const w = (b.east - b.west) * 111320 * Math.cos(lat * Math.PI / 180);
    const h = (b.north - b.south) * 110540;
    const km2 = (w * h) / 1e6;
    return km2 > 0 ? km2 : undefined;
}

function buildRegion(region, cov) {
    const reg = cov.regions.find(r => r.name === region);
    if (!reg) throw new Error(`region "${region}" not in coverage.json`);
    const fields = cov.fields;
    const cells = {};
    let n = 0;
    for (const prefix of reg.shards) {
        const fp = path.join(ROOT, 'data/scores', region, `${prefix}.json`);
        if (!existsSync(fp)) continue;
        const shard = JSON.parse(readFileSync(fp, 'utf8'));
        for (const [code, values] of Object.entries(shard)) {
            const features = {};
            fields.forEach((f, i) => { features[f] = values[i]; });
            const d = DigiPin.decodePartial(code);
            const u = UtilityEstimates.all(features, { areaKm2: areaKm2(d.bounds) });
            const ix = {};
            for (const ind of Object.values(IntelIndices.all(features))) if (ind && ind.value != null) ix[ind.id] = ind.value;
            const pr = {};
            for (const g of PriorityAnalysis.GOALS) { const r = PriorityAnalysis.compute(features, g); if (r && r.value != null) pr[g] = r.value; }
            cells[code] = {
                c: [+d.lng.toFixed(5), +d.lat.toFixed(5)],
                ix,
                ut: { e: u.electricity.kwhPerDay, w: Math.round(u.water.litresPerDay / 1000), g: u.waste.kgPerDay, s: u.solarRooftop.kwhPerDayPotential, st: u.supplyStress.value },
                pr,
            };
            n++;
        }
    }
    const out = {
        schema: 1, generatedBy: 'DigiPin Urban Intelligence', region, level: reg.level, bbox: reg.bbox,
        fields: { indices: IntelIndices.IDS, priorities: PriorityAnalysis.GOALS, utilities: ['e', 'w', 'g', 's', 'st'] },
        count: n, cells,
    };
    const dir = path.join(ROOT, 'data/intel', region);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'intel.json');
    writeFileSync(file, JSON.stringify(out));
    const kb = Math.round(Buffer.byteLength(JSON.stringify(out)) / 1024);
    console.log(`wrote data/intel/${region}/intel.json — ${n} cells, ${kb} KB`);
    return { name: region, level: reg.level, count: n, bbox: reg.bbox, path: `data/intel/${region}/intel.json` };
}

function main() {
    const cov = JSON.parse(readFileSync(path.join(ROOT, 'data/scores/coverage.json'), 'utf8'));
    const only = process.argv[2];
    const regions = (only ? cov.regions.filter(r => r.name === only) : cov.regions).map(r => r.name);
    const entries = regions.map(r => buildRegion(r, cov));
    const manifest = { schema: 1, generatedBy: 'DigiPin Urban Intelligence', regions: entries };
    mkdirSync(path.join(ROOT, 'data/intel'), { recursive: true });
    writeFileSync(path.join(ROOT, 'data/intel/manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`wrote data/intel/manifest.json — ${entries.length} region(s)`);
}

main();
