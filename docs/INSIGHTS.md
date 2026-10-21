# Urban intelligence (insights, dashboard, compare, what-if)

`js/urban-insights.js` turns the per-cell data store (docs/CELL_STORE.md) into
explainable answers. It runs entirely in the browser, needs no new data, and
picks up any dataset added to `data/cells/catalog.json` (or dropped on the map)
without code changes. `js/insights-panel.js` is the **Intel** dialog (toolbar,
or press `i`), and `js/disha-intel.js` grounds DISHA in the same engine.

| Output | What it does | Method |
|---|---|---|
| `areaInsights(area)` | Ranked strengths, concerns and notable mixes for a DIGIPIN area, map view or city, plus hotspots | Area mean vs the city's cell distribution: effect size d = (area − city mean) ÷ city SD, and the percentile. Categories and flags compare shares. Hotspots are parent cells where ≥ 25% of children sit in the city's best or worst 10% |
| trends and anomalies | Year-on-year change for every temporal dataset (`time` block) | Mean of the last 12 steps minus the 12 before, so seasons cancel. An anomaly is a cell whose latest step-vs-a-year-earlier change is ≥ 2 SD from the city's |
| `cityDashboard()` | Headline indicators, rank among cities, urban index, best/worst/flood zones, monthly environment series | Means over **built-up** cells (population, connectivity or infrastructure > 0), because each city's grid bbox includes farmland. Urban index = mean of the headline scores with flood risk inverted |
| `compare(a, b)` | City vs city or area vs area on every shared numeric field | A side wins an indicator when it is better by ≥ 5% of the field's range |
| `whatIf({type:'park'})` | New park at a cell | Green +boost in the cell and +35% of that in its 8 neighbours; livability recomputed with the pipeline's own weights (green = 2 of 13, `pipeline/scores/composite.py`) |
| `whatIf({type:'density'})` | 1.2–4× residents at a cell | Service score ÷ population index vs the city's 25th percentile; floors needed from the baked Open Buildings heights; road LOS E/F share |
| `whatIf({type:'flood'})` | Moderate / severe / extreme event over the view | Floods the city's riskiest 10 / 25 / 50% of built-up cells (rank-based; ties to the more populated cell), then counts sealable pockets, chokepoints, critical links and built blocks inside |
| `evidence(lat, lng)` | DISHA context block with `[C1]`, `[C2]` tags per dataset | Every dataset value at the cell with its city percentile, plus the neighbourhood's top findings. Replies render the tags as source-card chips |

Every finding, what-if and comparison lists the datasets it read, and the
dialog shows each one's source card (js/provenance.js). What-if results are
registered as the runtime `whatif` dataset, so they extrude as a 3D cell layer
and can colour the 3D buildings (`BuildingData`, `whatif:<field>`).

DISHA answers "what's notable here", "what if we add a park / double the
density / a severe flood hits", "compare Pune with Indore" and "which city is
best" from the engine directly (offline too), and with a model connected it
narrates the computed result citing `[C#]` tags. The agent gets three tools:
`areaInsights`, `whatIf` and `compareCities`.

Limits: scores are OSM-derived and sparse outside city cores, flood risk is a
terrain score rather than a hydraulic model, and population is an index, not a
head count. The panel says so next to each method.

## Share links and briefs

The Intel dialog's **Share** button (and the app-wide share link / saved views) carry the open Intel view:
`&intel=<city|here|compare|whatif>&ic=<city>&ia=<area>&ib=<area>&wi=<scenario>`. Area tokens are
`city:<region>`, `p:<DIGIPIN prefix>` or `b:west,south,east,north`; scenarios are `park:<code>:<boost>`,
`density:<code>:<factor>` or `flood:<level>`. A what-if link re-runs its scenario when it opens.

**Brief** (header, or "Printable brief" under Here / What-if results) builds a self-contained HTML page
(`js/intel-brief.js`, schema `digipin.brief/1`, no scripts or network): the city's index, key indicators with
rank and best city, monthly environment sparklines, zones, what stands out, the city ranking, the area or
scenario in view, and a source card for every dataset used. Print it to save a PDF.

## Drawn areas and what changed

