"""Local power cuts seen from space: nights a block went dark while the rest of the city stayed lit (NASA Black Marble).

Per L6 block (dataset ``blackouts``), over YEARS of VIIRS Black Marble daily night lights (VNP46A2, BRDF- and
moonlight-corrected), keeping only high-quality, cloud-free nights (Mandatory_Quality_Flag 0):

    dark_nights_pct  share of good nights on which the block's lights fell below DARK_RATIO of its own median while
                     the city's median block stayed normal: lights relative to the block's median, divided by that
                     night's citywide median of the same ratio, below DARK_RATIO. Normalising by the city removes haze,
                     thin cloud and festival nights that dim or brighten everything at once.
    good_nights      nights with a high-quality retrieval at the block
    lit_nw           median radiance of the good nights (nW/cm²/sr); blocks below MIN_LIT are left out

Black Marble pixels are ~500 m, so the dataset is at L6 (~1 km). A dark night can also be a sensor artefact or
switched-off street lighting, so read a high share as "check the feeder log", not a measured outage.

    python -m pipeline.realestate.blackouts --region all
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.cells import earthengine as gee
from pipeline.cells import store
from pipeline.cells.schema import DatasetSpec, FieldSpec

CELLS = Path(__file__).resolve().parents[2] / "data" / "cells"
LEVEL = 6
YEARS = (2023, 2024)
DARK_RATIO = 0.5
MIN_LIT = 5.0
SCALE_M = 500


def image(region):
    ee = gee.init()
    w, s, e, n = bbox_for(region)
    geom = ee.Geometry.Rectangle([w, s, e, n])
    col = ee.ImageCollection("NASA/VIIRS/002/VNP46A2").filterDate(f"{YEARS[0]}-01-01", f"{YEARS[1] + 1}-01-01").filterBounds(geom)

    def good(im):
        q = im.select("Mandatory_Quality_Flag").eq(0)
        return im.select("DNB_BRDF_Corrected_NTL").updateMask(q).rename("ntl").copyProperties(im, ["system:time_start"])

    goods = col.map(good)
    med = goods.median().rename("med")
    lit = med.gte(MIN_LIT)

    def night(im):
        ratio = im.select("ntl").divide(med).updateMask(lit)
        city = ratio.reduceRegion(ee.Reducer.median(), geom, SCALE_M * 2, maxPixels=1e8, bestEffort=True).get("ntl")
        rel = ratio.divide(ee.Number(ee.Algorithms.If(city, city, 1)))
        valid = rel.mask().rename("valid")
        dark = rel.lt(DARK_RATIO).unmask(0).updateMask(valid).rename("dark")
        return ee.Image.cat([valid.unmask(0).updateMask(lit), dark.unmask(0).updateMask(lit)]).float()

    nights = goods.map(night)
    valid_n = nights.select("valid").sum().rename("good_nights")
    dark_n = nights.select("dark").sum()
    pct = dark_n.divide(valid_n.max(1)).multiply(100).rename("dark_nights_pct")
    return ee.Image.cat([pct, valid_n, med.updateMask(lit).rename("lit_nw")]), (w, s, e, n)


def bake(region):
    img, bbox = image(region)
    raw = gee.fetch(gee.to_cells(img, SCALE_M), bbox, LEVEL)
    rows = {}
    for code, x in raw.items():
        p, g, m = x.get("dark_nights_pct"), x.get("good_nights"), x.get("lit_nw")
        if p is None or m is None or g is None or g < 20:
            continue
        rows[code] = {"dark_nights_pct": gee.r(p, 1), "good_nights": round(g), "lit_nw": gee.r(m, 1)}
    return rows


def cell_dataset(region, rows):
    specs = [
        FieldSpec("dark_nights_pct", "Nights the block went dark while the city stayed lit", agg="mean", unit="% of good nights",
                  domain=[0, 20], ramp="reds", higher_is="worse"),
        FieldSpec("good_nights", f"Cloud-free, high-quality nights {YEARS[0]}-{YEARS[1]}", agg="mean", unit="nights", ramp="viridis",
                  higher_is=None),
        FieldSpec("lit_nw", "Median night-time radiance on good nights", agg="mean", unit="nW/cm²/sr", domain=[0, 80], ramp="heat",
                  higher_is=None),
    ]
    spec = DatasetSpec(
        id="blackouts", title="Local power cuts from night lights (NASA Black Marble)", level=LEVEL, fields=specs, group="Hazards",
        description=f"NASA Black Marble VNP46A2 daily night lights ({YEARS[0]}-{YEARS[1]}, BRDF and moonlight corrected), "
                    f"high-quality cloud-free nights only. A night counts as dark for a lit block (median {MIN_LIT}+ nW/cm²/sr) "
                    f"when its radiance relative to its own median falls below {DARK_RATIO} of that night's citywide median "
                    "ratio, so haze and thin cloud that dim the whole city cancel out. About 500 m pixels, so ~1 km blocks. "
                    "Sensor artefacts and street lights switched off also count; a high share is a lead to check with "
                    "the distribution company, not a measured outage.",
        source="pipeline/realestate/blackouts.py (NASA Black Marble VNP46A2 via Earth Engine)",
        license="Public domain (NASA LAADS DAAC; cite Román et al. 2018)", default_field="dark_nights_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region,
                               store.bin_records(({"digipin": c, **r} for c, r in rows.items()), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = bake(r)
        vals = sorted(x["dark_nights_pct"] for x in rows.values())
        mid = vals[len(vals) // 2] if vals else 0
        print(f"{r}: {len(rows)} lit blocks, median {mid}% dark nights, top {vals[-1] if vals else 0}%")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
