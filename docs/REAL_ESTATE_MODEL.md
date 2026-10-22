# Real Estate Growth Model (live)

`js/real-estate-model.js` (`RealEstateModel`) turns a cell's **live** data into a
growth-potential score, an estimated annual-appreciation band, and a ranked list
of drivers. It is the production-safe complement to the satellite-based
`GrowthScore`: that model needs Google Earth Engine COGs that aren't shipped, so
it returns null in the deployed app — this one runs on the OSM scores, building
morphology and live flood/air signals every cell already has.

## How it works

A transparent, hedonic-style multi-factor model. Each driver is oriented so
**higher = better for value**, scored 0–100, and given a weight whose *relative*
size reflects the empirical hedonic property-value literature:

| Group | Factors (weight) | Basis |
|---|---|---|
| **Demand** | transit/connectivity (1.0), jobs/commercial (0.9), walkability (0.8), green (0.6), schools (0.6), healthcare (0.4) | Rent-gradient & transit-premium studies; Walk Score capitalisation; urban-green premiums up to ~20% |
| **Supply / leading** | development potential / FSI headroom (0.9), construction pipeline (0.8), redevelopment scope (0.5), newer stock (0.3) | Unused development rights & active pipelines lead price growth |
| **Risk (discounts)** | flood safety (0.9), air quality (0.4), quietness (0.3) | Flood-zone discounts (~9% after events); pollution/noise discounts |

- **Score** = weighted average of available factors (0–100; neutral = 50).
- **Drivers** = each factor's signed contribution `weight × (value − 50)`, ranked
  — surfaced as "Drivers" (lift) vs "Drags" (pull-down).
- **Appreciation band** = a city baseline (~6%/yr, configurable) shifted by the
  score and widened by data confidence. It is a **relative** signal, not a price
  quote.
- **Confidence** = share of the 13 factors that had live data.

Flood safety prefers the live GloFAS `peak_ratio` (from `RealtimeFlood`), falling
back to the `flood_risk` score; air quality uses the live AQI reading.

## Where it shows

- **Cell panel** — the answer-first **🏠 Property Intelligence** card
  (`real-estate-widget.js`), inserted directly under the header. It fuses the
  three previously-scattered real-estate signals: the live outlook + drivers,
  the **Building Intelligence** built-form summary (with a link to the full
  dialog), and the satellite **Growth Forecast** folded in as a "Trajectory"
  sub-section — which gracefully degrades to the live model instead of showing
  an "unavailable" card when the satellite COGs aren't present.
- **DISHA** — an outlook line is injected into the assistant's context.

## Intent profiles (Live / Invest / Build)

`INTENT_PROFILES` re-weights the factors for who's asking; the panel exposes a
toggle that re-renders the verdict live:

| Intent | Emphasis |
|---|---|
| **Live** (homebuyer) | walkability, green, schools, healthcare, quiet, flood-safe; de-emphasises construction |
| **Invest** (default) | accessibility, jobs, construction pipeline, development potential |
| **Build** (developer) | development potential / FSI headroom, redevelopment scope, pipeline |

`balanced` (all multipliers = 1) is the model default, so `outlook(data)` without
an intent — including the DISHA context — is unchanged.

## Compare view

Pinning 2–3 cells (📌 Pin) and opening Compare shows a **verdict block at the
top** — each cell's growth score (best highlighted), outlook label and
appreciation band — above the per-score table and overlay radar.

## Calibrating to real prices

Two hooks make the model calibratable instead of purely heuristic:

1. **Per-city / per-locality baseline.** Set
   `window.DIGIPIN_CONFIG.realEstateBaselines = { "Indore": 9.5, "default": 5 }`
   (annual %); the appreciation band anchors to the cell's city, so the *level*
   reflects real local market data while the model supplies the *relative* tilt.

2. **`RealEstateModel.calibrate(samples, { ridge })`** — a ridge least-squares
   fit that learns factor weights from observed appreciation. Feed
   `[{ factors: { accessibility, walkability, … }, appreciationPct }]` built from
   locality price history (MagicBricks/99acres/PropEquity per
   `RESEARCH_INTEGRATION.md` §18) and it returns `{ intercept, weights, r2, n }`.
   Those learned weights can then replace the literature-based defaults.

## Research basis

The weights are ordinal (relative), grounded in hedonic-pricing findings rather
than fit to a transaction dataset (none is bundled). To calibrate to real prices,
feed locality price/appreciation data (MagicBricks/99acres/PropEquity per
`docs/RESEARCH_INTEGRATION.md` §18) and regress the factors to learn weights.

