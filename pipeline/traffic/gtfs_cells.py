"""Bus service per DIGIPIN cell from an open GTFS timetable.

OSM tells the transit lens where stops are; a timetable says how often a bus
actually comes. This bins a city's GTFS feed into cell dataset
``bus_service`` (L7):

    stops               GTFS stops in the cell
    routes              distinct routes calling there
    departures_day      departures from those stops on a weekday
    peak_departures_hr  departures per hour 07:00–10:00 (all stops in the cell)
    best_headway_min    minutes between buses at the cell's busiest stop in
                        that window (60 / departures per hour; lower is better)

Feeds (ODbL or similar; downloaded at bake time, not committed):

    bengaluru   BMTC, community GTFS scraped from the Namma BMTC app
                (github.com/Vonter/bmtc-gtfs, ODbL)
    hyderabad   TGSRTC city buses, Telangana open data GTFS (February 2026)
                via data.opencity.in (public domain)
    chennai     MTC, community GTFS from the MTC app timetables
                (github.com/ungalsoththu/ChennaiGTFS, ODbL/PDDL, April 2026)
    delhi       DTC/cluster buses, Delhi Open Transit Data (needs a free
                registered key; skipped until the URL and key are set, or
                pass a downloaded feed with --gtfs)

    python -m pipeline.traffic.gtfs_cells --region bengaluru
    python -m pipeline.traffic.gtfs_cells --region bengaluru --gtfs path/to/feed.zip
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from pipeline._lib import digipin

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PEAK = (7 * 60, 10 * 60)             # weekday morning window, minutes
FEEDS = {
    "bengaluru": {"url": "https://raw.githubusercontent.com/Vonter/bmtc-gtfs/main/gtfs/bmtc.zip",
                  "name": "BMTC (Namma BMTC app, community GTFS by Vonter)", "license": "ODbL 1.0"},
    "hyderabad": {"url": "https://data.opencity.in/dataset/88e2d145-7ec6-4666-88dd-6cf18b18312e/resource/1b0d18bb-b2fb-4a79-8ed0-1e071da5790c/download/telangana_opendata_gtfs_tgsrtc_08_february_2026.zip",
                  "name": "TGSRTC (Telangana open data GTFS, February 2026, via OpenCity)", "license": "Public domain (OpenCity)"},
    "chennai": {"url": "https://raw.githubusercontent.com/ungalsoththu/ChennaiGTFS/main/data/mtc-gtfs.zip",
                "name": "MTC (MTC app timetables, community GTFS by UngalSoththu, April 2026)", "license": "ODbL 1.0 / PDDL"},
    # Static GTFS from otd.delhi.gov.in needs a registered key; fill the
    # download URL in once one is issued (until then the region is skipped).
    "delhi": {"url": None, "key_env": "OTD_DELHI_KEY",
              "name": "Delhi Open Transit Data (DTC + cluster buses)", "license": "Delhi OTD terms"},
}


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def minutes(hms):
    """'HH:MM:SS' (hours may exceed 24) → minutes after midnight, or None."""
    try:
        h, m, s = (int(x) for x in str(hms).split(":"))
        return h * 60 + m + s / 60
    except (TypeError, ValueError):
        return None


def weekday_services(calendar_rows, dates_rows=()):
    """Service ids running on a typical weekday (Wednesday in calendar.txt).

    With no calendar.txt (calendar_dates only), the date with the most
    services stands in for a weekday.
    """
    ids = {r["service_id"] for r in calendar_rows if str(r.get("wednesday", "0")).strip() == "1"}
    if ids or not dates_rows:
        return ids
    by_date: dict = {}
    for r in dates_rows:
        if str(r.get("exception_type")).strip() == "1":
            by_date.setdefault(r["date"], set()).add(r["service_id"])
    return max(by_date.values(), key=len) if by_date else set()


def summarise_stops(stop_times, trip_route, window=PEAK):
    """Per stop: {departures, peak, routes} from stop_times rows of running trips."""
    out: dict = {}
    lo, hi = window
    for r in stop_times:
        route = trip_route.get(r["trip_id"])
        if route is None:
            continue
        t = minutes(r.get("departure_time") or r.get("arrival_time"))
        if t is None:
            continue
        s = out.setdefault(r["stop_id"], {"departures": 0, "peak": 0, "routes": set()})
        s["departures"] += 1
        if lo <= t % 1440 < hi:
            s["peak"] += 1
        s["routes"].add(route)
    return out


def cell_rows(stops, per_stop, level=LEVEL, window=PEAK):
    """Bin stop summaries to DIGIPIN cells."""
    hours = (window[1] - window[0]) / 60
    rows: dict = {}
    for sid, (lat, lon) in stops.items():
        s = per_stop.get(sid)
        if not s:
            continue
        try:
            code = digipin.encode(lat, lon).replace("-", "")[:level]
        except Exception:                 # outside India's DIGIPIN extent
            continue
        r = rows.setdefault(code, {"stops": 0, "departures_day": 0, "_peak": 0, "_best": 0, "_routes": set()})
        r["stops"] += 1
        r["departures_day"] += s["departures"]
        r["_peak"] += s["peak"]
        r["_best"] = max(r["_best"], s["peak"])
        r["_routes"] |= s["routes"]
    out = {}
    for code, r in rows.items():
        best_hr = r["_best"] / hours
        out[code] = {
            "stops": r["stops"], "routes": len(r["_routes"]), "departures_day": r["departures_day"],
            "peak_departures_hr": round(r["_peak"] / hours, 1),
            "best_headway_min": round(60 / best_hr, 1) if best_hr > 0 else None,
        }
    return out


# ── IO ──────────────────────────────────────────────────────────────────────

def _rows(z, name):
    try:
        with z.open(name) as fh:
            yield from csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig"))
    except KeyError:
        return


def read_feed(path, log=print):
    with zipfile.ZipFile(path) as z:
        services = weekday_services(list(_rows(z, "calendar.txt")), list(_rows(z, "calendar_dates.txt")))
        trip_route = {t["trip_id"]: t["route_id"] for t in _rows(z, "trips.txt")
                      if not services or t["service_id"] in services}
        stops = {}
        for s in _rows(z, "stops.txt"):
            try:
                stops[s["stop_id"]] = (float(s["stop_lat"]), float(s["stop_lon"]))
            except (KeyError, ValueError):
                continue
        per_stop = summarise_stops(_rows(z, "stop_times.txt"), trip_route)
    log(f"  {len(stops)} stops, {len(trip_route)} weekday trips, {len(per_stop)} stops served")
    return stops, per_stop


def fetch(region, log=print):
    f = FEEDS.get(region)
    if not f:
        return None
    url = f["url"]
    if not url:
        log(f"{region}: skipped, no download URL yet (pass --gtfs <zip>)")
        return None
    if "{key}" in url:
        key = os.environ.get(f.get("key_env", ""), "")
        if not key:
            log(f"{region}: skipped, set {f['key_env']} for this feed")
            return None
        url = url.format(key=key)
    dst = Path(tempfile.gettempdir()) / f"gtfs_{region}.zip"
    if not dst.exists():
        log(f"{region}: downloading {f['name']}")
        urllib.request.urlretrieve(url, dst)
    return dst


def write(region, rows, source):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("best_headway_min", "Minutes between buses at the busiest stop (07–10 h)", agg="min",
                  unit="min", domain=[2, 60], ramp="heat", higher_is="worse"),
        FieldSpec("peak_departures_hr", "Bus departures per hour (07–10 h)", agg="sum", unit="per hour",
                  ramp="viridis", higher_is="better"),
        FieldSpec("departures_day", "Bus departures per weekday", agg="sum", unit="per day", ramp="viridis",
                  higher_is="better"),
        FieldSpec("routes", "Bus routes calling", agg="max", unit="routes", ramp="viridis", higher_is="better"),
        FieldSpec("stops", "Bus stops", agg="sum", unit="stops", ramp="viridis", higher_is="better"),
    ]
    # One catalog entry serves every city, so name every open feed, not just this run's.
    feeds = {r: f for r, f in FEEDS.items() if f.get("url")}
    if region not in feeds:
        feeds[region] = source
    names = "; ".join(f"{r}: {f['name']}" for r, f in feeds.items())
    spec = DatasetSpec(
        id="bus_service", title="Bus service (timetable)", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Weekday bus service from the city's open GTFS timetable: stops, routes, departures and the "
                    "gap between buses at each cell's busiest stop in the 07:00–10:00 peak. Only cities with an "
                    f"open feed ({names}).",
        source=f"pipeline/traffic/gtfs_cells.py over {names}",
        license="; ".join(f"{f['license']} ({r})" for r, f in feeds.items()),
        default_field="best_headway_min", extrude=False)
    table = store.bin_records(({"digipin": c, **r} for c, r in rows.items()), LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, gtfs=None, log=print):
    path = Path(gtfs) if gtfs else fetch(region, log)
    if path is None:
        return None
    stops, per_stop = read_feed(path, log)
    rows = cell_rows(stops, per_stop)
    res = write(region, rows, FEEDS.get(region, {"name": str(path), "license": "see feed"}))
    frequent = sum(1 for r in rows.values() if r["best_headway_min"] and r["best_headway_min"] <= 10)
    log(f"{region}: {len(rows)} cells with stops, {frequent} with a bus every ≤10 min at peak; {json.dumps(res)}")
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    p.add_argument("--gtfs", help="local GTFS zip (default: the region's registered feed)")
    a = p.parse_args(argv)
    for r in (list(FEEDS) if a.region == "all" else a.region.split(",")):
        run(r, a.gtfs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
