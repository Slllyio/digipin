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

// `const X = (() => {...})()` modules can only be evaluated once in a shared
// context (a second eval redeclares the const), so loading is idempotent —
// e.g. js/digipin.js is both the composite model's dep and its own model.
const loaded = new Set();

function loadGlobal(relPath, name) {
  if (loaded.has(relPath)) return;
  loaded.add(relPath);
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

  composite: {
    file: 'js/data-fetcher.js',
    global: 'DataFetcher',
    deps: [['js/digipin.js', 'DigiPin']],   // data-fetcher.js is loaded after digipin.js in index.html
    inputs: (G) => {
      const f = (cat) => ({ features: cat });   // wrap {feat: {count}} as a category
      const c = (n) => ({ count: n });
      const FIXTURES = [
        {},                                     // empty — every score from zero counts
        {                                       // rich mixed-use urban cell, multi-religion, WorldPop present
          categories: {
            food: f({ restaurants: c(10), cafes: c(5), fast_food: c(3), bakery: c(2), bars: c(1), ice_cream: c(1), butcher: c(1) }),
            shopping: f({ convenience: c(6), supermarket: c(2), mall: c(1), marketplace: c(1), department: c(1), electronics: c(2), mobile: c(3) }),
            transport: f({ bus_stop: c(8), metro: c(1), railway: c(1), parking: c(4), bicycle_rental: c(2), fuel: c(2), ev_charging: c(1) }),
            leisure: f({ parks: c(3), garden: c(2), playground: c(1), gym: c(2), sports_centre: c(1) }),
            infrastructure: f({ footpath: c(5), water_body: c(1), roads: c(40), street_lamps: c(30), cell_tower: c(3), power: c(2), bridge: c(1), river: c(1) }),
            government: f({ toilets: c(2), police: c(1), fire: c(1), post_office: c(1), govt_office: c(2), community: c(1), social: c(1) }),
            healthcare: f({ hospitals: c(2), clinics: c(4), pharmacies: c(6), lab: c(1), dentists: c(2), nursing_home: c(1) }),
            education: f({ schools: c(5), colleges: c(2), universities: c(1), libraries: c(1), kindergartens: c(3) }),
            entertainment: f({ cinema: c(1), nightclub: c(1), museum: c(1), theatre: c(1), worship: { count: 7, subTypes: { hindu: 4, muslim: 2, christian: 1 } } }),
            business: f({ offices: c(5), coworking: c(2), estate_agent: c(3), it_company: c(2) }),
            accommodation: f({ hotel: c(2), attraction: c(1), guest_house: c(1) }),
            landuse: f({ construction: c(2), vacant: c(1), buildings_total: c(50), industrial_area: c(1), res_buildings: c(20), residential_area: c(3) }),
          },
          environment: { populationDensity: { personsPerHectare: 120 }, elevation: { isLowLying: false, relative: 2, center: 450 } },
        },
        {                                       // low-lying, single-religion, no WorldPop (building-density fallback)
          categories: {
            entertainment: f({ worship: { count: 3, subTypes: { hindu: 3 } } }),
            infrastructure: f({ river: c(2), water_body: c(1) }),
            landuse: f({ industrial_area: c(2), buildings_total: c(10), res_buildings: c(5), residential_area: c(1) }),
            shopping: f({ convenience: c(2) }),
          },
          environment: { elevation: { isLowLying: true, relative: -3 } },
        },
        {                                       // worship count but no religion tags (fallback) + ridge (relative > 5)
          categories: { entertainment: f({ worship: { count: 5, subTypes: {} } }) },
          environment: { elevation: { isLowLying: false, relative: 8 } },
        },
      ];
      return {
        compute_scores: { call: (a) => G.computeScores(...a), args: FIXTURES.map((d) => [d]) },
      };
    },
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

  digipin: {
    file: 'js/digipin.js',
    global: 'DigiPin',
    inputs: (G) => {
      const coords = [[22.7196, 75.8577], [28.6139, 77.2090], [19.0760, 72.8777], [13.0827, 80.2707]];
      const pins = coords.map(([la, lo]) => G.encode(la, lo));
      const strip = (p) => p.replace(/-/g, '');
      return {
        encode: {
          call: (a) => G.encode(...a),
          args: [...coords.map((c) => [...c]), [2.5, 63.5], [38.5, 99.5]],   // + SW / NE corners
        },
        decode: { call: (a) => G.decode(...a), args: pins.map((p) => [p]) },
        decode_partial: {
          call: (a) => G.decodePartial(...a),
          args: [['FC9'], [strip(pins[0]).substring(0, 5)], [strip(pins[1]).substring(0, 8)]],
        },
        format_pin: { call: (a) => G.format(...a), args: [['FC9'], ['FC98K2'], ['FC98K2P3T7'], ['F']] },
      };
    },
  },
};

const outDir = path.join(__dirname, 'golden');
fs.mkdirSync(outDir, { recursive: true });

for (const [model, spec] of Object.entries(MODELS)) {
  for (const [depFile, depName] of spec.deps || []) loadGlobal(depFile, depName);
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
