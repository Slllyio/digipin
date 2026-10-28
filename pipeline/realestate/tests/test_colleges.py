from pipeline.realestate import colleges


def test_records_count_kinds_and_keep_government_degree_out_of_the_total():
    pts = [(77.59, 12.97, {}), (0.0, 0.0, {})]
    deg = list(colleges.records("degree", pts))
    gov = list(colleges.records("govt_degree", pts))
    assert deg == [{"lat": 12.97, "lng": 77.59, "degree": 1, "colleges": 1}]
    assert gov == [{"lat": 12.97, "lng": 77.59, "govt_degree": 1}]
