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
    under5, child, school, youth = (0, 1), (0, 1, 5, 10), (5, 10), (15, 20)
    old = (60, 65, 70, 75, 80)
    allages = (0, 1) + tuple(range(5, 81, 5))
    km2 = ee.Image.pixelArea().divide(1e6)
    img = ee.Image.cat([wp.select("population").rename("tot"), total(under5).rename("u5"),
                        total(child).rename("u15"), total(old).rename("o60"),
                        total(allages, ("F",)).rename("fem"), total(school).rename("s514"),
                        total(youth).rename("y1524")]).divide(km2)
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
            "school_age": round(x["s514"] * a) if x.get("s514") is not None else None,
            "youth_15_24": round(x["y1524"] * a) if x.get("y1524") is not None else None,
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
        FieldSpec("school_age", "Children of school age (5–14)", agg="sum", unit="people",
                  ramp="viridis"),
        FieldSpec("youth_15_24", "Young people aged 15–24", agg="sum", unit="people",
                  ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="demographics", title="Age & sex (WorldPop)", level=level, fields=specs, group=GROUP,
        description="Age and sex structure per cell from WorldPop 2020 constrained-to-settlement "
                    "estimates (100 m): children under 5, school-age children (5–14), young people (15–24), people 60+, shares of children, "
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
CDD_BASE = 24.0                  # °C daily mean; the balance point commonly used for Indian homes (BEE/ECBC)


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
            tx2, tn2 = tx.add(dx), tn.add(dn)
            mean_now, mean_fut = tx.add(tn).divide(2), tx2.add(tn2).divide(2)
            # ±1 °C counts give how fast the counts change per degree, so a block's own heat island can shift them
            return ee.Image.cat([tx.gte(40).rename("hot_now"), tx2.gte(40).rename("hot"),
                                 tn.gte(28).rename("warm_now"), tn2.gte(28).rename("warm"),
                                 tx.gte(39).subtract(tx.gte(41)).rename("hot_s_now"), tx2.gte(39).subtract(tx2.gte(41)).rename("hot_s"),
                                 tn.gte(27).subtract(tn.gte(29)).rename("warm_s_now"), tn2.gte(27).subtract(tn2.gte(29)).rename("warm_s"),
                                 mean_now.subtract(CDD_BASE).max(0).rename("cdd_now"), mean_fut.subtract(CDD_BASE).max(0).rename("cdd"),
                                 mean_fut.gte(CDD_BASE).rename("cool_days")])
        d = era.map(day).sum().divide(yrs)
        out[tag] = ee.Image.cat([d, dx.rename("dx")])
    chirps = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").select("precipitation")
    rx_now = ee.ImageCollection([chirps.filterDate(f"{y}-01-01", f"{y + 1}-01-01").max()
                                 for y in range(2005, 2025)]).mean().rename("rx_now")
    img = ee.Image.cat([out["mid"].select(["hot_now", "hot", "warm_now", "warm", "dx", "hot_s_now", "hot_s", "warm_s_now",
                                           "warm_s", "cdd_now", "cdd", "cool_days"]),
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
                   "wettest_day_change_pct": _r(100 * (x["rxr"] - 1)) if x.get("rxr") else None,
                   "hot_days_per_c_now": _r((x.get("hot_s_now") or 0) / 2), "hot_days_per_c_2050": _r((x.get("hot_s") or 0) / 2),
                   "warm_nights_per_c_now": _r((x.get("warm_s_now") or 0) / 2), "warm_nights_per_c_2050": _r((x.get("warm_s") or 0) / 2),
                   "cdd_now": _r(x.get("cdd_now")), "cdd_2050": _r(x.get("cdd")), "cooling_days_2050": _r(x.get("cool_days"))}
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
        FieldSpec("hot_days_per_c_now", "Extra days ≥ 40 °C per 1 °C of local warming, now", agg="mean", unit="days/°C", ramp="heat", higher_is="worse"),
        FieldSpec("hot_days_per_c_2050", "Extra days ≥ 40 °C per 1 °C of local warming, 2050", agg="mean", unit="days/°C", ramp="heat", higher_is="worse"),
        FieldSpec("warm_nights_per_c_now", "Extra nights ≥ 28 °C per 1 °C of local warming, now", agg="mean", unit="nights/°C", ramp="heat", higher_is="worse"),
        FieldSpec("warm_nights_per_c_2050", "Extra nights ≥ 28 °C per 1 °C of local warming, 2050", agg="mean", unit="nights/°C", ramp="heat", higher_is="worse"),
        FieldSpec("cdd_now", f"Cooling degree-days a year (base {CDD_BASE:g} °C), now", agg="mean", unit="°C·days", ramp="heat", higher_is="worse"),
        FieldSpec("cdd_2050", f"Cooling degree-days a year (base {CDD_BASE:g} °C), 2050 (SSP2-4.5)", agg="mean", unit="°C·days", ramp="heat", higher_is="worse"),
        FieldSpec("cooling_days_2050", f"Days a year with a mean ≥ {CDD_BASE:g} °C by 2050", agg="mean", unit="days", ramp="heat", higher_is="worse"),
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

# ── flood 2050 (WRI Aqueduct Floods v2: river and coastal, 1-in-100-year) ──

AQ_RIVER_GCMS = ["00000NorESM1-M", "0000GFDL-ESM2M", "0000HadGEM2-ES", "00IPSL-CM5A-LR", "MIROC-ESM-CHEM"]
AQ_WET_M = 0.05                    # depth that counts as flooded


def _aq(ee, name):
    return ee.Image(f"WRI/Aqueduct_Flood_Hazard_Maps/V2/{name}").select("inundation_depth").unmask(0)


def flood_future(region):
    """1-in-100-year river and coastal flooding now and by 2050 (WRI Aqueduct, ~1 km)."""
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 6

    def river(scen, year=2050):
        return ee.ImageCollection([_aq(ee, f"inunriver_{scen}_{g}_{year}_rp00100") for g in AQ_RIVER_GCMS]).mean()

    layers = {
        "rn": _aq(ee, "inunriver_historical_000000000WATCH_1980_rp00100"), "r5": river("rcp4p5"), "r8": river("rcp8p5"),
        # Coastal with land subsidence, the Aqueduct default for 2050; "now" is the 2010 baseline without it
        "cn": _aq(ee, "inuncoast_historical_nosub_hist_rp0100_0"), "c5": _aq(ee, "inuncoast_rcp4p5_wtsub_2050_rp0100_0"),
        "c8": _aq(ee, "inuncoast_rcp8p5_wtsub_2050_rp0100_0"),
        # The long view: 2080, when most of today's buildings will still stand
        "r80": river("rcp4p5", 2080), "c80": _aq(ee, "inuncoast_rcp4p5_wtsub_2080_rp0100_0"),
        "c80h": _aq(ee, "inuncoast_rcp8p5_wtsub_2080_rp0100_0"),
    }
    bands = []
    for k, im in layers.items():
        bands += [im.gt(AQ_WET_M).rename(f"{k}_w"), im.rename(f"{k}_d")]
    raw = gee.fetch(gee.to_cells(ee.Image.cat(bands), 925), bbox, level)
    rows = {}
    for c, x in raw.items():
        if x.get("rn_w") is None:
            continue

        def pct(k, x=x):
            return _r(100 * (x.get(f"{k}_w") or 0), 1)

        def depth(k, x=x):
            w = x.get(f"{k}_w") or 0
            return _r((x.get(f"{k}_d") or 0) / w, 2) if w > 0.01 else 0.0
        r = {"river_pct_now": pct("rn"), "river_pct_2050": pct("r5"), "river_pct_2050_high": pct("r8"),
             "river_depth_2050_m": depth("r5"), "coast_pct_now": pct("cn"), "coast_pct_2050": pct("c5"),
             "coast_pct_2050_high": pct("c8"), "coast_depth_2050_m": depth("c5")}
        r["any_pct_now"] = max(r["river_pct_now"], r["coast_pct_now"])
        r["any_pct_2050"] = max(r["river_pct_2050"], r["coast_pct_2050"])
        r.update({"river_pct_2080": pct("r80"), "coast_pct_2080": pct("c80"), "coast_pct_2080_high": pct("c80h")})
        r["any_pct_2080"] = max(r["river_pct_2080"], r["coast_pct_2080"])
        rows[c] = r                 # keep dry cells: the lens counts their residents as safe
    specs = [
        FieldSpec("any_pct_now", "1-in-100-year flood (river or sea), now", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("any_pct_2050", "1-in-100-year flood (river or sea) by 2050, RCP4.5", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("any_pct_2080", "1-in-100-year flood (river or sea) by 2080, RCP4.5", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("river_pct_2080", "River 100-year flood by 2080 (RCP4.5, 5 models)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("coast_pct_2080", "Coastal 100-year flood by 2080 (RCP4.5, sea-level rise and subsidence)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("coast_pct_2080_high", "Coastal 100-year flood by 2080 (RCP8.5, with subsidence)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("river_pct_now", "River 100-year flood, now (1980 baseline)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("river_pct_2050", "River 100-year flood by 2050 (RCP4.5, 5 models)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("river_pct_2050_high", "River 100-year flood by 2050 (RCP8.5)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("river_depth_2050_m", "River 100-year flood depth by 2050 where flooded", agg="mean", unit="m", domain=[0, 3], ramp="blues", higher_is="worse"),
        FieldSpec("coast_pct_now", "Coastal 100-year flood, now (2010)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("coast_pct_2050", "Coastal 100-year flood by 2050 (RCP4.5, sea-level rise and subsidence)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("coast_pct_2050_high", "Coastal 100-year flood by 2050 (RCP8.5, with subsidence)", agg="mean", unit="% of area", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("coast_depth_2050_m", "Coastal 100-year flood depth by 2050 where flooded", agg="mean", unit="m", domain=[0, 3], ramp="blues", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="flood_future", title="Flood 2050 (WRI Aqueduct)", level=level, fields=specs, group=GROUP,
        description="1-in-100-year river and coastal flooding now, by 2050 and by 2080 from WRI Aqueduct Floods v2 (~1 km). "
                    "River: GLOFRIS driven by five CMIP5 models (RCP4.5 and 8.5) against a 1980 baseline. Coast: "
                    "sea-level rise, storm surge and land subsidence against 2010. No flood defences are modelled and "
                    f"1 km cannot see drains or embankments; a cell counts as flooded where depth > {AQ_WET_M} m.",
        source="WRI/Aqueduct_Flood_Hazard_Maps/V2 via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (WRI)", default_field="any_pct_2050")
    return spec, _table(level, rows, specs)

# ── water risk now and 2050 (WRI Aqueduct 4.0, sub-basin polygons) ──

AQW_BASE = {"bws_raw": "ws", "bwd_raw": "wd", "gtd_raw": "gtd", "drr_score": "drr", "iav_raw": "iav",
            "udw_raw": "udw", "usa_raw": "usa"}
AQW_FUT = {"bau30_ws_x_r": "ws30", "bau50_ws_x_r": "ws50", "opt50_ws_x_r": "ws50o", "pes50_ws_x_r": "ws50p", "bau50_wd_x_r": "wd50"}


def _fc_image(ee, fc, props):
    return ee.Image.cat([fc.filter(ee.Filter.gte(k, -1e30)).reduceToImage([k], ee.Reducer.first()).rename(v)
                         for k, v in props.items()])


def water_risk(region):
    """Basin water stress, depletion and groundwater decline now and by 2050 (WRI Aqueduct 4.0)."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 5
    base = ee.FeatureCollection("WRI/Aqueduct_Water_Risk/V4/baseline_annual").filterBounds(geom)
    fut = ee.FeatureCollection("WRI/Aqueduct_Water_Risk/V4/future_annual").filterBounds(geom)
    img = ee.Image.cat([_fc_image(ee, base, AQW_BASE), _fc_image(ee, fut, AQW_FUT)])
    raw = gee.fetch(gee.to_cells(img, 1000), bbox, level)

    def pct(v):
        return _r(100 * v, 1) if v is not None and v >= 0 else None
    rows = {}
    for c, x in raw.items():
        if x.get("ws") is None and x.get("ws50") is None:
            continue
        rows[c] = {"water_stress_pct": pct(x.get("ws")), "water_stress_2030_pct": pct(x.get("ws30")), "water_stress_2050_pct": pct(x.get("ws50")),
                   "water_stress_2050_opt_pct": pct(x.get("ws50o")), "water_stress_2050_pes_pct": pct(x.get("ws50p")),
                   "depletion_pct": pct(x.get("wd")), "depletion_2050_pct": pct(x.get("wd50")),
                   "groundwater_decline_cm_yr": _r(x.get("gtd"), 1) if x.get("gtd") is not None and x["gtd"] > -9000 else None,
                   "drought_risk": _r(x.get("drr"), 2) if x.get("drr") is not None and x["drr"] >= 0 else None,
                   "variability": _r(x.get("iav"), 2) if x.get("iav") is not None and x["iav"] >= 0 else None,
                   "unimproved_water_pct": pct(x.get("udw")), "unimproved_sanitation_pct": pct(x.get("usa"))}
    specs = [
        FieldSpec("water_stress_pct", "Baseline water stress (withdrawals ÷ available supply)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("water_stress_2030_pct", "Water stress by 2030 (business as usual)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("water_stress_2050_pct", "Water stress by 2050 (business as usual)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("water_stress_2050_opt_pct", "Water stress by 2050 (optimistic)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("water_stress_2050_pes_pct", "Water stress by 2050 (pessimistic)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("depletion_pct", "Water depletion (consumption ÷ available supply)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("depletion_2050_pct", "Water depletion by 2050 (business as usual)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("groundwater_decline_cm_yr", "Groundwater table decline (1990–2014 trend)", agg="mean", unit="cm/yr", domain=[-2, 15], ramp="reds", higher_is="worse"),
        FieldSpec("drought_risk", "Drought risk score", agg="mean", unit="0-5", domain=[0, 5], ramp="reds", higher_is="worse"),
        FieldSpec("variability", "Year-to-year variability of supply", agg="mean", unit="ratio", domain=[0, 1.5], ramp="reds", higher_is="worse"),
        FieldSpec("unimproved_water_pct", "Population without improved drinking water (district)", agg="mean", unit="%", domain=[0, 30], ramp="reds", higher_is="worse"),
        FieldSpec("unimproved_sanitation_pct", "Population without improved sanitation (district)", agg="mean", unit="%", domain=[0, 60], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="water_risk", title="Water risk now and 2050 (WRI Aqueduct)", level=level, fields=specs, group=GROUP,
        description="WRI Aqueduct 4.0 per sub-basin (HydroBASINS level 6, split by state): water stress and depletion "
                    "(PCR-GLOBWB 2, 1979–2019), groundwater table decline (1990–2014 trend), drought risk and access to "
                    "drinking water and sanitation; and 2050 stress and depletion under business-as-usual (SSP3 RCP7.0), "
                    "optimistic (SSP1 RCP2.6) and pessimistic (SSP5 RCP8.5) futures. The future runs use a different model set "
                    "from the baseline, so compare 2030 with 2050, not baseline with 2050. Basin values cover the whole "
                    "catchment, so every block in a basin gets the same number: a city-level outlook, not a block one.",
        source="WRI/Aqueduct_Water_Risk/V4 via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (WRI)", default_field="water_stress_2050_pct")
    return spec, _table(level, rows, specs)


# ── humid heat 2050 (wet-bulb: ERA5-Land days shifted by the CMIP6 change in temperature and humidity) ──

WETBULB_DANGER = 31.0            # °C wet-bulb: outdoor work unsafe for most people (Vecellio et al. 2022 find ~31 °C limits)


def humid_future(region):
    """Humid-heat days (afternoon wet-bulb ≥ 28 °C and ≥ 31 °C) now and by 2050, delta method on ERA5-Land."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 5
    yrs = OBS_YEARS[1] - OBS_YEARS[0] + 1
    era = ee.ImageCollection("ECMWF/ERA5_LAND/DAILY_AGGR").filterDate(f"{OBS_YEARS[0]}-01-01", f"{OBS_YEARS[1] + 1}-01-01")
    es = lambda x: x.multiply(17.625).divide(x.add(243.04)).exp()
    out = {}
    for scen, tag in (("ssp245", "mid"), ("ssp585", "high")):
        dx = _ens_delta(ee, geom, "tasmax", scen, (3, 9))
        dh = _ens_delta(ee, geom, "hurs", scen, (3, 9))

        def day(im, dx=dx, dh=dh):
            tx = im.select("temperature_2m_max").subtract(273.15)
            td = im.select("dewpoint_temperature_2m").subtract(273.15)
            rh = es(td).divide(es(tx)).multiply(100).min(100)
            tw, tw2 = _wetbulb(tx, rh), _wetbulb(tx.add(dx), rh.add(dh).max(1).min(100))
            return ee.Image.cat([tw.gte(28).rename("h_now"), tw2.gte(28).rename("h"), tw.gte(WETBULB_DANGER).rename("d_now"),
                                 tw2.gte(WETBULB_DANGER).rename("d"), tw.rename("tw_now"), tw2.rename("tw")])
        d = era.map(day)
        out[tag] = ee.Image.cat([d.select(["h_now", "h", "d_now", "d"]).sum().divide(yrs),
                                 d.select(["tw_now", "tw"]).max(), dh.rename("dh")])
    img = ee.Image.cat([out["mid"], out["high"].select(["h", "d", "tw"], ["h_hi", "d_hi", "tw_hi"])])
    raw = gee.fetch(gee.to_cells(img, 11000), bbox, level)
    rows = {}
    for c, x in raw.items():
        if x.get("h_now") is None or x.get("h") is None:
            continue
        rows[c] = {"humid_days_now": _r(x["h_now"]), "humid_days_2050": _r(x["h"]), "humid_days_2050_high": _r(x.get("h_hi")),
                   "danger_days_now": _r(x.get("d_now")), "danger_days_2050": _r(x.get("d")), "danger_days_2050_high": _r(x.get("d_hi")),
                   "peak_wetbulb_now_c": _r(x.get("tw_now")), "peak_wetbulb_2050_c": _r(x.get("tw")), "peak_wetbulb_2050_high_c": _r(x.get("tw_hi")),
                   "humidity_change_pts": _r(x.get("dh"), 1)}
    specs = [
        FieldSpec("humid_days_now", f"Humid-heat days a year, wet-bulb ≥ 28 °C ({OBS_YEARS[0]}–{OBS_YEARS[1]})", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("humid_days_2050", "Humid-heat days a year by 2050 (SSP2-4.5)", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("humid_days_2050_high", "Humid-heat days a year by 2050 (SSP5-8.5)", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("danger_days_now", f"Dangerous humid-heat days, wet-bulb ≥ {WETBULB_DANGER:g} °C, now", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("danger_days_2050", f"Dangerous humid-heat days (≥ {WETBULB_DANGER:g} °C) by 2050 (SSP2-4.5)", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("danger_days_2050_high", f"Dangerous humid-heat days (≥ {WETBULB_DANGER:g} °C) by 2050 (SSP5-8.5)", agg="mean", unit="days", ramp="heat", higher_is="worse"),
        FieldSpec("peak_wetbulb_now_c", "Peak afternoon wet-bulb, now", agg="max", unit="°C", domain=[24, 34], ramp="heat", higher_is="worse"),
        FieldSpec("peak_wetbulb_2050_c", "Peak afternoon wet-bulb by 2050 (SSP2-4.5)", agg="max", unit="°C", domain=[24, 34], ramp="heat", higher_is="worse"),
        FieldSpec("peak_wetbulb_2050_high_c", "Peak afternoon wet-bulb by 2050 (SSP5-8.5)", agg="max", unit="°C", domain=[24, 34], ramp="heat", higher_is="worse"),
        FieldSpec("humidity_change_pts", "Change in hot-season relative humidity by 2050 (SSP2-4.5)", agg="mean", unit="points", domain=[-5, 5], ramp="diverging"),
    ]
    spec = DatasetSpec(
        id="humid_future", title="Humid heat 2050 (wet-bulb, CMIP6)", level=level, fields=specs, group=GROUP,
        description=f"Afternoon wet-bulb temperature (Stull 2011, daily maximum temperature with the mean dew point) on every "
                    f"ERA5-Land day of {OBS_YEARS[0]}–{OBS_YEARS[1]}, and the same days shifted by the six-model NEX-GDDP-CMIP6 "
                    f"change to 2041–2060 in March–September maximum temperature and relative humidity "
                    f"({', '.join(CMIP_MODELS)}). Days at a wet-bulb of 28 °C or more are humid-heat days; "
                    f"{WETBULB_DANGER:g} °C or more is where lab studies find healthy young people can no longer shed heat. "
                    "A ~9–25 km city-scale outlook; reanalysis runs 1–2 °C cool in cities.",
        source="NASA NEX-GDDP-CMIP6 and ECMWF ERA5-Land via Earth Engine (pipeline/cells/ee_layers.py)",
        license="NEX-GDDP-CMIP6: CC BY 4.0 (most models); ERA5-Land: Copernicus licence", default_field="humid_days_2050")
    return spec, _table(level, rows, specs)


# ── air trend (Sentinel-5P NO₂ 2019 → latest year, satellite PM2.5 2012 → 2022, SO₂) ──

AIR_TREND_FROM = 2019            # first full year of Sentinel-5P OFFL NO₂
PM_TREND_FROM, PM_TREND_TO = 2012, 2022


def air_trend(region):
    """Which blocks' air got cleaner or dirtier: NO₂ since 2019, PM2.5 over ten years, and SO₂ hotspots."""
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 6

    def s5p(cid, band, y):
        return _year(ee.ImageCollection(cid).select(band), y).mean()
    no2 = "COPERNICUS/S5P/OFFL/L3_NO2", "tropospheric_NO2_column_number_density"
    img = ee.Image.cat([
        s5p(*no2, AIR_TREND_FROM).multiply(1e6).rename("n0"), s5p(*no2, YEAR).multiply(1e6).rename("n1"),
        s5p("COPERNICUS/S5P/OFFL/L3_SO2", "SO2_column_number_density", YEAR).multiply(1e6).rename("so2"),
    ])
    a = gee.fetch(gee.to_cells(img, 1113), bbox, level)
    pmc = ee.ImageCollection("projects/sat-io/open-datasets/GLOBAL-SATELLITE-PM25/ANNUAL")

    def pm(y):
        return pmc.filter(ee.Filter.calendarRange(y, y, "year")).first()
    b = gee.fetch(gee.to_cells(ee.Image.cat([pm(PM_TREND_FROM).rename("p0"), pm(PM_TREND_TO).rename("p1")]), 1000), bbox, level)
    rows = {}
    for c, x in gee.merge(a, b).items():
        n0, n1, p0, p1 = x.get("n0"), x.get("n1"), x.get("p0"), x.get("p1")
        if n1 is None and p1 is None:
            continue
        rows[c] = {"no2_2019": _r(n0), "no2_latest": _r(n1),
                   "no2_change_pct": _r(100 * (n1 - n0) / n0) if n0 and n1 is not None and n0 > 0 else None,
                   "pm25_2012": _r(p0), "pm25_2022": _r(p1),
                   "pm25_change_pct": _r(100 * (p1 - p0) / p0) if p0 and p1 is not None and p0 > 0 else None,
                   "so2_umol_m2": _r(x.get("so2"))}
    specs = [
        FieldSpec("no2_2019", f"Tropospheric NO₂ ({AIR_TREND_FROM} mean)", agg="mean", unit="µmol/m²", ramp="reds", higher_is="worse"),
        FieldSpec("no2_latest", f"Tropospheric NO₂ ({YEAR} mean)", agg="mean", unit="µmol/m²", ramp="reds", higher_is="worse"),
        FieldSpec("no2_change_pct", f"Change in NO₂ {AIR_TREND_FROM}→{YEAR}", agg="mean", unit="%", domain=[-30, 30], ramp="diverging", higher_is="worse"),
        FieldSpec("pm25_2012", f"PM2.5 ({PM_TREND_FROM} annual mean)", agg="mean", unit="µg/m³", domain=[0, 120], ramp="reds", higher_is="worse"),
        FieldSpec("pm25_2022", f"PM2.5 ({PM_TREND_TO} annual mean)", agg="mean", unit="µg/m³", domain=[0, 120], ramp="reds", higher_is="worse"),
        FieldSpec("pm25_change_pct", f"Change in PM2.5 {PM_TREND_FROM}→{PM_TREND_TO}", agg="mean", unit="%", domain=[-30, 30], ramp="diverging", higher_is="worse"),
        FieldSpec("so2_umol_m2", f"SO₂ column ({YEAR} mean)", agg="mean", unit="µmol/m²", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="air_trend", title="Air quality trend (satellite)", level=level, fields=specs, group=GROUP,
        description=f"Sentinel-5P TROPOMI tropospheric NO₂ annual means for {AIR_TREND_FROM} and {YEAR} and their change, "
                    f"the {YEAR} SO₂ column (industry and power plants; noisy away from big sources), and Washington "
                    f"University satellite-derived surface PM2.5 (V6.GL, ~1 km) for {PM_TREND_FROM} and {PM_TREND_TO}. "
                    "NO₂ is a ~5 km column and tracks traffic and combustion; a single year can swing with weather "
                    "and lockdowns, so read changes under 10% as flat.",
        source="Copernicus Sentinel-5P OFFL L3 + ACAG V6.GL PM2.5 (awesome-gee-community catalog) via Earth Engine",
        license="Copernicus open licence; PM2.5 free for research (WUSTL ACAG)", default_field="no2_change_pct")
    return spec, _table(level, rows, specs)


# ── fires (VIIRS 375 m active fire: garbage, landfill, crop and industrial burning) ──

FIRE_FROM = "2023-09-01"         # start of the NASA LANCE VIIRS C2 record in Earth Engine


def fires(region):
    """Days with an active fire seen by VIIRS per block since Sep 2023: open burning, landfill fires and crop burning."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 6
    col = ee.ImageCollection("NASA/LANCE/SNPP_VIIRS/C2").filterBounds(geom).filterDate(FIRE_FROM, ee.Date(f"{YEAR + 1}-12-31"))

    def day(im):
        f = im.select("frp").gt(0).And(im.select("confidence").gte(1)).unmask(0)
        m = ee.Date(im.get("system:time_start")).get("month")
        winter = ee.Number(m).gte(10).Or(ee.Number(m).lte(2))
        return ee.Image.cat([f.rename("d"), f.multiply(winter).rename("w"), im.select("frp").unmask(0).rename("frp")]).toFloat()
    d = col.map(day)
    tot = d.sum()
    img = ee.Image.cat([tot.select("d").rename("dmax"), tot.select("w").rename("wmax"), tot.select("frp").rename("frp")])
    first = ee.Date(FIRE_FROM)
    years = ee.Date(col.aggregate_max("system:time_start")).difference(first, "year").getInfo()
    raw = gee.fetch(gee.to_cells(img.select(["dmax", "wmax"]), 375, "max").addBands(gee.to_cells(img.select("frp"), 375, "mean")),
                    bbox, level)
    k = 1 / max(years, 0.5)
    rows = {}
    for c, x in raw.items():
        if x.get("dmax") is None:
            continue
        px = gee.cell_area_km2(c) / (0.375 ** 2)
        rows[c] = {"fire_days_yr": _r(x["dmax"] * k, 1), "winter_fire_days_yr": _r((x.get("wmax") or 0) * k, 1),
                   "fire_mw_yr": _r((x.get("frp") or 0) * px * k, 1)}
    specs = [
        FieldSpec("fire_days_yr", "Days a year with an active fire (most-burned spot in the block)", agg="max", unit="days",
                  domain=[0, 20], ramp="reds", higher_is="worse"),
        FieldSpec("winter_fire_days_yr", "Of them October–February (crop residue, garbage and warmth fires)", agg="max",
                  unit="days", domain=[0, 15], ramp="reds", higher_is="worse"),
        FieldSpec("fire_mw_yr", "Fire radiative power a year, summed over the block", agg="sum", unit="MW",
                  ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="fires", title="Fires and open burning (VIIRS)", level=level, fields=specs, group=GROUP,
        description=f"NASA LANCE VIIRS (Suomi NPP) 375 m active-fire detections, nominal or high confidence, from {FIRE_FROM} "
                    f"to the latest pass ({years:.1f} years), as days a year at the block's most-burned 375 m spot, the "
                    "October–February share and summed fire radiative power. Satellites pass about 1:30 am and pm, so short "
                    "fires are missed; hot rooftops, flares and kilns can also trigger detections.",
        source="NASA LANCE SNPP VIIRS C2 active fire via Earth Engine (pipeline/cells/ee_layers.py)",
        license="NASA open data (no restrictions; cite NASA FIRMS)", default_field="fire_days_yr")
    return spec, _table(level, rows, specs)


# ── subsoil for foundations (OpenLandMap clay and bulk density at 60 and 100 cm) ──

EXPANSIVE_CLAY = 40              # % clay below which shrink-swell (black cotton) behaviour is rare


def subsoil(region):
    """Clay and bulk density at foundation depth: where expansive (black cotton) soils swell and shrink."""
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 7
    clay = ee.Image("OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02")
    bd = ee.Image("OpenLandMap/SOL/SOL_BULKDENS-FINEEARTH_USDA-4A1H_M/v02")
    img = ee.Image.cat([clay.select("b60").rename("c60"), clay.select("b100").rename("c100"), bd.select("b60").rename("bd60")])
    raw = gee.fetch(gee.to_cells(img, 250), bbox, level)
    rows = {}
    for c, x in raw.items():
        if x.get("c60") is None:
            continue
        rows[c] = {"clay_60cm_pct": _r(x["c60"]), "clay_100cm_pct": _r(x.get("c100")),
                   "bulk_density_60cm": _r(x["bd60"] / 100, 2) if x.get("bd60") is not None else None}
    specs = [
        FieldSpec("clay_60cm_pct", "Clay at 60 cm (typical footing depth)", agg="mean", unit="%", domain=[10, 60], ramp="reds",
                  higher_is="worse"),
        FieldSpec("clay_100cm_pct", "Clay at 1 m", agg="mean", unit="%", domain=[10, 60], ramp="reds", higher_is="worse"),
        FieldSpec("bulk_density_60cm", "Soil bulk density at 60 cm", agg="mean", unit="g/cm³", domain=[1.2, 1.8], ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="subsoil", title="Subsoil for foundations (OpenLandMap)", level=level, fields=specs, group=GROUP,
        description=f"Predicted clay content at 60 cm and 1 m and bulk density at 60 cm from OpenLandMap's 250 m soil maps. "
                    f"Clay of {EXPANSIVE_CLAY}% or more at footing depth marks soils that can swell and shrink with the "
                    "seasons (black cotton soils of the Deccan and Malwa), which crack walls unless footings go deeper or "
                    "use under-reamed piles (IS 2911-3). Under built-up land these are model predictions, not borehole "
                    "results: get a soil test before building.",
        source="OpenLandMap soil v02 (Hengl et al.) via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY-SA 4.0 (OpenLandMap)", default_field="clay_60cm_pct")
    return spec, _table(level, rows, specs)


# ── topsoil: what grows and what soaks in (OpenLandMap surface soil) ──

def topsoil(region):
    """Surface soil per block: organic carbon, pH, sand and clay at 0 cm (OpenLandMap 250 m)."""
    ee = gee.init()
    _, bbox = _bbox(region)
    level = 7
    sol = "OpenLandMap/SOL/SOL_"
    img = ee.Image.cat([
        ee.Image(sol + "ORGANIC-CARBON_USDA-6A1C_M/v02").select("b0").rename("soc"),
        ee.Image(sol + "PH-H2O_USDA-4C1A2A_M/v02").select("b0").rename("ph"),
        ee.Image(sol + "SAND-WFRACTION_USDA-3A1A1A_M/v02").select("b0").rename("sand"),
        ee.Image(sol + "CLAY-WFRACTION_USDA-3A1A1A_M/v02").select("b0").rename("clay"),
    ])
    raw = gee.fetch(gee.to_cells(img, 250), bbox, level)
    rows = {}
    for c, x in raw.items():
        if x.get("ph") is None:
            continue
        # Organic carbon is stored in units of 5 g/kg and pH × 10.
        rows[c] = {"soc_g_kg": _r(x["soc"] * 5, 1) if x.get("soc") is not None else None, "ph": _r(x["ph"] / 10, 2),
                   "sand_pct": _r(x.get("sand")), "clay_pct": _r(x.get("clay"))}
    specs = [
        FieldSpec("soc_g_kg", "Topsoil organic carbon", agg="mean", unit="g/kg", domain=[2, 20], ramp="greens", higher_is="better"),
        FieldSpec("ph", "Topsoil pH (in water)", agg="mean", unit="pH", domain=[5.5, 9], ramp="diverging", higher_is=None),
        FieldSpec("sand_pct", "Topsoil sand", agg="mean", unit="%", domain=[10, 70], ramp="viridis", higher_is=None),
        FieldSpec("clay_pct", "Topsoil clay", agg="mean", unit="%", domain=[10, 60], ramp="reds", higher_is=None),
    ]
    spec = DatasetSpec(
        id="topsoil", title="Topsoil for gardens and rain gardens (OpenLandMap)", level=level, fields=specs, group=GROUP,
        description="Predicted surface (0 cm) organic carbon, pH, sand and clay from OpenLandMap's 250 m soil maps (Hengl et al.). "
                    "Under built-up land these are what the soil was, or is in open patches, not the fill and rubble in a garden; "
                    "test before planting.",
        source="OpenLandMap soil v02 (Hengl et al.) via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY-SA 4.0 (OpenLandMap)", default_field="ph")
    return spec, _table(level, rows, specs)


# ── lakes: extent, algae, turbidity and weeds (Sentinel-2, dry season) ──

LAKE_FROM = 2019                 # first full Sentinel-2 L2A year over India
LAKE_MONTHS = (2, 4)             # Feb–Apr: after the monsoon fill, before the pre-monsoon low


def lakes(region):
    """Lake health per block: open water now and in 2019, chlorophyll (NDCI), turbidity (NDTI) and weed cover."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7

    def med(y):
        col = _year(ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(geom), y, *LAKE_MONTHS) \
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))

        def prep(im):
            scl = im.select("SCL")
            ok = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10))
            return im.updateMask(ok).select(["B3", "B4", "B5", "B8", "B11"]).divide(10000)
        return col.map(prep).median()
    a, b = med(LAKE_FROM), med(YEAR)
    mndwi = lambda im: im.normalizedDifference(["B3", "B11"])
    ndvi = lambda im: im.normalizedDifference(["B8", "B4"])
    # MNDWI > 0.2 rather than 0: city roofs and shadows creep over zero. Water quality only on clear water (NDVI < 0.1).
    w0, w1 = mndwi(a).gt(0.2), mndwi(b).gt(0.2)
    clear = w1.And(ndvi(b).lt(0.1))
    ndci = b.normalizedDifference(["B5", "B4"]).updateMask(clear)
    ndti = b.normalizedDifference(["B4", "B3"]).updateMask(clear)
    weeds = ndvi(b).gt(0.3).And(w0).updateMask(w0)   # 2019 water now green: hyacinth or reeds
    img = ee.Image.cat([w0.rename("w0"), w1.rename("w1"), ndci.rename("ndci"), ndti.rename("ndti"), weeds.rename("weeds")])
    raw = gee.fetch(gee.to_cells(img, 10), bbox, level, tile=64)
    rows = {}
    for c, x in raw.items():
        w0v, w1v = x.get("w0") or 0, x.get("w1") or 0
        if max(w0v, w1v) < 0.02:
            continue
        rows[c] = {"water_2019_pct": _r(100 * w0v), "water_now_pct": _r(100 * w1v), "water_change_pp": _r(100 * (w1v - w0v)),
                   "chlorophyll_ndci": _r(x.get("ndci"), 3), "turbidity_ndti": _r(x.get("ndti"), 3),
                   "weed_pct": _r(100 * x["weeds"]) if x.get("weeds") is not None else None}
    specs = [
        FieldSpec("water_2019_pct", f"Open water, Feb–Apr {LAKE_FROM}", agg="mean", unit="% of block", domain=[0, 100], ramp="blues"),
        FieldSpec("water_now_pct", f"Open water, Feb–Apr {YEAR}", agg="mean", unit="% of block", domain=[0, 100], ramp="blues"),
        FieldSpec("water_change_pp", f"Change in open water {LAKE_FROM}→{YEAR}", agg="mean", unit="points", domain=[-40, 40], ramp="diverging",
                  higher_is="better"),
        FieldSpec("chlorophyll_ndci", "Chlorophyll in the water (NDCI; above 0.1 is algae-rich)", agg="mean", unit="index",
                  domain=[-0.1, 0.3], ramp="greens", higher_is="worse"),
        FieldSpec("turbidity_ndti", "Turbidity (NDTI; higher is muddier)", agg="mean", unit="index", domain=[-0.2, 0.2], ramp="reds",
                  higher_is="worse"),
        FieldSpec("weed_pct", f"Share of {LAKE_FROM} water now covered by weeds or reeds", agg="mean", unit="%", domain=[0, 100],
                  ramp="greens", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="lakes", title="Lake health (Sentinel-2)", level=level, fields=specs, group=GROUP,
        description=f"Dry-season (Feb–Apr) Sentinel-2 L2A medians for {LAKE_FROM} and {YEAR}: open water (MNDWI > 0.2), the "
                    "normalised difference chlorophyll index (Mishra & Mishra 2012) and turbidity index (Lacaux et al. 2007) "
                    f"over today's clear water (NDVI < 0.1), and the share of {LAKE_FROM} water that is now green (NDVI > 0.3: water hyacinth, "
                    "reeds or infill). Only blocks with at least 2% water in either year are kept. One season's median "
                    "swings with the monsoon before it, so read small changes as noise.",
        source="Copernicus Sentinel-2 L2A via Earth Engine (pipeline/cells/ee_layers.py)",
        license="Copernicus open licence", default_field="water_change_pp")
    return spec, _table(level, rows, specs)


# ── what the haze is made of: CAMS aerosol composition and dust days ─────────

DUST_DAY_AOD = 0.3    # daily mean dust optical depth at 550 nm; a visible dust haze
AER_BANDS = {"dust": "dust_aerosol_optical_depth_at_550nm_surface",
             "smoke": ["black_carbon_aerosol_optical_depth_at_550nm_surface", "organic_matter_aerosol_optical_depth_at_550nm_surface"],
             "sulphate": "sulphate_aerosol_optical_depth_at_550nm_surface",
             "seasalt": "sea_salt_aerosol_optical_depth_at_550nm_surface",
             "total": "total_aerosol_optical_depth_at_550nm_surface"}


def haze_mix(region):
    """Share of the year's aerosol optical depth from dust, smoke (black carbon + organic), sulphate and sea salt; dust days."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 5
    col = _year(ee.ImageCollection("ECMWF/CAMS/NRT").filterBounds(geom), YEAR) \
        .filter(ee.Filter.lt("model_forecast_hour", 24))

    def parts(im):
        sm = im.select(AER_BANDS["smoke"]).reduce(ee.Reducer.sum()).rename("smoke")
        return ee.Image.cat([im.select(AER_BANDS["dust"]).rename("dust"), sm, im.select(AER_BANDS["sulphate"]).rename("sulphate"),
                             im.select(AER_BANDS["seasalt"]).rename("seasalt"), im.select(AER_BANDS["total"]).rename("total")])
    mean = col.map(parts).mean()
    pre = _year(ee.ImageCollection("ECMWF/CAMS/NRT").filterBounds(geom), YEAR, 3, 6) \
        .filter(ee.Filter.lt("model_forecast_hour", 24)).select(AER_BANDS["dust"]).mean().rename("dust_pre")
    start = ee.Date.fromYMD(YEAR, 1, 1)
    days = ee.List.sequence(0, 364).map(lambda d: col.filterDate(start.advance(d, "day"), start.advance(ee.Number(d).add(1), "day"))
                                       .select(AER_BANDS["dust"]).mean().gt(DUST_DAY_AOD).unmask(0))
    dd = ee.ImageCollection.fromImages(days).sum().rename("dust_days")
    img = ee.Image.cat([mean, pre, dd])
    raw = gee.fetch(gee.to_cells(img, 11000), bbox, level)
    rows = {}
    for c, x in raw.items():
        tot = x.get("total")
        if not tot:
            continue
        sh = {k: _r(100 * (x.get(k) or 0) / tot) for k in ("dust", "smoke", "sulphate", "seasalt")}
        rows[c] = {"aod_total": _r(tot, 3), "dust_share_pct": sh["dust"], "smoke_share_pct": sh["smoke"],
                   "sulphate_share_pct": sh["sulphate"], "seasalt_share_pct": sh["seasalt"],
                   "dust_aod_premonsoon": _r(x.get("dust_pre"), 3), "dust_days_yr": _r(x.get("dust_days"))}
    specs = [
        FieldSpec("aod_total", f"Aerosol optical depth at 550 nm, {YEAR} mean", agg="mean", unit="AOD", domain=[0, 1.2], ramp="reds",
                  higher_is="worse"),
        FieldSpec("dust_share_pct", "Share of the haze that is dust", agg="mean", unit="%", domain=[0, 60], ramp="heat", higher_is="worse"),
        FieldSpec("smoke_share_pct", "Share that is smoke (black carbon + organic matter)", agg="mean", unit="%", domain=[0, 60], ramp="heat",
                  higher_is="worse"),
        FieldSpec("sulphate_share_pct", "Share that is sulphate (coal, oil, industry)", agg="mean", unit="%", domain=[0, 60], ramp="heat",
                  higher_is="worse"),
        FieldSpec("seasalt_share_pct", "Share that is sea salt", agg="mean", unit="%", domain=[0, 40], ramp="blues", higher_is=None),
        FieldSpec("dust_aod_premonsoon", "Dust optical depth, Mar–Jun mean", agg="mean", unit="AOD", domain=[0, 0.6], ramp="heat",
                  higher_is="worse"),
        FieldSpec("dust_days_yr", f"Dust-haze days (daily dust AOD over {DUST_DAY_AOD})", agg="mean", unit="days/yr", domain=[0, 120],
                  ramp="heat", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="haze_mix", title="What the haze is made of (CAMS)", level=level, fields=specs, group=GROUP,
        description=f"Copernicus Atmosphere Monitoring Service near-real-time analyses and day-ahead forecasts for {YEAR} (about 40 km "
                    "grid): mean aerosol optical depth at 550 nm and the share from dust, smoke (black carbon plus organic matter), "
                    f"sulphate and sea salt (nitrate and ammonium, large in north Indian winters, are not split out, so shares do not add to 100%). "
                    f"Dust days count days whose mean dust optical depth is over {DUST_DAY_AOD}. Shares are model output, not measurements: "
                    "read them as the city's mix, not block detail.",
        source="ECMWF/CAMS/NRT via Earth Engine (pipeline/cells/ee_layers.py)",
        license="Copernicus licence (CAMS)", default_field="dust_share_pct")
    return spec, _table(level, rows, specs)


# ── mangroves: extent 1996 and 2020 (Global Mangrove Watch v3) ───────────────

GMW = "projects/sat-io/open-datasets/GMW/extent/gmw_v3_{}_vec"
MANGROVE_FROM, MANGROVE_TO = 1996, 2020


def mangroves(region):
    """Mangrove share of each block in 1996 and 2020, and the change, from Global Mangrove Watch v3 polygons."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7

    def mask(y):
        fc = ee.FeatureCollection(GMW.format(y)).filterBounds(geom)
        return ee.Image(0).byte().paint(fc, 1)
    m0, m1 = mask(MANGROVE_FROM), mask(MANGROVE_TO)
    img = ee.Image.cat([m0.rename("m0"), m1.rename("m1"), m0.And(m1.Not()).rename("lost")])
    raw = gee.fetch(gee.to_cells(img, 25), bbox, level, tile=64)
    rows = {}
    for c, x in raw.items():
        a, b = x.get("m0") or 0, x.get("m1") or 0
        if max(a, b) < 0.01:
            continue
        rows[c] = {"mangrove_1996_pct": _r(100 * a), "mangrove_2020_pct": _r(100 * b), "mangrove_change_pp": _r(100 * (b - a)),
                   "mangrove_lost_pct": _r(100 * (x.get("lost") or 0))}
    specs = [
        FieldSpec("mangrove_1996_pct", f"Mangroves, {MANGROVE_FROM}", agg="mean", unit="% of block", domain=[0, 100], ramp="greens"),
        FieldSpec("mangrove_2020_pct", f"Mangroves, {MANGROVE_TO}", agg="mean", unit="% of block", domain=[0, 100], ramp="greens"),
        FieldSpec("mangrove_change_pp", f"Change in mangroves {MANGROVE_FROM}→{MANGROVE_TO}", agg="mean", unit="points", domain=[-30, 30],
                  ramp="diverging", higher_is="better"),
        FieldSpec("mangrove_lost_pct", f"Block area that was mangrove in {MANGROVE_FROM} and is not in {MANGROVE_TO}", agg="mean",
                  unit="% of block", domain=[0, 30], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="mangroves", title="Mangroves (Global Mangrove Watch)", level=level, fields=specs, group=GROUP,
        description=f"Global Mangrove Watch v3 extent polygons (25 m, from ALOS PALSAR radar and Landsat) for {MANGROVE_FROM} and "
                    f"{MANGROVE_TO}, rasterised and averaged per block: the mangrove share in each year, the change, and the share "
                    "lost. Mangroves buffer storm surge and hold coastal mud; losses show reclamation, ports and roads. Only blocks "
                    "with at least 1% mangrove in either year are kept.",
        source=f"{GMW.format('YYYY')} (awesome-gee-community-catalog) via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (Bunting et al. 2022, Global Mangrove Watch)", default_field="mangrove_2020_pct")
    return spec, _table(level, rows, specs)


# ── water bodies by decade: when lakes and ponds were lost (JRC yearly history) ─

GSW_YEARLY = "JRC/GSW1_4/YearlyHistory"
WATER_EPOCHS = {"1990": (1988, 1992), "2000": (1998, 2002), "2010": (2008, 2012), "2020": (2019, 2021)}


def water_history(region):
    """Surface water per block by decade (any seasonal or permanent water in a 3–5 year window), the share lost since
    1990–2000 and the mean last year those lost pixels held water."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    yearly = ee.ImageCollection(GSW_YEARLY).filterBounds(geom)

    def wet(y0, y1):
        col = yearly.filter(ee.Filter.rangeContains("year", y0, y1))
        return col.map(lambda im: im.select("waterClass").gte(2)).max().unmask(0)
    ep = {k: wet(*v) for k, v in WATER_EPOCHS.items()}
    lost = ep["1990"].Or(ep["2000"]).And(ep["2020"].Not())   # early Landsat years have gaps, so either epoch counts
    years = yearly.filter(ee.Filter.rangeContains("year", 1988, 2021)) \
        .map(lambda im: ee.Image.constant(im.get("year")).toFloat().updateMask(im.select("waterClass").gte(2)))
    last = years.max().updateMask(lost)
    img = ee.Image.cat([*(ep[k].rename(f"w{k}") for k in WATER_EPOCHS), lost.rename("lost"), last.rename("last")])
    raw = gee.fetch(gee.to_cells(img, 30), bbox, level, tile=64)
    rows = {}
    for c, x in raw.items():
        w = {k: x.get(f"w{k}") or 0 for k in WATER_EPOCHS}
        if max(w.values()) < 0.02:
            continue
        rows[c] = {**{f"water_{k}_pct": _r(100 * v) for k, v in w.items()}, "water_lost_pct": _r(100 * (x.get("lost") or 0)),
                   "lost_year": _r(x.get("last"), 0) if (x.get("lost") or 0) >= 0.01 and x.get("last") else None}
    specs = [*(FieldSpec(f"water_{k}_pct", f"Surface water around {k} ({a}–{b})", agg="mean", unit="% of block", domain=[0, 100], ramp="blues")
               for k, (a, b) in WATER_EPOCHS.items()),
             FieldSpec("water_lost_pct", "Block area that held water around 1990 or 2000 and none in 2019–2021", agg="mean", unit="% of block",
                       domain=[0, 30], ramp="reds", higher_is="worse"),
             FieldSpec("lost_year", "Last year the lost water was seen (mean)", agg="mean", unit="year", domain=[1988, 2018], ramp="viridis",
                       higher_is=None)]
    spec = DatasetSpec(
        id="water_history", title="Water bodies by decade (JRC yearly)", level=level, fields=specs, group=GROUP,
        description="JRC Global Surface Water yearly history (Landsat, 30 m, 1984–2021): the share of each block that held seasonal or "
                    "permanent water in any year of four windows (1988–92, 1998–2002, 2008–12, 2019–21), the share that held water around "
                    "1990 or 2000 and none in 2019–2021, and the mean last year that lost water was seen, which dates when a pond or lake went. "
                    "Early Landsat years have gaps over India, and a dry run of years can read as loss for seasonal ponds.",
        source=f"{GSW_YEARLY} via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (Pekel et al. 2016, EC JRC / Google)", default_field="water_lost_pct")
    return spec, _table(level, rows, specs)


# ── farmland at the edge: cropland lost since 2018 (Dynamic World) ────────────

FARM_FROM = 2018      # first full year of Sentinel-2 L2A over India
DW_CROPS, DW_BUILT = 4, 6


def farmland(region):
    """Cropland per block in 2018 and now (Dynamic World yearly mode label), and how much of it is now built."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    dw = ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1").filterBounds(geom).select("label")
    a, b = _year(dw, FARM_FROM).mode(), _year(dw, YEAR).mode()
    crop0, crop1 = a.eq(DW_CROPS), b.eq(DW_CROPS)
    built = crop0.And(b.eq(DW_BUILT))
    img = ee.Image.cat([crop0.rename("c0"), crop1.rename("c1"), built.rename("cb"), b.eq(DW_BUILT).rename("b1")])
    raw = gee.fetch(gee.to_cells(img, 10), bbox, level, tile=64)
    rows = {}
    for c, x in raw.items():
        c0, c1, cb = x.get("c0") or 0, x.get("c1") or 0, x.get("cb") or 0
        if max(c0, c1) < 0.05:
            continue
        rows[c] = {"crop_2018_pct": _r(100 * c0), "crop_now_pct": _r(100 * c1), "crop_change_pp": _r(100 * (c1 - c0)),
                   "crop_built_pp": _r(100 * cb), "crop_built_share": _r(100 * cb / c0) if c0 >= 0.05 else None,
                   "built_now_pct": _r(100 * (x.get("b1") or 0))}
    specs = [
        FieldSpec("crop_2018_pct", f"Cropland, {FARM_FROM}", agg="mean", unit="% of block", domain=[0, 100], ramp="greens"),
        FieldSpec("crop_now_pct", f"Cropland, {YEAR}", agg="mean", unit="% of block", domain=[0, 100], ramp="greens"),
        FieldSpec("crop_change_pp", f"Change in cropland {FARM_FROM}→{YEAR}", agg="mean", unit="points", domain=[-40, 40],
                  ramp="diverging", higher_is=None),
        FieldSpec("crop_built_pp", f"Block area that was cropland in {FARM_FROM} and is built now", agg="mean", unit="% of block",
                  domain=[0, 30], ramp="reds", higher_is="worse"),
        FieldSpec("crop_built_share", f"Share of the block's {FARM_FROM} cropland now built", agg="mean", unit="%", domain=[0, 60],
                  ramp="reds", higher_is="worse"),
        FieldSpec("built_now_pct", f"Built-up, {YEAR} (Dynamic World)", agg="mean", unit="% of block", domain=[0, 100], ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="farmland", title="Farmland at the edge (Dynamic World)", level=level, fields=specs, group=GROUP,
        description=f"Dynamic World V1 yearly mode land-cover label at 10 m for {FARM_FROM} and {YEAR}: the share of each block "
                    "that reads as crops in each year, and the share that was crops and is now built. The yearly mode smooths "
                    "out fallow months, but Dynamic World still confuses dry fallow with bare ground and grass, so read changes "
                    "under 10 points as noise. Only blocks with at least 5% cropland in either year are kept.",
        source="GOOGLE/DYNAMICWORLD/V1 via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (Dynamic World)", default_field="crop_built_pp")
    return spec, _table(level, rows, specs)


# ── roofs: how much sun they reflect (Sentinel-2 albedo on Open Buildings roofs) ──

# Thresholds are for 10 m pixel albedo, which blends roofs with parapets, tanks and shade: the median Lucknow roof
# pixel reads 0.18, a dark tar or tin roof under 0.17 and a whitewashed one 0.25 or more. Cool paint reaches 0.6–0.8.
DARK_ALBEDO = 0.17
BRIGHT_ALBEDO = 0.25


def _s2_albedo(ee, geom):
    """Dry-season (Mar–May) broadband shortwave albedo from Sentinel-2 L2A (Liang 2001 narrow-to-broadband, Naegeli et al. 2017)."""
    col = _year(ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(geom), YEAR, 3, 5) \
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 40))

    def prep(im):
        scl = im.select("SCL")
        ok = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11))
        b = im.select(["B2", "B4", "B8", "B11", "B12"]).divide(10000)
        a = b.expression("0.356*B2 + 0.130*B4 + 0.373*B8 + 0.085*B11 + 0.072*B12 - 0.0018",
                         {k: b.select(k) for k in ("B2", "B4", "B8", "B11", "B12")})
        return a.updateMask(ok).rename("alb")
    return col.map(prep).median()


def roofs(region):
    """Roof albedo per block: where dark roofs soak up the summer sun (cool-roof candidates)."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    ob = ee.ImageCollection("GOOGLE/Research/open-buildings-temporal/v1").filterBounds(geom) \
        .filter(ee.Filter.calendarRange(2023, 2023, "year"))
    pres = ob.mosaic().setDefaultProjection(ob.first().projection().atScale(4)).select("building_presence")
    roof = pres.reduceResolution(ee.Reducer.mean(), maxPixels=64) \
        .reproject(ee.Projection("EPSG:4326").atScale(10)).gte(0.5)
    alb = _s2_albedo(ee, geom).updateMask(roof)
    img = ee.Image.cat([alb.rename("alb"), alb.lt(DARK_ALBEDO).rename("dark"), alb.gte(BRIGHT_ALBEDO).rename("bright")])
    raw = gee.fetch(gee.to_cells(img, 10), bbox, level, tile=48)
    rows = {}
    for c, x in raw.items():
        if x.get("alb") is None:
            continue
        rows[c] = {"roof_albedo": _r(x["alb"], 3), "dark_roof_pct": _r(100 * (x.get("dark") or 0)),
                   "bright_roof_pct": _r(100 * (x.get("bright") or 0))}
    specs = [
        FieldSpec("roof_albedo", "Roof albedo (share of sunlight reflected, dry season)", agg="mean", unit="0-1",
                  domain=[0.08, 0.35], ramp="viridis", higher_is="better"),
        FieldSpec("dark_roof_pct", f"Dark roofs (albedo below {DARK_ALBEDO})", agg="mean", unit="% of roof area",
                  domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("bright_roof_pct", f"Light or white roofs (albedo {BRIGHT_ALBEDO} or more)", agg="mean",
                  unit="% of roof area", domain=[0, 60], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="roofs", title="Roof albedo (Sentinel-2)", level=level, fields=specs, group=GROUP,
        description=f"Broadband shortwave albedo from the {YEAR} March–May Sentinel-2 L2A median (cloud-masked; "
                    f"Liang 2001 coefficients as in Naegeli et al. 2017) averaged over 10 m pixels that are at least half roof "
                    f"in Google Open Buildings 2.5D Temporal 2023. A 10 m pixel blends a roof with its parapets, tanks and "
                    f"shade, so values bunch around 0.18: dark here means under {DARK_ALBEDO} (tar, dark tin, weathered "
                    f"concrete) and light {BRIGHT_ALBEDO} or more (whitewashed). Cool-roof paint or lime wash reaches 0.6–0.8.",
        source="Copernicus Sentinel-2 L2A + Google Open Buildings 2.5D Temporal via Earth Engine",
        license="Copernicus open licence; Open Buildings CC BY 4.0", default_field="roof_albedo")
    return spec, _table(level, rows, specs)


# ── tree_season: which trees keep their leaves through the hot months (Sentinel-2 over tree canopy) ──

LEAFY_NDVI = 0.4                 # NDVI a tree crown keeps when in leaf


def tree_season(region):
    """Phenology of tree canopy per block: summer-leafy share, dry-to-wet NDVI rise and its spread (a variety proxy)."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    dry, wet = _s2(geom, 3, 5), _s2(geom, 8, 10)
    chc = ee.ImageCollection("projects/meta-forest-monitoring-okw37/assets/CanopyHeight").filterBounds(geom)
    ch = chc.mosaic().select("cover_code").setDefaultProjection(chc.first().projection())
    tree = ch.gte(5)              # sampled at the 20 m working scale by to_cells
    rise = wet.subtract(dry)
    img = ee.Image.cat([dry.gte(LEAFY_NDVI).rename("leafy"), rise.rename("rise"), rise.pow(2).rename("rise2"),
                        tree.rename("tree")]).updateMask(tree)
    raw = gee.fetch(gee.to_cells(img, 20), bbox, level, tile=64)
    rows = {}
    for c, x in raw.items():
        if x.get("leafy") is None or x.get("rise") is None:
            continue
        sd = math.sqrt(max(0.0, (x.get("rise2") or 0) - x["rise"] ** 2))
        rows[c] = {"summer_leafy_pct": _r(100 * x["leafy"]), "tree_ndvi_rise": _r(x["rise"], 3), "tree_phen_sd": _r(sd, 3)}
    specs = [
        FieldSpec("summer_leafy_pct", f"Tree canopy still in leaf in Mar-May (NDVI ≥ {LEAFY_NDVI})", agg="mean", unit="% of canopy",
                  domain=[0, 100], ramp="greens", higher_is="better"),
        FieldSpec("tree_ndvi_rise", "Tree greening from Mar-May to Aug-Oct (NDVI rise)", agg="mean", unit="NDVI", domain=[-0.05, 0.3],
                  ramp="viridis", higher_is=None),
        FieldSpec("tree_phen_sd", "Spread of tree greening across the block (variety proxy)", agg="mean", unit="NDVI", domain=[0, 0.15],
                  ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="tree_season", title="Tree canopy through the seasons (Sentinel-2)", level=level, fields=specs, group=GROUP,
        description=f"Sentinel-2 NDVI medians for {YEAR} (Mar-May and Aug-Oct), read only over tree canopy (Meta/WRI canopy ≥ 5 m "
                    "at each 20 m sample). Share of canopy still in leaf in the hot months, the mean greening "
                    "from summer to post-monsoon (high where trees are deciduous) and its spread across the block's trees: by "
                    "the spectral variation hypothesis a mix of species greens on different schedules, so a wider spread hints "
                    "at more kinds of tree. A proxy, not a species count.",
        source="Copernicus Sentinel-2 L2A + Meta/WRI High Resolution Canopy Height via Earth Engine (pipeline/cells/ee_layers.py)",
        license="Copernicus open licence; canopy height CC BY 4.0", default_field="summer_leafy_pct")
    return spec, _table(level, rows, specs)


def built_class(region):
    """Homes versus other buildings, building height bands, roads and open green per block (GHSL GHS-BUILT-C 2018, 10 m)."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    c = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_C/2018").select("built_characteristics")
    res, non = c.gte(11).And(c.lte(15)), c.gte(21).And(c.lte(25))
    built = res.Or(non)
    tall = c.remap([14, 15, 24, 25], [1, 1, 1, 1], 0)
    img = ee.Image.cat([res.rename("res"), non.rename("non"), built.rename("built"), tall.rename("tall"),
                        c.eq(5).rename("road"), c.eq(2).Or(c.eq(3)).rename("green")]).updateMask(c.gt(0))
    raw = gee.fetch(gee.to_cells(img, 10), bbox, level, tile=64)
    rows = {}
    for code, x in raw.items():
        b = x.get("built")
        if b is None:
            continue
        rows[code] = {"built_pct": _r(100 * b), "nonres_pct": _r(100 * x["non"] / b) if b > 0.02 else None,
                      "tall_pct": _r(100 * x["tall"] / b) if b > 0.02 else None,
                      "road_pct": _r(100 * (x.get("road") or 0)), "green_open_pct": _r(100 * (x.get("green") or 0))}
    pct = lambda k, label, ramp, hi: FieldSpec(k, label, agg="mean", unit="%", domain=[0, 100], ramp=ramp, higher_is=hi)
    specs = [
        pct("nonres_pct", "Non-residential share of built-up ground (offices, shops, industry, institutions)", "viridis", None),
        pct("built_pct", "Built-up ground (GHSL 2018)", "reds", None),
        pct("tall_pct", "Built-up ground with buildings over 15 m", "viridis", None),
        pct("road_pct", "Road surface", "viridis", None),
        pct("green_open_pct", "Open ground with medium or high vegetation", "greens", "better"),
    ]
    spec = DatasetSpec(
        id="built_class", title="Homes versus other buildings (GHSL 2018)", level=level, fields=specs, group=GROUP,
        description="The European Commission JRC's GHS-BUILT-C 2018 map at 10 m classes every built pixel as residential or "
                    "non-residential in five height bands and open land as roads, water or vegetated: per block, the "
                    "non-residential share of built-up ground, the share of buildings over 15 m, road surface and open green.",
        source="JRC GHSL GHS-BUILT-C R2023A (2018) via Earth Engine (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (European Commission, JRC)", default_field="nonres_pct")
    return spec, _table(level, rows, specs)


def wind(region):
    """Mean wind speed near the ground and above the roofs per block (Global Wind Atlas 3, 250 m)."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    col = "projects/sat-io/open-datasets/global_wind_atlas/wind-speed/gwa3_250_wind-speed_"
    img = ee.Image.cat([ee.Image(col + "10m").rename("w10"), ee.Image(col + "100m").rename("w100")])
    raw = gee.fetch(gee.to_cells(img, 250), bbox, level, tile=128)
    rows = {}
    for code, x in raw.items():
        a, b = x.get("w10"), x.get("w100")
        if a is None or b is None:
            continue
        rows[code] = {"wind10_ms": _r(a, 2), "wind100_ms": _r(b, 2), "wind_kept_pct": _r(100 * a / b) if b > 0.5 else None}
    specs = [
        FieldSpec("wind10_ms", "Mean wind speed at 10 m", agg="mean", unit="m/s", domain=[1, 5], ramp="blues", higher_is="better"),
        FieldSpec("wind100_ms", "Mean wind speed at 100 m", agg="mean", unit="m/s", domain=[2, 8], ramp="blues", higher_is=None),
        FieldSpec("wind_kept_pct", "Wind at 10 m as a share of wind at 100 m (lower: more sheltered by buildings and terrain)", agg="mean", unit="%", domain=[20, 70], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="wind", title="Wind near the ground (Global Wind Atlas)", level=level, fields=specs, group=GROUP,
        description="Mean annual wind speed at 10 m and 100 m above ground from the Global Wind Atlas 3 (DTU and the World "
                    "Bank, 250 m, 2008-2017 reanalysis downscaled with terrain and surface roughness), and how much of the "
                    "100 m wind survives at 10 m: a low share marks still, sheltered air where smoke and exhaust linger.",
        source="Global Wind Atlas 3 via the awesome-gee-community-catalog (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (Technical University of Denmark and World Bank Group)", default_field="wind10_ms")
    return spec, _table(level, rows, specs)


def solar_atlas(region):
    """Photovoltaic output and sunshine per block (Global Solar Atlas 2, about 1 km)."""
    ee = gee.init()
    geom, bbox = _bbox(region)
    level = 7
    gsa = "projects/sat-io/open-datasets/global_solar_atlas/"
    months = ee.ImageCollection(gsa + "pvout_LTAm_AvgDailyTotals")
    img = ee.Image.cat([ee.Image(gsa + "pvout_LTAy_AvgDailyTotals").rename("pv"), ee.Image(gsa + "ghi_LTAy_AvgDailyTotals").rename("ghi"),
                        months.min().rename("pvmin"), months.max().rename("pvmax")])
    raw = gee.fetch(gee.to_cells(img, 1000), bbox, level, tile=128)
    rows = {}
    for code, x in raw.items():
        pv, lo, hi = x.get("pv"), x.get("pvmin"), x.get("pvmax")
        if pv is None:
            continue
        rows[code] = {"pvout_kwh_kwp": _r(365 * pv, 0), "ghi_kwh_m2_day": _r(x.get("ghi"), 2),
                      "pv_worst_month_pct": _r(100 * lo / hi) if lo is not None and hi else None}
    specs = [
        FieldSpec("pvout_kwh_kwp", "Solar PV output per kWp installed, per year", agg="mean", unit="kWh/kWp", domain=[1350, 1750], ramp="heat", higher_is="better"),
        FieldSpec("ghi_kwh_m2_day", "Global horizontal irradiation", agg="mean", unit="kWh/m²/day", domain=[4.4, 5.8], ramp="heat", higher_is="better"),
        FieldSpec("pv_worst_month_pct", "PV output in the worst month as a share of the best", agg="mean", unit="%", domain=[40, 90], ramp="heat", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="solar_atlas", title="Solar PV output (Global Solar Atlas)", level=level, fields=specs, group=GROUP,
        description="Long-term yearly output of a standard fixed solar PV system per kWp, global horizontal irradiation and the "
                    "worst month's output as a share of the best month's (the monsoon dip), from the Global Solar Atlas 2 "
                    "(Solargis for the World Bank, about 1 km; haze and cloud are in the model).",
        source="Global Solar Atlas 2 via the awesome-gee-community-catalog (pipeline/cells/ee_layers.py)",
        license="CC BY 4.0 (World Bank Group, Solargis)", default_field="pvout_kwh_kwp")
    return spec, _table(level, rows, specs)


LAYERS = {
    "population": population, "built_up": built_up, "land_cover": land_cover,
    "vegetation": vegetation, "terrain": terrain, "water": water,
    "nightlights": nightlights, "surface_heat": heat, "air_quality": air_quality,
    "rainfall": rainfall, "building_stock": building_stock, "soil": soil,
    "accessibility": accessibility, "waterlogging": waterlogging,
    "demographics": demographics, "wealth": wealth, "climate_zones": climate_zones,
    "humid_heat": humid_heat, "climate_future": climate_future, "flood_future": flood_future, "water_risk": water_risk,
    "roofs": roofs, "humid_future": humid_future, "air_trend": air_trend, "fires": fires, "subsoil": subsoil, "lakes": lakes, "farmland": farmland, "haze_mix": haze_mix, "mangroves": mangroves, "water_history": water_history, "topsoil": topsoil, "tree_season": tree_season, "built_class": built_class, "wind": wind, "solar_atlas": solar_atlas,
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
