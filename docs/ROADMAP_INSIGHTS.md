# Insights roadmap: what to add next, and why

*Written 2026-10-21 against `dev` (c0dc633). Scope: new **interpretations** of the
data already in the cell store, ranked by insight per unit of effort.*

## Where we are

The cell store already holds ~30 datasets per DIGIPIN cell for 13 cities
(docs/CELL_STORE.md): people (WorldPop counts, density, 2030 projection), built
form (GHSL built-up, Open Buildings counts and heights, OSM roads and
buildings), land cover and greenery (Dynamic World, Sentinel-2 NDVI, canopy),
climate and environment (Landsat/MODIS LST, CHIRPS rain, S5P/CAMS air), hazard
(JRC water, GloFAS 100-year flood depth, HAND, terrain), economy proxies (VIIRS
night lights), services (OSM amenities by category, travel time to healthcare),
transport (road LOS, transit stops, mobility chokepoints), growth (2016 → 2023 →
2035) and ten monthly or yearly series.

The Intel engine (docs/INSIGHTS.md) reads every one of these **one field at a
time**: an area is compared to its city with an effect size, trends are
year-on-year, and what-ifs perturb one score. That answers "what is unusual
here". It does not yet answer the questions urban analysts actually get asked,
because those are almost always **combinations**:

- *Who* is exposed, not *where* is hot: hazard × people × their ability to cope.
- *Access*, not supply: a clinic matters to the people within reach of it, and
  how many others compete for it.
- *Distribution*, not averages: a city mean of 60 can hide a quarter of
  residents at 10.
- *Pattern*, not values: is a high value a single cell (noise) or a
  statistically significant cluster?

So the roadmap below is a set of **lenses**: established urban-analytics
methods that combine datasets we already have into one interpretable number
per cell, a city summary in people, an equity reading, and a hotspot map.

## Ranking

Insight per effort = (how many decisions it informs × how defensible the method
is) ÷ (new data + code). Effort: **S** ≤ 1 day, **M** 2–4 days, **L** a week or
new data.

