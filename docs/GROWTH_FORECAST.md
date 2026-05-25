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
