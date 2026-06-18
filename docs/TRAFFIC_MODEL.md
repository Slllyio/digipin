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

```
V/C  = normalised_betweenness ÷ capacity_for_class(highway)
LOS  = A ≤0.35 · B ≤0.55 · C ≤0.75 · D ≤0.90 · E ≤1.00 · F >1.00
risk = clamp(V/C, 0..1) × 100
```

`capacity_for_class` ranks OSM `highway` classes (motorway/trunk high →
residential/service low). Because capacity is the denominator, a moderately-used
*residential* street can grade worse than a busy *trunk* road — congestion is
relative to what the road was built to carry.

### 3. Critical links (single points of failure)
**Bridge edges** (whose removal disconnects part of the network) are flagged
`critical` — the resilience-planning half: "this link has no redundancy".

### 4. Transit access (GTFS)
The multimodal half: a GTFS feed (open bus/transit timetables) gives per-stop
**route breadth** and **median headway**, aggregated to a per-cell
`transit_access` score (frequency-dominated, 5-min headway ≈ 100, ≥30-min ≈ 0).
Well-served cells generate/absorb trips without adding road load.

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
