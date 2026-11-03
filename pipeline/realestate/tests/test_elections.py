from types import SimpleNamespace

from pipeline.realestate import elections as e

SEG = [["Maharashtra", "29", "Mumbai North Central", "1744297", "176", "VandreEast", "1000", "0", "10", "A", "INC", "300"],
       ["Maharashtra", "29", "Mumbai North Central", "1744297", "176", "VandreEast", "1000", "0", "10", "B", "BJP", "190"],
       ["Telangana", "176", "Other", "1", "176", "Elsewhere", "500", "0", "0", "C", "X", "100"]]
WIN = [["Maharashtra", "29", "Mumbai North Central", "GAIKWAD VARSHA EKNATH", "Indian National Congress", "B", "BJP", "110", "Result Declared"]]


def test_segments_and_winners():
    segs = e.parse_segments(SEG)
    s = segs[(176, "VandreEast", "Maharashtra")]
    assert s["lead_party"] == "INC" and s["turnout_pct"] == 50.0 and s["nota_pct"] == 2.0
    w = e.parse_winners(WIN, segs)[(29, "Mumbai North Central", "Maharashtra")]
    assert w == {"mp": "Gaikwad Varsha Eknath", "mp_party": "Indian National Congress", "pc_margin_pct": 22.0}


def test_block_rows_match_by_number_and_name():
    segs = e.parse_segments(SEG)
    wins = e.parse_winners(WIN, segs)
    t = SimpleNamespace(codes=["4FK0000"], columns={"ac_no": ["176"], "assembly": ["Vandre East"], "pc_no": ["29"], "lok_sabha": ["Mumbai North-Central"]})
    row = e.block_rows(t, segs, wins)["4FK0000"]
    assert row["lead_party"] == "INC" and row["mp_party"] == "Indian National Congress"     # not Telangana's AC 176
