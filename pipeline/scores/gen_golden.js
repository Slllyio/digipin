/**
 * Golden-fixture generator for the GrowthScore parity test.
 *
 * Loads the *browser* IIFE module (js/growth-score.js) the same way the Vitest
 * suite does, runs it over a fixed set of input cases, and writes the JS output
 * to golden/growth.json. The Python port (growth.py) must reproduce these
 * exactly — see tests/test_growth_parity.py.
 *
 * Regenerate after changing js/growth-score.js:  npm run golden:scores
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');

function loadGlobal(relPath, name) {
  let code = fs.readFileSync(path.join(root, relPath), 'utf-8');
  code += `\nif (typeof ${name} !== 'undefined') globalThis.${name} = ${name};`;
  vm.runInThisContext(code, { filename: relPath });
}

loadGlobal('js/growth-score.js', 'GrowthScore');
const G = globalThis.GrowthScore;

// Each entry: a list of positional-argument arrays. The matching Python
// function (same key) is called as fn(*args) by the parity test.
const inputs = {
  norm_log: {
    call: (a) => G.normLog(...a),
    args: [[10, 80], [0, 80], [500000000, 500000000], [55, 60], [1, 100], [-3, 80]],
  },
  bue_sub_score: {
    call: (a) => G.bueSubScore(...a),
    args: [
      [{ buildings_temporal: [100, 140], heights: [8, 12], osm_construction_count: 3 }],
      [{ buildings_temporal: [200, 150] }],                       // falling, no heights
      [{ buildings_temporal: [100] }],                            // too short -> null
      [{ buildings_temporal: [100, 140, 210], heights: [8, 9, 15], osm_construction_count: 10 }], // osm cap
      [{ buildings_temporal: [0, 50] }],                          // prev == 0 -> yoy 0
    ],
  },
  den_sub_score: {
    call: (a) => G.denSubScore(...a),
    args: [
      [{ ghsl_pop_5yr_pct: 12, osm_commercial_density: 80 }],
      [{ ghsl_pop_5yr_pct: -5, osm_commercial_density: 0 }],
      [{ ghsl_pop_5yr_pct: null }],                               // -> null
      [{ ghsl_pop_5yr_pct: 40, osm_commercial_density: 200 }],    // comm cap
    ],
  },
  cap_sub_score: {
    call: (a) => G.capSubScore(...a),
    args: [
      [{ rera_projects: null }],                                  // -> null
      [{ rera_projects: [] }],                                    // -> 0
      [{ rera_projects: [{ value: 1e8, age_yrs: 1, distance_km: 0.5 }, { value: 5e7, age_yrs: 3, distance_km: 2 }] }],
      [{ rera_projects: [{ value: 2e9, age_yrs: 0, distance_km: 0 }] }],
    ],
  },
  composite: {
    call: (a) => G.composite(...a),
    args: [
      [{ bue: 80, den: 60, cap: 40 }, 'nowcast'],
      [{ bue: null, den: 60, cap: 40 }, 'year_2'],
      [{ bue: 70, den: null, cap: null }, 'nowcast'],
      [{ bue: null, den: null, cap: null }, 'nowcast'],           // -> null
      [{ bue: 50, den: 50, cap: 50 }, 'year_5'],
    ],
  },
  linear_trend: {
    call: (a) => G.linearTrend(...a),
    args: [
      [[1, 2, 3, 4, 5]],
      [[5, 4, 3, 2, 1]],
      [[3, 3, 3, 3]],
      [[1, 2]],                                                   // -> null
      [[2, 1, 4, 3, 6, 5]],
    ],
  },
  emerging_class: {
    call: (a) => G.emergingClass(...a),
    args: [
      [80, 3], [80, -3], [80, 0],
      [30, 3], [30, -3], [30, 0],
      [null, 3],
      [50, 2, { hotLevel: 40, slopeEps: 1 }],
    ],
  },
  confidence_band: {
    call: (a) => G.confidenceBand(...a),
    args: [
      ['nowcast', 0.9], ['year_2', 0.5],
      ['year_5', 0.9], ['year_5', 0], ['year_5', null],
    ],
  },
};

const golden = {};
for (const [name, spec] of Object.entries(inputs)) {
  golden[name] = spec.args.map((args) => ({ args, out: spec.call(args) }));
}

const outDir = path.join(__dirname, 'golden');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'growth.json');
fs.writeFileSync(outPath, JSON.stringify(golden, null, 2) + '\n');
console.log(`Wrote ${outPath} (${Object.keys(golden).length} functions)`);
