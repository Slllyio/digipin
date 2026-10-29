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

## Climate 2050 (`climate_future`, lens `climate2050`)

Per L5 cell, from `pipeline/cells/ee_layers.py` (`--layer climate_future`). Delta method on a six-model NASA NEX-GDDP-CMIP6 ensemble (ACCESS-CM2, EC-Earth3, MIROC6, MPI-ESM1-2-HR, MRI-ESM2-0, NorESM2-MM): the 2041–2060 minus 1995–2014 change in March–June daily maximum and May–September daily minimum temperature is added to every ERA5-Land day of 2015–2024, then days ≥ 40 °C (IMD plains heatwave threshold) and nights ≥ 28 °C are counted. SSP2-4.5 is the central case; `hot_days_2050_high` uses SSP5-8.5. The wettest-day change is the ensemble ratio of the mean annual maximum one-day rainfall, applied to CHIRPS 2005–2024.

Resident-weighted, SSP2-4.5: Delhi 26 → 41 hot days and 17 → 43 warm nights; Ahmedabad 35 → 58 hot days; Chennai 35 → 85 warm nights; Mumbai's wettest day +9%. Models are ~25 km and reanalysis ~9 km, so this is a city-scale outlook: it misses the urban heat island, and ERA5-Land reads 1–2 °C below city stations, so absolute counts are low. The property report lists the block's numbers under Risk and flags 45+ hot days a year by 2050.

### Street heat 2050 (lens `streetheat`)

`climate_future` also stores how many extra days cross 40 °C (and nights cross 28 °C) per 1 °C of local warming, measured from counts at ±1 °C. It also stores cooling degree-days above a 24 °C daily mean, for now and for 2050.

The lens shifts the city's 2050 counts by each block's own heat island:

- By day, the offset is 0.3 × the Landsat surface anomaly (`surface_heat.uhi_anomaly_c`). Venter, Chakraborty & Lee 2021 find air heat islands run about a third of surface ones.
- At night, the offset is 0.6 × the MODIS night surface anomaly.
- Both offsets are centred on the resident-weighted mean, so they redistribute the reanalysis cell's warmth rather than add to it.

Results:

| City | Days ≥ 40 °C by 2050, hottest tenth | Coolest tenth |
|---|---|---|
| Delhi | 48 | 35 |
| Ahmedabad | 67 | 49 |

Cooling need rises about 25% in the hot plains cities and 82% in Bengaluru, from a low base. About 72% of the hottest tenth live under less than 5% tree canopy. Read the block values as a ranking: surface-to-air coupling varies with wind, humidity and street form.

## Flood 2050 (`flood_future`, lens `flood2050`)

This is an L6 cell dataset from `pipeline/cells/ee_layers.py --layer flood_future`. It uses WRI Aqueduct Floods v2 (~1 km) to give the share of each cell flooded more than 5 cm deep by the 1-in-100-year flood.

- **River flooding** comes from GLOFRIS. The 1980 baseline is compared with the mean of five CMIP5 models for 2050, under RCP4.5 and RCP8.5.
- **Coastal flooding** combines storm surge, sea-level rise and land subsidence for 2050, compared with 2010.

Residents in the zone, now → 2050:

| City | River or sea | Newly exposed | From the sea alone |
|---|---|---|---|
| Kolkata | 19.7 → 26.5 lakh | 6.8 lakh | 16.1 lakh by 2050 |
| Delhi | 53.4 → 61.2 lakh | — | — |
| Ahmedabad | 4.9 → 9.1 lakh | — | — |
| Mumbai | 44.3 → 45.7 lakh | — | 3.3 lakh by 2050 |

Aqueduct models no defences or drains, and at 1 km it reads well above the GloFAS floodplain. For example, it puts 63% of Chennai residents in the zone. Use it for the change to 2050 more than for the level. The property report shows the block's share under Risk.

## Home solar (lens `solarhome`)

This lens works out rooftop solar for each household, as a companion to the city-wide `solar` lens.

**Method**

1. **Roof per home.** Building cover × cell area × 30% usable roof, divided by the number of households (residents ÷ 4.3).
2. **System size.** 10 m² of roof per kW, capped at 3 kW. Homes with room for less than 1 kW are counted as having too little roof and are pointed to society or community solar.
3. **Payback.** (₹60,000 a kW − the PM Surya Ghar subsidy) ÷ (yield × ₹7/kWh). The subsidy is ₹30k a kW up to 2 kW, plus ₹18k for the third kW, capped at ₹78k.
4. **AC cover.** Annual output compared with one AC at 1.2 kWh per cooling degree-day in 2050, which is close to BEE's 1,600-hour label in Delhi.

**Results**

| City | Residents with room for at least 1 kW | Median payback | Residents whose roof share could run one AC through a 2050 summer |
|---|---|---|---|
| Delhi | 57% | about 3.2 years | 39% |
| Mumbai | 6.5% | — | — |
| Guna | 82% | — | — |

The property report has an Energy section with the home's kW, payback and AC cover.

## Water risk (`water_risk`, lens `waterrisk`)

`water_risk` is an L5 cell dataset built by `pipeline/cells/ee_layers.py --layer water_risk` from WRI Aqueduct 4.0 sub-basin polygons, rasterised and averaged per cell. It holds:

- Baseline water stress and depletion (PCR-GLOBWB 2, 1979–2019).
- Groundwater table decline (1990–2014 trend).
- Drought risk.
- District access to drinking water and sanitation.
- 2030 and 2050 stress under business-as-usual, optimistic and pessimistic futures.

Aqueduct's future runs use different models from its baseline, so compare 2030 with 2050, not today with 2050.

What the data shows:

| City | Basin withdrawals vs renewable supply | Groundwater decline |
|---|---|---|
| Delhi | 11.2 times | 12.9 cm a year |
| Jaipur | 10.7 times | 8.3 cm a year |
| Chennai | 1.5 times | not available |
| Bengaluru | 64% | not available |
| Mumbai | 12% | not available |

Basins are large, so this is a city-level outlook. The property report lists water stress and groundwater decline under Risk, and flags groundwater falling 10 cm or more a year.

## Climate 2050 grade (lens `climategrade`)

**Score** = 100 × (0.40 × heat + 0.35 × flood + 0.25 × water). Each part runs from 0 to 1 on a fixed scale, so blocks and cities compare directly.

- **Heat** = 0.5 × (days at 40 °C or more by 2050, taking the block's own heat island into account; 60 days scores 1) + 0.3 × (nights at 28 °C or more; 90 nights scores 1) + 0.2 × (today's humid-heat days with a wet-bulb of 28 °C or more; 60 days scores 1).
- **Flood** = the share of the block inside the 1-in-100-year river or sea flood zone by 2050, from WRI Aqueduct.
- **Water** = 0.7 × (basin water stress by 2050; 100% scores 1) + 0.3 × (groundwater decline; 15 cm a year scores 1).

**Grades:**

| Grade | Score |
|---|---|
| A | under 20 |
| B | 20–35 |
| C | 35–50 |
| D | 50–65 |
| E | 65 or more |

**Average resident:**

| City | Grade (score) | Main driver |
|---|---|---|
| Chennai | D (57) | flood |
| Ahmedabad | D (54) | heat |
| Delhi | D (52) | water and heat |
| Kolkata | B (22) | heat |
| Mumbai | A (16) | flood |
| Bengaluru | A (12) | water |

The reanalysis rarely reaches a 28 °C wet-bulb on the coast, and drainage is not in the score, which flatters Mumbai and Kolkata. The weights are a judgement call, not a calibration. The property report shows the block's grade and flags grades D and E.

## Risky growth (lens `riskygrowth`)

This lens checks whether new building is going into land that will flood by 2050.

**Method**

1. Take the new floor area built 2016–2023 (`re_supply.new_floor_m2`).
2. Weight it by each block's share of the 2050 1-in-100-year flood zone (WRI Aqueduct).
3. Divide by the share of all land in that zone to get the tilt. Above 1, new building leans toward flood land; below 1, it avoids it.

The lens also reports floor area in climate grade D/E blocks and GHSL's projected built-up gain 2020→2030 inside the zone.

**Results**

| City | New floor area in the 2050 flood zone | Share of land in the zone | Tilt |
|---|---|---|---|
| Chennai | 66% | 53% | 1.26× |
| Delhi | 19% | 24% | 0.82× |
| Kolkata | 29% | 40% | 0.73× |
| Mumbai | 21% | 29% | 0.73× |

In Chennai, 71% of the built-up land GHSL projects to 2030 also falls in the zone.

Bengaluru has almost no land in Aqueduct's zone. Its flooding comes from drains and lakes, which the Waterlogging lens covers.

## Businesses and services (`places`, lens `vitality`)

`pipeline/realestate/places.py` counts Overture Maps places in each L7 block. It reads the places theme with DuckDB, keeps places with confidence ≥ 0.6 that are not marked closed, and groups them with Overture's level-1 taxonomy:

- **Groups:** food, shopping, services, health, education, lodging, leisure, culture, community and transport.
- **Keyword counts:** offices, finance and real-estate agents.
- **Brand share** and **business mix** (Shannon evenness).

All 13 cities hold about 6.7 lakh places, of which Delhi has 1.46 lakh. The data takes about 0.9 MB.

The `vitality` lens reports:

- **High streets:** the top 2% of blocks by number of places.
- **Chain share and office counts.**
- **Retail gaps:** places where fewer shops and eateries lie within 1 km per 1,000 residents than a quarter of the city median, and at least 2,000 people live within 1 km.

| City | Residents in retail gaps |
|---|---|
| Delhi | 33.7 lakh (11%) |
| Bengaluru | 8.7 lakh |
| Mumbai | 6 lakh |

Overture follows online listings, so informal markets are under-counted. Treat gaps as leads to check on the ground.

The property report lists the block's businesses under Neighbourhood. The bake runs in the precompute-cells workflow.

## Satellite embeddings: what changed, and places that look alike

`pipeline/cells/embeddings.py` builds the L7 dataset `embeddings` from Google's Satellite Embedding V1, which comes from the AlphaEarth Foundations model. The model summarises each 10 m pixel's year of optical, radar, thermal, terrain and climate data as 64 numbers.

The dataset has two kinds of field:

- **Look-alike components:** the first 12 principal components of each block's mean 2025 embedding. One PCA is fitted across all 13 cities, so blocks in different cities compare directly. The 12 components hold 91% of the variance.
- **Change:** `change_8yr` and `change_2yr` are 1 − cosine similarity between the block's mean embedding in 2017 (or 2023) and 2025.

The build runs in two steps. `fetch` caches each city's 64-number means in `data/cache/embeddings`, which git ignores. `write` fits the PCA and writes the store, about 4.7 MB in total.

### The `change` lens ("What changed")

Rain and haze vary from year to year, so a block counts as changed strongly when it moved at least 3 times as far as the city's median block. Each hotspot is labelled with the likely cause, checked in this order:

1. New buildings, from Open Buildings for 2016 to 2023.
2. Water, bare ground or cropland, from ESA WorldCover.
3. Tree canopy.

| City | Strongly changed since 2017 | Share of that land with 20+ new buildings |
|---|---|---|
| Delhi | 139 km² (5.2% of blocks) | 17% |
| Bengaluru | 50 km² | 42% |
| Pune | 31 km² | 68% |
| Chennai | 23 km² | 26% |

Chennai's top hotspots are water bodies whose extent changed. Delhi's are along the Dwarka Expressway, plus farmland on the fringe.

### "Looks like this from space"

`UrbanLenses.lookalike` finds the blocks of any city whose 12 components lie nearest the clicked block. DISHA answers questions like "find places that look like this from space in Mumbai".

Connaught Place matches Churchgate, Fort and Colaba in Mumbai. It also matches Saket and the Rajouri Garden and Janakpuri belt in Delhi.

This matches physical form only. The existing "places like this" search matches on price, access and wealth, so the two complement each other.

## Humid heat 2050 (wet-bulb)

The `humid_future` dataset is at L5 and built by `pipeline/cells/ee_layers.py --layer humid_future`. For every ERA5-Land day from 2015 to 2024, it calculates the afternoon wet-bulb temperature (Stull 2011). It then shifts the same days by the six-model CMIP6 change in March–September maximum temperature and relative humidity.

It counts days with a wet-bulb of 28 °C or more, and of 31 °C or more. Vecellio et al. 2022 found that, at around 31 °C, healthy young people can no longer shed heat.

| City | Humid-heat days now | 2050, SSP2-4.5 | 2050, SSP5-8.5 | Peak wet-bulb 2050 |
|---|---|---|---|---|
| Kolkata | 42 | 124 | 143 | 31.2 °C |
| Chennai | 20 | 69 | 95 | 30.4 °C |
| Lucknow | 14 | 67 | 85 | 30.5 °C |
| Delhi | 12 | 57 | 74 | 30.4 °C |
| Ahmedabad | 2 | 42 | 61 | 29.9 °C |
| Mumbai | 2 | 25 | 43 | 30.0 °C |
| Jaipur | 0 | 20 | 31 | 29.5 °C |

The 28 °C threshold sits near the monsoon's usual afternoon peak, so small shifts move the counts a lot. Treat the counts as direction and scale, not exact numbers.

The `climate2050` lens now reports humid-heat days. The Climate 2050 grade now uses the 2050 count instead of today's, so humid cities grade worse than before.

## Air trend

The `air_trend` dataset is at L6 and built by `pipeline/cells/ee_layers.py --layer air_trend`. It holds:

- Sentinel-5P tropospheric NO₂ annual means for 2019 and 2025, and the change between them.
- Satellite PM2.5 (V6.GL) for 2012 and 2022.
- The 2025 SO₂ column.

The `airtrend` lens weights each block by its residents. Changes under 10% count as flat. It names SO₂ hotspots only above 100 µmol/m².

| City | NO₂ 2019 → 2025 | PM2.5 2012 → 2022 |
|---|---|---|
| Delhi | −16% | 99 → 94 µg/m³ |
| Bengaluru | −16% | 30 → 37 µg/m³ |
| Kolkata | flat | 59 → 47 µg/m³ |
| Lucknow | flat | 84 → 88 µg/m³ |

In Delhi, NO₂ fell in the core and rose on the western fringe.

## Cool roofs

The `roofs` dataset is at L7 and built by `pipeline/cells/ee_layers.py --layer roofs`. It takes the March–May Sentinel-2 broadband albedo (Liang 2001) over 10 m pixels that are mostly roof in Open Buildings 2023.

Each pixel blends a roof with its parapets, tanks and shade, so values bunch around 0.18 to 0.25. The thresholds are set for that: dark means under 0.17, and light means 0.25 or more.

The `coolroof` lens reports:

- Dark roof area and the residents under it.
- The cost to coat every dark roof, at about ₹300/m².
- A priority score: residents × dark share, weighted up for hot blocks, poor blocks (Relative Wealth Index below 0) and low-rise blocks.

| City | Roof area that reads dark | Residents under dark roofs | Cost to coat |
|---|---|---|---|
| Kolkata | 86% | 1.2 crore | ₹2,495 crore |
| Mumbai | 65% | 1.1 crore | ₹1,270 crore |
| Chennai | 10% | 10 lakh | ₹354 crore |
| Ahmedabad | 6% | 4.6 lakh | ₹147 crore |

In humid cities, concrete weathers dark. Ahmedabad has 42% light roofs, partly thanks to its cool-roof programme.

## Open burning

The `fires` dataset is at L6 and built by `pipeline/cells/ee_layers.py --layer fires`. It counts NASA VIIRS 375 m active-fire detections from September 2023 onward, nominal or high confidence only.

| Field | Meaning |
|---|---|
| `fire_days_yr` | Days a year with a fire at the block's most-burned spot |
| `winter_fire_days_yr` | The October–February part of that count |
| `fire_mw_yr` | Fire radiative power summed over the block |

The `burning` lens sorts blocks into two groups:

- **Frequent burning:** 3 to 30 fire days a year.
- **Steady heat sources:** more than 30 days a year. These are almost always furnaces or kilns, so the lens lists them separately.

It also counts residents within 1 km of frequent burning, and uses WorldCover to label the likely cause: crop land, bare ground, or built-up land.

| City | Residents within 1 km of frequent burning | Fire days in October–February |
|---|---|---|
| Delhi | 10 lakh | 55% |
| Ahmedabad | 7.2 lakh | 80% |
| Chennai | 3.7 lakh | 60% |
| Indore | none | |

## Ground conditions

The `subsoil` dataset is at L7 and built by `pipeline/cells/ee_layers.py --layer subsoil`. It holds OpenLandMap clay at 60 cm and 1 m, and bulk density at 60 cm.

The `ground` lens flags three issues per block:

- **Expansive black cotton clay:** 40% or more clay at 60 cm.
- **Low-lying, waterlogging-prone land:** a waterlogging index of 50 or more. Where that index is missing, land under 1 m above the nearest drain (HAND).
- **Steep land:** a slope of 10° or more.

It also gives the city's seismic zone from IS 1893 (Part 1): 2016, Annex E: Delhi IV; Mumbai, Kolkata, Chennai, Pune, Ahmedabad and Lucknow III; the rest II.

| City | Land on expansive clay |
|---|---|
| Pune | 91% |
| Guna | 80% |
| Indore | 76% |
| Chennai | 61% |
| Kolkata | 57% (soft clay with high settlement risk; 48% is also wet) |
| Delhi, Jaipur, Lucknow | 0% |

The property report shows the clay at 60 cm and the seismic zone, and flags expansive clay as a risk. Soil maps are model predictions under cities, so treat them as a reason to test the soil, not as test results.

## Plant trees here

The `treeplant` lens works out each lived-in block's canopy gap. The target is 30% tree canopy, from the 3-30-300 rule. It converts the gap into trees, assuming about 50 m² of crown per mature tree.

It then checks how many of those trees fit on half of the block's grass, shrub and bare ground. Priority goes to blocks with room for trees that are also hotter than the average home and have many residents.

| City | Trees needed | Fit on the blocks' own open ground |
|---|---|---|
| Delhi | 89 lakh | 17 lakh (19%) |
| Bengaluru | 46 lakh | 12 lakh (27%) |
| Chennai | 24 lakh | 2.8 lakh (12%) |

The trees that don't fit need street trees, rooftop and courtyard planting, or parks on reclaimed land.

## Where the jobs are

The `jobsmap` lens estimates jobs per block. It starts from the city total, which is residents × 35.3%, the Census 2011 urban work participation rate. It assumes the city has as many jobs as resident workers.

It spreads that total over blocks using two weights of equal size:

- **Floor space:** the block's share of non-residential floor area. This is GHSL built volume × the non-residential share ÷ 3.5 m per storey.
- **Businesses:** the block's share of Overture places.

The lens then compares jobs with resident workers within 3 km. Below 0.5 jobs per worker counts as a bedroom area, and 1.5 or more as job-rich.

| City | Jobs in the busiest tenth of blocks | Residents in bedroom areas |
|---|---|---|
| Delhi | 56% | 96 lakh (33%) |
| Bengaluru | 53% | 71 lakh (54%) |
| Mumbai | 44% | 8 lakh (5%) |

The property report shows the jobs-to-workers ratio within 3 km.

## Flood: the 2080 view

The `flood_future` dataset now also holds 2080 fields: `any_pct_2080`, `river_pct_2080`, `coast_pct_2080` and `coast_pct_2080_high`. They come from Aqueduct Floods, under RCP4.5 with subsidence, plus RCP8.5 for the coast.

The `flood2050` lens adds a long-view line. Kolkata goes from 26.5 lakh residents in the flood zone by 2050 to 36.3 lakh by 2080, and 30.5 lakh of those are at risk from the sea.

## Lake health

The `lakes` dataset is at L7 and built by `pipeline/cells/ee_layers.py --layer lakes`. It uses Sentinel-2 dry-season (Feb–Apr) medians for 2019 and 2025, and holds:

- **Open water:** MNDWI above 0.2.
- **Chlorophyll index (NDCI) and turbidity (NDTI):** measured over clear water only.
- **Weeds:** the share of 2019 water that is now vegetation.

The `lakehealth` lens joins water blocks that touch into lakes. It then flags each lake for three problems:

- **Lost water:** 20% or more of its open water gone since 2019.
- **Algae:** NDCI of 0.1 or more.
- **Weeds:** 30% or more of its 2019 water surface choked.

In Bengaluru, it maps 66 lakes. Of these, 41 are algae-rich, 16 are choked by weeds and 12 have lost a fifth or more of their water. About 5.4 lakh people live within 500 m of a lake with at least one problem.

## Farmland at the edge

