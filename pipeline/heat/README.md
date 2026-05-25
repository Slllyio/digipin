# `pipeline/heat/` — Urban Heat Island data pipeline

Extracts MODIS land surface temperature (LST) as Cloud-Optimized GeoTIFFs
for the (future) Urban Heat Island feature on the DigiPin portal.

This package is **standalone infrastructure** as of PR #14 — the browser-side
score module, panel widget, and map overlay that consume this data will land
in subsequent PRs. The extractor is shipped first because the GEE export is
the slow long-tail step (~15 min runtime) and the data file needs to be
present before the UI can render.

## Setup

```sh
# Reuses the same GEE auth as the growth pipeline.
# See pipeline/growth/README.md for the dual-auth-path explanation.
pip install -r pipeline/heat/requirements.txt
```

## Run

```sh
PYTHONIOENCODING=utf-8 python -m pipeline.heat.extract_modis_lst
```

Expected runtime: ~10-15 min. Output lands in your Google Drive folder
`DigiPin/`. Move into `data/heat/`:

```sh
mv ~/Downloads/modis_lst_2016-2024.tif data/heat/
```

## Output shape

| Property | Value |
|---|---|
| File | `data/heat/modis_lst_2016-2024.tif` |
| Bands | 18 (`lst_day_2016`, `lst_night_2016`, ..., `lst_day_2024`, `lst_night_2024`) |
| Resolution | 1 km (MODIS native) |
| Coverage | India bbox (68°-97.5° E, 6.5°-35.5° N) |
| Encoding | uint16 Kelvin × 50 (divide by 50 to get K; subtract 273.15 for °C) |
| Size | ~30 MB compressed |

## Why day + night separately

- **Day LST** — captures heating from sunlight + low albedo (concrete vs. vegetation reflectance).
- **Night LST** — captures *heat retention*. Cities cool ~3-5 °C less than surrounding rural areas at night because built materials store heat through the day and release it slowly. **This is the canonical Urban Heat Island signal.**

Future UHI score will likely use night LST anomaly relative to surrounding cells (e.g., cell's `lst_night_2024 - mean(lst_night_2024 within 10 km)`). Day LST is shipped alongside for diurnal-range analyses.

## Refresh cadence

Yearly when the next year's daily product is complete (typically January for the prior year's full annual mean). Bump `YEARS` constant and re-run.
