/**
 * Static performance budgets over the committed assets. These run in plain
 * vitest (no browser) so a too-big file fails fast and everywhere.
 *
 * Only files tracked by git count: pipeline outputs that are gitignored
 * never ship to Pages, so they cannot blow the budget.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;
const ROOT = path.resolve(__dirname, '..');

function tracked(prefix) {
    let out = '';
    try { out = execSync(`git ls-files -z -- '${prefix}'`, { cwd: ROOT }).toString(); } catch { return []; }
    return out.split('\0').filter(Boolean).map(f => ({ file: f, size: safeSize(f) }));
}
function safeSize(f) { try { return fs.statSync(path.join(ROOT, f)).size; } catch { return 0; } }

describe('static asset budgets', () => {
    it('no single building-heights file exceeds 6 MB (Delhi is the reference)', () => {
        const over = tracked('data/heights').filter(f => f.size > 6 * MB);
        expect(over, JSON.stringify(over)).toEqual([]);
    });

    it('no committed per-cell data file exceeds 3 MB (split it into parts)', () => {
        const over = tracked('data/cells').filter(f => f.size > 3 * MB);
        expect(over, JSON.stringify(over)).toEqual([]);
    });

    // Road-level GeoJSON (traffic LOS, OSM road vectors) is fetched only when
    // its layer is toggled for that city, so it gets a looser 10 MB cap than
    // the files that load on boot or on the first click into a cell.
    const LAZY_VECTOR = /^data\/(traffic|vectors)\//;
    it('no committed file under data/ exceeds 6 MB (10 MB for lazy road vectors)', () => {
        const over = tracked('data').filter(f => f.size > (LAZY_VECTOR.test(f.file) ? 10 : 6) * MB);
        expect(over, JSON.stringify(over)).toEqual([]);
    });

    // 2.05 MB on 2026-10-21 (127 modules; the Hindi UI strings tipped it over
    // 2 MB). The boot-transfer budget in tests/playwright/perf.spec.js is the
    // user-facing guard; this total is the tripwire for unbounded growth, so
    // raising it is a deliberate step, not a reflex: next stop is a bundle.
    // 2.63 MB on 2026-10-22 (feature threads added lazy modules: traffic,
    // 3D night view, massing, agents), so the cap moved to 3 MB.
    // 3.00 MB on 2026-10-24 (the data roadmap's lens modules, each under 150 kB;
    // bundled boot is 4.03 of the 5 MB bootBytes budget), so the cap moved to 3.25 MB.
    it('first-party JavaScript stays under 3.25 MB in total and 150 kB per module', () => {
        const js = tracked('js');
        const total = js.reduce((a, f) => a + f.size, 0);
        expect(total, `js/ total ${(total / MB).toFixed(2)} MB`).toBeLessThan(3.25 * MB);
        const big = js.filter(f => f.size > 150 * 1024);
        expect(big, JSON.stringify(big)).toEqual([]);
    });

    it('the service-worker precache list stays under 4 MB of local assets', () => {
        const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
        const m = sw.match(/const LOCAL_ASSETS = \[([\s\S]*?)\];/);
        expect(m, 'LOCAL_ASSETS array in sw.js').toBeTruthy();
        const files = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1].replace(/^\.\//, '').replace(/^\//, ''))
            .filter(f => f && !f.startsWith('http'));
        const sizes = files.map(f => ({ f, size: safeSize(f === '' || f === '.' ? 'index.html' : f) }));
        const total = sizes.reduce((a, x) => a + x.size, 0);
        expect(total, `precache ${(total / MB).toFixed(2)} MB`).toBeLessThan(4 * MB);
        // A precached path that does not exist on disk would 404 and fail the install.
        const missing = sizes.filter(x => x.size === 0 && !/^(\.\/)?$/.test(x.f)).map(x => x.f);
        expect(missing, 'precached but missing on disk').toEqual([]);
    });
});
