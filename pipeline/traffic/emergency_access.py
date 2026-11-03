"""Ambulance access at rush hour: drive time from every home to the nearest
hospital at 03:00, 09:00 and 18:00, plus where schools sit.

Facilities come from Overture Maps places (the latest release on the public
S3 bucket, read with DuckDB and a bbox filter): hospitals (``basic_category``
or taxonomy ``hospital`` / ``emergency_room``, confidence ≥ ``MIN_CONF``) and
schools (preschool to high school). They are written once per city to
data/vectors/overture_facilities_<region>.geojson so the app can draw them and
re-bakes don't need the network.

Drive times run on the demand model's arterial graph
(data/traffic/<region>/road_los.geojson, demand_model.Network). Each road
piece takes its free-flow time at 03:00 and the BPR time for the road's
modelled V/C at 09:00 (vc_am) and 18:00 (vc_pm), floored at a quarter of
free-flow speed as in the model. Homes (L7 population cells) and hospitals
join the graph at the nearest junction with an access leg at
``ACCESS_KMH`` over 1.3× the straight line. One multi-source Dijkstra per
period on the reversed graph gives every home its quickest hospital.

Caveats: general-traffic speed (ambulances weave, but Indian arterials at
LOS F leave little room), arterials only, a hospital is any Overture place
tagged so (small nursing homes included, no bed or emergency-ward data).

Outputs: cell dataset ``emergency_access`` (L7): hospital_min_night,
hospital_min_am, hospital_min_pm, rush_delay_min, hospitals, schools; and an
``emergency_access`` block in summary.json.

    python -m pipeline.traffic.emergency_access --region all
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
VECTORS = REPO / "data" / "vectors"
LEVEL = 7
OVERTURE_RELEASE = "2026-10-21.0"
MIN_CONF = 0.6
ACCESS_KMH = 15.0
DETOUR = 1.3
GOLDEN_MIN = 10.0            # "within 10 minutes" threshold reported by the lens
HOSPITAL = ("hospital", "emergency_room")
SCHOOL = ("school", "preschool", "elementary_school", "middle_school", "high_school",
          "private_school", "public_school", "place_of_learning")


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def kind_of(basic, primary):
    """'hospital' | 'school' | None for an Overture place's categories."""
    b, p = (basic or "").lower(), (primary or "").lower()
    if b in HOSPITAL or p in HOSPITAL:
        return "hospital"
    if p in SCHOOL or (b == "place_of_learning" and p in ("", "school")) or b in SCHOOL[:5]:
        return "school"
    return None


def period_time(t0, vc, cap_slow=dm.MAX_SLOWDOWN):
    """Link minutes at a V/C (BPR, floored at free-flow ÷ cap_slow)."""
    return t0 * min(1 + dm.BPR_A * max(vc, 0.0) ** dm.BPR_B, cap_slow)


def access_min(dist_m):
    return dist_m * DETOUR / 1000 / ACCESS_KMH * 60


# ── facilities ──────────────────────────────────────────────────────────────

def fetch_facilities(region, release=OVERTURE_RELEASE, log=print):
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
    rows = con.execute(f"""
        SELECT names.primary, basic_category, taxonomy.primary, confidence,
               (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
        FROM read_parquet('{src}')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}
          AND confidence >= {MIN_CONF}
          AND (basic_category IN {HOSPITAL + SCHOOL} OR taxonomy.primary IN {HOSPITAL + SCHOOL})
    """).fetchall()
    feats = []
    for name, basic, prim, conf, x, y in rows:
        k = kind_of(basic, prim)
        if k:
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(x, 6), round(y, 6)]},
                          "properties": {"kind": k, "name": name or "", "category": prim or basic,
                                         "confidence": round(conf, 2)}})
    gj = {"type": "FeatureCollection", "features": feats,
          "source": f"Overture Maps places {release} (CDLA-Permissive-2.0 / ODbL sources)"}
    out = VECTORS / f"overture_facilities_{region}.geojson"
    out.write_text(json.dumps(gj, separators=(",", ":")))
    log(f"{region}: {sum(f['properties']['kind'] == 'hospital' for f in feats)} hospitals, "
        f"{sum(f['properties']['kind'] == 'school' for f in feats)} schools → {out.name}")
    return gj


