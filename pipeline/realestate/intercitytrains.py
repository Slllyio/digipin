"""Long-distance trains within reach: DataMeet's Indian Railways stations, trains and schedules (CC0, 2016 timetable).

DataMeet gathered Indian Railways' timetable in 2016: 8,990 stations (8,697 with coordinates), 5,208 trains with their
type, and 417,080 scheduled stops. The timetable is ten years old: new trains (Vande Bharat and others) are missing and a
few stations have been rebuilt or renamed, but the long-distance network and its main stops change slowly. Long-distance
trains are the express types (``LONG``: Express, Superfast, Mail, Rajdhani, Shatabdi, Jan Shatabdi, Duronto, Garib
Rath and Sampark Kranti); passenger, MEMU/DEMU and suburban (MMTS, Kolkata and Delhi locals) are left out. Per lived-in
L7 block (dataset ``intercity_trains``):

    it_trains_5km     distinct long-distance trains stopping at any station within ``REACH_KM``
    it_hub_km         straight-line distance to the nearest station with ``HUB_TRAINS`` or more long-distance trains
    it_hub_trains     long-distance trains stopping at that station
    it_stations_5km   stations within ``REACH_KM`` with at least one long-distance stop

A train counts once per station however many days a week it runs (the data has no days of operation). Stations it
runs through (arrival equal to departure) are not stops.

    python -m pipeline.realestate.intercitytrains
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RAW = "https://raw.githubusercontent.com/datameet/railways/master/"
LONG = {"Exp", "SF", "Mail", "Raj", "Shtb", "JShtb", "Drnt", "GR", "SKr"}
REACH_KM = 5.0
HUB_TRAINS = 50


def _km(la, lo, la2, lo2):
    return math.hypot((la - la2) * 110.57, (lo - lo2) * 111.32 * math.cos(math.radians(la)))


def is_stop(s):
    """A real stop: the train starts or ends here, or waits (arrival differs from departure); equal times mean it runs through."""
    a, d = str(s.get("arrival")), str(s.get("departure"))
    return a in ("None", "") or d in ("None", "") or a != d


def station_trains(stations, trains, schedules):
    """[(code, name, lat, lng, long-distance trains)] for stations with coordinates and at least one long-distance stop."""
    kind = {f["properties"]["number"]: f["properties"].get("type") for f in trains}
    stops = defaultdict(set)
    for s in schedules:
        if kind.get(s.get("train_number")) in LONG and is_stop(s):
            stops[s["station_code"]].add(s["train_number"])
    out = []
    for f in stations:
        p, g = f["properties"], f.get("geometry")
        if g and p["code"] in stops:
            lo, la = g["coordinates"][:2]
            out.append((p["code"], p["name"], la, lo, len(stops[p["code"]])))
    return out


def block_rows(cells, stations, reach=REACH_KM, hub=HUB_TRAINS):
    rows = {}
    if not cells:
        return rows
    la0 = min(c[1] for c in cells) - 0.6
    la1 = max(c[1] for c in cells) + 0.6
    lo0 = min(c[2] for c in cells) - 0.6
    lo1 = max(c[2] for c in cells) + 0.6
    near = [s for s in stations if la0 <= s[2] <= la1 and lo0 <= s[3] <= lo1]
    hubs = [s for s in near if s[4] >= hub]
    for code, la, lo in cells:
        inr = [s for s in near if _km(la, lo, s[2], s[3]) <= reach]
        row = {"it_trains_5km": sum(s[4] for s in inr), "it_stations_5km": len(inr)}
        if hubs:
            d, s = min(((_km(la, lo, h[2], h[3]), h) for h in hubs), key=lambda t: t[0])
            row["it_hub_km"] = round(d, 1)
            row["it_hub_trains"] = s[4]
        rows[code] = row
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("it_trains_5km", "Long-distance trains stopping within 5 km (2016 timetable)", agg="mean", unit="trains", ramp="viridis", higher_is="better"),
        FieldSpec("it_hub_km", f"Distance to the nearest station with {HUB_TRAINS}+ long-distance trains", agg="mean", unit="km", domain=[0, 30], ramp="reds", higher_is="worse"),
        FieldSpec("it_hub_trains", "Long-distance trains at that station", agg="mean", unit="trains", ramp="viridis", higher_is="better"),
        FieldSpec("it_stations_5km", "Stations with long-distance stops within 5 km", agg="mean", unit="stations", ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="intercity_trains", title="Long-distance trains within reach (Indian Railways 2016 timetable)", level=LEVEL, fields=specs,
        group="Mobility",
        description="Distinct express, superfast and premium trains stopping at stations near each block, and the distance to the "
                    f"nearest station with {HUB_TRAINS} or more of them, from DataMeet's 2016 Indian Railways timetable (CC0).",
        source="pipeline/realestate/intercitytrains.py (github.com/datameet/railways stations, trains, schedules)",
        license="CC0 (DataMeet, Indian Railways data gathered by S. Bhangar and S. Hussain, 2016)", default_field="it_trains_5km", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", help="local folder with stations.json, trains.json, schedules.json")
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    load = (lambda n: json.load(open(Path(a.dir) / f"{n}.json"))) if a.dir else (lambda n: requests.get(RAW + f"{n}.json", timeout=600).json())
    stations = station_trains(load("stations")["features"], load("trains")["features"], load("schedules"))
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        rows = block_rows(lived_cells(region), stations)
        info = cell_dataset(region, rows)
        hubs = sorted({(r.get("it_hub_trains"), ) for r in rows.values()}, reverse=True)[:1]
        print(f"{region}: {len(rows)} blocks, median trains within 5 km "
              f"{sorted(r['it_trains_5km'] for r in rows.values())[len(rows) // 2]}, busiest hub {hubs}; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
