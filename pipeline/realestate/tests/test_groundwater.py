from pipeline.realestate import groundwater

CSV = ("﻿S.No.,Area No.,Dept No.,Location,Jan ,Feb,Mar,Apr ,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec\n"
       "1,I,1,Kathivakkam,1.48,1.52,1.46,1.5,1.53,1.55,1.69,1.6,1.61,1.53,1.29,1.38\n"
       "2,I,2,Ernavoor,0,0,2.2,,,,,,,,,\n"
       ",,,Average,2,2,2,2,2,2,2,2,2,2,2,2\n")


def test_depths_skip_totals_and_zero_readings():
    d = groundwater.depths(CSV.lstrip("﻿"))
    assert set(d) == {1, 2}
    assert d[1]["May"] == 1.53 and d[1]["Dec"] == 1.38
    assert d[2] == {"Mar": 2.2}


def test_chennai_rows_join_by_ward_number():
    years = {2021: {1: {"Mar": 2.0}}, 2023: {1: {"May": 5.0, "Dec": 2.0}}, 2024: {1: {"Mar": 3.5}}}
    rows = groundwater.chennai_rows({"A": "1", "B": "7", "C": "0"}, years)
    assert rows == {"A": {"gw_may_m": 5.0, "gw_dec_m": 2.0, "gw_change_m": 1.5}}


def test_prospect_classes_drop_masks():
    kml = "".join(f'<Placemark><SimpleData name="GW_PROS">{p}</SimpleData><Polygon><outerBoundaryIs><LinearRing><coordinates>'
                  '77.5,13.0,0 77.51,13.0,0 77.51,13.01,0 77.5,13.0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
                  for p in ("Good", "Poor to Nil", "Water Body Mask", "Habitation Mask"))
    assert [c for c, _ in groundwater.prospect_polygons(kml)] == [5, 1]
