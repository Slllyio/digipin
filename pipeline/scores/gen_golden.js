/**
 * Golden-fixture generator for the score-model parity tests.
 *
 * For each model it loads the *browser* IIFE module (js/*-score.js) the same way
 * the Vitest suite does, runs it over a fixed set of input cases, and writes the
 * JS output to golden/<model>.json. The Python ports (growth.py, heat.py, ...)
 * must reproduce these exactly — see tests/test_<model>_parity.py.
 *
 * Regenerate after changing any js/*-score.js:  npm run golden:scores
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

// Each model: the browser module + its input cases. `inputs` keys match the
// Python function names; each `call` invokes the JS, each `args` array is one
// positional-argument list the Python parity test replays as fn(*args).
const MODELS = {
  growth: {
    file: 'js/growth-score.js',
    global: 'GrowthScore',
    inputs: (G) => ({
      norm_log: {
        call: (a) => G.normLog(...a),
        args: [[10, 80], [0, 80], [500000000, 500000000], [55, 60], [1, 100], [-3, 80]],
      },
      bue_sub_score: {
        call: (a) => G.bueSubScore(...a),
        args: [
          [{ buildings_temporal: [100, 140], heights: [8, 12], osm_construction_count: 3 }],
          [{ buildings_temporal: [200, 150] }],
          [{ buildings_temporal: [100] }],
          [{ buildings_temporal: [100, 140, 210], heights: [8, 9, 15], osm_construction_count: 10 }],
          [{ buildings_temporal: [0, 50] }],
        ],
      },
      den_sub_score: {
        call: (a) => G.denSubScore(...a),
        args: [
          [{ ghsl_pop_5yr_pct: 12, osm_commercial_density: 80 }],
          [{ ghsl_pop_5yr_pct: -5, osm_commercial_density: 0 }],
          [{ ghsl_pop_5yr_pct: null }],
          [{ ghsl_pop_5yr_pct: 40, osm_commercial_density: 200 }],
        ],
      },
      cap_sub_score: {
        call: (a) => G.capSubScore(...a),
        args: [
          [{ rera_projects: null }],
          [{ rera_projects: [] }],
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
          [{ bue: null, den: null, cap: null }, 'nowcast'],
          [{ bue: 50, den: 50, cap: 50 }, 'year_5'],
        ],
      },
      linear_trend: {
        call: (a) => G.linearTrend(...a),
        args: [[[1, 2, 3, 4, 5]], [[5, 4, 3, 2, 1]], [[3, 3, 3, 3]], [[1, 2]], [[2, 1, 4, 3, 6, 5]]],
      },
      emerging_class: {
        call: (a) => G.emergingClass(...a),
        args: [
          [80, 3], [80, -3], [80, 0], [30, 3], [30, -3], [30, 0], [null, 3],
          [50, 2, { hotLevel: 40, slopeEps: 1 }],
        ],
      },
      confidence_band: {
        call: (a) => G.confidenceBand(...a),
        args: [['nowcast', 0.9], ['year_2', 0.5], ['year_5', 0.9], ['year_5', 0], ['year_5', null]],
      },
    }),
  },

  heat: {
    file: 'js/heat-score.js',
    global: 'HeatScore',
    inputs: (G) => ({
      lst_raw_to_celsius: {
        call: (a) => G.lstRawToCelsius(...a),
        args: [[null], [0], [14000], [15000], [16225]],
      },
      uhi_score: {
        call: (a) => G.uhiScore(...a),
        args: [
          [{ cell_night_lst_c: 24, surrounding_night_lst_c: 22 }],
          [{ cell_night_lst_c: 20, surrounding_night_lst_c: 25 }],   // clamps to 0
          [{ cell_night_lst_c: 30, surrounding_night_lst_c: 22 }],   // clamps to 100
          [{ cell_night_lst_c: null, surrounding_night_lst_c: 22 }], // -> null
        ],
      },
      diurnal_range_c: {
        call: (a) => G.diurnalRangeC(...a),
        args: [
          [{ day_lst_c: 40, night_lst_c: 25 }],
          [{ day_lst_c: null, night_lst_c: 25 }],
        ],
      },
      night_trend: {
        call: (a) => G.nightTrend(...a),
        args: [
          [[20, 20.5, 21, 21.5, 22]],
          [[null, 21, 22, null, 23, 24]],   // nulls dropped, re-indexed
          [[20, 20]],                       // too few valid -> null
          [[22, 22, 22]],                   // flat -> r2 == 1
        ],
      },
    }),
  },
};

const outDir = path.join(__dirname, 'golden');
fs.mkdirSync(outDir, { recursive: true });

for (const [model, spec] of Object.entries(MODELS)) {
  loadGlobal(spec.file, spec.global);
  const G = globalThis[spec.global];
  const inputs = spec.inputs(G);
  const golden = {};
  for (const [name, s] of Object.entries(inputs)) {
    golden[name] = s.args.map((args) => ({ args, out: s.call(args) }));
  }
  const outPath = path.join(outDir, `${model}.json`);
  fs.writeFileSync(outPath, JSON.stringify(golden, null, 2) + '\n');
  console.log(`Wrote ${outPath} (${Object.keys(golden).length} functions)`);
}
