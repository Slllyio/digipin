# DigiPin Urban Intelligence

A browser-based urban-analytics platform built on India Post's **DigiPin** grid.
Every location in India resolves to a 10-character DigiPin code addressing a
~4×4 m cell. Click any cell and the app pulls **160+ live urban features** from
free public APIs, computes ~30 intelligence scores, renders heat / growth /
flood / building overlays, and lets you interrogate the location through a
grounded LLM assistant (**DISHA**).

It is a **static Progressive Web App** — no backend, no build step. Everything
runs in the browser and is deployable to GitHub Pages / Cloudflare Pages for
~$0/month.

> **Scope, honestly:** this is an **Indore-first pilot**. The DigiPin encoder
> covers all of India, and you can click a cell anywhere, but features are
> **fetched live, per-click** from public APIs rather than precomputed for every
> cell nationwide. Some layers (IUDX smart-city sensors, ward boundaries, the
> default city) are Indore-specific. Treat the "160+ features for every cell"
> framing as *capability on demand*, not a national precomputed dataset.

## Features

- **DigiPin grid** — spec-accurate encoder/decoder (`js/digipin.js`), zoom-aware
  cell rendering over a MapLibre GL map.
- **160+ features per cell** — POIs (OSM Overpass), weather + air quality + solar
  (Open-Meteo), AQI (CPCB / WAQI), population (WorldPop), elevation, health
  facilities (data.gov.in), Wikipedia context, IUDX smart-city sensors.
- **Intelligence scores** — pure, deterministic, unit-tested score models for
  **Urban Heat Island** (MODIS LST anomaly + trend), **Growth Forecast**
  (Open Buildings Temporal + GHSL pop + RERA capital flow, 3 horizons with
  confidence bands), and **flood** (SCS-CN runoff).
- **Map overlays** — heatmaps, LCZ, Overture building footprints, 3D mode,
  ISRO Bhuvan LULC, roads, wards, isochrones.
- **DISHA assistant** — multi-provider LLM (local **Ollama**, **Groq**, or any
  OpenAI-compatible endpoint) grounded on the selected cell's real data, with
  token streaming and an optional QLoRA fine-tune pipeline.
- **Real-time layer** — disaster / weather / earthquake alerts refreshed every
  15 min by a Python scraper framework and committed as JSON snapshots.
- **Productivity** — compare cells (radar charts), bookmarks, reports, PWA
  install + offline service worker.

## Quick start

No build step. Serve the repo root over HTTP (a `file://` open won't work
because of module + fetch behaviour):

```sh
python serve.py          # http://localhost:5500
# or any static server:
npx serve .
```

Optional configuration — set before the scripts load (e.g. inline in
`index.html`):

```js
window.DIGIPIN_CONFIG = {
  waqiToken: 'your-aqicn-token',  // sharper station-level AQI (default: demo)
  ogdApiKey: 'your-data-gov-key', // higher data.gov.in quota (default: public sample)
};
```

### DISHA (AI assistant)

Easiest is local Ollama (free, no key):

```sh
ollama pull qwen2.5
ollama serve
# optionally build the tuned persona:  ollama create disha -f Modelfile
```

Or open the ⚙ panel in the app and paste a **Groq** key (free tier) or any
OpenAI-compatible endpoint. The app auto-detects Ollama → Groq → custom and
falls back to an offline notice if none is reachable.

## Real-time scrapers

Pulls near-real-time data from Indian public sources that lack clean APIs
(NDMA SACHET, IMD, NCS / USGS earthquakes, GDACS, OpenAQ). Output feeds the
map's alert layer.

```sh
pip install -r scrapers/requirements.txt
python -m scrapers.cli ndma_sachet        # writes data/realtime/<source>/latest.json
```

A GitHub Actions cron (`.github/workflows/realtime-scrape.yml`) refreshes all
sources every 15 minutes and commits the snapshots. Sources needing API keys
skip gracefully when the keys are unset. See [`scrapers/README.md`](scrapers/README.md)
for the source catalogue, JSON-Schema quality contracts, and politeness rules.

## Testing

```sh
npm install && npm test     # Vitest — frontend unit + regression (136 tests)
pytest -q                   # Python — scrapers + smoke (33 tests)
```

CI (`.github/workflows/webpack.yml`) runs both across Node 18/20/22, rejects
merge-conflict markers, and runs an **orphan-JS guard** that fails the build if
a `js/*.js` module is committed but never wired into a `<script>` tag.

## Architecture

```
Public APIs (OSM / Open-Meteo / WorldPop / IUDX / data.gov.in / Wikipedia)
   │  fetched live, per cell click, cached in IndexedDB
   ▼
Browser (static PWA)
   ├─ js/digipin.js        DigiPin encode/decode + grid
   ├─ js/data-fetcher.js   160+ feature pipeline
   ├─ js/*-score.js        pure score models (heat / growth / flood)
   ├─ js/map.js + overlays MapLibre GL rendering
   └─ js/disha*.js         grounded multi-provider LLM assistant

Python scrapers → data/realtime/*/latest.json → map alert layer
```

Vector/raster tiling and the planned R2 tile pipeline are described in
[`docs/DIGITAL_TWIN_ARCHITECTURE.md`](docs/DIGITAL_TWIN_ARCHITECTURE.md).

## Security

This is a keyless static PWA, so it **cannot hold a private secret** — anything
shipped to the browser is public. Only **public / shared-sample** credentials
(the data.gov.in sample key, the open IUDX S3 bucket) appear in client code, and
both are overridable via `window.DIGIPIN_CONFIG`. Any genuinely private key must
be fronted by a backend proxy and injected at request time — never committed to
this repo. The page ships a strict Content-Security-Policy with SRI hashes on
all CDN scripts.

## Repository layout

| Path | What |
|---|---|
| `index.html`, `js/`, `css/` | the DigiPin Urban Intelligence PWA |
| `scrapers/` | Python real-time data scraper framework |
| `pipeline/` | offline raster/vector extraction (heat, growth, tiles) |
| `data/realtime/` | committed JSON snapshots from the scrapers |
| `docs/` | architecture + design notes |
| `training-data/`, `Modelfile` | DISHA fine-tuning (QLoRA) + Ollama persona |
| `tests/`, `pytest.ini`, `vitest.config.js` | test suites |
| `guna-twin-city/` | a separate prototype digital-twin for Guna (self-contained sub-project; not part of the main PWA) |

> The video / slide-deck tooling at the repo root (`record-video.mjs`,
> `build-final-video.py`, `generate-ppt.py`, `demo-recorder.html`,
> `presentation.html`) is **demo/marketing material**, not part of the running
> product. A future cleanup should move these and `guna-twin-city/` out of the
> product tree.

## License

ISC (see `package.json`). Built on India Post's open DigiPin system and a stack
of open data sources — please respect each upstream provider's terms and the
politeness rules in `scrapers/README.md`.
