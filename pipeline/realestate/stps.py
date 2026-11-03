"""Sewage treatment plants per block from the water boards' and corporations' maps (OpenCity, public domain).

Per L7 block (dataset ``stps``):

    stps           sewage treatment plants (working or built)
    capacity_mld   their treatment capacity, million litres a day
    proposed       plants proposed but not yet built (PMC, Pune)

Maps: BWSSB's STP list with coordinates and capacity (Bengaluru, 39 plants), CMWSSB's STP outlines (Chennai) and PMC's
existing and proposed STP outlines (Pune). Outlines are placed at their centre; one plant drawn as several outlines
counts once (same id or name).

    python -m pipeline.realestate.stps --region bengaluru,chennai,pune
"""
from __future__ import annotations

import argparse
import csv
import io
import re
from pathlib import Path

from pipeline.realestate.parksofficial import centroid

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
SOURCES = {
    "bengaluru": OPENCITY + "de97d604-7791-43d1-8572-e460cd520ba0/resource/5b40965d-152d-4d09-a3f2-d5858f1a2e01/download/242994a9-af09-4a01-bbb7-aa6dfedd5541.csv",
    "chennai": OPENCITY + "fd44b214-c5a2-42b2-b622-aa949aad9c4d/resource/0a02f27d-f2b4-48f2-ac51-0ac4d250de2f/download/c548786e-91cf-4a9e-bc77-e2b30903ec3d.kml",
    "pune": OPENCITY + "eb12f642-e1bb-4475-840e-4c4746d98fe0/resource/8a81eb8d-de2b-4842-b3fd-c74cc44fdff4/download/9beb555b-b3b8-4f3b-947c-b33ba33615a5.kml",
}
PLACEMARK = re.compile(r"<Placemark\b[^>]*>(.*?)</Placemark>", re.S)
DATA = re.compile(r'<SimpleData name="(\w+)">([^<]*)<')
OUTER = re.compile(r"<outerBoundaryIs>.*?<coordinates>\s*([^<]+?)\s*</coordinates>", re.S)


def bwssb(text):
    """(lng, lat, capacity_mld, proposed) per plant in BWSSB's CSV (capacity in KLD)."""
    for r in csv.DictReader(io.StringIO(text)):
        try:
            lat, lng = float(r["Latitude"]), float(r["Longitude"])
        except (KeyError, ValueError):
            continue
        kld = r.get("TreatmentCapacity (KLD)") or ""
        yield lng, lat, (float(kld) / 1000 if kld.replace(".", "", 1).isdigit() else 0.0), False


def outlines(text):
    """(lng, lat, capacity_mld, proposed) per plant from CMWSSB or PMC outlines; repeated ids or names count once."""
    seen = set()
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        p = dict(DATA.findall(body))
        key = (p.get("stp_id") or p.get("Unique_ID") or p.get("stp_name") or p.get("STP_Name") or "").strip()
        rings = [r for r in ([tuple(map(float, q.split(",")[:2])) for q in o.split()] for o in OUTER.findall(body)) if len(r) >= 3]
        if not rings or (key and key in seen):
            continue
        seen.add(key)
        lng, lat = centroid(max(rings, key=len))
        cap = p.get("installed_capacity_mld") or p.get("STP_Capaci") or ""
        try:
            mld = float(cap)
        except ValueError:
            mld = 0.0
        yield lng, lat, mld, (p.get("Category") or "").lower().startswith("proposed")


def records(plants):
    for lng, lat, mld, proposed in plants:
        yield {"lat": lat, "lng": lng, **({"proposed": 1} if proposed else {"stps": 1, "capacity_mld": mld})}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("stps", "Sewage treatment plants", agg="sum", unit="plants", ramp="reds", higher_is="worse"),
        FieldSpec("capacity_mld", "Sewage treatment capacity", agg="sum", unit="MLD", ramp="reds", higher_is="worse"),
        FieldSpec("proposed", "Proposed sewage treatment plants (PMC)", agg="sum", unit="plants", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="stps", title="Sewage treatment plants (water board maps)", level=LEVEL, fields=specs, group="Environment",
        description="Sewage treatment plants from the water boards' and corporations' maps on data.opencity.in: BWSSB's STP list "
                    "with capacity (Bengaluru), CMWSSB's STP outlines (Chennai) and PMC's existing and proposed STPs (Pune).",
        source="pipeline/realestate/stps.py (OpenCity BWSSB, CMWSSB and PMC STP maps)",
        license="Public domain (BWSSB, CMWSSB and PMC via data.opencity.in)", default_field="capacity_mld", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        text = requests.get(SOURCES[r], timeout=300).content.decode("utf-8-sig")
        plants = list(bwssb(text) if r == "bengaluru" else outlines(text))
        info = cell_dataset(r, list(records(plants)))
        built = [p for p in plants if not p[3]]
        print(f"{r}: {len(built)} plants, {sum(p[2] for p in built):.0f} MLD, {len(plants) - len(built)} proposed, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
