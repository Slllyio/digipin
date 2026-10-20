# How DigiPin scores work — methodology

DigiPin is India-native by design: it scores locations on the **government
DIGIPIN grid** using Indian civic and OpenStreetMap data, runs entirely in the
browser on free, static infrastructure, and exposes every formula for audit. It
is not a closed Western GIS product — there are no per-seat licences and nothing
is hidden behind a server.

This document explains exactly how every intelligence score is computed, what
data feeds it, how fresh that data is, and where the method has limits. It is the
authoritative reference for anyone who wants to audit or reproduce a number. The
scoring code is the source of truth: `js/data-fetcher.js` (`computeScores`) in
the browser and its parity-pinned Python port `pipeline/scores/composite.py`
(both produce identical values — enforced by golden-fixture tests in CI).

## The cell model

Every location resolves to a **DIGIPIN cell** — a fixed grid square from the
DIGIPIN addressing scheme. Levels used: **6 ≈ 244 m**, **7 ≈ 61 m**. Features are
counted within a **400 m disc around the cell centre** (the live app uses an
Overpass `(around:400)` query; the precompute pipeline reproduces the same disc).
A 400 m disc (~50 ha) is the neighbourhood a person experiences on foot, which is
why every count is calibrated to it rather than to the cell rectangle.

## Data sources and vintage

| Signal | Source | Vintage / refresh |
|--------|--------|-------------------|
| POIs / amenities / buildings / roads | OpenStreetMap (live Overpass, or a monthly precomputed extract) | live, or ≤ 1 month |
| Population density | GHSL GHS-POP (100 m) | 2020 epoch |
| Elevation (flood) | Copernicus GLO-30 DEM, or open-elevation (live) | static |
| Weather | Open-Meteo | live, 1 h cache |
| Air quality | CPCB (data.gov.in) → WAQI → Open-Meteo | live, 1 h cache |
| EV charging | OpenChargeMap | live |

When scores are served from **precomputed tiles** (`data/scores/`), the OSM
vintage is the monthly extract; population/elevation come from the rasters above.
When served **live**, OSM is real-time Overpass. The scores are computed the same
way either way — only the data source differs.

## The normaliser

Most scores are a weighted sum of feature counts passed through a logarithmic
normaliser so the first few amenities matter most and saturation is graceful:

```
normLog(value, anchor) = min(100, round(100 · ln(1+value) / ln(1+anchor)))   (0 if value ≤ 0)
```

`anchor` is the count that maps to ~100 (calibrated per score for a 400 m disc).
All scores are integers in **0–100**.

## The scores

Each line below is the exact formula (feature counts in a 400 m disc).

- **Walkability** = normLog(restaurants·2 + cafes·2 + convenience·2 + supermarket·2 + bus_stop·3 + parks·3 + footpath·1.5 + toilets·2, **80**)
- **Safety** = clamp₀–₁₀₀( normLog(street_lamps·2 + police·15 + fire·12 + hospitals·5, 100) + min(15, normLog(buildings·0.1 + footpaths·2, 30)) − industrial·8 − nightclubs·3 )
- **Green** = normLog(parks·8 + garden·5 + playground·3 + water_body·4 + nature_reserve·15 + dog_park·3, 80)
- **Connectivity** = normLog(bus_stop·3 + metro·20 + railway·15 + parking·2 + bicycle_rental·5 + roads·0.3, 100)
- **Commercial vibrancy** = normLog(mall·15 + supermarket·5 + restaurants·2 + offices·3 + marketplace·8 + department·10 + convenience·1, 120)
- **Education** = normLog(schools·5 + colleges·10 + universities·20 + libraries·8 + kindergartens·3, 80)
- **Healthcare access** = normLog(hospitals·12 + clinics·3 + pharmacies·1.5 + lab·5 + dentists·3 + nursing_home·8, 100)
- **Entertainment** = normLog(cinema·8 + parks·3 + gym·4 + nightclub·6 + museum·10 + theatre·8 + sports_centre·5, 80)
- **Investment potential** = normLog(construction·12 + vacant·8 + bus_stop·2 + metro·20 + coworking·8 + estate_agent·10, 100)
- **Tourism appeal** = normLog(hotel·5 + monument·8 + museum·10 + attraction·8 + restaurants·1 + guest_house·3 + worship·2, 80)
- **Infrastructure maturity** = normLog(street_lamps·0.5 + cell_tower·8 + power·5 + post_office·8 + roads·0.2 + bridge·10, 100)
- **Quietness** (higher = quieter) = 100 − normLog(roads·0.3 + bus_stop·4 + railway·15 + metro·8 + industrial·12 + nightclub·6 + marketplace·5 + fuel·3 + cinema·2 − parks·3 − garden·2 − nature_reserve·5, 80)
- **Population density** = normLog(personsPerHectare, 500) from GHSL; falls back to a building-density proxy where GHSL is absent
- **Food diversity** = normLog(Σ food-venue types, 40)
- **Religious diversity** = Shannon evenness × richness over `place_of_worship` religions (richness capped at 4 distinct), with a discounted count-only fallback when religions are untagged
- **Public service access** = normLog(post_office·8 + govt_office·8 + community·5 + toilets·3 + townhall·10 + social·5, 60)
- **Real-estate growth** = normLog(construction·15 + vacant·10 + estate_agent·12 + ev_charging·8, 80) — blended with building-morphology metrics when available
- **Digital readiness** = normLog(cell_tower·8 + coworking·12 + it_company·10 + ev_charging·6 + electronics·3 + mobile·3, 80)
- **Flood risk** (higher = riskier) = clamp₀–₁₀₀( 30 + elevation_term + water_body·8 + river·12 − bridge·5 − power·2 + industrial·5 ), where elevation_term = +25 if low-lying, +10 if below its surroundings, −15 if a ridge (> 5 m above)
- **Livability** = weighted average of walkability·2, safety·3, green·2, connectivity·1.5, healthcare·2, quietness·1.5, food_diversity·1

(Growth forecast and urban-heat scores come from separate raster models —
`pipeline/scores/growth.py`, `heat.py` — when those rasters are loaded.)

## Known limitations

Read the numbers as **relative indicators**, not survey-grade ground truth.

- **OSM completeness varies.** Scores reflect what is mapped in OpenStreetMap;
  under-mapped areas score lower than reality. Indian metros are well-mapped;
  peripheries less so.
- **Precompute relation gap (v1).** The precomputed counter counts OSM nodes and
  ways but not relations (some large multipolygon parks, rivers, and landuse
  areas), so those features can be slightly under-counted vs the live app. This
  is *measured*, not assumed — see `scripts/spot_check_parity.py`.
- **Quantization.** Precomputed counts bin feature positions to a ~15 m grid
  before the 400 m disc sum — a sub-metre effect on a 400 m radius.
- **Elevation source.** Live uses SRTM-derived open-elevation; precompute uses
  Copernicus GLO-30 (a surface model). The ±2 m low-lying threshold can differ
  near that boundary.
- **Population is 2020.** GHSL GHS-POP's latest published epoch.
- **Air quality is sparse.** CPCB/WAQI stations are city-level; a cell inherits
  the nearest station, not a cell-specific reading.

## Reproducing a score

1. Count features in the 400 m disc (OSM tags → feature keys via the classifier
   in `js/data-fetcher.js` / `pipeline/scores/osm_classify.py`).
2. Apply the formula above (`composite.py` / `computeScores`).
3. The two implementations are pinned to produce identical output by
   `pipeline/scores/golden/*.json` and the CI golden-freshness guard.
