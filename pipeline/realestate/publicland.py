"""Land the city corporation owns, per block (Bengaluru; GBA property register on OpenCity, public domain).

Dataset ``public_land`` (L7):

    gba_plots       properties on the Greater Bengaluru Authority's property register in the block
    gba_land_m2     their recorded area
    vacant_plots    of them, recorded as vacant land (ಖಾಲಿ ಜಾಗ), including undeveloped park plots
    vacant_m2       their area
    amenity_plots   of them, used for a school, clinic, anganwadi, library, community hall, toilet or market

Only rows the register geolocates to the plot (Quality ``unique``) are used; ``approximate`` rows sit on about 200
shared points (ward or locality centres) and are dropped. The register's Kannada property descriptions are matched to
uses by keyword; nothing else is kept.

    python -m pipeline.realestate.publicland
"""
from __future__ import annotations

import argparse
import csv
import io
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "gba-properties-list"
VACANT = re.compile(r"ಖಾಲಿ ?ಜಾಗ|ಖಾಲಿ ನಿವೇಶನ|vacant", re.I)
AMENITY = re.compile(r"ಶಾಲೆ|school|ಆಸ್ಪತ್ರೆ|ಆರೋಗ್ಯ|ಡಿಸ್ಪೆನ್ಸರಿ|hospital|clinic|dispensary|ಅಂಗನವಾಡಿ|ಗ್ರಂಥಾಲಯ|library|ಸಮುದಾಯ ಭವನ|"
                     r"community hall|ಶೌಚಾಲಯ|toilet|ಮಾರುಕಟ್ಟೆ|market", re.I)


def records(rows, bbox):
    w, s, e, n = bbox
    for x in rows:
        if (x.get("Quality") or "").strip() != "unique":
            continue
        try:
            lat, lng = float(x["Latitude"]), float(x["Longitude"])
        except (KeyError, ValueError):
            continue
        if not (w <= lng <= e and s <= lat <= n):
            continue
        try:
            m2 = max(0.0, float(x.get("Area (sq. m)") or 0))
        except ValueError:
            m2 = 0.0
        d = x.get("Property Details") or ""
        rec = {"lat": lat, "lng": lng, "gba_plots": 1, "gba_land_m2": m2}
        if VACANT.search(d):
            rec.update(vacant_plots=1, vacant_m2=m2)
        elif AMENITY.search(d):
            rec["amenity_plots"] = 1
        yield rec


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("gba_plots", "Corporation-owned properties", agg="sum", unit="plots", ramp="blues", higher_is=None),
             FieldSpec("gba_land_m2", "Corporation-owned land (recorded area)", agg="sum", unit="m²", ramp="blues", higher_is=None),
             FieldSpec("vacant_plots", "Vacant corporation plots", agg="sum", unit="plots", ramp="greens", higher_is=None),
             FieldSpec("vacant_m2", "Vacant corporation land (recorded area)", agg="sum", unit="m²", ramp="greens", higher_is=None),
             FieldSpec("amenity_plots", "Corporation plots used for schools, clinics and other services", agg="sum", unit="plots", ramp="blues", higher_is=None)]
    spec = DatasetSpec(
        id="public_land", title="Corporation-owned land (GBA property register)", level=LEVEL, fields=specs, group="Real estate",
        description="Properties on the Greater Bengaluru Authority's 2026 property register (data.opencity.in) that the register "
                    "geolocates to the plot: count, recorded area, vacant land and plots used for public services.",
        source="pipeline/realestate/publicland.py (OpenCity GBA properties list)",
        license="Public domain (Greater Bengaluru Authority via data.opencity.in)", default_field="gba_land_m2", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    p = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": PACKAGE}, timeout=60).json()["result"]
    url = next(r["url"] for r in p["resources"] if r["format"] == "CSV")
    rows = list(csv.DictReader(io.StringIO(requests.get(url, timeout=300).content.decode("utf-8-sig"))))
    recs = list(records(rows, bbox_for("bengaluru")))
    info = cell_dataset("bengaluru", recs)
    print(f"bengaluru: {len(recs)} of {len(rows)} properties, {sum(1 for r in recs if 'vacant_plots' in r)} vacant "
          f"({sum(r.get('vacant_m2', 0) for r in recs) / 1e4:.1f} ha), {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