| # | Lens | Answers | Data ready? | Effort | Status |
|---|---|---|---|---|---|
| 1 | Heat vulnerability index | Who suffers most in a heatwave? | Yes | S | **Shipped** |
| 2 | Flood exposure | How many people and buildings sit in the 100-year floodplain? | Yes | S | **Shipped** |
| 3 | 15-minute completeness + land-use mix | Can people reach daily needs on foot? | Yes (OSM) | S | **Shipped** |
| 4 | Healthcare access (E2SFCA) | Where is care scarce relative to demand? | Yes | S | **Shipped** |
| 5 | Hotspots (Getis-Ord Gi\*, LISA, Moran's I) | Is this a real cluster or noise? | Any field | S | **Shipped** |
| 6 | Equity of access (Gini, Lorenz, bottom-20 %) | Is the city fair? Who is left behind? | Yes | S | **Shipped** |
| 7 | Air pollution exposure | How many people breathe above the standard? | Yes | S | **Shipped** |
| 8 | Night lights vs people | Where is activity above (or below) what residents explain? | Yes | S | **Shipped** |
| 9 | Compound risk ("triple burden") | Which neighbourhoods carry heat, flood and air at once? | Yes | S | **Shipped** |
| 10 | Sprawl and compactness | Is growth infill, edge or leapfrog? How steep is the density gradient? | Yes | M | **Shipped** |
| 11 | Walkability index (Frank et al.) | Is the street fabric walkable, independent of POIs? | Yes | S | **Shipped** |
| 12 | 3-30-300 green rule | Does each neighbourhood meet the tree / canopy / park rule? | Partly (no parks layer) | S–M | **Shipped** |
| 13 | Neighbourhood archetypes (k-means) | What kinds of places make up this city? | Yes | M | **Shipped** |
| 14 | Siting suitability (MCDA / AHP presets) | Where should the next clinic, school, park or cool roof go? | Yes | M | **Shipped** |
| 15 | Rooftop solar and cooling potential | How much energy could the roofs make? | Yes (heights, sun-hours) | M | **Shipped** |
| 16 | Network isochrones | True 15-minute reach on the road graph | No: `data/vectors/osm_roads_*` holds tertiary and above only; walking needs residential/footway edges baked by `pipeline/cells/osm_layers.py` in Actions | M–L | Data needed |
| 17 | Transit job access | How many jobs within 45 min by bus/metro? | No (GTFS + jobs) | L | Data needed |
| 18 | Socio-economic sensitivity | Who is poor, old, young (census)? | No (Census / SHRUG) | L | Data needed |
| 19 | Data confidence layer | How much should I trust this cell? | Yes (coverage) | S | **Shipped** |
| 20 | Area profile through every lens | How does my neighbourhood compare on each lens? | Yes | S | **Shipped** |
| 21 | Seasonal exposure | How many months a year are residents exposed? Is it warming? | Yes (monthly series) | S | **Shipped** |

Excluded here because other work owns them: draw-an-area building insights,
the "what changed this month" feed, and performance/reliability.

---

## 1. Heat vulnerability index (HVI)

**Question.** In a heatwave, where are people most likely to be harmed?

**Method.** The IPCC framing, vulnerability = exposure × sensitivity ×
(1 − adaptive capacity), as operationalised in heat-vulnerability indices
(Cutter et al. 2003 SoVI style; Reid et al. 2009; Wolf & McGregor 2013). Each
component is a within-city percentile rank (0–1) so units cancel:

- Exposure E = mean rank of Landsat day LST (`surface_heat.lst_day_c`) and
  MODIS **night** LST (`surface_heat.modis_night_c`). Night heat is what kills:
  bodies do not recover.
- Sensitivity S = mean rank of population density (`population.density_km2`)
  and built-up share (`built_up.built_pct`, impervious, heat-retaining).
- Adaptive capacity A = mean rank of tree canopy (`vegetation.tree_canopy_pct`),
  NDVI (`vegetation.ndvi`) and healthcare proximity (inverse
  `accessibility.healthcare_min`).
- HVI = E × S × (1 − A), reported as a 0–100 city percentile.

**User sees.** A 3D cell layer, the people living in the top decile, the
hottest night-time cells, the equity of exposure, and Gi\* hot clusters.

**Limits.** No age or income data (item 18 would add them to S); LST is
surface, not air, temperature.

## 2. Flood exposure

**Question.** How many people and how much built-up land sits in the 100-year
floodplain, and where is it concentrated?

**Method.** Risk = hazard × exposure (× vulnerability), the UNDRR/Sendai
framing. Hazard is the GloFAS 100-year flood share of the cell
(`water.flood_rp100_pct`) weighted by depth (≥ 1 m treated as full hazard,
`water.flood_rp100_depth_m`), plus a pluvial term for low-lying cells (HAND
< 5 m, Nobre et al. 2011) at half weight. People exposed = population ×
flood share; built exposed = built-up share × flood share. 10-year share gives
the frequent-flood count.

**User sees.** "N people (x %) live in the 100-year floodplain, M in the
10-year one", the risk layer in 3D, clusters, and the people-weighted share.

**Limits.** GloFAS is riverine and ~1 km; no drainage network; HAND is a
proxy for pluvial ponding.

## 3. 15-minute completeness and land-use mix

**Question.** Can residents reach daily needs within a 15-minute walk
(Moreno et al. 2021)?

**Method.** Cumulative opportunities within a 1.2 km Euclidean radius (15 min
at 4.8 km/h, ~5 L7 cells). Seven essentials from `osm_amenities`: food,
shopping, healthcare, education, transport, leisure, finance. Completeness =
share of the seven with at least one POI in reach. Land-use mix is the
normalised Shannon entropy H = −Σ pᵢ ln pᵢ / ln K of the same categories within
500 m (Frank et al. 2006 use the same entropy for land-use mix).

**User sees.** Completeness 0–100 per cell, people living in "complete"
neighbourhoods (≥ 6 of 7), the missing category most often absent, mix.

**Limits.** OSM completeness varies a lot between Indian cities; Euclidean
radius overstates reach across rivers and rail (item 16 fixes this).

## 4. Healthcare access (Enhanced 2SFCA)

**Question.** Where is healthcare scarce *relative to the people who need it*?

**Method.** Two-step floating catchment area (Luo & Wang 2003) with Gaussian
distance decay (E2SFCA / G2SFCA, Luo & Qi 2009, Dai 2010):

1. For each supply cell j: Rⱼ = Sⱼ / Σₖ G(dₖⱼ) Pₖ over population cells k within d₀.
2. For each demand cell i: Aᵢ = Σⱼ G(dᵢⱼ) Rⱼ.

G(d) = (e^{−½(d/d₀)²} − e^{−½}) / (1 − e^{−½}), d₀ = 2 km. Supply Sⱼ =
`osm_amenities.healthcare`, demand Pₖ = `population.population`. Reported as
facilities per 10 000 residents in reach.

**User sees.** The access layer, its Gini, the people below a tenth of the
city median, and the cold clusters (the "care deserts").

**Limits.** Facilities are counted, not sized (a clinic = a hospital).

## 5. Hotspots: Getis-Ord Gi\*, Local Moran's I, global Moran's I

**Question.** Is a high value part of a significant cluster, and does the
variable cluster at all?

**Method.** Distance-band binary weights (neighbours within ~1 km).
Global Moran's I (Moran 1950) for overall autocorrelation; Gi\* z-scores
(Getis & Ord 1992; Ord & Getis 1995) with |z| > 1.96 / 2.58 for 95 / 99 %
hot or cold spots; Local Moran's I (Anselin 1995) with a seeded conditional
permutation test (99 draws) to label High-High, Low-Low, High-Low and
Low-High outliers.

**User sees.** For any lens: hot/cold cluster cells outlined on the map,
Moran's I with a plain-language reading ("strongly clustered").

**Limits.** No FDR correction yet, so treat 95 % hotspots as exploratory.

## 6. Equity of access

**Question.** Is a service distributed fairly across residents?

**Method.** Population-weighted Gini coefficient and Lorenz curve of each lens
(the access-equity literature, e.g. Delbosc & Currie 2011 for transit), the
share of residents in the city-wide bottom 20 %, and the Palma-like ratio of
the top-10 % to bottom-40 % mean.

**User sees.** A Gini for every lens and a Lorenz sparkline.

## 7. Air pollution exposure

**Question.** How many people breathe air above the national standard and the
WHO guideline?

**Method.** Population-weighted mean PM2.5 (the GBD/WHO exposure metric) from
`air_quality.pm25_ugm3`; counts of people above India's NAAQS annual 40 µg/m³
and the WHO 2021 annual 5 µg/m³; NO₂ column as a traffic co-pollutant.

**Limits.** CAMS/S5P are ~1–10 km: this ranks districts, not streets.

## 8. Night lights vs people

**Question.** Where is economic activity higher, or lower, than its residents
explain?

**Method.** Night lights are an established proxy for economic activity
(Henderson, Storeygard & Weil 2012; Chen & Nordhaus 2011). Fit
ln(radiance + 0.1) = a + b ln(population + 1) over populated cells (OLS). The
standardised residual says: > +1 SD lit above its residents (commercial,
industrial, transit hubs), < −1 SD among dense cells under-lit for its
population (possible energy poverty or informal housing; a flag to check,
not a label). Radiance per capita is the second output.

## 9. Compound risk ("triple burden")

**Question.** Where do heat, flood and air pollution stack up on the same
residents?

**Method.** Count of hazards for which the cell is in the city's worst
quintile (HVI, flood risk, PM2.5), weighted by population.

## 10–19 (next)

- **Sprawl and compactness.** Landscape Expansion Index (Liu et al. 2010):
  new built-up (2016 → 2023, `growth`) classed as infill (> 50 % of the ring
  was built), edge (0–50 %) or outlying (0 %). Clark (1951) density gradient:
  slope of ln density on distance from the peak (the CBD, found as the
  night-lights maximum). Population-weighted density (Craig 1984). A
  compact-vs-sprawl verdict per city with the trend.
- **Walkability index.** Frank et al. (2010): 2·z(intersection density) +
  z(residential density) + z(land-use mix) from `osm_roads.junctions_km2`,
  `population.density_km2` and lens 3. Compare with the OSM walkability score.
- **3-30-300.** Konijnendijk (2021): 3 trees visible (not measurable here),
  30 % canopy per neighbourhood (`vegetation.tree_canopy_pct` over 500 m), 300 m
  to a green space (`osm_amenities.leisure` until a parks layer is baked).
- **Neighbourhood archetypes.** k-means (k = 6–8, chosen by silhouette) on
  standardised density, height, built share, mix, green, lights, growth;
  labels from cluster centroids ("dense old core", "new high-rise edge",
  "village in the city"). The urban analogue of Local Climate Zones
  (Stewart & Oke 2012).
- **Siting suitability.** Weighted-overlay MCDA with AHP weights (Saaty 1980;
  Malczewski 2006) for presets: clinic (high demand, low 2SFCA, not flood,
  road access), school, park (high HVI, low canopy), cool roofs (HVI ×
  building cover), EV chargers. Extends `analysis.js` "index" sections.
- **Rooftop solar.** Building footprints × sun-hours × panel yield;
  per-cell kWh and share of demand.
- **Network isochrones.** Replace the Euclidean radius of lenses 3–4 with
  walking time on the OSM road graph (detour index 1.3 as an interim factor).
- **Transit job access** and **socio-economic sensitivity** need GTFS feeds,
  an employment proxy, and Census 2011 / SHRUG joins via Bharatlas.
- **Data confidence.** Per-cell completeness: OSM building cover vs Open
  Buildings, source resolution, and age, shown as hatch on any lens.

## How it is built

`js/urban-lenses.js` (pure, unit-tested) builds a **city frame**: every
dataset aligned onto the population L7 grid (coarser datasets broadcast from
their parent cell, temporal ones read as the trailing-12 mean), then runs each
lens over that frame. Results register as the runtime dataset `lenses`, so
they extrude in 3D, colour buildings (`lenses:<field>`) and appear in exports
like any other layer. The Intel dialog's **Lenses** tab shows each lens's
headline in people, equity, clusters, method and sources.

## Calling a lens from code (agents, DISHA, other modules)

```js
const r = await UrbanLenses.lens('heat', 'delhi');                       // any id from UrbanLenses.catalog()
const s = await UrbanLenses.lens('siting', 'pune', null, { preset: 'clinic', sites: 8 });
// → { schema: 'digipin.lens/1', id, preset, title, question, city, cityLabel, ranAt, headline,
//     findings: [{label, value}], stats, equity, hotspots, sites?, weights?, consistency?,
//     method, refs, sources: [source cards], layer: { spec, table }, text }
CellStore.register(r.layer.spec, r.layer.table);                          // paint it
```

Siting presets (`UrbanLenses.PRESETS`): `clinic`, `school`, `park`, `cool_roofs`, `ev_charging`; each is a
criteria list with directions and an AHP pairwise matrix (all consistency ratios < 0.1, tested).
