# DigiPin data proxy

A tiny **allowlisted reverse proxy** that fronts the few upstream APIs the
browser cannot reach directly. It exists to fix the app's main reliability
drawback: live, per-click fetches that fail because of CORS or missing keys.

## What it solves

The PWA fetches everything live from third-party APIs in the browser. Some of
those:

- **don't send CORS headers** — `data.gov.in`, NRSC Bhoonidhi, IUDX — so the
  browser blocks the response outright; and
- **require an API key** that must not ship in client source.

The repo previously worked around CORS with the public `allorigins.win` proxy,
which is frequently rate-limited or down. This Worker replaces it:

- it runs server-side, so there is **no CORS wall** on the upstream call;
- it **injects keys from environment secrets**, so the client ships none;
- it returns the response with permissive **CORS headers** the browser accepts.

It is **not an open proxy**: only hosts in the `UPSTREAMS` allowlist
(`worker.mjs`) are forwarded, and only `GET`/`OPTIONS` are allowed.

## Allowlisted hosts

| Host | Why proxied | Key injected |
|------|-------------|--------------|
| `api.data.gov.in` | CORS + key | `OGD_API_KEY` |
| `api.waqi.info` | key | `WAQI_TOKEN` |
| `api.openchargemap.io` | key | `OCM_API_KEY` |
| `cos.iudx.org.in` | CORS | — |
| `bhoonidhi-api.nrsc.gov.in` | CORS | — |
| `api.open-elevation.com` | reliability | — |
| `api.worldpop.org` | reliability | — |

## Deploy (Cloudflare Workers)

### Automatic (CI)

`.github/workflows/deploy-proxy.yml` deploys this worker automatically whenever
`worker.mjs` or `wrangler.toml` changes on `main` (the worker unit tests gate
the deploy). To enable it, add two repository secrets under
**Settings → Secrets and variables → Actions**:

| Secret | What |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | a token with the "Edit Workers" permission |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account id |

Until those are set the workflow is a safe no-op (runs tests, emits a notice).

### Manual / first-time

```bash
cd proxy
npx wrangler deploy
npx wrangler secret put OGD_API_KEY    # data.gov.in key
npx wrangler secret put WAQI_TOKEN      # aqicn.org / WAQI token
```

The upstream keys (`OGD_API_KEY`, `WAQI_TOKEN`) are **not** managed by CI:
Cloudflare secrets persist across code deploys, so set them once with
`wrangler secret put`. The worker degrades gracefully when they're absent
(it simply doesn't inject a key).

Then point the app at it (e.g. in `index.html` before the app scripts):

```html
<script>
  window.DIGIPIN_CONFIG = {
    proxyBase: 'https://digipin-data-proxy.<you>.workers.dev',
  };
</script>
```

When `proxyBase` is **unset**, the app behaves exactly as before (direct fetches,
`allorigins` fallback for the CORS-only IUDX call) — so the proxy is an opt-in
reliability upgrade, not a hard dependency.

## Client contract

```
GET https://<proxy>/?url=<url-encoded upstream URL>
```

The Worker validates the upstream host against the allowlist, injects the
relevant key from its environment, fetches server-side, and returns the body
with CORS headers.

## Tests

`worker.test.mjs` runs under the repo's Vitest suite (`npm test`) and covers the
allowlist enforcement, key injection, CORS/preflight handling, and upstream
error mapping — no real network calls (the upstream `fetch` is mocked).
