from pipeline.realestate import gwstress as g

ROWS = [{"Name of District": "Bengaluru (Urban)", "Stage of GW extraction (%)": "177.28", "Total Annual Extraction": "54669.77",
         "Domestic - Annual Extraction": "16223.9", "Industrial - Annual extraction": "13701.82", "Irrigation - Annual extraction": "24744.05",
         "Total annual groundwater recharge": "34265.4"},
        {"Name of District": "Total(Ham)", "Stage of GW extraction (%)": "66.49"}]


def test_districts_and_state_total():
    d, state = g.districts(ROWS)
    f = d["bengaluru (urban)"]
    assert state == 66.49 and f["gw_class"] == 4 and f["gw_domestic_pct"] == 29.7 and f["gw_stage_pct"] == 177.3


def test_block_rows_alias_2011_names():
    rows = g.block_rows({"a": "Bangalore", "b": "Gurgaon"}, {"Karnataka": g.districts(ROWS)})
    assert set(rows) == {"a"} and rows["a"]["gw_state_stage_pct"] == 66.5
    assert [g.klass(x) for x in (70, 85, 95, 101)] == [1, 2, 3, 4]
