"""Air and noise quality monitoring stations per block (Hyderabad, Bengaluru; OpenCity, public domain).

Dataset ``air_monitors`` (L7):

    monitors         air quality monitoring stations in the block (continuous and manual)
    continuous       of them, continuous ambient air quality stations (CAAQMS, reporting hourly)
    noise_monitors   noise monitoring stations in the block (Bengaluru)

Maps: TSPCB's continuous station list (November 2023) for Hyderabad; for Bengaluru, KSPCB's air quality monitor map
(KGIS, continuous and manual stations), the 2023 list of continuous stations and KSPCB's noise monitoring stations. A
station on two lists (within 300 m) counts once, as continuous when either list says so.

    python -m pipeline.realestate.airmonitors --region hyderabad,bengaluru
"""
from __future__ import annotations

import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
O = "https://data.opencity.in/dataset/"
SOURCES = {     # region: [(kind, path, name)]
    "hyderabad": [("continuous", "f6acf3f6-095f-4ab2-adf6-422c768cd760/resource/4c51bd08-4496-44ca-bfb0-63ba9cfa34fd/download/5ba1b110-a85f-4b68-9006-de3919246e89.kml", "TSPCB continuous stations 2023")],
    "bengaluru": [("continuous", "04effd8d-4c4c-4dc1-b0bf-7d1dee6cf226/resource/16664e2d-0680-4573-8dec-12449a64d96d/download/62cb4117-f22b-498c-b761-247d8763de3f.kml", "Bengaluru continuous stations 2023"),
                  ("air", "04effd8d-4c4c-4dc1-b0bf-7d1dee6cf226/resource/1093c792-e772-44bb-a964-2c91ee9e2061/download/d218ec06-5c90-4447-b0e5-d1f4b88bef99.kml", "KSPCB air quality monitors (KGIS)"),
                  ("noise", "04effd8d-4c4c-4dc1-b0bf-7d1dee6cf226/resource/366b0fb9-3995-4262-b433-3eb09e59f125/download/28fcbf01-779c-4cdc-a984-1c3b3897f0fe.kml", "KSPCB noise monitors")],
}
SAME_M = 300


def merge(kind_points, bbox):
    """[(lng, lat, kind)] inside bbox; air stations within SAME_M of each other merged, continuous winning."""
    import math
    w, s, e, n = bbox
    out = []
    for kind, pts in sorted(kind_points, key=lambda kp: kp[0] != "continuous"):
        for lng, lat, _ in pts:
            if not (w <= lng <= e and s <= lat <= n):
                continue
            dup = kind != "noise" and any(
                k != "noise" and math.hypot((lng - x) * 111320 * math.cos(math.radians(lat)), (lat - y) * 110540) < SAME_M
                for x, y, k in out)
            if not dup:
                out.append((lng, lat, kind))
    return out


def records(stations):
    for lng, lat, kind in stations:
        if kind == "noise":
            yield {"lat": lat, "lng": lng, "noise_monitors": 1}
        else:
            yield {"lat": lat, "lng": lng, "monitors": 1, "continuous": 1 if kind == "continuous" else 0}


def cell_dataset(region, stations):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("monitors", "Air quality monitoring stations", agg="sum", unit="stations", ramp="blues", higher_is="better"),
             FieldSpec("continuous", "Continuous (hourly) air quality stations", agg="sum", unit="stations", ramp="blues", higher_is="better"),
             FieldSpec("noise_monitors", "Noise monitoring stations", agg="sum", unit="stations", ramp="blues", higher_is="better")]
    names = "; ".join(f"{r}: " + ", ".join(n for _, _, n in s) for r, s in SOURCES.items())
    spec = DatasetSpec(
        id="air_monitors", title="Air and noise monitoring stations", level=LEVEL, fields=specs, group="Real estate",
        description=f"Air quality (continuous and manual) and noise monitoring stations of the state pollution control boards, "
                    f"from maps on data.opencity.in ({names}).",
        source="pipeline/realestate/airmonitors.py (OpenCity TSPCB and KSPCB monitor maps)",
        license="Public domain (TSPCB and KSPCB via data.opencity.in)", default_field="monitors", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(records(stations), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.toilets import kml_points
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        kp = [(kind, kml_points(requests.get(O + path, timeout=120).content.decode("utf-8-sig"))) for kind, path, _ in SOURCES[r]]
        stations = merge(kp, bbox_for(r))
        info = cell_dataset(r, stations)
        count = {k: sum(1 for *_, kk in stations if kk == k) for k in ("continuous", "air", "noise")}
        print(f"{r}: {count}, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
