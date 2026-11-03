import numpy as np
import pytest

from pipeline.realestate.fossilco2 import NORTH, RES, WEST, per_km2, pixel_km2, rows_from, sample


def test_per_km2_converts_carbon_to_co2():
    assert per_km2(12 * pixel_km2(0), 0) == pytest.approx(44)


def test_rows_from_skips_noise_baseline():
    cells = [("A", 0, 0), ("B", 0, 0), ("C", 0, 0)]
    a = pixel_km2(0) * 12 / 44
    rows = rows_from(cells, [100 * a, 10 * a, None], [150 * a, 50 * a, 7 * a])
    assert rows["A"] == {"co2_2024": 150, "co2_2004": 100, "co2_change_pct": 50}
    assert rows["B"] == {"co2_2024": 50, "co2_2004": 10}
    assert rows["C"] == {"co2_2024": 7}


def test_sample_reads_pixel_under_centre():
    g = np.zeros((10, 10), dtype="float32")
    g[2, 3] = 5
    lat, lng = NORTH - 2.5 * RES, WEST + 3.5 * RES
    assert sample(g, [("A", lat, lng), ("B", 0.0, 0.0)]) == [5.0, None]
