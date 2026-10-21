import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';

// js/lazy-libs.js loads CDN libraries the boot does not need (georaster) on
// first use. The loader is exercised against jsdom's <script> elements by
// firing load/error by hand (jsdom does not fetch cross-origin scripts).
function fresh() {
    const ctx = { window: globalThis, document, globalThis, setTimeout, clearTimeout, console };
    vm.runInNewContext(readFileSync(path.join(process.cwd(), 'js/lazy-libs.js'), 'utf-8'), ctx);
    return globalThis.LazyLibs;
}
const tag = () => document.head.querySelector('script[src*="georaster"]');

describe('LazyLibs', () => {
    beforeEach(() => { document.head.innerHTML = ''; });
    afterEach(() => { document.head.innerHTML = ''; });

    it('injects the pinned tag once with its integrity hash and resolves to the global', async () => {
        const L = fresh();
        expect(tag()).toBeNull();
        expect(L.isLoaded('georaster')).toBe(false);
        const p1 = L.load('georaster');
        const p2 = L.load('georaster');
        expect(p1).toBe(p2);
        const el = tag();
        expect(el).not.toBeNull();
        expect(document.head.querySelectorAll('script').length).toBe(1);
        expect(el.getAttribute('integrity')).toBe(L.LIBS.georaster.integrity);
        expect(el.getAttribute('crossorigin')).toBe('anonymous');
        const fn = () => 'parsed';
        globalThis.parseGeoraster = fn;
        el.onload();
        await expect(p1).resolves.toBe(fn);
        expect(L.isLoaded('georaster')).toBe(true);
        // Already present: no second tag.
        await expect(L.load('georaster')).resolves.toBe(fn);
        expect(document.head.querySelectorAll('script').length).toBe(1);
        delete globalThis.parseGeoraster;
    });

    it('rejects when the CDN fails, removes the tag, and tries again on the next call', async () => {
        const L = fresh();
        const p = L.load('georaster');
        tag().onerror();
        await expect(p).rejects.toThrow(/failed to load/);
        expect(tag()).toBeNull();
        const p2 = L.load('georaster');
        expect(tag()).not.toBeNull();
        tag().onerror();
        await expect(p2).rejects.toThrow();
    });

    it('rejects a tag that ran but defined nothing, and an unknown library', async () => {
        const L = fresh();
        const p = L.load('georaster');
        tag().onload();
        await expect(p).rejects.toThrow(/did not define parseGeoraster/);
        await expect(L.load('nope')).rejects.toThrow(/unknown library/);
    });

    it('matches the service worker and the page: lazy URLs are precached, not in app.html', () => {
        const L = fresh();
        const sw = readFileSync(path.join(process.cwd(), 'sw.js'), 'utf-8');
        const html = readFileSync(path.join(process.cwd(), 'app.html'), 'utf-8');
        for (const lib of Object.values(L.LIBS)) {
            expect(sw).toContain(`'${lib.url}'`);
            expect(html).not.toContain(`src="${lib.url}"`);
        }
        expect(html).toContain('src="js/lazy-libs.js"');
    });
});
