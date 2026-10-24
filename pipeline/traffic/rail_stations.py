"""Metro and suburban-rail stations, and how far each home is from one.

Stations are Overture Maps places tagged train_station / metro_station plus
OpenStreetMap station points (data/vectors/osm_transit_<region>.geojson). Each
is classed by the nearest Overture rail segment within SNAP_M:

    metro   subway, light_rail, monorail or tram track (Delhi Metro, Namma Metro,
            Mumbai Metro lines are railway=subway in OSM)
    rail    standard or narrow gauge (Mumbai locals, Chennai MRTS/suburban,
            Kolkata suburban); a point with no track nearby is dropped

Stations of the same class within MERGE_M merge into one. Outputs:

    data/vectors/rail_stations_<region>.geojson   points {kind, name}
    cell dataset ``rail_access`` (L7, populated cells):
        metro_walk_min   walk to the nearest metro station (straight line × 1.3
                         detour at 4.8 km/h)
        rail_walk_min    the same for any station, metro or rail
        metro_stations / rail_stations   stations in the cell
    summary.json ``rail_access`` block: residents within a 10-minute walk.

    python -m pipeline.traffic.rail_stations --region delhi
    python -m pipeline.traffic.rail_stations --region all --refresh   # re-query Overture
"""
from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
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
SNAP_M = 250.0
MERGE_M = 250.0
WALK_M_PER_MIN = 80.0          # 4.8 km/h
DETOUR = 1.3
CATCH_MIN = 10.0
METRO_CLASSES = ("subway", "light_rail", "monorail", "tram")
RAIL_CLASSES = ("standard_gauge", "narrow_gauge", "unknown")
STATION_CATS = ("train_station", "metro_station")


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def walk_min(dist_m):
    return dist_m * DETOUR / WALK_M_PER_MIN


def _seg_dist_m(px, py, ax, ay, bx, by):
    """Metres from point P to segment AB (equirectangular, fine at city scale)."""
    k = math.cos(math.radians(py)) * 111320.0
    x, y = (px - ax) * k, (py - ay) * 110540.0
    dx, dy = (bx - ax) * k, (by - ay) * 110540.0
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, (x * dx + y * dy) / L))
    return math.hypot(x - t * dx, y - t * dy)


class TrackIndex:
    """Nearest rail class to a point, via a coarse grid over segment pieces."""

    def __init__(self, lines, g=0.005):
        self.g, self.grid = g, {}
        for cls, coords in lines:
            for (ax, ay), (bx, by) in zip(coords, coords[1:]):
                for gx in range(int(min(ax, bx) / g), int(max(ax, bx) / g) + 1):
                    for gy in range(int(min(ay, by) / g), int(max(ay, by) / g) + 1):
                        self.grid.setdefault((gx, gy), []).append((cls, ax, ay, bx, by))

    def nearest(self, x, y, within=SNAP_M):
        gx, gy, best, cls = int(x / self.g), int(y / self.g), within, None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for c, ax, ay, bx, by in self.grid.get((gx + dx, gy + dy), ()):
                    d = _seg_dist_m(x, y, ax, ay, bx, by)
                    if d <= best:
                        best, cls = d, c
        return cls, best


STATION_WORDS = re.compile(r"\b(station|stn|metro|railway|rly|junction|jn|halt|terminus|cantt?)\b|स्टेशन|मेट्रो", re.I)
METRO_WORDS = re.compile(r"\bmetro\b|मेट्रो", re.I)
RAIL_WORDS = re.compile(r"\b(railway|rly|junction|jn|halt|terminus)\b|रेलवे", re.I)
NOT_STATION = re.compile(r"\b(cafe|café|restaurant|market|quarters|depot|rest house|reservation|parking|pillar|"
                         r"services|store|shop|office|colony|flyover|cabin|mall|hotel|bridge road|bypass)\b", re.I)
GATE = re.compile(r"[\s,(-]*(gate|exit|entry|entrance|गेट)\b.*$", re.I)


def is_station_name(name, from_osm=False):
    """Overture's train_station places include cafés and depots; keep real station names."""
    if not name:
        return from_osm
    if NOT_STATION.search(name):
        return False
    return from_osm or bool(STATION_WORDS.search(name))


