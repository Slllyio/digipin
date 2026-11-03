import numpy as np

from pipeline.realestate import kilns
from pipeline.realestate.downwind import BINS

CSV = "id,lat,lon,type,fuel,pm25_t_yr\nBKI-1,28.70,77.30,FCBK,coal,50\nBKI-2,bad,77.3,ZZ,coal,1\n"


def test_parse_skips_bad_rows():
    assert kilns.parse(CSV) == [(28.70, 77.30, 50.0, "FCBK")]


def test_exposure_counts_and_wind():
    north = np.zeros(BINS)
    north[0] = 1.0                       # all wind blows towards the north
    cells = [("N", 28.72, 77.30), ("S", 28.68, 77.30), ("FAR", 29.2, 77.3)]
    rows = kilns.exposure(cells, kilns.parse(CSV), north, 28.7)
    assert rows["N"]["kilns_10km"] == 1 and rows["N"]["kiln_smoke"] > 0
    assert rows["S"]["kiln_smoke"] == 0  # upwind of the kiln
    assert "FAR" not in rows
