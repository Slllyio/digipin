"""Unit tests for the env sampler (A3), against synthetic in-memory rasters.

Proves the elevation 5-point math matches fetchElevation (incl. the -2 m
isLowLying threshold) and that GHSL pixels read as persons/hectare directly.
"""
from __future__ import annotations

import numpy as np
import rasterio
from rasterio.transform import from_bounds as transform_from_bounds

from pipeline.scores import env_sampler

# Raster bbox around the test cell centre.
_W, _S, _E, _N = 75.79, 22.69, 75.81, 22.71
_PX = 200  # 200x200 px over 0.02 deg -> ~0.0001 deg/px (offset 0.0018 ~ 18 px)


def _write_tif(path, array, nodata=None):
    h, w = array.shape
    transform = transform_from_bounds(_W, _S, _E, _N, w, h)
    with rasterio.open(
        path, "w", driver="GTiff", height=h, width=w, count=1,
        dtype=array.dtype, crs="EPSG:4326", transform=transform, nodata=nodata,
    ) as dst:
        dst.write(array, 1)
    return str(path)


def _cell(lat=22.70, lng=75.80):
    return {"code": "T", "center": {"lat": lat, "lng": lng},
            "bounds": {"south": lat - 0.0005, "north": lat + 0.0005,
                       "west": lng - 0.0005, "east": lng + 0.0005}}


def test_population_pixel_reads_as_persons_per_hectare(tmp_path):
    pop = np.full((_PX, _PX), 200.0, dtype="float32")
    path = _write_tif(tmp_path / "pop.tif", pop, nodata=-200.0)
    sampler = env_sampler.make_env_sampler(pop_tif=path)
    env = sampler(_cell())
    assert env["populationDensity"]["personsPerHectare"] == 200
    assert env["populationDensity"]["source"] == "GHSL"


def test_elevation_pit_is_low_lying(tmp_path):
    # Radial pit: elevation = distance-from-centre (px). Centre ~0, surroundings high.
    yy, xx = np.mgrid[0:_PX, 0:_PX]
    elev = np.sqrt((yy - _PX / 2) ** 2 + (xx - _PX / 2) ** 2).astype("float32")
    path = _write_tif(tmp_path / "dem.tif", elev)
    sampler = env_sampler.make_env_sampler(dem_tif=path)
    e = sampler(_cell())["elevation"]
    assert e["center"] < 2                 # near the pit bottom
    assert e["surrounding"] > 10           # ~18 px out
    assert e["relative"] < 0               # centre below its surroundings
    assert e["isLowLying"] is True


def test_elevation_flat_is_not_low_lying(tmp_path):
    flat = np.full((_PX, _PX), 450.0, dtype="float32")
    path = _write_tif(tmp_path / "flat.tif", flat)
    sampler = env_sampler.make_env_sampler(dem_tif=path)
    e = sampler(_cell())["elevation"]
    assert e["relative"] == 0
    assert e["isLowLying"] is False


def test_output_feeds_flood_and_population_scores(tmp_path):
    from pipeline.scores.composite import compute_flood_risk, compute_population_score
    from pipeline.scores.osm_classify import assemble_data

    yy, xx = np.mgrid[0:_PX, 0:_PX]
    elev = np.sqrt((yy - _PX / 2) ** 2 + (xx - _PX / 2) ** 2).astype("float32")
    dem = _write_tif(tmp_path / "dem.tif", elev)
    pop = _write_tif(tmp_path / "pop.tif", np.full((_PX, _PX), 300.0, dtype="float32"))

    sampler = env_sampler.make_env_sampler(pop_tif=pop, dem_tif=dem)
    data = assemble_data({}, {}, sampler(_cell()))
    # low-lying -> flood risk above the 30 baseline
    assert compute_flood_risk(data) > 30
    # 300 persons/ha -> norm_log(300, 500) > 0
    assert compute_population_score(data) > 0


def test_no_rasters_yields_empty_environment():
    sampler = env_sampler.make_env_sampler()
    assert sampler(_cell()) == {}
