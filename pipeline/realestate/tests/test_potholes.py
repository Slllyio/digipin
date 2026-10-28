from pipeline.realestate import potholes


def pm(**kw):
    return "<Placemark>" + "".join(f'<SimpleData name="{k}">{v}</SimpleData>' for k, v in kw.items()) + "</Placemark>"


KML = "<kml>" + pm(Latitude="12.97", Longitude="77.59", Status="Work Done", Type_of_Wo="Road Cutting", Type_of_Ro="Arterial Road",
                   Area__in_s="19.5", Total_Esti="8805", Phone="9999999999") \
    + pm(Latitude="12.98", Longitude="77.60", Status="Rejected") \
    + pm(Latitude="0", Longitude="0", Status="Assigned") + "</kml>"


def test_rejected_and_off_map_complaints_are_dropped_and_phones_not_kept():
    got = list(potholes.complaints(KML))
    assert len(got) == 1 and "Phone" not in got[0]


def test_records_flag_fixed_cuts_and_main_roads():
    r = next(potholes.records(potholes.complaints(KML)))
    assert (r["reports"], r["fixed"], r["road_cuts"], r["main_road"]) == (1, 1, 1, 1)
    assert r["pothole_m2"] == 19.5 and r["repair_rs"] == 8805
