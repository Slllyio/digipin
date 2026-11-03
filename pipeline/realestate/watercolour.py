"""River water colour from space: algae, mud and floating weeds on the rivers, canals and creeks of the 13 cities (Sentinel-2).

No open source measures BOD or coliform on most of the water people live next to: CPCB's NWMP samples a handful of
river and lake points per city, and its river tables are not published as open data. What a satellite can see is the
water's colour, and the colour of sewage-fed water is distinctive: green from algae fed by nutrients, brown from mud
and silt, and a solid green mat where water hyacinth and other floating weeds take over a stagnant lake or drain.

Lakes and tanks are already in ``lakes`` (pipeline lake health); this dataset keeps only blocks whose water the Copernicus
DEM water body mask calls river or canal, which ``lakes`` does not separate. Per L7 block (~250 m, dataset ``water_colour``)
holding permanent river water (JRC Global Surface Water occurrence of
OCC_MIN % or more), from the median of cloud-free Sentinel-2 scenes in the dry, pre-monsoon months (March-May of
YEARS):

    wc_water_pct  share of the block that is permanent water (the sea excluded with the Copernicus DEM water mask)
    wc_river      1: most of that water is river or canal in the same mask (blocks that are not are dropped)
    wc_weed_pct   share of that water covered by floating weeds or a dense bloom (NDVI WEED_NDVI or more)
    wc_ndci       Normalised Difference Chlorophyll Index on the open water (B5-B4)/(B5+B4): above ALGAE_NDCI points to
                  high chlorophyll (eutrophic, nutrient-rich water; Mishra & Mishra 2012)
    wc_ndti       Normalised Difference Turbidity Index (B4-B3)/(B4+B3): higher is muddier

These are colour indices, not lab measurements. Clear deep water and dark polluted water can look alike, shallow beds
and shadows add noise, and blocks with only a sliver of water are left out (MIN_WATER_PCT).

    python -m pipeline.realestate.watercolour --region all
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.cells import earthengine as gee
from pipeline.cells import store
from pipeline.cells.schema import DatasetSpec, FieldSpec

CELLS = Path(__file__).resolve().parents[2] / "data" / "cells"
LEVEL = 7
YEARS = (2024, 2025)
OCC_MIN = 60
WEED_NDVI = 0.3
OPEN_NDVI = 0.1
ALGAE_NDCI = 0.15
MIN_WATER_PCT = 5.0
SCALE_M = 20
TILE = 96


def image(region):
    ee = gee.init()
    w, s, e, n = bbox_for(region)
    geom = ee.Geometry.Rectangle([w, s, e, n])
    # Copernicus DEM's water body mask (0 land, 1 ocean, 2 lake, 3 river) keeps the sea, lagoons' open-sea side and
    # harbour basins out; JRC GSW alone counts the coastal sea as permanent water.
    wbm = ee.ImageCollection("COPERNICUS/DEM/GLO30").filterBounds(geom).select("WBM").mosaic().unmask(0)
    water = (ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence").gte(OCC_MIN).unmask(0)
             .And(wbm.neq(1)))
    river = water.And(wbm.eq(3)).rename("wc_river_pct").float()

    def clean(im):
        scl = im.select("SCL")
        ok = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11))
        return im.select(["B3", "B4", "B5", "B8"]).updateMask(ok)

    parts = [ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(geom)
             .filterDate(f"{y}-03-01", f"{y}-06-01").filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 40)).map(clean)
             for y in YEARS]
    col = parts[0]
    for p in parts[1:]:
        col = col.merge(p)
    med = col.median().divide(10000)
    ndvi = med.normalizedDifference(["B8", "B4"])
    wet = water.selfMask()
    weed = ndvi.gte(WEED_NDVI).updateMask(wet).rename("wc_weed_pct")
    open_ = wet.updateMask(ndvi.lt(OPEN_NDVI))
    ndci = med.normalizedDifference(["B5", "B4"]).updateMask(open_).rename("wc_ndci")
    ndti = med.normalizedDifference(["B4", "B3"]).updateMask(open_).rename("wc_ndti")
    return ee.Image.cat([water.rename("wc_water_pct").float(), river, weed.float(), ndci, ndti]), (w, s, e, n)


def rows_from(raw):
    """Keep blocks with enough permanent water; fractions to percentages. Pure."""
    rows = {}
    for code, x in raw.items():
        wp = x.get("wc_water_pct")
        if wp is None or wp * 100 < MIN_WATER_PCT:
            continue
        weed, ndci, ndti = x.get("wc_weed_pct"), x.get("wc_ndci"), x.get("wc_ndti")
        if weed is None and ndci is None:
            continue
        rv = x.get("wc_river_pct") or 0
        if rv < wp / 2:
            continue
        rows[code] = {"wc_water_pct": gee.r(wp * 100, 1), "wc_river": 1, "wc_weed_pct": gee.r((weed or 0) * 100, 1),
                      "wc_ndci": gee.r(ndci, 3), "wc_ndti": gee.r(ndti, 3)}
    return rows


def bake(region):
    img, bbox = image(region)
    return rows_from(gee.fetch(gee.to_cells(img, SCALE_M), bbox, LEVEL, tile=TILE))


def cell_dataset(region, rows):
    specs = [
        FieldSpec("wc_water_pct", "Permanent river, canal or creek water in the block", agg="mean", unit="% of block", domain=[0, 100], ramp="blues",
                  higher_is=None),
        FieldSpec("wc_river", "Mostly river, canal or creek water (1)", agg="mode", unit="yes/no", domain=[0, 1],
                  ramp="blues", higher_is=None),
        FieldSpec("wc_weed_pct", "Water covered by floating weeds or a dense bloom", agg="mean", unit="% of water", domain=[0, 60],
                  ramp="reds", higher_is="worse"),
        FieldSpec("wc_ndci", "Algae (chlorophyll index, NDCI) on open water", agg="mean", unit="index", domain=[-0.1, 0.25],
                  ramp="reds", higher_is="worse"),
        FieldSpec("wc_ndti", "Muddiness (turbidity index, NDTI) on open water", agg="mean", unit="index", domain=[-0.2, 0.2],
                  ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="water_colour", title="River and creek water colour: algae, mud and weeds (Sentinel-2)", level=LEVEL, fields=specs,
        group="Environment",
        description=f"Median of cloud-free Copernicus Sentinel-2 surface reflectance scenes, March-May {YEARS[0]}-{YEARS[1]}, "
                    f"over permanent water (JRC Global Surface Water occurrence {OCC_MIN}%+, sea removed and only river and canal water kept with the Copernicus DEM GLO-30 water body mask; lakes and tanks are in the lakes dataset). Floating weeds or dense bloom: "
                    f"NDVI {WEED_NDVI}+ on water. On open water (NDVI below {OPEN_NDVI}): NDCI (B5-B4)/(B5+B4) for chlorophyll, "
                    f"above {ALGAE_NDCI} suggests nutrient-rich, eutrophic water (Mishra & Mishra 2012); NDTI (B4-B3)/(B4+B3) "
                    f"for turbidity. Blocks with under {MIN_WATER_PCT:g}% water are left out. Colour indices, not BOD or coliform "
                    "measurements; sewage shows up through the algae and weeds it feeds.",
        source="pipeline/realestate/watercolour.py (Copernicus Sentinel-2 SR and JRC Global Surface Water via Earth Engine)",
        license="Copernicus Sentinel data and Copernicus DEM (free, full and open; modified); JRC GSW CC BY 4.0 (Pekel et al. 2016)",
        default_field="wc_weed_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region,
                               store.bin_records(({"digipin": c, **r} for c, r in rows.items()), LEVEL, specs), parquet=False)


def refilter(region):
    """Rewrite an already baked region with the river-only rule, without calling Earth Engine."""
    import json
    d = json.loads((CELLS / "water_colour" / f"{region}.json").read_text())
    rows = {}
    for i, c in enumerate(d["cells"]):
        x = {k: d["columns"][k][i] for k in d["columns"]}
        if x.get("wc_river") == 1:
            rows[c.replace("-", "")] = x
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    ap.add_argument("--refilter", action="store_true", help="re-apply the river-only rule to baked files")
    a = ap.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = refilter(r) if a.refilter else bake(r)
        weedy = sum(1 for x in rows.values() if x["wc_weed_pct"] >= 25)
        algae = sum(1 for x in rows.values() if x["wc_ndci"] is not None and x["wc_ndci"] >= ALGAE_NDCI)
        print(f"{r}: {len(rows)} river blocks, {weedy} weed-covered (25%+), {algae} algae-rich")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
