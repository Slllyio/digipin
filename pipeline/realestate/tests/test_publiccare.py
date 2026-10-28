from pipeline.realestate import publiccare


def test_records_count_each_centre_once_per_kind():
    kp = [("primary", [(77.6014, 13.0016, {}), (77.60141, 13.00161, {})]), ("primary", [(77.60142, 13.00162, {})]),
          ("maternity", [(77.6014, 13.0016, {}), (0.0, 0.0, {})])]
    recs = list(publiccare.records(kp))
    assert recs == [{"lat": 13.0016, "lng": 77.6014, "primary": 1}, {"lat": 13.0016, "lng": 77.6014, "maternity": 1}]


def test_points_reads_geojson():
    text = '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[77.6,13.0]},"properties":{"a":1}}]}'
    assert publiccare.points("x.geojson", text) == [(77.6, 13.0, {"a": 1})]

CSV = ("City Name,Ward No,Ward Name,Name of healthcare facility,Type of facility,Latitude,Longitude\n"
       "Pune,6,Kothrud,Late. Jayabai Sutar Maternity Home,Government hospital(PMC),18.503652,73.807762\n"
       "Pune,6,Kothrud,Late. Sundarabai Raut Dawakhana,Government hospital(PMC),18.511578,73.820137\n"
       "Pune,13,Kasba,Kamala Nehru Hospital (General Hospital),Government hospital(PMC),18.52283,73.86199\n")


def test_pmc_list_split_by_kind():
    assert publiccare.points("x.csv", CSV, "maternity") == [(73.807762, 18.503652, {})]
    assert publiccare.points("x.csv", CSV, "primary") == [(73.820137, 18.511578, {})]


def test_pune_registered():
    assert {k for k, _, _ in publiccare.SOURCES["pune"]} == {"primary", "maternity"}
