from pipeline.realestate.raingauges import merge, records


def test_merge_dedupes_per_kind_inside_bbox():
    kp = [("gauge", [(77.60, 12.90, {}), (77.70, 13.50, {})]),
          ("gauge", [(77.6003, 12.9002, {}), (77.65, 12.95, {})]),
          ("station", [(77.6001, 12.9001, {})])]
    pts = merge(kp, (77.45, 12.83, 77.78, 13.14))
    assert sorted(k for *_, k in pts) == ["gauge", "gauge", "station"]
    assert {tuple(sorted(r)) for r in records(pts)} == {("lat", "lng", "rain_gauges"), ("lat", "lng", "weather_stations")}
