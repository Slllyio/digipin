"""Law & Order Mobility — road-access resilience for security/emergency planning.

Marks where authorities' / emergency vehicles' movement can be choked or sealed
off during a riot, VIP movement, disaster, or other law-and-order situation — so
planners can pre-position and keep routes open. This is a DEFENSIVE resilience
view (the same lens as the flood/hazard layers): it surfaces access
vulnerabilities in order to protect them, not to exploit them.

Built on the road graph from `pipeline.traffic.road_network`:

  * **Critical junctions** — `networkx.articulation_points`: nodes whose removal
    splits the road network. Block/lose one and whole sectors disconnect.
  * **Critical links** — the `criticality == "critical"` segments already scored
    by road_network (high-betweenness bridges = sole connectors).
  * **Chokepoints** — OSM railway level crossings, toll booths, lift gates
    (fetch_osm_safety.py) that throttle a road and are easily sealed.
  * **Police response reach** — straight-line distance to the nearest station.
  * **Sealable pockets** — cells whose access depends on a single critical
    junction/link and that have sparse road redundancy.

Outputs:
  data/safety/<region>/chokepoints.geojson  — the points + critical links to mark
  data/safety/<region>/mobility_grid.json   — per-cell mobility-risk the browser samples

`mobility_risk` / `access_class` / `_haversine_km` are pure (stdlib) and
unit-tested; the graph build + articulation points import networkx lazily.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
from pathlib import Path

from pipeline._lib.regions import get_default_region_name

log = logging.getLogger("pipeline.safety.mobility")

CHOKE_RADIUS_M = 250.0          # a chokepoint within this of a cell sits on its access
POLICE_CAP_KM = 5.0             # reach saturates here (≥5 km ⇒ slowest)


# ───────────────────────── pure helpers ─────────────────────────
def _haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance in kilometres between two lat/lng points."""
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def mobility_risk(police_km, choke_near, sealable, road_density_m, res_m=200.0):
    """0..100 restricted-mobility risk (higher = harder to move/reach). Pure.

    Weights: police reach 35, chokepoint on access 25, sealable pocket 20,
    sparse road access 20."""
    police = min(1.0, (police_km if police_km is not None else POLICE_CAP_KM) / POLICE_CAP_KM)
    # sparse access: a cell with < ~2 cell-widths of road is poorly connected
    dens = road_density_m if road_density_m is not None else 0.0
    sparse = 1.0 - min(1.0, dens / (res_m * 2.0))
    score = 35 * police + 25 * (1.0 if choke_near else 0.0) \
        + 20 * (1.0 if sealable else 0.0) + 20 * sparse
    return int(round(max(0.0, min(100.0, score))))


def access_class(risk, sealable=False):
    """Qualitative band. Sealable pockets are never labelled 'Smooth'. Pure."""
    if sealable and risk < 66:
        return "Restricted"
    if risk >= 66:
        return "Restricted"
    if risk >= 40:
        return "Constrained"
    return "Smooth"


def _cell_xy(lng, lat, bounds, nx, ny):
    """Return the (x, y) grid cell for a lng/lat within bounds, or (-1, -1) if outside."""
    w, s, e, n = bounds["west"], bounds["south"], bounds["east"], bounds["north"]
    if not (w <= lng < e and s <= lat < n):
        return -1, -1
    x = min(nx - 1, int((lng - w) / (e - w) * nx))
    y = min(ny - 1, int((n - lat) / (n - s) * ny))
    return x, y


# ───────────────────────── orchestration (lazy networkx) ─────────────────────
def _build_noded_graph(features):
    """Properly-noded road graph: edges between CONSECUTIVE vertices so that
    intersections (shared OSM nodes) become shared graph nodes. (road_network's
    endpoint-only graph fragments the network and makes cut-vertex analysis
    meaningless.) Returns a networkx.Graph."""
    import networkx as nx
    G = nx.Graph()
    for f in features:
        geom = f.get("geometry", {})
        t = geom.get("type")
        coords = geom.get("coordinates", [])
        segs = [coords] if t == "LineString" else coords if t == "MultiLineString" else []
        for seg in segs:
            pts = [(round(p[0], 5), round(p[1], 5)) for p in seg]
            for a, b in zip(pts, pts[1:]):
                if a != b:
                    G.add_edge(a, b)
    return G


def seal_analysis(G, nx, min_pocket=40, max_pocket=2000, max_seals=2):
    """Find sealable pockets: 2-edge-connected blocks of meaningful size that the
    rest of the network reaches through only a few **bridge** edges. Cutting those
    bridges seals the pocket — the law-and-order "restrict access" scenario.

    Returns (seal_bridges, sealable_nodes):
      seal_bridges  — list of ((lng,lat),(lng,lat)) bridge edges that seal a pocket
      sealable_nodes — set of (lng,lat) nodes inside a sealable pocket
    Single O(V+E) pass (bridges + components), no per-node recompute."""
    from collections import Counter
    bridges = list(nx.bridges(G))
    Gb = G.copy()
    Gb.remove_edges_from(bridges)
    comps = list(nx.connected_components(Gb))           # 2-edge-connected blocks
    node2comp = {}
    for i, c in enumerate(comps):
        for n in c:
            node2comp[n] = i
    bridge_deg = Counter()                              # bridges touching each block
    for u, v in bridges:
        cu, cv = node2comp[u], node2comp[v]
        if cu != cv:
            bridge_deg[cu] += 1
            bridge_deg[cv] += 1
    pockets = {i for i, c in enumerate(comps)
               if min_pocket <= len(c) <= max_pocket and 1 <= bridge_deg[i] <= max_seals}
    sealable_nodes = set()
    for i in pockets:
        sealable_nodes |= comps[i]
    seal_bridges = [(u, v) for u, v in bridges
                    if node2comp[u] in pockets or node2comp[v] in pockets]
    return seal_bridges, sealable_nodes


