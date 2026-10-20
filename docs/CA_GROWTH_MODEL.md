# Growth prediction — Cellular-Automata + ML (CA-RF)

> **Can cellular automata seriously predict urban growth?** Yes — it is a mature,
> peer-validated field. SLEUTH, CA-Markov and modern **CA-RF / CA-XGBoost /
> ConvLSTM** hybrids routinely hindcast built-up expansion at **Kappa ~0.75 up to
> ~0.94–0.97**, with CA-RF among the strongest on spatial realism, validated with
> **Cohen's Kappa + Pontius Figure of Merit**. DigiPin implements the CA-RF
> variant, trained on its **own observed building history** rather than synthetic
> data — and, unlike most didactic notebooks, it **hindcast-validates** every run.

This is a **separate layer** from the SSP projection (the coarse 1 km
scenario-based `futureExpansion`). SSP answers "what do global scenarios imply for
this 1 km cell"; CA-RF answers "given *this city's* recent expansion and local
geography, where does built-up land most likely appear next, at ~100 m".

## Pipeline

| Stage | File | What |
|---|---|---|
| Drivers | `pipeline/growth/ca_drivers.py` | Build the (H,W,K) driver stack aligned to the temporal-COG grid |
| Model + sim | `pipeline/growth/urban_ca_ml.py` | RF transition potential → Markov demand → neighbourhood CA → COG, with hindcast |
| Tests | `pipeline/growth/tests/test_urban_ca_ml.py` | Pure helpers + an RF hindcast smoke on a synthetic landscape |

### Inputs

- **Built-up history** — `data/growth/buildings_temporal_2016-2023_<region>.tif`
  (8 bands, presence 0..1 per year; from `download_temporal_gcs.py`). A cell is
  "urban" when presence ≥ 0.5.
- **Drivers** (each min-max normalized to 0..1, aligned to the temporal grid):
  - **slope** (degrees) from a Copernicus GLO-30 DEM mosaic (`regions.dem_tile_urls`)
  - **distance-to-roads** — `data/vectors/osm_roads_<region>.geojson` rasterized →
    `scipy.ndimage.distance_transform_edt`
  - **distance-to-water** — `osm_water_<region>.geojson`, same
  - **population** — `data/growth/ghsl_pop_2020_<region>.tif`
  - **night-lights** — latest band of `viirs_2016-2024_<region>.tif`
  - Missing inputs degrade to a zero layer, so the model still trains on whatever
    drivers exist. Spatial **contiguity** is enforced separately by the CA's 3×3
    neighbourhood term, not a distance-to-built driver.

### Method (the standard CA-RF hybrid)

1. **Transition potential** — a `RandomForestClassifier` (200 trees, depth 12,
   `class_weight="balanced"`) trained on cells **non-urban at t0**, labelled by
   whether they urbanized by t1; features = the driver stack. `predict_proba` →
   per-cell potential surface (already-urban cells forced to 0).
2. **Demand** — a Markov estimate: the mean count of newly-urbanized cells per
   year over the observed record.
3. **Allocation** — each yearly step, score = `potential × (1 + 0.5 ×
   neighbourhood_fraction)`; urbanize the top-`demand` non-urban cells. Repeated to
   the horizon (default **2035**).
4. **Output** — `data/growth/ca_urban_prediction_<region>.tif`, 1 band,
   **P(urban by horizon) 0..1**, ~100 m, deflate-tiled (~1–2 MB) — the same
   small-COG contract `realtime-growth.js` already reads. Cells allocated sooner
   get higher probability; never-allocated cells keep a faint `potential × 0.4`
   signal.

### Hindcast validation (the credibility piece)

Every `run()` first trains on **2016→2020**, simulates 3 steps to **2023**, and
scores the prediction against the **observed** 2023 map:

- **Figure of Merit** (Pontius) on the *change* class — `hits / (hits + misses +
  false alarms)`.
- **Cohen's Kappa** on the full binary map.

