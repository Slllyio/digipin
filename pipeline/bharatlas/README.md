# Bharatlas mirror

A scraper + integration for [bharatlas.com](https://bharatlas.com) — India's open atlas, a CC0/CC-BY-4.0 catalog of 59 curated geospatial layers (admin boundaries, electoral constituencies, pin codes, environment, wildlife) published by [urbanmorph](https://urbanmorph.com).

## Why DigiPin uses Bharatlas

DigiPin previously fetched the same admin boundaries from Overpass at every cell click — slow, rate-limited, and inconsistent. Bharatlas serves the same data as pre-built PMTiles from Cloudflare R2. One download per layer, zero per-click Overpass calls, and **every layer carries multi-source provenance** (LGD + SOI + geoBoundaries + Bhuvan / PMGSY alternates) — the same multi-source quality pattern as our own `scrapers/lib/quality.py`.

## The 4 lookup layers DigiPin loads on startup

These attach invisibly to MapLibre at boot so every cell click can resolve administrative + postal containment in <50 ms:

| Layer | Source | Rows | Size |
|---|---|---:|---:|
| `lgd_states` | LGD | 36 | 3.5 MB |
| `lgd_districts` | LGD | 785 | 12.7 MB |
| `lgd_subdistricts` | LGD | 6,471 | 34.1 MB |
| `datagov_pincodes` | data.gov.in | 19,312 | 20.9 MB |

The result is the **Bharatlas containment chip-row** that appears in every cell detail panel — pincode + tehsil + district + state, sourced from authoritative government data rather than text-parsed Nominatim output.

## How to mirror

```bash
# Pull all 59 layers' PMTiles (~1 GB total) — resume-friendly
python pipeline/bharatlas/fetch_all.py

# Also pull parquet (DuckDB-ingestable)
python pipeline/bharatlas/fetch_all.py --formats pmtiles parquet

# Or everything (parquet + pmtiles + geojson + kml + shapefile, ~6 GB)
python pipeline/bharatlas/fetch_all.py --formats all

# Restrict to a few layers
python pipeline/bharatlas/fetch_all.py --layers datagov_pincodes lgd_subdistricts
```

Output lands in `data/bharatlas/` mirroring the upstream R2 layout:

```
data/bharatlas/
  catalog.json                     # snapshot of the upstream index
  admin/states/LGD_States.pmtiles
  admin/districts/LGD_Districts.pmtiles
  admin/subdistricts/LGD_Subdistricts.pmtiles
  postal/boundaries/Datagov_Pincode_Boundaries.pmtiles
  ...
  MANIFEST.json                    # record of what was fetched + when
```

## Idempotency + politeness

- Files matching the catalog's expected `bytes` (±1 %) are skipped on re-run — the mirror is safe to schedule on a cron.
- 0.5 s polite delay between requests (R2 doesn't rate-limit but we behave like a good neighbour).
- User-Agent identifies the mirror: `DigiPin-Bharatlas-Mirror/1.0`.

## Catalog schema

Bharatlas's `catalog.json` is self-describing — see [bharatlas.com/catalog.json](https://bharatlas.com/catalog.json). Each layer entry has:

```json
{
  "id": "lgd_states",
  "level": "state",
  "source": "LGD",
  "rows": 36,
  "category": "administrative",
  "licence": "CC0-1.0 / CC-BY-4.0",
  "provenance": "curated",
  "attribution": { "primary": "...", "publisher": "..." },
  "pmtiles": { "url": "https://pub-....r2.dev/.../LGD_States.pmtiles", "bytes": 3500000 },
  "parquet": { "url": "...", "bytes": 1200000 },
  "geojson": { "url": "...", "bytes": 8400000 },
  "kml":     { "url": "...", "bytes": 6100000 },
  "shapefile": { "url": "...", "bytes": 2300000 }
}
```

## Attribution

Per the catalog's `attribution` blocks, downstream consumers (including DigiPin) must:

- Credit **bharatlas.com** + the **upstream source** (LGD, SOI, data.gov.in, Bhuvan, CWC, etc.) on the rendered map.
- Honour the per-layer licence — most are CC0-1.0, some are CC-BY-4.0.
- Link back to the source on every feature popup.

DigiPin's cell-detail panel does this automatically — every containment chip includes a `via bharatlas · LGD · data.gov.in` source line.

## Related

- Frontend integration: [`js/bharatlas.js`](../../js/bharatlas.js)
- Per-cell containment widget: [`js/panel.js`](../../js/panel.js) (`_attachBharatlasContainment`)
- Bharatlas source: [github.com/urbanmorph/geodata](https://github.com/urbanmorph/geodata)
