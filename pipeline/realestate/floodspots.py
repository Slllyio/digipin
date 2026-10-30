"""Chennai's waterlogging spots by ward, 2015-2024: the inundation lists in GCC's City Disaster Management Plan (via OpenCity, public domain).

Greater Chennai Corporation's City Disaster Management Perspective Plan 2025 reprints, monsoon by monsoon, the list of
streets and colonies that went under water: zone, ward, location and depth class, for the north-east monsoons of 2015
and 2017 to 2024 (about 1,320 listed spots in all; 554 after the November 2021 rains, 306 after December 2015). Each
L7 block in a GCC ward (``wards`` dataset) carries its ward's record (dataset ``flood_spots``):

    fs_ward     GCC ward number
    fs_years    monsoons, of the nine listed, in which the ward had a waterlogged spot
    fs_spots    listed spots summed over the nine monsoons
    fs_2015 / fs_2021 / fs_2024   spots listed after those monsoons
    fs_recent   spots listed after 2022, 2023 and 2024

The lists give ward numbers but no coordinates, so values are ward wide. Depth classes are printed as a tick in one of
four columns whose layout shifts from page to page, so they are not read.

    python -m pipeline.realestate.floodspots
"""
from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/7569167c-ae52-4871-9229-0cf561ca66b2/resource/"
       "18844e89-3194-4e9c-891d-d6acc5ae8478/download/cdmp_2025-compressed.pdf")
PACKAGE = "chennai-disaster-management-plans"
YEARS = (2015, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024)
HEAD = re.compile(r"Depth of Inundation During Monsoon|Vulnerable Locations During Monsoon-2023|VULNERABLE LOCATIONS")
END = re.compile(r"Chronic Inundation|NORTH\s?EAST\s?MONSOON|Abstract Of Vulnerable|^\s*CHAPTER|^\s*\d+\.\d+\.?\s+[A-Z][a-z]")
ROW = re.compile(r"^\s*(\d{1,3})\s+(\d{1,2}|[IVX]{1,4})\s+(\d{1,3})\b(.*)$")
NUMBERS_ONLY = re.compile(r"^[\d\s]*(NIL)?\s*$")


def spots(text):
    """{year: {ward: listed spots}} from the plan's text (pdftotext -layout)."""
    out, year, seen = {}, None, set()
    for line in text.split("\n"):
        if HEAD.search(line):
            m = re.search(r"20\d\d", line)
            year, seen = (int(m.group()) if m else None), set()
            continue
        if year is None:
            continue
        if END.search(line) and not ROW.match(line):
            year = None
            continue
        m = ROW.match(line)
        if not m or NUMBERS_ONLY.match(m.group(4)):
            continue                          # zone abstracts are numbers only
        sl, ward = int(m.group(1)), int(m.group(3))
        if not 1 <= ward <= 200 or sl in seen:
            continue
        seen.add(sl)
        w = out.setdefault(year, {})
        w[ward] = w.get(ward, 0) + 1
    return out


def ward_figures(by_year):
    """{ward: fields} over all listed monsoons."""
    wards = {w for ws in by_year.values() for w in ws}
    out = {}
    for w in wards:
        n = {y: by_year.get(y, {}).get(w, 0) for y in YEARS}
        out[w] = {"fs_ward": w, "fs_years": sum(1 for v in n.values() if v), "fs_spots": sum(n.values()),
                  "fs_2015": n[2015], "fs_2021": n[2021], "fs_2024": n[2024], "fs_recent": n[2022] + n[2023] + n[2024]}
    return out


def records(cells, figs):
    """Every ward block gets its ward's figures; wards never listed get zeros."""
    zero = {"fs_years": 0, "fs_spots": 0, "fs_2015": 0, "fs_2021": 0, "fs_2024": 0, "fs_recent": 0}
    for code, w in cells:
        if 1 <= w <= 200:
            yield {"digipin": code, **figs.get(w, {"fs_ward": w, **zero})}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    n = lambda key, label, unit="spots": FieldSpec(key, label, agg="max", unit=unit, ramp="reds", higher_is="worse")
    specs = [
        n("fs_years", "Monsoons (of 9, 2015-2024) in which the ward had a listed waterlogged spot", "monsoons"),
        n("fs_spots", "Waterlogged spots listed in the ward, 2015-2024 (summed over monsoons)"),
        n("fs_2015", "Spots listed in the ward after the 2015 monsoon"),
        n("fs_2021", "Spots listed in the ward after the 2021 monsoon"),
        n("fs_2024", "Spots listed in the ward after the 2024 monsoon"),
        n("fs_recent", "Spots listed in the ward after the 2022-2024 monsoons"),
        FieldSpec("fs_ward", "GCC ward", agg="min", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="flood_spots", title="Waterlogged spots by ward, 2015-2024 (GCC disaster management plan)", level=LEVEL, fields=specs,
        group="Environment",
        description="Streets and colonies Greater Chennai Corporation listed as inundated after each north-east monsoon "
                    "(2015 and 2017-2024), counted per ward from the lists in its City Disaster Management Perspective Plan "
                    "2025 on data.opencity.in. The lists name a ward but give no coordinates, so values are ward wide.",
        source="pipeline/realestate/floodspots.py (GCC City Disaster Management Perspective Plan 2025 via OpenCity)",
        license="Public domain (Greater Chennai Corporation via data.opencity.in)", default_field="fs_years", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def pdf_text(url):
    import requests
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(requests.get(url, timeout=600).content)
        f.flush()
        # the inundation lists sit in the first 130 pages; the zone chapters after them repeat older lists
        return subprocess.run(["pdftotext", "-layout", "-l", "130", f.name, "-"], capture_output=True, text=True, check=True).stdout


def main(argv=None):
    import requests

    from pipeline.realestate.econcensus import ward_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="chennai")
    region = ap.parse_args(argv).region
    res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": PACKAGE}, timeout=60).json()["result"]["resources"]
    url = next((r["url"] for r in res if "2025" in r["name"]), URL)
    by_year = spots(pdf_text(url))
    for y in YEARS:
        print(f"{y}: {sum(by_year.get(y, {}).values())} spots in {len(by_year.get(y, {}))} wards")
    figs = ward_figures(by_year)
    info = cell_dataset(region, list(records(ward_cells(region), figs)))
    print(f"{region}: {len(figs)} wards ever listed, {sum(1 for f in figs.values() if f['fs_years'] >= 4)} in 4+ monsoons; {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