def kind_for(track_class, name=""):
    """metro | rail | None from the nearest track class, with the name breaking ties."""
    if track_class is None:
        return None
    if METRO_WORDS.search(name or ""):
        return "metro"
    if RAIL_WORDS.search(name or "") and track_class in RAIL_CLASSES:
        return "rail"
    if track_class in METRO_CLASSES:
        return "metro"
    if track_class in RAIL_CLASSES:
        return "rail"
    return None


def name_key(name):
    """'Saket Metro Station-Gate No 2' → 'saket' for merging entrances of one station."""
    n = GATE.sub("", (name or "").lower())
    n = re.sub(r"\b(metro|railway|rly|rail|station|stn|junction|jn|halt|main|new delhi|delhi)\b|मेट्रो|रेलवे|स्टेशन", " ", n)
    return " ".join(re.sub(r"[^\w\s]", " ", n).split())


def merge_stations(points, within=MERGE_M):
    """Greedy merge of same-kind points closer than `within` metres.

    points: [(x, y, kind, name)] → [(x, y, kind, name)] with mean positions and
    the most common non-empty name.
    """
    out: list = []
    for x, y, kind, name in points:
        key = name_key(name)
        for s in out:
            if s["kind"] != kind:
                continue
            d = dm.haversine_m(x, y, s["x"], s["y"])
            if d <= within or (key and key in s["keys"] and d <= 3 * within):
                s["pts"].append((x, y))
                s["x"] = sum(p[0] for p in s["pts"]) / len(s["pts"])
                s["y"] = sum(p[1] for p in s["pts"]) / len(s["pts"])
                if name:
                    s["names"][GATE.sub("", name).strip() or name] += 1
                if key:
                    s["keys"].add(key)
                break
        else:
            out.append({"x": x, "y": y, "kind": kind, "pts": [(x, y)], "keys": {key} if key else set(),
                        "names": Counter([GATE.sub("", name).strip() or name] if name else [])})
    return [(s["x"], s["y"], s["kind"], s["names"].most_common(1)[0][0] if s["names"] else "") for s in out]


# ── IO ──────────────────────────────────────────────────────────────────────

def fetch(region, release=OVERTURE_RELEASE, log=print):
    """Overture station places + rail track → data/vectors/rail_stations_<region>.geojson."""
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    base = f"s3://overturemaps-us-west-2/release/{release}"
    places = con.execute(f"""
        SELECT names.primary, (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
        FROM read_parquet('{base}/theme=places/type=place/*')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}
          AND confidence >= {MIN_CONF} AND taxonomy.primary IN {STATION_CATS}
    """).fetchall()
    tracks = con.execute(f"""
        SELECT class, ST_AsText(geometry)
        FROM read_parquet('{base}/theme=transportation/type=segment/*')
        WHERE subtype = 'rail' AND bbox.xmin <= {e} AND bbox.xmax >= {w}
          AND bbox.ymin <= {n} AND bbox.ymax >= {s}
          AND class IN {METRO_CLASSES + RAIL_CLASSES}
    """).fetchall() if _has_spatial(con) else []
    lines = []
    for cls, wkt in tracks:
        if wkt and wkt.startswith("LINESTRING"):
            pts = [tuple(map(float, p.split())) for p in wkt[wkt.index("(") + 1:-1].split(",")]
            lines.append((cls, pts))
    pts = [(x, y, nm or "") for nm, x, y in places if is_station_name(nm)]
    osm = VECTORS / f"osm_transit_{region}.geojson"
    if osm.exists():
        for f in json.loads(osm.read_text())["features"]:
            p = f["properties"]
            if p.get("kind") == "station" and f["geometry"]["type"] == "Point" \
                    and is_station_name(p.get("name"), from_osm=True):
                x, y = f["geometry"]["coordinates"][:2]
                pts.append((x, y, p.get("name") or ""))
    idx = TrackIndex(lines)
    classed = []
    for x, y, nm in pts:
        k = kind_for(idx.nearest(x, y)[0], nm)
        if k:
            classed.append((x, y, k, nm))
    st = merge_stations(classed)
    gj = {"type": "FeatureCollection", "source": f"Overture Maps places + transportation {release}; OpenStreetMap",
          "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(x, 6), round(y, 6)]},
                        "properties": {"kind": k, "name": nm}} for x, y, k, nm in st]}
    out = VECTORS / f"rail_stations_{region}.geojson"
    out.write_text(json.dumps(gj, separators=(",", ":"), ensure_ascii=False))
    log(f"{region}: {len(lines)} track pieces, {len(pts)} station points → "
        f"{sum(k == 'metro' for *_, k, _ in st)} metro + {sum(k == 'rail' for *_, k, _ in st)} rail stations")
    return gj


