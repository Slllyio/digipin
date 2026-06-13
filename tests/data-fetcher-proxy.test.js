import { describe, it, expect, afterEach } from 'vitest';

// DataFetcher is exposed on globalThis by tests/setup.js. viaProxy rewrites an
// upstream URL to the configured serverless proxy (proxy/worker.mjs); its output
// must match the worker's `?url=<encoded>` contract.
const { viaProxy } = globalThis.DataFetcher;

afterEach(() => { delete window.DIGIPIN_CONFIG; });

const UP = 'https://api.data.gov.in/resource/x?api-key=demo&format=json';

describe('DataFetcher.viaProxy()', () => {
    it('returns the URL unchanged when no proxy is configured', () => {
        expect(viaProxy(UP)).toBe(UP);
    });

    it('falls back to allorigins for CORS-only calls when unconfigured', () => {
        const out = viaProxy(UP, { corsFallback: true });
        expect(out).toBe(`https://api.allorigins.win/raw?url=${encodeURIComponent(UP)}`);
    });

    it('rewrites to the configured proxy with the worker-expected ?url= shape', () => {
        window.DIGIPIN_CONFIG = { proxyBase: 'https://p.workers.dev' };
        expect(viaProxy(UP)).toBe(`https://p.workers.dev/?url=${encodeURIComponent(UP)}`);
    });

    it('prefers the configured proxy over the allorigins fallback', () => {
        window.DIGIPIN_CONFIG = { proxyBase: 'https://p.workers.dev' };
        expect(viaProxy(UP, { corsFallback: true }))
            .toBe(`https://p.workers.dev/?url=${encodeURIComponent(UP)}`);
    });

    it('round-trips through encode so the worker can decode the original URL', () => {
        window.DIGIPIN_CONFIG = { proxyBase: 'https://p.workers.dev' };
        const out = viaProxy(UP);
        const passed = new URL(out).searchParams.get('url');
        expect(passed).toBe(UP);
    });

    it('reads config at call time (set after load still applies)', () => {
        expect(viaProxy(UP)).toBe(UP);
        window.DIGIPIN_CONFIG = { proxyBase: 'https://late.workers.dev' };
        expect(viaProxy(UP)).toBe(`https://late.workers.dev/?url=${encodeURIComponent(UP)}`);
    });
});
