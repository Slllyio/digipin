from pipeline.realestate.propertytax import YEARS, records, wards


def row(no, res0=1.0, res1=1.5, com=0.5, coll=0.9):
    r = {"Ward No.": no}
    for y in YEARS:
        r[f"{y} - Property Tax Demand (in crores) - Residential"] = str(res1 if y == YEARS[-1] else res0)
        r[f"{y} - Property Tax Collection (in crores) - Residential"] = str(coll * (res1 if y == YEARS[-1] else res0))
        r[f"{y} - Property Tax Demand (in crores) - Commercial"] = str(com)
        r[f"{y} - Property Tax Collection (in crores) - Commercial"] = str(coll * com)
    return r


def test_wards():
    ws = wards([row("N012"), row("")])
    assert list(ws) == [12]
    w = ws[12]
    assert w["pt_res_demand_lakh"] == 150.0 and w["pt_com_demand_lakh"] == 50.0
    assert w["pt_collect_pct"] == 90.0 and w["pt_res_growth_pct"] == 50.0


def test_records():
    recs = list(records([("A", 12), ("B", 13)], wards([row("N012")])))
    assert len(recs) == 1 and recs[0]["pt_ward"] == 12