def _load_geojson(path):
    """Read a GeoJSON file, or return an empty FeatureCollection if it is missing."""
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else {"features": []}


def run(region=None):
    """Full pipeline: sealable-pocket + chokepoint + police-reach analysis → grid + geojson."""
    region = region or get_default_region_name()

    roads_p = Path(f"data/vectors/osm_roads_{region}.geojson")
    grid_p = Path(f"data/traffic/{region}/traffic_grid.json")
    if not roads_p.exists():
        raise SystemExit(f"missing {roads_p} — run pipeline.traffic.fetch_osm_roads first")
    if not grid_p.exists():
        raise SystemExit(f"missing {grid_p} — run pipeline.traffic.traffic_grid first")

    import networkx as nx
    roads = json.loads(roads_p.read_text())["features"]
    G = _build_noded_graph(roads)
    seal_bridges, sealable_nodes = seal_analysis(G, nx)
    log.info("graph %d nodes / %d edges → %d seal-bridges, %d cells in sealable pockets",
             G.number_of_nodes(), G.number_of_edges(), len(seal_bridges), len(sealable_nodes))

    los = _load_geojson(f"data/traffic/{region}/road_los.geojson")["features"]
    critical_links = [f for f in los if (f.get("properties", {}).get("criticality") == "critical")]

    safety = _load_geojson(f"data/vectors/osm_safety_{region}.geojson")["features"]
    police = [(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])
              for f in safety if f["properties"].get("kind") == "police"]
    chokepts = [f for f in safety if f["properties"].get("kind") != "police"]

    # ---- chokepoints.geojson: the marks (OSM chokepoints + seal/critical links) ----
    out_dir = Path(f"data/safety/{region}")
    out_dir.mkdir(parents=True, exist_ok=True)
    choke_features = []
    for f in chokepts:
        f["properties"]["severity"] = "high" if f["properties"]["kind"] == "level_crossing" else "medium"
        choke_features.append(f)
    for (au, av) in seal_bridges:
        choke_features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [list(au), list(av)]},
            "properties": {"kind": "seal_link", "severity": "high"},
        })
    for f in critical_links:
        f["properties"]["kind"] = "critical_link"
        f["properties"]["severity"] = "high"
        choke_features.append(f)
    (out_dir / "chokepoints.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": choke_features}, separators=(",", ":")))

    # ---- per-cell mobility grid (reuse traffic grid geometry + road_density) ----
    grid = json.loads(grid_p.read_text())
    bounds, gnx, gny = grid["bounds"], grid["nx"], grid["ny"]
    density = grid.get("road_density_m") or [0.0] * (gnx * gny)
    res_m = grid.get("res_m", 200)
    size = gnx * gny

    choke_cell = [0] * size
    for f in chokepts:
        lng, lat = f["geometry"]["coordinates"][:2]
        x, y = _cell_xy(lng, lat, bounds, gnx, gny)
        if x >= 0:
            choke_cell[y * gnx + x] = 1
    seal_cell = [0] * size                              # cells inside a sealable pocket
    for (lng, lat) in sealable_nodes:
        x, y = _cell_xy(lng, lat, bounds, gnx, gny)
        if x >= 0:
            seal_cell[y * gnx + x] = 1

    risk = [None] * size
    aclass = [None] * size
    sealable_arr = [0] * size
    police_km_arr = [None] * size
    chokeprox = [0] * size

    for i in range(size):
        gy, gx = divmod(i, gnx)
        # Only score navigable cells (on the road network / carrying a chokepoint
        # or sealable pocket); empty no-road cells stay null.
        on_network = (density[i] or 0.0) > 0 or choke_cell[i] or seal_cell[i]
        if not on_network:
            continue
        clat = bounds["north"] - (gy + 0.5) / gny * (bounds["north"] - bounds["south"])
        clng = bounds["west"] + (gx + 0.5) / gnx * (bounds["east"] - bounds["west"])
        pk = min((_haversine_km(clat, clng, plat, plng) for plat, plng in police), default=None)
        police_km_arr[i] = round(pk, 2) if pk is not None else None
        near = False
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yy, xx = gy + dy, gx + dx
                if 0 <= yy < gny and 0 <= xx < gnx and choke_cell[yy * gnx + xx]:
                    near = True
        chokeprox[i] = 1 if near else 0
        seal = bool(seal_cell[i])
        sealable_arr[i] = 1 if seal else 0
        r = mobility_risk(pk, near, seal, density[i], res_m)
        risk[i] = r
        aclass[i] = access_class(r, seal)

    mob = {
        "res_m": res_m, "bounds": bounds, "nx": gnx, "ny": gny,
        "mobility_risk": risk,
        "access_class": aclass,
        "sealable": sealable_arr,
        "on_chokepoint": chokeprox,
        "nearest_police_km": police_km_arr,
        "source": "osm_seal_pockets_chokepoints",
    }
    (out_dir / "mobility_grid.json").write_text(json.dumps(mob, separators=(",", ":")))
    covered = sum(1 for r in risk if r is not None and r >= 40)
    log.info("wrote %s — %d marks, %d cells Constrained+/Restricted",
             out_dir / "mobility_grid.json", len(choke_features), covered)
    return {"marks": len(choke_features), "seal_bridges": len(seal_bridges),
            "critical_links": len(critical_links), "police": len(police),
            "sealable_cells": sum(sealable_arr)}


def main():
    """CLI: build the access-resilience (mobility) grid and print its summary."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    argparse.ArgumentParser().parse_args()
    print(run())


if __name__ == "__main__":
    main()
