"""Parking pressure: where more cars and two-wheelers arrive than the kerbs and lots can hold.

Demand per L7 cell is the demand model's trip attraction (GHSL non-residential
floor space + OSM amenities, as in dm.zones): the city's motorised trips
(TRIPS_PER_CAPITA × residents, half of them ending away from home) shared out
by each cell's attraction, turned into private vehicles with the model's mode
split (cars 15% at 1.6 people, two-wheelers 40% at 1.2) and into equivalent
car spaces (ECS; a two-wheeler takes TWO_WHEELER_ECS). ACCUMULATION of them are
parked at once at the late-morning peak.

Supply is kerb on local and secondary streets (osm_roads km/km² × cell area,
both sides, a car space every BAY_M, USABLE share left after junctions,
driveways, bus stops and no-parking stretches) plus mapped parking lots
(Overture places, LOT_ECS each). Where the corporation publishes its own lots
with capacities (BMC's public parking lots, Mumbai; ``--official`` refreshes
data/vectors/parking_lots_official_{region}.geojson) a block takes the larger
of the official capacity and the mapped-lot estimate. Main roads are left out. Per L7 cell
(dataset ``parking``):

    demand_ecs   vehicles parked at the late-morning peak, in car spaces
    supply_ecs   kerb + lot spaces
    lots         mapped parking lots
    pressure     demand / supply (above 1: vehicles spill onto footpaths,
                 main roads or double-park)

summary.json ``parking``: share of demand in overflowing cells, top hotspots.
Indicative: no parking surveys, permits or occupancy counts.

    python -m pipeline.traffic.parking --region delhi
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
VECTORS = REPO / "data" / "vectors"
LEVEL = 7
AWAY_SHARE = 0.5               # trips that end somewhere other than home
CAR_PER_TRIP = 0.15 / 1.6      # mode share / occupancy (demand_model.PCU_PER_TRIP mix)
TW_PER_TRIP = 0.40 / 1.2
TWO_WHEELER_ECS = 0.25         # IRC SP 12: a two-wheeler bay is about a quarter of a car bay
ACCUMULATION = 0.6             # share of the day's arriving vehicles parked at once (work + errands)
BAY_M = 5.5
USABLE = 0.4
LOT_ECS = 40.0
OFFICIAL = {"mumbai": ("mumbai-parking", "Mumbai Parking Lots")}   # OpenCity dataset, resource (public domain)
MIN_DEMAND = 20.0
TOP = 10


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def ecs_per_trip():
    """Equivalent car spaces per motorised trip end."""
    return CAR_PER_TRIP + TW_PER_TRIP * TWO_WHEELER_ECS


def demand_ecs(city_pop, attr_share):
    """Vehicles parked at the late-morning peak in a cell with ``attr_share`` of the city's attraction."""
    return dm.TRIPS_PER_CAPITA * city_pop * AWAY_SHARE * attr_share * ecs_per_trip() * ACCUMULATION


def kerb_ecs(street_km):
    """Usable kerb spaces along ``street_km`` of local/secondary street (both sides)."""
    return street_km * 2 * 1000 / BAY_M * USABLE


def pressure(demand, supply):
    if demand < MIN_DEMAND:
        return None
    return demand / max(supply, 1.0)


# ── run ─────────────────────────────────────────────────────────────────────

def _cols(ds, region, fields):
    t = dm._read(ds, region)
    if t is None:
        return {}
    out = {}
    for i, c in enumerate(t.codes):
        out[c] = tuple(t.columns[f][i] if f in t.columns else None for f in fields)
    return out


