"""Large construction projects with state environmental clearance in Bengaluru Urban (OpenCity, public domain).

Per L7 block (dataset ``big_projects``):

    projects      construction projects SEIAA Karnataka cleared in the block (each 20,000 m² built-up or more)
    residential   of them, residential (apartments, group housing, layouts)
    commercial    of them, offices, IT parks, malls, hotels and other commercial (mixed-use counts in both)

Map: SEIAA Karnataka construction project locations for Bengaluru Urban (KGIS; about 600 projects). Projects of
20,000 m² or more built-up need state environmental clearance (EIA Notification 2006, item 8(a)), so this is the
city's large-project pipeline; the map gives the project name, not its date or size. The type is read from the name.

    python -m pipeline.realestate.seiaa
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/1a231f9a-5b6f-4dc0-b533-a3eca1ad4beb/resource/574c6f7c-5d1c-48e7-9321-8081dac104ac/"
       "download/76e1aa89-f66b-42b5-a2dc-42fbacc94f62.kml")
RESIDENTIAL = re.compile(r"resid|resden|resdin|apartment|housing|layout|villa|township|flats", re.I)
COMMERCIAL = re.compile(r"commerc|office|\bit\b|tech|software|mall|hotel|retail|\bsez\b|business|mixed", re.I)


def kind(name):
    """(residential, commercial) flags from a project name; mixed use is both."""
    name = name or ""
    mixed = "mixed" in name.lower()
    return bool(RESIDENTIAL.search(name)) or mixed, bool(COMMERCIAL.search(name)) or mixed


def records(points):
    seen = set()
    for lng, lat, p in points:
        if not (77 < lng < 78.2 and 12.5 < lat < 13.5):
            continue
        k = (round(lng, 4), round(lat, 4), p.get("CONSTRUCTIONName"))
        if k in seen:
            continue
        seen.add(k)
        res, com = kind(p.get("CONSTRUCTIONName"))
        yield {"lat": lat, "lng": lng, "projects": 1, "residential": int(res), "commercial": int(com)}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("projects", "Large projects with environmental clearance", agg="sum", unit="projects", ramp="heat", higher_is="better"),
        FieldSpec("residential", "Large residential projects", agg="sum", unit="projects", ramp="heat", higher_is="better"),
        FieldSpec("commercial", "Large commercial projects", agg="sum", unit="projects", ramp="heat", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="big_projects", title="Large construction projects (SEIAA clearances)", level=LEVEL, fields=specs, group="Real estate",
        description="Construction projects of 20,000 m² or more built-up that SEIAA Karnataka cleared in Bengaluru Urban (KGIS map on "
                    "data.opencity.in), counted per block, with residential and commercial counts read from the project names.",
        source="pipeline/realestate/seiaa.py (OpenCity SEIAA construction project map)",
        license="Public domain (SEIAA Karnataka / KGIS via data.opencity.in)", default_field="projects", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    recs = list(records(kml_points(requests.get(URL, timeout=300).content.decode("utf-8-sig"))))
    info = cell_dataset("bengaluru", recs)
    print(f"bengaluru: {len(recs)} projects ({sum(r['residential'] for r in recs)} residential, "
          f"{sum(r['commercial'] for r in recs)} commercial) in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
