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
