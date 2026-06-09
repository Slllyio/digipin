import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { handleRequest, UPSTREAMS } from './worker.mjs';

const req = (url, method = 'GET') => new Request(url, { method });

// Capture the upstream fetch and return a canned body.
let fetchSpy;
beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    }));
    globalThis.fetch = fetchSpy;
});
afterEach(() => vi.restoreAllMocks());

describe('data proxy worker', () => {
    it('answers CORS preflight without touching the upstream', async () => {
        const res = await handleRequest(req('https://proxy/?url=x', 'OPTIONS'), {});
        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects non-GET methods', async () => {
        const res = await handleRequest(req('https://proxy/?url=x', 'POST'), {});
        expect(res.status).toBe(405);
    });

    it('400s when url param is missing or invalid', async () => {
        expect((await handleRequest(req('https://proxy/'), {})).status).toBe(400);
        expect((await handleRequest(req('https://proxy/?url=not%20a%20url'), {})).status).toBe(400);
    });

    it('403s a host that is not on the allowlist (no open proxy)', async () => {
        const res = await handleRequest(
            req('https://proxy/?url=' + encodeURIComponent('https://evil.example.com/steal')), {});
        expect(res.status).toBe(403);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('forwards an allowlisted host and adds CORS headers', async () => {
        const up = 'https://cos.iudx.org.in/catalogue/search?q=parking';
        const res = await handleRequest(req('https://proxy/?url=' + encodeURIComponent(up)), {});
        expect(res.status).toBe(200);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(res.headers.get('Cache-Control')).toContain('max-age');
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(fetchSpy.mock.calls[0][0]).toBe(up); // CORS-only host: url untouched
    });

    it('injects the data.gov.in api-key from env, overriding any client value', async () => {
        const up = 'https://api.data.gov.in/resource/abc?format=json&api-key=CLIENT_SAMPLE';
        await handleRequest(req('https://proxy/?url=' + encodeURIComponent(up)),
            { OGD_API_KEY: 'SERVER_SECRET' });
        const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
        expect(calledUrl.searchParams.get('api-key')).toBe('SERVER_SECRET');
        expect(calledUrl.searchParams.get('format')).toBe('json');
    });

    it('injects the OpenChargeMap key from env', async () => {
        const up = 'https://api.openchargemap.io/v3/poi/?latitude=22.7&longitude=75.8&key=demo';
        await handleRequest(req('https://proxy/?url=' + encodeURIComponent(up)),
            { OCM_API_KEY: 'ocm-secret' });
        const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
        expect(calledUrl.searchParams.get('key')).toBe('ocm-secret');
    });

    it('injects the WAQI token from env', async () => {
        const up = 'https://api.waqi.info/feed/here/?token=demo';
        await handleRequest(req('https://proxy/?url=' + encodeURIComponent(up)),
            { WAQI_TOKEN: 'real-token' });
        const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
        expect(calledUrl.searchParams.get('token')).toBe('real-token');
    });

    it('leaves the url unchanged when the env secret is absent', async () => {
        const up = 'https://api.data.gov.in/resource/abc?api-key=CLIENT_SAMPLE';
        await handleRequest(req('https://proxy/?url=' + encodeURIComponent(up)), {});
        const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
        expect(calledUrl.searchParams.get('api-key')).toBe('CLIENT_SAMPLE');
    });

    it('returns 502 when the upstream throws', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
        const res = await handleRequest(
            req('https://proxy/?url=' + encodeURIComponent('https://api.worldpop.org/v1/x')), {});
        expect(res.status).toBe(502);
    });

    it('every allowlisted key-injecting host names an env secret', () => {
        for (const [, conf] of Object.entries(UPSTREAMS)) {
            if (conf.keyParam) expect(typeof conf.envKey).toBe('string');
        }
    });
});
