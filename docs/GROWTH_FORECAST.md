# Urban Growth Forecast

When you click a DigiPin cell, the panel shows a **Growth Forecast**
widget with three time horizons (Nowcast / 1-2 yr / 5 yr) and three
contributing dimensions (Built-up / Densify / Capital).

See [the design spec](superpowers/specs/2026-05-24-urban-growth-forecast-design.md)
for the full data sources, score model, and disclosure notes.

## Refreshing the data

Once a quarter (or when GHSL / Open Buildings publish new annual data):

```sh
export GOOGLE_APPLICATION_CREDENTIALS=~/.gee/digipin-credentials.json
python -m pipeline.growth.extract_buildings_temporal
python -m pipeline.growth.extract_viirs_annual
python -m pipeline.growth.download_ghsl_pop
git add data/growth/
git commit -m "data(growth): refresh COGs YYYY-MM"
```

RERA snapshot refresh is automatic via the existing real-time scraper
workflow (`.github/workflows/realtime-scrape.yml`).

> **Note:** the growth COGs above (`data/growth/*.tif`) are **not committed
> to the repo** — they require Google Earth Engine credentials to generate.
> Until they're hosted (or produced by Phase 2 of
> [`PRECOMPUTE_PLAN.md`](PRECOMPUTE_PLAN.md)), the Growth Forecast returns
> null in the deployed app.

## Emerging-hotspot classification (map type #4)

`GrowthScore.emergingClass(level, slope)` turns a cell's current growth
**level** and its temporal **trend** (slope from `GrowthScore.linearTrend`
over the building/VIIRS series) into a space-time category — *Intensifying /
Persistent / Diminishing / Emerging / Cooling / Stable*. It is pure and
unit-tested, and consumes exactly what `scoreCell` already derives per cell,
so the "Emerging Hotspot" map lights up automatically once the growth COGs
above are hosted. It is intentionally **not** wired to a toolbar overlay
today, because with no temporal data it would render empty.
