"""Urban Growth Forecast pipeline — extracts COGs from Earth Engine.

Spec reference: docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md §6

Output written to data/growth/:
  buildings_temporal_2016-2023.tif  (8-band, Open Buildings Temporal V1)
  viirs_2016-2024.tif               (9-band, NASA VIIRS night lights)
  ghsl_pop_2025.tif                 (single-band, EU JRC GHSL)

Run with `python -m pipeline.growth.extract_buildings_temporal` etc.
GEE auth via GOOGLE_APPLICATION_CREDENTIALS env var.
"""
