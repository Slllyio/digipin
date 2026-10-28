"""Heat and shade at bus stops: where people wait in the sun, and which stops need a shelter or trees first.

Bus stops come from three open sources, merged within MERGE_M:

    OpenStreetMap   highway=bus_stop via Overpass (CI runners; skipped quietly
                    where Overpass is blocked)
    GTFS            stops.txt of the open feeds in gtfs_cells.FEEDS (BMTC,
                    TGSRTC, MTC, PMPML, AMTS/BRTS, BEST; Delhi once its key is set)
    Overture Maps   places tagged bus_station / public_transit_facility_or_service

Each stop takes the daytime land surface temperature (surface_heat.lst_day_c,
Landsat summer composite) and tree canopy (vegetation.tree_canopy_pct) of its
L7 cell, and the residents of that cell and its eight neighbours (about a
5-minute walk) as the people likely to wait there. A stop is "hot and bare"
at HOT_C+ surface temperature with under BARE_PCT canopy. Its shelter priority
is waiting residents × degrees above COMFORT_C × the unshaded share. Per L7
cell (dataset ``bus_stop_heat``):

    stops            bus stops in the cell
    hot_bare_stops   … hot and bare
    stop_lst_c       mean surface temperature at those stops
    stop_canopy_pct  mean canopy at those stops
    shelter_priority highest stop priority in the cell (resident-degrees)

data/vectors/bus_stops_<region>.geojson keeps the stop points; summary.json
``bus_stop_heat`` has the share of stops and riders in the sun and the top
stops. Surface temperature is not air temperature, and canopy at 30 m misses
a single tree or a shelter roof, so read it as screening, not an audit.

    python -m pipeline.traffic.bus_stop_heat --region delhi [--refresh]
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.traffic import demand_model as dm
from pipeline.traffic import gtfs_cells
from pipeline.traffic.ev_charging import OVERPASS_URL, OVERTURE_RELEASE, dedupe

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
VECTORS = REPO / "data" / "vectors"
LEVEL = 7
MERGE_M = 30.0
HOT_C = 40.0                   # daytime surface temperature that marks a hot stop
BARE_PCT = 10.0                # tree canopy below this counts as unshaded
COMFORT_C = 35.0               # degrees above this drive the priority
MIN_CONF = 0.4
CATS = ("bus_station", "public_transit_facility_or_service")
TOP = 10


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def hot_bare(lst, canopy):
    """True when a stop is at HOT_C+ and under BARE_PCT canopy (None when unknown)."""
    if lst is None or canopy is None:
        return None
    return lst >= HOT_C and canopy < BARE_PCT


def priority(people, lst, canopy):
    """Waiting residents × degrees above COMFORT_C × unshaded share. Pure."""
    if lst is None or canopy is None or not people:
        return 0.0
    return people * max(0.0, lst - COMFORT_C) * max(0.0, 1 - canopy / 100)


def neighbours(code):
    """The L-level cell and its eight neighbours (codes)."""
    ix = digipin.to_index(code)
    out = []
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            c = digipin.from_index(ix["level"], ix["row"] + dr, ix["col"] + dc)
            if c:
                out.append(c)
    return out


# ── sources ─────────────────────────────────────────────────────────────────

def osm(region, log=print):
    import urllib.parse
    import urllib.request
    w, s, e, n = bbox_for(region)
    q = f'[out:json][timeout:180];node["highway"="bus_stop"]({s},{w},{n},{e});out;'
    try:
        req = urllib.request.Request(OVERPASS_URL, data=urllib.parse.urlencode({"data": q}).encode(),
                                     headers={"User-Agent": "digipin-bus-stops"})
        with urllib.request.urlopen(req, timeout=200) as r:
            els = json.loads(r.read())["elements"]
    except Exception as ex:                       # blocked sandbox, rate limit…
        log(f"{region}: OSM bus stops skipped ({type(ex).__name__})")
        return []
    return [(el["lon"], el["lat"], "stop", (el.get("tags") or {}).get("name", ""), "osm") for el in els]


def gtfs(region, log=print):
    try:
        path = gtfs_cells.fetch(region, log)
        if not path:
            return []
        stops, _ = gtfs_cells.read_feed(path, log)
    except Exception as ex:
        log(f"{region}: GTFS stops skipped ({type(ex).__name__})")
        return []
    w, s, e, n = bbox_for(region)
    return [(lon, lat, "stop", "", "gtfs") for lat, lon in stops.values() if w <= lon <= e and s <= lat <= n]


def overture(region, release=OVERTURE_RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    rows = con.execute(f"""
        SELECT names.primary, (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}
          AND confidence >= {MIN_CONF} AND taxonomy.primary IN {CATS}
    """).fetchall()
    return [(x, y, "stop", nm or "", "overture") for nm, x, y in rows]


def fetch(region, log=print):
    pts = dedupe(osm(region, log) + gtfs(region, log) + overture(region), within=MERGE_M)
    gj = {"type": "FeatureCollection",
          "source": f"OpenStreetMap highway=bus_stop; open GTFS stops; Overture Maps places {OVERTURE_RELEASE}",
          "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(x, 6), round(y, 6)]},
                        "properties": {"name": nm, "src": src}} for x, y, _, nm, src in pts]}
    VECTORS.mkdir(parents=True, exist_ok=True)
    (VECTORS / f"bus_stops_{region}.geojson").write_text(json.dumps(gj, separators=(",", ":"), ensure_ascii=False))
    log(f"{region}: {dict(Counter(p[4] for p in pts))}")
    return gj


def load(region, refresh=False, log=print):
    p = VECTORS / f"bus_stops_{region}.geojson"
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    return fetch(region, log)


# ── cells ───────────────────────────────────────────────────────────────────

def _col(ds, field, region):
    t = dm._read(ds, region)
    if t is None or field not in t.columns:
        return {}
    return {c: v for c, v in zip(t.codes, t.columns[field]) if v is not None}


def compute(region, refresh=False, log=print):
    gj = load(region, refresh, log)
    lst = _col("surface_heat", "lst_day_c", region)
    can = _col("vegetation", "tree_canopy_pct", region)
    pop = _col("population", "population", region)
    rows: dict = {}
    stops = []
    for f in gj["features"]:
        x, y = f["geometry"]["coordinates"]
        try:
            c = digipin.encode(y, x).replace("-", "")[:LEVEL]
        except Exception:
            continue
        people = sum(pop.get(k, 0) or 0 for k in neighbours(c))
        t, cv = lst.get(c), can.get(c)
        hb, pr = hot_bare(t, cv), priority(people, t, cv)
        stops.append((c, f["properties"].get("name") or "", x, y, people, t, cv, hb, pr))
        r = rows.setdefault(c, {"stops": 0, "hot_bare_stops": 0, "_t": [], "_c": [], "shelter_priority": 0})
        r["stops"] += 1
        r["hot_bare_stops"] += 1 if hb else 0
        if t is not None:
            r["_t"].append(t)
        if cv is not None:
            r["_c"].append(cv)
        r["shelter_priority"] = max(r["shelter_priority"], round(pr))
    for r in rows.values():
        ts, cs = r.pop("_t"), r.pop("_c")
        if ts:
            r["stop_lst_c"] = round(sum(ts) / len(ts), 1)
        if cs:
            r["stop_canopy_pct"] = round(sum(cs) / len(cs), 1)
    known = [s for s in stops if s[7] is not None]
    riders = sum(s[4] for s in known) or 1
    top = sorted(stops, key=lambda s: -s[8])[:TOP]
    summ = {"stops": len(stops), "stops_with_heat_data": len(known),
            "pct_hot_bare": round(100 * sum(1 for s in known if s[7]) / (len(known) or 1), 1),
            "pct_riders_at_hot_bare": round(100 * sum(s[4] for s in known if s[7]) / riders, 1),
            "median_stop_lst_c": round(sorted(s[5] for s in known)[len(known) // 2], 1) if known else None,
            "top_stops": [{"digipin": s[0], "name": s[1], "lon": round(s[2], 5), "lat": round(s[3], 5),
                           "residents_5min": round(s[4]), "lst_c": s[5], "canopy_pct": s[6], "priority": round(s[8])}
                          for s in top if s[8] > 0],
            "thresholds": {"hot_c": HOT_C, "bare_canopy_pct": BARE_PCT, "comfort_c": COMFORT_C},
            "sources": dict(Counter(f["properties"].get("src", "") for f in gj["features"]))}
    log(f"{region}: {json.dumps({k: v for k, v in summ.items() if k != 'top_stops'})}")
    return rows, summ


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("stops", "Bus stops", agg="sum", unit="stops", ramp="viridis"),
        FieldSpec("hot_bare_stops", f"Bus stops at {int(HOT_C)}+ °C surface with under {int(BARE_PCT)}% tree canopy",
                  agg="sum", unit="stops", ramp="reds", higher_is="worse"),
        FieldSpec("stop_lst_c", "Daytime surface temperature at the stops", agg="mean", unit="°C",
                  domain=[30, 50], ramp="heat", higher_is="worse"),
        FieldSpec("stop_canopy_pct", "Tree canopy at the stops", agg="mean", unit="%", domain=[0, 40],
                  ramp="greens", higher_is="better"),
        FieldSpec("shelter_priority", "Shelter / tree priority (waiting residents × heat × no shade)", agg="max",
                  unit="score", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="bus_stop_heat", title="Heat and shade at bus stops", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Bus stops from OpenStreetMap, open GTFS feeds and Overture Maps places, each with the daytime "
                    "land surface temperature and tree canopy of its cell and the residents within about a 5-minute "
                    f"walk. Hot and bare: {int(HOT_C)}+ °C surface with under {int(BARE_PCT)}% canopy. Priority = "
                    f"residents × degrees above {int(COMFORT_C)} °C × unshaded share. Surface temperature is not air "
                    "temperature, and 30 m canopy misses single trees and shelter roofs.",
        source="pipeline/traffic/bus_stop_heat.py over bus stops + surface_heat + vegetation + population",
        license="ODbL (OpenStreetMap, BMTC GTFS) + CDLA-Permissive-2.0 (Overture places) + derived EE layers",
        default_field="shelter_priority", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, refresh=False, log=print):
    rows, summ = compute(region, refresh, log)
    if not rows:
        log(f"{region}: no bus stops, skipped")
        return None
    res = cell_dataset(region, rows)
    sp = REPO / "data" / "traffic" / region / "summary.json"
    if sp.parent.exists():
        s = json.loads(sp.read_text()) if sp.exists() else {}
        s["bus_stop_heat"] = summ
        sp.write_text(json.dumps(s, indent=2) + "\n")
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    p.add_argument("--refresh", action="store_true", help="re-fetch the stops")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r, a.refresh)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
