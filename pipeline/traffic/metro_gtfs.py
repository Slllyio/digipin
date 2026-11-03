"""Metro service per DIGIPIN cell from an open metro GTFS timetable.

Bins a metro feed into cell dataset ``metro_service`` (L7), with the same counting as ``gtfs_cells`` (bus):

    stops               metro platforms in the cell (a station has one per direction or more)
    routes              distinct lines calling there
    departures_day      train departures from those platforms on a weekday
    peak_departures_hr  train departures per hour 07:00-10:00 (all platforms in the cell)
    best_headway_min    minutes between trains at the cell's busiest platform in that window

Feeds:

    bengaluru   Namma Metro (BMRCL), community GTFS built from BMRCL's published timetables and OpenStreetMap
                (github.com/Vonter/bmrcl-gtfs, ODbL); stop times are estimates from published headways
    hyderabad   Hyderabad Metro Rail (L&T HMRL), Telangana open data GTFS (July 2026) via data.opencity.in
                (public domain)

    python -m pipeline.traffic.metro_gtfs --region bengaluru,hyderabad
"""
from __future__ import annotations

import argparse
import tempfile
import urllib.request
from pathlib import Path

from pipeline.traffic.gtfs_cells import CELLS, LEVEL, cell_rows, read_feed

FEEDS = {
    "bengaluru": {"url": "https://raw.githubusercontent.com/Vonter/bmrcl-gtfs/main/gtfs/bmrcl.zip",
                  "name": "Namma Metro (BMRCL timetables, community GTFS by Vonter, August 2026)", "license": "ODbL 1.0"},
    "hyderabad": {"url": "https://data.opencity.in/dataset/4e72c202-4cdb-4437-a629-ffcbe9519f73/resource/5fa250e1-3104-4ca7-ad31-4fa3321f6255/download/telangana_opendata_gtfs_hmrl_03_july_2026.zip",
                  "name": "Hyderabad Metro Rail (Telangana open data GTFS, July 2026, via OpenCity)", "license": "Public domain (OpenCity)"},
}


def write(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("best_headway_min", "Minutes between trains at the busiest platform (07-10 h)", agg="min",
                  unit="min", domain=[2, 20], ramp="heat", higher_is="worse"),
        FieldSpec("peak_departures_hr", "Train departures per hour (07-10 h)", agg="sum", unit="per hour", ramp="viridis", higher_is="better"),
        FieldSpec("departures_day", "Train departures per weekday", agg="sum", unit="per day", ramp="viridis", higher_is="better"),
        FieldSpec("routes", "Metro lines calling", agg="max", unit="lines", ramp="viridis", higher_is="better"),
        FieldSpec("stops", "Metro platforms", agg="sum", unit="platforms", ramp="viridis", higher_is="better"),
    ]
    names = "; ".join(f"{r}: {f['name']}" for r, f in FEEDS.items())
    spec = DatasetSpec(
        id="metro_service", title="Metro service (timetable)", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Weekday metro service from the city's open GTFS timetable: platforms, lines, departures and the gap "
                    f"between trains at each cell's busiest platform in the 07:00-10:00 peak ({names}).",
        source=f"pipeline/traffic/metro_gtfs.py over {names}",
        license="; ".join(f"{f['license']} ({r})" for r, f in FEEDS.items()), default_field="best_headway_min", extrude=False)
    table = store.bin_records(({"digipin": c, **r} for c, r in rows.items()), LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(FEEDS))
    ap.add_argument("--gtfs", help="local GTFS zip (default: the region's registered feed)")
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        path = Path(a.gtfs) if a.gtfs else Path(tempfile.gettempdir()) / f"metro_{r}.zip"
        if not path.exists():
            urllib.request.urlretrieve(FEEDS[r]["url"], path)
        stops, per_stop = read_feed(path)
        rows = cell_rows(stops, per_stop)
        res = write(r, rows)
        print(f"{r}: {len(rows)} cells with platforms, {res}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