The `farmland` dataset (L7) uses the Dynamic World V1 yearly mode label at 10 m for 2018 and 2025. It records three things per block:

- the share that reads as crops in each year;
- the share that was crops in 2018 and is built-up in 2025;
- the 2025 built-up share.

The `farmloss` lens adds these up into farmland turned built-up since 2018. It also marks the active edge: blocks still 30% or more crops that are already 20% or more built. Finally, it weights each block's remaining farmland by the CA-ML growth model's projected urban share for 2035.

Dynamic World counts roads and cleared, plotted land as built-up. In Bengaluru and Pune, the blocks that lost the most farmland had only 4–5% roof cover in Open Buildings 2023, so much of the converted land is plotted layouts that are not yet built.

Farmland turned built-up, 2018 to 2025:

| City | Built-up area | Share of 2018 farmland |
|---|---|---|
| Bengaluru | 47 km² | 41% |
| Jaipur | 33 km² | 38% |
| Pune | 27 km² | 27% |
| Lucknow | 26 km² | 28% |

## Property market activity

The `market` lens counts estate agents, brokers and property dealers within 1 km of each block. It uses the `property_agents` count from the Overture places data. Agents cluster where deals happen, so the count works as a proxy for transaction activity, not for prices.

Busy markets are the top 10% of blocks by this count. Emerging markets are busy blocks whose land value index is still below the city median.

How closely agent density tracks the land value index (Spearman ρ): Bengaluru 0.56, Pune 0.49, Mumbai 0.34, Delhi 0.28. Delhi's agents are concentrated: 42% of them sit in the busiest 1% of blocks.

## What the haze is made of

The `haze_mix` dataset (L5) is built from CAMS near-real-time analyses for 2025, which run on a grid of about 40 km. It holds:

- the mean aerosol optical depth;
- the shares of that depth from dust, smoke (black carbon plus organic matter), sulphate and sea salt;
- the mean dust optical depth before the monsoon;
- the number of days whose mean dust optical depth is over 0.3.

The `airtrend` lens and the property report show the mix. These figures are model output at city scale, not measurements, and nitrate and ammonium are not split out.

| City | Dust | Smoke | Sulphate | Dust-haze days a year |
|---|---|---|---|---|
| Delhi | 27% | 22% | 32% | 81 |
| Kolkata | 4% | 27% | 46% | 0 |

## Deaths from air pollution

The `airdeaths` lens estimates early deaths from PM2.5 with the Global Exposure Mortality Model (Burnett et al. 2018) for non-communicable and lower-respiratory disease. It uses each block's 2022 satellite-derived PM2.5 and a national baseline of 5 such deaths per 1,000 residents a year (GBD 2019 India).

| City | Early deaths a year | Share of these deaths | Deaths avoided if India's 40 µg/m³ standard were met |
|---|---|---|---|
| Delhi | about 59,000 | 40% | about 29,000 |
| Mumbai | about 24,000 | 27% | about 1,600 |
| Bengaluru | about 16,000 | 25% | about 10 |

GEMM sits at the high end of published estimates. One national baseline rate is used everywhere, so the map shows where air kills more, not local death records.

## Park space per resident

The `parks` dataset (L7, `pipeline/realestate/parks.py`) clips Overture Maps land use to each block. It keeps parks, gardens, recreation grounds, playgrounds, pitches, dog parks, village greens and commons. Overture takes these polygons from OpenStreetMap.

The `parkshare` lens works out park space per resident as a catchment ratio:

- the park area within 1 km of a block, divided by the residents within 1 km;
- compared against WHO's 9 m² per person and the 10–12 m² in India's URDPFI guidelines;
- plus whether a park of half a hectare or more lies within 300 m of home, the WHO Europe target.

Ridge forests, nature reserves and private or unmapped green are not counted.

| City | Park space per resident | Residents with under 2 m² each within 1 km |
|---|---|---|
| Delhi (NCR extent) | 2.0 m² | 71% |
| Bengaluru | 2.1 m² | 85% |
| Mumbai | 0.6 m² | 98% |
| Chennai | 0.6 m² | 96% |
| Ahmedabad | 0.3 m² | 98% |

## Mangroves

The `mangroves` dataset (L7) uses Global Mangrove Watch v3 extent polygons for 1996 and 2020, rasterised at 25 m. Of the 13 cities, only Mumbai's map extent reaches mangroves.

The `mangrove` lens covers four things:

- area then and now;
- the area lost since 1996;
- the blocks that lost the most;
- the residents within 1 km of mangroves, who get some shelter from storm surge.

Mumbai had 82.8 km² of mangroves in 1996 and 80.8 km² in 2020. 4.4 km² of the 1996 stands have gone, and regrowth elsewhere offsets most of that. 38 lakh residents live within 1 km of mangroves.

## Storm runoff

The `runoff` lens applies the SCS curve-number method to each block, using the wettest day of 2025 from CHIRPS. Each block's curve number is weighted by its ESA WorldCover land-cover shares, and its SoilGrids texture sets the hydrologic soil group.

The lens reports:

- the share of that day's rain that runs off, and its volume;
- the runoff saved if a tenth of every block's built cover were made permeable;
- the waterlogging hotspots (index 50 or more) that receive the most runoff from within 1 km.

| City | Wettest day of 2025 | Share that ran off | Volume | Cut from greening 10% of built area |
|---|---|---|---|---|
| Delhi | 72 mm | 46% | 88 million m³ | 5% |
| Mumbai | 235 mm | 85% | 168 million m³ | 1% |
| Bengaluru | 63 mm | 45% | | 6% |
| Chennai | 75 mm | 66% | | |

On Mumbai's 235 mm day, soil saturates whatever the cover, so making surfaces permeable helps little there. Storage and drains matter more.

## Night-time economy

The VIIRS night-time light composite is captured at about 1:30 am. The `nighteconomy` lens combines that late-night light with the number of eateries, leisure places and hotels within 500 m, taken from Overture places. A night district is a block in the top 10% for both.

| City | Night-district blocks | Share of these places in them |
|---|---|---|
| Delhi | 1,269 | 28% |
| Mumbai | 398 | 21% |
| Bengaluru | 321 | 11% |

## Retail catchments

The `catchment` lens is a Huff gravity model. Shopping centres are the top 5% of blocks by Overture shops. Each block's residents split their trips across the centres within 5 km in proportion to shops ÷ distance².

The lens reports each centre's draw and its residents per listed shop. Centres at twice the median residents per shop are flagged as having room for more shops. In Delhi and Pune these are mostly small outer centres that are the only one serving dense new suburbs. Overture lists only a fraction of real shops, so compare centres within a city, not the absolute counts.

## Construction sites

The `sites` dataset (L7, `pipeline/realestate/stalled.py`) compares two dry seasons a year apart in `construction_monthly`: December 2024–May 2025 against December 2025–May 2026. It only looks at blocks that are at least 15% built-up, and sorts them into three groups:

- **Stalled:** 25% or more bare ground in both seasons, with built-up up by less than 5 points.
- **Building up:** built-up up by 10 points or more.
- **Cleared this year:** bare ground up by 15 points or more, or built-up down 10 points with bare ground up as much (demolition).

The `sites` lens names the largest stalled sites and the fastest-building blocks, and counts the residents within 300 m of a stalled site. Quarries and dry open plots can look like stalled sites, so check them on the satellite view. Before classifying, the city-wide median change between the two seasons is removed, because a hazier season shifts every block at once. Delhi has 508 stalled-or-idle blocks, 38 building up and 8 newly cleared. Many of Delhi's stalled-or-idle blocks are long-vacant open plots rather than halted projects.

## Informal housing (likely)

The `informal` lens counts four signs per lived-in block:

- a mean building footprint under 60 m², worked out as roof cover × block area ÷ building count from Open Buildings 2023;
- roof cover of 35% or more;
- a mean height under 8 m;
- a Relative Wealth Index in quintile 1–2.

A block with three or more signs is likely informal. This is a look-alike from space, not a legal status.

It undercounts the densest settlements. Open Buildings merges touching slum roofs into one large polygon, and its heights there are noisy. Mumbai reads 3.8% against a Census 2011 slum share of 41%.

Share of residents in likely-informal blocks:

| City | Share |
|---|---|
| Kolkata | 9.8% |
| Bengaluru | 9.3% |
| Chennai | 8.9% |
| Delhi | 5.7% |

Read the lens for where settlements are, not for how many people live in them.

## Empty new buildings

The `ghost` lens looks at new-build blocks. A block counts as new-build when it has at least 20,000 m² of floor and 40% or more of its 2023 buildings were not there in 2016. It flags one as possibly empty when all three of these hold:

- its 2025 night light per hectare of roof is in the city's bottom quarter;
- its radiance is below the median built block;
- it has fewer than one listed business per hectare of floor.

| City | Flagged blocks | Floor area | Share of new floor since 2016 |
|---|---|---|---|
| Delhi (including the Gurugram edge) | 183 | 7.8 million m² | 17% |
| Pune | 141 | | 15% |
| Hyderabad | 225 | | 14% |
| Bengaluru | 261 | | 10% |

Night light spills between neighbouring blocks, so treat flagged blocks as places to check, not as vacancy counts.

## Commercial floor space

The `floorspace` lens estimates floor area per block as Open Buildings 2023 roof cover × block area × storeys, counting one storey per 3.5 m of height. It multiplies that by the GHSL 2020 non-residential share of built-up. The non-residential floor is then split into office-like and shop-and-eatery-like space, in proportion to the listed offices against shops and eateries in Overture.

This is an upper bound on commercial space, because industry and public buildings are non-residential too.

| City | Non-residential floor | Office-like part |
|---|---|---|
| Delhi | 48 million m² | 20 million m² |
| Bengaluru | 43 million m² | 15 million m² |
| Mumbai | 34 million m² | |

For comparison, brokers count Bengaluru's Grade A office stock at about 19 million m².

## Under the flight paths

The `flight_paths` dataset (L7, `pipeline/realestate/flightpaths.py`) merges OpenStreetMap runway segments from Overture and keeps runways of 2,000 m or more. Military airfields are included.

A block counts as under a flight path when it lies beyond a runway end, within 10 km along the extended centreline, and within 0.5 km plus 10% of the distance out to either side.

The `flightpath` lens and the property report count residents in three groups:

- under a path;
- within 3 km of a runway end, where aircraft pass below about 300 m;
- within 2 km of a runway.

| City | Residents under a path | Share of residents | Within 3 km of a runway end |
|---|---|---|---|
| Delhi | 25 lakh | 8.6% | 2.6 lakh |
| Chennai | 8.7 lakh | 10% | |
| Mumbai | 5.7 lakh | | 2.3 lakh |

This marks where low overflights are likely. It does not measure noise.

## Everyday services

The `services` lens counts Overture places within 1 km of each lived-in block in three groups:

- banks and ATMs;
- clinics, hospitals and pharmacies;
- schools, colleges and coaching.

A block counts as missing a kind when none of that kind is listed within 1 km. The lens names the blocks with the most people around them that miss one or more kinds.

| City | Residents missing at least one kind |
|---|---|
| Delhi | 4.5% |
| Pune | 1.5% |
| Guna | 28% |

Overture under-lists small and informal providers, so a gap can mean thin listings rather than a missing service.

## Rental demand anchors (`anchors` lens)

