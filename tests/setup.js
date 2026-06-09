/**
 * Setup file for Vitest with jsdom.
 *
 * DigiPin and DataFetcher are IIFE modules that rely on browser script-tag
 * global hoisting:  `const DigiPin = (() => {...})();` becomes globally
 * accessible inside a <script> tag, but **not** when evaluated via
 * `vm.runInNewContext` — `const` declarations are lexically scoped to the
 * script and don't attach to the context object.
 *
 * Fix: read the source, **append** `globalThis.<Name> = <Name>` lines so
 * the IIFE's const becomes reachable, then evaluate via
 * `vm.runInThisContext` so the assignments hit the Vitest worker's
 * globalThis (not a fresh sandbox).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);

function loadGlobalScript(relPath, exposeNames) {
    const filePath = path.join(rootDir, relPath);
    let code = readFileSync(filePath, 'utf-8');
    for (const name of exposeNames) {
        code += `\nif (typeof ${name} !== 'undefined') globalThis.${name} = ${name};`;
    }
    vm.runInThisContext(code, { filename: relPath });
}

loadGlobalScript('js/digipin.js', ['DigiPin']);
loadGlobalScript('js/data-fetcher.js', ['DataFetcher']);
loadGlobalScript('js/growth-score.js', ['GrowthScore']);
loadGlobalScript('js/realtime-growth.js', ['RealtimeGrowth']);
loadGlobalScript('js/growth-widget.js', ['GrowthWidget']);
loadGlobalScript('js/heat-score.js', ['HeatScore']);
loadGlobalScript('js/heat-widget.js', ['HeatWidget']);
loadGlobalScript('js/realtime-flood.js', ['RealtimeFlood']);
loadGlobalScript('js/realtime-alerts.js', ['RealtimeAlerts']);
loadGlobalScript('js/realtime-quakes.js', ['RealtimeQuakes']);
loadGlobalScript('js/bivariate-overlay.js', ['BivariateOverlay']);
loadGlobalScript('js/ndvi-overlay.js', ['NDVIOverlay']);
loadGlobalScript('js/viewshed.js', ['Viewshed']);
loadGlobalScript('js/kde-overlay.js', ['KDEOverlay']);
loadGlobalScript('js/accessibility-overlay.js', ['AccessibilityOverlay']);
loadGlobalScript('js/query-engine.js', ['QueryEngine']);
loadGlobalScript('js/bookmarks.js', ['Bookmarks']);
loadGlobalScript('js/building-intelligence.js', ['BuildingIntelligence']);
