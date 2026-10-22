# Traffic Analysis — Structural Congestion Intelligence

> **Why not live traffic?** DigiPin is a backend-less, keyless, static PWA. Every
> live-traffic API (TomTom, HERE, Google Routes, Mappls) needs an API key, a
> server-side proxy, and CORS support — none of which exist here (the README
> egress allowlist confirms none are reachable, and the old ORS key is dead).
> Real-time traffic is therefore **out of scope by design**. The video-CV
> approach of reference projects like *TraffiQ* (YOLOv8 + ByteTrack on traffic
> cameras) is GPU/server-bound and equally incompatible with a browser PWA.

Instead DigiPin computes **structural** congestion — where traffic load
concentrates *by network design* — which is free, offline, and well grounded in
transport geography. It answers "which roads are structural bottlenecks, which
links are single points of failure, and where is transit access good/poor",
**not** "what are the delays right now".

## Method

### 1. Betweenness centrality → traffic-volume proxy
The OSM road network is built into a graph (intersections = nodes, segments =
edges weighted by length) and we compute **edge betweenness centrality** — the
share of all shortest paths that traverse each segment. Network betweenness is a
long-established proxy for through-traffic *volume*: a segment that many trips
must cross carries more load. (Same approach as `guna-twin-city/pipeline/
road_centrality.py`, k-sampled on large graphs for speed.)

### 2. Level of Service (A–F) from volume / capacity
We grade each segment with the standard **Highway Capacity Manual** definition —
a **volume-to-capacity (V/C) ratio** mapped to LOS A (free-flow) … F (breakdown).
This is also the LOS concept TraffiQ uses, adopted honestly:

```text
V/C  = normalised_betweenness / capacity_for_class(highway)
LOS  = A <=0.35 · B <=0.55 · C <=0.75 · D <=0.90 · E <=1.00 · F >1.00
risk = clamp(V/C, 0..1) * 100
```

`capacity_for_class` ranks OSM `highway` classes (motorway/trunk high →
residential/service low). Because capacity is the denominator, a moderately-used
*residential* street can grade worse than a busy *trunk* road — congestion is
relative to what the road was built to carry.

### 3. Critical links (single points of failure)
**Bridge edges** (whose removal disconnects part of the network) are flagged
`critical` — the resilience-planning half: "this link has no redundancy".

### 4. Transit access (GTFS frequency, or OSM coverage)
The multimodal half. **Where a GTFS feed exists**, `gtfs_transit.py` derives
per-stop **route breadth** and **median headway** → a frequency-dominated
`transit_access` score (5-min headway ≈ 100, ≥30-min ≈ 0).

**No open GTFS feed exists for Indore** (AICTSL publishes route/timing web pages
but no GTFS; Chalo's data is proprietary; Transitland/MobilityDatabase list no
Indore feed). So the Indore pilot instead uses **OSM stop coverage**
(`fetch_osm_transit.py` + `osm_transit.py`): OSM-mapped transit stops are binned
and each cell scored by how many stops fall within its ~walk-shed (3×3
neighbourhood) — `coverage_access` (4+ nearby stops ≈ 100). This is an honest
"is transit reachable here" proxy (`transit_source: "osm_stops"`), **not**
timetable frequency; headway/route fields stay null and the widget labels it
"(OSM coverage)". Swap in a real GTFS feed later for true frequency.

#### Bus frequency from open timetables (`gtfs_cells.py`)

Where a city's bus timetable is open GTFS, `pipeline/traffic/gtfs_cells.py`
bins it to cell dataset `bus_service` (L7): stops, routes, weekday
departures, departures per hour 07:00–10:00 and the minutes between buses at
each cell's busiest stop in that window. Bengaluru uses the community BMTC
feed scraped from the Namma BMTC app (github.com/Vonter/bmtc-gtfs, ODbL;
routes without live tracking are missing). Delhi's Open Transit Data feed
needs a registered key and is skipped until one is configured (or pass
`--gtfs <zip>`). The **Public transport access** lens then adds residents
within 500 m of a stop with a bus every 10 minutes or better at peak.

    python -m pipeline.traffic.gtfs_cells --region bengaluru   # ~45 MB download, seconds to bin