Three kinds of place drive rental demand in Indian cities: colleges and coaching centres (students, PG and hostel demand), hospitals (staff, and patients' families on long stays) and offices and co-working spaces (young workers). The `places` dataset now counts each in exact Overture categories (college_university; tutoring_service, computer_coaching, test_preparation, private_tutor; hospital, childrens_hospital; shopping_mall; coworking_space; hostel). For every lived-in block the lens sums each kind within 2 km, ranks it as a within-city percentile, and averages the three into `anchor_score`. Blocks scoring 80 or more sit near all three at once. The top student hubs also show how many hostels are already listed nearby, as a first read on existing supply.

| City | Blocks near all three (80+) | Colleges and coaching | Hospitals | Offices and co-working |
|---|---|---|---|---|
| Delhi | 7,277 | 3,807 | 2,719 | 9,078 |
| Pune | 1,618 | 1,446 | 1,135 | 3,194 |

Counts are listings, not seats, beds or desks, so a large campus counts once and a coaching street of fifty small centres counts fifty times. Mall counts are stored in `places.malls` for later retail lenses.

## Lightning (`lightning` lens, `lightning` dataset)

NASA's LIS/OTD 0.5° High Resolution Flash Climatology (Cecil et al. 2014) is the 1995–2014 mean of lightning seen by two orbiting sensors. `pipeline/safety/lightning.py` interpolates it bilinearly to every L6 block and estimates ground strikes with the Prentice & Mackerras (1977) latitude rule, which puts the cloud-to-ground share at about 15–19% across India. The file needs a NASA Earthdata token (`EARTHDATA_TOKEN`), and since it is a fixed climatology one bake is enough.

| City | Ground strikes per km² a year |
|---|---|
| Kolkata | 3.7 |
| Delhi | 2.8 |
| Chennai | 2.3 |
| Jaipur | 2.2 |
| Mumbai | 1.1 |
| Ahmedabad | 0.8 |

The grid is about 55 km, so the lens gives a city-scale figure and a gentle gradient, not street-level risk. A diurnal cycle is not in this file (the 2.5° hourly array in it is sensor detection efficiency, not flashes).

## Groundwater recharge (`recharge` lens)

Annual recharge per block is annual rain (CHIRPS) × the unbuilt, non-water share of the block (Dynamic World) × a rainfall infiltration factor by soil group from SoilGrids sand and clay: 0.22 for sandy ground, 0.16 loamy, 0.11 clay-loam and 0.08 clayey, after the Central Ground Water Board's GEC-2015 norms. The same rain on built-over ground is counted as recharge lost to sealing.

| City | Recharged a year | Lost to built-over ground |
|---|---|---|
| Delhi | 256 million m³ | 138 million m³ (35%) |
| Bengaluru | 95 million m³ | 73 million m³ (43%) |
| Chennai | 28 million m³ | 49 million m³ (64%) |

Blocks at least 20% open are scored as recharge sites (soil 35%, flat slope 25%, open share 20%, wetness index 20%) and the top tenth are listed, spaced 1.5 km apart. Geology and lineaments, which decide recharge in hard-rock cities like Bengaluru and Hyderabad, are not in the data, so the score is a first screen before a hydrogeological survey. The `water_risk.groundwater_decline_cm_yr` field is not used here because its values do not read as a physical cm-a-year trend.

## Hotel demand gap (`stay` lens)

Visitors come to a block for sights (Overture cultural and historic places), business (offices), treatment (hospitals) and travel (stations and stops). Each is summed within 1.5 km, ranked as a within-city percentile and weighted 40/25/15/20 into visitor pull. Hotels, guest houses and hostels within 1.5 km are the supply, also ranked. The gap is pull minus supply. A block with pull in the city's top 30% and a gap of 30 points or more is underserved: Delhi has 56 such blocks, Jaipur 49. The hotel belt around Mahipalpur by the airport shows as oversupplied (blue), as expected. Listings are not rooms, so one large hotel counts once.

## Lost lakes and ponds, dated (`waterloss` lens, `water_history` dataset)

The `water_history` Earth Engine layer reads the JRC Global Surface Water yearly history (Landsat, 30 m, 1984–2021). For four windows (1988–92, 1998–2002, 2008–12, 2019–21) it records the share of each block that held seasonal or permanent water in any year. A pixel counts as lost water if it held water around 1990 or 2000 and none in 2019–21, since early Landsat years have gaps over India. The last year a lost pixel held water dates the loss.

| City | Water lost | Last seen before 2000 / 2000s / 2010s | In blocks now 30%+ built |
|---|---|---|---|
| Bengaluru | 11.9 km² | 2.0 / 5.1 / 4.8 km² | 6% |
| Chennai | 10.4 km² | 3.7 / 3.5 / 3.2 km² | 40% |

Chennai's loss clusters in the south around the Pallikaranai marsh. River channels that moved and seasonal ponds through a run of dry years also read as loss, so the lens is a list of places to check on the satellite view, not a finding of encroachment.

## Mapped land use and landfill neighbours (`landuse` dataset, `dumps` lens)

`pipeline/realestate/landuse.py` clips Overture Maps land use (from OpenStreetMap) to every L7 block and groups it into residential, industrial (industrial and works), commercial (commercial and retail), civic (schools, colleges, universities, hospitals, institutional and religious), military (including airfields), construction (construction and greenfield), brownfield, landfill and quarry. `mapped_pct` says how much of the block has any land use drawn, since mapping is uneven. Protected-area polygons are left out because some cover whole districts. This is mapped use, not the statutory master-plan zone.

The `dumps` lens treats any block holding 0.5 ha or more of landfill or quarry as a site and counts the residents within 1 km.

| City | Within 1 km of a landfill or quarry | Landfill / quarry area mapped |
|---|---|---|
| Mumbai | 18.3 lakh (10.3%) | 3.5 / 0.6 km² |
| Delhi | 8.2 lakh (2.8%) | 1.2 / 0.7 km² |
| Bengaluru | 2.2 lakh (1.7%) | 1.6 / 5.3 km² |

Mumbai's map lights up around Deonar (Govandi, Shivaji Nagar, Mankhurd) and the Kanjurmarg site. The Maus et al. global mining polygons were checked first, but none fall inside the 13 cities.

## Monument construction limits (`heritage` lens, `heritage` dataset)

`pipeline/realestate/heritage.py` pulls every Wikidata item in India with a heritage designation (P1435) and coordinates inside each city's box: Monuments of National Importance, State Protected Monuments and other listings such as municipal heritage grades. The Ancient Monuments and Archaeological Sites and Remains Act 1958, amended in 2010, bans new construction within 100 m of a national monument's protected limits. From 100 m to 300 m, building needs National Monuments Authority permission and follows the height limits in that monument's heritage bye-laws. Each L7 block is sampled on an 8 × 8 grid for its share in each zone. The lens lives in a new module, `js/urban-lenses-planning.js`, because the environment module is close to the 150 kB cap.

| City | National monuments | Prohibited area | Regulated area | Residents inside |
|---|---|---|---|---|
| Delhi | 179 | 4.1 km² | 23.1 km² | 6.3 lakh |
| Ahmedabad | 55 | 1.4 km² | 8.3 km² | 4.6 lakh |
| Lucknow | 29 | 0.9 km² | 5.9 km² | 1.3 lakh |

Wikidata holds one point per monument, not the notified boundary, so zones around forts, tomb gardens and large complexes are too small. State Protected Monuments follow state rules and are counted but not zoned. The property report adds a "Monument limits (ASI)" row.

## Land-use mix and homes beside industry (`landmix` lens)

Using the `landuse` dataset, the lens sums mapped homes, commerce (commercial and retail), civic land (schools, hospitals, institutions, religious) and industry (industrial and works) within 1 km of each lived-in block. Mix is the Shannon entropy of the four shares ÷ ln 4, scaled to 0–100 (Frank et al. 2006). Homes beside industry are lived-in blocks whose land within 0.5 km is at least 20% industrial.

| City | Average mix | Homes beside industry | Land with a use mapped |
|---|---|---|---|
| Delhi | 26 | 26.7 lakh (9.1%) | 38% |
| Kolkata | 26 | 7.7 lakh (5.7%) | 32% |
| Pune | 29 | 1.8 lakh (2.8%) | 24% |

Only a quarter to two-fifths of lived-in land has a use drawn in OpenStreetMap, so the headline says so when coverage is under half.

## Everyday and public services reach (`reach` lens)

`places` now also counts post offices, police stations, fire stations, pharmacies, grocers (grocery, Indian grocery, supermarket and convenience stores) and preschools (preschool and day care) in exact Overture categories. A lived-in block lacks a service when no listed place of that kind lies within its distance: grocer 0.5 km, pharmacy 1 km, preschool 1 km, post office 2 km, police station 2 km, fire station 3 km. These are planning thresholds for the lens, not statutory norms.

| City | Missing 3+ of 6 | Biggest single gap |
|---|---|---|
| Lucknow | 17.8 lakh (38%) | post office within 2 km: 31.8 lakh |
| Delhi | 82.3 lakh (28%) | fire station within 3 km: 1.6 crore |
| Mumbai | 9.2 lakh (5%) | grocer within 0.5 km: 42.9 lakh |

Overture lists far fewer kirana shops, post offices and fire stations than exist (Delhi has 203 post offices and 39 fire stations listed), so every gap is first a listing gap to check, and the headline says so.

## What changed in a year (`monthly` lens)

Four monthly series already in the cell store are compared year on year: Dynamic World built-up probability, VIIRS night lights, Sentinel-2 NDVI and Sentinel-5P NO₂. For each series the lens takes the mean of the latest three months that at least half the lived-in blocks have, and compares it with the same three months a year earlier. That cancels the season and smooths over a cloudy month. A block shows a sign for new building (built-up +15 points), lights coming on (radiance +50% and at least +2 nW/cm²/sr), greenery lost (NDVI −0.15) or dirtier air (NO₂ +30% from at least 40 µmol/m²). Blocks with two or more signs are the likeliest real changes.

| City | New building | Lights on | Greenery lost | Dirtier air | Two or more signs |
|---|---|---|---|---|---|
| Delhi | 337 | 545 | 40 | 272 | 11 |
| Bengaluru | 596 | 1,057 | 42 | 0 | 76 |

Bengaluru's signs cluster on the Sarjapur and Hoskote fringe. The first version compared single months, and monsoon NO₂ noise flagged 13,607 Bengaluru blocks; the three-month window and the NO₂ floor fixed that.

## Building inside protected forests (`greenbelt` lens)

The `landuse` dataset now carries `protected_pct` and `esz_pct`. Protected land is Overture land use of subtype protected: national parks, wildlife sanctuaries, reserve forests and biodiversity parks. Polygons named as eco-sensitive zones (ESZ) are counted separately. Polygons over about 2,400 km² are dropped, because Pacific marine monuments that wrap the antimeridian otherwise cover every city, and so is `aboriginal_land`, which in Delhi is a mis-tagged ASI regulated area. The lens multiplies each block's protected and ESZ shares by Open Buildings Temporal built-up (2016 and 2023), WorldCover tree cover and Hansen tree loss, which assumes they are spread evenly over the block.

| City | Protected land | Built over (2023) | ESZ mapped, built | Residents inside (by share) |
|---|---|---|---|---|
| Delhi | 63.3 km² | 0.76 km² (1.2%), 0.19 since 2016 | 42.1 km², 10.6%, +0.46 since 2016 | 4.8 lakh |
| Mumbai | 89.7 km² | 0.37 km² (0.4%) | 75.3 km², 2.7% | |

Delhi's new building clusters in the Asola-Bhatti eco-sensitive zone and along Sangam Vihar. Boundaries are OpenStreetMap's, not the gazette notification.

## Mosquito season and breeding risk (`mosquito` lens)

Aedes aegypti, the dengue and chikungunya mosquito, transmits between about 18 and 34 °C, with a peak near 29 °C (Mordecai et al. 2017). For each of the last 12 months in `lst_monthly`, a block's month is suitable when the mean of day and night land surface temperature lies in that range and that month or the one before had at least 40 mm of rain (`rain_monthly`, CHIRPS). Land surface temperature is a rough stand-in for air temperature. The score is 40% suitable months, 30% waterlogging index and 30% within-city density percentile.

| City | Suitable months (per resident) | People in blocks scoring 70+ |
|---|---|---|
| Kolkata | 8.7 (Mar–Nov) | 39.9 lakh (29%) |
| Chennai | 8.1 | 6.8 lakh (8%) |
| Delhi | 6.9 (May–Nov) | 2.1 lakh (0.7%) |

It is an index of breeding conditions, not of cases. Water storage in homes, drainage and fogging matter as much and are not in the data.

## How old is the city? (`buildingage` lens)

The lens reads the GHSL built-up series in `builtup_yearly` (every five years from 1975). Each epoch's increase in a block's built-up share counts as area built in those five years, treating GHSL built area as never shrinking. A block's median build year is the first epoch by which half of its latest built area was standing.

| City | By 1975 | 1976–90 | 1991–2005 | 2006–15 | 2016–20 |
|---|---|---|---|---|---|
| Kolkata | 71% | 9% | 14% | 5% | 1% |
| Delhi | 56% | 11% | 20% | 9% | 4% |
| Bengaluru | 26% | 9% | 32% | 27% | 6% |

The 1975 epoch comes from coarse early Landsat imagery and is the least certain; it probably reads high. Footprints only: rebuilding or adding floors on the same plot does not show.

## Cooling centres for heat waves (`cooling` lens)

Heat action plans (Ahmedabad from 2013, NDMA guidelines 2019) open public buildings with shade, water and cooling to people without a cool home. Hot blocks are the hottest quarter of residents by MODIS summer daytime land surface temperature (population-weighted 75th percentile within the city). Candidate cooling centres are Overture Maps libraries, shopping malls and community centres (`places.libraries`, `places.malls`, `places.community_centres`); a hot block is unserved when none lies within 1 km. Places of worship (`places.worship`, every `*_place_of_worship` category) are counted separately as a possible stand-in. Five sites are picked from unserved hot blocks by residents plus three times the residents aged 60 and over, at least 1.5 km apart.

First run: Ahmedabad 5.7 lakh people (28.5% of the hottest quarter, 60,721 aged 60+) and Chennai 7.1 lakh have no candidate site within 1 km. Overture undercounts government libraries and community halls, so check ward records before siting.

## Festival and crowd zones (`crowds` lens)

Gathering places are Overture places of worship (every faith's `*_place_of_worship` category), shopping malls, culture and leisure, counted within 0.5 km. Crowd zones are lived-in blocks in the city's top 10% by that count that are also denser than the city median. Police stations within 2 km and fire stations within 3 km are checked from Overture, which undercounts both. First run: Delhi 3,610 crowd-zone blocks (77.5 lakh residents, 933 without listed police or fire cover), Mumbai 804, Kolkata 658. It finds likely crowd zones, not event sizes; NDMA's 2014 crowd-management guide asks for venue-by-venue plans.

## Getting to the airport (`airport` lens)

Straight-line distance to the nearest jet runway (`flight_paths.runway_km`, OSM runways of 1.8 km or more, only blocks within 30 km) × a 1.35 road detour, at 20 km/h peak and 35 km/h off-peak. Median resident at peak: Delhi 45 min, Mumbai 39 min, Kolkata 46 min. Not routed; the nearest runway can be an air force base.

## Soil for gardens and rain gardens (`gardens` lens)

New EE layer `topsoil` (L7, OpenLandMap 250 m surface soil, CC BY-SA 4.0): organic carbon (g/kg; stored as ×5 g/kg), pH (stored ×10), sand and clay. Garden score = 45% pH (full from 6 to 7.5), 35% organic carbon (zero at 2.5 g/kg, full at 10) and 20% texture (clay 35–45% scores 0.6, over 45% scores 0.3). Rain gardens need 40%+ sand and under 35% clay. Open land is WorldCover grass, bare and shrub. First run: Delhi has 284 km² of open land, 84% garden-ready and 24% draining for rain gardens; Pune's black soils drain on only 2%. SoilGrids 2.0 was tried first but masks built-up land, so it is blank in city cores.

## Homes under power lines (`powerlines` lens)

New dataset `power_lines` (L7, pipeline/realestate/powerlines.py): OpenStreetMap power lines of 66 kV and over from Overture's base infrastructure, with their `voltage` tag, buffered to the Ministry of Power 2015 right-of-way width (66 kV 18 m, 110 kV 22 m, 132 kV 27 m, 220 kV 35 m, 400 kV 46 m, 765 kV 67 m; untagged lines taken as 132 kV) and clipped to each block. Fields: line_km, corridor_pct, max_kv, substations. Residents and built-up land inside corridors are block totals times the corridor share, so they assume an even spread. First run: Delhi has 1,417 km of line and 48 km² of corridor, with roughly 3 lakh residents inside. The property report shows the corridor share for the block.

## Street infrastructure, public toilets and gated colonies (`toilets` and `gated` lenses)

New dataset `street_infra` (L7, pipeline/realestate/streetinfra.py) counts OpenStreetMap street objects from Overture's base infrastructure per block: public toilets, drinking-water points, fire hydrants, gates and lift barriers, benches, bins, ATMs and telecom towers. Mapping is uneven: Delhi has 1,020 toilets and Indore 351, but Ahmedabad only 48.

- `toilets`: lived-in blocks with no public toilet within 1 km, and the busiest 10% of shopping and food blocks with none within 500 m; drinking water within 500 m. Below 100 mapped toilets the headline says the map shows mapping gaps, not toilet gaps. Delhi: 53% of residents have none mapped within 1 km.
- `gated`: gates and barriers within 500 m per km²; 20 or more is called gated. Delhi 39% of residents, with a median value index of 122 in gated blocks against 63 elsewhere; Kolkata 17% (138 vs 88). Gate density tracks planned, formal colonies as much as gating itself.

## Drains, nallahs and wastewater works (`drainage` lens)

New dataset `drains` (L7, pipeline/realestate/drains.py): OpenStreetMap drains and ditches (`canal` subtype, classes drain and ditch) and canals from Overture's base water theme, with the share of each block within 100 m of a drain and the area of wastewater basins (sewage treatment plants and effluent ponds). The lens shows mapped drain length within 1 km per km², residents beside an open drain, waterlogging-prone blocks (index 50+) with no main drain mapped within 1 km, and residents within 1 km of a wastewater works. Delhi: 416 km of mapped drains in lived-in areas, 15 lakh residents within 100 m of one, and 2,301 of 4,915 waterlogging-prone blocks with none within 1 km. Most other cities map under 50 km of drains, and the headline then says the gaps are mapping gaps.

## Farms inside the city (`cityfarms` lens)

The `landuse` dataset gained `farm_pct`: OpenStreetMap farmland, farmyards, orchards, allotments, plant nurseries, greenhouses and vineyards (Overture land use). The lens maps farm blocks and flags those whose Open Buildings built-up share rose 5+ points from 2016 to 2023 as farms under pressure; it also counts residents with farmland mapped within 1 km. It complements `farmloss`, which uses Dynamic World land cover.

## Visitor magnets and hotel gaps (`tourism` lens)

New dataset `landmarks` (L7, pipeline/realestate/landmarks.py): Wikidata visitor attractions (about 40 classes: places of worship, tombs, forts, museums, monuments, palaces, parks, zoos, lakes, beaches, markets, stadiums and more) with articles in 3+ Wikipedia languages; each block gets the count, the summed language editions (pull) and the best-known landmark's editions. Wikipedia page views were the plan, but the Wikimedia REST API rate-limits this host, so language editions stand in for fame. The lens sums pull within 1.5 km; visitor magnets are the top 10% of blocks, and hotel gaps are magnets in the lowest quarter for Overture lodging within 1 km. Delhi: 136 landmarks, 504 magnet blocks, 126 with few places to stay.

## Coastline change and the CRZ band (`coast` lens)

Uses `water_history` (JRC yearly water 1990 and 2020) in blocks within 2 km of any 2080 coastal flood exposure (`flood_future.coast_pct_2080_high`), so inland lakes stay out. Land made is the drop in water share, land lost the rise. The Coastal Regulation Zone band is land within 500 m of blocks that are 80%+ water in 2020 (sea, creek or tidal river). Mumbai: 8.2 km² made and 6.5 km² lost since 1990, about 2.5 lakh residents in the band; Kolkata's tidal Hooghly and the East Kolkata wetlands count too. Salt pans and mudflats flip between land and water in Landsat maps.

## Packed blocks with no setbacks (`packed` lens)

Open Buildings 2.5D Temporal roof cover (2023) over the whole block, streets included. Bye-laws cap plot coverage at roughly 60–75% for small residential plots, so 50%+ of a whole block under roofs means plots built almost wall to wall. Tall packed blocks average 10 m or more. Delhi: 74.9 lakh residents (25.5%) in packed blocks; Kolkata 11%; Mumbai 2.8% (Open Buildings merges slum roofs into fewer, larger shapes, so dense slums may read lower).

## Comparable blocks in every city

`UrbanLenses.similarEverywhere({ fromCity, lat, lng, cities })` runs `similar()` against each other city and returns the best match per city, most similar first; DISHA answers "comparable localities in every city" with it. The match features now also include roof cover, daytime surface heat and present-day flood exposure (half weight each). A Delhi block at Lodhi Road finds 93% matches in Bengaluru, Hyderabad and Mumbai; Guna's best is 81%. All 12 cities take about 13 s.

## Tech hubs and IT parks (`techhubs` lens)

The `places` dataset gained `tech` (Overture software development, information technology company, biotechnology company and B2B science and technology service) and `corporate` (corporate and business offices). The lens counts tech firms within 1 km; hubs are the densest 5% of blocks with at least 5 firms. It reports the share of firms in hubs, residents within 5 km of a hub, hubs within a 15-minute walk of the metro, and the hubs' median value index against the city's. Wikidata has too few IT parks and SEZs with coordinates to use, so firms are counted by listing, not jobs.

## Shaded walk to the clinic (`shadecare` lens)

For each lived-in block the nearest clinic, hospital or pharmacy (Overture `places.health` or OSM healthcare) within 2 km is found on the walking network, and the route is traced back block by block from the Dijkstra distances. A step is hot and bare when the block has under 10% tree canopy of 5 m or more (Meta/WRI) and a MODIS summer day surface temperature at or above the city's population-weighted median. Columns: `care_walk_exposed_pct` (share of the walk that is hot and bare) and `care_walk_m`. Planting picks add up the residents whose walk crosses each hot, bare block. Residents with care in their own block count as 0% exposed; blocks off the walking network are not traced and are reported separately. Ahmedabad is worst among the big cities: 57.5% of residents who walk to care do so mostly in the sun.

## Cyclone wind risk (`cyclone` lens, `cyclones` dataset)

`pipeline/realestate/cyclones.py` reads NOAA's IBTrACS North Indian basin best tracks for 1981–2024 (JTWC 1-minute winds, else IMD 3-minute winds ÷ 0.93), interpolates each track to 30-minute steps and builds a modified Rankine wind field (linear inside the radius of maximum wind, (R/r)^0.5 outside; radius from JTWC or Willoughby et al. 2006). Per lived-in block it keeps each season's strongest wind and stores `wind_max_kmh`, `wind_rl50_kmh` (Gumbel by moments on the storm seasons, mixed with their share of all seasons), `gale_years` (62 km/h+) and `storms_200km`. The lens reports the residents' median 50-year wind on IMD's scale and the residents in each class, plus residents in blocks of 30 m+ buildings facing severe-storm winds. Results: Chennai and Kolkata about 125 km/h (very severe cyclonic storm), Mumbai 87 km/h, inland cities under 62 km/h. Winds are open-exposure sustained winds; STORM (Bloemendaal 2020) would be the better source but data.4tu.nl is unreachable from the bake host.

## Delivery riders: hubs and rest stops (`riders` lens)

Delivery demand per block is the count of Overture eateries plus grocers within 1 km (`delivery_places_1km`). Rider hubs are the top 5% of blocks (at least 30). Each hub is checked for an OpenStreetMap public toilet and drinking-water point within 500 m and for heat (MODIS day surface at or above the residents' median, under 10% canopy). Rest-stop picks rank hubs missing a toilet or water by demand, 1.5 times for hot ones, 1.5 km apart. About 70–85% of hubs in Delhi, Bengaluru and Mumbai have no toilet or water point mapped within 500 m; OSM undercounts both, so these are places to check, not proven gaps.

## Summer shade from trees (`summershade` lens, `tree_season` layer)

The `tree_season` Earth Engine layer reads Sentinel-2 NDVI medians for March–May and August–October only over tree canopy (Meta/WRI height ≥ 5 m at each 20 m sample). Per block: `summer_leafy_pct` (canopy with NDVI ≥ 0.4 in the hot months), `tree_ndvi_rise` (greening into the post-monsoon, high for deciduous trees) and `tree_phen_sd` (the spread of that greening across the block's trees, a variety proxy under the spectral variation hypothesis). The lens reports the canopy-weighted share still in leaf, residents in leafy blocks (10%+ canopy) where under 40% of the canopy keeps its leaves, and picks hot blocks for evergreen or late-shedding planting. Water stress also makes trees look leafless, and the spread is not a species count.

## What the buildings are used for (`builduse` lens)

Only about 15–45% of built-up blocks (5%+ roof cover) have land use mapped in Overture/OSM. The lens trains a Gaussian naive Bayes classifier per city on the blocks where one use (homes, shops and offices, industry, institutions and campuses including military) covers 50%+ of a block that is at least half mapped. Features, standardised per city: the 12 satellite-embedding components, Open Buildings height and cover, VIIRS night lights, GHSL non-residential share, WorldPop density and Overture counts of places, offices and shops. Every fifth labelled block is held out to score it: 76% in Delhi, 74.5% Mumbai, 68% Bengaluru, 65% Chennai, with per-use recall in the stats. Output `use_class` (1–4) and `nonres_prob_pct`. Mapped blocks over-represent campuses and estates, so small mixed-use blocks are least certain; below 70% accuracy the headline says to treat the map as rough.

## Scenario builder: new metro station, clinic or school (`UrbanLenses.rescore`)

`UrbanLenses.rescore(city, store, { edits: [{ kind: 'metro'|'clinic'|'school', code | lat, lng }] })` edits a copy of the city's lens frame the way the bake would have counted the facility, and re-runs every lens whose `needs` include an edited column. A metro station adds a station and rapid-transit stop to its cell and shortens `rail_access.metro_walk_min` to straight-line × 1.3 at 80 m/min (as `pipeline/traffic/rail_stations.py`), up to 20 minutes. A clinic adds one to `places.health` and `osm_amenities.healthcare`; a school to `places.education` and `osm_amenities.education`. Each lens reports its city metric before and after, and the population-weighted mean of its main field for residents within 2 km, with the number of residents whose value changed. The Intel What-if tab exposes it as New metro station, New clinic and New school, and DISHA routes "what if we open a new clinic here" to it. Nothing else responds: no new trips, prices or building.

## Living beside the railway (`railnoise` lens, `railways` dataset)

`pipeline/realestate/railways.py` clips Overture transportation rail segments (OpenStreetMap railway track) to lived-in blocks: `rail_km` (every class but subway, light rail, tram and monorail), `metro_km`, and the share of the block within 50 m (`rail_near_pct`) and 150 m (`rail_band_pct`) of mainline track. The lens counts residents by those shares, schools and hospitals in blocks a quarter or more within 50 m, compares the land value index beside the track with blocks over 150 m away (centrality confounds this), and picks the blocks with the most residents within 50 m for noise barriers or track-side greening. There is no decibel model: train counts are not open. Delhi: 22.8 lakh residents within 150 m, 8.3 lakh within 50 m.

## Care for mothers and young children (`mothercare` lens)

The `places` dataset gained `obgyn` (Overture obstetrics and gynaecology, maternity centres) and `paediatric` (paediatric clinics and every `pediatric_*` specialty). The lens counts both within 3 km of each block with children under 5 (WorldPop), reports under-5s missing either or both, approximates births as under-5s ÷ 5, and picks the blocks with the most under-5s lacking both for a mother-and-child clinic. Overture lists private care; government PHCs, urban health and wellness centres and anganwadis are largely missing.

## Wedding season: banquet halls and event clusters (`events` lens)

The `places` dataset gained `events` (Overture party and event planning, where most banquet halls and marriage gardens are filed, plus event venues, wedding planning and caterers), `freight` and `wholesale`. The lens counts event places within 1 km; clusters are the top 5% of blocks (at least 10). It reports residents within 500 m of a cluster and the clusters whose main-road network within 1 km is thinner than the residents' median (blocks with no mapped main road nearby are treated as unmapped, not thin), and picks clusters for wedding-date traffic and parking plans. Delhi: 2,095 listings, 62 lakh residents within 500 m of a cluster.

## Fire risk in crowded markets (`marketfire` lens, js/urban-lenses-safety.js)

The planning module reached the 150 kB per-module budget, so new lenses go in `js/urban-lenses-safety.js` (loaded after the planning module in app.html, sw.js, tests/setup.js and scripts/build_lens_league.js). Market blocks are the top 5% by Overture shops and eateries within 500 m (at least 50); packed means Open Buildings roofs cover 50%+ of the block; far means no listed fire station within 3 km, judged only where 5+ stations are listed. The map scores 1 (market), 2 (packed market), 3 (packed and far). Overture lists under half of the real fire stations (Delhi 29), so "far" overstates gaps. Delhi: 1,863 market blocks, 314 packed, 34 packed and far.

## Old buildings, now tall (`oldtall` lens, js/urban-lenses-safety.js)

Where people live in blocks built before India's earthquake codes were widely applied that now carry tall buildings. Old means settled by 1985 (WSF Evolution) or 20%+ built in 1975 (GHSL); tall means a mean Open Buildings height of 10 m or more (about G+2); floors added means mean height rose 1.5–4 m from 2016 to 2023. A rise of 4 m or more counts as rebuilt and drops out of "tall", since new towers on old land follow current codes. The map scores 1 (old), 2 (old and tall), 3 (old, tall and floors added); picks weigh residents by height capped at 25 m. The city's IS 1893 seismic zone comes from the ground lens. Delhi: 65.6 lakh residents in 2,954 old, tall blocks, 135 with floors added; Mumbai: 65.2 lakh in 1,603 blocks, 309 with floors added. Single-building build years are not in open data, so this ranks where to start audits.

## Emergency services on wet ground (`critwater` lens, js/urban-lenses-safety.js)

Hospitals, fire stations and police stations (Overture) and schools used as relief camps (OpenStreetMap) whose block is flood-prone (25%+ in WRI Aqueduct's 1-in-100-year river or coastal flood today) or waterlogged (rain waterlogging index 60+). The map scores blocks that hold any of these 0 (dry), 1 (waterlogged) or 2 (in the 100-year flood). Stranded residents have at least one listed hospital within 3 km and every one of them is on wet ground. Picks weigh emergency services on wet ground by residents within 3 km and flood level. Delhi: 289 of 2,719 listed hospitals on wet ground, 11.6 lakh stranded; Chennai: 981 of 1,254 (Aqueduct's ~1 km coastal and river floodplain covers most of the city, which overstates block-level risk), 34.4 lakh stranded. DISHA routes "cut off / stranded" questions to the existing `cutoff` lens and "hospitals that flood" to this one.

## Earthquake shaking on soft ground (`quake` lens, js/urban-lenses-safety.js)

A site-effect proxy to sit beside the city's IS 1893 zone (from the ground lens). Soft ground is a block less than 2 m above the nearest drain or river (MERIT Hydro HAND): young floodplain and coastal sediment with a shallow water table, which amplifies shaking. Sandy soft ground adds 45%+ topsoil sand (SoilGrids), the soils that liquefy when saturated. Tall adds a mean building height of 15 m+ on soft ground. The map scores 0-3; picks weigh residents by sandiness and height. A 5 m HAND cut put 87% of Delhi on soft ground and did not separate floodplain from older alluvium, so 2 m is used. Residents on soft ground: Kolkata 65%, Delhi 57%, Chennai 46%, Mumbai 16%, Bengaluru 5.5%. Borehole and shear-wave data are not open; published microzonation maps win where they exist.

## Homes beside factories (`factoryhomes` lens, js/urban-lenses-safety.js)

Industry among housing, the setting of Delhi's 2019 Anaj Mandi and 2022 Mundka fires. Industrial blocks have 20%+ of their land mapped industrial (OSM land use via Overture); mixed blocks also have 20%+ mapped housing; hot adds VIIRS thermal anomalies on 1+ day a year (furnaces, kilns, burning). Map: 1 within 500 m of an industrial block, 2 mixed, 3 mixed and hot. OSM land-use polygons overlap, so shares can add past 100%. Delhi: 61.5 lakh residents (21%) within 500 m of industry, 3 lakh in 238 mixed blocks, 23 of them hot; Mumbai 41% within 500 m. MAH unit registers and factory licences are not open.

## Storm-surge shelter gaps (`refuge` lens, js/urban-lenses-safety.js)

Residents in blocks with 25%+ of their area in Aqueduct's coastal 1-in-100-year flood today or by 2050 (RCP4.5), and whether a school (OSM) or community hall (Overture) lies within 1 km. Map: 1 surge zone with a refuge, 2 none within 1 km. Wind-only exposure was tried and dropped: a 89 km/h 50-year wind covers all of Chennai and Kolkata, and pucca homes ride out wind; the surge is what forces evacuation. Kolkata: 18.2 lakh in the surge zone today, 41,882 with no refuge within 1 km, about 5,600 exposed residents per refuge; Mumbai 4.6 lakh, 78,080 with none. Aqueduct puts no Chennai block 25% in the coastal flood, so Chennai returns nothing; inland cities too.

## Fire engines in packed lanes (`firelanes` lens, js/urban-lenses-safety.js)

Adds road access to the `packed` lens. Packed blocks have 50%+ under roofs (Open Buildings 2023); deep means no OSM main or secondary road in the block or within 300 m, so a fire tender (about 4.5 m of road, NBC 2016 Part 4) stops short; far means no Overture fire station within 3 km, judged where 5+ are listed. Map: 1 packed, 2 deep, 3 deep and far. DISHA now sends "fire tender/engine access" questions here rather than to `packed`. Delhi: 17 lakh residents in 766 deep packed blocks, 522 of them also far from a listed station; Mumbai only 48,254 (Open Buildings merges dense slum roofs less, and Mumbai's road grid is denser).

## School safety check (`schoolsafe` lens, js/urban-lenses-safety.js)

A compound of the safety lenses at every block with an OSM school, for the hazard audits in the NDMA School Safety Policy (2016). Six checks, with the thresholds used by the other safety lenses: 100-year flood 25%+, waterlogging index 60+, soft ground (HAND under 2 m) in seismic zone III or higher, packed with no main road within 300 m, industry within 500 m, road noise of 70 dB Lden or more. A check is skipped where the city lacks the data (Bengaluru, in zone II, has 5). The map counts hazards per school block. Delhi: 27% of 6,376 schools face two or more hazards (56% are on soft ground in zone IV); Mumbai 30%; Bengaluru 3%.

## Hospital safety check (`hospitalsafe` lens, js/urban-lenses-safety.js)

The school safety check run over Overture hospitals (both lenses share `siteCheck`). Delhi: 20% of 2,719 listed hospitals face two or more hazards, 47% stand on soft ground in zone IV; Chennai: 50%, mostly because Aqueduct puts 78% of its hospitals in the 100-year flood. DISHA sends "hospitals that flood" to `critwater` and "hospital safety / hospitals at risk" here.

## Crowded local-train stations (`stationload` lens, js/urban-lenses-safety.js)

Item 67 asked for Mumbai locals with frequency; no open timetable or GTFS is reachable, so this ships the catchment half. Every lived-in block within 2 km of a suburban rail station (rail_access, Overture + OSM) is assigned to its nearest station on the block grid; a station's load is its assigned residents, split across stations sharing a block. The map shows each block's station load. Mumbai: 100 stations, 1.5 crore residents within 2 km, median 1.1 lakh per station, busiest tenth 3 lakh+. A catchment is not ridership: interchanges, long-distance commuters and fast-train choice are missing.

## Older people in walk-up flats (`walkups` lens, js/urban-lenses-safety.js)

Residents 60+ (WorldPop age structure) in blocks whose mean building height is 9-15 m (about three to five storeys): the NBC 2016 asks for lifts above 15 m, so these are mostly climbed on foot. Pharmacies within 500 m are Overture places. The map shows older residents per walk-up block. Delhi: 5.9 lakh (36%) of 16.1 lakh older residents, 1.6 lakh with no pharmacy within 500 m; Mumbai 29%; Kolkata 23%; Bengaluru 14%.

## Monsoon tree-fall risk (`treefall` lens, js/urban-lenses-safety.js)

Tall canopy over busy roads, for pre-monsoon tree surveys and pruning. The vegetation dataset's `canopy_m` is the block-wide mean of Meta/WRI 1 m canopy height, so the trees' own height is `canopy_m` divided by tree cover (the share 5 m+); tall means 10 m+ over 15%+ of the block. Busy blocks are in the city's top half by OSM main and secondary road density. Map: 1 tall canopy, 2 over busy roads. Picks weigh road density, cover, tree height, CHIRPS heavy-rain days and cyclone wind. Main road under tall canopy: Delhi about 248 km, Mumbai 214 km, Bengaluru 200 km. Species, rot and trenching damage need a tree census.

## Substations under water (`gridflood` lens, js/urban-lenses-safety.js)

OSM substations (power_lines dataset) checked against critwater's thresholds (25%+ in Aqueduct's 100-year flood, or waterlogging index 60+), plus those dry today but flood-prone by 2050. Each lived-in block within 3 km is assigned its nearest substation; the map shows that substation's state (0 dry, 1 waterlogged, 2 flood). Delhi: 75 of 337 mapped substations wet, nearest for 70.9 lakh residents; Chennai 29 of 53 (Aqueduct's broad floodplain again), 60.5 lakh; Mumbai 15 of 77, 31.1 lakh. Feeder networks, plinths and flood walls are not open.

## Coaching hub safety (`coaching` lens, js/urban-lenses-safety.js)

Hub blocks have 10+ Overture coaching centres within 500 m and sit in the top tenth of blocks with any. Each hub is flagged for waterlogging (index 45+, a lower bar than critwater because basements flood first), packed lanes (50%+ under roofs, no main road within 300 m), no fire station within 3 km (where 5+ are listed) and packed buildings. Map: 1 hub, 2 one flag, 3 two or more. Picks weigh centre count, flags and hostels. Delhi: 617 hub blocks, 451 flagged (261 waterlogged); Hyderabad 99, 72 far from a listed fire station. The 2023 Mukherjee Nagar fire and the 2024 Old Rajinder Nagar basement flood are the cases it is built around; basement use and fire NOCs are not open.

## Rooftop rainwater (`rainharvest` lens, js/urban-lenses-safety.js)

Roof area (Open Buildings 2023 cover × block area) × CHIRPS annual rain × 0.8 (CGWB runoff coefficient for hard roofs) is each block's harvestable rain; spread over the year and its residents it gives litres per resident a day against the CPHEEO 135 l/day norm. Picks weigh volume by the water_risk groundwater decline. Delhi: about 276 million m³ a year, 21 l per resident a day for the median resident (19% of city need); Chennai 39 l (33%); Mumbai 20 l. Commercial blocks with few residents show very high per-resident figures. The safety module's header now reads "safety and resilience".

## Construction dust and heat (`sitedust` lens, js/urban-lenses-safety.js)

Every block in the sites dataset (cleared this year, building up, or stalled with bare ground; all blow dust) with residents, OSM schools and Overture hospitals counted within 500 m, and flagged hot where its pre-monsoon Landsat surface temperature is 2°C+ above the city median (labourers working in the open). Map: 1 site, 2 near a school or hospital, 3 also hot. Delhi: 554 site blocks, 67.7 lakh residents within 500 m, 481 sites near a school or hospital. The sites dataset is thin for Bengaluru (25 blocks), so its figures understate construction there.

## Hotel cluster fire safety (`hotelfire` lens, js/urban-lenses-safety.js)

Cluster blocks have 10+ Overture lodging places within 500 m and sit in the top 3% of blocks with any (the top tenth flagged 1,831 Delhi blocks, too many to act on). Flags: packed (50%+ under roofs), no main road within 300 m, no listed fire station within 3 km, settled by 1985. Map: 1 cluster, 2 one flag, 3 two or more. Delhi: 555 cluster blocks (35+ lodgings within 500 m), 118 with two or more flags, led by Paharganj and Karol Bagh; Mumbai 188, 14 flagged twice. Built around the 2019 Hotel Arpit Palace fire.

## Quarries and flooded pits near homes (`quarries` lens, js/urban-lenses-safety.js)

Blocks with 10%+ mapped as quarry (OSM land use via Overture), flooded where 5%+ is open water (ESA WorldCover); residents and children within 500 m. Map: 1 near a quarry, 2 near a flooded pit. Bengaluru: 161 quarry blocks, 37 holding water, 8,399 residents within 500 m of a flooded pit; Hyderabad 58 and 11. Quarry mapping is patchy (Jaipur has none mapped), so the counts are a floor.

## Heritage at risk (`heritagesafe` lens, js/urban-lenses-safety.js)

The school and hospital safety check (`siteCheck`) run over Wikidata heritage listings of all grades (summed into a `heritage.all` column on the frame). Delhi: 8% of 196 listed monuments face two or more hazards; Kolkata 53% of 230 (soft delta ground, river flood, industry and traffic); Ahmedabad 19% of 64. Built for the hazard audits in the NDMA guidelines on cultural heritage sites and precincts (2017).

## Fuel stations among homes (`fuelsafe` lens, js/urban-lenses-safety.js)

Overture fuel stations flagged per block for sharing it with a school (OSM) or hospital (Overture), standing in a packed block (50%+ under roofs) and lying in Aqueduct's 100-year flood. Blocks are about 250 m across, coarser than the tens of metres the Petroleum Rules and OISD siting standards set, so a flag means measure there. Delhi: 123 of 485 listed stations share a block with a school or hospital, 56 in the 100-year flood; Mumbai 141 of 236.

## Tests, teeth and eyes (`carekit` lens, js/urban-lenses-safety.js)

Four new Overture place counts per block (`places.diagnostics`, `dental`, `eyecare`, `elder_homes`; pipeline/realestate/places.py) give the reach of everyday out-of-pocket care: a diagnostic lab or scan centre within 2 km, a dentist within 2 km and an eye clinic within 3 km. Map: how many of the three are missing (0-3). Extra stats: residents 60+ with no eye clinic (cataract age) and residents 60+ per listed old-age home. Delhi: 4.4% of residents have no lab within 2 km and 17.5% no eye clinic within 3 km (20% of over-60s); Bengaluru 19% have no eye clinic nearby; Mumbai's gaps are under 2%. Eye clinics are thinly listed (166 in Delhi) and government dispensaries and hospital departments are undercounted, so the picks are blocks to check, not proven deserts.

## Coal smoke upwind (`coalplume` lens, js/urban-lenses-safety.js)

New dataset `power_plants` (pipeline/realestate/powerplants.py): coal, gas and oil plants within 150 km of each lived-in block from the WRI Global Power Plant Database in Earth Engine (a 2018-2021 snapshot; Badarpur, Rajghat, old Ennore, Titagarh and old Panki removed as retired). The upwind coal index sums each coal plant's MW × the share of ERA5-Land daily 10 m wind (2020-2024, speed-weighted, nearest land cell to the city centre) blowing from the plant towards the block within ±45°, ÷ distance (km, at least 5). Chennai's Manali and Tiruvottiyur, downwind of North Chennai, Vallur and Ennore, score highest of the 13 cities; Kolkata's residents all live within 20 km of a coal plant and Mumbai's 66% (Trombay). A ranking for SO₂ monitors and FGD follow-up, not a concentration.

## Downwind of the dump (`dumpsmoke` lens, js/urban-lenses-safety.js)

New dataset `downwind` (pipeline/realestate/downwind.py): per lived-in block, mapped landfill and dump land (2 ha+ per block, OSM land use) and industrial land (10%+ of a block) within 3 km, each weighted by area × the share of ERA5-Land daily wind blowing from it towards the block (±45°, the city wind rose from pipeline/realestate/powerplants.py) ÷ distance. `landfill_upwind` is the largest such wind share. The lens counts residents where 30%+ of the wind comes from a landfill: Delhi 20 lakh (6.8%), with Ghazipur's plume over Gharoli and Khora; Chennai 8.6%; Mumbai 6.9%. Pune, Jaipur, Lucknow, Indore and Guna have no landfill mapped at 2 ha+, so the lens is empty there.

## Power cuts from space (`powercuts` lens, js/urban-lenses-safety.js)

New L6 dataset `blackouts` (pipeline/realestate/blackouts.py): NASA Black Marble VNP46A2 daily night lights for 2023-2024, high-quality cloud-free nights only. For each lit ~1 km block (median 5+ nW/cm²/sr), a night counts as dark when its radiance relative to its own median falls below half of that night's citywide median ratio, which cancels haze and thin cloud. `dark_nights_pct` is the share of good nights (about 400 of 731 in Delhi) that were dark. The lens counts residents in blocks dark on 5%+ of clear nights, with over-60s, 40 °C heat and hospitals in them. VIIRS passes at about 1:30 am, so evening load-shedding is missed, and switched-off street lights count too; dim peri-urban blocks are noisiest.

## Homes on the forest edge (`wildedge` lens, js/urban-lenses-safety.js)

Forest blocks have 60%+ tree cover (ESA WorldCover) or 50%+ mapped protected land, with 25+ such blocks within 1 km so that parks and leafy colonies do not count. Lived-in blocks within 500 m of one are the edge (1); lived-in blocks inside are 2. Stats add children under 5 and the darkest quarter of blocks by VIIRS night radiance. Mumbai: 11.2 lakh residents (6.3%) on the edge, tracing the Sanjay Gandhi National Park and Aarey ring; Delhi 5.2% (the Ridge and Asola); Bengaluru 1.4%. Leopard sightings and attacks are not open data, so this is exposure, not incidents.

## A school within 1 km (`schoolgap` lens, js/urban-lenses-safety.js)

`demographics` gained `school_age` (5-14) and `youth_15_24` from the same WorldPop 2020 age-sex rasters (pipeline/cells/ee_layers.py). The lens checks every school-age child against OpenStreetMap schools within 1 km (the RTE primary norm) and 3 km (upper primary), with children per mapped school nearby and young people with no college within 5 km. Delhi: 5.7% of children have no mapped school within 1 km; Mumbai 7.7%; Bengaluru 3.6%. OSM misses many government and budget schools, so the named blocks are to be checked against UDISE+ (item 88, still parked).

## Railway level crossings (`railgates` lens, js/urban-lenses-safety.js)

New dataset `level_crossings` (pipeline/realestate/levelcrossings.py): connectors shared by an Overture (OSM) mainline or suburban rail segment and a road segment, counted per L7 block with how many sit on main roads (trunk to tertiary) and the busiest road class. Delhi has 150 mapped (service roads in yards and depots left out), 78 on main roads; Kolkata 171, Lucknow 118. The lens maps crossings (1), on main roads (2) and in the top quarter of road blocks by the traffic model's peak PCU (3), with residents and schools within 500 m, and ranks bridge candidates by peak traffic and road class. Train counts (the Railways' TVU criterion) are not open.

## Rooms with a view (`views` lens, js/urban-lenses-realestate.js)

Tower blocks (mean Open Buildings height 20 m+) within 400 m of open water (2+ shoreline blocks with 30%+ JRC permanent water; the frame holds lived-in blocks only, so lakes and sea show up as their shores) or a big park (3+ blocks 50%+ park or part of a big OSM park). Map: park view 1, water 2, both 3. Mumbai: 689 of 1,712 tower blocks have a view, 98 over water (Worli, Malabar Hill, Mahim, Bandra); in Bengaluru and Hyderabad the model's land value index is about 10% higher for park-view towers (the index's green driver contributes, so not a market premium). Line of sight and orientation are not modelled.

## Neighbourhood names (`neighbourhoods` dataset, pipeline/realestate/neighbourhoods.py)

Each lived-in L7 block gets the name of the smallest Overture Maps division area (microhood, neighbourhood, macrohood or locality, as OpenStreetMap maps colonies, sectors, urban villages and wards) that holds its centre, the next larger area with a different name (Dwarka around "Sector 11"), and the county-level district. Where no area holds the block, or the holding area is a whole ward or town of over 12 km², the nearest named division point within 1.5 km is used (`place_src` = `point`; Kolkata goes from 9 names to 255 this way). The PIN code (`pin`) is a distance-weighted vote of the postcodes on Overture place addresses within 600 m (about 90% of Delhi's 3 lakh places carry one; codes seen fewer than 10 times are dropped as typos), and `pin_share` is the winning code's share, low on a PIN boundary. Spot checks: Lajpat Nagar 110024, Saket 110017, Dwarka 110075, Connaught Place 110001, Ballygunge 700029. Delhi names about 40,000 of 51,000 blocks with some 1,200 names. `UrbanLenses.run` adds the name to every pick that ends in a block code ("Care point 1: 39J3286 · Shahdara North, Delhi"), the property report heads with the name and PIN code ("Lajpat Nagar, South East Delhi · PIN 110024"), and `UrbanLenses.names(city)` / `UrbanLenses.places(city)` give the code-to-name and code-to-PIN maps to DISHA and the UI. Boundaries are crowd-mapped and uneven, so read them as everyday names, not legal limits. Licence: ODbL 1.0 (names); CDLA Permissive 2.0 (Overture places, for PIN codes).

## Brick-kiln smoke (`kilnsmoke` lens, js/urban-lenses-safety.js)

New dataset `brick_kilns` (pipeline/realestate/kilns.py) reads the asset-level emissions inventory of the Indo-Gangetic Plain (Brick_Kilns_IND_coal.csv on the public S3 bucket assetdata-igp, CC BY 4.0): 22,459 Indian fixed-chimney and zigzag kilns mapped from satellite imagery, each with a coal-fired PM2.5 estimate in tonnes a year. For each lived-in block it keeps the kilns within 10 km, their PM2.5 within 25 km, the nearest kiln, and an upwind index: each kiln's PM2.5 × the share of ERA5-Land daily wind (2020-2024, one rose per city, from powerplants.fetch_wind) blowing from it to the block within ±45°, ÷ distance (at least 1 km). Only Delhi (1,147 kilns within reach), Lucknow (278) and Kolkata (226) are on the plain. The lens reports residents within 3 km of a kiln (Delhi 7.1 lakh, Lucknow 5.3 lakh or 11%), the most exposed tenth, children under 5 and satellite PM2.5 there, and five inspection points named by neighbourhood (Loni, Dhansa, Khekra in Delhi's belt; Jankipuram and Kalyanpur in Lucknow). The property report lists kilns within 10 km and flags one within 3 km. Kilns fire November to June while the rose is annual; stack height and fuel mix are left out.

## Municipal wards (`wards` dataset, pipeline/realestate/wards.py)

The corporation ward holding each lived-in block, from the newest public ward map found for each city, in priority layers so metro blocks outside the core corporation get their own body. OpenCity public-domain maps (data.opencity.in): Bengaluru's 369 GBA wards of December 2025 across the five new city corporations, Indore, Ahmedabad, Bhopal and Greater Jaipur 2024, Gurugram and Faridabad 2024 (Delhi region), Thane 2023 and Navi Mumbai 2024 (Mumbai region), Hyderabad's GHMC 2022 wards with zones, and Kolkata's KMC 2022. DataMeet's Municipal Spatial Data (CC BY 4.0) fills the rest: Delhi's MCD 2017 map (272 wards plus NDMC and Delhi Cantonment charges; MCD has had 250 wards since 2022 and no public map of those was found), Chennai (GCC 200, with zones), Lucknow, Pune (2022 electoral wards), Mumbai's 24 BMC administrative wards, and the old Jaipur map for blocks outside Greater Jaipur. Guna has none. Fields are `ward` ("27 Sri Lakshmi Devi Ward"), `ward_no`, `zone` and `body` ("Bengaluru South City Corporation"). The property report heads with it and `UrbanLenses.places(city)` carries `ward` and `body`.

## Assembly and Lok Sabha constituencies (`constituencies` dataset, pipeline/realestate/constituencies.py)

The assembly constituency holding each lived-in block, its number, the Lok Sabha constituency it sits in, and whether the assembly seat is reserved (SC or ST), for all 13 cities. Boundaries are the 2008 delimitation, still in force, scraped by DataMeet from the Election Commission's polling station locator (github.com/datameet/maps, CC BY 2.5 India); DataMeet notes some shift and a few wrong or missing names, and Telangana seats are still filed under Andhra Pradesh. Spot checks: Lajpat Nagar is Jangpura (East Delhi), Saket is Malviya Nagar (New Delhi), Koramangala is B.T.M Layout (Bangalore South), Bandra West is Vandre West (Mumbai North-Central), Jubilee Hills is in Secunderabad.

## Which ward, PIN code or constituency is this? (DISHA `whereis`)

With a block clicked, DISHA answers "which ward is this", "what is the PIN code here" or "who is the MLA for this area" from `UrbanLenses.places`: the neighbourhood and district, the PIN code, the municipal ward and corporation, and the assembly and Lok Sabha constituencies. It does not name the sitting MLA, MP or corporator (that changes with each election and is not in these maps). Questions that rank places ("which neighbourhoods are hottest") still go to the lenses.

## District health (`districthealth` lens, js/urban-lenses-realestate.js)

New dataset `nfhs` (pipeline/realestate/nfhs.py) spreads 15 NFHS-5 (2019-21) district indicators to every lived-in block: children under 5 stunted and wasted, child and women's anaemia, women overweight or obese, raised blood pressure and high blood sugar for women and men, clean cooking fuel, improved sanitation, household health insurance, women with 10+ years of school, full vaccination and institutional births. Values are the IIPS / Ministry of Health district fact sheets as converted to CSV, with 2011 census district boundaries, by github.com/SaiSiddhardhaKalla/NFHS (phase-1 states via pratapvardhan/NFHS-5, CC BY 4.0); the converted CSV writes missing values as 0, which the pipeline drops. Districts formed since 2011 take their parent's boundary. The lens groups blocks by district and reports residents in districts with 30%+ child stunting (Delhi 1.1 crore, 39%), 50%+ anaemic women, 25%+ adults with raised blood pressure, and under 25% of households insured, with one row per district (stunting, anaemia, BP, sugar, insurance). The property report shows the block's district values. These are survey averages of about 900 households a district: context for anganwadis, screening camps and PM-JAY enrolment, not block measurements.

## Flooded before (`floodagain` lens, js/urban-lenses-realestate.js)

New dataset `flood_reports` (pipeline/realestate/floodreports.py) reads public-domain flood maps from data.opencity.in: Greater Chennai Corporation flood hotspots for 2005, 2015 and 2020 (Cyclone Nivar), 2015 stagnation and district hotspots, the mapped December 2015 inundation zone and 2005 extent, crowd-sourced flooded streets of 2015, Hyderabad's inundation points, and Bengaluru's flood-vulnerable, flood-prone and BBMP low-lying locations. Per block it keeps reported spots within 300 m, the share inside each mapped extent, flooded street segments, and the number of separate floods that reached it (a spot within 300 m or half the block inside an extent; the undated lists count as one recurring event). Chennai: 13.4 lakh residents (15%) live in blocks two or more floods reached and 21 lakh inside the 2015 zone; the first drain-audit block is in Velachery. Bengaluru: 2 lakh in repeat-flood blocks, which carry a higher median land-value index than the city (112 vs 93). Only these three cities have such maps there. The property report lists past floods and flags two or more.

## Government school strain (`schoolstrain` lens, `schools_udise` dataset, pipeline/realestate/udise.py)

UDISE+ 2024-25, the Ministry of Education's census of every school, comes per district from data.opencity.in (public domain): profile (management, PIN code, school type), facilities (classroom condition, toilets, library), enrolment and teachers. Schools have a PIN code but no coordinates, so each PIN code's schools are summed (at least 3) and every L7 block takes its PIN code from the `neighbourhoods` dataset. Fields: schools, government and private-unaided shares, government pupils, pupils per government teacher, government classrooms needing major repair (over good + minor + major, since `total_class_rooms` is often 0), girls' and co-ed government schools with a working girls' toilet, and government schools with a library. Bengaluru South's and Mumbai Suburban's 2024-25 "Profile Part 1" links point at Part 2, so Part 1 comes from 2023-24 (pseudocodes are stable). Covers Delhi, Mumbai, Bengaluru Urban, Pune, Chennai, Hyderabad and Kolkata (about 30,000 schools).

The lens weights by school-age children (`demographics.school_age`) and counts those in PIN codes where government schools exceed 35 pupils per teacher (RTE schedule), where 10%+ of classrooms need major repair, and where under 90% of schools have a working girls' toilet; it lists the worst PIN-code areas. The property report shows the PIN code's schools, government share, pupils per teacher and repair share.

## Leaving government schools (`schooldrift` lens, `schools_udise` dataset, pipeline/realestate/udise.py)

The 2021-22 UDISE+ district files are summed by PIN code like the 2024-25 ones: pupils in government schools and in
private unaided schools (aided schools left out of both). `govt_share_pct` is the 2024-25 government share and
`govt_share_change_pp` its change in percentage points; PIN codes with under 200 such pupils in a year are dropped.
Counts are never compared across the years: from 2022-23 UDISE+ collected verified pupil records instead of school
returns, which cut duplicate and ghost enrolment, and 2021-22 came right after the pandemic, when many families had
moved children to government schools. The lens counts school-age children where the share fell 5 points or more and
lists the steepest falls and rises. First run: Delhi -6.2 points (Sangam Vihar -23.6), Hyderabad -4.9, Kolkata +2.7.

## Recorded road crashes (`crashrecord` lens in js/urban-lenses-mobility.js, `road_crashes` dataset, pipeline/realestate/btpcrashes.py)

Bengaluru Traffic Police publishes station-wise crash tables (2018-2020, 2021-2022, 2023, 2024, 2025: fatal, non-fatal and total cases) and a 2022 map of its 47 jurisdictions on data.opencity.in (public domain). Each lived-in Bengaluru block takes its jurisdiction's crashes and fatal crashes a year (2023-2025 mean), the same per km² (spheroid area of the polygon), and the change in fatal crashes against 2018-2019. Station spellings vary by year (`ALIAS`); stations opened after 2022 are added to the jurisdiction they were carved from (`PARENT`: Mahadevapura to K.R. Puram, Bellanduru to HSR Layout, JP Nagar to Jayanagar, Thalagattapura to Kumaraswamy Layout, Jnanabharathi to Kengeri, Kodigehalli to Hebbal, Chickpet to Upparpet), a judgement call that keeps years comparable. One unnamed airport polygon has no counts.

The lens shows fatal crashes per km², counts residents where that is at least twice the median jurisdiction's and where fatal crashes rose 25% or more, and lists the densest jurisdictions. Unlike `roadsafety` (modelled exposure on the school walk) these are police records, but only per jurisdiction. The property report adds the jurisdiction's crashes a year and the fatal trend.

## Mapped slums (`slummap` lens, `slums_mapped` dataset, pipeline/realestate/slums.py)

The corporations' own slum boundary maps on data.opencity.in (public domain): Greater Chennai Corporation (887 polygons), GHMC Hyderabad (1,351, with notified or non-notified status), MCGM slum clusters 2015 (2,542, no attributes) and BBMP Bengaluru (509, with status; spellings such as "Non_Notofied" are normalised). A DuckDB overlay gives each lived-in block the share of its area inside a mapped slum, the number of slums touching it, and the notified share of that slum area. Blocks under 1% are dropped.

The lens counts residents in blocks at least 20% slum and residents × slum share ("on slum land"), the part of them in mostly non-notified slums (Hyderabad, Bengaluru) and in blocks that also flood (`flood_reports`). Modelled population spreads people evenly, so it understates slum density: Mumbai shows 18% of residents in slum blocks against about 42% in the 2011 census. It complements the `informal` lens, which infers settlements from building form and wealth rather than official maps.

## Public toilets from corporation lists (`toilets_official` dataset, pipeline/realestate/toilets.py)

Point maps of public and community toilets on data.opencity.in: PMC Pune (547), GCC Chennai (613), BMC Mumbai (about 8,400 community and public toilet blocks with men's and women's seat counts) and GHMC Hyderabad (574, September 2018), counted per L7 block. The `toilets` lens (js/urban-lenses-planning.js) now takes, per block, the larger of this count and OpenStreetMap's, so its gaps in these four cities reflect the corporation network rather than missing mapping, and in Mumbai it adds residents per women's seat. Bengaluru's BBMP list on OpenCity has no licence, so it is not used.

## Police station per block (`police_stations` dataset, pipeline/realestate/police.py)

Law-and-order police station jurisdiction maps on data.opencity.in (public domain): Mumbai (91 stations), Bengaluru (120 KGIS boundaries, including the rural stations around the city) and Hyderabad (73). Each lived-in block takes the station whose polygon holds its centre; names drop "PS" and "Police Station" and keep the maps' spellings. `UrbanLenses.places()` carries it as `police`, so DISHA's "which police station is this?" (`whereis`) and the property report header name it.

## Lok Sabha 2024 results and turnout (`turnout` lens in js/urban-lenses-safety.js, `elections_2024` dataset, pipeline/realestate/elections.py)

Election Commission of India 2024 tables on data.opencity.in (public domain): candidate EVM votes by assembly segment, and winners with runners-up and margins. Each block's assembly segment and Lok Sabha seat come from the `constituencies` dataset (2008 delimitation, which 2024 still used), matched by number plus a fuzzy name match (ratio 0.7) because spellings differ ("Vandre West" against "VandreEast") and city regions cross state lines. Fields: MP and party, margin as % of the seat's EVM votes, and the segment's EVM turnout (votes including NOTA over electors), leading party and NOTA share. A few segments do not match (about 900 Thane blocks in the Mumbai region; some Kolkata margins).

`UrbanLenses.places()` adds the MP, so DISHA's "who is the MP here?" and the property report name them. The lens shows the resident-weighted turnout, residents in segments under 50% and in seats won by under 2%, and the lowest-turnout segments. Low turnout partly reflects stale electoral rolls, not only abstention.

## Anganwadi reach (`anganwadi` lens in js/urban-lenses-mobility.js, `anganwadis` dataset, pipeline/realestate/anganwadis.py)

Anganwadi (ICDS) centre points from data.opencity.in (public domain): the Telangana state map (35,364 centres) clipped to the Hyderabad region, the Karnataka KGIS map (65,654) clipped to Bengaluru, and Greater Chennai's 2023 map (1,806, corporation limits only). Duplicates are dropped and centres counted per L7 block. The lens walks the OpenStreetMap network (walkTree, out to 1 km) from every centre and counts children under five (WorldPop) more than 500 m away, those in mapped slum blocks, and residents per centre against the ICDS urban norm of 400-800; it picks up to five new-centre sites with at least 60 unserved children under five within 500 m, 1 km apart.

## Free clinic reach (`freeclinic` lens in js/urban-lenses-mobility.js, `public_care` dataset, pipeline/realestate/publiccare.py)

Public primary care points from data.opencity.in (public domain): Greater Chennai UPHCs (140) and maternity units, Hyderabad district health centres (388) and, for Bengaluru, BBMP UPHCs (139) plus Namma Clinics (240, 2026), with the same centre on two lists counted once (4-decimal rounding). Mumbai City's UPHC, dispensary and maternity maps round coordinates to 0.01 degrees (about 1 km), so they are left out. The lens walks the OpenStreetMap network out to 2 km and counts residents more than 1 km from a centre, but only in blocks within 3 km of some listed centre, because each map covers only its corporation or district; it reports residents per centre against the NUHM norm of one UPHC per 50,000 and picks up to five new-clinic sites with 5,000+ unserved residents within 1 km.

## Tree census (`treecensus` lens in js/urban-lenses-environment.js, `tree_census` dataset, pipeline/realestate/treecensus.py)

Municipal tree censuses from data.opencity.in (public domain): Pune Municipal Corporation's 2019 census (17 CSV parts, about 4 million trees with botanical name, girth, canopy diameter and condition) and BBMP Bengaluru's census as released in July 2026 (species and location). Trees are counted per L7 block with species (genus and species, lower case), the most common species' share, invasive exotics (subabul/Leucaena, mesquite/Prosopis, earleaf acacia, gliricidia), and for Pune big trees (girth 150 cm or more), canopy area and the share recorded dead, poor or average. The lens judges only lived-in blocks within 1 km of a counted tree, since each census stops at the corporation boundary and ward coverage is uneven; it reports trees per 100 residents, residents in blocks under 10 per 100, single-species and invasive-heavy blocks, and planting picks ranked by residents times summer surface heat above 30 °C.

## Fire station reach (`firereach` lens in js/urban-lenses-safety.js, `fire_stations_official` dataset, pipeline/realestate/firestations.py)

Fire station points from the fire services' maps on data.opencity.in (public domain): Mumbai Fire Brigade (35), Pune Fire Brigade (14), Telangana Fire Services in Hyderabad (21, 2018) and Karnataka State Fire and Emergency Services (the Bengaluru list plus the state list clipped to the region; 20). The lens loader (`TOPUPS` in js/urban-lenses.js) tops up `places.fire_stations` per block with whichever of the official list and OpenStreetMap/Overture counts more, so marketfire, firelanes, critwater, crowds and reach all gain the official stations (OpenStreetMap had 5 in Pune and Hyderabad). The lens takes straight-line distance from each lived-in block to the nearest station, judges blocks within 10 km of a listed station, and reports residents per station, lived-in area per station against the Standing Fire Advisory Council norm of 10 km², residents beyond 3 km and 5 km, and five new-station picks that bring the most residents within 3 km. Delhi and other cities without an official list use OpenStreetMap/Overture alone, which undercounts (Delhi Fire Service runs about 70 stations).

## Street light poles (`streetpoles` lens in js/urban-lenses-mobility.js, `street_lights` dataset, pipeline/realestate/streetlights.py)

BBMP's 2024 street light maps on data.opencity.in (public domain) for Bangalore East, RR Nagar, Bommanahalli and Dasarahalli zones: about 1.9 lakh distinct poles (repeats within ~1 m dropped) with lamp type, counted per L7 block with how many are LED (33%). The lens divides poles by the block's OpenStreetMap street length and flags blocks under 15 poles per street km, where gaps exceed the 30-60 m spacing of urban lighting practice; it judges only surveyed ground (75% of lived-in blocks within 500 m have poles) and picks five dim blocks 1 km apart by residents times shortfall. Pune's ward-wise street light table assumes a flat 62 poles per km in every ward, so it is not used.

## Official top-ups (`TOPUPS` in js/urban-lenses.js)

Some crowd-sourced counts in the `places` dataset miss most of a city's public facilities. Where an official list exists, the lens loader takes, block by block, the larger of the two counts: `fire_stations_official.stations` tops up `places.fire_stations`, and `libraries_official.libraries` (Pune 54, Bengaluru 105 public libraries, pipeline/realestate/libraries.py) tops up `places.libraries`, which the cooling-centre lens reads (Pune's unserved hot-quarter residents fall from 41.2% to 40.3%). `schools_official.schools` (Mumbai, BMC's municipal, aided and unaided school maps, a building counted once; pipeline/realestate/bmcschools.py) tops up `emergency_access.schools`, which cuts Mumbai's children with no school within 1 km from 7.7% to 6.5% in the school gap lens. `community_halls.halls` (GHMC's 2018 community hall map, 1,264 in the Hyderabad region; pipeline/realestate/communityhalls.py) tops up `places.community_centres`, which cuts Hyderabad's hot-quarter residents with no cooling-centre candidate within 1 km from 29.3% to 11.5%. The official dataset is listed among the frame's sources when it is used.

## Water bodies census (`pondcensus` lens in js/urban-lenses-environment.js, `water_bodies` dataset, pipeline/realestate/waterbodies.py)

India's first Census of Water Bodies (Ministry of Jal Shakti, 2023; enumerated 2018-19) from the state maps on data.opencity.in (public domain): Delhi (893), Kolkata (2,574 in the region), Hyderabad (Hyderabad and Rangareddy maps plus the two Telangana state maps clipped to the region; 340) and Bengaluru (Bengaluru Urban plus the Karnataka map clipped; 334). Each body is counted in its L7 block with whether it is in use, whether it is encroached, government ownership and storage when full; repeats across maps are dropped by the census unique id. Bengaluru's maps mark every tank "not in use" and "not encroached", a blank default, so the pipeline keeps only its counts and the lens skips Bengaluru. Tamil Nadu and Maharashtra maps are non-commercial and are not used. The lens reports bodies not in use and encroached (Delhi 74% and 24%, Hyderabad 44% and 25%, Kolkata 24% and none reported), residents within 1 km of one, public ownership, storage, and five revival picks ranked by disused or encroached bodies times residents within 1 km.

## Subsidised canteen reach (`canteen` lens in js/urban-lenses-mobility.js, `canteens` dataset, pipeline/realestate/canteens.py)

Subsidised public canteens from the city maps on data.opencity.in (public domain): Indira Canteens in Bengaluru (157, KGIS 2022), Amma Unavagams in Chennai (383, GCC 2023) and Annapurna meal centres in Hyderabad (128, GHMC 2018). The lens walks the OpenStreetMap network out to 2 km from every canteen, judges blocks within 3 km of a listed canteen, and reports residents per canteen, residents and mapped-slum residents more than a 1 km walk away (Chennai 17%, Bengaluru 39%, Hyderabad 49%), and five new-canteen sites 2 km apart where the most unserved residents live within 1 km, counting slum residents twice.

## Sewer gaps (`sewergap` lens in js/urban-lenses-mobility.js, `sewers` dataset, pipeline/realestate/sewers.py)

BWSSB's sewerage line maps (KGIS) for Bengaluru on data.opencity.in (public domain), in three diameter bands (under 150 mm, 150-300 mm, 300 mm and above; about 10,400 km). Each line is cut into pieces of at most 25 m and each piece's length goes to the L7 block at its midpoint, giving sewer length and trunk-sewer length per block. The maps' Status field is mostly blank, so pipe age is not used. The lens judges lived-in blocks within 2 km of a mapped sewer and inside the corporation's wards (the `wards` dataset gives `in_area`, so cantonments, other towns and villages past the limit, which run their own drainage, are not read as gaps), counts residents with no sewer within 250 m (6%) and those where sewers run along under 30% of the OpenStreetMap street length (16.5%), mapped slum residents unsewered, and five unsewered blocks 1.5 km apart with the most unserved residents within 500 m.

Chennai comes from CMWSSB's sewer main network on data.opencity.in (public domain): about 181,000 pipes and 4,200 km, with pipe size given as a code that the published "Sewer Main Codes" note maps to millimetres (`CMWSSB_MM`; 300 mm and up counts as trunk). The same rules give 9.8% of residents with no sewer within 250 m and 16.1% thinly sewered, with the gaps in Manali, Perungudi and Royapuram.

Pune comes from PMC's drainage map on data.opencity.in, listed there as storm-water drains: of its 141,341 lines, the road, nala and river sewers (about 2,190 km; `drainaige_` Trunk_Sewer gives 306 km of trunk sewer, as most collection sewers are 300 mm) are kept and its storm drains and nalas left out. 5.2% of residents have no sewer within 250 m and 32.9% are thinly sewered. PMC's separate "sewage network" map holds only about 660 km and leaves out most of the old city, so it is not used.

Hyderabad comes from HMWSSB's core-city sewer lines on data.opencity.in (a GeoJSON in UTM zone 44N, converted with `police.utm_to_lnglat`): 90,299 lines, about 3,260 km, in 72 operation and maintenance sections. As the map covers only the core city, `in_area` there is the GHMC ward blocks whose centre lies inside the convex outline of a mapped section (`section_cells`). The core is almost fully sewered: 0.5% of residents have no sewer within 250 m and 11% are thinly sewered, with the pockets in Moosapet, Shastripuram and Kanchanbagh.

## Planned road widening (`roadplan` lens in js/urban-lenses-civic.js, `road_plan` dataset, pipeline/realestate/roadplan.py)

BDA's Revised Master Plan 2015 road width map for Bengaluru on data.opencity.in (public domain): 23,238 segments with a planned right of way (`RR_WIDTH_P`, 12-67 m; `RR_width_B` is half of it, the setback from the centre line) and a type (`W` widening, `C` new connection). Lines are cut into pieces of at most 25 m (the sewer pipeline's `pieces`) and summed per L7 block: planned road length, length planned 24 m or wider, proposed link length and the widest planned road. The lens reports residents in blocks on a road planned 24 m or wider (31%) and in blocks a proposed link crosses (6%), and five populated blocks 1.5 km apart with the most link length times residents. js/urban-lenses-civic.js is a new lens module (the others are near the 150 kB budget); it is loaded in app.html, cached in sw.js, and listed in tests/setup.js and scripts/build_lens_league.js.

## Cremation and burial grounds (`lastrites` lens in js/urban-lenses-civic.js, `funeral_sites` dataset, pipeline/realestate/funeral.py)

Cremation grounds, crematoriums and burial grounds from the corporations' maps on data.opencity.in (public domain): BMC funeral and cremation sites (Mumbai, 189), PMC cremation and burial grounds (Pune, 76), GCC burial grounds and crematoriums (Chennai, 210) and BBMP's electric crematoriums (12) and burial grounds (68) for Bengaluru, whose list leaves out open cremation grounds. The lists do not separate burial from cremation reliably (GCC calls every site a burial ground, BMC calls Hindu cremation grounds cemeteries), so only the site count and electric or gas crematoriums (named in the list) are kept. The lens takes straight-line distance to the nearest site for lived-in blocks within 8 km of one, and reports residents per site, residents beyond 3 km (Mumbai 8%, Chennai 8%, Pune 10%, Bengaluru 13%) and five new-site picks.

## Borewells beside septic tanks (`wellrisk` lens in js/urban-lenses-civic.js, `borewells` dataset, pipeline/realestate/borewells.py)

BWSSB's public borewell map (KGIS) on data.opencity.in (public domain): 7,438 records, about 7,200 distinct wells after dropping repeats within ~10 m, counted per L7 block. The lens crosses them with the `sewers` dataset: a well block has no sewer nearby when no mapped sewer runs within 250 m (0.5% of wells) and is thinly sewered when its sewer length is under 30% of its OpenStreetMap street length (11.8%), where many homes drain into septic tanks and soak pits over the same aquifer (CPHEEO asks for 15-30 m between a soak pit and a well). It reports the wells and residents in such blocks and five blocks to test first, ranked by level times wells times residents. It marks where to test, not measured contamination.

## Waste bin reach (`binreach` lens in js/urban-lenses-civic.js, `waste_bins` dataset, pipeline/realestate/wastebins.py)

Public bins from the corporations' maps on data.opencity.in (public domain): GCC street bins for Chennai (2022; 8,130 distinct in the region) and GHMC dumper bins for Hyderabad (2018; 2,505, many since removed under the bin-free drive), repeats within ~10 m dropped. The lens judges lived-in blocks within 1 km of a listed bin and reports residents per bin, residents with no bin within 250 m on the block grid (Chennai 13%, Hyderabad 38%) and five unserved blocks 1.5 km apart. Door-to-door collection replaces bins in many wards, so a gap marks where to check collection, not dumping.

## Large-project pipeline (`bigprojects` lens in js/urban-lenses-civic.js, `big_projects` dataset, pipeline/realestate/seiaa.py)

SEIAA Karnataka's map of construction projects with state environmental clearance in Bengaluru Urban (KGIS) on data.opencity.in (public domain): 598 distinct projects. Building projects of 20,000 m² or more built-up need this clearance (EIA Notification 2006, item 8(a)), so the map covers the city's large apartment, office, mall and hotel projects. The type is read from the project name (397 residential, 158 commercial; mixed use counts in both, about 40 names say neither). The lens counts projects within 2 km of each block and reports residents with five or more nearby (47%) and the five busiest clusters 1.5 km apart, all in the east (Bharath Aikya Ward, Kaveri Nagara, S.M. Krishna Ward, Hoodi, Kundalahalli). The map has no clearance dates, sizes or completion status, so a cluster shows where large projects were cleared, not what is still to come.

## Coastal and eco-sensitive building limits (`buildlimits` lens in js/urban-lenses-civic.js, `eco_limits` dataset, pipeline/realestate/ecolimits.py)

Chennai: the Tamil Nadu CRZ boundary (TNGIS) on data.opencity.in (public domain) is a set of lines, not areas. It draws the landward CRZ line 500 m from the high-tide line along the sea and both edges of the zone along the tidal Adyar, Cooum and Buckingham Canal, but not the high-tide line. The zone is rebuilt on a 20 m raster: the lines become walls; land reached from the inland edge is outside; from the part reached from the sea edge, the 500 m band next to the line is the coastal zone and the rest is sea; a walled pocket is a waterway zone when no point in it is more than 300 m from a wall, and ordinary land caught between two zones otherwise (the 1-1.5 km strip between the Buckingham Canal and the coast). The result is 24 km², with 3.9 lakh residents (4.5%) and 6.5 km² of built-up land inside, most in the fishing wards of Royapuram and along the Adyar. The northern Buckingham Canal pair is left open by a gap in the lines and is not counted. Bengaluru: the Karnataka Forest Department's 2022 Bannerghatta National Park eco-sensitive zone and protected areas (with Puttenahalli Lake Bird Conservation Reserve), which only clip the city region's southern edge. Each block carries the share of its land inside; the CRZ category (I-IV) and site-level limits need the approved Coastal Zone Management Plan map.

## Police station reach (`policereach` lens in js/urban-lenses-civic.js, `police_official` dataset, pipeline/realestate/police.py)

Police stations from the state police maps on data.opencity.in (public domain): Mumbai Police station locations (BMC disaster management GIS; 101 after keeping subtype "Station"), Karnataka Police KGIS stations (115) and outposts (12) for Bengaluru Urban, and Telangana Police properties for Hyderabad district plus the state map (UTM zone 44N, converted with the USGS series) for the Cyberabad and Rachakonda suburbs. Telangana lists police properties, not stations, so names are kept only when they name a station ("PS", "Police Station", "WPS") outside parentheses and are not traffic stations, quarters, outposts, offices, old or unbuilt buildings (84 stations in the region). The loader max-merges the counts into `places.police`. The lens takes straight-line distance to the nearest station and judges only blocks inside the city police's own jurisdiction map (the `police_stations` dataset) in Mumbai and Bengaluru, so Thane is not read as a gap; Hyderabad's jurisdiction map covers only the city commissionerate, so there blocks more than 3.5 km from every station are left out. Residents more than 2 km from a station: Mumbai 4.7%, Bengaluru 11%, Hyderabad 19%, with five new-station picks 1.5 km apart.

## Lake buffer building (`lakebuffer` lens in js/urban-lenses-civic.js, `lake_buffers` dataset, pipeline/realestate/lakebuffers.py)

The Karnataka GIS wetland map of Bengaluru Urban on data.opencity.in (public domain) gives 265 lakes, tanks and other wetlands as polygons, without names. They are filled on a 10 m raster (47 km² in the city region), and a distance transform gives the land within 30 m of a lake (the no-build buffer in Bengaluru's zoning regulations; 10.7 km²) and within 75 m (the National Green Tribunal's 2016 buffer, set aside by the Supreme Court in 2019). Each block carries its lake, 30 m and 75 m shares. The lens estimates built land in the buffer pro rata, the block's built-up share times its buffer share (about 1.35 km², 12.6% of the 30 m buffer, and 38,000 residents), and maps the smaller of the two shares as an upper bound per block. It flags blocks to check against survey sketches, not plots.

## Neighbourhood park reach (`parkreach` lens in js/urban-lenses-civic.js, `parks_official` dataset, pipeline/realestate/parksofficial.py)

Parks, playgrounds and layout open spaces from the corporations' maps on data.opencity.in (public domain): GHMC parks (821), playgrounds (488) and open spaces left in approved layouts (1,353; land reserved for public use, not yet a park), September 2018, for Hyderabad; PMC parks and gardens (198 outlines, about 200 ha; area from the outline) for Pune. A block is served when a listed park or playground lies within 500 m on the block grid, URDPFI's housing-area park; blocks more than 3 km from any listed park are outside the corporation's map. Residents with none within 500 m: Hyderabad 41%, Pune 53% (Pune's list leaves out the cantonments and private green space). Hyderabad picks are layout open spaces 1.5 km apart with the most unserved residents within 500 m, the cheapest new parks since the land is already reserved; Pune picks are unserved blocks.

