"""Thermal power plants upwind of each block (WRI Global Power Plant Database × ERA5-Land wind).

Per L7 lived-in block (dataset ``power_plants``):

    coal_mw_50km        coal-fired capacity within 50 km
    fossil_mw_100km     coal, gas and oil capacity within 100 km
    coal_km             distance to the nearest coal plant (up to REACH_KM)
    coal_plume          upwind coal index: sum over coal plants within REACH_KM of capacity (MW) × the share of the
                        wind (daily means by speed, 2020-2024) blowing from the plant towards the block, ÷ distance (km,
                        floored at 5 km). A relative exposure index, not a concentration.

Plants come from GPPD (as mirrored in Earth Engine, WRI/GPPD/power_plants); it is a 2018-2021 snapshot. Known
retirements since (CLOSED, e.g. Delhi's Badarpur) are dropped by name; newer units may be missing. Wind is ERA5-Land daily
10 m wind at the city centre: one wind rose per city.

    python -m pipeline.realestate.powerplants --region all
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
REACH_KM = 150
COAL_KM, FOSSIL_KM = 50, 100
SECTOR_DEG = 45
MIN_KM = 5
FOSSIL = ("Coal", "Gas", "Oil")
YEARS = (2020, 2024)
# Coal plants in the snapshot retired since: Badarpur (2018), Rajghat (2015), old Ennore (2017), Titagarh (2018), old Panki
# units (2018). Other retirements and new units since 2021 are not tracked.
CLOSED = ("BADARPUR", "RAJGHAT", "ENNORE", "TITAGARH", "PANKI")


def haversine_km(lat1, lng1, lat2, lng2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lng2 - lng1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))


def bearing_deg(lat1, lng1, lat2, lng2):
    """Initial bearing from point 1 to point 2, degrees clockwise from north."""
    p = math.pi / 180
    y = math.sin((lng2 - lng1) * p) * math.cos(lat2 * p)
    x = math.cos(lat1 * p) * math.sin(lat2 * p) - math.sin(lat1 * p) * math.cos(lat2 * p) * math.cos((lng2 - lng1) * p)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def rose(winds):
    """[(toward_deg, weight)] from [(u, v)] wind vectors (u east, v north): direction the air moves to, weighted by speed."""
    out = [((math.degrees(math.atan2(u, v)) + 360) % 360, math.hypot(u, v)) for u, v in winds]
    tot = sum(w for _, w in out) or 1
    return [(d, w / tot) for d, w in out]


def share_towards(rose_, bearing):
    """Share of the wind (speed-weighted) moving within SECTOR_DEG of a bearing."""
    return sum(w for d, w in rose_ if abs((d - bearing + 180) % 360 - 180) <= SECTOR_DEG)


def exposure(cells, plants, rose_):
    """{code: row} for cells [(code, lat, lng)] and plants [(lat, lng, fuel, mw)]."""
    rows = {}
    for code, lat, lng in cells:
        coal50 = fossil100 = plume = 0.0
        near = None
        for py, px, fuel, mw in plants:
            d = haversine_km(lat, lng, py, px)
            if d > REACH_KM:
                continue
            if fuel == "Coal":
                near = d if near is None else min(near, d)
                if d <= COAL_KM:
                    coal50 += mw
                plume += mw * share_towards(rose_, bearing_deg(py, px, lat, lng)) / max(d, MIN_KM)
            if d <= FOSSIL_KM:
                fossil100 += mw
        rows[code] = {"coal_mw_50km": round(coal50), "fossil_mw_100km": round(fossil100),
                      "coal_km": round(near, 1) if near is not None else None, "coal_plume": round(plume, 1)}
    return rows


def _ee():
    import ee
    from google.oauth2.credentials import Credentials
    import os
    ee.Initialize(Credentials(token="proxy-injected"), project=os.environ.get("GEE_PROJECT", "van-suraksha-alert"))
    return ee


def fetch_plants(ee, bbox):
    w, s, e, n = bbox
    pad = REACH_KM / 100
    fc = ee.FeatureCollection("WRI/GPPD/power_plants").filter(ee.Filter.inList("fuel1", list(FOSSIL))) \
        .filterBounds(ee.Geometry.Rectangle([w - pad, s - pad, e + pad, n + pad]))
    feats = fc.getInfo()["features"]
    return [(f["properties"]["latitude"], f["properties"]["longitude"], f["properties"]["fuel1"], f["properties"]["capacitymw"] or 0)
            for f in feats if f["properties"]["name"] not in CLOSED]


def fetch_wind(ee, lat, lng):
    col = ee.ImageCollection("ECMWF/ERA5_LAND/DAILY_AGGR").filterDate(f"{YEARS[0]}-01-01", f"{YEARS[1] + 1}-01-01") \
        .select(["u_component_of_wind_10m", "v_component_of_wind_10m"])
    # ERA5-Land masks sea cells, so a coastal city centre can come back empty: step 0.1° at a time until land is found.
    for dy, dx in ((0, 0), (0, -0.1), (0, 0.1), (0.1, 0), (-0.1, 0), (0, -0.2), (0, 0.2), (0.1, -0.1), (0.1, 0.1)):
        vals = col.getRegion(ee.Geometry.Point([lng + dx, lat + dy]), 11132).getInfo()
        head = vals[0]
        iu, iv = head.index("u_component_of_wind_10m"), head.index("v_component_of_wind_10m")
        out = [(r[iu], r[iv]) for r in vals[1:] if r[iu] is not None and r[iv] is not None]
        if out:
            return out
    return []


def lived_cells(region):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next(r for r in pop["regions"] if r["name"] == region)
    out = []
    for c in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(c)
        out.append((c, (b["south"] + b["north"]) / 2, (b["west"] + b["east"]) / 2))
    return out


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("coal_mw_50km", f"Coal power capacity within {COAL_KM} km", agg="max", unit="MW", ramp="reds", higher_is="worse"),
        FieldSpec("fossil_mw_100km", f"Coal, gas and oil power capacity within {FOSSIL_KM} km", agg="max", unit="MW", ramp="reds", higher_is="worse"),
        FieldSpec("coal_km", "Nearest coal power plant", agg="min", unit="km", ramp="reds", higher_is="better"),
        FieldSpec("coal_plume", "Upwind coal index (MW × downwind wind share ÷ km)", agg="max", unit="index", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="power_plants", title="Thermal power plants upwind (GPPD, ERA5-Land)", level=LEVEL, fields=specs, group="Hazards",
        description=f"Coal, gas and oil power plants from the WRI Global Power Plant Database (Earth Engine WRI/GPPD/power_plants, "
                    f"a 2018-2021 snapshot) within {REACH_KM} km of each block, with an upwind coal index that weights each coal "
                    f"plant's capacity by the share of ERA5-Land daily 10 m wind ({YEARS[0]}-{YEARS[1]}, city centre, speed-weighted) "
                    f"blowing from the plant towards the block (±{SECTOR_DEG}°) and divides by distance. A relative index for "
                    "where plumes are likelier to arrive, not a pollution concentration; stack height, emission controls and "
                    "plant load factors are left out.",
        source="pipeline/realestate/powerplants.py (WRI GPPD and ECMWF ERA5-Land via Earth Engine)",
        license="CC BY 4.0 (WRI Global Power Plant Database); ERA5-Land: Copernicus licence (free with attribution)",
        default_field="coal_plume", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS, bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    ee = _ee()
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        w, s, e, n = bbox_for(r)
        plants = fetch_plants(ee, (w, s, e, n))
        r_ = rose(fetch_wind(ee, (s + n) / 2, (w + e) / 2))
        rows = exposure(lived_cells(r), plants, r_)
        coal = sum(p[3] for p in plants if p[2] == "Coal")
        print(f"{r}: {len(plants)} fossil plants within reach ({coal:.0f} MW coal), {len(rows)} blocks, "
              f"plume index up to {max((x['coal_plume'] for x in rows.values()), default=0):.0f}")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
