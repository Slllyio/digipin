import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, cpSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

// scripts/build_bundle.py runs at deploy (deploy.yml) and turns app.html's
// ~130 local <script defer> modules into one js/app.bundle.js, rewriting the
// deployed app.html and sw.js only. The source tree stays module-per-file, so
// this test builds into a temporary copy and checks the result is a faithful
// rewrite: every module, in order, exactly once; one script tag in its place;
// the service-worker precache naming the bundle; and a bundle Node can parse.
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(rootDir, 'scripts', 'build_bundle.py');

function localScripts(html) {
    return [...html.matchAll(/<script\b[^>]*\bsrc="(js\/[^"]+)"[^>]*>\s*<\/script>/g)].map((m) => m[1]);
}

describe('scripts/build_bundle.py', () => {
    let site;
    let out;
    beforeAll(() => {
        site = mkdtempSync(path.join(tmpdir(), 'digipin-bundle-'));
        copyFileSync(path.join(rootDir, 'app.html'), path.join(site, 'app.html'));
        copyFileSync(path.join(rootDir, 'sw.js'), path.join(site, 'sw.js'));
        cpSync(path.join(rootDir, 'js'), path.join(site, 'js'), { recursive: true });
        out = execFileSync('python3', [script, '--root', site], { encoding: 'utf8' });
    });
    afterAll(() => { if (site) rmSync(site, { recursive: true, force: true }); });

    it('concatenates every local module of app.html, in document order, once', () => {
        const srcHtml = readFileSync(path.join(rootDir, 'app.html'), 'utf8');
        const modules = localScripts(srcHtml);
        expect(modules.length).toBeGreaterThan(100);
        const bundle = readFileSync(path.join(site, 'js', 'app.bundle.js'), 'utf8');
        const markers = [...bundle.matchAll(/^\/\/ ==== (js\/[^ ]+) ====$/gm)].map((m) => m[1]);
        expect(markers).toEqual(modules);
        // Spot-check that the bodies are there, not only the markers.
        for (const src of [modules[0], modules[Math.floor(modules.length / 2)], modules[modules.length - 1]]) {
            const body = readFileSync(path.join(rootDir, src), 'utf8').trim().slice(0, 200);
            expect(bundle).toContain(body);
        }
        expect(out).toMatch(new RegExp(`${modules.length} modules`));
    });

    it('leaves one script tag where the first module was, and keeps the CDN tags', () => {
        const srcHtml = readFileSync(path.join(rootDir, 'app.html'), 'utf8');
        const html = readFileSync(path.join(site, 'app.html'), 'utf8');
        expect(localScripts(html)).toEqual(['js/app.bundle.js']);
        const firstModule = localScripts(srcHtml)[0];
        const before = srcHtml.slice(0, srcHtml.indexOf(`src="${firstModule}"`)).split('\n').length;
        const after = html.slice(0, html.indexOf('src="js/app.bundle.js"')).split('\n').length;
        expect(after).toBe(before);
        const cdn = (h) => [...h.matchAll(/<script\b[^>]*\bsrc="(https:[^"]+)"/g)].map((m) => m[1]);
        expect(cdn(html)).toEqual(cdn(srcHtml));
        // The inline scripts (theme pre-paint, toolbar wiring) survive untouched.
        expect((html.match(/<script>/g) || []).length).toBe((srcHtml.match(/<script>/g) || []).length);
    });

    it('rewrites the service-worker precache to the bundle and nothing else', () => {
        const sw = readFileSync(path.join(site, 'sw.js'), 'utf8');
        const srcSw = readFileSync(path.join(rootDir, 'sw.js'), 'utf8');
        const block = (s) => s.match(/const LOCAL_ASSETS = \[([\s\S]*?)\];/)[1];
        const js = [...block(sw).matchAll(/'\.\/(js\/[^']+)'/g)].map((m) => m[1]);
        expect(js).toEqual(['js/app.bundle.js']);
        // Non-js entries (pages, css, icons, manifest) are exactly as before.
        const other = (s) => [...block(s).matchAll(/'\.\/((?!js\/)[^']*)'/g)].map((m) => m[1]);
        expect(other(sw)).toEqual(other(srcSw));
        expect(sw.match(/const CDN_ASSETS = \[([\s\S]*?)\];/)[1]).toBe(srcSw.match(/const CDN_ASSETS = \[([\s\S]*?)\];/)[1]);
    });

    it('produces a bundle Node can parse (no two modules fused by a missing semicolon)', () => {
        const bundle = path.join(site, 'js', 'app.bundle.js');
        expect(existsSync(bundle)).toBe(true);
        expect(() => execFileSync(process.execPath, ['--check', bundle], { stdio: 'pipe' })).not.toThrow();
    });

    it('--check reports without writing', () => {
        const dry = mkdtempSync(path.join(tmpdir(), 'digipin-bundle-dry-'));
        try {
            copyFileSync(path.join(rootDir, 'app.html'), path.join(dry, 'app.html'));
            copyFileSync(path.join(rootDir, 'sw.js'), path.join(dry, 'sw.js'));
            cpSync(path.join(rootDir, 'js'), path.join(dry, 'js'), { recursive: true });
            const report = execFileSync('python3', [script, '--root', dry, '--check'], { encoding: 'utf8' });
            expect(report).toMatch(/nothing written/);
            expect(existsSync(path.join(dry, 'js', 'app.bundle.js'))).toBe(false);
            expect(readFileSync(path.join(dry, 'app.html'), 'utf8')).toBe(readFileSync(path.join(rootDir, 'app.html'), 'utf8'));
        } finally {
            rmSync(dry, { recursive: true, force: true });
        }
    });

    it('refuses a page whose local scripts are not all deferred', () => {
        const bad = mkdtempSync(path.join(tmpdir(), 'digipin-bundle-bad-'));
        try {
            const html = readFileSync(path.join(rootDir, 'app.html'), 'utf8').replace('<script defer src="js/app.js">', '<script src="js/app.js">');
            copyFileSync(path.join(rootDir, 'sw.js'), path.join(bad, 'sw.js'));
            cpSync(path.join(rootDir, 'js'), path.join(bad, 'js'), { recursive: true });
            writeFileSync(path.join(bad, 'app.html'), html);
            expect(() => execFileSync('python3', [script, '--root', bad], { stdio: 'pipe' })).toThrow(/without defer/);
        } finally {
            rmSync(bad, { recursive: true, force: true });
        }
    });
});