Hyderabad (added the same day): GHMC's land-use map of reservoirs and tanks (849 polygons, 40.7 km² in the region) on data.opencity.in (public domain). The statutory buffer there follows GO Ms 168 (2012): 30 m round tanks of 10 ha or more (149) and 9 m round smaller ones (700); the 9 m band is under one 10 m pixel wide, so pixels next to the shore count. About 2.2 km² of the 11 km² buffer is built up (20%, pro rata), home to some 78,000 residents.

## Storm-water drain buffer building (`drainbuffer` lens in js/urban-lenses-civic.js, `drain_buffers` dataset, pipeline/realestate/drainbuffers.py)

BBMP's 2022 storm-water drain maps on data.opencity.in (public domain): 329 km of primary drains (rajakaluves), 440 km of secondary and 1,222 km of tertiary, as centrelines. Each class is drawn on a 10 m raster and distance transforms give the Revised Master Plan 2015 buffer (50 m from the centre of a primary drain, 25 m from a secondary, 15 m from a tertiary; 114.5 km²) and the National Green Tribunal's wider 2016 buffer (50, 35 and 25 m), which the Supreme Court set aside in 2019 and is kept as a screen. Each block carries its drain lengths and buffer shares. The lens estimates built land in the buffer pro rata (about 33 km², 29%, and 17 lakh residents) and maps the smaller of the block's buffer and built-up shares as an upper bound. Many tertiary drains run beside streets, so their buffer also takes in road space; the result flags blocks to survey, not plots.

