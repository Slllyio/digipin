"""Landslide susceptibility per block: NASA's global landslide susceptibility map (Stanley and Kirschbaum; 2023 update, public domain).

NASA's map scores every ~1 km cell of the world from very low (1) to very high (5) landslide susceptibility from slope,
geology, fault zones, road cuts and forest loss; it is the static layer behind NASA's LHASA landslide nowcasts. Each
lived-in L7 block takes the class of the cell under its centre, and the highest class within one cell around it
(dataset ``landslide_susceptibility``):

    ls_class       susceptibility class under the block (1 very low ... 5 very high; water and flat coast 0 are dropped)
    ls_near_max    highest class in the 3 x 3 cells around the block
    ls_moderate    1 when the block's class is moderate (3) or higher

At ~1 km a cell mixes a hillside with the flat ground below it, so read the class as "this neighbourhood has slopes
that can fail", not as a verdict on one building.

    python -m pipeline.realestate.landslidesus --region mumbai,pune,...
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = "https://gpm.nasa.gov/sites/default/files/downloads/global-landslide-susceptibility-map-2-27-23.tif"


def block_rows(cells, read_window):
    """cells: [(code, lat, lng)]; read_window(lat, lng) -> 3x3 list of class values around the point (centre at [1][1])."""
    rows = {}
    for code, la, lo in cells:
        w = read_window(la, lo)
        c = int(w[1][1])
        if not 1 <= c <= 5:
            continue
        near = max(int(v) for r in w for v in r if 1 <= int(v) <= 5)
        rows[code] = {"ls_class": c, "ls_near_max": near, "ls_moderate": int(c >= 3)}
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("ls_class", "Landslide susceptibility (1 very low ... 5 very high)", agg="max", domain=[1, 5], ramp="reds", higher_is="worse"),
        FieldSpec("ls_near_max", "Highest landslide susceptibility within about 1 km", agg="max", domain=[1, 5], ramp="reds", higher_is="worse"),
        FieldSpec("ls_moderate", "Moderate or higher landslide susceptibility", agg="max", unit="yes/no", domain=[0, 1], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="landslide_susceptibility", title="Landslide susceptibility (NASA global map)", level=LEVEL, fields=specs, group="Hazards",
        description="NASA's global landslide susceptibility map (Stanley and Kirschbaum, 2023 update; slope, geology, faults, "
                    "road cuts and forest loss at about 1 km), sampled at each block: the static layer behind NASA's LHASA "
                    "landslide nowcasts.",
        source="pipeline/realestate/landslidesus.py (NASA GPM global landslide susceptibility map)",
        license="Public domain (NASA)", default_field="ls_class", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import tempfile

    import rasterio
    import requests
    from rasterio.windows import Window

    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    ap.add_argument("--region", default=",".join(regions))
    ap.add_argument("--tif", help="local copy of the map")
    a = ap.parse_args(argv)
    path = a.tif
    if not path:
        tmp = tempfile.NamedTemporaryFile(suffix=".tif", delete=False)
        tmp.write(requests.get(URL, timeout=600).content)
        tmp.close()
        path = tmp.name
    with rasterio.open(path) as ds:
        def read_window(la, lo):
            r, c = ds.index(lo, la)
            return ds.read(1, window=Window(c - 1, r - 1, 3, 3), boundless=True, fill_value=0).tolist()
        for region in a.region.split(","):
            rows = block_rows(lived_cells(region), read_window)
            if not rows:
                continue
            info = cell_dataset(region, rows)
            print(f"{region}: {len(rows)} blocks, {sum(r['ls_moderate'] for r in rows.values())} moderate or higher, "
                  f"{sum(1 for r in rows.values() if r['ls_class'] >= 4)} high or very high; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
