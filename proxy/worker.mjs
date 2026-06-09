/**
 * DigiPin data proxy — a tiny *allowlisted* reverse proxy for the handful of
 * upstreams the browser cannot reach directly.
 *
 * Why this exists: the PWA fetches everything live, per click, from third-party
 * APIs. Several of them either (a) don't send CORS headers (data.gov.in, NRSC
 * Bhoonidhi, IUDX) so the browser blocks them, or (b) require an API key that
 * must not ship in client source. This Worker fronts only those hosts:
 *   - it runs server-side, so there is no CORS wall on the upstream call;
 *   - it injects keys from environment secrets, so the client ships none;
 *   - it returns the response with permissive CORS headers the browser accepts.
 *
 * It is deliberately NOT an open proxy: only hosts in UPSTREAMS are forwarded,
 * and only GET/OPTIONS are allowed, so it can't be abused to fetch arbitrary
 * URLs. Deploy on Cloudflare Workers (see README.md); the same default-export
 * shape runs on most edge runtimes.
 *
 * Client usage: GET https://<proxy>/?url=<url-encoded upstream>
 */

// host -> { keyParam, envKey } for key injection. Empty object = CORS-only.
const UPSTREAMS = {
    'api.data.gov.in': { keyParam: 'api-key', envKey: 'OGD_API_KEY' },
    'api.waqi.info': { keyParam: 'token', envKey: 'WAQI_TOKEN' },
    'cos.iudx.org.in': {},
    'bhoonidhi-api.nrsc.gov.in': {},
    'api.open-elevation.com': {},
    'api.worldpop.org': {},
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

async function handleRequest(request, env) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
        return json(405, { error: 'method not allowed' });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return json(400, { error: 'missing url parameter' });

    let upstream;
    try {
        upstream = new URL(target);
    } catch {
        return json(400, { error: 'invalid url' });
    }

    const conf = UPSTREAMS[upstream.hostname];
    if (!conf) return json(403, { error: `host not allowed: ${upstream.hostname}` });

    // Inject the server-side key (overriding anything the client sent) so the
    // browser never has to hold a real key.
    if (conf.keyParam && conf.envKey && env && env[conf.envKey]) {
        upstream.searchParams.set(conf.keyParam, env[conf.envKey]);
    }

    let resp;
    try {
        resp = await fetch(upstream.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'DigiPinDataProxy/1.0', Accept: 'application/json' },
        });
    } catch (e) {
        return json(502, { error: 'upstream fetch failed', detail: String((e && e.message) || e) });
    }

    // Stream the upstream body back with CORS + a short edge-cache hint.
    const headers = new Headers(CORS_HEADERS);
    const ct = resp.headers.get('Content-Type');
    if (ct) headers.set('Content-Type', ct);
    headers.set('Cache-Control', 'public, max-age=600');
    return new Response(resp.body, { status: resp.status, headers });
}

export default { fetch: handleRequest };
// Named exports for unit tests.
export { handleRequest, UPSTREAMS };
