"""Freight and logistics: where goods move, which roads the trucks use, and who lives beside them.

Establishments that generate truck trips are Overture Maps places (confidence
≥ MIN_CONF) in three groups:

    logistics   freight and cargo, freight forwarding, courier, storage,
                shipping centres, trucking, rail freight, movers, warehouses
    wholesale   wholesalers, distributors, wholesale grocers
    industry    manufacturers, industrial companies

Each establishment gets an indicative TRUCKS[kind] truck trips a day (trip
ends in + out; freight-trip-generation surveys put small Indian
establishments at a few trucks a day and logistics sites at 10–20). Trucks
take the fastest free-flow route on the modelled arterials (road_los) to the
nearest national highway node (motorway/trunk): the first and last mile, at
night when most Indian cities allow heavy vehicles in. Per L7 cell
(dataset ``freight``):

    logistics / wholesale / industry   establishments in the cell
    trucks_day       busiest modelled truck flow on a road in the cell
    truck_nox_kg_day truck NOx emitted on roads in the cell (EF g/km)

summary.json ``freight``: establishments, truck trips, busiest truck roads.

    python -m pipeline.traffic.freight --region delhi [--refresh]
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.traffic import demand_model as dm
from pipeline.traffic.emergency_access import Snapper

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
VECTORS = REPO / "data" / "vectors"
LEVEL = 7
OVERTURE_RELEASE = "2026-10-21.0"
MIN_CONF = 0.5
TRUCKS = {"logistics": 12, "wholesale": 6, "industry": 4}
NOX_G_KM = 5.0                 # heavy goods vehicle NOx, BS-IV/BS-VI fleet mix (COPERT-class factor)
GATEWAY = {"motorway", "trunk"}
LOGISTICS = {"freight_and_cargo_service", "freight_forwarding_agency", "storage_facility", "shipping_center",
             "courier_and_delivery_service", "motor_freight_trucking", "railroad_freight", "mover", "warehouse",
             "distribution_service", "packing_services", "logistics", "self_storage_facility"}
WHOLESALE = re.compile(r"wholesal|distributor|supplier_or_distributor")
INDUSTRY = re.compile(r"manufactur|^industrial_company$|^commercial_industrial$|^factory$")
PATTERN = "freight|cargo|courier|storage|shipping|trucking|mover|warehouse|distribut|wholesal|supplier|manufactur|industrial|factory|logistic|packing"
NOT_FREIGHT = re.compile(r"club_store|food_truck|marketing|medical_transport|dealer")


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def kind_of(primary):
    """'logistics' | 'wholesale' | 'industry' | None for an Overture category."""
    p = primary or ""
    if NOT_FREIGHT.search(p):
        return None
    if p in LOGISTICS:
        return "logistics"
    if WHOLESALE.search(p):
        return "wholesale"
    if INDUSTRY.search(p):
        return "industry"
    return None


def route_flows(n, links, sources, gateways):
    """Truck flow per link when each source sends its trucks to the nearest gateway.

    ``links`` = [(tail, head, minutes)], ``sources`` = [(node, trucks)],
    ``gateways`` = node ids. Returns a list of flows aligned with ``links``.
    """
    import numpy as np
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    best: dict = {}
    for e, (a, b, t) in enumerate(links):
        # Reversed graph: gateway → facility mirrors facility → gateway.
        k = (b, a)
        if k not in best or t < links[best[k]][2]:
            best[k] = e
    gw = sorted(set(gateways))
    rows = [k[0] for k in best] + [n] * len(gw)
    cols = [k[1] for k in best] + gw
    vals = [max(links[e][2], 1e-6) for e in best.values()] + [1e-6] * len(gw)
    g = csr_matrix((vals, (rows, cols)), shape=(n + 1, n + 1))
    dist, pred = dijkstra(g, indices=n, return_predecessors=True)
    flow = [0.0] * len(links)
    for node, trucks in sources:
        u = node
        if not np.isfinite(dist[u]):
            continue
        guard = 0
        while u != n and pred[u] >= 0 and pred[u] != n and guard < n:
            p = int(pred[u])
            flow[best[(p, u)]] += trucks
            u, guard = p, guard + 1
    return flow


# ── IO ──────────────────────────────────────────────────────────────────────

def fetch(region, release=OVERTURE_RELEASE, log=print):
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    base = f"s3://overturemaps-us-west-2/release/{release}"
    rows = con.execute(f"""
        SELECT taxonomy.primary, names.primary, (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
        FROM read_parquet('{base}/theme=places/type=place/*')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n} AND confidence >= {MIN_CONF}
          AND regexp_matches(taxonomy.primary, '{PATTERN}')
    """).fetchall()
    feats = []
    for cat, name, x, y in rows:
        k = kind_of(cat)
        if k:
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(x, 6), round(y, 6)]},
                          "properties": {"kind": k, "category": cat, "name": name or ""}})
    gj = {"type": "FeatureCollection", "source": f"Overture Maps places {release}", "features": feats}
    VECTORS.mkdir(parents=True, exist_ok=True)
    (VECTORS / f"freight_places_{region}.geojson").write_text(json.dumps(gj, separators=(",", ":"), ensure_ascii=False))
    log(f"{region}: {Counter(f['properties']['kind'] for f in feats)}")
    return gj


def load(region, refresh=False, log=print):
    p = VECTORS / f"freight_places_{region}.geojson"
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    return fetch(region, log=log)


def _cell(x, y):
    try:
        return digipin.encode(y, x).replace("-", "")[:LEVEL]
    except Exception:
        return None


def compute(region, refresh=False, log=print):
    feats = json.loads((REPO / "data" / "traffic" / region / "road_los.geojson").read_text())["features"]
    net = dm.Network(feats)
    snap = Snapper(net)
    gj = load(region, refresh, log)
    rows: dict = {}
    src = Counter()
    for f in gj["features"]:
        x, y = f["geometry"]["coordinates"]
        k = f["properties"]["kind"]
        c = _cell(x, y)
        if c:
            r = rows.setdefault(c, {})
            r[k] = r.get(k, 0) + 1
        node, _ = snap.nearest(x, y)
        if node >= 0:
            src[node] += TRUCKS[k]
    gates = [net.tail[e] for e in range(len(net.head))
             if (feats[net.feat[e]]["properties"].get("highway") or "").replace("_link", "") in GATEWAY
             and net.main[net.tail[e]]]
    links = [(net.tail[e], net.head[e], net.t0[e]) for e in range(len(net.head))]
    flow = route_flows(net.n, links, list(src.items()), gates) if gates else [0.0] * len(links)
    by_feat = Counter()
    for e, v in enumerate(flow):
        if v:
            by_feat[net.feat[e]] += v
            mx, my = net.mid[e]
            c = _cell(mx, my)
            if c:
                r = rows.setdefault(c, {})
                r["trucks_day"] = max(r.get("trucks_day", 0), round(v))
                r["truck_nox_kg_day"] = round(r.get("truck_nox_kg_day", 0) + v * net.length[e] / 1000 * NOX_G_KM / 1000, 3)
    named = Counter()
    for fi, v in by_feat.items():
        nm = feats[fi]["properties"].get("name")
        if nm:
            named[nm] = max(named[nm], v)
    kinds = Counter(f["properties"]["kind"] for f in gj["features"])
    heavy_km = sum(net.length[e] for e, v in enumerate(flow) if v >= 500) / 1000 / 2
    summ = {"establishments": dict(kinds), "truck_trips_day": int(sum(TRUCKS[k] * v for k, v in kinds.items())),
            "gateway_nodes": len(set(gates)), "road_km_500_trucks_day": round(heavy_km, 1),
            "busiest_truck_roads": [{"name": n, "trucks_day": round(v)} for n, v in named.most_common(5)],
            "assumptions": {"trucks_per_establishment": TRUCKS, "nox_g_km": NOX_G_KM},
            "source": f"Overture Maps places {OVERTURE_RELEASE}; demand model arterials"}
    log(f"{region}: {json.dumps(summ)[:400]}")
    return rows, summ


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("logistics", "Logistics, courier and storage sites", agg="sum", unit="sites", ramp="viridis"),
        FieldSpec("wholesale", "Wholesalers and distributors", agg="sum", unit="sites", ramp="viridis"),
        FieldSpec("industry", "Manufacturers and industrial firms", agg="sum", unit="sites", ramp="viridis"),
        FieldSpec("trucks_day", "Busiest modelled truck flow on a road here", agg="max", unit="trucks/day",
                  ramp="heat", higher_is="worse"),
        FieldSpec("truck_nox_kg_day", "Truck NOx emitted on roads here", agg="sum", unit="kg/day",
                  ramp="heat", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="freight", title="Freight and logistics", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Truck-trip generators from Overture Maps places (logistics, wholesale, industry) and the "
                    "first/last-mile truck routes they load: each site's indicative truck trips "
                    f"({TRUCKS['logistics']}/{TRUCKS['wholesale']}/{TRUCKS['industry']} a day) take the fastest "
                    "free-flow arterial route to the nearest national highway. Truck NOx at "
                    f"{NOX_G_KM} g/km. Indicative: no truck counts or gate data.",
        source=f"pipeline/traffic/freight.py over Overture Maps places {OVERTURE_RELEASE} + road_los",
        license="CDLA-Permissive-2.0 (Overture places) + ODbL (OpenStreetMap)",
        default_field="trucks_day", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, refresh=False, log=print):
    path = REPO / "data" / "traffic" / region / "road_los.geojson"
    if not path.exists():
        log(f"{region}: no road_los.geojson, skipped")
        return None
    rows, summ = compute(region, refresh, log)
    res = cell_dataset(region, rows)
    sp = REPO / "data" / "traffic" / region / "summary.json"
    s = json.loads(sp.read_text()) if sp.exists() else {}
    s["freight"] = summ
    sp.write_text(json.dumps(s, indent=2) + "\n")
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    p.add_argument("--refresh", action="store_true", help="re-query Overture")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r, a.refresh)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
