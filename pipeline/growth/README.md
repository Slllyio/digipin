# `pipeline/growth/` — Growth Forecast data pipeline

Builds the three Cloud-Optimized GeoTIFFs that power the urban growth
forecast feature. See [spec §6](../../docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md#6-data-sources--pipeline).

## Setup

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r pipeline/growth/requirements.txt

# Earth Engine auth (one-time)
export GOOGLE_APPLICATION_CREDENTIALS=~/.gee/digipin-credentials.json
```

## Run

```sh
python -m pipeline.growth.extract_buildings_temporal   # ~20 min, 8-band COG
python -m pipeline.growth.extract_viirs_annual         # ~10 min, 9-band COG
python -m pipeline.growth.download_ghsl_pop            # ~1 min, single COG
```

Output in `data/growth/`.

## Refresh cadence

| Source | When |
|---|---|
| Buildings Temporal | Yearly, when Google publishes the next year |
| VIIRS | Quarterly |
| GHSL | Every 5 years (next 2030) |