## Birdlife (`birdlife` lens in js/urban-lenses-civic.js, `birds` dataset, pipeline/realestate/birds.py)

Baked for all 12 cities (Indore pilot aside); Delhi has 14.5 lakh records (Okhla and Basai/Sultanpur lead), Kolkata 3.5 lakh, Ahmedabad 2.2 lakh, Jaipur and Lucknow about 1 lakh each, Guna a handful. GBIF occurrence records of birds (class Aves) since 2015, keeping only records licensed CC0 or CC BY 4.0 (mostly the eBird Observation Dataset and iNaturalist research-grade; CC BY-NC records are left out). One occurrence search per ~1 km DIGIPIN block (level 6), faceted by species, gives the records and the per-species counts; no key is needed. Raw species counts follow birding effort, so richness is rarefied to 200 records with the hypergeometric expectation, E[S] = Σ 1 − C(N − Nᵢ, 200) / C(N, 200), and only blocks with 200 or more records are rated. Bengaluru has 33 lakh records and a median of 57 species in 200 records; blocks with under 20 records count as unsurveyed (20% of Bengaluru's residents, 54% of Hyderabad's). Hotspots need 1,000 or more records, since a few long checklists can fake richness. Low-canopy blocks often rate higher than leafy ones because lakes and scrub hold more species, so canopy is not a stand-in for birdlife.

