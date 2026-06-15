# Precompute Phase 1 — multi-city rollout

Phase 0 (Indore pilot) is live: the pipeline scores a metro grid offline and the
app reads it from `data/scores/` with no per-click upstream calls. Phase 1
extends that to tier-1 metros. This doc is the runbook + the remaining
infra-gated work.

See `docs/PRECOMPUTE_PLAN.md` for the full pipeline design and
`pipeline/scores/README.md` for the JS↔Python parity contract.

## What landed in this PR (groundwork)

- **Multi-city region registry** (`pipeline/_lib/regions.py`): tier-1 metro
  bboxes + the Geofabrik sub-extract each maps to, plus helpers/CLI
  (`geofabrik-url`, `clip-bbox`, `dem-urls`, `bbox`, `list-cities`).
- **Region-driven CI** (`.github/workflows/precompute-scores.yml`): every
  per-region input is resolved from the registry, so building a new city is a
  `workflow_dispatch` with that region name — no YAML edits. Multi-tile DEMs are
  mosaicked with `gdalbuildvrt`.
- **Multipolygon relations** (`pipeline/scores/count_features.py`): parks/lakes/
  landuse mapped as relations are now counted (assembled via pyosmium areas,
  outer-ring bbox centre), fixing a green/water undercount. Closed ways are not
  double-counted.

The frontend already auto-discovers any region from `coverage.json`
(`js/precomputed-scores.js`), so a newly-built city lights up with no app
changes.

## City registry (level 6 ≈ 244 m)

| Region | Geofabrik zone | L6 cells | ~JSON |
|---|---|---:|---:|
| indore_pilot | central-zone | 2,209 | ~122 KB |
| delhi | northern-zone | 3,304 | ~180 KB |
| bengaluru | southern-zone | 1,368 | ~75 KB |
| mumbai | western-zone | 1,125 | ~62 KB |
| hyderabad | southern-zone | 1,080 | ~60 KB |
| chennai | southern-zone | 726 | ~40 KB |
| pune | western-zone | 700 | ~39 KB |
| bhopal | central-zone | 442 | ~24 KB |
| **8 cities** | | **~11.0k** | **~0.6 MB** |

Level 7 (~61 m) is ~167k cells / ~9 MB total — still trivial to host. Storage is
not a constraint; CI compute + raster inputs are.

## Build one city

Via CI (preferred): **Actions → Precompute scores → Run workflow**, set
`region` (e.g. `pune`) and `level` (6). The job resolves the extract/clip/DEM,
builds, smoke-checks, and commits `data/scores/pune/` + updates `coverage.json`.

Locally (to verify before CI):

```bash
EXTRACT=$(python -m pipeline._lib.regions geofabrik-url pune)
CLIP=$(python -m pipeline._lib.regions clip-bbox pune)
curl -sSL -o zone.osm.pbf "$EXTRACT"
osmium extract -b "$CLIP" zone.osm.pbf -o pune.osm.pbf
# DEM (optional): python -m pipeline._lib.regions dem-urls pune
python -m pipeline.scores.build_tile --region pune --level 6 \
  --pbf pune.osm.pbf --pmtiles --out data/scores
python -m pipeline.scores.smoke_check data/scores --region pune
```

Adding a brand-new city = one bbox + Geofabrik-zone entry in
`pipeline/_lib/regions.py` (+ its test), then the steps above.

## Remaining infra (needs decisions/secrets)

1. **GHSL population raster.** `population_proxy` + flood currently use a
   building-density fallback. A one-time Google Earth Engine GHS-POP export,
   clipped per city and hosted as an asset, then wired via `--pop`, improves
   fidelity. *Needs: GEE access + asset hosting.*

2. **R2 hosting + parallel matrix.** Committing every city's tile to git is fine
   for a handful; for the full set, publish to Cloudflare R2 (zero egress) and
   point `window.DIGIPIN_CONFIG.scoresBase` at it. A parallel build matrix over
   `regions.CITY_PILOTS` then needs a **commit/upload strategy that doesn't
   race** (each job writes only its own `data/scores/<region>/` and updates
   `coverage.json` atomically, or uploads to R2 instead of committing).
   *Needs: `CLOUDFLARE_*` secrets + the matrix/serialization wiring.*

3. **CI minutes.** Each tile build downloads a ~1 GB zonal extract; cities
   sharing a zone (Indore+Bhopal, Pune+Mumbai, Bengaluru+Hyderabad+Chennai) can
   share one download if the matrix is grouped by zone.

## Parity & cadence

Scorers stay pinned to the JS source of truth via golden fixtures
(`pipeline/scores/README.md`); changing a scorer means regenerating fixtures
(`npm run golden:scores`) and re-running `pytest pipeline/`. The monthly cron
keeps tiles fresh against OSM edits.