- **Draw**: the Here tab's ✏ Draw button outlines any shape (click points; click the first point or double-click to
  finish; Esc cancels). The engine accepts `{ polygon: [[lng, lat], …] }` and keeps the cells whose centre is
  inside (falling back to the shape's box when it is smaller than the data's cells). The drag-a-box Area summary
  has a "What stands out here" button too. Share links carry a shape as `ia=g:lng,lat;…`.
- **What changed** (`UrbanInsights.changes`): for each temporal field in a city, the city mean at its latest step
  vs the same step one window earlier (a year for monthly data), how big that move is against the series' own
  typical same-step change, and the cells whose change was 2+ SD from the city's. Shown on the City tab, in briefs,
  and to DISHA ("what changed in Pune?"). The Intel button shows a dot when the store has a newer month than the
  one you last saw.

## Trees for heat and road closure

- **Trees for heat** (`cool`): fits daytime land surface temperature on tree cover and built-up share over the
  city's ~244 m cells (`ols2`, least squares), then applies the tree-cover slope to the added points in each cell
  of the ~1 km site (capped so tree + water ≤ 100%). Reports surface temperature and UHI anomaly before/after,
  cells leaving the city's hottest 10%, residents (GHSL), and the fitted slope with R². If the city's data shows
  no cooling from trees, it predicts no change and says so.
- **Road closure** (`closure`): closes every road in the selected cell (~250 m at level 7, or the 16 children of a
  ~1 km cell); the closed road length spreads over the roads in the two rings of cells around it in proportion to
  their length (congestion × (1 + share), capped at 100). Reports congested cells before/after, critical links
  and chokepoints closed, transit stops inside, and people in sealable pockets nearby.

## Plans (stacked scenarios)

"➕ Add to plan" under any what-if result keeps the scenario (up to 8, saved in this browser). The plan bar on the
What-if tab runs them together (`UrbanInsights.runPlan`): each scenario keeps its own model, and the plan reports
the ~1 km cells hit by more than one, flagging a ⚖ trade-off where a benefit (park, trees) and a burden (flood,
road closure) land on the same place. Plans travel in share links as `wp=<scenario>|<scenario>|…` and print in briefs.

## Lenses (combined-dataset indicators)

`js/urban-lenses.js` + `js/lenses-panel.js` (Intel → **Lenses**). Each lens combines several datasets with an
established method and answers in people; the ranked plan and the methods with references are in
[ROADMAP_INSIGHTS.md](ROADMAP_INSIGHTS.md).

| Lens | Combines | Method |
|---|---|---|
| Heat vulnerability | LST day + night, density, built-up, canopy, NDVI, travel time to care | exposure × sensitivity × (1 − adaptive capacity), city percentile ranks |
| Flood exposure | GloFAS 100/10-yr share and depth, HAND, population, built-up | hazard × exposure; people and built km² in the floodplain |
| 15-minute completeness | 7 OSM amenity categories, population | essentials within 1.2 km; Shannon mix within 500 m |
| Healthcare access | OSM healthcare, population | E2SFCA, Gaussian decay, 2 km catchment |
| Air exposure | PM2.5, NO₂, population | population-weighted mean; residents above NAAQS / WHO |
| Night lights vs people | VIIRS radiance, population | residual of ln(radiance) on ln(population) |
| Walkability index | OSM junctions, density, land-use mix, OSM walkability score | Frank et al.: 2·z(intersections) + z(density) + z(mix); residents below the LEED-ND 54 junctions/km² bar |
| Sprawl and compactness | GHSL-style built-up 2016 / 2023, night lights, density | Landscape expansion index (infill / edge / leapfrog), Clark density gradient from the night-lights peak, population-weighted density |
| Neighbourhood archetypes | density, built-up, height, mix, canopy, lights, junctions, growth | k-means++ on the urban fabric (≥ 1 500 people/km², DEGURBA), k = 4–7 by silhouette, clusters named from centroids; a category layer |
| 3-30-300 green rule | canopy, land cover trees/grass, OSM leisure | 30% canopy within 500 m; green space within 300 m (the "3 trees" part needs street imagery) |
| Rooftop solar | Open Buildings cover (else OSM), NASA POWER irradiance per city | 30% of roof usable, 10 m²/kWp (MNRE), PR 0.75; vs 1,395 kWh per resident (CEA 2023-24) |
| Siting suitability | heat, flood, healthcare access, walkability, OSM schools/leisure, roads, lights | weighted-overlay MCDA, AHP weights (CR < 0.1), top cells ≥ 1.5 km apart; presets clinic, school, park, cool roofs, EV charging |
| Data confidence | OSM vs Open Buildings building counts, input coverage | half OSM completeness, half share of inputs present; flags where amenity lenses are lower bounds |
| Seasonal exposure | monthly MODIS LST day/night, CAMS PM2.5 | per-cell months ≥ 40 °C surface and > 60 µg/m³ in the last 12; population-weighted monthly series; last-12 vs previous-12 warming |
| Compound risk | the heat, flood and air lenses | hazards in the city's worst fifth, per resident |