Mumbai (added the same day): BMC's map of public gardens, parks, recreation and play grounds, Miyawaki gardens and zoos (950 distinct points, with OpenCity's corrections; names with "P.G.", "playground" or "maidan" count as playgrounds, 162). Only blocks inside Mumbai Police's jurisdiction map, which matches the BMC area, are judged, so Thane and Mira-Bhayandar are not read as gaps; 19% of residents have no listed park or playground within 500 m.

## Storm-drain gaps on wet streets (`stormgap` lens in js/urban-lenses-civic.js, `storm_drains` dataset, pipeline/realestate/stormdrains.py)

Storm-water drain maps on data.opencity.in (public domain): GCC's 2023 map for Chennai (10,257 drains, 2,225 km; `COVER` and `DRAIN_DETL` give 2,028 km covered or closed) and PMC's drainage map for Pune, whose `category` field separates storm drains (1,122 km) and nalas (404 km) from the sewers that feed `sewers`. Lines are cut into 25 m pieces (`sewers.pieces`) and summed per L7 block; `in_area` comes from the corporation's ward map. BBMP's Bengaluru maps hold only 1,662 km of secondary and tertiary drains against far more streets, so 95% of residents would read as thinly drained and Bengaluru is left out (its drains feed `drain_buffers`). The lens compares drain length with the block's OpenStreetMap street length (capped at 100%), judges lived-in blocks inside the corporation within 1.5 km of a mapped drain, and marks a block wet when it is in the wettest quarter of judged blocks on the waterlogging index or has a reported flood spot within 300 m. Residents where drains run along under 30% of the streets: Chennai 55%, Pune 65%; of them in wet blocks: Chennai 37%, Pune 19% of all residents. Picks are wet, thinly drained blocks 1.5 km apart ranked by residents, waterlogging and flood spots (Teynampet, Adyar, Anna Nagar and Velachery in Chennai; Wanawadi, Harinagar and Kharadi in Pune). Lane drains are often missing from the maps, so a pick is a block to check on the ground.

## Piped water gaps (`watergap` lens in js/urban-lenses-civic.js, `water_lines` dataset, pipeline/realestate/waterlines.py)

BWSSB's detailed water supply line maps for Bengaluru on data.opencity.in (public domain): lines of 300 mm or less (97,827 lines, about 10,800 km) and mains wider than 300 mm (2,865 lines, about 940 km). The KMLs carry geometry only, so diameter comes from which file a line is in. Lines are cut into 25 m pieces and summed per L7 block (`pipe_m`, `main_m`), and `in_area` comes from the corporation's ward map. The lens uses the sewer-gap yardsticks: lived-in blocks inside the corporation within 2 km of a mapped line, no water line within 250 m (3.8% of residents) or lines along under 30% of the OpenStreetMap street length (12.6%). It also counts residents with neither a water line nor a sewer within 250 m (3.1 lakh) and public borewells in unpiped blocks, and picks five unpiped blocks 1.5 km apart with the most unserved residents within 500 m (Andrahalli, Dodda Bidarakallu, Doddabettahalli, Abbigere, Bagalagunte). The maps predate some Cauvery stage V work in the 110 villages, and a line nearby does not mean a connection or daily supply.

## Sewage treatment plants nearby (`stpnear` lens in js/urban-lenses-civic.js, `stps` dataset, pipeline/realestate/stps.py)

Sewage treatment plants on data.opencity.in (public domain): BWSSB's list of 39 plants with coordinates and capacity in KLD (Bengaluru, 1,372 MLD; three without a capacity), CMWSSB's plant outlines for Chennai (8 plants, capacity for only some, so no capacity check there) and PMC's outlines of 9 existing (477 MLD) and 8 proposed plants for Pune. Outlines are placed at their centre and a plant drawn as several outlines counts once (same id or name). The lens judges lived-in blocks within 3 km of a plant on the block grid (within 500 m, within 1 km, farther) and reports residents within 500 m of a plant (Bengaluru 1.9 lakh, 1.4%; Pune 1.1 lakh; Chennai 79,000) and, in Pune, of a proposed one (38,000). Where 85% or more of the plants have a listed capacity, the total is set against the sewage residents make at CPHEEO's 135 litres a head a day with 80% returned (Bengaluru 96%, Pune 69% on rated capacity; plants often run below their rating). Picks are the plants with the most residents within 500 m (Chamarajpet in Bengaluru, Erandwane in Pune, Royapuram in Chennai).

## Basic services together (`basics` lens in js/urban-lenses-civic.js)

A synthesis of the agency network maps already in the cells: `water_lines` (BWSSB), `sewers` (BWSSB, CMWSSB, PMC, HMWSSB core city), `storm_drains` (GCC, PMC), `waste_bins` (GCC, GHMC) and `toilets_official` (GCC, PMC, GHMC, BMC). A lived-in block is short of a network when none runs or stands within 250 m on the block grid (1 km for public toilets). Only networks the city has mapped count, and at least two are needed (so Mumbai, with toilets only, gets no result); a block is judged only within 2 km of every counted network and inside the corporation where an `in_area` field gives the limit, which keeps Hyderabad to its mapped core. The map shows how many networks are missing (0-4). Residents short of two or more: Bengaluru 2.4% (water line and sewer, in Andrahalli, Kempegowda Nagara, Dodda Bidarakallu, Bagalagunte), Chennai 8% (Manali, Tondiarpet, Royapuram, Tiruvottiyur), Pune 3.1%, core Hyderabad 2.1% (bins and toilets in Shastripuram, Kanchanbagh, Riyasat Nagar).

## Property registration offices (`sroload` lens in js/urban-lenses-civic.js, `registration` dataset, pipeline/realestate/registration.py)