### 5. Demand-driven traffic load through the day (`demand_model.py`)

Betweenness treats every pair of junctions as equally likely to swap
traffic. The demand model puts people behind the flows with a four-step
model built only from data already in the repo:

| step | how | assumption |
|---|---|---|
| Generation | residents per ~1 km DIGIPIN L6 zone (GHSL, cell store) | 0.9 motorised trips / person / day |
| Attraction | GHSL non-residential built surface + 25% of residential + 400 m² per OSM amenity | jobs and activity floor space |
| Distribution | singly-constrained gravity, exp(−0.10 · minutes) | mean trip ≈ 10–15 min (5–7 km) |
| Vehicles | 0.37 PCU per trip (2W 40%, car 15%, auto 15%, bus 30%; IRC 106 PCUs) | one Indian mode mix |
| Peak | 9% of the day in the morning peak hour (IRC SP 41: 8–10%) | homes → destinations |
| Assignment | incremental (40/30/20/10%) all-or-nothing on the arterial graph, BPR t = t₀(1 + 0.15 (V/C)⁴) between increments | free-flow speeds and IRC 106 per-direction capacities by OSM class |

The graph is the arterial OSM network in `road_los.geojson`, split at shared
vertices with dangling ends snapped (≤ 25 m) onto the road they meet. Each
road gets `pcu_peak` (busier direction, PCU/h; demand, so it can exceed
capacity), `vc_peak`, `los_peak`, `speed_peak` (km/h after BPR) and
`pcu_daily`; reported speeds floor at a quarter of free flow (BPR runs away past V/C ≈ 2); the per-city `summary.json` gains a `demand_model` block. The cell
store gets `traffic_load` (L7): busiest-road V/C, LOS and demand, vehicle-km
weighted speed and delay, and daily vehicle-km per cell. The **Traffic** map
layer colours roads by the peak LOS, widens them with traffic and animates the
busiest; the **Traffic load** lens counts residents within 250 m of an
arterial at LOS E/F.

#### Through the day

Three trip patterns are distributed once on free-flow times and assigned
separately (each with its own BPR feedback):

| pattern | matrix | volume |
|---|---|---|
| `am` 09:00 commute | homes → jobs/activity (β 0.10) | 9.0% of the day |
| `pm` 18:00 trip home | the morning matrix transposed | 8.8% |
| `mid` 13:00 errands | homes ↔ activity, shorter trips (β 0.15), half each way | 4.8% |

`HOURLY_SHARE` gives each hour's share of daily traffic (a typical Indian
arterial profile: sharp 09:00 peak, broad 18:00 peak, midday plateau, quiet
night; sums to 100) and `HOURLY_MIX` which pattern(s) each hour carries
(06–11 morning, 16–21 evening, the rest errands, blended on the shoulders).
A road's V/C at hour *h* is Σₖ mixₖ(h) · V/Cₖ · share(h)/shareₖ, so each
pattern is reproduced exactly at its own hour. Roads gain `vc_am`, `vc_pm`,
`vc_mid`, `ffs` (free-flow km/h) and `peak_period`; the `pcu_peak`/`vc_peak`
/`los_peak`/`speed_peak` fields are now the worse of the two peaks and
`pcu_daily` sums all 24 hours. `traffic_load` gains `am_vc`, `pm_vc`, `mid_vc`
and `peak_period` (Morning/Evening). `summary.json` carries the profile under
`demand_model.hourly`, which the map reads. The **Traffic** layer's legend has
a clock: drag to any hour or press ▶ to play the day; roads re-colour with
paint expressions (no reload), also in the pitched 3D view. DISHA can do the
same with `[ACTION] trafficHour hour:18` (or `peak`, `play`).

Between peak hours the hourly V/C is a linear blend of the assigned patterns,
not a fresh assignment, so off-peak route choice is approximated.

