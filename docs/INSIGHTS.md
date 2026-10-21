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