Written to `data/growth/ca_validation_<region>.json` and logged. The UI/legend
frames the layer honestly as a **model projection, hindcast-validated** — not a
certainty. (On the synthetic landscape in the test suite the harness recovers
FoM ≈ 0.26; real per-region figures come from the actual run.)

## Activation (on a data-capable machine)

```sh
pip install -r pipeline/growth/requirements.txt        # adds scikit-learn, scipy
# prerequisites already produced by the existing pipelines:
#   data/growth/buildings_temporal_2016-2023_<region>.tif   (download_temporal_gcs)
#   data/growth/dem_<region>.tif, ghsl_pop_2020_<region>.tif, viirs_2016-2024_<region>.tif
#   data/vectors/osm_roads_<region>.geojson, osm_water_<region>.geojson
python -m pipeline.growth.urban_ca_ml --horizon 2035
```

Commit the small resulting `ca_urban_prediction_<region>.tif` (rename/symlink to
`data/growth/ca_urban_prediction.tif`, the path `realtime-growth.js` fetches).

## Browser consumption

- `js/realtime-growth.js` reads `COG_CA` → `ca_growth_prob` (0..1) on
  `result.realtime.growth`, plus `sources.ca_growth`. Independent of the SSP
  `future_expansion` signal.
- `js/real-estate-model.js` adds a **separate** `caGrowthPrediction` factor
  (supply group), up-weighted for the Invest/Build intents; `futureExpansion`
  (SSP) is untouched. Both drop gracefully to neutral when their COG is absent.
- `js/ca-growth-overlay.js` (`CAGrowthOverlay`, **"Predict"** toolbar button)
  viewport-samples cells and paints a sequential **purple** probability ramp with
  a legend — mirroring `GrowthOverlay`, but reading `ca_growth_prob`.

## Caveats

- A **projection**, not a forecast of certainty — report it with its hindcast
  FoM/Kappa. CA-RF captures *where* expansion is plausible given recent drivers; it
  does not model policy shocks, master-plan rezoning, or megaprojects.
- Trained per-region on ~8 years of history; longer/again as new temporal years land.
- 100 m grid (browser-fetchable) — a neighbourhood-scale read, not parcel-level.
- Heavy data (temporal + DEM/OSM/GHSL/VIIRS) means training runs on a data-capable
  machine; the pure CA/metric logic is unit-tested here on synthetic rasters.

## Interactive scenario lens (what-if planner)

The **Scenario** toolbar button (`btn-scenario` → `js/scenario-panel.js`) adds an
interactive *what-if* layer on top of the base CA-ML prediction. It samples the
viewport (same 5×5 / 400 m pattern as `CAGrowthOverlay`), applies a transparent
adjustment to each cell's base probability, recolours the cells, and reports the
aggregate delta (cells crossing the "likely" threshold up/down + mean shift).

**Honesty:** this is **not** a re-trained model run — regenerating the CA-RF
surface needs the offline pipeline (`pipeline/growth/urban_ca_ml.py`) and cannot
run in the browser. The lenses are simple, documented rules so a planner can
reason about *what would steer growth*; the panel is badged "illustrative lens on
the CA-ML base — not a re-trained run."

Lenses (`js/scenario-model.js`, pure + unit-tested in `tests/scenario-model.test.js`):

| Scenario | Rule |
|----------|------|
| Baseline | base probability unchanged |
| New transit hub (pick a point) | +25 pts at the clicked hub, fading linearly to 0 by 3 km |
| Protect flood-prone land | ×0.4 where `flood_risk` ≥ 60, ×0.7 where ≥ 40 |
| Curb urban-edge sprawl | ×0.5 where road density < 50 m, ×0.8 where < 150 m |

Per-cell inputs come from the already-fetched result: `ca_growth_prob`
(base), `scores.flood_risk`, and `realtime.traffic.road_density_m`. A future
upgrade can replace these heuristics with precomputed per-scenario COGs from the
pipeline (committed like the base prediction) for a faithful re-run.
