"""Schools from official education department maps (OpenCity, public domain): Mumbai (BMC) and Hyderabad (Telangana).

Per L7 block (dataset ``schools_official``):

    schools     schools listed in the block (all three maps, the same site counted once)
    municipal   government schools: BMC municipal schools (Mumbai); state, local body (MPP/ZPP), central, welfare
                and residential society schools (Hyderabad, Telangana school education department map with management)
    aided       private aided schools
    unaided     private unaided schools

The lens loader tops up ``emergency_access.schools`` (OpenStreetMap) with whichever source lists more per block, so
the school-run, relief-camp and school-safety lenses see BMC's list.

    python -m pipeline.realestate.bmcschools [--region mumbai,hyderabad]
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/12b66346-5f5e-4980-bdea-b41465f3c883/resource/"
MAPS = {
    "municipal": "c5a238c6-69d5-49ed-a1b1-812ca4037697/download/a1e7a777-bf13-4799-8cfe-09a46247aed9.kml",
    "aided": "f92e6632-c921-4645-9abc-d4cbbeedd74a/download/8c3cb0d6-b9c9-43f3-be85-8d167f83518c.kml",
    "unaided": "c0ad04ae-156a-4b7d-a943-609d16d07d91/download/04e77044-423a-404c-b432-19dee5b96a47.kml",
}


BBOX = {"mumbai": (72.7, 18.85, 73.1, 19.35)}


def ts_kind(management):
    """Telangana UDISE management -> municipal (government) / aided / unaided / None (unrecognised)."""
    m = (management or "").strip().lower()
    if m.startswith("pvt.aided"):
        return "aided"
    if m.startswith("pvt.unaided"):
        return "unaided"
    if "unrecognized" in m or not m:
        return None
    return "municipal"


def ts_points(text, bbox):
    """{kind: [(lng, lat, {})]} from the Telangana schools KML, clipped to bbox (names and phone fields never read)."""
    import re
    w, s, e, n = bbox
    out = {"municipal": [], "aided": [], "unaided": [], "other": []}
    for pm in re.finditer(r"<Placemark.*?</Placemark>", text, re.S):
        p = pm.group(0)
        xy = re.search(r"<coordinates>\s*([^<]+?)\s*</coordinates>", p)
        mg = re.search(r'name="Management">([^<]*)<', p)
        if not xy:
            continue
        x, y = map(float, xy.group(1).split(",")[:2])
        if w <= x <= e and s <= y <= n:
            out[ts_kind(mg.group(1) if mg else "") or "other"].append((x, y, {}))
    return out


def records(by_kind, bbox=BBOX["mumbai"]):
    """One record per school site: several schools (shifts, mediums) in one building count as one site in `schools`."""
    seen = set()
    for kind, pts in by_kind.items():
        for lng, lat, _ in pts:
            if not (bbox[0] < lng < bbox[2] and bbox[1] < lat < bbox[3]):
                continue
            k = (round(lng, 4), round(lat, 4))
            rec = {"lat": lat, "lng": lng, "schools": 0 if k in seen else 1}
            if kind != "other":
                rec[kind] = 1
            seen.add(k)
            yield rec


def cell_dataset(by_kind, region="mumbai", bbox=BBOX["mumbai"]):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("schools", "School sites (education department maps)", agg="sum", unit="sites", ramp="blues", higher_is="better"),
        FieldSpec("municipal", "Government and municipal schools", agg="sum", unit="schools", ramp="blues", higher_is="better"),
        FieldSpec("aided", "Private aided schools", agg="sum", unit="schools", ramp="blues", higher_is="better"),
        FieldSpec("unaided", "Private unaided schools", agg="sum", unit="schools", ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="schools_official", title="Schools (education department maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Schools from education department maps on data.opencity.in (Mumbai: BMC municipal, private aided and "
                    "unaided maps; Hyderabad: Telangana school education department map with management): government, "
                    "private aided and private unaided, counted per block (a building housing several schools is one site).",
        source="pipeline/realestate/bmcschools.py (OpenCity Mumbai and Telangana school maps)",
        license="Public domain (BMC and Telangana via data.opencity.in)", default_field="schools", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(records(by_kind, bbox), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.newroads import resource_url
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="mumbai,hyderabad")
    for region in ap.parse_args(argv).region.split(","):
        if region == "mumbai":
            bbox = BBOX["mumbai"]
            by_kind = {k: kml_points(requests.get(OPENCITY + p, timeout=300).content.decode("utf-8-sig")) for k, p in MAPS.items()}
        else:
            bbox = bbox_for(region)
            by_kind = ts_points(requests.get(resource_url("hyderabad-schools", "Hyderabad Schools"), timeout=900).content.decode("utf-8-sig"), bbox)
        info = cell_dataset(by_kind, region, bbox)
        print(f"{region}: " + ", ".join(f"{len(v)} {k}" for k, v in by_kind.items()) + f" schools in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
