from pipeline.realestate.tradelicences import figures, pins, records


def row(pin="560001", date="2025-05-01", kind="Renewal", part="PART-1(Trade food)", zone="COMMERCIAL RETAIL BUSINESS"):
    return {"Address PIN": pin, "Date": date, "Application Type": kind, "Major Trade": part, "Zonal Classification": zone}


def test_pins_and_figures():
    ps = pins([row(), row(part="PART-2(Lodging)"), row(zone="LIGHT INDUSTRIAL", part=""), row(kind="New", date="2016-01-01"),
               row(kind="New", date="2023-03-03"), row(pin="123"), row(pin="400001")])
    assert list(ps) == [560001]
    f = figures(ps[560001])
    assert f["tl_fy"] == 3 and f["tl_food_pct"] == 33.3 and f["tl_lodging_pct"] == 33.3 and f["tl_industry_pct"] == 33.3
    assert f["tl_new_then"] == 0.2 and f["tl_new_now"] == 0.2


def test_records():
    recs = list(records([("A", 560001), ("B", 560002)], pins([row()])))
    assert len(recs) == 1 and recs[0]["tl_pin"] == 560001
