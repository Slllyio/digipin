"""Floods reported in the news per block (Groundsource 2026, Google Research, CC BY 4.0).

Per L7 block (dataset ``news_floods``):

    flood_news_days     distinct days with a news-reported flood located in the block, 2000 to March 2026
    flood_news_recent   of them, days since 2021
    flood_news_last     year of the latest reported flood

Groundsource extracts flooded places from news articles with Gemini and geocodes them with the Google Maps geocoder,
one record per place and day. Only records geocoded to a street, landmark or neighbourhood (footprint up to MAX_KM2)
are used, each at its footprint's centre; district- and city-wide records say nothing about a block. Coverage follows
the news: recent years and big cities are reported far more often, and quiet flooding goes unreported.

    python -m pipeline.realestate.newsfloods --region all
"""
from __future__ import annotations

import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
ASSET = "projects/sat-io/open-datasets/groundsource_2026"
MAX_KM2 = 2.0
RECENT = "2021"
PAGE = 4000


def fetch(bbox):
    """[(lng, lat, start_date)] for neighbourhood-scale records whose footprint centre lies in bbox."""
    from pipeline.cells import earthengine as gee
    ee = gee.init()
    w, s, e, n = bbox
    out = []

    def grab(box):
        fc = (ee.FeatureCollection(ASSET).filterBounds(ee.Geometry.Rectangle(list(box))).filter(ee.Filter.lte("area_km2", MAX_KM2))
              .map(lambda f: ee.Feature(f.geometry().centroid(10), {"d": f.get("start_date")})))
        if fc.size().getInfo() > PAGE:                 # getInfo caps at 5,000 features: split the box
            x0, y0, x1, y1 = box
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            for b in ((x0, y0, mx, my), (mx, y0, x1, my), (x0, my, mx, y1), (mx, my, x1, y1)):
                grab(b)
            return
        for f in fc.getInfo()["features"]:
            lng, lat = f["geometry"]["coordinates"][:2]
            if box[0] <= lng < box[2] and box[1] <= lat < box[3]:
                out.append((lng, lat, f["properties"].get("d") or ""))

    grab((w, s, e, n))
    return out


def rows(points):
    """{code: fields} from [(lng, lat, date)]: distinct days per block."""
    from pipeline.cells.store import cell_code
    days = {}
    for lng, lat, d in points:
        code = cell_code(LEVEL, lat, lng)
        if code and len(d) >= 10:
            days.setdefault(code, set()).add(d[:10])
    return {c: {"flood_news_days": len(ds), "flood_news_recent": sum(d >= RECENT for d in ds), "flood_news_last": int(max(ds)[:4])}
            for c, ds in days.items()}


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("flood_news_days", "Days with a news-reported flood in the block (2000 to 2026)", agg="sum", unit="days", domain=[0, 10], ramp="blues", higher_is="worse"),
        FieldSpec("flood_news_recent", "Of them, days since 2021", agg="sum", unit="days", domain=[0, 8], ramp="blues", higher_is="worse"),
        FieldSpec("flood_news_last", "Year of the latest reported flood", agg="max", unit="year", domain=[2005, 2026], ramp="blues", higher_is=None),
    ]
    spec = DatasetSpec(
        id="news_floods", title="Floods reported in the news (Groundsource)", level=LEVEL, fields=specs, group="Real estate",
        description="Days on which news reports placed a flood in the block, from Google Research's Groundsource (2026): flooded "
                    "places extracted from news articles by Gemini and geocoded, 2000 to March 2026. Only street, landmark and "
                    f"neighbourhood records (footprint up to {MAX_KM2:g} km²) are used. News coverage, not flood frequency: recent "
                    "years and busy areas are over-reported.",
        source="pipeline/realestate/newsfloods.py (Groundsource 2026 via the awesome-gee-community-catalog)",
        license="CC BY 4.0 (Mayo, Zlydenko et al. 2026, Groundsource)", default_field="flood_news_days", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS, bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        pts = fetch(bbox_for(r))
        rows_ = rows(pts)
        info = cell_dataset(r, rows_)
        print(f"{r}: {len(pts)} neighbourhood-scale records, {len(rows_)} blocks, {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
