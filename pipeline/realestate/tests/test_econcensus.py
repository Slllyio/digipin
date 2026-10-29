from pipeline.realestate.econcensus import figures, records, wards


def row(wc, bact="12", hh="0", own="2", sex="1", mh="0", fh="0", mnh="1", fnh="0", total="1", tv="7110"):
    return {"WC": wc, "T_V": tv, "BACT": bact, "IN_HH": hh, "OWN_SHIP_C": own, "SEX": sex,
            "M_H": mh, "F_H": fh, "M_NH": mnh, "F_NH": fnh, "TOTAL_WORKER": total}


def test_wards_and_figures():
    ws = wards([row("5", bact="6", hh="1", mh="3", total="4"), row("5", sex="2", fnh="1", mnh="0"), row("0"), row("884"), row("5", tv="7112")])
    assert list(ws) == [5]
    f = figures(ws[5])
    assert f["ec_workers"] == 5 and f["ec_estabs"] == 2
    assert f["mfg_pct"] == 80.0 and f["trade_pct"] == 20.0 and f["home_pct"] == 50.0
    assert f["women_pct"] == 20.0 and f["women_owner_pct"] == 50.0 and f["hired_pct"] == 60.0


def test_records_join_by_ward():
    ws = wards([row("7")])
    recs = list(records([("AAA", 7), ("BBB", 8)], ws))
    assert len(recs) == 1 and recs[0]["digipin"] == "AAA" and recs[0]["ec_ward"] == 7