Every plot is registered at the sub-registrar office (SRO) whose jurisdiction holds it, and guidance values are set per SRO. The maps on data.opencity.in (public domain): Karnataka Stamps and Registration's Bengaluru Urban SRO jurisdictions (50) with KGIS office locations, and Tamil Nadu Registration's statewide SRO jurisdictions (697) with TNGIS office locations (699). Each lived-in L7 block takes the jurisdiction holding its centre (DuckDB spatial; a few Tamil Nadu polygons that `ST_MakeValid` rejects go in as drawn), giving `sro`, `dro` and the official code `sro_id` (lenses group by the number). `sro_km` is the straight-line distance to the office of that name, the nearest one where a name repeats, and dropped beyond 30 km (another district's office); Chennai's Thiyagaraya Nagar has no office point under that name. The lens reports offices covering the city, residents per office (Bengaluru median 1.5 lakh, busiest 12.9 lakh; Chennai median 2.6 lakh, busiest 6.2 lakh), the distance within which half of residents live (2.2 and 2.5 km) and residents more than 10 km from their office, with SEIAA large projects per office in Bengaluru.

## Pincode crowding (`pinsize` lens in js/urban-lenses-civic.js, `pincodes` dataset, pipeline/realestate/pincodes.py)

India Post published all-India pincode boundaries in May 2025 (19,312 pincodes; OpenCity, public domain). Every lived-in block in the 12 cities takes the pincode whose boundary holds its centre (DuckDB spatial), with the post office it is named after, the postal division and the pincode's whole area. The lens sums block residents per pincode inside the city view and flags pincodes of more than 5 lakh people, where a pincode alone is a poor address and a DigiPin adds most. Delhi: 154 pincodes, median 1.3 lakh residents over 10.9 km², 110090 the most crowded at 9.8 lakh, 31% of residents in pincodes over 5 lakh. Bengaluru: 115, median 52,000, 16.5% over 5 lakh. Mumbai: median 1.3 lakh over 3.9 km². Chennai: median 79,000, none over 5 lakh. Boundaries are India Post's delivery areas, not legal limits, and a pincode reaching past the city view is counted only for its part inside.

## Pothole complaints (`potholes` lens in js/urban-lenses-civic.js, `potholes` dataset, pipeline/realestate/potholes.py)

BBMP's Fix My Street log for May and June 2022 (OpenCity, public domain) holds about 16,500 pothole requests with location, status, work type, road class, measured size and the engineer's repair estimate. The 3,100 the BBMP rejected are dropped; names and phone numbers in the log are never read. Per block: accepted complaints, how many were fixed (work done or resolved) by the end of June, utility road cuts, complaints on arterial and sub-arterial roads, square metres to repair and the estimate. The lens sets complaints against the block's OpenStreetMap street length (at least 0.5 km) and picks the blocks with the most unfixed complaints. Bengaluru: 13,444 accepted complaints in 2,931 blocks, 19.5% fixed by the end of June, 17.9% utility road cuts, 33% on main roads, about 95,700 m² and ₹4.6 crore of repairs; Parvathi Nagar had 57 complaints in one block, none fixed. A two-month snapshot of what people reported, not a road survey.

## Revenue villages (`revvillage` lens in js/urban-lenses-civic.js, `villages` dataset, pipeline/realestate/villages.py)

Land records in India (RTC in Karnataka, 7/12 extract in Maharashtra, AnyROR in Gujarat, khasra and jamabandi in Delhi, Banglarbhumi in West Bengal) are filed by revenue village and survey number, not by street address. Survey of India's village boundaries on OpenCity (public domain) cover Bengaluru Urban (702 villages), Pune district (1,922), Ahmedabad district (559), south Kolkata (70) and Delhi's eleven districts (2022). Every lived-in block takes the village whose boundary holds its centre, with tehsil and district. Where the map draws a town, municipal or cantonment limit in place of villages (old BBMP core and the former city municipalities, Pune's "Urban" core and Hadapsar (Urban), "Suburbs of Kolkata", Jadid Chhawni and Ahmedabad cantonment) the block is marked `in_town`: land there sits on the city survey. Delhi's maps leave out the urbanised core (New Delhi district). Results: Delhi 347 villages under homes, 73% of residents on village land, 72 villages now home to more than 1 lakh people (Basai Darapur 4.7 lakh); Pune 72 villages, 43% of residents (57% in the urban core); Bengaluru 343 villages but only 17% of residents (83% in the old corporation and municipalities). Boundaries are the survey's, not a title record.

## BDA layouts (`bdalayout` lens in js/urban-lenses-civic.js, `bda_layouts` dataset, pipeline/realestate/bdalayouts.py)

The Bangalore Development Authority's layout boundaries (OpenCity, public domain; 149 outlines of 59 layouts such as Arkavathy, Gnanabharathi, Sir M Vishveshwarayya and the Banashankari 6th Stage extensions). Every block of the region whose centre is in a layout takes its name, BDA code and the layout's whole area, so vacant layouts are included. A BDA-layout plot was acquired and allotted by the authority, which buyers treat as a cleaner title than a private or revenue layout. The lens rolls up per layout the satellite built-over share (built_up layer), residents and new buildings since 2016 (building_stock layer). Bengaluru: 58 layouts on the map, about 184 km², 38 lakh residents (29%), 36% of layout ground built over; the emptiest large layouts are in the south-west (Anjanapura, Talagattapura, Badamanavarthekaval, 8 to 14% built), and the fastest filling add about 1,800 to 2,000 buildings per km² since 2016.

## Paved-over watersheds (`watershedpave` lens in js/urban-lenses-civic.js, `watersheds` dataset, pipeline/realestate/watersheds.py)

Micro-watershed boundaries with Watershed Atlas of India codes (basin to micro-watershed) for seven cities on OpenCity (public domain). Every block takes the micro-watershed holding its centre, its watershed and the micro-watershed's area (the atlas AREA field, hectares). The lens averages the satellite built-over share across each micro-watershed's blocks, judging only those at least half inside the view, and classes them by the Impervious Cover Model (Schueler 1994; Center for Watershed Protection 2003): up to 10% sensitive, 10 to 25% impacted, 25 to 60% non-supporting, over 60% urban drainage. Built-over ground is a floor for impervious cover (roads and paved yards outside built-up pixels are missed). Results: Chennai 26 of 37 micro-watersheds past 25% (most paved around Kodambakkam, 45%); Bengaluru 47 of 115 (Rajajinagar 52%); Delhi 106 of 326, one past 60% (around Press Enclave, West Delhi); Mumbai 10 of 37. The lens also lists catchments between 20 and 25%, the next to cross.

## Student housing near colleges (`studenthousing` lens in js/urban-lenses-civic.js, `colleges` dataset, pipeline/realestate/colleges.py)

Karnataka's higher-education maps (2023, KGIS) on OpenCity (public domain) give the Bengaluru Urban PU colleges (706), degree colleges (371, of which a separate map marks 21 government ones), engineering colleges (97), polytechnics (70) and universities (24). They are counted per block. The lens weights each college by the students it draws from out of town (university 3, engineering 2, degree and polytechnic 1, PU 0), sums that pull within 2 km on the block grid and divides it by one plus the hostels and PGs Overture Maps lists within the same distance. The biggest college clusters sit around V.V. Puram and Basavanagudi (about 90 colleges within 2 km, under 20 hostels listed); the largest gaps are at the edges (Anjanapura, Talagattapura, Hirandahalli, Kannur, Kogilu), where 10 to 15 colleges have no listed hostel or PG nearby. Overture misses many informal PGs, so a gap is a lead for a site visit. The `anchors` lens still answers general student-housing demand in every city.

## Vacant land in 2017, and since (`vacant2017` lens in js/urban-lenses-civic.js, `landuse_2017` dataset, pipeline/realestate/landuse2017.py)

The Karnataka State Remote Sensing Applications Centre's 2017 urban land use map of the BBMP area (OpenCity, public domain; about 157,000 polygons, 297 MB of KML) is read on its ULU and level 1 to 3 classes into nine groups: residential, commercial, industrial, vacant (vacant land plus laid-out but unbuilt layouts), civic, green, farm, water and road. Each block is sampled on a 6 x 6 grid of points (about 40 m apart, DuckDB spatial with an R-tree index; the bake takes about 9 minutes) and stores the share of points in each group. The lens totals the city's 2017 mix (47% residential, 4.7% commercial, 3.1% industrial over 649 km²) and its vacant land (94.5 km², 14.6%), then checks the 1,438 blocks at least 40% vacant in 2017 against new buildings since 2016 (building stock layer): 205 added few or no buildings and are the land most likely still open (Agaram, Anjanapura 8th Block, Talagattapura), while others filled fast (Sir MV Layout extension, Gottigere, about 160 to 200 new buildings a block). The vacant class includes defence and government land kept open.

## Land converted 2011-2017 (`landchange` lens in js/urban-lenses-civic.js, `landuse_2011` dataset, pipeline/realestate/landuse2017.py --year 2011)

KSRSAC's 2011 urban land use map of the BBMP area (OpenCity, public domain; about 74,000 polygons) stores its class as a number in each placemark's description, decoded with the map's published index (residential, mixed built-up, industrial, commercial, public and semi-public, vacant land, layouts, crop and fallow land, plantations, lakes, tanks, streams, roads, rail). It is sampled per block on the same 6 x 6 grid into the same nine groups as the 2017 map. The lens takes the fall in vacant plus farm share block by block: vacant and farm land went from 162.6 km² to 98.8 km², 79.4 km² was converted in the blocks that lost it, with gross gains of 69 km² of homes, 22 km² of shops and offices and 5 km² of industry; 21 km² of green ground was lost. The most converted blocks sit on the eastern and southern edges (Bharathiya City in Kogilu, Dodda Nekkundi, Yelenahalli, Anjanapura). The 2011 map rarely draws roads separately, so built classes are compared together, and lakes are outlined differently in the two maps, so the water losses it lists are leads to check.

## Ward and utility boundaries (`wardfit` lens in js/urban-lenses-civic.js, `service_areas` dataset, pipeline/realestate/serviceareas.py)

The utilities' own boundary maps on OpenCity (public domain): BESCOM section offices (237) and BWSSB service stations (143) for Bengaluru, TNEB sections (2,914 across Tamil Nadu, unnamed in the map) and CMWSSB depots (199) for Chennai. Every lived-in block takes the section and field unit holding its centre, with BESCOM's and BWSSB's office names, so a block answers "which electricity and water office do I go to". For each ward (wards layer) the pipeline then counts the distinct electricity sections, water units and police stations (police layer, Bengaluru) covering its lived-in blocks. Coterminous boundaries are a long-standing ask in city-systems reviews (Janaagraha ASICS); when they line up a ward deals with one or two of each. Bengaluru: the median resident's ward deals with 2 of each, but 20% live in wards split across 4 or more electricity sections; Agaram is the most split (9 sections, 8 water units, 8 police stations). Chennai: TNEB sections are small, so the median ward spans 4 electricity sections and 2 depots, and 63% of residents live in wards split across 4 or more sections (Ward 86, Ambattur: 10).

## Metro frequency and reach (`metrowait` lens in js/urban-lenses-civic.js, `metro_service` dataset, pipeline/traffic/metro_gtfs.py)

Hyderabad Metro Rail's GTFS timetable (Telangana open data, July 2026, via OpenCity; public domain) is binned per block with the bus timetable's code (`gtfs_cells.read_feed` and `cell_rows`): platforms, lines, weekday departures, departures an hour from 07:00 to 10:00 and the gap between trains at the busiest platform. The lens gives every block within 800 m (straight line on the block grid, the MoHUA TOD influence zone) the best peak headway among stations in reach, and divides the population within 800 m of each station by its peak departures as a rough crowding pointer. Hyderabad: 57 station blocks, 17.3 lakh residents (19%) within 800 m, 15.5 lakh of them with a train every 5 minutes or better; the Green line (JBS to MGBS) runs every 12 minutes at peak, so Bansilalpet, Bholakpur and Monda Market have the longest waits and the most residents per train. Bengaluru uses a community GTFS built from BMRCL's published timetables (github.com/Vonter/bmrcl-gtfs, ODbL; stop times estimated from published headways): 101 station blocks, 27.4 lakh residents (21%) within 800 m, but only 5.6 lakh with a train every 5 minutes at peak; the Green line's northern end (Peenya to Madhavara) runs every 11 minutes. Other cities' metro timetables are not openly published yet (Delhi's needs a registered key).

## Land parcel size and public land (`landgrain` lens in js/urban-lenses-civic.js, `cadastre` dataset, pipeline/realestate/cadastre.py)

Three official cadastral maps on data.opencity.in (public domain) are measured parcel by parcel: GHMC's town survey map of Hyderabad (147,000 parcels, each flagged government or private), the KGIS revenue survey map of the BBMP area (31,000 survey numbers plus stream, tank, road, canal and rail kharab strips) and PMC's revenue map of Pune (29,000 gut numbers). Each parcel's area comes from its outline on a local flat projection and it is counted in the block holding its centre; a block keeps its parcel count and median parcel, and the share of its ground in government land (Hyderabad) or kharab strips (Bengaluru) from a 6 x 6 point sample. The lens maps parcels per hectare and picks easy-assembly blocks (under 30% built, under 20% public, median parcel 1 to 20 ha; bigger single parcels are defence, palace or institutional estates). Hyderabad: the median block's typical parcel is 507 m², about 20 owners for a hectare, and 39.8 km² (31% of the mapped core) is government land; Bengaluru: 1.8 ha survey numbers, 41 km² (7%) kharab; Pune: 4 ha gut numbers. Survey numbers are often sub-divided (hissa) on the ground, so the counts are a floor.

## Official flood zones and return periods (`floodzones` lens in js/urban-lenses-civic.js, `flood_zones` dataset, pipeline/realestate/floodzones.py)

The Chennai flooding maps on data.opencity.in (public domain) hold the city's flood inundation hazard zones (7,453 polygons, five classes) and modelled flood extents for the 5, 10, 25, 50, 100 and 200-year return period flows (each in LOW, MODERATE and HIGH classes). Each block is point-sampled 6 x 6 against every map (DuckDB spatial; the bake takes about 25 minutes) for its share in each hazard class and inside each extent, plus the 100-year extent's HIGH class. The lens maps the yearly chance that a modelled flood covers a quarter of the block (1 / the most frequent such return period) and splits WorldPop residents by the shares: 9.2 lakh residents (13%) in the Very High or High hazard zones, 17.8 lakh inside the 5-year extent, 41.6 lakh inside the 100-year extent and 8.6 lakh in its deepest class. The extents model river and channel flooding, not street waterlogging, which the flood reports lens covers.

## Groundwater depth by ward and groundwater prospects (`gwdepth` and `gwprospect` lenses in js/urban-lenses-civic.js, `groundwater_local` dataset, pipeline/realestate/groundwater.py)

Chennai: CMWSSB's ward-wise monthly groundwater depth tables on data.opencity.in (public domain; one monitoring well per ward, 200 wards, 2021 to March 2024) are joined to the wards layer by ward number, so each block carries its ward well's May 2023 depth (before the north-east monsoon), December 2023 depth (after it) and the change in March depth from 2021 to 2024; zero readings (well not read) are dropped. The median resident's water table was 5 m down in May 2023 and 2.5 m in December; 15.7 lakh residents (22%) live where it was 8 m or deeper before the rains, and 11.4 lakh where the March level fell a metre or more since 2021. One well per ward is coarse, so a value is the ward's reading. Bengaluru: the groundwater potential map (good to poor-to-nil prospect zones from geology, landforms and lineaments, NRSC method) is read under each lived-in block's centre; it masks the built core, so it covers 26.6 lakh residents on the outskirts, 96% of them on moderate or good prospects.

## Homes versus workplaces (`homeswork` lens in js/urban-lenses-civic.js, `built_class` dataset, pipeline/cells/ee_layers.py)

The JRC's GHS-BUILT-C 2018 map (10 m, CC BY 4.0) is read per block through Earth Engine for all 13 cities: the non-residential share of built-up ground, the share with buildings over 15 m, road surface and vegetated open ground. The lens weighs the non-residential share by built-up ground (Bengaluru 4.3%, Delhi 3.5%, Mumbai 8.4%; the model reads mixed shop-houses as homes, so these are floors), picks workplace clusters (blocks at least half non-residential) and marks mostly residential pockets: populated blocks where, within 2 km, both the non-residential share and the Overture businesses per resident are under half the city's rate (the business check keeps market streets such as Karol Bagh out). About a quarter of residents live in such pockets in Bengaluru (34.6 lakh) and Delhi (72.9 lakh).

## Air quality monitor gaps (`airmonitorgap` lens in js/urban-lenses-civic.js, `air_monitors` dataset, pipeline/realestate/airmonitors.py)

State pollution control board station maps on data.opencity.in (public domain): TSPCB's continuous stations (November 2023) for Hyderabad, and for Bengaluru KSPCB's air quality monitor map (KGIS, continuous and manual), the 2023 continuous list and KSPCB's noise stations; a station on two lists within 300 m counts once. The lens counts stations within 2 km of each lived-in block and picks new sites where the most unmonitored residents breathe the worst satellite PM2.5. Bengaluru: 24 stations (11 continuous), 66 lakh residents (50%) more than 2 km from any; Hyderabad: 10 continuous stations inside the region, 76 lakh (84%) beyond 2 km.

## Still air (`stillair` lens, `wind` dataset, pipeline/cells/ee_layers.py `wind`)

Global Wind Atlas 3 mean annual wind at 10 m and 100 m (250 m grid, CC BY 4.0) per L7 block, and the 10 m speed as a
share of the 100 m speed (about 42% over dense building, 58% over open ground, 75% at the sea front). Most blocks in
Indian cities sit under 2 m/s (light air), so the lens ranks within the city: the stillest fifth of residents, and of
them those on the top quarter of road PM2.5 exhaust from the traffic model. Picks are those blocks 1.5 km apart ranked
by residents × exhaust × satellite PM2.5 ÷ wind. Annual means hide calm winter nights and inversions.

## Bad-air days (`badairdays` lens, `pm25_days` dataset, pipeline/cells/ee_layers.py `pm25_days`)

GHAP daily PM2.5 (1 km, gap-free, machine learning over satellite aerosol, weather and monitors) counted per L7 block:
days in 2022 above India's 24-hour standard (60 µg/m³) and the CPCB AQI 'poor' (90) and 'very poor' (120)
breakpoints, the 2022 mean, the 95th-percentile day, and days above 60 in 2017. The lens weights by residents, counts
residents with 100 or more days above the standard and picks blocks 1.5 km apart by residents × (poor days + a quarter
of the days above 60). The 2017-2022 change mixes policy with weather years, so it is reported, not ranked.

## Floods in the news (`floodnews` lens, `news_floods` dataset, pipeline/realestate/newsfloods.py)

Groundsource records (one per place and day, extracted from news by Gemini and geocoded) are filtered in Earth Engine
to footprints of 2 km² or less, so district- and city-wide reports drop out, and each kept record's centre is binned
to its L7 block as a distinct day. The lens sums reported days within 500 m of each resident's block, counts residents
near spots reported on 3 or more days and lists the repeat spots 1.5 km apart. It measures news coverage, which grows
sharply after 2020 and favours busy, newsworthy places; it complements the official flood maps of `floodagain`.

## How neighbourhoods were built (`howbuilt` lens, `urban_form` dataset, pipeline/cells/ee_layers.py `urban_form`)

WRI's Global Intra-Urban Land Use (2020, 5 m, CC BY 4.0) is mosaicked per city; a pixel is road where the road
probability band exceeds 50 (as in WRI's own script), otherwise its `lulc` class. Each L7 block gets the shares of
open space, non-residential, road and residential ground, and the residential ground split into atomistic
(unplanned), informal subdivision, formal subdivision and housing project. The lens weights by residents, counts those
in blocks that are over half unplanned or informal, and compares road and open-space shares with planned blocks.
First run: Delhi 35% of residents in mostly unplanned or informal blocks, with roads on 5% of the ground against 11.8%.

## Hot nights (`hotnights` lens, `night_heat` dataset, pipeline/cells/ee_layers.py `night_heat`)

ECOSTRESS L2T LSTE V2 scenes (70 m, public domain) from April to June 2023-2025 with UTC hours 16 to 23 (21:30 to
05:30 IST) are masked to cloud-free, non-water pixels; each L7 block takes the median LST in °C, its difference from
the median block of the whole city region and the number of scenes behind it (Delhi typically 9 to 22). The lens
re-centres on the night the median resident sleeps through (population-weighted median), counts residents 1 °C or
more above it with the elderly and under-5s among them, compares tree canopy, and picks blocks 1.5 km apart ranked by
(residents + 3 × residents aged 60+) × heat above the median. First run: Delhi's median home 25.5 °C at night, 2 °C
above the region; 15.8% of residents 1 °C hotter still, with 4.1% tree canopy against 8%.
Afternoon peak (`pm_heat`, roadmap 231): the same ECOSTRESS product on cloud-free April-June afternoons, 11:30 to 16:30
IST, pooled over 2018-2025 because the space station passes over a city on few afternoons a season (2023-25 alone left
Chennai with 3 scenes). The lens reports overnight cooling (afternoon minus night, residents weighted) when afternoon data
covers at least half the lived-in blocks; Delhi's homes cool 18.2 °C, its hottest-night blocks 16.8 °C.

## Big roads to come (`newroads` lens, `new_roads` dataset, pipeline/realestate/newroads.py)

Each corridor's "Coordinates" KML on data.opencity.in (Greater Bengaluru Authority elevated corridors, categories A to
C) is read as centrelines; when a map draws right-of-way edges beside the centreline (Pune Outer Ring Road, about 106 m
off), lines whose samples sit over 80% within 150 m of a longer kept line are dropped, and two-point chainage ticks are
dropped when longer lines exist. Alignments are densified every 20 m into a KD-tree; every block within 3 km gets the
distance from its centre and the nearest corridor's number, and alignment length is binned per block. The lens counts
residents in crossed blocks, within 500 m and within 2 km, today's modelled road noise on the line, census trees and
schools in crossed blocks, the land value index near the line, and residents within 500 m per corridor. First run:
56.6 km, 3.2 lakh residents in crossed blocks, 12.9 lakh within 500 m, land value index 119 near the line against 99.

Since roadmap item 236 the Bengaluru bake also reads BDA's Peripheral Ring Road (Bengaluru Business Corridor) October 2022
alignment map, which is a right-of-way polygon rather than a centreline: `alignment()` falls back to polygon outlines, distance is
taken to the outline and the length inside a block counts half (two sides of one road), giving 73.0 km.

## Rain gauge gaps (`raingaugegap` lens, `rain_gauges` dataset, pipeline/realestate/raingauges.py)

KSNDMC's Karnataka telemetric rain gauge and weather station layers and the Bengaluru Urban rain gauge layer (KGIS,
via data.opencity.in) are clipped to the Bengaluru map and merged (a gauge on both rain gauge layers within 100 m
counts once). The lens counts gauges and stations within 2 km of every block, residents beyond that, blocks near a
reported flood spot (flood_reports, within 300 m) beyond it, and residents beyond it in waterlogging-prone blocks
(index 60+). New gauge picks are blocks 1.5 km apart ranked by unmeasured flood-spot blocks and residents within 2 km.
First run: 133 gauges, 5.5 lakh residents (4.1%) beyond 2 km, 60 of 1,575 flood-spot blocks unmeasured.

