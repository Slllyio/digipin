# `pipeline/growth/` — Growth Forecast data pipeline

Builds the three Cloud-Optimized GeoTIFFs that power the urban growth
forecast feature. See [spec §6](../../docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md#6-data-sources--pipeline).

## Setup

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r pipeline/growth/requirements.txt
```

Earth Engine auth — two paths, in priority order:

1. **Cached OAuth (recommended for local dev)** — run `earthengine authenticate` once. Credentials cache to `~/.config/earthengine/credentials`. No further setup. The pipeline's `_init_ee()` falls back to this when `GOOGLE_APPLICATION_CREDENTIALS` is unset.
2. **Service account (required for CI)** — download a JSON key from the GCP console for an Earth Engine-enabled service account, then:
   ```sh
   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
   ```

Project ID defaults to `van-suraksha-alert` (the GCP project that owns the EE-registered service account). Override via:

```sh
export GEE_PROJECT=your-other-project
```

## Run

```sh
PYTHONIOENCODING=utf-8 python -m pipeline.growth.extract_buildings_temporal   # ~20 min, 8-band COG
PYTHONIOENCODING=utf-8 python -m pipeline.growth.extract_viirs_annual         # ~10 min, 9-band COG
PYTHONIOENCODING=utf-8 python -m pipeline.growth.download_ghsl_pop            # ~5 min, single COG
```

(`PYTHONIOENCODING=utf-8` is a Windows safeguard — logs emit Unicode in some informational messages; on a default cp1252 console the script otherwise crashes on the first log line. Linux/macOS users can omit it.)

All three use GEE's `Export.image.toDrive` — the result lands in your Google Drive folder `DigiPin/`. Manually download and move into `data/growth/`:

```sh
mv ~/Downloads/buildings_temporal_2016-2023.tif data/growth/
mv ~/Downloads/viirs_2016-2024.tif              data/growth/
mv ~/Downloads/ghsl_pop_2020.tif                data/growth/
```

(The `download_ghsl_pop.py` script is named historically — it now also uses GEE export rather than direct HTTPS download, since the original EU JRC URL pattern moved in the R2025A release.)

## Refresh cadence

| Source | When | GEE asset |
|---|---|---|
| Buildings Temporal | Yearly, when Google publishes the next year | `GOOGLE/Research/open-buildings-temporal/v1` |
| VIIRS | Quarterly | `NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG` |
| GHSL | Every 5 years (next 2025 epoch when EU JRC publishes to GEE) | `JRC/GHSL/P2023A/GHS_POP/<YEAR>` |