#### Road what-if (`js/road-whatif.js`)

The Traffic legend's **What if…** button opens a panel: close a road, widen
one (+50% capacity, about one more lane each way) or click two junctions to
build a new 4-lane link, pick the 09:00 or 18:00 peak and press Run. A Web
Worker re-routes the commute with the pipeline's method (incremental
all-or-nothing + BPR) twice, before and after the edit (the "before" run is
cached per city and peak), and the map shows roads whose V/C rose (reds) or
fell (blues). The panel reports the change in vehicle-hours and average trip
time, roads that get busier or quieter, roads that tip into LOS E/F, people
living within 250 m of a road that gets worse, and trips cut off when a
closure leaves homes with no arterial route.

Input is `data/traffic/<region>/whatif_model.json` (written by `run`, or
alone with `--whatif-only`, a few seconds per city): the split arterial graph,
the home → work matrix with each origin's top 40 destinations kept exactly
and the rest pooled per ~4 km DIGIPIN L5 parent (correlation with the
pipeline's own 09:00 V/C ≈ 0.89 in Indore and Delhi), and residents per L7
cell near the network. Indore takes ~2 s per scenario, Delhi ~13 s for the
first run in the browser. Destinations stay fixed, so this is the effect in
the first weeks after a change, before people move jobs or homes.

What it does not know: signals, lane counts, one-way rules, local streets,
parking, buses' own routes, or today's events. Treat it as where commuting
demand meets thin capacity, then check against counts or a live feed (TomTom,
HERE or Mappls, which need a key).

    python -m pipeline.traffic.demand_model --region all     # ~3 min Delhi (three patterns)

### 6. Road noise and exhaust (`noise_air.py`)

From the demand model's daily volumes (`pcu_daily`, ×1.4 vehicles per PCU
for a two-wheeler-heavy mix, 5% heavy vehicles, 83% of the day between 06:00
and 24:00) each home cell (L7 centre) gets the CRTN L10(18h) of every modelled
road within 300 m, energy-summed and converted to Lden
(0.90·L10 + 3.77, Abbott & Nelson 2002). Exhaust is vehicle-km in the cell ×
fleet-average factors (NOx 0.45 g, exhaust PM2.5 0.025 g, CO₂ 110 g per
vehicle-km). Output: cell dataset `traffic_noise` (`lden_db`, `l10_18h_db`,
`nox_kg_day`, `pm25_exhaust_g_day`, `co2_t_day`) and a `noise_air` block in
`summary.json`. The **Road noise** lens counts residents at or above WHO's
53 dB Lden road guideline and at 65 dB, with the poorest-fifth share.

Sanity check: modelled NOx per ~4 km cell (L5) against Sentinel-5P NO₂ has a
Spearman rank correlation of 0.82 in Delhi, 0.87 Bhopal, 0.81 Jaipur, 0.77
Kolkata, 0.69 Indore, 0.65 Bengaluru, and is weak where ports, power plants
or the sea dominate the column (Mumbai 0.22, Chennai 0.33). Arterials only,
no barriers or building shielding: the noise figures describe the
road-facing side of homes near main roads.

    python -m pipeline.traffic.noise_air --region all        # seconds per city

### 7. Hospital access by time of day (`emergency_access.py`)

Hospitals and schools come from Overture Maps places (release 2026-10-21.0,
confidence ≥ 0.6, read straight from the public S3 parquet with DuckDB and
cached as `data/vectors/overture_facilities_<region>.geojson`). Each hospital
snaps to its nearest arterial node; one multi-source Dijkstra on the reversed
road graph gives every node its drive time to the nearest hospital. Link
times are free flow for 03:00 and BPR at the link's modelled `vc_am` /
`vc_pm` for 09:00 and 18:00 (capped at 4× free-flow time). Home cells add a
walk-speed access leg (15 km/h × 1.3 detour) to and from the road. Output:
cell dataset `emergency_access` (`hospital_min_night`, `hospital_min_am`,
`hospital_min_pm`, `rush_delay_min`, `hospitals`, `schools`) and an
`emergency_access` block in `summary.json`.