## TB care reach (`tbcare` lens, `tb_care` dataset, pipeline/realestate/tbcare.py)

The Karnataka TB facility maps (KGIS, via data.opencity.in) are clipped to the Bengaluru map and binned per block. The
lens counts TB units plus drug-resistant and district TB centres within 3 km of each block and CBNAAT sites within 5 km,
and weights slum residents as residents × slums_mapped.slum_pct. New TB unit picks are 6 km apart, ranked by residents
plus four times slum residents beyond reach within 3 km. Primary health centres that collect sputum are not on these
maps. First run: 22 units, 38.5% of residents beyond 3 km, picks in Sunkadakatte, Rajiv Gandhi Nagar and Manjunatha
Nagar.


## Citizen service centres (`servicecentres` lens, `service_centres` dataset, pipeline/realestate/servicecentres.py)

Karnataka e-governance maps on data.opencity.in (package `grama-one-centres-in-karnataka-and-bengaluru`, public domain): Common
Service Centre and Grama One locations in Bengaluru Urban district. The pipeline reads only `<coordinates>` from the KMLs; the
maps also hold operator names and phone numbers, which are never parsed or stored. Points inside the Bengaluru box are deduped
at about 1 m and summed per L7 block (`csc`, `grama_one`).

The lens counts centres within 1 km of each block and reports residents, residents aged 60+ and slum residents beyond that.
New centre picks are blocks 2 km apart beyond 1 km of a centre, ranked by residents + 2 × elderly + 2 × slum residents within
1 km. Bangalore One, ward offices, banks and post offices also deliver some of these services and are not on the maps.
Bengaluru: 1,508 centres, one per 8,788 residents; 3.1% of residents and 6.4% of the elderly are more than 1 km from one.

Chennai (roadmap item 237): `tbcare.py --region chennai` reads Greater Chennai Corporation's TB centre map into `tb_units`, and
`servicecentres.py --region chennai` reads the Chennai Aadhaar enrolment centre map into a new `aadhaar` field. Both maps cover
the corporation only, so blocks further out read as far from a centre.

## Recycling reach (`recycling` lens, `waste_recovery` dataset, pipeline/realestate/recycling.py)

Maps on data.opencity.in (public domain), coordinates only: BBMP's Reduce-Reuse-Recycle centres and KSPCB e-waste collection
centres for Bengaluru; Greater Chennai Corporation's 2022 resource recovery centres, compost yards, vermicompost, biogas and
biomethanisation plants for Chennai. Per L7 block: `recovery_centres` (drop-off points) and `processing_sites` (wet-waste
processing). The lens counts drop-off centres within 1 km, residents within about 250 m of a processing site, and picks new
drop-off centres 2 km apart beyond 1 km of one, ranked by residents beyond reach. Bengaluru: 51 centres, 71% of residents more
than 1 km away; Chennai: 53 centres, 79%, and 10 lakh residents beside a processing site.

## Public land bank (`publicland` lens, `public_land` dataset, pipeline/realestate/publicland.py)

The Greater Bengaluru Authority's 2026 property register on data.opencity.in (public domain) lists 6,817 properties with a
recorded area, a free-text description (mostly Kannada) and a location quality. Only the 2,792 `unique` rows are used:
`approximate` rows sit on about 200 shared ward or locality points. Per L7 block: `gba_plots`, `gba_land_m2`, `vacant_plots` and
`vacant_m2` (ಖಾಲಿ ಜಾಗ, vacant land, including undeveloped park plots) and `amenity_plots` (school, clinic, anganwadi, library,
community hall, toilet or market by keyword). The lens reports land placed, vacant land, residents within 500 m of a vacant
plot, and vacant plots 2 km apart where residents within 1 km lack a public clinic within 1 km or an anganwadi within 500 m,
weighted up for larger plots. Recorded areas can be dated and a vacant plot may be encroached or earmarked.

## Day and night (`daytime` lens, `ambient_pop` EE layer)

LandScan Global (Oak Ridge National Laboratory, CC BY 4.0) via `projects/sat-io/open-datasets/ORNL/LANDSCAN_GLOBAL/landscan-global-YYYY`,
converted to people per km² with pixelArea and sampled per L7 block: `ambient_pop`, `ambient_km2` (2024) and
`ambient_change_pct` (2019 to 2024). The lens averages GHSL residents over the blocks within 500 m (LandScan is a ~1 km grid),
rescales ambient people to the resident total (LandScan's city totals are 65 to 90% of GHSL's) and maps
(daytime − residents) ÷ (daytime + residents + 50). Magnets hold at least twice their residents by day and 500 more people;
bedroom blocks the reverse. The size of a single gap mixes movement with model differences; the pattern is what to read.

## Sinking ground (`sinking` lens, `subsidence` EE layer)

`projects/sat-io/open-datasets/global_subsidence/Final_subsidence_proba_greater_1cm_2013_2019_recoded` (Hasan et al. 2023,
CC BY 4.0, ~2.2 km): probability that land subsided more than 1 cm a year in 2013-2019, from a random forest trained on InSAR
and GPS records with groundwater, climate, soil, sediment and land cover predictors. Stored per L7 block as `subsid_prob_pct`.
The lens reports the resident-weighted mean chance, residents at 60% and 75% or more, blocks with tall buildings on high-chance
ground and hotspots 2 km apart. A 2 km model of conditions, not a measured rate.

## Hillside homes (`hillside` lens, `landslides` dataset, pipeline/realestate/landslides.py)

`landslides.py` reads NASA's Global Landslide Catalog (`projects/sat-io/open-datasets/events/global_landslide_1970-2019`) per
city bounding box with an Earth Engine getInfo and bins events and reported deaths per L7 block (cities with no event are
skipped). The lens uses `terrain.slope_deg` (Copernicus 30 m DEM block mean): residents at 10° and 15° or steeper, slum residents
on 10°+ ground, residents within 500 m of a recorded slide, and hillsides to check 2 km apart ranked by
(residents + 4 × slum residents) × slope within 500 m.

## Cold nights (`coldnights` lens, `winter_nights` dataset, pipeline/cells/ee_layers.py)

`winter_nights` is the median ECOSTRESS L2T LSTE V2 land surface temperature over cloud-free, non-water pixels on December to
February nights (21:30 to 05:30 IST) from winter 2019-20 to 2025-26 at 70 m, with each block's difference from the city's
median block and the scene count, for Delhi, Lucknow, Jaipur, Bhopal, Indore, Guna, Ahmedabad and Kolkata. The lens measures
each block against the night the median resident sleeps through: residents, the elderly and under-5s in cold pockets 1 °C or
more below it, the share of them in mostly unplanned or informal blocks (WRI intra-urban land use) and in mapped slums, and
cold pockets 2 km apart ranked by (residents + 3 × elderly + 3 × under 5) × degrees below the median, doubled in unplanned
blocks. Surface, not air, temperature; the homeless are not counted by any map.

## Heated up (`heatedup` lens, `heat_change` dataset, pipeline/cells/ee_layers.py)

`heat_change` takes cloud-free Landsat Collection 2 Level-2 surface temperature scenes for April and May in 2000-2006
(Landsat 5 and 7, ST_B6) and 2021-2025 (Landsat 8 and 9, ST_B10), masks pixels that are water at least half the time (JRC
Global Surface Water), turns each scene into each pixel's gap to that scene's land median over the city region (300 m
reduceRegion), and stores per L7 block the period medians (`lst_2000s_c`, `lst_2020s_c`) and the change in the median gap
(`heat_rel_change_c`). The lens reports residents in blocks 2 °C or more hotter or cooler against the city, the mean change
for blocks with 20%+ new built surface 2000-2020 (GHSL) against blocks under 5%, today's tree canopy in warmed blocks, and
warmed blocks 2 km apart ranked by residents × warming. A relative, surface measure: in hot, dry cities new building on bare
fallow reads as cooling.

## Green then and now (`greenchange` lens, `green_change` dataset, pipeline/cells/ee_layers.py)

`green_change` repeats the `heat_change` recipe on Landsat Collection 2 surface reflectance NDVI (Landsat 5/7 SR_B4/SR_B3,
Landsat 8/9 SR_B5/SR_B4, scale 0.0000275 and offset −0.2) for April-May 2000-2006 and 2021-2025: JRC permanent water masked,
each scene turned into each pixel's gap to that scene's land median, period medians (`ndvi_2000s`, `ndvi_2020s`) and the change
in the median gap (`green_rel_change`) per L7 block. The lens counts residents in blocks that browned or greened by 0.1 or
more against the city, the mean `heat_change.heat_rel_change_c` for browned, greened and other blocks, and browned blocks
2 km apart ranked by residents × loss.

## Night shelters (`nightshelters` lens, `night_shelters` dataset, pipeline/realestate/nightshelters.py)

`nightshelters.py` reads Greater Chennai Corporation's night shelter KML (OpenCity `chennai-shelters`), keeping only each
placemark's coordinates and TYPE_SHELT, which it sorts into men, women, children and special shelters (psycho-social needs,
disability, elderly, transgender); names and phone numbers are never parsed. The lens judges only blocks inside the
corporation's wards (`wards.ward_no`): shelters against the NULM Shelter for Urban Homeless norm of one per lakh residents,
residents within 2 km of a shelter, railway and metro station blocks without one, and shelters to add 4 km apart ranked
by LandScan daytime people within 1 km, tripled at stations.

## Hot days, measured (`hotdays` lens, `air_heat` dataset, pipeline/cells/ee_layers.py)

`air_heat` reads `projects/sat-io/open-datasets/global-daily-air-temp/europe_asia` (Zhang, Zhou et al. 2022, 1 km daily
Tmax and Tmin, values × 0.1 °C). Older images carry no `year` property, so years are selected by date. For each year it
counts days with Tmax ≥ 40 °C and ≥ 45 °C and nights with Tmin ≥ 28 °C, and averages them over 2005-2014 (`*_then`) and
2015-2024 (`*_now`); it also keeps the April-June mean Tmax (`tmax_amj_c`, filtered by `doy` 91-181 before scaling) and its
gap to the city median (`tmax_amj_anomaly_c`), per L6 block. The lens weights blocks by GHSL residents for the city
figures, reports the 5th to 95th percentile spread across homes, residents with 7 or more extra days than the median
resident, and the ERA5-Land `climate_future.hot_days_now` count for comparison, and picks hottest homes 2 km apart by
(residents + 3 × elderly) × days above the median resident's. Counts near a threshold move with the model's 1-2 °C error.

## Old tank beds (`tankbeds` lens, `tank_beds` dataset, pipeline/realestate/tankbeds.py)

`tankbeds.py` reads HYDRAA's Outer Ring Road tank KML (OpenCity `hyderabad-and-telangana-water-bodies`), keeping each
part's outline, its 2023 class (water or built up), the tank ID and the tank's 2014 and 2023 status; survey numbers are
not read. Water and built-up parts are filled on a 10 m raster and shared out to L7 blocks (`tankbed_pct`,
`tankbed_built_pct`, `tankbed_water_pct`). Each tank is counted once at the centre of its largest part (`tanks`), with
`tanks_live`, `tanks_lost` (wholly encroached in 2023) and `tanks_worse` (status rank Live < Partly < Wholly rose between
2014 and 2023). The lens estimates residents on built-up beds as block residents × built-up share, compares the mean
Sentinel-1 waterlogging index of blocks with 10%+ built-up bed against blocks with no bed, and picks blocks 2 km apart by
residents on the bed × (1 + waterlogging / 100).

## Workplaces counted (`jobcount` lens, `econ_census` dataset, pipeline/realestate/econcensus.py)

`econcensus.py` reads the Kolkata 6th Economic Census microdata CSV (OpenCity `kolkata-economic-census`), keeping only the
ward (WC), town code (Kolkata Municipal Corporation, 7110), broad activity (BACT), household flag (IN_HH), ownership type,
proprietor's sex and workers by sex and hiring; social group and religion are never read. Rows outside wards 1-144 are
dropped. Ward totals (workers, establishments) and shares (manufacturing BACT 6, trade BACT 10-12, home-based, women
workers, women-owned proprietary establishments, hired workers) are written to every L7 block the `wards` dataset puts in
that ward. The lens regroups blocks by ward: area from mapped blocks, residents from GHSL, the densest tenth's share of
workers, workers per 100 residents, the workshop wards by manufacturing share, and a Spearman rank correlation between
census workers per km² and Overture places per km² across wards.

## Property tax by ward (`ptax` lens, `property_tax` dataset, pipeline/realestate/propertytax.py)

`propertytax.py` reads GCC's ward-wise property tax CSV (OpenCity `chennai-property-tax-collections`; ward numbers like
N012) and writes to every L7 block of that ward (via the 2011 GCC ward map in `wards`) the 2017-18 residential and
commercial demand (₹ lakh), collected over billed across 2013-14 to 2017-18 (residential and commercial), and the change
in residential demand from 2013-14 to 2017-18. The lens regroups blocks by ward (3 or more blocks and 2,000 or more GHSL
residents), reports the bill per resident and its spread, the lowest-collection wards, and Spearman rank correlations
across wards between the bill (per resident and per km² of mapped ward) and the residents-weighted land value index. Wards
billed low for their land value are those with the largest gap between their percentile on the bill and on land value.

## Street connectivity (`streetgrid` lens, `street_grid` dataset, pipeline/realestate/streetgrid.py)

`streetgrid.py` reads Overture transportation segments and connectors for each city's bounding box with DuckDB (public
S3; the container's injected AWS keys must be unset for anonymous reads). Only public street classes count (trunk,
primary, secondary, tertiary, residential, unclassified, living_street, pedestrian). Each connector's degree is the
number of street ends meeting there, a segment passing through it (0 < at < 1) counting twice; degree 3 or more is an
intersection, degree 1 a dead end, summed per L7 block. The lens averages both over blocks within 500 m of each home,
reports resident-weighted quantiles of intersections per km², residents under 50 per km² and those also facing 40% or more
dead ends, and picks blocks 2 km apart by residents × (1 − density / 50) × dead-end share.

## Trade licences (`licences` lens, `trade_licences` dataset, pipeline/realestate/tradelicences.py)

`tradelicences.py` reads the 27 constituency CSVs of OpenCity's `bbmp-trade-licenses-data-2025`, keeping only application
type, date, bye-law part (Major Trade), zonal classification and pincode (Bengaluru pincodes start 56). Per pincode it
counts 2025-26 licences (April 2025 to March 2026) with food (Parts 1 and 6), lodging (Part 2), medical (Part 3) and
industrial-zone shares, and new licences a year for 2015-2019 and 2022-2025, and writes them to every L7 block of that
pincode (via `pincodes`). The lens regroups blocks by pincode (5 or more blocks, 5,000 or more residents), reports licences
per 1,000 residents, the change in new licences, the fastest-growing and slowing pincodes (20 or more new licences a year
before), and current licences per 100 Overture places.

## Homes in 2011 by ward (`homes2011` lens in js/urban-lenses-wards.js, `census_homes` dataset, pipeline/realestate/census2011.py)

The commons lens module reached the 150 kB per-module budget, so ward-record lenses start a new module,
`js/urban-lenses-wards.js` (loaded after commons in app.html, sw.js, tests/setup.js and scripts/build_lens_league.js).
`census2011.py` reads OpenCity's `mumbai-ward-wise-census-data`: the census-ward list (census ward code to BMC ward
letter), the Primary Census Abstract for Mumbai City and Mumbai Suburban (households, people, literacy, working women)
and the HH-14 houselisting workbooks (percentages of households by amenities and assets). Census wards are summed into
the 24 BMC wards, HH-14 shares weighted by households, and every BMC block carries its ward's figures plus
`c11_ward_no` (A = 1 ... T = 24), because lens frames read numbers only. Caste and tribe columns are not read.

## Low ground by the sea (`lowground` lens in js/urban-lenses-wards.js, `low_ground` EE layer)

`ee_layers.low_ground` samples Deltares DeltaDTM v1.1 (`projects/sat-io/open-datasets/DELTARES/deltadtm_v1-1`, a single
image, not a collection) at 30 m with JRC permanent water masked, per L7 block: mean ground height and the shares at
2, 3 and 5 m or less above mean sea level (EGM2008). The model stops at 30 m, so only coastal and delta cities are baked
(Mumbai, Chennai, Kolkata). The lens counts GHSL residents on those shares, compares the low blocks with Aqueduct's
present-day coastal flood map and the rain waterlogging index, and picks lived-in low blocks 1.5 km apart.

## Feels-like heat outdoors (`feelslike` lens in js/urban-lenses-wards.js, `feels_like` EE layer)

`ee_layers.feels_like` reads GloUTCI-M (`projects/sat-io/open-datasets/gloutci-m`, 272 monthly images, values in
0.01 °C) at 1 km (L6): months a year whose mean daily peak UTCI is 38 °C or more (very strong heat stress) and 32 °C or
more (strong), averaged over 2013-2022 and 2000-2009, and the April-June mean and its change. Sea and edge pixels read
near 0 and are dropped (April-June mean under 20 °C). The lens weights by GHSL residents, sets the April-June UTCI peak
against the air-temperature peak from `air_heat`, and picks the hottest lived-in blocks 1.5 km apart.

## Bengaluru residents reshared by census ward (`pipeline/realestate/wardpop.py`)

GHSL GHS-POP R2023A puts far too few people in south and east Bengaluru (the South and East corporations hold 12-18%
of their Census 2011 count, West and North about twice theirs), and Meta's HRSL, built on the same census units, does
the same; GHSL's built volume shows no such gap. `ee_layers.population` therefore calls `wardpop.calibrate_region`
for Bengaluru: GHSL's total inside the GBA is kept but shared across the 369 wards by each ward's Census 2011
population (TOT_P on the GBA ward map of December 2025) times its residential built volume growth 2010→2020 (GHS-BUILT-V
total minus non-residential, capped at 3×), and within a ward by 2020 residential built volume. `projected_2030` keeps
GHSL's 2030/2020 ratio; `change_2000_2020_pct` is dropped for those blocks. Only Corporation, ward_id and TOT_P are read.
Mumbai's census wards sit at 0.7-1.9 times their 2011 count in GHSL, so it is left alone.

## Civic works ordered (`civicworks` lens in js/urban-lenses-wards.js, `work_orders` dataset)

`pipeline/realestate/workorders.py` reads OpenCity's categorised BBMP work orders 2018-2023 (constituency-wise gross
CSV) and gives every block inside both an assembly constituency and the corporation its constituency's totals in ₹ crore
(all, roads, drains, water and sanitation, street lighting, waste, buildings). Work tagged to several wards or none is
left out. The lens divides each constituency's total by its corporation residents and five years, ranks constituencies,
and compares drain orders per resident with the residents-weighted rain waterlogging index (Spearman).

## Services in the fringe villages (`fringevillages` lens in js/urban-lenses-wards.js, `village_services` dataset)

`pipeline/realestate/antyodaya.py` reads Mission Antyodaya's 2020 village survey for Bengaluru Urban and Pune districts
(OpenCity `bengaluru-urban-antyodaya-data`). The rows carry 2011 village codes the Survey of India maps lack, so they are
matched by spelling-normalised name within the same tehsil (close spellings only when the first two letters agree; the
map's "Bengaluru Urban" tehsil accepts the survey's North, East and Yelahanka), several rows of a village are summed,
and villages whose surveyed households hold under a fifth of today's GHSL residents are dropped (Pimple Saudagar,
Pashan: token rural remnants). Codes follow the survey's codebook (drainage 1 closed to 5 none; power-hour and distance
bands become midpoints). Ahmedabad's box has only five villages left rural, so it is not baked. The lens weights by
households and sets piped-water shares against the floor area added 2016-2023 (`re_supply.new_floor_m2`).