Every lens gets a population-weighted Gini, Lorenz curve and Palma ratio (access lenses), global Moran's I
and Getis-Ord Gi* hot/cold spots (500 m distance band), and on demand Local Moran's I clusters and outliers
(99 seeded permutations). The engine builds a **city frame** first: every needed field on the population
L7 grid, coarser datasets broadcast from their parent cell. "Map" registers the runtime dataset `lenses`
(3D cells, building colouring, exports). DISHA routes "heat vulnerable", "floodplain", "15-minute",
"healthcare desert", "PM2.5", "night lights", "compound risk" and "how unequal" questions to it.
Other modules call one lens through `UrbanLenses.lens(id, city, store, opts)` (contract in
ROADMAP_INSIGHTS.md). A big city (Delhi, 37k cells) takes about 3 s in the browser, yielding between lenses.

## Scenarios through the lenses, 3D framing, zone leaderboard

- `js/scenario-lenses.js` (`ScenarioLenses.impact(results)`) applies a what-if's change to the lenses' ~244 m frame
  (js/urban-lenses.js) and re-runs the lenses it can move: trees → heat vulnerability (canopy up, LST down); park →
  heat and 15-minute (canopy, one leisure place); density → healthcare access (E2SFCA), heat and 15-minute
  (residents × factor). Flood and road closure change no lens input, so they report who lives in the affected
  cells (heat-vulnerable, already in the floodplain, no care within 2 km). Equity lenses show the
  population-weighted Gini before → after. A plan applies every change to one frame. Shown under each what-if
  and plan ("Through the lenses") and printed in briefs.
- Every what-if and plan lands as an extruded runtime layer with its legend (plans: `plan_pressure`, + burden /
  − benefit, diverging), and `InsightsPanel.frame3D` tilts the camera (pitch 55°) to frame it beside the window.
- Zone leaderboard on the City tab: `UrbanInsights.zoneRanking` ranks a city's ~4 km zones on any numeric field
  (direction-aware, built-up cells for scores, 12-month mean for series); "Show all zones in 3D" extrudes them.

## 3D city tour and time-lapses

- `js/city-tour.js` (`CityTour.start(city)`, "▶ 3D tour of the city" on the City tab) flies a narrated 3D tour:
  overview of every ~4 km zone, best and weakest liveable zone, hottest zone, most flood-exposed zone, and the
  biggest recent change, then back out. Each stop extrudes its layer (runtime dataset `tour`, with legend),
  outlines the zone and frames it with neighbours. Caption card: ◀ ▶/❚❚ ▶|, dots, arrow keys, Esc.
- "● Record" hands the stops to the fly-through recorder (`CameraPresets.record({shots, orbit, fileName})`),
  so the tour saves as MP4/WebM with captions; there is no second camera system.
- "▶ Time-lapse in 3D" on a "What changed" card plays the last 24 months of that field as extruded cells
  through the TimeSlider (`CityTour.timelapse`); "● Record" saves it as video.
- DISHA: "give me a tour of Pune", "fly me through the city", "show me around" list the stops in chat and fly the
  tour; "city overview of …" lists them with a "▶ Fly the 3D tour" button. Offered as a cell suggestion.