def load_facilities(region, refresh=False, log=print):
    p = VECTORS / f"overture_facilities_{region}.geojson"
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    return fetch_facilities(region, log=log)


# ── travel times ────────────────────────────────────────────────────────────

class Snapper:
    """Nearest main-component node to a point via a coarse grid."""

    def __init__(self, net, g=0.01):
        self.net, self.g, self.grid = net, g, {}
        for i, (x, y) in enumerate(net.xy):
            if net.main[i]:
                self.grid.setdefault((int(x / g), int(y / g)), []).append(i)

    def nearest(self, lon, lat):
        """(node, metres): checks the 3×3 block, widening until something is found."""
        gx, gy = int(lon / self.g), int(lat / self.g)
        for r in range(1, 8):
            best, bi = float("inf"), -1
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    for i in self.grid.get((gx + dx, gy + dy), ()):
                        x, y = self.net.xy[i]
                        d = dm.haversine_m(lon, lat, x, y)
                        if d < best:
                            best, bi = d, i
            if bi >= 0:
                return bi, best
        return -1, float("inf")


def drive_times(net, feats, hospital_nodes, hospital_access):
    """{period: dist array (minutes) from every node to its nearest hospital}."""
    import numpy as np
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    n = net.n
    vcs = {"night": None, "am": "vc_am", "pm": "vc_pm"}
    out = {}
    for period, key in vcs.items():
        t = np.array([net.t0[e] if key is None else
                      period_time(net.t0[e], float(feats[net.feat[e]]["properties"].get(key) or 0.0))
                      for e in range(len(net.head))])
        # Reverse graph (home → hospital = hospital → home on reversed links) + a super-source.
        best: dict = {}
        for e in range(len(net.head)):
            k = (net.head[e], net.tail[e])
            if k not in best or t[e] < best[k]:
                best[k] = t[e]
        rows = [a for a, _ in best] + [n] * len(hospital_nodes)
        cols = [b for _, b in best] + list(hospital_nodes)
        vals = list(best.values()) + [max(a, 1e-6) for a in hospital_access]
        g = csr_matrix((vals, (rows, cols)), shape=(n + 1, n + 1))
        out[period] = dijkstra(g, indices=n)[:n]
    return out


def compute(region, log=print):
    import numpy as np
    path = REPO / "data" / "traffic" / region / "road_los.geojson"
    feats = json.loads(path.read_text())["features"]
    net = dm.Network(feats)
    snap = Snapper(net)
    fac = load_facilities(region, log=log)
    hn, ha = [], []
    counts: dict = {}
    for f in fac["features"]:
        x, y = f["geometry"]["coordinates"]
        k = f["properties"]["kind"]
        try:
            code = digipin.encode(y, x).replace("-", "")[:LEVEL]
        except Exception:
            continue
        c = counts.setdefault(code, {"hospitals": 0, "schools": 0})
        c["hospitals" if k == "hospital" else "schools"] += 1
        if k == "hospital":
            node, d = snap.nearest(x, y)
            if node >= 0:
                hn.append(node)
                ha.append(access_min(d))
    if not hn:
        raise RuntimeError(f"no hospitals found for {region}")
    times = drive_times(net, feats, hn, ha)
    pop = dm._read("population", region)
    rows: dict = {}
    for code, p in zip(pop.codes, pop.columns["population"]):
        if not p or not p > 0:          # nodata/negative population pixels
            continue
        b = digipin.decode_partial(code)["bounds"]
        x, y = (b["west"] + b["east"]) / 2, (b["south"] + b["north"]) / 2
        node, d = snap.nearest(x, y)
        if node < 0:
            continue
        acc = access_min(d)
        vals = {k: float(v[node]) + acc for k, v in times.items()}
        if not all(np.isfinite(v) for v in vals.values()):
            continue
        rows[code[:LEVEL]] = {
            "hospital_min_night": round(vals["night"], 1), "hospital_min_am": round(vals["am"], 1),
            "hospital_min_pm": round(vals["pm"], 1),
            "rush_delay_min": round(max(vals["am"], vals["pm"]) - vals["night"], 1),
            "_pop": p,
        }
    for code, c in counts.items():
        r = rows.setdefault(code, {"_pop": 0})
        r.update(c)
    return rows, len(hn)


