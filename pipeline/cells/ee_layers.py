"""Open raster datasets baked into the cell store via Earth Engine.

    python -m pipeline.cells.ee_layers --region delhi                 # every layer
    python -m pipeline.cells.ee_layers --region all population terrain
    python -m pipeline.cells.ee_layers --list

Each entry in ``LAYERS`` builds one registry dataset: it asks Earth Engine for
the source bands, aggregated per DIGIPIN cell (pipeline/cells/earthengine.py),
turns them into fields with units, and writes them with ``store.write_dataset``
so they appear under **Layers** with a legend and a source card. Every source
here is open and keyless beyond an Earth Engine project.

Cell levels follow the source resolution: L7 (~244 m) for 10–100 m rasters,
L6 (~975 m) for kilometre-scale ones (Sentinel-5P, CHIRPS), so a cell never
pretends to be sharper than its data.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import time
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.cells import earthengine as gee
from pipeline.cells import store
from pipeline.cells.schema import DatasetSpec, FieldSpec

REPO = Path(__file__).resolve().parents[2]
YEAR = 2025          # last complete year for the time-series sources
GROUP = "Open Data (satellite)"

_r = gee.r


def _table(level, rows: dict, specs: list) -> store.CellTable:
    """CellTable from {code: {field: value}}, dropping cells with no data."""
    return store.bin_records(({"digipin": c, **v} for c, v in rows.items()), level, specs)


def _bbox(region):
    w, s, e, n = bbox_for(region)
    return gee.init().Geometry.Rectangle([w, s, e, n]), (w, s, e, n)


def _year(col, y=YEAR, m0=1, m1=12):
    ee = gee.init()
    end = ee.Date.fromYMD(y, m1, 1).advance(1, "month")
    return col.filterDate(ee.Date.fromYMD(y, m0, 1), end)


# ── population (GHSL) ───────────────────────────────────────────────────────

def population(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 7

    def dens(year):  # people per km² so a cell mean scales to its own area
        img = ee.Image(f"JRC/GHSL/P2023A/GHS_POP/{year}")
        return img.divide(ee.Image.pixelArea().divide(1e6))

    img = ee.Image.cat([dens(2020).rename("d2020"), dens(2000).rename("d2000"),
                        dens(2030).rename("d2030")])
    raw = gee.fetch(gee.to_cells(img, 100), bbox, level)
    rows = {}
    for code, v in raw.items():
        a = gee.cell_area_km2(code)
        d20, d00, d30 = v.get("d2020"), v.get("d2000"), v.get("d2030")
        if d20 is None:
            continue
        p20 = d20 * a
        rows[code] = {
            "population": round(p20),
            "density_km2": round(d20),
            "change_2000_2020_pct": _r(100 * (d20 - d00) / d00) if d00 and d00 * a >= 50 else None,
            "projected_2030": round(d30 * a) if d30 is not None else None,
        }
    specs = [
        FieldSpec("population", "Residents (2020)", agg="sum", unit="people", ramp="viridis"),
        FieldSpec("density_km2", "Population density", agg="mean", unit="people/km²", ramp="heat"),
        FieldSpec("change_2000_2020_pct", "Growth 2000→2020", agg="mean", unit="%",
                  domain=[-50, 300], ramp="diverging"),
        FieldSpec("projected_2030", "Projected residents (2030)", agg="sum", unit="people",
                  ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="population", title="Population (GHSL)", level=level, fields=specs, group=GROUP,
        description="Residents per cell from the JRC Global Human Settlement Layer GHS-POP "
                    "R2023A (100 m), with 2000→2020 growth and the 2030 projection.",
        source="JRC GHSL GHS-POP R2023A via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (European Commission JRC)",
        default_field="density_km2", extrude=True, height_m=500)
    return spec, _table(level, rows, specs)


# ── built environment (GHSL) ────────────────────────────────────────────────

_SMOD = {30: "Urban centre", 23: "Dense urban cluster", 22: "Semi-dense urban cluster",
         21: "Suburban / peri-urban", 13: "Rural cluster", 12: "Low-density rural",
         11: "Very low-density rural", 10: "Water"}
_SMOD_COLORS = {"Urban centre": "#7f0000", "Dense urban cluster": "#d7301f",
                "Semi-dense urban cluster": "#fc8d59", "Suburban / peri-urban": "#fdcc8a",
                "Rural cluster": "#addd8e", "Low-density rural": "#78c679",
                "Very low-density rural": "#238443", "Water": "#2c7fb8"}


def built_up(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 7
    s = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2020")
    s00 = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2000").select("built_surface")
    v = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_V/2020").select("built_volume_total")
    h = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_H/2018").select("built_height")
    area = ee.Image.pixelArea()
    img = ee.Image.cat([
        s.select("built_surface").divide(area).rename("built"),          # m²/m²
        s.select("built_surface_nres").divide(area).rename("nres"),
        s00.divide(area).rename("built00"),
        v.divide(area).rename("vol"),                                     # m³/m²
        h.updateMask(h.gt(0)).rename("height"),
    ])
    mean = gee.fetch(gee.to_cells(img, 100), bbox, level)
    smod = gee.fetch(gee.to_cells(ee.Image("JRC/GHSL/P2023A/GHS_SMOD/2020").rename("smod"),
                                  1000, "mode"), bbox, level)
    rows = {}
    for code, x in gee.merge(mean, smod).items():
        b = x.get("built")
        if b is None:
            continue
        sm = x.get("smod")
        rows[code] = {
            "built_pct": _r(100 * b),
            "nonres_share_pct": _r(100 * x["nres"] / b) if b > 0.01 and x.get("nres") is not None else None,
            "built_change_pct": _r(100 * (b - x["built00"])) if x.get("built00") is not None else None,
            "volume_m3_m2": _r(x.get("vol"), 2),
            "avg_height_m": _r(x.get("height")),
            "urbanisation": _SMOD.get(int(sm)) if sm is not None else None,
        }
    specs = [
        FieldSpec("built_pct", "Built-up surface", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="heat"),
        FieldSpec("nonres_share_pct", "Non-residential share", agg="mean", unit="% of built",
                  domain=[0, 100], ramp="blues"),
        FieldSpec("built_change_pct", "New built surface 2000→2020", agg="mean",
                  unit="pp of cell", ramp="reds"),
        FieldSpec("volume_m3_m2", "Built volume density", agg="mean", unit="m³/m²", ramp="viridis"),
        FieldSpec("avg_height_m", "Average building height", agg="mean", unit="m", ramp="viridis"),
        FieldSpec("urbanisation", "Degree of urbanisation", type="category", agg="mode",
                  colors=_SMOD_COLORS),
    ]
    spec = DatasetSpec(
        id="built_up", title="Built-up area (GHSL)", level=level, fields=specs, group=GROUP,
        description="Built surface, non-residential share, 2000→2020 expansion, built volume "
                    "and height from GHSL R2023A (100 m); degree of urbanisation from GHS-SMOD (1 km).",
        source="JRC GHSL GHS-BUILT-S/V/H + GHS-SMOD R2023A via Earth Engine",
        license="CC BY 4.0 (European Commission JRC)",
        default_field="built_pct", extrude=True, height_m=400)
    return spec, _table(level, rows, specs)


# ── land cover (ESA WorldCover) ─────────────────────────────────────────────

_WC = [(10, "tree", "Tree cover", "#006400"), (20, "shrub", "Shrubland", "#ffbb22"),
       (30, "grass", "Grassland", "#ffff4c"), (40, "crop", "Cropland", "#f096ff"),
       (50, "built", "Built-up", "#fa0000"), (60, "bare", "Bare / sparse", "#b4b4b4"),
       (80, "water", "Water", "#0064c8"), (90, "wetland", "Wetland", "#0096a0"),
       (95, "mangrove", "Mangroves", "#00cf75")]


def land_cover(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 7
    wc = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map")
    img = ee.Image.cat([wc.eq(c).rename(k) for c, k, _, _ in _WC])
    raw = gee.fetch(gee.to_cells(img, 10), bbox, level)
    rows = {}
    for code, x in raw.items():
        fr = {k: x.get(k) for _, k, _, _ in _WC}
        if all(v is None for v in fr.values()):
            continue
        row = {f"{k}_pct": _r(100 * (v or 0)) for k, v in fr.items()}
        top = max(_WC, key=lambda t: fr.get(t[1]) or 0)
        row["dominant"] = top[2]
        rows[code] = row
    specs = [FieldSpec(f"{k}_pct", label, agg="mean", unit="% of cell", domain=[0, 100],
                       ramp={"tree": "greens", "water": "blues", "wetland": "blues",
                             "mangrove": "greens", "built": "reds"}.get(k, "viridis"))
             for _, k, label, _ in _WC]
    specs.append(FieldSpec("dominant", "Dominant land cover", type="category", agg="mode",
                           colors={label: col for _, _, label, col in _WC}))
    spec = DatasetSpec(
        id="land_cover", title="Land cover (ESA WorldCover)", level=level, fields=specs,
        group=GROUP,
        description="Share of each cell in each ESA WorldCover 2021 class (10 m Sentinel-1/2 "
                    "classification), plus the dominant class.",
        source="ESA WorldCover v200 (2021) via Earth Engine",
        license="CC BY 4.0 (ESA WorldCover project)",
        default_field="dominant")
    return spec, _table(level, rows, specs)


# ── vegetation (Sentinel-2 NDVI + Meta canopy height) ───────────────────────

def _s2(geom, m0, m1):
    ee = gee.init()
    col = _year(ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(geom), YEAR, m0, m1)
    col = col.filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 60))

    def prep(im):
        scl = im.select("SCL")
        ok = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10))
        return im.updateMask(ok).normalizedDifference(["B8", "B4"]).rename("ndvi")
    return col.map(prep).median()


def vegetation(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    img = ee.Image.cat([_s2(geom, 1, 12).rename("ndvi"), _s2(geom, 3, 5).rename("ndvi_dry"),
                        _s2(geom, 8, 10).rename("ndvi_wet")])
    # Year-long Sentinel-2 medians are memory-heavy; small tiles keep EE under its limit.
    ndvi = gee.fetch(gee.to_cells(img, 20), bbox, level, tile=64)
    ch = ee.ImageCollection("projects/meta-forest-monitoring-okw37/assets/CanopyHeight") \
        .filterBounds(geom).mosaic().select("cover_code")
    can = gee.fetch(gee.to_cells(ee.Image.cat([ch.rename("canopy"),
                                               ch.gte(5).rename("cover")]), 5), bbox, level,
                    tile=128)
    rows = {}
    for code, x in gee.merge(ndvi, can).items():
        if x.get("ndvi") is None and x.get("canopy") is None:
            continue
        rows[code] = {
            "ndvi": _r(x.get("ndvi"), 3), "ndvi_dry": _r(x.get("ndvi_dry"), 3),
            "ndvi_wet": _r(x.get("ndvi_wet"), 3),
            "canopy_m": _r(x.get("canopy")),
            "tree_canopy_pct": _r(100 * x["cover"]) if x.get("cover") is not None else None,
        }
    specs = [
        FieldSpec("ndvi", f"NDVI (median {YEAR})", agg="mean", unit="index", domain=[-0.2, 0.8],
                  ramp="greens", higher_is="better"),
        FieldSpec("ndvi_dry", "NDVI, dry season (Mar–May)", agg="mean", unit="index",
                  domain=[-0.2, 0.8], ramp="greens", higher_is="better"),
        FieldSpec("ndvi_wet", "NDVI, post-monsoon (Aug–Oct)", agg="mean", unit="index",
                  domain=[-0.2, 0.8], ramp="greens", higher_is="better"),
        FieldSpec("canopy_m", "Mean canopy height", agg="mean", unit="m", ramp="greens"),
        FieldSpec("tree_canopy_pct", "Tree canopy ≥ 5 m", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="vegetation", title="Vegetation & tree canopy", level=level, fields=specs, group=GROUP,
        description=f"Sentinel-2 NDVI medians for {YEAR} (cloud-masked, annual, dry and "
                    "post-monsoon) and Meta/WRI 1 m canopy height (mean height, share ≥ 5 m).",
        source="Copernicus Sentinel-2 L2A + Meta/WRI High Resolution Canopy Height via Earth Engine",
        license="Copernicus open licence; canopy height CC BY 4.0",
        default_field="ndvi")
    return spec, _table(level, rows, specs)


# ── terrain (Copernicus DEM + MERIT Hydro) ──────────────────────────────────

def terrain(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    col = ee.ImageCollection("COPERNICUS/DEM/GLO30_2024_1").filterBounds(geom).select("DEM")
    dem = col.mosaic().setDefaultProjection(col.first().projection())
    slope = ee.Terrain.slope(dem)
    hand = ee.Image("MERIT/Hydro/v1_0_1").select("hnd")
    mean = gee.fetch(gee.to_cells(ee.Image.cat([dem.rename("elev"), slope.rename("slope")]), 30),
                     bbox, level)
    lo = gee.fetch(gee.to_cells(dem.rename("lo"), 30, "min"), bbox, level)
    hi = gee.fetch(gee.to_cells(dem.rename("hi"), 30, "max"), bbox, level)
    hd = gee.fetch(gee.to_cells(hand.rename("hand"), 90), bbox, level)
    rows = {}
    for code, x in gee.merge(mean, lo, hi, hd).items():
        if x.get("elev") is None:
            continue
        rows[code] = {
            "elevation_m": _r(x["elev"]),
            "relief_m": _r(x["hi"] - x["lo"]) if x.get("hi") is not None and x.get("lo") is not None else None,
            "slope_deg": _r(x.get("slope"), 2),
            "hand_m": _r(x.get("hand")),
        }
    specs = [
        FieldSpec("elevation_m", "Elevation", agg="mean", unit="m a.s.l.", ramp="viridis"),
        FieldSpec("relief_m", "Local relief (max − min)", agg="max", unit="m", ramp="heat"),
        FieldSpec("slope_deg", "Mean slope", agg="mean", unit="°", ramp="heat"),
        FieldSpec("hand_m", "Height above nearest drainage", agg="mean", unit="m",
                  ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="terrain", title="Terrain & drainage", level=level, fields=specs, group=GROUP,
        description="Elevation, relief and slope from the Copernicus GLO-30 DEM; height above "
                    "nearest drainage (HAND, a flood-exposure proxy: low = close to a channel) "
                    "from MERIT Hydro (90 m).",
        source="Copernicus DEM GLO-30 + MERIT Hydro v1.0.1 via Earth Engine",
        license="Copernicus DEM licence; MERIT Hydro CC BY-NC 4.0",
        default_field="elevation_m", extrude=True, height_m=300)
    return spec, _table(level, rows, specs)


# ── water + flood hazard (JRC GSW + GloFAS) ─────────────────────────────────

def water(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    gsw = ee.Image("JRC/GSW1_4/GlobalSurfaceWater")
    occ = gsw.select("occurrence").unmask(0)
    fl = ee.ImageCollection("JRC/CEMS_GLOFAS/FloodHazard/v2_1").filterBounds(geom).mosaic()
    # Permanent water bodies carry a placeholder depth of 1 m; they are not flood.
    dry = fl.select("permanent_water_class").unmask(0).neq(1)
    rp100 = fl.select("RP100_depth").unmask(0).multiply(dry)
    rp10 = fl.select("RP10_depth").unmask(0).multiply(dry)
    land = ee.Image.constant(1)
    a = gee.fetch(gee.to_cells(ee.Image.cat([
        occ.rename("occ"), occ.gte(75).rename("perm"),
        gsw.select("max_extent").unmask(0).rename("ever"), land.rename("land")]), 30), bbox, level)
    b = gee.fetch(gee.to_cells(ee.Image.cat([
        rp100.rename("d100"), rp100.gt(0).rename("f100"), rp10.gt(0).rename("f10")]), 90),
        bbox, level)
    rows = {}
    for code, x in gee.merge(a, b).items():
        if x.get("occ") is None:
            continue
        rows[code] = {
            "water_occurrence_pct": _r(x["occ"]),
            "permanent_water_pct": _r(100 * x["perm"]),
            "ever_water_pct": _r(100 * x["ever"]),
            "flood_rp100_depth_m": _r(x.get("d100"), 2),
            "flood_rp100_pct": _r(100 * x["f100"]) if x.get("f100") is not None else None,
            "flood_rp10_pct": _r(100 * x["f10"]) if x.get("f10") is not None else None,
        }
    specs = [
        FieldSpec("water_occurrence_pct", "Surface-water occurrence 1984–2021", agg="mean",
                  unit="% of time", domain=[0, 100], ramp="blues"),
        FieldSpec("permanent_water_pct", "Permanent water (≥ 75% of time)", agg="mean",
                  unit="% of cell", domain=[0, 100], ramp="blues"),
        FieldSpec("ever_water_pct", "Ever under water", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="blues"),
        FieldSpec("flood_rp100_depth_m", "River flood depth, 1-in-100 yr", agg="mean", unit="m",
                  ramp="blues", higher_is="worse"),
        FieldSpec("flood_rp100_pct", "Floodable area, 1-in-100 yr", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("flood_rp10_pct", "Floodable area, 1-in-10 yr", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="water", title="Surface water & river flood hazard", level=level, fields=specs,
        group=GROUP,
        description="Landsat-derived surface-water history (JRC Global Surface Water 1984–2021, "
                    "30 m) and modelled riverine flood extent/depth for 10- and 100-year return "
                    "periods (Copernicus GloFAS flood hazard v2.1, ~90 m). The model ignores "
                    "embankments and drains, and does not cover pluvial/urban waterlogging.",
        source="JRC Global Surface Water v1.4 + CEMS GloFAS Flood Hazard v2.1 via Earth Engine",
        license="CC BY 4.0 (European Commission JRC)",
        default_field="flood_rp100_pct")
    return spec, _table(level, rows, specs)


# ── night lights (VIIRS) ────────────────────────────────────────────────────

def nightlights(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    col = ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG").select("avg_rad")
    now = _year(col).median().rename("rad")
    then = _year(col, 2015).median().rename("rad15")
    raw = gee.fetch(gee.to_cells(ee.Image.cat([now, then]), 100), bbox, level)
    rows = {}
    for code, x in raw.items():
        v, v15 = x.get("rad"), x.get("rad15")
        if v is None:
            continue
        v = max(v, 0.0)
        rows[code] = {
            "radiance": _r(v, 2),
            "change_2015_pct": _r(100 * (v - v15) / v15) if v15 is not None and v15 >= 1 else None,
        }
    specs = [
        FieldSpec("radiance", f"Night-time radiance ({YEAR} median)", agg="mean",
                  unit="nW/cm²/sr", domain=[0, 80], ramp="heat"),
        FieldSpec("change_2015_pct", f"Change since 2015", agg="mean", unit="%",
                  domain=[-100, 200], ramp="diverging"),
    ]
    spec = DatasetSpec(
        id="nightlights", title="Night lights (VIIRS)", level=level, fields=specs, group=GROUP,
        description=f"VIIRS Day/Night Band monthly composites (stray-light corrected), median of "
                    f"{YEAR} and change since 2015. Native ~460 m, so neighbouring 244 m cells "
                    "share values. A proxy for economic activity and electrification.",
        source="NOAA/EOG VIIRS DNB monthly VCMSLCFG via Earth Engine",
        license="Public domain (NOAA EOG; credit Earth Observation Group)",
        default_field="radiance", extrude=True, height_m=400)
    return spec, _table(level, rows, specs)


# ── land surface temperature (Landsat + MODIS) ──────────────────────────────

def heat(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7

    def ls(cid):
        return _year(ee.ImageCollection(cid).filterBounds(geom), YEAR, 3, 6) \
            .filter(ee.Filter.lt("CLOUD_COVER", 40))

    def lst(im):
        qa = im.select("QA_PIXEL")
        clear = qa.bitwiseAnd(0b11010).eq(0)   # fill, dilated cloud, cirrus, cloud
        return im.select("ST_B10").multiply(0.00341802).add(149.0 - 273.15) \
            .updateMask(clear).rename("lst")
    landsat = ls("LANDSAT/LC09/C02/T1_L2").merge(ls("LANDSAT/LC08/C02/T1_L2")).map(lst).median()
    mod = _year(ee.ImageCollection("MODIS/061/MOD11A2"), YEAR, 4, 6)
    day = mod.select("LST_Day_1km").mean().multiply(0.02).subtract(273.15).rename("day")
    night = mod.select("LST_Night_1km").mean().multiply(0.02).subtract(273.15).rename("night")
    a = gee.fetch(gee.to_cells(landsat, 30), bbox, level)
    b = gee.fetch(gee.to_cells(ee.Image.cat([day, night]), 1000), bbox, level)
    merged = gee.merge(a, b)
    vals = [x["lst"] for x in merged.values() if x.get("lst") is not None]
    med = statistics.median(vals) if vals else None
    rows = {}
    for code, x in merged.items():
        t = x.get("lst")
        if t is None and x.get("day") is None:
            continue
        rows[code] = {
            "lst_day_c": _r(t),
            "uhi_anomaly_c": _r(t - med) if t is not None and med is not None else None,
            "modis_day_c": _r(x.get("day")),
            "modis_night_c": _r(x.get("night")),
        }
    specs = [
        FieldSpec("lst_day_c", f"Surface temperature, pre-monsoon {YEAR} (Landsat)", agg="mean",
                  unit="°C", domain=[25, 55], ramp="heat", higher_is="worse"),
        FieldSpec("uhi_anomaly_c", "Hotter than the city median", agg="mean", unit="°C",
                  domain=[-8, 8], ramp="diverging", higher_is="worse"),
        FieldSpec("modis_day_c", f"Daytime LST Apr–Jun {YEAR} (MODIS, 1 km)", agg="mean",
                  unit="°C", domain=[25, 55], ramp="heat", higher_is="worse"),
        FieldSpec("modis_night_c", f"Night-time LST Apr–Jun {YEAR} (MODIS, 1 km)", agg="mean",
                  unit="°C", domain=[15, 35], ramp="heat", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="surface_heat", title="Land surface temperature", level=level, fields=specs,
        group=GROUP,
        description=f"Pre-monsoon (Mar–Jun {YEAR}) median surface temperature from Landsat 8/9 "
                    "thermal (30 m, ~10:30 local), its anomaly against the city median (urban "
                    "heat island), and MODIS day/night means (1 km). Surface, not air, temperature.",
        source="USGS Landsat 8/9 Collection 2 L2 + MODIS MOD11A2 v6.1 via Earth Engine",
        license="Public domain (USGS / NASA)",
        default_field="lst_day_c")
    return spec, _table(level, rows, specs)


# ── air quality (Sentinel-5P + satellite PM2.5) ─────────────────────────────

def air_quality(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 6

    def s5p(cid, band):
        return _year(ee.ImageCollection(cid).select(band)).mean()
    img = ee.Image.cat([
        s5p("COPERNICUS/S5P/OFFL/L3_NO2", "tropospheric_NO2_column_number_density").multiply(1e6).rename("no2"),
        s5p("COPERNICUS/S5P/OFFL/L3_CO", "CO_column_number_density").multiply(1e3).rename("co"),
        s5p("COPERNICUS/S5P/OFFL/L3_AER_AI", "absorbing_aerosol_index").rename("aai"),
        s5p("COPERNICUS/S5P/OFFL/L3_HCHO", "tropospheric_HCHO_column_number_density").multiply(1e6).rename("hcho"),
    ])
    a = gee.fetch(gee.to_cells(img, 1113), bbox, level)
    pm = ee.ImageCollection("projects/sat-io/open-datasets/GLOBAL-SATELLITE-PM25/ANNUAL") \
        .sort("system:time_start", False).first().rename("pm25")
    b = gee.fetch(gee.to_cells(pm, 1000), bbox, level)
    rows = {}
    for code, x in gee.merge(a, b).items():
        if x.get("no2") is None and x.get("pm25") is None:
            continue
        rows[code] = {"no2_umol_m2": _r(x.get("no2")), "co_mmol_m2": _r(x.get("co"), 2),
                      "aerosol_index": _r(x.get("aai"), 3), "hcho_umol_m2": _r(x.get("hcho")),
                      "pm25_ugm3": _r(x.get("pm25"))}
    specs = [
        FieldSpec("pm25_ugm3", "PM2.5, annual mean (2022)", agg="mean", unit="µg/m³",
                  domain=[0, 120], ramp="reds", higher_is="worse"),
        FieldSpec("no2_umol_m2", f"Tropospheric NO₂ ({YEAR} mean)", agg="mean", unit="µmol/m²",
                  ramp="reds", higher_is="worse"),
        FieldSpec("co_mmol_m2", f"CO column ({YEAR} mean)", agg="mean", unit="mmol/m²",
                  ramp="reds", higher_is="worse"),
        FieldSpec("aerosol_index", f"UV aerosol index ({YEAR} mean)", agg="mean", unit="index",
                  ramp="reds", higher_is="worse"),
        FieldSpec("hcho_umol_m2", f"Formaldehyde HCHO ({YEAR} mean)", agg="mean",
                  unit="µmol/m²", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="air_quality", title="Air quality (satellite)", level=level, fields=specs, group=GROUP,
        description=f"Sentinel-5P TROPOMI column means for {YEAR} (NO₂, CO, aerosol index, "
                    "HCHO; ~5 km native) and the Washington University satellite-derived "
                    "surface PM2.5 (V6.GL, ~1 km, latest year 2022). Columns are not ground "
                    "concentrations; use for spatial contrast.",
        source="Copernicus Sentinel-5P OFFL L3 + ACAG V6.GL.02 PM2.5 (awesome-gee-community "
               "catalog) via Earth Engine",
        license="Copernicus open licence; PM2.5 free for research (WUSTL ACAG)",
        default_field="pm25_ugm3")
    return spec, _table(level, rows, specs)


# ── rainfall (CHIRPS) ───────────────────────────────────────────────────────

def rainfall(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 6
    col = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").select("precipitation")
    yr = _year(col)
    img = ee.Image.cat([
        yr.sum().rename("annual"), _year(col, YEAR, 6, 9).sum().rename("monsoon"),
        yr.max().rename("maxday"), yr.map(lambda i: i.gte(64.5)).sum().rename("heavy"),
        col.filterDate(f"{YEAR - 9}-01-01", f"{YEAR + 1}-01-01").sum().divide(10).rename("normal"),
    ])
    raw = gee.fetch(gee.to_cells(img, 1000), bbox, level)
    rows = {}
    for code, x in raw.items():
        if x.get("annual") is None:
            continue
        rows[code] = {"rain_annual_mm": round(x["annual"]), "rain_monsoon_mm": round(x["monsoon"]),
                      "rain_max_day_mm": _r(x["maxday"]), "heavy_rain_days": _r(x["heavy"]),
                      "rain_10yr_mean_mm": round(x["normal"]),
                      "rain_anomaly_pct": _r(100 * (x["annual"] - x["normal"]) / x["normal"])
                      if x.get("normal") else None}
    specs = [
        FieldSpec("rain_annual_mm", f"Rainfall {YEAR}", agg="mean", unit="mm", ramp="blues"),
        FieldSpec("rain_monsoon_mm", f"Monsoon rainfall Jun–Sep {YEAR}", agg="mean", unit="mm",
                  ramp="blues"),
        FieldSpec("rain_max_day_mm", f"Wettest day {YEAR}", agg="mean", unit="mm/day",
                  ramp="blues", higher_is="worse"),
        FieldSpec("heavy_rain_days", f"Heavy-rain days {YEAR} (≥ 64.5 mm, IMD)", agg="mean",
                  unit="days", ramp="blues", higher_is="worse"),
        FieldSpec("rain_10yr_mean_mm", f"Mean annual rainfall {YEAR - 9}–{YEAR}", agg="mean",
                  unit="mm", ramp="blues"),
        FieldSpec("rain_anomaly_pct", f"{YEAR} vs 10-year mean", agg="mean", unit="%",
                  domain=[-50, 50], ramp="diverging"),
    ]
    spec = DatasetSpec(
        id="rainfall", title="Rainfall (CHIRPS)", level=level, fields=specs, group=GROUP,
        description=f"CHIRPS v2 daily rainfall (satellite + station blend, ~5 km): {YEAR} totals, "
                    "monsoon total, wettest day, IMD heavy-rain days and the 10-year mean.",
        source="UCSB Climate Hazards Center CHIRPS v2.0 daily via Earth Engine",
        license="CC0 / public domain (UCSB CHC)",
        default_field="rain_annual_mm")
    return spec, _table(level, rows, specs)


# ── building stock over time (Google Open Buildings 2.5D Temporal) ──────────

def building_stock(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    col = ee.ImageCollection("GOOGLE/Research/open-buildings-temporal/v1").filterBounds(geom)

    def yr(y):
        c = col.filter(ee.Filter.calendarRange(y, y, "year"))
        m = c.mosaic().setDefaultProjection(c.first().projection().atScale(4))
        pres = m.select("building_presence")
        h = m.select("building_height")
        return ee.Image.cat([
            m.select("building_fractional_count").rename(f"n{y}"),
            pres.gte(0.5).rename(f"p{y}"),
            h.updateMask(pres.gte(0.5).And(h.gt(0))).rename(f"h{y}"),
        ])
    img = ee.Image.cat([yr(2016), yr(2023)])
    raw = gee.fetch(gee.to_cells(img, 4), bbox, level, tile=48)
    rows = {}
    for code, x in raw.items():
        if x.get("n2023") is None:
            continue
        # The fractional count is per 0.5 m pixel; a 4 m sample of it is one of those values.
        k = gee.cell_area_km2(code) * 1e6 / 0.25
        n23, n16 = x["n2023"] * k, (x["n2016"] or 0) * k
        rows[code] = {
            "buildings_2023": round(n23),
            "buildings_2016": round(n16),
            "new_buildings": round(n23 - n16),
            "growth_pct": _r(100 * (n23 - n16) / n16) if n16 >= 20 else None,
            "cover_2023_pct": _r(100 * (x.get("p2023") or 0)),
            "height_2023_m": _r(x.get("h2023")),
        }
    specs = [
        FieldSpec("buildings_2023", "Buildings (2023, model estimate)", agg="sum", unit="count",
                  ramp="heat"),
        FieldSpec("buildings_2016", "Buildings (2016, model estimate)", agg="sum", unit="count",
                  ramp="heat"),
        FieldSpec("new_buildings", "New buildings 2016→2023", agg="sum", unit="count",
                  ramp="reds"),
        FieldSpec("growth_pct", "Building growth 2016→2023", agg="mean", unit="%",
                  domain=[-20, 100], ramp="diverging"),
        FieldSpec("cover_2023_pct", "Roof cover (2023)", agg="mean", unit="% of cell",
                  domain=[0, 80], ramp="heat"),
        FieldSpec("height_2023_m", "Mean building height (2023)", agg="mean", unit="m",
                  ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="building_stock", title="Building stock 2016–2023", level=level, fields=specs,
        group=GROUP,
        description="Building counts, roof cover and height from Google Open Buildings 2.5D "
                    "Temporal (annual, 4 m effective resolution) for 2016 and 2023. Counts are "
                    "the model's fractional-count estimate and run higher than the v3 polygon "
                    "count in dense cores.",
        source="Google Open Buildings 2.5D Temporal v1 via Earth Engine",
        license="CC BY 4.0 + ODbL (Google Open Buildings)",
        default_field="buildings_2023", extrude=True, height_m=500)
    return spec, _table(level, rows, specs)


# ── soil (OpenLandMap) ──────────────────────────────────────────────────────

_TEXTURE = {1: "Clay", 2: "Silty clay", 3: "Sandy clay", 4: "Clay loam", 5: "Silty clay loam",
            6: "Sandy clay loam", 7: "Loam", 8: "Silt loam", 9: "Sandy loam", 10: "Silt",
            11: "Loamy sand", 12: "Sand"}


def soil(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 7
    olm = "OpenLandMap/SOL/SOL_{}/v02"
    img = ee.Image.cat([
        ee.Image(olm.format("CLAY-WFRACTION_USDA-3A1A1A_M")).select("b0").rename("clay"),
        ee.Image(olm.format("SAND-WFRACTION_USDA-3A1A1A_M")).select("b0").rename("sand"),
        ee.Image(olm.format("ORGANIC-CARBON_USDA-6A1C_M")).select("b0").rename("soc"),
        ee.Image(olm.format("PH-H2O_USDA-4C1A2A_M")).select("b0").rename("ph"),
    ])
    a = gee.fetch(gee.to_cells(img, 250), bbox, level)
    tex = ee.Image(olm.format("TEXTURE-CLASS_USDA-TT_M")).select("b0").rename("tex")
    b = gee.fetch(gee.to_cells(tex, 250, "mode"), bbox, level)
    rows = {}
    for code, x in gee.merge(a, b).items():
        if x.get("clay") is None:
            continue
        t = x.get("tex")
        rows[code] = {"clay_pct": _r(x["clay"]), "sand_pct": _r(x.get("sand")),
                      "organic_carbon_gkg": _r(5 * x["soc"]) if x.get("soc") is not None else None,
                      "ph": _r(x["ph"] / 10) if x.get("ph") is not None else None,
                      "texture": _TEXTURE.get(int(round(t))) if t is not None else None}
    specs = [
        FieldSpec("clay_pct", "Clay content (topsoil)", agg="mean", unit="%", domain=[0, 60],
                  ramp="viridis"),
        FieldSpec("sand_pct", "Sand content (topsoil)", agg="mean", unit="%", domain=[0, 80],
                  ramp="viridis"),
        FieldSpec("organic_carbon_gkg", "Soil organic carbon", agg="mean", unit="g/kg",
                  ramp="greens", higher_is="better"),
        FieldSpec("ph", "Soil pH (in water)", agg="mean", unit="pH", domain=[5, 9],
                  ramp="diverging"),
        FieldSpec("texture", "USDA texture class", type="category", agg="mode"),
    ]
    spec = DatasetSpec(
        id="soil", title="Soil (OpenLandMap)", level=level, fields=specs, group=GROUP,
        description="Topsoil (0 cm) clay, sand, organic carbon, pH and USDA texture class from "
                    "OpenLandMap machine-learning soil maps (250 m). Under built-up land these "
                    "are predicted, not sampled, values.",
        source="OpenLandMap soil v02 (Hengl et al., EnvirometriX) via Earth Engine",
        license="CC BY-SA 4.0 (OpenLandMap)",
        default_field="texture")
    return spec, _table(level, rows, specs)


# ── travel time (Malaria Atlas Project friction surfaces) ───────────────────

def accessibility(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 6
    base = "projects/malariaatlasproject/assets/accessibility/"
    img = ee.Image.cat([
        ee.Image(base + "accessibility_to_healthcare/2019").select("accessibility").rename("health"),
        ee.Image(base + "accessibility_to_cities/2015_v1_0").select("accessibility").rename("city"),
    ])
    raw = gee.fetch(gee.to_cells(img, 1000), bbox, level)
    rows = {c: {"healthcare_min": _r(x.get("health")), "city_min": _r(x.get("city"))}
            for c, x in raw.items() if x.get("health") is not None or x.get("city") is not None}
    specs = [
        FieldSpec("healthcare_min", "Travel time to a health facility (motorised)", agg="mean",
                  unit="min", domain=[0, 30], ramp="reds", higher_is="worse"),
        FieldSpec("city_min", "Travel time to a city of 50k+", agg="mean", unit="min",
                  domain=[0, 60], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="accessibility", title="Travel time to services", level=level, fields=specs,
        group=GROUP,
        description="Modelled travel time from the Malaria Atlas Project global friction "
                    "surfaces (1 km): to the nearest health facility (2019) and to the nearest "
                    "city of 50,000+ (2015).",
        source="Malaria Atlas Project accessibility (Weiss et al. 2018, 2020) via Earth Engine",
        license="CC BY 4.0 (Malaria Atlas Project)",
        default_field="healthcare_min")
    return spec, _table(level, rows, specs)



# ── rain waterlogging (Sentinel-1 + DEM + MERIT Hydro + GHSL) ───────────────

WATERLOG_YEARS = (2021, 2025)
# Wet-season window per city: the south-west monsoon everywhere except the
# Coromandel coast, whose heavy rain comes with the north-east monsoon.
_WET_MONTHS = {"chennai": (10, 12)}
_WLOG_CLASSES = [(25, "Low"), (45, "Moderate"), (65, "High"), (101, "Very high")]
_WLOG_COLORS = {"Low": "#c6dbef", "Moderate": "#6baed6", "High": "#2171b5",
                "Very high": "#08306b"}


def _ramp01(v, lo, hi):
    """Linear 0..1 between lo and hi (lo may be > hi to invert), clamped."""
    if v is None:
        return None
    t = (v - lo) / (hi - lo)
    return 0.0 if t < 0 else 1.0 if t > 1 else t


def _pct_rank(values: dict) -> dict:
    """{code: v} → {code: tie-averaged percentile 0..1} over non-None values."""
    items = sorted((v, c) for c, v in values.items() if v is not None)
    out, i, n = {}, 0, len(items)
    while i < n:
        j = i
        while j + 1 < n and items[j + 1][0] == items[i][0]:
            j += 1
        p = ((i + j) / 2) / (n - 1) if n > 1 else 0.5
        for k in range(i, j + 1):
            out[items[k][1]] = p
        i = j + 1
    return out


def waterlogging(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    m0, m1 = _WET_MONTHS.get(region, (6, 9))
    y0, y1 = WATERLOG_YEARS
    s1 = (ee.ImageCollection("COPERNICUS/S1_GRD").filterBounds(geom)
          .filter(ee.Filter.eq("instrumentMode", "IW"))
          .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
          .select("VV"))
    wet = s1.filterDate(f"{y0}-01-01", f"{y1 + 1}-01-01") \
        .filter(ee.Filter.calendarRange(m0, m1, "month"))
    dry = s1.filterDate(f"{y0}-01-01", f"{y1 + 1}-01-01") \
        .filter(ee.Filter.calendarRange(2, 4, "month")).median()
    # Standing water is a change: a pass counts when the ground is dark
    # (VV < −16 dB) *and* at least 3 dB darker than its own dry-season median,
    # so surfaces that are always dark (sand, tarmac, tanks) do not count.
    gsw = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence").unmask(0)
    land = gsw.lt(50)

    def flag(im):
        vv = im.focalMedian(30, "circle", "meters")
        return vv.lt(-16).And(vv.subtract(dry).lt(-3)).rename("w")
    freq = wet.map(flag).mean().unmask(0).updateMask(land).rename("obs")

    col = ee.ImageCollection("COPERNICUS/DEM/GLO30_2024_1").filterBounds(geom).select("DEM")
    dem = col.mosaic().setDefaultProjection(col.first().projection())
    # Hollow depth: how far a pixel sits below the mean ground within 300 m.
    hollow = dem.focalMean(300, "circle", "meters").subtract(dem).max(0).rename("hollow")
    mh = ee.Image("MERIT/Hydro/v1_0_1")
    tanb = ee.Terrain.slope(mh.select("elv")).multiply(3.14159265 / 180).tan().max(0.001)
    twi = mh.select("upa").multiply(1e6).divide(90).divide(tanb).log().rename("twi")
    built = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2020").select("built_surface") \
        .divide(ee.Image.pixelArea()).rename("imperv")

    a = gee.fetch(gee.to_cells(freq, 20), bbox, level, tile=64)
    b = gee.fetch(gee.to_cells(hollow, 30), bbox, level)
    c = gee.fetch(gee.to_cells(ee.Image.cat([twi, mh.select("hnd").rename("hand")]), 90),
                  bbox, level)
    d = gee.fetch(gee.to_cells(mh.select("upa").rename("upa"), 90, "max"), bbox, level)
    e = gee.fetch(gee.to_cells(built, 100), bbox, level)
    x = gee.merge(a, b, c, d, e)
    twi_rank = _pct_rank({k: v.get("twi") for k, v in x.items()})
    rows = {}
    for code, v in x.items():
        if v.get("hollow") is None and v.get("hand") is None:
            continue
        parts = [(0.25, _ramp01(v.get("hand"), 10, 0)),        # near drainage level
                 (0.15, _ramp01(v.get("hollow"), 0, 2)),        # sits in a hollow
                 (0.20, twi_rank.get(code)),                     # collects runoff
                 (0.15, v.get("imperv")),                        # rain cannot soak in
                 (0.25, _ramp01(v.get("obs"), 0, 0.1))]          # seen wet by radar
        got = [(w, s) for w, s in parts if s is not None]
        idx = 100 * sum(w * s for w, s in got) / sum(w for w, _ in got) if got else None
        rows[code] = {
            "waterlogging_index": _r(idx),
            "waterlogging_class": next(lbl for cut, lbl in _WLOG_CLASSES if idx < cut)
            if idx is not None else None,
            "monsoon_water_pct": _r(100 * v["obs"]) if v.get("obs") is not None else None,
            "hollow_depth_m": _r(v.get("hollow"), 2),
            "wetness_index": _r(v.get("twi"), 2),
            "upstream_km2": _r(v.get("upa"), 2),
            "impervious_pct": _r(100 * v["imperv"]) if v.get("imperv") is not None else None,
        }
    specs = [
        FieldSpec("waterlogging_index", "Rain waterlogging susceptibility", agg="mean",
                  unit="0-100", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("waterlogging_class", "Waterlogging class", type="category", agg="mode",
                  colors=_WLOG_COLORS),
        FieldSpec("monsoon_water_pct", f"Seen waterlogged by radar, wet seasons {y0}–{y1}",
                  agg="mean", unit="% of passes", domain=[0, 30], ramp="blues",
                  higher_is="worse"),
        FieldSpec("hollow_depth_m", "Depth below surrounding ground (300 m)", agg="mean",
                  unit="m", domain=[0, 3], ramp="blues", higher_is="worse"),
        FieldSpec("wetness_index", "Topographic wetness index", agg="mean", unit="ln(m)",
                  ramp="blues", higher_is="worse"),
        FieldSpec("upstream_km2", "Largest upstream catchment draining through", agg="max",
                  unit="km²", ramp="blues"),
        FieldSpec("impervious_pct", "Sealed (built) surface", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="waterlogging", title="Rain waterlogging", level=level, fields=specs, group=GROUP,
        description=f"Where heavy rain pools, independent of rivers. Combines Sentinel-1 radar "
                    f"passes that saw standing water on normally dry land in the wet seasons "
                    f"{y0}–{y1} (VV under −16 dB and 3 dB darker than the Feb–Apr median after a "
                    "30 m median filter, outside JRC water), hollows below the surrounding 300 m "
                    "(Copernicus DEM), the topographic wetness index and height above drainage "
                    "(MERIT Hydro) and sealed surface (GHSL). The index weights near-drainage "
                    "25%, radar-observed water 25%, wetness 20%, hollows 15%, sealing 15%. "
                    "Radar misses water between tall buildings (double bounce), so dense cores "
                    "lean on terrain; drains and pumping are not modelled.",
        source="Copernicus Sentinel-1 GRD + Copernicus DEM GLO-30 + MERIT Hydro + JRC GSW + "
               "GHSL GHS-BUILT-S via Earth Engine",
        license="Copernicus open licence; MERIT Hydro CC BY-NC 4.0; GHSL/GSW CC BY 4.0",
        default_field="waterlogging_index")
    return spec, _table(level, rows, specs)


# ── age and sex (WorldPop) ──────────────────────────────────────────────────

def demographics(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 7
    wp = ee.ImageCollection("WorldPop/GP/100m/pop_age_sex") \
        .filter(ee.Filter.eq("country", "IND")).filter(ee.Filter.eq("year", 2020)).first()

    def total(ages, sexes=("M", "F")):
        return ee.Image.cat([wp.select(f"{s}_{a}") for s in sexes for a in ages]) \
            .reduce(ee.Reducer.sum())
    under5, child = (0, 1), (0, 1, 5, 10)
    old = (60, 65, 70, 75, 80)
    allages = (0, 1) + tuple(range(5, 81, 5))
    km2 = ee.Image.pixelArea().divide(1e6)
    img = ee.Image.cat([wp.select("population").rename("tot"), total(under5).rename("u5"),
                        total(child).rename("u15"), total(old).rename("o60"),
                        total(allages, ("F",)).rename("fem")]).divide(km2)
    raw = gee.fetch(gee.to_cells(img, 100), bbox, level)
    rows = {}
    for code, x in raw.items():
        if x.get("tot") is None:
            continue
        a = gee.cell_area_km2(code)
        tot, u15, o60 = x["tot"] * a, x["u15"] * a, x["o60"] * a
        work = tot - u15 - o60
        ok = tot >= 20   # shares from a handful of modelled people are noise
        rows[code] = {
            "under5": round(x["u5"] * a), "elderly_60plus": round(o60),
            "children_pct": _r(100 * u15 / tot) if ok else None,
            "elderly_pct": _r(100 * o60 / tot) if ok else None,
            "women_pct": _r(100 * x["fem"] * a / tot) if ok else None,
            "dependency_ratio": _r(100 * (u15 + o60) / work) if ok and work > 0 else None,
            "wp_population": round(tot),
        }
    specs = [
        FieldSpec("under5", "Children under 5", agg="sum", unit="people", ramp="viridis"),
        FieldSpec("elderly_60plus", "People aged 60+", agg="sum", unit="people", ramp="viridis"),
        FieldSpec("children_pct", "Children 0–14", agg="mean", unit="% of residents",
                  domain=[15, 35], ramp="viridis"),
        FieldSpec("elderly_pct", "Aged 60+", agg="mean", unit="% of residents",
                  domain=[4, 14], ramp="viridis"),
        FieldSpec("women_pct", "Women", agg="mean", unit="% of residents", domain=[44, 52],
                  ramp="diverging"),
        FieldSpec("dependency_ratio", "Dependency ratio (0–14 and 60+ per 100 aged 15–59)",
                  agg="mean", unit="per 100", domain=[30, 70], ramp="reds"),
        FieldSpec("wp_population", "Residents (WorldPop 2020)", agg="sum", unit="people",
                  ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="demographics", title="Age & sex (WorldPop)", level=level, fields=specs, group=GROUP,
        description="Age and sex structure per cell from WorldPop 2020 constrained-to-settlement "
                    "estimates (100 m): children under 5, people 60+, shares of children, "
                    "elderly and women, and the dependency ratio. Census 2011 district age "
                    "profiles spread by a model: the age and sex shares are set per district, so they "
                    "separate cities and districts, not streets; the totals differ "
                    "from GHSL residents.",
        source="WorldPop Global Project Population Data: age/sex structures 2020 (100 m) via "
               "Earth Engine",
        license="CC BY 4.0 (WorldPop, University of Southampton)",
        default_field="elderly_60plus")
    return spec, _table(level, rows, specs)


# ── relative wealth (Meta RWI) ──────────────────────────────────────────────

def wealth(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 6
    w, s, e, n = gee.aligned_bbox(bbox, level)
    pad = 0.03
    fc = ee.FeatureCollection("projects/sat-io/open-datasets/facebook/relative_wealth_index") \
        .filterBounds(ee.Geometry.Rectangle([w - pad, s - pad, e + pad, n + pad]))
    pts = [(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1],
            f["properties"]["rwi"], f["properties"].get("error"))
           for f in fc.getInfo()["features"]]
    if not pts:
        raise RuntimeError("no RWI tiles in bbox")
    lat_step, lon_step = gee.cell_step(level)
    from pipeline._lib import digipin
    rows, rad2 = {}, 0.016 ** 2   # a zoom-14 tile is ~0.022°; stay inside one
    for i in range(round((n - s) / lat_step)):
        lat = s + (i + 0.5) * lat_step
        for j in range(round((e - w) / lon_step)):
            lng = w + (j + 0.5) * lon_step
            d2, p = min((((x - lng) * math.cos(math.radians(lat))) ** 2 + (y - lat) ** 2, (x, y, r, er))
                        for x, y, r, er in pts)
            if d2 > rad2:
                continue
            code = digipin.encode(lat, lng).replace("-", "")[:level]
            rows[code] = {"rwi": _r(p[2], 3), "rwi_error": _r(p[3], 3)}
    vals = sorted(v["rwi"] for v in rows.values())
    cuts = [vals[int(len(vals) * q / 5)] for q in range(1, 5)]
    for v in rows.values():
        q = 1 + sum(v["rwi"] >= c for c in cuts)
        v["wealth_quintile"] = ["Poorest fifth", "Second", "Middle", "Fourth",
                                "Richest fifth"][q - 1]
    specs = [
        FieldSpec("rwi", "Relative wealth index", agg="mean", unit="index (India = 0)",
                  domain=[-1.5, 1.5], ramp="viridis", higher_is="better"),
        FieldSpec("rwi_error", "RWI uncertainty", agg="mean", unit="± index", ramp="reds"),
        FieldSpec("wealth_quintile", "Wealth fifth within the city", type="category",
                  agg="mode", colors={"Poorest fifth": "#b2182b", "Second": "#ef8a62",
                                      "Middle": "#f7f7f7", "Fourth": "#67a9cf",
                                      "Richest fifth": "#2166ac"}),
    ]
    spec = DatasetSpec(
        id="wealth", title="Relative wealth (Meta RWI)", level=level, fields=specs, group=GROUP,
        description="Meta Data for Good Relative Wealth Index: asset-based wealth predicted from "
                    "satellite imagery and connectivity data, trained on DHS surveys, on ~2.4 km "
                    "Bing tiles (zoom 14). Relative within India (0 = national average). Cells "
                    "take the tile they fall in, so neighbouring cells share values; the quintile "
                    "is within this city's extent.",
        source="Meta Data for Good Relative Wealth Index (Chi et al. 2022, PNAS) via the "
               "awesome-gee-community-catalog",
        license="CC BY-NC 4.0 (Meta Data for Good)",
        default_field="rwi")
    return spec, _table(level, rows, specs)


# ── local climate zones (WUDAPT / RUB global LCZ map) ───────────────────────

# Stewart & Oke (2012) classes with the WUDAPT colour key.
_LCZ = {1: ("Compact high-rise", "#8c0000"), 2: ("Compact mid-rise", "#d10000"),
        3: ("Compact low-rise", "#ff0000"), 4: ("Open high-rise", "#bf4d00"),
        5: ("Open mid-rise", "#ff6600"), 6: ("Open low-rise", "#ff9955"),
        7: ("Lightweight low-rise", "#faee05"), 8: ("Large low-rise", "#bcbcbc"),
        9: ("Sparsely built", "#ffccaa"), 10: ("Heavy industry", "#555555"),
        11: ("Dense trees", "#006a00"), 12: ("Scattered trees", "#00aa00"),
        13: ("Bush, scrub", "#648525"), 14: ("Low plants", "#b9db79"),
        15: ("Bare rock or paved", "#000000"), 16: ("Bare soil or sand", "#fbf7ae"),
        17: ("Water", "#6a6aff")}
_LCZ_GROUPS = {"compact": (1, 2, 3), "open": (4, 5, 6), "lightweight": (7,),
               "industrial": (8, 10), "natural": (11, 12, 13, 14, 16, 17)}


def climate_zones(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    lcz = ee.ImageCollection("RUB/RUBCLIM/LCZ/global_lcz_map/latest").filterBounds(geom) \
        .mosaic().select("LCZ_Filter")
    shares = ee.Image.cat([lcz.remap(list(v), [1] * len(v), 0).rename(k)
                           for k, v in _LCZ_GROUPS.items()])
    a = gee.fetch(gee.to_cells(shares, 100), bbox, level)
    b = gee.fetch(gee.to_cells(lcz.rename("lcz"), 100, "mode"), bbox, level)
    rows = {}
    for code, x in gee.merge(a, b).items():
        z = x.get("lcz")
        if z is None:
            continue
        rows[code] = {"lcz": _LCZ.get(int(round(z)), (None,))[0],
                      **{f"{k}_pct": _r(100 * x[k]) if x.get(k) is not None else None
                         for k in _LCZ_GROUPS}}
    specs = [
        FieldSpec("lcz", "Local climate zone", type="category", agg="mode",
                  colors={n: c for n, c in _LCZ.values()}),
        FieldSpec("compact_pct", "Compact built form (LCZ 1–3)", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="reds"),
        FieldSpec("open_pct", "Open built form (LCZ 4–6)", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="heat"),
        FieldSpec("lightweight_pct", "Lightweight low-rise (LCZ 7)", agg="mean",
                  unit="% of cell", domain=[0, 100], ramp="heat"),
        FieldSpec("industrial_pct", "Large low-rise and industry (LCZ 8, 10)", agg="mean",
                  unit="% of cell", domain=[0, 100], ramp="viridis"),
        FieldSpec("natural_pct", "Natural cover (LCZ A–G)", agg="mean", unit="% of cell",
                  domain=[0, 100], ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="climate_zones", title="Local climate zones", level=level, fields=specs,
        group=GROUP,
        description="Stewart & Oke Local Climate Zones from the global WUDAPT-based map "
                    "(Demuzere et al. 2022, 100 m, ~2018): the standard urban-form classes "
                    "used in heat studies (compact/open high-, mid- and low-rise, lightweight "
                    "low-rise, industry, trees, water). Lightweight low-rise often marks "
                    "informal or temporary housing, but it is a remote-sensing class, not a "
                    "slum census. Typical classification accuracy is ~70–80%.",
        source="RUB Climatology global LCZ map v1 via Earth Engine",
        license="CC BY 4.0 (Demuzere et al. 2022)",
        default_field="lcz")
    return spec, _table(level, rows, specs)


# ── humid heat (ERA5-Land) ──────────────────────────────────────────────────

def _wetbulb(t, rh):
    """Stull (2011) wet-bulb temperature, °C, from air °C and RH % (ee.Image)."""
    return (t.multiply(rh.add(8.313659).sqrt().multiply(0.151977).atan())
            .add(t.add(rh).atan()).subtract(rh.subtract(1.676331).atan())
            .add(rh.pow(1.5).multiply(0.00391838).multiply(rh.multiply(0.023101).atan()))
            .subtract(4.686035))


def humid_heat(region):
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 5
    col = _year(ee.ImageCollection("ECMWF/ERA5_LAND/DAILY_AGGR"))

    def day(im):
        tx = im.select("temperature_2m_max").subtract(273.15)
        tn = im.select("temperature_2m_min").subtract(273.15)
        td = im.select("dewpoint_temperature_2m").subtract(273.15)
        # Afternoon humidity: the day's mean dew point against its maximum temperature.
        es = lambda x: x.multiply(17.625).divide(x.add(243.04)).exp()
        rh = es(td).divide(es(tx)).multiply(100).min(100)
        tw = _wetbulb(tx, rh)
        return ee.Image.cat([tx.gte(40).rename("hot"), tn.gte(28).rename("warm"),
                             tw.gte(28).rename("humid"), tx.rename("tx"), tw.rename("tw")])
    d = col.map(day)
    img = ee.Image.cat([d.select(["hot", "warm", "humid"]).sum(),
                        d.select(["tx", "tw"]).max()])
    raw = gee.fetch(gee.to_cells(img, 11000), bbox, level)
    rows = {c: {"hot_days_40c": round(x["hot"]), "warm_nights_28c": round(x["warm"]),
                "humid_heat_days": round(x["humid"]), "peak_tmax_c": _r(x.get("tx")),
                "peak_wetbulb_c": _r(x.get("tw"))}
            for c, x in raw.items() if x.get("hot") is not None}
    specs = [
        FieldSpec("hot_days_40c", f"Days ≥ 40 °C ({YEAR})", agg="mean", unit="days",
                  ramp="heat", higher_is="worse"),
        FieldSpec("warm_nights_28c", f"Nights ≥ 28 °C ({YEAR})", agg="mean", unit="nights",
                  ramp="heat", higher_is="worse"),
        FieldSpec("humid_heat_days", f"Humid-heat days, wet-bulb ≥ 28 °C ({YEAR})", agg="mean",
                  unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("peak_tmax_c", f"Hottest day ({YEAR})", agg="max", unit="°C",
                  domain=[34, 48], ramp="heat", higher_is="worse"),
        FieldSpec("peak_wetbulb_c", f"Peak afternoon wet-bulb ({YEAR})", agg="max", unit="°C",
                  domain=[24, 32], ramp="heat", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="humid_heat", title="Heat & humid heat (ERA5-Land)", level=level, fields=specs,
        group=GROUP,
        description=f"Air-temperature heat stress for {YEAR} from ERA5-Land daily aggregates "
                    "(~9 km reanalysis): days with a maximum ≥ 40 °C (the IMD plains heatwave "
                    "threshold), nights with a minimum ≥ 28 °C, and afternoon wet-bulb (Stull "
                    "2011, daily max temperature with mean dew point) — humid-heat days are "
                    "wet-bulb ≥ 28 °C. Reanalysis smooths the urban heat island and usually "
                    "reads 1–2 °C below city stations; use Land surface temperature for "
                    "street-scale contrast.",
        source="ECMWF ERA5-Land daily aggregated via Earth Engine",
        license="Copernicus licence (ECMWF / C3S)",
        default_field="hot_days_40c")
    return spec, _table(level, rows, specs)

# ── climate 2050 (NASA NEX-GDDP-CMIP6, delta method on observed baselines) ──

CMIP_MODELS = ["ACCESS-CM2", "EC-Earth3", "MIROC6", "MPI-ESM1-2-HR", "MRI-ESM2-0", "NorESM2-MM"]
CMIP_HIST, CMIP_FUT = (1995, 2014), (2041, 2060)
OBS_YEARS = (2015, 2024)


def _cmip(ee, geom, model, scenario, years, band, months=None):
    col = ee.ImageCollection("NASA/GDDP-CMIP6").filterBounds(geom).filter(ee.Filter.eq("model", model)) \
        .filter(ee.Filter.eq("scenario", scenario)).filterDate(f"{years[0]}-01-01", f"{years[1] + 1}-01-01").select(band)
    return col.filter(ee.Filter.calendarRange(months[0], months[1], "month")) if months else col


def _ens_delta(ee, geom, band, scenario, months):
    """Ensemble-mean change in the season's mean of `band` (K), future minus historical."""
    ds = [_cmip(ee, geom, m, scenario, CMIP_FUT, band, months).mean()
          .subtract(_cmip(ee, geom, m, "historical", CMIP_HIST, band, months).mean()) for m in CMIP_MODELS]
    return ee.ImageCollection(ds).mean()


