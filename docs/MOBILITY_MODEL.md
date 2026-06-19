# Law & Order Mobility — access-resilience model

> **Defensive framing.** This layer is for **authorities and emergency planners**:
> it marks where police / fire / ambulance movement can be **choked or sealed off**
> during a riot, VIP movement, disaster, or other law-and-order situation, so those
> routes can be **kept open and pre-positioned**. It is the security sibling of the
> flood/hazard layers — it surfaces access vulnerabilities in order to protect them.
> All inputs are public OpenStreetMap data; it is *structural*, not a live feed.

## What it marks

1. **Chokepoints** (points) — OSM **railway level crossings**, **toll booths**, and
   **lift gates** that physically throttle a road and are trivially blocked/sealed.
   (Indore: 43 level crossings, 14 toll booths, 81 lift gates.)
2. **Critical / seal links** (lines) — sole-connector road segments:
   - `critical_link` — the high-betweenness bridges from the traffic LOS model.
   - `seal_link` — bridge edges that, if cut, isolate a **sealable pocket**.
3. **Sealable pockets** (per-cell) — from a 2-edge-connected-component analysis on a
   properly **noded** road graph: a block of real size reachable from the rest of the
   network only through ≤2 bridge edges. One or two barricades seal it.
4. **Police response reach** (per-cell) — straight-line distance to the nearest of the
   17 OSM police stations.

These combine into a per-cell **mobility-risk** (0–100, higher = harder to move/reach)
and an **access class**: Smooth / Constrained / Restricted (a sealable pocket is never
"Smooth").

## Method

```text
mobility_risk = 35*police_reach + 25*chokepoint_on_access + 20*sealable + 20*sparse_roads
  police_reach = min(1, nearest_police_km / 5)
  sparse_roads = 1 - min(1, road_density_m / (2*res_m))     # reuses the traffic grid
access_class = Restricted (>=66 or sealable) · Constrained (>=40) · Smooth (<40)
```

The graph is noded by connecting **consecutive** road vertices (so OSM intersections
become shared nodes — the traffic model's endpoint-only graph fragments the network and
can't support cut-analysis). Sealable pockets come from one O(V+E) pass: list bridges,
remove them, take connected components (2-edge-connected blocks), and flag blocks of
size 40–2000 nodes reachable via ≤2 bridges.

## Pipeline (`pipeline/safety/`)

| Stage | File | Output |
|---|---|---|
| Fetch police + chokepoints | `fetch_osm_safety.py` | `data/vectors/osm_safety_<region>.geojson` |
| Analysis | `mobility.py` | `data/safety/<region>/chokepoints.geojson` + `mobility_grid.json` |
| Tests | `tests/test_mobility.py` | risk/class/geometry helpers + seal-pocket analysis (`importorskip networkx`) |

```sh
pip install -r pipeline/safety/requirements.txt          # networkx, requests
# prerequisites: the traffic road graph + grid (pipeline.traffic.*)
python -m pipeline.safety.fetch_osm_safety
python -m pipeline.safety.mobility
```

Indore result: 153 marks (138 OSM chokepoints + 13 critical links + 2 seal links),
~1,970 scored cells (1494 Smooth / 388 Constrained / 91 Restricted), 9 sealable cells.

## Browser consumption

- `js/mobility-score.js` — pure access-class bands + colours (mirrors the pipeline).
- `js/mobility-grid.js` — samples `mobility_grid.json` by lat/lng (null off-network).
- `js/realtime-mobility.js` — `fetchCell`/`scoreCell` → `result.realtime.mobility`.
- `js/mobility-widget.js` — cell-panel card (access class, risk, police reach, sealable).
- `js/mobility-overlay.js` — **"L&O"** toolbar layer: chokepoint markers + seal/critical
  links + legend + click details (the "mark those places" deliverable).

## Caveats & responsible use
- **Defensive resilience aid**, not an operational targeting tool. It highlights
  vulnerabilities so authorities can keep access open / pre-position resources.
- **Structural & OSM-derived** on the arterial network — coverage and accuracy depend
  on OSM completeness; not a live or sanctioned-route feed. Police reach is
  straight-line, not drive-time.
- A well-connected city has few true sealable pockets (Indore: a handful) — that is the
  expected, honest result, not a gap.
