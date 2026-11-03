"""EV charging: where chargers are, and where traffic has none nearby.

Charger points come from every open source reachable at bake time, merged
within 60 m:

    Overture Maps places   ev_charging_station (always; read from public S3)
    OpenStreetMap          amenity=charging_station via Overpass (CI runners;
                           skipped quietly where Overpass is blocked)
    Open Charge Map        when OCM_API_KEY is set (free key)

Overture parking and fuel-station places are kept too: they are where a
charger is cheapest to add. Output:

    data/vectors/ev_places_<region>.geojson  points {kind: charger|parking|fuel, name, src}
    cell dataset ``ev_charging`` (L7):
        charger_km   straight-line km to the nearest known charger (populated or
                     trafficked cells)
        chargers / parking / fuel   places in the cell
    summary.json ``ev_charging`` block: chargers by source, per lakh residents,
    share of arterial vehicle-km within 2 km of a charger.

    python -m pipeline.traffic.ev_charging --region delhi --refresh
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
VECTORS = REPO / "data" / "vectors"
LEVEL = 7
OVERTURE_RELEASE = "2026-10-21.0"
MIN_CONF = 0.5
MERGE_M = 60.0
NEAR_KM = 2.0
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
CATS = {"ev_charging_station": "charger", "parking": "parking", "gas_station": "fuel", "fueling_station": "fuel"}


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def dedupe(points, within=MERGE_M):
    """[(x, y, kind, name, src)] → same, dropping a point within `within` m of an
    earlier one of the same kind (sources listed first win)."""
    out, grid, g = [], {}, 0.001
    for p in points:
        x, y, kind = p[0], p[1], p[2]
        gx, gy = int(x / g), int(y / g)
        dup = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in grid.get((gx + dx, gy + dy, kind), ()):
                    if dm.haversine_m(x, y, q[0], q[1]) <= within:
                        dup = True
                        break
        if not dup:
            out.append(p)
            grid.setdefault((gx, gy, kind), []).append(p)
    return out


class NearestKm:
    """Nearest-point distance (km) on a coarse grid, widening rings until found."""

    def __init__(self, pts, g=0.02):
        self.g, self.grid = g, {}
        for x, y in pts:
            self.grid.setdefault((int(x / g), int(y / g)), []).append((x, y))
        self.empty = not pts

    def __call__(self, x, y, max_rings=40):
        if self.empty:
            return None
        gx, gy, best = int(x / self.g), int(y / self.g), float("inf")
        for r in range(0, max_rings):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    if max(abs(dx), abs(dy)) != r:
                        continue
                    for a, b in self.grid.get((gx + dx, gy + dy), ()):
                        best = min(best, dm.haversine_m(x, y, a, b))
            # a ring of r cells guarantees anything closer than r·g has been seen
            if best < float("inf") and best / 1000 <= r * self.g * 95:
                return best / 1000
        return best / 1000 if best < float("inf") else None


# ── sources ─────────────────────────────────────────────────────────────────

def overture(region, release=OVERTURE_RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    rows = con.execute(f"""
        SELECT names.primary, coalesce(taxonomy.primary, basic_category),
               (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}
          AND confidence >= {MIN_CONF}
          AND (taxonomy.primary IN {tuple(CATS)} OR basic_category IN {tuple(CATS)})
    """).fetchall()
    return [(x, y, CATS[c], nm or "", "overture") for nm, c, x, y in rows if c in CATS]


def osm(region, log=print):
    import urllib.parse
    import urllib.request
    w, s, e, n = bbox_for(region)
    q = f'[out:json][timeout:120];node["amenity"="charging_station"]({s},{w},{n},{e});out;'
    try:
        req = urllib.request.Request(OVERPASS_URL, data=urllib.parse.urlencode({"data": q}).encode(),
                                     headers={"User-Agent": "digipin-ev-charging"})
        with urllib.request.urlopen(req, timeout=150) as r:
            els = json.loads(r.read())["elements"]
    except Exception as ex:                       # blocked sandbox, rate limit…
        log(f"{region}: OSM chargers skipped ({type(ex).__name__})")
        return []
    return [(el["lon"], el["lat"], "charger", (el.get("tags") or {}).get("name", ""), "osm") for el in els]


def ocm(region, log=print):
    key = os.environ.get("OCM_API_KEY", "")
    if not key:
        return []
    import urllib.request
    w, s, e, n = bbox_for(region)
    url = (f"https://api.openchargemap.io/v3/poi/?output=json&compact=true&verbose=false&maxresults=10000"
           f"&boundingbox=({n},{w}),({s},{e})&key={key}")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "digipin"}), timeout=120) as r:
            pois = json.loads(r.read())
    except Exception as ex:
        log(f"{region}: Open Charge Map skipped ({type(ex).__name__})")
        return []
    out = []
    for p in pois:
        a = p.get("AddressInfo") or {}
        if a.get("Longitude") is not None:
            out.append((a["Longitude"], a["Latitude"], "charger", a.get("Title") or "", "ocm"))
    return out


def fetch(region, log=print):
    pts = osm(region, log) + ocm(region, log) + overture(region)
    pts = dedupe(pts)
    gj = {"type": "FeatureCollection",
          "source": f"OpenStreetMap; Open Charge Map (if keyed); Overture Maps places {OVERTURE_RELEASE}",
          "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(x, 6), round(y, 6)]},
                        "properties": {"kind": k, "name": nm, "src": src}} for x, y, k, nm, src in pts]}
    out = VECTORS / f"ev_places_{region}.geojson"
    out.write_text(json.dumps(gj, separators=(",", ":"), ensure_ascii=False))
    by = {}
    for *_, k, _, src in pts:
        by[f"{k}:{src}"] = by.get(f"{k}:{src}", 0) + 1
    log(f"{region}: {json.dumps(by)}")
    return gj


def load(region, refresh=False, log=print):
    p = VECTORS / f"ev_places_{region}.geojson"
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    return fetch(region, log)


# ── cells ───────────────────────────────────────────────────────────────────

def compute(region, log=print):
    gj = load(region, log=log)
    pts = [(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1], f["properties"]["kind"],
            f["properties"].get("src", "")) for f in gj["features"]]
    near = NearestKm([(x, y) for x, y, k, _ in pts if k == "charger"])
    pop = dm._read("population", region)
    rows: dict = {}
    for code, p in zip(pop.codes, pop.columns["population"]):
        if p and p > 0:
            rows[code[:LEVEL]] = {"_pop": p, "_vkm": 0.0}
    try:
        tl = dm._read("traffic_load", region)
        vk = tl.columns.get("daily_vkm")
        if vk is not None:
            for code, v in zip(tl.codes, vk):
                if v and v > 0:
                    rows.setdefault(code[:LEVEL], {"_pop": 0})["_vkm"] = float(v)
    except Exception:
        pass
    for code, r in rows.items():
        b = digipin.decode_partial(code)["bounds"]
        d = near((b["west"] + b["east"]) / 2, (b["south"] + b["north"]) / 2)
        if d is not None:
            r["charger_km"] = round(d, 2)
    for x, y, k, _ in pts:
        try:
            code = digipin.encode(y, x).replace("-", "")[:LEVEL]
        except Exception:
            continue
        r = rows.setdefault(code, {"_pop": 0})
        key = {"charger": "chargers", "parking": "parking", "fuel": "fuel"}[k]
        r[key] = r.get(key, 0) + 1
    return rows, pts


def summarise(rows, pts):
    pop = sum(r.get("_pop", 0) for r in rows.values()) or 1
    vkm = sum(r.get("_vkm", 0) for r in rows.values()) or 1
    ch = [p for p in pts if p[2] == "charger"]
    near_vkm = sum(r.get("_vkm", 0) for r in rows.values() if r.get("charger_km", 1e9) <= NEAR_KM)
    near_pop = sum(r.get("_pop", 0) for r in rows.values() if r.get("charger_km", 1e9) <= NEAR_KM)
    src = {}
    for p in ch:
        src[p[3]] = src.get(p[3], 0) + 1
    return {"chargers": len(ch), "chargers_by_source": src,
            "parking": sum(p[2] == "parking" for p in pts), "fuel": sum(p[2] == "fuel" for p in pts),
            "chargers_per_lakh": round(len(ch) / pop * 1e5, 2),
            "pct_vkm_within_2km": round(100 * near_vkm / vkm, 1), "pct_pop_within_2km": round(100 * near_pop / pop, 1)}


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("charger_km", "Distance to the nearest known EV charger", agg="mean", unit="km",
                  domain=[0, 10], ramp="heat", higher_is="worse"),
        FieldSpec("chargers", "EV charging points (known)", agg="sum", unit="sites", ramp="viridis", higher_is="better"),
        FieldSpec("parking", "Parking places", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("fuel", "Fuel stations", agg="sum", unit="stations", ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="ev_charging", title="EV charging (known sites)", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Known public EV charging sites (OpenStreetMap, Overture Maps, and Open Charge Map when keyed), "
                    "with parking and fuel stations as low-cost places to add chargers. Open data lists only part "
                    "of India's chargers, so distance-to-charger is an upper bound.",
        source=f"pipeline/traffic/ev_charging.py over OSM / Overture Maps {OVERTURE_RELEASE} / Open Charge Map",
        license="ODbL (OpenStreetMap) + CDLA-Permissive-2.0 (Overture) + CC BY 4.0 (Open Charge Map)",
        default_field="charger_km", extrude=False)
    clean = ({"digipin": c, **{k: v for k, v in r.items() if not k.startswith("_")}} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, refresh=False, log=print):
    if refresh:
        fetch(region, log)
    rows, pts = compute(region, log)
    res = cell_dataset(region, rows)
    summ = REPO / "data" / "traffic" / region / "summary.json"
    s = json.loads(summ.read_text()) if summ.exists() else {}
    s["ev_charging"] = summarise(rows, pts)
    summ.write_text(json.dumps(s, indent=2) + "\n")
    log(f"{region}: {json.dumps(s['ev_charging'])}")
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    p.add_argument("--refresh", action="store_true", help="re-query the sources")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r, a.refresh)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
