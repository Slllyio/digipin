"""Telemetric rain gauges and weather stations per block (Bengaluru; KSNDMC maps on OpenCity, public domain).

Dataset ``rain_gauges`` (L7):

    rain_gauges        Karnataka State Natural Disaster Monitoring Centre telemetric rain gauges in the block
    weather_stations   KSNDMC telemetric weather stations (rain, temperature, humidity, wind) in the block

Maps on data.opencity.in (KGIS): the Karnataka telemetric rain gauge and weather station layers, and the Bengaluru
Urban rain gauge layer. A gauge on both rain gauge layers (within 100 m) counts once.

    python -m pipeline.realestate.raingauges
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
SAME_M = 100
SOURCES = [     # (kind, OpenCity dataset, resource name)
    ("gauge", "karnataka-telemetric-weather-stations-and-rain-gauges", "Karnataka - Telemetric Rain Gauges"),
    ("gauge", "list-of-automated-weater-stations-aws-in-bengaluru-urban-rural-districts", "Bengaluru Urban - Telemetric Rain"),
    ("station", "karnataka-telemetric-weather-stations-and-rain-gauges", "Karnataka - Telemetric Weather Station"),
]


def merge(kind_points, bbox):
    """[(lng, lat, kind)] inside bbox; points of one kind within SAME_M of each other count once."""
    w, s, e, n = bbox
    out = []
    for kind, pts in kind_points:
        for lng, lat, _ in pts:
            if not (w <= lng <= e and s <= lat <= n):
                continue
            if any(k == kind and math.hypot((lng - x) * 111320 * math.cos(math.radians(lat)), (lat - y) * 110540) < SAME_M
                   for x, y, k in out):
                continue
            out.append((lng, lat, kind))
    return out


def records(points):
    for lng, lat, kind in points:
        yield {"lat": lat, "lng": lng, "rain_gauges" if kind == "gauge" else "weather_stations": 1}


def cell_dataset(region, points):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("rain_gauges", "Telemetric rain gauges (KSNDMC)", agg="sum", unit="gauges", ramp="blues", higher_is="better"),
             FieldSpec("weather_stations", "Telemetric weather stations (KSNDMC)", agg="sum", unit="stations", ramp="blues", higher_is="better")]
    spec = DatasetSpec(
        id="rain_gauges", title="Rain gauges and weather stations (KSNDMC)", level=LEVEL, fields=specs, group="Environment",
        description="Karnataka State Natural Disaster Monitoring Centre telemetric rain gauges (reporting every 15 minutes) and "
                    "weather stations, from the KGIS maps on data.opencity.in; a gauge on both the state and the Bengaluru "
                    "Urban layer counts once.",
        source="pipeline/realestate/raingauges.py (OpenCity KSNDMC maps)",
        license="Public domain (KSNDMC via data.opencity.in)", default_field="rain_gauges", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(records(points), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.newroads import resource_url
    from pipeline.realestate.toilets import kml_points
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    kp = [(kind, kml_points(requests.get(resource_url(pkg, name), timeout=300).content.decode("utf-8-sig")))
          for kind, pkg, name in SOURCES]
    points = merge(kp, bbox_for("bengaluru"))
    info = cell_dataset("bengaluru", points)
    print(f"bengaluru: {sum(k == 'gauge' for *_, k in points)} rain gauges, "
          f"{sum(k == 'station' for *_, k in points)} weather stations, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
