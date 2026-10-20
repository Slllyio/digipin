import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Keep the service-worker precache honest. The app has no bundler, so every
// js/ module is a separate <script> in app.html; if one isn't precached in
// sw.js, the app silently breaks offline for that feature. This test parses
// both files and fails CI on any drift — no manual list maintenance.
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appHtml = readFileSync(path.join(rootDir, 'app.html'), 'utf-8');
const indexHtml = readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
const swJs = readFileSync(path.join(rootDir, 'sw.js'), 'utf-8');

/** All `js/…js` / `css/…css` srcs referenced by the two precached entry points
 *  (app.html + the index.html landing), de-duped. */
function appHtmlLocalAssets() {
    const re = /(?:src|href)="((?:js|css)\/[a-z0-9-]+\.(?:js|css))"/g;
    const out = [];
    for (const html of [appHtml, indexHtml]) {
        let m;
        while ((m = re.exec(html)) !== null) out.push(m[1]);
    }
    return [...new Set(out)];
}

/** The LOCAL_ASSETS array contents from sw.js as `js/…`/`css/…` (strip `./`). */
function swLocalAssets() {
    const block = swJs.match(/const LOCAL_ASSETS = \[([\s\S]*?)\];/);
    if (!block) return [];
    return [...block[1].matchAll(/['"]\.\/((?:js|css)\/[a-z0-9-]+\.(?:js|css))['"]/g)].map(x => x[1]);
}

/** Pinned CDN libs referenced in app.html (unpkg @version). */
function appHtmlCdnVersions() {
    return [...appHtml.matchAll(/unpkg\.com\/([a-z-]+)@([0-9.]+)\//g)].map(x => `${x[1]}@${x[2]}`);
}
function swCdnVersions() {
    const block = swJs.match(/const CDN_ASSETS = \[([\s\S]*?)\];/);
    if (!block) return [];
    return [...block[1].matchAll(/unpkg\.com\/([a-z-]+)@([0-9.]+)\//g)].map(x => `${x[1]}@${x[2]}`);
}

describe('sw.js precache ↔ app.html', () => {
    it('precaches every local js/css asset app.html loads', () => {
        const referenced = appHtmlLocalAssets();
        const cached = new Set(swLocalAssets());
        const missing = referenced.filter(a => !cached.has(a));
        expect(missing, `not precached in sw.js LOCAL_ASSETS: ${missing.join(', ')}`).toEqual([]);
    });

    it('does not precache assets app.html no longer references', () => {
        const referenced = new Set(appHtmlLocalAssets());
        // The app shell entries (./ ./index.html ./app.html) aren't <script>/<link> in app.html.
        const shell = new Set(); // js/css only — all should be referenced
        const stale = swLocalAssets().filter(a => !referenced.has(a) && !shell.has(a));
        expect(stale, `precached but unreferenced (dead): ${stale.join(', ')}`).toEqual([]);
    });

    it('precaches the same CDN library versions app.html pins', () => {
        // sw.js caches the map-critical libs; every version it caches must match
        // the pinned <script>/<link> tags in app.html (a stale precache would
        // serve a mismatched MapLibre offline).
        const appPins = new Set(appHtmlCdnVersions());
        const mismatched = swCdnVersions().filter(v => !appPins.has(v));
        expect(mismatched, `sw.js CDN version not in app.html: ${mismatched.join(', ')}`).toEqual([]);
    });
});
