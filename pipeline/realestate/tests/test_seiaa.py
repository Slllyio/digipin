from pipeline.realestate import seiaa


def test_kind_reads_type_from_name():
    assert seiaa.kind("Residential Apartment Project") == (True, False)
    assert seiaa.kind("IT Park and Office Space") == (False, True)
    assert seiaa.kind("Mixed Use Development") == (True, True)
    assert seiaa.kind(None) == (False, False)


def test_records_dedupe_and_clip():
    pts = [(77.6, 12.9, {"CONSTRUCTIONName": "Residential Apartments"}), (77.6, 12.9, {"CONSTRUCTIONName": "Residential Apartments"}),
           (80.2, 13.0, {"CONSTRUCTIONName": "Hotel"})]
    assert list(seiaa.records(pts)) == [{"lat": 12.9, "lng": 77.6, "projects": 1, "residential": 1, "commercial": 0}]
