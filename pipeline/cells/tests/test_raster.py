"""Raster adapter: GeoTIFF → DIGIPIN cell records (fine and coarse pixels)."""
import pytest

rasterio = pytest.importorskip("rasterio")
np = pytest.importorskip("numpy")

from rasterio.transform import from_origin  # noqa: E402

from pipeline.cells import adapters, build, store  # noqa: E402
from pipeline.cells.schema import DatasetSpec, FieldSpec  # noqa: E402


def _tif(path, arrays, west, north, res):
    h, w = arrays[0].shape
    with rasterio.open(path, "w", driver="GTiff", height=h, width=w, count=len(arrays),
                       dtype="float32", crs="EPSG:4326",
                       transform=from_origin(west, north, res, res), nodata=-9999) as dst:
        for i, a in enumerate(arrays, 1):
            dst.write(a.astype("float32"), i)
    return path


def test_fine_pixels_are_zonal_means(tmp_path):
    # 0.0005° pixels (~55 m) inside L7 cells (~0.0022°): many pixels per cell.
    a = np.full((8, 8), 10.0)
    a[0, 0] = 30.0
    a[1, 1] = -9999          # nodata → ignored
    b = np.arange(64, dtype=float).reshape(8, 8)
    p = _tif(tmp_path / "f.tif", [a, b], 75.85, 22.72, 0.0005)
    recs = list(adapters.raster_records(p, {"a": 1, "b": 2}, 7,
                                        derive={"twice": lambda r: None if r["a"] is None else 2 * r["a"]}))
    assert len(recs) == 64 and all("lat" in r for r in recs)
    assert sum(r["a"] is None for r in recs) == 1
    f = [FieldSpec("a", "A", agg="mean"), FieldSpec("twice", "2A", agg="max"), FieldSpec("b", "B", agg="sum")]
    t = store.bin_records(recs, 7, f)
    assert 1 <= len(t) <= 9
    assert max(t.columns["twice"]) == 60
    assert sum(t.columns["b"]) == sum(range(64))          # sum agg conserves totals


def test_coarse_pixels_sample_every_cell_centre(tmp_path):
    # 0.01° pixels (~1 km) over L7 cells: each cell samples the pixel under its centre.
    a = np.array([[1.0, 2.0], [3.0, 4.0]])
    p = _tif(tmp_path / "c.tif", [a], 75.80, 22.74, 0.01)
    recs = list(adapters.raster_records(p, {"v": 1}, 7, keep=lambda r: r["v"] is not None))
    assert len(recs) > 4 and all("digipin" in r and len(r["digipin"].replace("-", "")) == 7 for r in recs)
    assert {r["v"] for r in recs} == {1.0, 2.0, 3.0, 4.0}


def test_raster_dataset_helper(tmp_path):
    p = _tif(tmp_path / "x.tif", [np.full((4, 4), 5.0)], 75.85, 22.72, 0.0005)
    spec = DatasetSpec(id="x", title="X", level=8, fields=[FieldSpec("v", "V", agg="mean")])
    s, t = build.raster_dataset(spec, p, {"v": 1})
    assert s is spec and set(t.columns["v"]) == {5.0}
    assert build.raster_dataset(spec, tmp_path / "missing.tif", {"v": 1}) is None