def _has_spatial(con):
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        return True
    except Exception:
        return False


def load(region, refresh=False, log=print):
    p = VECTORS / f"rail_stations_{region}.geojson"
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    return fetch(region, log=log)


def compute(region, log=print):
    gj = load(region, log=log)
    st = [(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1], f["properties"]["kind"])
          for f in gj["features"]]
    if not st:
        return {}, gj
    metro = [(x, y) for x, y, k in st if k == "metro"]
    allst = [(x, y) for x, y, _ in st]
    pop = dm._read("population", region)
    rows: dict = {}

    def nearest(pts, x, y):
        return min(dm.haversine_m(x, y, a, b) for a, b in pts)

    for code, p in zip(pop.codes, pop.columns["population"]):
        if not p or not p > 0:
            continue
        b = digipin.decode_partial(code)["bounds"]
        x, y = (b["west"] + b["east"]) / 2, (b["south"] + b["north"]) / 2
        r = {"rail_walk_min": round(walk_min(nearest(allst, x, y)), 1), "_pop": p}
        if metro:
            r["metro_walk_min"] = round(walk_min(nearest(metro, x, y)), 1)
        rows[code[:LEVEL]] = r
    for x, y, k in st:
        try:
            code = digipin.encode(y, x).replace("-", "")[:LEVEL]
        except Exception:
            continue
        r = rows.setdefault(code, {"_pop": 0})
        key = "metro_stations" if k == "metro" else "rail_stations"
        r[key] = r.get(key, 0) + 1
    return rows, gj


def summarise(rows, gj):
    tot = sum(r["_pop"] for r in rows.values()) or 1
    share = lambda k: round(100 * sum(r["_pop"] for r in rows.values() if r.get(k, 1e9) <= CATCH_MIN) / tot, 1)
    kinds = Counter(f["properties"]["kind"] for f in gj["features"])
    return {"metro_stations": kinds.get("metro", 0), "rail_stations": kinds.get("rail", 0),
            "pct_within_10_walk_metro": share("metro_walk_min"), "pct_within_10_walk_any": share("rail_walk_min"),
            "source": f"Overture Maps {OVERTURE_RELEASE} + OpenStreetMap"}


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("metro_walk_min", "Walk to the nearest metro station", agg="mean", unit="min",
                  domain=[0, 40], ramp="heat", higher_is="worse"),
        FieldSpec("rail_walk_min", "Walk to the nearest metro or rail station", agg="mean", unit="min",
                  domain=[0, 40], ramp="heat", higher_is="worse"),
        FieldSpec("metro_stations", "Metro stations", agg="sum", unit="stations", ramp="viridis", higher_is="better"),
        FieldSpec("rail_stations", "Suburban rail stations", agg="sum", unit="stations", ramp="viridis",
                  higher_is="better"),
    ]
    spec = DatasetSpec(
        id="rail_access", title="Metro & rail station access", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Walking time from each home cell to the nearest metro station and to any metro or suburban "
                    "rail station (straight line × 1.3 at 4.8 km/h). Stations are Overture Maps and OpenStreetMap "
                    "station points classed by the nearest Overture rail track (subway/light rail/monorail = metro).",
        source=f"pipeline/traffic/rail_stations.py over Overture Maps {OVERTURE_RELEASE} + OpenStreetMap",
        license="CDLA-Permissive-2.0 / ODbL (Overture) + ODbL (OpenStreetMap)",
        default_field="metro_walk_min", extrude=False)
    clean = ({"digipin": c, **{k: v for k, v in r.items() if not k.startswith("_")}} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, refresh=False, log=print):
    if refresh:
        fetch(region, log=log)
    rows, gj = compute(region, log)
    if not rows:
        log(f"{region}: no stations, skipped")
        return None
    res = cell_dataset(region, rows)
    summ = REPO / "data" / "traffic" / region / "summary.json"
    s = json.loads(summ.read_text()) if summ.exists() else {}
    s["rail_access"] = summarise(rows, gj)
    summ.write_text(json.dumps(s, indent=2) + "\n")
    log(f"{region}: {json.dumps(s['rail_access'])}")
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