def _ens_rx1day_ratio(ee, geom, scenario):
    """Ensemble-mean ratio of the mean annual wettest day, future ÷ historical."""
    def rx(model, scen, years):
        ims = [_cmip(ee, geom, model, scen, (y, y), "pr").max() for y in range(years[0], years[1] + 1)]
        return ee.ImageCollection(ims).mean()
    return ee.ImageCollection([rx(m, scenario, CMIP_FUT).divide(rx(m, "historical", CMIP_HIST)) for m in CMIP_MODELS]).mean()


def climate_future(region):
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 5
    yrs = OBS_YEARS[1] - OBS_YEARS[0] + 1
    era = ee.ImageCollection("ECMWF/ERA5_LAND/DAILY_AGGR").filterDate(f"{OBS_YEARS[0]}-01-01", f"{OBS_YEARS[1] + 1}-01-01")
    out = {}
    for scen, tag in (("ssp245", "mid"), ("ssp585", "high")):
        dx = _ens_delta(ee, geom, "tasmax", scen, (3, 6))
        dn = _ens_delta(ee, geom, "tasmin", scen, (5, 9))

        def day(im, dx=dx, dn=dn):
            tx = im.select("temperature_2m_max").subtract(273.15)
            tn = im.select("temperature_2m_min").subtract(273.15)
            return ee.Image.cat([tx.gte(40).rename("hot_now"), tx.add(dx).gte(40).rename("hot"),
                                 tn.gte(28).rename("warm_now"), tn.add(dn).gte(28).rename("warm")])
        d = era.map(day).sum().divide(yrs)
        out[tag] = ee.Image.cat([d, dx.rename("dx")])
    chirps = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").select("precipitation")
    rx_now = ee.ImageCollection([chirps.filterDate(f"{y}-01-01", f"{y + 1}-01-01").max()
                                 for y in range(2005, 2025)]).mean().rename("rx_now")
    img = ee.Image.cat([out["mid"].select(["hot_now", "hot", "warm_now", "warm", "dx"]),
                        out["high"].select(["hot", "warm", "dx"], ["hot_hi", "warm_hi", "dx_hi"]),
                        _ens_rx1day_ratio(ee, geom, "ssp245").rename("rxr")])
    a = gee.fetch(gee.to_cells(img, 11000), bbox, level)
    b = gee.fetch(gee.to_cells(rx_now, 5500), bbox, level)
    rows = {}
    for c, x in gee.merge(a, b).items():
        if x.get("hot_now") is None or x.get("dx") is None:
            continue
        rx = x.get("rx_now")
        rows[c] = {"hot_days_now": _r(x["hot_now"]), "hot_days_2050": _r(x["hot"]), "hot_days_2050_high": _r(x.get("hot_hi")),
                   "warm_nights_now": _r(x["warm_now"]), "warm_nights_2050": _r(x["warm"]),
                   "tmax_rise_c": _r(x["dx"], 2), "tmax_rise_high_c": _r(x.get("dx_hi"), 2),
                   "wettest_day_mm": _r(rx), "wettest_day_2050_mm": _r(rx * x["rxr"]) if rx is not None and x.get("rxr") else None,
                   "wettest_day_change_pct": _r(100 * (x["rxr"] - 1)) if x.get("rxr") else None}
    specs = [
        FieldSpec("hot_days_now", f"Days ≥ 40 °C a year ({OBS_YEARS[0]}–{OBS_YEARS[1]})", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("hot_days_2050", "Days ≥ 40 °C a year by 2050 (SSP2-4.5)", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("hot_days_2050_high", "Days ≥ 40 °C a year by 2050 (SSP5-8.5)", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("warm_nights_now", "Nights ≥ 28 °C a year now", agg="mean", unit="nights", ramp="heat", higher_is="worse"),
        FieldSpec("warm_nights_2050", "Nights ≥ 28 °C a year by 2050 (SSP2-4.5)", agg="mean", unit="nights", ramp="heat", higher_is="worse"),
        FieldSpec("tmax_rise_c", "Hot-season daytime warming by 2050 (SSP2-4.5)", agg="mean", unit="°C", domain=[0, 3], ramp="heat", higher_is="worse"),
        FieldSpec("tmax_rise_high_c", "Hot-season daytime warming by 2050 (SSP5-8.5)", agg="mean", unit="°C", domain=[0, 4], ramp="heat", higher_is="worse"),
        FieldSpec("wettest_day_mm", "Wettest day of the year, average (2005–2024)", agg="mean", unit="mm", ramp="blues", higher_is="worse"),
        FieldSpec("wettest_day_2050_mm", "Wettest day of the year by 2050 (SSP2-4.5)", agg="mean", unit="mm", ramp="blues", higher_is="worse"),
        FieldSpec("wettest_day_change_pct", "Change in the wettest day by 2050 (SSP2-4.5)", agg="mean", unit="%", domain=[-10, 40], ramp="blues", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="climate_future", title="Climate 2050 (CMIP6, downscaled)", level=level, fields=specs, group=GROUP,
        description=f"Heat and extreme rain by 2041–2060 against today. A six-model NASA NEX-GDDP-CMIP6 ensemble "
                    f"({', '.join(CMIP_MODELS)}) gives the change from {CMIP_HIST[0]}–{CMIP_HIST[1]}: hot-season (Mar–Jun) "
                    "daytime and monsoon (May–Sep) night-time warming, added to every ERA5-Land day of "
                    f"{OBS_YEARS[0]}–{OBS_YEARS[1]} to count days ≥ 40 °C and nights ≥ 28 °C; and the ratio of the "
                    "mean annual wettest day, applied to CHIRPS 2005–2024. Climate models are ~25 km and reanalysis "
                    "~9 km, so this is a city- and district-scale outlook: street-level heat comes from Land surface temperature.",
        source="NASA NEX-GDDP-CMIP6, ECMWF ERA5-Land and UCSB CHIRPS via Earth Engine (pipeline/cells/ee_layers.py)",
        license="NEX-GDDP-CMIP6: CC BY 4.0 (most models); ERA5-Land: Copernicus licence; CHIRPS: public domain",
        default_field="hot_days_2050")
    return spec, _table(level, rows, specs)

LAYERS = {
    "population": population, "built_up": built_up, "land_cover": land_cover,
    "vegetation": vegetation, "terrain": terrain, "water": water,
    "nightlights": nightlights, "surface_heat": heat, "air_quality": air_quality,
    "rainfall": rainfall, "building_stock": building_stock, "soil": soil,
    "accessibility": accessibility, "waterlogging": waterlogging,
    "demographics": demographics, "wealth": wealth, "climate_zones": climate_zones,
    "humid_heat": humid_heat, "climate_future": climate_future,
}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Bake open raster datasets into the cell store.")
    p.add_argument("layers", nargs="*", help=f"subset of {sorted(LAYERS)} (default: all)")
    p.add_argument("--region", default="all", help="region name, comma list, or 'all' (8 metros)")
    p.add_argument("--out", default=str(REPO / "data" / "cells"))
    p.add_argument("--no-parquet", action="store_true")
    p.add_argument("--list", action="store_true", help="print layer ids and exit")
    a = p.parse_args(argv)
    if a.list:
        print("\n".join(LAYERS))
        return 0
    unknown = set(a.layers) - set(LAYERS)
    if unknown:
        p.error(f"unknown layer(s) {sorted(unknown)}; known: {sorted(LAYERS)}")
    regions = list(CITY_PILOTS) if a.region == "all" else a.region.split(",")
    failed = 0
    for region in regions:
        for name in a.layers or list(LAYERS):
            t0 = time.time()
            try:
                spec, table = LAYERS[name](region)
            except Exception as exc:  # keep going: one bad source must not sink the batch
                failed += 1
                print(json.dumps({"dataset": name, "region": region, "error": str(exc)[:300]}),
                      flush=True)
                continue
            res = store.write_dataset(a.out, spec, region, table, parquet=not a.no_parquet)
            res["seconds"] = round(time.time() - t0, 1)
            print(json.dumps(res), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
