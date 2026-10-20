"""Tests for the SSP urban-expansion clip pipeline.

The clip is exercised end-to-end against a synthetic in-memory global raster
(no network), proving window/resample/normalise + the output COG contract that
realtime-growth.js reads (single band, 0..1).
"""
import pytest

pytest.importorskip("rasterio")
pytest.importorskip("numpy")
mod = pytest.importorskip("pipeline.growth.download_ssp_urban")


def test_target_dims():
    w, h = mod.target_dims((75.6, 22.5, 76.0, 22.9), 1000)
    assert w > 0 and h > 0
    # ~0.4° / (1000/111000)° ≈ 44 cells each way
    assert 30 < w < 60 and 30 < h < 60


def test_clip_resample_writes_0_1_cog(tmp_path):
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds

    # synthetic "global-ish" source covering the bbox, values as PERCENT (0..100)
    bbox = (75.6, 22.5, 76.0, 22.9)
    sw, ss, se, sn = 75.0, 22.0, 77.0, 23.5
    sw_w, sw_h = 200, 150
    arr = np.full((sw_h, sw_w), 80.0, dtype="float32")   # 80% urban everywhere
    src = tmp_path / "src.tif"
    with rasterio.open(
        src, "w", driver="GTiff", height=sw_h, width=sw_w, count=1, dtype="float32",
        crs="EPSG:4326", transform=from_bounds(sw, ss, se, sn, sw_w, sw_h),
    ) as d:
        d.write(arr, 1)

    out = mod.clip_resample(src, bbox, 1000, tmp_path / "ssp.tif")
    with rasterio.open(out) as r:
        assert r.count == 1
        assert str(r.crs) == "EPSG:4326"
        v = r.read(1)
        # 80% → normalised to ~0.8, clamped to 0..1
        assert 0.0 <= float(v.min()) <= 1.0 and 0.0 <= float(v.max()) <= 1.0
        assert abs(float(v.mean()) - 0.8) < 0.05
