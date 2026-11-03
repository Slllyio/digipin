"""Recorded landslides per block (NASA Global Landslide Catalog 1970-2019 via the awesome-gee catalog, public).

Dataset ``landslides`` (L7):

    landslides         rainfall-triggered landslides the catalog places in the block
    landslide_deaths   people killed in them

    python -m pipeline.realestate.landslides [--region mumbai,...]
"""
from __future__ import annotations

import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
ASSET = "projects/sat-io/open-datasets/events/global_landslide_1970-2019"
REGIONS = ["mumbai", "bengaluru", "chennai", "hyderabad", "delhi", "kolkata", "jaipur", "ahmedabad"]


def records(features):
    for f in features:
        p = f.get("properties") or {}
        try:
            lat, lng = float(p["latitude"]), float(p["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        try:
            deaths = max(0, int(float(p.get("fatality_c") or 0)))
        except (TypeError, ValueError):
            deaths = 0
        yield {"lat": lat, "lng": lng, "landslides": 1, "landslide_deaths": deaths}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("landslides", "Recorded landslides, 1970-2019", agg="sum", unit="events", ramp="reds", higher_is="worse"),
             FieldSpec("landslide_deaths", "Deaths in recorded landslides, 1970-2019", agg="sum", unit="people", ramp="reds", higher_is="worse")]
    spec = DatasetSpec(
        id="landslides", title="Recorded landslides (NASA Global Landslide Catalog)", level=LEVEL, fields=specs, group="Environment",
        description="Rainfall-triggered landslides compiled from news, official and scientific reports by NASA's Global "
                    "Landslide Catalog, 1970-2019, with reported deaths.",
        source="pipeline/realestate/landslides.py (NASA GLC via the awesome-gee-community-catalog)",
        license="Public (NASA Goddard Space Flight Center)", default_field="landslides", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import bbox_for
    from pipeline.cells import earthengine as gee
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(REGIONS))
    ee = gee.init()
    fc = ee.FeatureCollection(ASSET)
    for region in ap.parse_args(argv).region.split(","):
        w, s, e, n = bbox_for(region)
        feats = fc.filterBounds(ee.Geometry.Rectangle([w, s, e, n])).getInfo()["features"]
        recs = list(records(feats))
        if not recs:
            print(f"{region}: no recorded landslides")
            continue
        info = cell_dataset(region, recs)
        print(f"{region}: {len(recs)} landslides, {sum(r['landslide_deaths'] for r in recs)} deaths, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