The **Hospital at rush hour** lens reports residents within 10 minutes at
3 am and at the worse peak, those more than 20 minutes away, people 60+ who
lose 10-minute reach in traffic, and schools at 65+ dB Lden or within 250 m
of an arterial at LOS E/F. First run: Delhi 91% within 10 min at night vs
83% at 09:00; Kolkata 98% vs 87%; Bengaluru 99% vs 96%. Overture's hospital
category includes nursing homes and small clinics, and there is no ambulance
priority, so this is general-traffic reach to any hospital-tagged place.

    python -m pipeline.traffic.emergency_access --region all            # cached places
    python -m pipeline.traffic.emergency_access --region delhi --refresh  # re-query Overture

### 8. Metro and rail station catchments (`rail_stations.py`)

Station points are Overture Maps places tagged `train_station` /
`metro_station` (names filtered: Overture also tags cafés, depots and
railway quarters) plus OpenStreetMap `station` points. Each is classed by the
nearest Overture rail track within 250 m: subway, light rail, monorail or tram
is **metro**, standard or narrow gauge is **rail**, with "metro" / "railway"
in the name breaking ties; nothing within 250 m drops the point. Entrances of
one station (same name within 750 m, or anything within 250 m) merge.
Output: `data/vectors/rail_stations_<region>.geojson`, cell dataset
`rail_access` (`metro_walk_min`, `rail_walk_min`, `metro_stations`,
`rail_stations`; walk = straight line × 1.3 at 4.8 km/h) and a `rail_access`
block in `summary.json`.

The **Metro catchments** lens reports residents within a 10-minute walk of a
metro station and of any station, the poorest fifth's share, and the three
best new station sites, chosen greedily by the residents each would add that
are not already within 10 minutes (no track alignment or cost).
`UrbanLenses.stationWhatIf(frame, lat, lng)` scores one site; DISHA answers
"what if a new metro station opened here?" for the selected cell and "where
should the next metro station go?" for the city. First run: Mumbai 30% within
10 min of metro (51% counting the locals), Delhi 26% (30%), Kolkata 21%,
Chennai 20%, Bengaluru 14%. Overture misses some newer stations (Ahmedabad
has 16 of about 32 mapped), so read the smaller systems as lower bounds.

    python -m pipeline.traffic.rail_stations --region all --refresh   # ~30 s per city

### 9. EV charging gaps (`ev_charging.py`)

Known public chargers merge (within 60 m) from OpenStreetMap
`amenity=charging_station` (Overpass; works on CI runners, skipped where it is
blocked), Open Charge Map (when `OCM_API_KEY` is set) and Overture Maps
`ev_charging_station` places; Overture `parking` and fuel-station places are
kept as low-cost host sites. Output: `data/vectors/ev_places_<region>.geojson`,
cell dataset `ev_charging` (`charger_km`, `chargers`, `parking`, `fuel`) and an
`ev_charging` block in `summary.json`.

