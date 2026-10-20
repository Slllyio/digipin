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
    raw = gee.fetch(gee.to_cells(img, 4), bbox, level, tile=128)
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


LAYERS = {
    "population": population, "built_up": built_up, "land_cover": land_cover,
    "vegetation": vegetation, "terrain": terrain, "water": water,
    "nightlights": nightlights, "surface_heat": heat, "air_quality": air_quality,
    "rainfall": rainfall, "building_stock": building_stock, "soil": soil,
    "accessibility": accessibility,
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
