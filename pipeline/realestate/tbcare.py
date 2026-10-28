"""TB care sites per block (Bengaluru; Karnataka health department maps on KGIS via OpenCity, public domain).

Dataset ``tb_care`` (L7):

    tb_units       National TB Elimination Programme TB units (sub-district treatment and reporting centres)
    tb_tests       CBNAAT molecular testing sites (rapid TB and rifampicin-resistance tests)
    drtb_centres   drug-resistant TB centres and district TB centres
    nrc            nutrition rehabilitation centres (severe acute malnutrition in children; same map set)

    python -m pipeline.realestate.tbcare
"""
from __future__ import annotations

import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "karnataka-tuberculosis-centres"
SOURCES = [     # (field, resource name prefix)
    ("tb_units", "Karnataka Tuberculosis Units"),
    ("tb_tests", "Karnataka CBNAAT Centres"),
    ("drtb_centres", "Karnataka Drug Resistant TB Centres"),
    ("drtb_centres", "Karnataka District Tuberculosis Centres"),
    ("nrc", "Karnataka Nutrition Rehabilitation"),
]


def records(kind_points, bbox):
    w, s, e, n = bbox
    seen = set()
    for kind, pts in kind_points:
        for lng, lat, _ in pts:
            k = (kind, round(lng, 4), round(lat, 4))
            if not (w <= lng <= e and s <= lat <= n) or k in seen:
                continue
            seen.add(k)
            yield {"lat": lat, "lng": lng, kind: 1}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("tb_units", "TB units (NTEP)", agg="sum", unit="units", ramp="greens", higher_is="better"),
             FieldSpec("tb_tests", "CBNAAT rapid TB testing sites", agg="sum", unit="sites", ramp="greens", higher_is="better"),
             FieldSpec("drtb_centres", "Drug-resistant and district TB centres", agg="sum", unit="centres", ramp="greens", higher_is="better"),
             FieldSpec("nrc", "Nutrition rehabilitation centres", agg="sum", unit="centres", ramp="greens", higher_is="better")]
    spec = DatasetSpec(
        id="tb_care", title="TB care sites (Karnataka health maps)", level=LEVEL, fields=specs, group="Real estate",
        description="TB units, CBNAAT testing sites, drug-resistant and district TB centres and nutrition rehabilitation "
                    "centres from the Karnataka health department's KGIS maps on data.opencity.in.",
        source="pipeline/realestate/tbcare.py (OpenCity Karnataka TB centre maps)",
        license="Public domain (Karnataka health department via data.opencity.in)", default_field="tb_units", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.newroads import resource_url
    from pipeline.realestate.toilets import kml_points
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    kp = [(kind, kml_points(requests.get(resource_url(PACKAGE, name), timeout=300).content.decode("utf-8-sig"))) for kind, name in SOURCES]
    recs = list(records(kp, bbox_for("bengaluru")))
    info = cell_dataset("bengaluru", recs)
    counts = {k: sum(1 for r in recs if k in r) for k, _ in SOURCES}
    print(f"bengaluru: {counts}, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
