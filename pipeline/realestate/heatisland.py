"""How much hotter the city is than its countryside: Yang et al.'s global urban heat island intensity dataset (CC BY 4.0,
via the Earth Engine community catalog, projects/sat-io/open-datasets/UHII).

Yang, Xu, Chakraborty et al. (Remote Sensing of Environment 2024) estimate monthly urban heat island intensity (UHII:
the city's temperature minus that of comparable surrounding countryside) for over 10,000 cities from 2001 to 2020, with
a "dynamic equal-area" method that picks a rural ring the same size as the city and drops water, high ground and other
confounders. Two of its series are used, each by day and by night:

    surface  all-sky land surface temperature (seamless MODIS Terra 8-day LST, gaps under cloud filled), ``AMOD2``
    air      near-surface air temperature (a global 1 km air temperature product), ``SAT``

Values are one per city (the whole urban polygon carries it), stored in hundredths of a degree. Each month's image is
read in a 3 km disc around the city's GHSL urban-centre centroid with zeros (no city) masked, averaged by year, and
summarised (dataset ``heat_island``, one value per city copied to every lived-in L7 block):

    hi_surf_day / hi_surf_night   surface UHII, mean of 2016-2020 (°C)
    hi_air_day / hi_air_night     air UHII, mean of 2016-2020 (°C)
    hi_surf_night_trend           change in night surface UHII, °C per decade (least squares over 2001-2020)
    hi_surf_day_trend             the same for day
    hi_air_night_trend            the same for night air UHII
    hi_summer_surf_day            surface UHII by day in March-May, 2016-2020 (°C)

    python -m pipeline.realestate.heatisland
"""
from __future__ import annotations

import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
ASSET = "projects/sat-io/open-datasets/UHII/"
YEARS = range(2001, 2021)
RECENT = range(2016, 2021)
RADIUS_M = 3000
# GHSL urban-centre centroids (GHS-UCDB 2025) in lng, lat; Hyderabad's falls on Hussain Sagar, so a point on land is used
CENTRE = {"ahmedabad": (72.5988, 23.0192), "bengaluru": (77.5599, 13.0108), "bhopal": (77.4233, 23.2390),
          "chennai": (80.1949, 13.0399), "delhi": (77.2239, 28.6226), "guna": (77.3128, 24.6472),
          "hyderabad": (78.4867, 17.3850), "indore_pilot": (75.8562, 22.6986), "jaipur": (75.7794, 26.9118),
          "kolkata": (88.3414, 22.5874), "lucknow": (80.9584, 26.8568), "mumbai": (72.8872, 19.1350), "pune": (73.8648, 18.5339)}


def slope_per_decade(series):
    """Least-squares slope of {year: value} in units per decade (None if under 10 years)."""
    pts = [(y, v) for y, v in series.items() if v is not None]
    if len(pts) < 10:
        return None
    n = len(pts)
    mx = sum(y for y, _ in pts) / n
    my = sum(v for _, v in pts) / n
    sxx = sum((y - mx) ** 2 for y, _ in pts)
    return 10 * sum((y - mx) * (v - my) for y, v in pts) / sxx


def mean_of(series, years):
    xs = [series[y] for y in years if series.get(y) is not None]
    return sum(xs) / len(xs) if len(xs) >= 3 else None


def summarise(surf_day, surf_night, air_day, air_night, summer_day):
    """Series are {year: UHII in hundredths of a degree}; returns the dataset fields in °C."""
    c = lambda x, nd=1: None if x is None else round(x / 100, nd)
    f = {
        "hi_surf_day": c(mean_of(surf_day, RECENT)), "hi_surf_night": c(mean_of(surf_night, RECENT)),
        "hi_air_day": c(mean_of(air_day, RECENT)), "hi_air_night": c(mean_of(air_night, RECENT)),
        "hi_surf_night_trend": c(slope_per_decade(surf_night), 2), "hi_surf_day_trend": c(slope_per_decade(surf_day), 2),
        "hi_air_night_trend": c(slope_per_decade(air_night), 2), "hi_summer_surf_day": c(mean_of(summer_day, RECENT)),
    }
    return {k: v for k, v in f.items() if v is not None}


def fetch(region):
    """{series: {year: value}} for one city from Earth Engine."""
    from pipeline.cells import earthengine as gee
    ee = gee.init()
    geom = ee.Geometry.Point(CENTRE[region]).buffer(RADIUS_M)

    def yearly(prod, diurnal, months=None):
        col = ee.ImageCollection(ASSET + prod).filter(ee.Filter.eq("diurnal", diurnal))
        if months:
            col = col.filter(ee.Filter.calendarRange(months[0], months[1], "month"))
        bands = []
        for y in YEARS:
            im = col.filter(ee.Filter.eq("year", y)).map(lambda i: i.updateMask(i.neq(0)))
            bands.append(ee.Image(ee.Algorithms.If(im.size().gt(0), im.mean(), ee.Image.constant(0).updateMask(0))).rename(f"y{y}").toFloat())
        return ee.Image.cat(bands)

    out = {}
    for key, args in {"surf_day": ("AMOD2", "daytime"), "surf_night": ("AMOD2", "nighttime"), "air_day": ("SAT", "daytime"),
                      "air_night": ("SAT", "nighttime"), "summer_day": ("AMOD2", "daytime", (3, 5))}.items():
        vals = yearly(*args).reduceRegion(ee.Reducer.median(), geom, 927).getInfo()
        out[key] = {int(k[1:]): v for k, v in vals.items() if v is not None}
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit: FieldSpec(k, label, agg="max", unit=unit, ramp="reds", higher_is="worse")
    specs = [
        v("hi_surf_day", "Surface heat island by day, 2016-2020 (city minus countryside)", "°C"),
        v("hi_surf_night", "Surface heat island by night, 2016-2020", "°C"),
        v("hi_air_day", "Air heat island by day, 2016-2020", "°C"),
        v("hi_air_night", "Air heat island by night, 2016-2020", "°C"),
        v("hi_surf_night_trend", "Change in the night surface heat island, 2001-2020", "°C/decade"),
        v("hi_surf_day_trend", "Change in the day surface heat island, 2001-2020", "°C/decade"),
        v("hi_air_night_trend", "Change in the night air heat island, 2001-2020", "°C/decade"),
        v("hi_summer_surf_day", "Surface heat island on March-May days, 2016-2020", "°C"),
    ]
    spec = DatasetSpec(
        id="heat_island", title="City heat island by day and night (global UHII dataset, 2001-2020)", level=LEVEL, fields=specs,
        group="Environment",
        description="How much warmer the city's surface and air are than comparable surrounding countryside, by day and by night, "
                    "2016-2020, and the trend since 2001, from Yang et al.'s global urban heat island intensity dataset "
                    "(dynamic equal-area method; MODIS all-sky land surface temperature and 1 km air temperature). One value per city.",
        source="pipeline/realestate/heatisland.py (projects/sat-io/open-datasets/UHII AMOD2 and SAT via Earth Engine)",
        license="CC BY 4.0 (Q. Yang et al., A global urban heat island intensity dataset, figshare doi:10.6084/m9.figshare.24821538)",
        default_field="hi_surf_night", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    for region in (a.region.split(",") if a.region else CENTRE):
        s = fetch(region)
        f = summarise(s["surf_day"], s["surf_night"], s["air_day"], s["air_night"], s["summer_day"])
        if not f:
            print(region, "no heat island values")
            continue
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