The **EV charging gaps** lens reports residents within 2 km and 3 km (the
grid spacing in India's 2024 charging guidelines) of a known charger and the
share of arterial vehicle-km within 2 km. The **EV charging hub** siting
preset now weights arterial vehicle-km within 1 km (3), distance to the
nearest known charger (2), parking and fuel forecourts within 500 m (2),
residents per km² (1) and night lights (1). Open data lists only a fraction
of India's chargers (Overture: Delhi 44, Pune 85, Kolkata 0), so distances
are upper bounds until the OSM/Open Charge Map sources are added on CI.

    python -m pipeline.traffic.ev_charging --region all --refresh

### 10. Buildings on the traffic clock (`js/traffic-buildings.js`)

"Colour 3D buildings by the clock" in the Traffic legend (or DISHA
`[ACTION] trafficHour hour:18 buildings:on`) builds a runtime cell dataset
`traffic_clock` from `traffic_load` for the clock's hour: each L7 cell takes
the worst road V/C in it (via `TrafficOverlay.vcAt`), or ¾ of the worst in a
neighbouring cell, and BuildingData colours every Overture building by its
cell. Moving the slider or playing the day repaints the buildings as the
roads beside them fill and empty.

### 11. Monsoon what-if (`road_flood.py` + the What-if panel)

`road_flood.py` samples every arterial each ~100 m against the
`waterlogging` and `water` cell datasets and writes `wlog` (highest
waterlogging index along the road), `wlog_hi` (% of samples in High-or-worse
cells) and `fl100` (some stretch in the 1-in-100-year river flood at ≥ 0.3 m)
onto road_los.geojson, plus a `road_flood` block in summary.json. It runs
after demand_model. The What-if panel's three rain buttons (and DISHA: "what
happens to traffic in Mumbai when it rains heavily?") cut capacity by the
highest index along each road and re-route the commute:

| Level | wlog ≥ 65 | 60–65 | 55–60 | river floodplain |
|---|---|---|---|---|
| Heavy shower | × 0.5 | × 0.75 | – | – |
| Severe waterlogging | closed | × 0.5 | × 0.75 | – |
| River flood (1-in-100) | closed | × 0.5 | × 0.75 | × 0.25 |

Closures can disconnect homes whose only modelled arterial floods; the
headline then reports the vehicle trips cut off. Pumps, drains and the timing
of a storm are not modelled, so read it as which corridors carry the
diverted traffic, not as a forecast.

### 12. Shaded walks (Urban lens `shade`)

One multi-source Dijkstra per target type (stations from `rail_access`,
schools from `emergency_access`) over the `osm_walk` cell links, out to
1.6 km (~20 minutes). Each home takes the route to its nearest target; the
route's shade is the mean Meta/WRI tree canopy of the cells it crosses and
its heat the mean daytime LST. Residents are then pushed down the tree to
count whose route passes each cell; planting priority = that count × the
cell's missing canopy, and the top five cells (≥ 750 m apart) are listed.
Delhi: 63% of residents within 20 minutes of a station walk there under less
than 10% tree cover; 72% for the walk to school.

### 13. Bus gaps on busy corridors (Urban lens `busgap`)

Busy corridors are arterials in the top fifth of modelled peak-hour PCU; a
home within 250 m of one is beside it. It counts as served with a bus every
10 minutes or better within 400 m (GTFS, 07–10 h; Bengaluru today), any
mapped OSM bus stop within 400 m where there is no timetable, or a
rail/metro/BRT station within 800 m. The five heaviest unserved corridor
cells (≥ 1.5 km apart) are listed as candidates for new or more frequent
routes. Bengaluru: 4.9% of the 55.6 lakh people beside busy arterials lack a
frequent bus; Delhi (stops only): 17.3% have no stop at all.

### 14. Road danger on the school walk (Urban lens `roadsafety`)

Every child (residents × WorldPop under-15 share) walks the OSM walking
network to the nearest Overture school, out to 1.6 km. A road cell is
dangerous when its modelled arterial reaches 40+ km/h at free flow (peak
speed × (1 + peak delay)) and carries 600+ PCU in the peak hour. The map
shows the worst pedestrian fatality risk along each child's route if struck
at that speed (Rosén & Sander 2009 logistic: 1.5% at 30 km/h, 3.6% at 40,
18% at 60); crossing priority is children walking through × that risk, and
the top five cells (≥ 750 m apart) are listed for signalised crossings and
30 km/h school zones. There are no crossings, footbridges or crash records in
open data, so this ranks exposure, not crashes. Children whose walk crosses a
fast, busy arterial: Mumbai 34.5%, Bengaluru 28.8%, Kolkata 27%, Delhi 13.2%;
schools within 250 m of one: Mumbai 59%, Bengaluru 38%, Delhi 24%.

### 15. Mobility scorecard across the cities (`UrbanLenses.scorecard`)

Built from the lens league (`data/lenses/league.json`, `node
scripts/build_lens_league.js`), which now also carries `monsoon`: the share of
modelled arterial km in High-or-worse waterlogging cells (road_flood). Each
measure scores 0–100 between the worst and best of the 13 cities, direction-
aware; four pillars average their measures (Access: metro, SDG 11.2.1
transit, bus gaps, hospital at rush hour; Traffic flow: jammed arterials,
monsoon roads; Safety & health: school-walk danger, road noise; Walking:
15-minute essentials, shaded walks, junction density) and the overall score
averages the pillars. EV charging is left out because open charger data is
too partial to rank on. Scores are relative to these 13 cities, so small
towns (Guna) score well on flow simply by having little traffic. It shows in
the Lenses panel and answers "mobility scorecard" / "which city has the best
public transport" in DISHA. October 2026: Hyderabad 67, Bhopal 65, Pune 62 …
Mumbai 48, Kolkata 44, Ahmedabad 30.

## Pipeline (`pipeline/traffic/`)

| Stage | File | Output |
|---|---|---|
| Centrality + LOS | `road_network.py` | `data/traffic/<region>/road_los.geojson` + `summary.json` |
| Per-cell grid | `traffic_grid.py` | `data/traffic/<region>/traffic_grid.json` |
| Transit access | `gtfs_transit.py` | merges `transit_*` arrays into the grid |
| Tests | `tests/test_traffic.py` | pure helpers + betweenness on a synthetic graph (`importorskip networkx`) |

```sh
pip install -r pipeline/traffic/requirements.txt        # networkx
# needs OSM roads for the region (data/vectors/osm_roads_<region>.geojson)
python -m pipeline.traffic.road_network                  # → road_los.geojson + summary
python -m pipeline.traffic.traffic_grid                  # → traffic_grid.json
python -m pipeline.traffic.gtfs_transit --gtfs <dir|zip> # optional: add transit access
```

Heavy OSM/GTFS pulls can't run in the dev sandbox, so the pure CA/grid/LOS logic
is unit-tested on synthetic data and the real run happens on a data-capable
machine; commit the small resulting artifacts (~5–15 MB/region).

## Browser consumption

- `js/traffic-score.js` — pure LOS helpers (mirrors the pipeline).
- `js/traffic-grid.js` — samples `traffic_grid.json` by lat/lng (like `footprint-grid.js`).
- `js/realtime-traffic.js` — `fetchCell`/`scoreCell` → `result.realtime.traffic`.
- `js/traffic-widget.js` — cell-panel card (LOS grade, congestion risk, dominant
  road, critical-link flag, transit access).
- `js/traffic-overlay.js` — **"Traffic"** toolbar layer: roads coloured by LOS
  A–F with critical links emphasised + legend. **Fallback:** when no precomputed
  `road_los.geojson` exists it fetches viewport roads live from Overpass and
  colours them by OSM-class capacity only (labelled "class-based, no centrality")
  — so the layer is immediately useful and upgrades to full LOS once the pipeline
  has run.
- `js/real-estate-model.js` — adds `transitAccess` (demand) + `lowCongestion`
  (risk) factors, intent-weighted (Live ↑ transit & low congestion); drops to
  neutral when the traffic layer is absent. Surfaced in Compare verdicts too.

## Data sources & licensing
- **Roads**: OpenStreetMap (ODbL — attribute & share-alike).
- **Transit**: GTFS feeds (per-operator licences; Transitland / data.gov.in).
- All free, redistributable with attribution, $0/month, fully offline once built.

## Caveats
- **Structural, not real-time** — captures where load concentrates by network
  design; it does not model time-of-day peaks, incidents, weather, or signals.
- Betweenness is a *volume proxy*, not measured counts; capacity is inferred from
  road class (OSM `maxspeed`/lanes are sparse in Tier-2 India).
- 100–200 m grid → a neighbourhood-scale read, not lane-level.
- GTFS reflects the timetable, not live delays; transit signal absent where no
  feed is published.
