"""Recycling drop-off and waste processing sites per block (Bengaluru and Chennai; OpenCity maps, public domain).

Dataset ``waste_recovery`` (L7):

    recovery_centres    drop-off points for reusables, recyclables and e-waste (Bengaluru: BBMP's Reduce-Reuse-Recycle
                        centres and KSPCB e-waste collection centres; Chennai: GCC resource recovery centres)
    processing_sites    wet-waste processing sites (Chennai: GCC compost yards, vermicompost, biogas and biomethanisation
                        plants; KSPCB's biomedical waste facilities all lie outside the Bengaluru map)

Only coordinates are read.

    python -m pipeline.realestate.recycling [--region bengaluru,chennai]
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.servicecentres import coords

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
KSPCB = "karnataka-waste-collection-recycling-and-processing-centres"
GCC = "chennai-solid-waste-management-data"
SOURCES = {     # region: [(field, OpenCity dataset, resource name prefix)]
    "bengaluru": [("recovery_centres", "rrr-reduce-reuse-recycle-centres-in-bengaluru", "Map of RRR Centres"),
                  ("recovery_centres", KSPCB, "Karnataka - E-Waste Collection Centres")],
    "chennai": [("recovery_centres", GCC, "Chennai Resource Recovery Centres"),
                ("processing_sites", GCC, "Chennai Ordinary Compost Generation Plants"),
                ("processing_sites", GCC, "Chennai Vermi Compost Centres"),
                ("processing_sites", GCC, "Chennai Biogas Plants"),
                ("processing_sites", GCC, "Chennai Biomethanisation Plants")],
}


def records(kind_points, bbox):
    w, s, e, n = bbox
    seen = set()
    for kind, pts in kind_points:
        for lng, lat in pts:
            k = (kind, round(lng, 4), round(lat, 4))
            if w <= lng <= e and s <= lat <= n and k not in seen:
                seen.add(k)
                yield {"lat": lat, "lng": lng, kind: 1}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("recovery_centres", "Recycling and resource recovery drop-off centres", agg="sum", unit="centres", ramp="greens", higher_is="better"),
             FieldSpec("processing_sites", "Wet-waste processing sites (compost, biogas)", agg="sum", unit="sites", ramp="reds", higher_is=None)]
    spec = DatasetSpec(
        id="waste_recovery", title="Recycling centres and waste processing sites", level=LEVEL, fields=specs, group="Real estate",
        description="Drop-off centres for reusables, recyclables and e-waste, and waste processing sites, from the BBMP RRR "
                    "centre and KSPCB maps (Bengaluru) and Greater Chennai Corporation's solid waste maps (2022) on "
                    "data.opencity.in.",
        source="pipeline/realestate/recycling.py (OpenCity BBMP, KSPCB and GCC maps)",
        license="Public domain (BBMP, KSPCB and Greater Chennai Corporation via data.opencity.in)", default_field="recovery_centres", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.newroads import resource_url
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    for region in ap.parse_args(argv).region.split(","):
        kp = [(kind, coords(requests.get(resource_url(pkg, name), timeout=300).content.decode("utf-8-sig"))) for kind, pkg, name in SOURCES[region]]
        recs = list(records(kp, bbox_for(region)))
        info = cell_dataset(region, recs)
        print(f"{region}: {({k: sum(1 for r in recs if k in r) for k in ('recovery_centres', 'processing_sites')})}, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
