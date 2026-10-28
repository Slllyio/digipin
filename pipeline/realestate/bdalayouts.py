"""BDA layout per block from the Bangalore Development Authority's layout boundary map (OpenCity, public domain).

Per L7 block (dataset ``bda_layouts``):

    layout       the BDA-formed layout whose boundary holds the block centre (Arkavathy, Banashankari 6th Stage, ...)
    layout_id    BDA's layout code, a number the lenses can group by
    layout_km2   area of the whole layout (all its parts), km2

Map: BDA's layout boundaries (149 outlines of about 70 layouts). Plots in a BDA layout were acquired and allotted by
the BDA, so their title runs back to the authority rather than to a private or revenue layout. Every block of the
region (not only lived-in ones) is checked, so empty layouts show up.

    python -m pipeline.realestate.bdalayouts
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline.realestate.pincodes import area_km2

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/a3b7e6cf-c7c8-4285-abb8-0d1a0790c2da/resource/4020321c-a59f-4a18-9741-1cfb109ed3ba/"
       "download/a0d357a9-8b26-445e-ad2f-f21997c60b97.kml")


def title(s):
    s = " ".join((s or "").replace("EXTENSTION", "EXTENSION").split())
    return " ".join(w if any(ch.isdigit() for ch in w) and not w[0].isdigit() else w.capitalize() for w in s.split()) or None


def layouts(text):
    """[(name, code, geometry, km2 of the whole layout)]: parts of one layout share its code and total area."""
    from pipeline.realestate.wards import kml_features
    parts = []
    for f in kml_features(text):
        p = f["properties"]
        try:
            code = int(p.get("LayoutCode"))
        except (TypeError, ValueError):
            continue
        parts.append((title(p.get("LAYOUT_NAME")), code, f["geometry"], area_km2(f["geometry"])))
    total = {}
    for _, code, _, km2 in parts:
        total[code] = total.get(code, 0.0) + km2
    return [(name, code, g, round(total[code], 2)) for name, code, g, _ in parts]


def region_cells(region, dataset="built_up"):
    """(code, lat, lng) for every block a whole-region dataset holds."""
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    d = next(x for x in cat["datasets"] if x["id"] == dataset)
    entry = next(r for r in d["regions"] if r["name"] == region)
    out = []
    for c in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(c)
        out.append((c, (b["south"] + b["north"]) / 2, (b["west"] + b["east"]) / 2))
    return out


def rows(cells, lay):
    from pipeline.realestate.registration import assign
    got = assign(cells, [(None, None, x[2]) for x in lay])
    return {c: {"layout": lay[k][0], "layout_id": lay[k][1], "layout_km2": lay[k][3]} for c, k in got.items()}


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("layout", "BDA layout", type="category", agg="mode"),
        FieldSpec("layout_id", "BDA layout code", agg="max", unit="", ramp="viridis", higher_is="better"),
        FieldSpec("layout_km2", "Area of the BDA layout", agg="mean", unit="km2", ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="bda_layouts", title="BDA layouts (Bangalore Development Authority)", level=LEVEL, fields=specs, group="Real estate",
        description="The Bangalore Development Authority layout (if any) whose boundary holds each block, its BDA code and the "
                    "layout's area, from BDA's layout boundary map on data.opencity.in.",
        source="pipeline/realestate/bdalayouts.py (OpenCity BDA layout boundaries via DuckDB spatial)",
        license="Public domain (BDA via data.opencity.in)", default_field="layout_id", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--map", help="the downloaded KML (fetched when left out)")
    a = ap.parse_args(argv)
    text = open(a.map, encoding="utf-8-sig").read() if a.map else requests.get(URL, timeout=300).content.decode("utf-8-sig")
    lay = layouts(text)
    got = rows(region_cells("bengaluru"), lay)
    info = cell_dataset("bengaluru", got)
    print(f"bengaluru: {len({x[1] for x in lay})} layouts, {len({v['layout_id'] for v in got.values()})} over {len(got)} blocks, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