def fetch_official(region):
    """Official public parking lots with capacity -> data/vectors/parking_lots_official_{region}.geojson."""
    import re

    import requests

    from pipeline.realestate.newroads import resource_url
    pkg, name = OFFICIAL[region]
    text = requests.get(resource_url(pkg, name), timeout=120).content.decode("utf-8-sig")
    feats = []
    for pm in re.findall(r"<Placemark.*?</Placemark>", text, re.S):
        xy = re.search(r"<coordinates>\s*([^<]+?)\s*</coordinates>", pm)
        val = dict(re.findall(r'<SimpleData name="([^"]+)">([^<]*)<', pm))
        try:
            x, y = map(float, xy.group(1).split(",")[:2])
            cap = int(float(val.get("TOTAL") or 0))
        except (AttributeError, ValueError):
            continue
        if cap > 0:
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(x, 6), round(y, 6)]},
                          "properties": {"code": val.get("CODE", ""), "spaces": cap,
                                         "cars": int(float(val.get("LMV") or 0)), "goods": int(float(val.get("LCV") or 0)) + int(float(val.get("HMV") or 0))}})
    VECTORS.mkdir(parents=True, exist_ok=True)
    (VECTORS / f"parking_lots_official_{region}.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "source": f"data.opencity.in/dataset/{pkg} (public domain)", "features": feats}, separators=(",", ":")))
    return feats


def official_spaces(region):
    """{L7 code: vehicle spaces} from the official lots file, if any."""
    p = VECTORS / f"parking_lots_official_{region}.geojson"
    out = Counter()
    if p.exists():
        for f in json.loads(p.read_text())["features"]:
            x, y = f["geometry"]["coordinates"]
            out[digipin.encode(y, x).replace("-", "")[:LEVEL]] += f["properties"]["spaces"]
    return out


def compute(region, log=print):
    from pipeline.cells import earthengine as gee
    pop = _cols("population", region, ("population",))
    built = _cols("built_up", region, ("built_pct", "nonres_share_pct"))
    poi = _cols("osm_amenities", region, ("poi_total",))
    roads = _cols("osm_roads", region, ("secondary_km_km2", "local_km_km2"))
    lots = Counter()
    p = VECTORS / f"ev_places_{region}.geojson"
    if p.exists():
        for f in json.loads(p.read_text())["features"]:
            if f["properties"].get("kind") == "parking":
                x, y = f["geometry"]["coordinates"]
                try:
                    lots[digipin.encode(y, x).replace("-", "")[:LEVEL]] += 1
                except Exception:
                    pass
    official = official_spaces(region)
    attr = Counter()
    for c, (bp, nr) in built.items():
        if bp:
            m2 = bp / 100 * gee.cell_area_km2(c) * 1e6
            share = (nr or 0) / 100
            attr[c] += m2 * share + 0.25 * m2 * (1 - share)
    for c, (n,) in poi.items():
        if n:
            attr[c] += 400.0 * n
    city_pop = sum(v[0] or 0 for v in pop.values())
    tot = sum(attr.values()) or 1.0
    rows = {}
    for c in set(attr) | set(lots) | (set(official) & set(built)):
        d = demand_ecs(city_pop, attr[c] / tot)
        sec, loc = roads.get(c, (None, None))
        street = ((sec or 0) + (loc or 0)) * gee.cell_area_km2(c)
        s = kerb_ecs(street) + max(LOT_ECS * lots[c], official[c])
        pr = pressure(d, s)
        if pr is None and not lots[c] and not official[c]:
            continue
        r = {"demand_ecs": round(d), "supply_ecs": round(s)}
        if lots[c]:
            r["lots"] = lots[c]
        if pr is not None:
            r["pressure"] = round(pr, 2)
        rows[c] = r
    dem = sum(r["demand_ecs"] for r in rows.values()) or 1
    over = [(c, r) for c, r in rows.items() if (r.get("pressure") or 0) > 1]
    top = sorted(over, key=lambda cr: -(cr[1]["demand_ecs"] - cr[1]["supply_ecs"]))[:TOP]
    summ = {"cells": len(rows), "demand_ecs": round(dem), "lots_mapped": sum(lots.values()), "official_lot_spaces": sum(official.values()),
            "pct_demand_in_overflow": round(100 * sum(r["demand_ecs"] for _, r in over) / dem, 1),
            "overflow_ecs": round(sum(r["demand_ecs"] - r["supply_ecs"] for _, r in over)),
            "hotspots": [{"digipin": c, **r} for c, r in top],
            "assumptions": {"away_share": AWAY_SHARE, "ecs_per_trip": round(ecs_per_trip(), 3),
                            "accumulation": ACCUMULATION, "bay_m": BAY_M, "usable_kerb": USABLE, "lot_ecs": LOT_ECS}}
    log(f"{region}: {json.dumps({k: v for k, v in summ.items() if k not in ('hotspots', 'assumptions')})}")
    return rows, summ


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("demand_ecs", "Vehicles parked at the late-morning peak", agg="sum", unit="car spaces",
                  ramp="heat", higher_is="worse"),
        FieldSpec("supply_ecs", "Kerb and lot spaces", agg="sum", unit="car spaces", ramp="greens", higher_is="better"),
        FieldSpec("lots", "Mapped parking lots", agg="sum", unit="lots", ramp="viridis"),
        FieldSpec("pressure", "Parking pressure (demand / spaces)", agg="mean", unit="ratio", domain=[0, 3],
                  ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="parking", title="Parking pressure", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Late-morning parked vehicles from the demand model's trip attraction (cars and two-wheelers "
                    "in equivalent car spaces) against usable kerb on local and secondary streets and mapped "
                    "parking lots. Above 1, vehicles spill onto footpaths and main roads. Indicative: no parking "
                    "surveys or occupancy counts; open data maps few off-street lots.",
        source="pipeline/traffic/parking.py over population, built_up, osm_amenities, osm_roads + Overture parking",
        license="CC BY 4.0 (GHSL) + ODbL (OpenStreetMap) + CDLA-Permissive-2.0 (Overture places)",
        default_field="pressure", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, log=print):
    try:
        rows, summ = compute(region, log)
    except RuntimeError as ex:
        log(f"{region}: skipped ({ex})")
        return None
    if not rows:
        return None
    res = cell_dataset(region, rows)
    sp = REPO / "data" / "traffic" / region / "summary.json"
    if sp.parent.exists():
        s = json.loads(sp.read_text()) if sp.exists() else {}
        s["parking"] = summ
        sp.write_text(json.dumps(s, indent=2) + "\n")
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    p.add_argument("--official", action="store_true", help="re-fetch the corporations' official parking lot lists first")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        if a.official and r in OFFICIAL:
            print(f"{r}: {len(fetch_official(r))} official lots")
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
