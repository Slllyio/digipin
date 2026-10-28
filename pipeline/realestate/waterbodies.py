"""Ponds, tanks and lakes from India's first Census of Water Bodies (OpenCity, public domain).

Per L7 block (dataset ``water_bodies``):

    bodies        water bodies the census lists in the block
    not_in_use    of them, not in use (dried, silted or abandoned)
    encroached    of them, encroached
    public_pct    share owned by a government body (panchayat, municipality, state, other agency)
    capacity_m3   storage capacity when full

Census of Water Bodies (Ministry of Jal Shakti, 2023; data as of 2018-19) maps for Delhi, Kolkata, Hyderabad (with the
Rangareddy map and the Telangana state maps clipped to the region) and Bengaluru (Bengaluru Urban plus the Karnataka
map clipped to the region). Tamil Nadu and Maharashtra maps carry a non-commercial licence, so Chennai, Mumbai and
Pune are left out.

    python -m pipeline.realestate.waterbodies --region delhi,kolkata,hyderabad,bengaluru
"""
from __future__ import annotations

import argparse
import os
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
SOURCES = {
    "delhi": ["0e089da2-53bc-4751-a919-7d6f95f72784/resource/0d3882a6-4d4e-4d67-87fc-d23729b1f6eb/download/b4219512-7105-4227-9c95-9bdf64020799.kml"],
    "kolkata": ["d9c9b5e1-01e2-4fa4-8c7c-ff335d327f96/resource/8b4faaae-746e-4079-8d08-93c54fa04956/download/bdb7e96d-acaf-442c-9488-b9f8297404ca.kml"],
    "hyderabad": ["037dc191-1419-4242-a6c1-0dcbfecae600/resource/4b7fe252-8d3c-4a1b-8f50-eccb3caf3269/download/e94a1948-f2a6-4661-9243-750e55616d3d.kml",
                  "037dc191-1419-4242-a6c1-0dcbfecae600/resource/41640ad7-31f8-4e26-8366-bc19b0ded63e/download/5f24f421-adc5-40a9-a365-2378b8978970.kml",
                  "037dc191-1419-4242-a6c1-0dcbfecae600/resource/59bedc0d-8291-4bb0-9458-879379f16772/download/a45aa734-60b1-40e9-b1bb-333f969e7c3e.kml",
                  "037dc191-1419-4242-a6c1-0dcbfecae600/resource/313092ff-7f7e-4584-9aff-542969f8fe35/download/fd1a0e75-b949-45f5-ae67-fd20a25a1083.kml"],
    "bengaluru": ["97448b4d-9154-4342-9db0-4198f52baca3/resource/bab6a73b-c237-4808-b982-6624bda036b0/download/f76d1d1c-0360-4a44-a9f9-7f8b5e3fe4f9.kml",
                  "97448b4d-9154-4342-9db0-4198f52baca3/resource/88187824-6dba-4ec2-9973-6f0e3ec85ecc/download/b6a59e3c-9b29-4844-babe-3d22498bd967.kml"],
}
PUBLIC = ("panchayat", "muncipal", "municipal", "govt", "state", "central")


def placemarks(path):
    """Yield the SimpleData attributes of each Placemark in a KML file, streaming (state maps run to 60 MB)."""
    import xml.etree.ElementTree as ET
    tag = lambda e: e.tag.rsplit("}", 1)[-1]
    for _, el in ET.iterparse(path, events=("end",)):
        if tag(el) != "Placemark":
            continue
        yield {d.get("name"): (d.text or "").strip() for d in el.iter() if tag(d) == "SimpleData"}
        el.clear()


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def records(rows, bbox, seen):
    for p in rows:
        lng, lat = _f(p.get("longitude")), _f(p.get("latitude"))
        if lng is None or lat is None or not (bbox[0] <= lng <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            continue
        uid = p.get("unique_id") or (round(lng, 5), round(lat, 5))
        if uid in seen:
            continue
        seen.add(uid)
        own = (p.get("water_body_ownership") or "").lower()
        rec = {"lat": lat, "lng": lng, "bodies": 1,
               "not_in_use": 1 if (p.get("waterbody_use_notuse") or "").lower() == "no" else 0,
               "encroached": 1 if (p.get("waterbody_encroached") or "").lower() == "yes" else 0,
               "public_pct": 100.0 if any(w in own for w in PUBLIC) else 0.0}
        cap = _f(p.get("storage_capacity_water_body_ori"))
        if cap and cap > 0:
            rec["capacity_m3"] = cap
        yield rec


def download(path, dst):
    import requests
    for attempt in range(4):
        try:
            with requests.get(OPENCITY + path, stream=True, timeout=900) as r, open(dst, "wb") as f:
                r.raise_for_status()
                f.writelines(r.iter_content(1 << 20))
            return
        except (requests.RequestException, OSError):
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("bodies", "Water bodies (census)", agg="sum", unit="ponds/tanks/lakes", ramp="blues", higher_is="better"),
        FieldSpec("not_in_use", "Water bodies not in use", agg="sum", unit="water bodies", ramp="reds", higher_is="worse"),
        FieldSpec("encroached", "Water bodies encroached", agg="sum", unit="water bodies", ramp="reds", higher_is="worse"),
        FieldSpec("public_pct", "Publicly owned share", agg="mean", unit="%", ramp="blues", higher_is="better"),
        FieldSpec("capacity_m3", "Storage capacity when full", agg="sum", unit="m³", ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="water_bodies", title="Water bodies census", level=LEVEL, fields=specs, group="Real estate",
        description="Ponds, tanks and lakes from India's first Census of Water Bodies (Ministry of Jal Shakti, 2023) on "
                    "data.opencity.in, counted per block with how many are not in use or encroached, who owns them and how much "
                    "they hold: Delhi, Kolkata, Hyderabad and Bengaluru.",
        source="pipeline/realestate/waterbodies.py (OpenCity water bodies census maps)",
        license="Public domain (Ministry of Jal Shakti via data.opencity.in)", default_field="bodies", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    ap.add_argument("--from-dir", help="read the KMLs (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        bbox, seen, recs = bbox_for(r), set(), []
        with tempfile.TemporaryDirectory() as tmp:
            for path in SOURCES[r]:
                name = path.rsplit("/", 1)[-1]
                src = os.path.join(a.from_dir, name) if a.from_dir and os.path.exists(os.path.join(a.from_dir, name)) else os.path.join(tmp, name)
                if not os.path.exists(src):
                    download(path, src)
                recs += list(records(placemarks(src), bbox, seen))
        # Bengaluru Urban's map marks every tank "not in use" and "not encroached": a blank default, not an answer.
        if recs and all(x["not_in_use"] for x in recs) and not any(x["encroached"] for x in recs):
            for x in recs:
                del x["not_in_use"], x["encroached"]
            print(f"{r}: use and encroachment flags are uniform defaults; kept counts only")
        info = cell_dataset(r, recs)
        print(f"{r}: {len(recs)} water bodies, {sum(x.get('not_in_use', 0) for x in recs)} not in use, "
              f"{sum(x.get('encroached', 0) for x in recs)} encroached, in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