def summarise(rows, n_hosp):
    def share(pred):
        tot = sum(r["_pop"] for r in rows.values() if "hospital_min_am" in r) or 1
        return round(100 * sum(r["_pop"] for r in rows.values() if "hospital_min_am" in r and pred(r)) / tot, 1)
    return {
        "hospitals": n_hosp,
        "pct_within_10_night": share(lambda r: r["hospital_min_night"] <= GOLDEN_MIN),
        "pct_within_10_am": share(lambda r: r["hospital_min_am"] <= GOLDEN_MIN),
        "pct_within_10_pm": share(lambda r: r["hospital_min_pm"] <= GOLDEN_MIN),
        "pct_over_20_peak": share(lambda r: max(r["hospital_min_am"], r["hospital_min_pm"]) > 20),
        "source": f"Overture Maps places {OVERTURE_RELEASE}; demand model link times",
    }


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("hospital_min_am", "Drive to the nearest hospital at 09:00", agg="mean", unit="min",
                  domain=[0, 30], ramp="heat", higher_is="worse"),
        FieldSpec("hospital_min_pm", "Drive to the nearest hospital at 18:00", agg="mean", unit="min",
                  domain=[0, 30], ramp="heat", higher_is="worse"),
        FieldSpec("hospital_min_night", "Drive to the nearest hospital at 03:00", agg="mean", unit="min",
                  domain=[0, 30], ramp="heat", higher_is="worse"),
        FieldSpec("rush_delay_min", "Extra minutes to hospital in the worse peak", agg="mean", unit="min",
                  domain=[0, 15], ramp="reds", higher_is="worse"),
        FieldSpec("hospitals", "Hospitals (Overture places)", agg="sum", unit="places", ramp="viridis",
                  higher_is="better"),
        FieldSpec("schools", "Schools (Overture places)", agg="sum", unit="places", ramp="viridis",
                  higher_is="better"),
    ]
    spec = DatasetSpec(
        id="emergency_access", title="Hospital access by time of day", level=LEVEL, fields=specs,
        group="Traffic & mobility",
        description="Drive time from each home cell to the nearest hospital at 03:00 (free flow), 09:00 and "
                    "18:00, on the arterial network with the demand model's congestion (BPR at each road's "
                    "modelled V/C). Hospitals and schools are Overture Maps places (confidence ≥ 0.6). "
                    "General-traffic speed, arterials only, no bed or emergency-ward data.",
        source=f"pipeline/traffic/emergency_access.py over Overture Maps places {OVERTURE_RELEASE} + "
               "data/traffic road_los.geojson",
        license="CDLA-Permissive-2.0 / ODbL (Overture) + ODbL (OpenStreetMap)",
        default_field="hospital_min_am", extrude=False)
    clean = ({"digipin": c, **{k: v for k, v in r.items() if not k.startswith("_")}} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, log=print):
    rows, n_hosp = compute(region, log)
    res = cell_dataset(region, rows)
    summ = REPO / "data" / "traffic" / region / "summary.json"
    s = json.loads(summ.read_text()) if summ.exists() else {}
    s["emergency_access"] = summarise(rows, n_hosp)
    summ.write_text(json.dumps(s, indent=2) + "\n")
    log(f"{region}: {json.dumps(s['emergency_access'])}")
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    p.add_argument("--refresh", action="store_true", help="re-download facilities from Overture")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        if a.refresh:
            fetch_facilities(r)
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
