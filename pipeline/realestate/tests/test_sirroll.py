from pipeline.realestate import sirroll as s


def test_roll_skips_totals_and_reads_both_headers():
    ka = s.roll([{"row_type": "AC", "ac_no": "158", "ac_name": "Hebbal", "male": "84580", "female": "91422", "total": "176015"},
                 {"row_type": "District", "ac_no": "", "ac_name": "", "male": "1", "female": "1", "total": "2"}])
    assert ka == {158: {"name": "Hebbal", "total": 176015, "male": 84580, "female": 91422}}
    wb = s.roll([{"Phase": "1", "AC No.": "159", "AC Name": "BHABANIPUR", "Male": "81000", "Female": "79313", "Total": "160313"}])
    assert wb[159]["total"] == 160313 and wb[159]["female"] == 79313


def test_seat_figures_tamil_nadu_deletions():
    t = {"final": {13: {"name": "Kolathur", "total": 211772, "male": 101900, "female": 109872}},
         "draft": {13: {"name": "Kolathur", "total": 186841, "male": None, "female": None}},
         "deleted": {13: (10000, 90000, 3812, 103812)}}
    name, f = s.seat_figures("Tamil Nadu", t, {13: 282966})[13]
    assert name == "Kolathur"
    assert f["sir_change_pct"] == -25.2 and f["sir_deleted_pct"] == 35.7 and f["sir_women_per_1000"] == 1078
    assert "sir_draft_change_pct" not in f


def test_block_rows_match_number_and_name():
    figs = {159: ("BHABANIPUR", {"sir_electors": 160313}), 160: ("RASHBEHARI (SC)", {"sir_electors": 158406})}
    rows = s.block_rows({"a": (159, "Bhabanipur"), "b": (160, "Rashbehari"), "c": (161, "Ballygunge"), "d": (159, "Tollygunge")}, figs)
    assert set(rows) == {"a", "b"} and rows["b"]["sir_ac"] == 160
