from pipeline.realestate import lakewater as lw

TEXT = """  3589          Nov         Madiwala Tank                       D            27         5.9      6.5       381       6      1.53     0.21       310        2800
1388     Sep                                              E        26       1.5     7.8      512      22     1.97     BDL      1200     7000
STN    Sampling   header line
"""


def test_samples_reads_class_do_bod_and_coliform():
    assert lw.samples(TEXT) == [("3589", "D", 5.9, 6.0, 310.0), ("1388", "E", 1.5, 22.0, 1200.0)]


def test_summary_and_block_rows_use_nearest_lake_within_2km():
    s = lw.lake_summary([("1", "E", 2.0, 20.0, 1000.0), ("1", "D", 4.0, 10.0, 3000.0), ("1", "E", None, None, None), ("2", "D", 6.0, 4.0, 200.0)])
    assert s["1"] == {"n": 3, "e_share": 67, "do": 3.0, "bod": 15.0, "fc": 2000.0}
    lakes = {"1": (12.90, 77.60), "2": (12.91, 77.60)}
    rows = lw.block_rows([("a", 12.90, 77.60), ("far", 13.20, 77.60)], s, lakes)
    assert set(rows) == {"a"}
    assert rows["a"]["lw_e_share"] == 67 and rows["a"]["lw_lakes_2km"] == 2 and rows["a"]["lw_e_lakes_2km"] == 1
