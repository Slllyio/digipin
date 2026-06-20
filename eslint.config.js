// ESLint flat config for the DigiPin PWA.
//
// The app is classic <script> modules using the IIFE-global pattern (no
// bundler), so each module both declares `const X = (()=>{})()` AND is a
// cross-file global. We therefore:
//   - declare the cross-module + library globals so `no-undef` stays useful
//     (it catches typos and missing references — the highest-value lint here);
//   - disable `no-redeclare` (the IIFE const legitimately shadows the global);
//   - downgrade style/cosmetic rules to warnings so the lint gate flags real
//     bugs without drowning in an existing 12k-line codebase.
//
// CommonJS form — package.json is "type": "commonjs".
const js = require('@eslint/js');
const globals = require('globals');

// Globals defined by one module and consumed across files.
const APP_GLOBALS = {
  DigiPin: 'readonly', DataFetcher: 'readonly', DataFetcherCache: 'readonly',
  MapModule: 'readonly', App: 'readonly', Panel: 'readonly', QueryEngine: 'readonly',
  KeyboardNav: 'readonly',
  DISHA: 'readonly', DISHAPanel: 'readonly', DISHAProviders: 'readonly', DISHACache: 'readonly',
  DISHAActions: 'readonly',
  Compare: 'readonly', Bookmarks: 'readonly', CitySelector: 'readonly', WardOverlay: 'readonly',
  HeatmapOverlay: 'readonly', BuildingIntelligence: 'readonly', BuildingIntelDialog: 'readonly',
  ScoresDialog: 'readonly', DigitalTwinLayers: 'readonly', FloatingDialogs: 'readonly',
  OvertureBuildings: 'readonly', Isochrone: 'readonly', Report: 'readonly', TrainingDataGen: 'readonly',
  GrowthScore: 'readonly', GrowthOverlay: 'readonly', GrowthWidget: 'readonly', RealtimeGrowth: 'readonly',
  CAGrowthOverlay: 'readonly', ScenarioModel: 'readonly', ScenarioPanel: 'readonly',
  TrafficScore: 'readonly', TrafficGrid: 'readonly', RealtimeTraffic: 'readonly',
  TrafficWidget: 'readonly', TrafficOverlay: 'readonly',
  MobilityScore: 'readonly', MobilityGrid: 'readonly', RealtimeMobility: 'readonly',
  MobilityWidget: 'readonly', MobilityOverlay: 'readonly',
  Utilities: 'readonly',
  HeatScore: 'readonly', HeatOverlay: 'readonly', HeatWidget: 'readonly', RealtimeHeat: 'readonly',
  FloodSCS: 'readonly', FloodInundation: 'readonly', FloodAnimation: 'readonly', RealtimeFlood: 'readonly',
  RealtimeAlerts: 'readonly', RealtimeIMD: 'readonly', RealtimeQuakes: 'readonly',
  BivariateOverlay: 'readonly', NDVIOverlay: 'readonly', Viewshed: 'readonly',
  KDEOverlay: 'readonly', AccessibilityOverlay: 'readonly',
  PrecomputedScores: 'readonly', ScoreChoropleth: 'readonly', Text2Map: 'readonly', Text2MapEmbeddings: 'readonly',
  Text2MapResultsLayer: 'readonly',
  URLState: 'readonly', SavedViews: 'readonly', Theme: 'readonly',
  LayersPanel: 'readonly', ExportDialog: 'readonly', DTDLExport: 'readonly', Onboarding: 'readonly',
  RealEstateModel: 'readonly', RealEstateWidget: 'readonly', FootprintGrid: 'readonly',
  DIGIPIN_CONFIG: 'readonly',
  // third-party libraries loaded from CDN
  maplibregl: 'readonly', pmtiles: 'readonly', parseGeoraster: 'readonly', GeoRaster: 'readonly',
};

const RELAXED_RULES = {
  'no-redeclare': 'off',                                  // IIFE const shadows its own global
  // PascalCase = a cross-file module global; leading _ = intentionally unused.
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^[A-Z_]' }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-constant-condition': ['error', { checkLoops: false }], // while(true) stream readers
};

module.exports = [
  {
    ignores: [
      'node_modules/**', 'guna-twin-city/**', 'extras/**', 'scrapers/**',
      'data/**', 'docs/**', 'coverage/**',
      // Legacy, data-dependent Playwright specs (not run in CI, ESM import form).
      'tests/playwright/growth-widget.spec.js', 'tests/playwright/realtime-panels.spec.js',
    ],
  },

  // App source — classic browser scripts.
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...APP_GLOBALS },
    },
    rules: { ...js.configs.recommended.rules, ...RELAXED_RULES },
  },

  // Service worker.
  {
    files: ['sw.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.serviceworker, ...globals.browser } },
    rules: { ...js.configs.recommended.rules, ...RELAXED_RULES },
  },

  // Vitest unit tests (ESM) — browser env (jsdom) + node + test globals.
  {
    files: ['tests/**/*.test.js', 'tests/setup.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.vitest, ...APP_GLOBALS },
    },
    rules: { ...js.configs.recommended.rules, ...RELAXED_RULES },
  },

  // Vitest config is ESM.
  {
    files: ['vitest.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: { ...js.configs.recommended.rules, ...RELAXED_RULES },
  },

  // Playwright smoke spec + CommonJS root config files (require/module.exports).
  {
    files: ['tests/playwright/smoke.spec.js', 'eslint.config.js', 'playwright.config.js', 'pipeline/scores/gen_golden.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...RELAXED_RULES },
  },

  // Serverless data proxy — ESM edge worker + its Vitest test.
  {
    files: ['proxy/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.serviceworker, ...globals.node, ...globals.vitest },
    },
    rules: { ...js.configs.recommended.rules, ...RELAXED_RULES },
  },
];
