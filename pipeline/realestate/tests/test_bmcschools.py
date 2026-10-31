from pipeline.realestate import bmcschools as bs


def test_records_count_each_site_once():
    recs = list(bs.records({"municipal": [(72.85, 19.22, {}), (72.85001, 19.22001, {})], "aided": [(72.85, 19.22, {}), (0, 0, {})]}))
    assert [r["schools"] for r in recs] == [1, 0, 0]
    assert sum(r.get("municipal", 0) for r in recs) == 2 and sum(r.get("aided", 0) for r in recs) == 1


def test_telangana_management_and_clip():
    from pipeline.realestate.bmcschools import ts_kind, ts_points
    assert [ts_kind(m) for m in ("State Govt.", "MPP_ZPP SCHOOLS", "Pvt.Aided", "Pvt.Unaided (CBSE Syllabus)", "Madarsa unrecognized")] == \
        ["municipal", "municipal", "aided", "unaided", None]
    kml = ('<Placemark><SimpleData name="Management">Pvt.Aided</SimpleData><Point><coordinates>78.47,17.39</coordinates></Point></Placemark>'
           '<Placemark><SimpleData name="Management">State Govt.</SimpleData><Point><coordinates>79.5,17.39</coordinates></Point></Placemark>')
    got = ts_points(kml, (78.2, 17.2, 78.7, 17.6))
    assert len(got["aided"]) == 1 and not got["municipal"]