Sources:
- [Urban green space hedonic valuation (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S016920461300162X)
- [Urban green space & housing value (Taylor & Francis)](https://www.tandfonline.com/doi/full/10.1080/19498276.2024.2432758)
- [Neighbourhood services & land values, hedonic model (Springer)](https://link.springer.com/article/10.1007/s10708-019-10127-w)
- [House prices & flood-risk exposure (Springer)](https://link.springer.com/article/10.1007/s11146-022-09930-z)

## City-wide land value, supply and lenses (2026-10-22)

The per-cell `RealEstateModel` above scores one place at a time from live data.
The pipeline in `pipeline/realestate/` bakes the same ideas onto every L7 block
(~245 m) of all 13 cities, so they can be mapped, ranked and asked about.

**`land_value` (pipeline/realestate/land_value.py).** A hedonic land value
surface. Each block's value index is `100·exp(Σ premiums)`, re-centred so the
city's median home is 100. Premiums, in log points:

| Driver | Rule |
|---|---|
| Jobs | 0.35·ln(reach / city median), ±0.6; reach = 0.6·car + 0.4·transit share of jobs within 45 min (`job_access`) |
| Metro | +0.10 within a 6-minute walk, tapering to 0 at 20 minutes (`rail_access`) |
| Amenities | 0.08·ln((1 + POIs within ~1 km) / (1 + median)) (`osm_amenities`) |
| Neighbourhood | 0.20·(RWI − median) + 0.30·ln(average footprint / median), ±0.4 (Meta RWI, Open Buildings) |
| Green | 0.004 per point of canopy within ~500 m above the median, ±0.06 |
| Risk | −0.09 in the 1-in-100-year floodplain (≥30% of the block), −0.05 / −0.02 for very high / high waterlogging |
| Noise | −0.006 per dB of road noise above 60 dB Lden, at most −0.08 |

Each premium is also stored (`prem_*_pct`) so the map can show why a block is
dear. `data/realestate/anchors.json` holds NHB RESIDEX year-on-year growth per
city (Q3 FY26) for the level; the index supplies the spatial pattern.

**`re_supply` (pipeline/realestate/supply.py).** Floor area built 2016–2023
(new Open Buildings 2.5D Temporal buildings × average footprint × storeys),
construction intensity, vacant buildable land (WorldCover bare/grass/shrub in
the urban area, outside water, floodplain and parks), FAR now (GHSL volume ÷
3 m) and headroom under each city's typical base FAR.

**Delhi check (pipeline/realestate/calibrate.py).** Delhi's colonies are
categorised A–H for circle rates (2014 revision: ₹7.74 lakh/m² for A down to
₹23,280 for H). 244 colonies from the MCD colony list were placed on the map by
name (Overture divisions, then OpenStreetMap; names that match several far-apart
places are dropped) into `data/realestate/delhi_colonies.geojson`. Their value
index ranks with **Spearman 0.67** against the category rate. Refitting the
seven premiums by cross-validated ridge regression did not beat the
literature weights (0.65), so the weights stand. The index is mapped to rupees
by rank matching at the colony deciles (`calibration.knots` in
`data/realestate/delhi.json`): 77% of colonies land within 2× of their own
category rate. Circle rates are government floors that lag the market,
furthest in the dearest colonies.

**Lenses (js/urban-lenses-realestate.js).** `landvalue` (spread and drivers,
₹ circle-rate equivalent in Delhi), `buildhot` (construction hotspots, share
near metro and on risky land), `vacant` (vacant land ranked by value, homes at
base FAR), `rentdemand` (job reach high relative to land value), `affordability`
(land value rank minus wealth rank; displacement pressure) and `undervalued`
(access rank minus value rank plus momentum, no flood flag). DISHA routes
questions on land prices, circle rates, rent, displacement, vacant land,
construction and "where should I invest" to them. Buildings can be coloured by
`land_value:value_index` in 3D (Building data panel, or `bc=` in a share link).

**`building_dynamics` (pipeline/realestate/building_dynamics.py, Earth Engine).**
When and how fast each block was built, from the building prediction datasets:
Open Buildings 2.5D Temporal yearly counts and heights 2016–2023 (median build
year, construction acceleration relative to the city's median block, height
change), World Settlement Footprint Evolution 1985–2015 (year first settled),
GHSL built-up 1975 / 2020 and its 2030 projection, GHSL 2018 building-height
and use classes (high-rise and non-residential shares) and Dynamic World
built-area probability 2023→2026 (construction since the last Open Buildings
year). Lenses `redevelop` (older blocks getting taller) and `nextgrowth`
(projected gain + recent building + pace) read it, and buildings can be
coloured by `building_dynamics:settled_year` in 3D. The model's later years
detect more buildings, so raw acceleration runs above 1 city-wide; the stored
ratio is relative to the city's median block.

Rerun after the traffic and access datasets:
`python -m pipeline.realestate.building_dynamics --region all && python -m pipeline.realestate.land_value --region all && python -m pipeline.realestate.supply --region all && python -m pipeline.realestate.calibrate`.

### Development feasibility (`feasible` lens)

This is a residual valuation for every block. It asks what a developer can pay for land and still build at the city's base FAR.

- **Sale price.** The sale price per m² is the city-average new-home price (`PRICE_SQFT` in js/urban-lenses-realestate.js) multiplied by the block's value index ÷ 100.
  - The top seven cities use ANAROCK Q3 2025 figures.
  - Ahmedabad, Jaipur, Lucknow, Indore, Bhopal and Guna use rough placeholders, and the lens says so. Replace them when licensed market data arrives.
- **Residual land value.** This is sales minus build cost minus developer margin:
  - Sales: FAR area × 1.25, the loading to saleable area.
  - Build cost: FAR area × 1.4 for parking and services, at ₹22,000/m² (CPWD), plus 15% soft costs.
  - Taller buildings cost more: add 3% for each storey above four. Storeys = FAR ÷ 50% ground cover. Because of this, FAR 4 can lose money on cheap land.
  - Developer margin: 20% of sales.
  - At FAR ≤ 2 the break-even price is about ₹3,300 per sq ft. It rises with FAR above that.
- **Rebuild gain.** This is the residual value minus the existing floor area (GHSL volume) sold as old stock at 60% of the new price. It only counts for built-up blocks, meaning FAR ≥ 0.5 today.
- **TOD uplift.** This is the extra residual value at FAR 4 within a 10-minute metro walk, following the MoHUA TOD policy. It is summed over vacant buildable land.
- **Where it shows.** The property report has a "Development feasibility" section. DISHA answers questions like "is development feasible in Pune" or "residual land value in Delhi".
- **FAR what-if.** DISHA answers "what if FAR were 3 here" for a clicked block (`UrbanLenses.farAsk`/`farText`). The answer covers the residual value at the asked FAR against the base FAR, the rebuild case, extra homes per hectare, and whether the block sits in a TOD zone.
- **Results at the base FAR:**
  - Delhi: building pays in 86% of blocks, and the median residual is about ₹83,000/m².
  - Mumbai: building pays in 100% of blocks, at about ₹3.4 lakh/m².
  - Guna: building pays in only 1.5% of blocks. Apartments do not pay there at current prices, which matches its plotted-house market.

### Encroachment watch (`encroachment` dataset, `encroach` lens)

pipeline/realestate/encroachment.py measures, per L7 block:

- **Lost surface water** (JRC GSW transitions 3/6, 1984–2021), and how much of it is built up now (Dynamic World built class most likely, 2025–26).
- **New building footprint in the GloFAS 1-in-100-year floodplain.** Open Buildings Temporal presence must be ≥ 0.5 in 2023 and < 0.2 in 2016.
- **Hansen tree-cover loss** (≥ 30% canopy in 2000, lost 2001–2024), and how much of it is built up.
- **Building since 2023** on any of the above. The built probability must be ≥ 0.6 now and ≤ 0.3 in 2023.

For "built since 2023", the probability thresholds replaced a "most-likely label in both years" test. That test flagged whole built-up blocks as "100% built since 2023", because Dynamic World labels flicker. Delhi dropped from 2,903 ha to 43 ha.

Results:
- Former water now built up: Chennai 286 ha, Delhi 109 ha, Mumbai 44 ha, Bengaluru 37 ha.
- New floodplain footprint 2016→2023: Delhi 1,496 ha. GloFAS ignores the Yamuna embankments, so read this as building on the natural floodplain.

To bake every city, run `python -m pipeline.realestate.encroachment --region all`. Delhi takes about 40 minutes because of the 4 m Open Buildings pass.

### Upcoming metro uplift (`metro_future` dataset, `metroboost` lens)

pipeline/realestate/metro_future.py reads Wikidata metro stations in India: 916 stations, of which 72 are under construction and 3 are proposed, with opening dates for 841. The snapshot is saved in data/realestate/metro_stations.json; `--refresh` re-queries it.

**Upcoming stations.** These are stations under construction or proposed, plus stations opened since 2025 that the Overture station layer may lack. Each block's walk to the nearest one goes into the land-value model's metro premium, and the dataset stores the gain.

Coverage depends on Wikidata. Bengaluru, Chennai, Kolkata, Mumbai, Indore and Bhopal are well covered. Delhi Phase 4 is mostly missing.

**Did past stations draw building?** The test compares floor area added 2016–2023:

- Treated blocks: within 800 m of stations opened 2017–22.
- Comparison blocks: 1.5–3 km from the same stations.
- Both groups had no older station within 2 km.

Across 9 cities, 5,364 blocks near new stations added **1.00× (±0.03)** the floor area of 8,834 comparison blocks. Height change and Dynamic World built-up change show no effect either. The result is in data/realestate/metro_effect.json.

Under base FAR, stations raised access but did not densify their surroundings. That is the case for the TOD FAR in the feasibility lens.

Results: in Bengaluru, 8.2 lakh residents in 723 blocks come within a 10-minute walk, adding about ₹95,600 crore to existing property. In Indore, 36,700 residents in 190 blocks gain.
