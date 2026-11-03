from pipeline.realestate import lakeoxygen as lo

TEXT = """1391   HUSSAIN SAGAR LAKE, BUDAMERU         LAKE    TELANGANA    23.2   32.0   0.3   2.4   7.4        8.0   1044   1410   5.8   8.0    1.80   14.60   39       120     430       920
1789   HIMAYAT SAGAR LAKE , R.R.DIST.       LAKE    TELANGANA    20.0   29.0   4.9   6.2   7.3        8.1   388    526    2.1   2.6    0.30   1.20    2        4       2         110
3031   BHALSWA LAKE, DELHI                  LAKE       DELHI       32.0   32.0   0.3   1.7    7.6        8.1   6560   6600   1   2   3   4   5   6   7   8
"""


def test_lakes_reads_one_state_and_the_right_columns():
    t = lo.lakes(TEXT)
    assert set(t) == {"1391", "1789"}
    assert t["1391"] == {"do_min": 0.3, "do_max": 2.4, "bod_max": 8.0, "fc_max": 120.0}


def test_block_rows_counts_lakes_that_never_reached_fish_oxygen():
    t = lo.lakes(TEXT)
    rows = lo.block_rows([("a", 17.424, 78.474), ("far", 17.9, 78.9)], t, {"1391": (17.4241, 78.4742), "1789": (17.43, 78.48)})
    assert set(rows) == {"a"}
    assert rows["a"]["lo_do_max"] == 2.4 and rows["a"]["lo_lakes_2km"] == 2 and rows["a"]["lo_dead_2km"] == 1
