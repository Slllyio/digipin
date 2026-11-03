from pipeline.realestate import intercitytrains as it


def test_station_trains_and_rows():
    stations = [{"properties": {"code": "A", "name": "Alpha"}, "geometry": {"coordinates": [77.0, 12.0]}},
                {"properties": {"code": "B", "name": "Beta"}, "geometry": {"coordinates": [77.3, 12.0]}},
                {"properties": {"code": "C", "name": "Gamma"}, "geometry": None}]
    trains = [{"properties": {"number": "1", "type": "SF"}}, {"properties": {"number": "2", "type": "Exp"}}, {"properties": {"number": "3", "type": "Pass"}}]
    sched = [{"train_number": "1", "station_code": "A", "arrival": "10:00:00", "departure": "10:05:00"},
             {"train_number": "2", "station_code": "A", "arrival": "None", "departure": "11:00:00"},
             {"train_number": "3", "station_code": "A", "arrival": "12:00:00", "departure": "12:02:00"},
             {"train_number": "1", "station_code": "B", "arrival": "13:00:00", "departure": "13:00:00"},
             {"train_number": "2", "station_code": "C", "arrival": "14:00:00", "departure": "14:05:00"}]
    st = it.station_trains(stations, trains, sched)
    assert st == [("A", "Alpha", 12.0, 77.0, 2)]
    rows = it.block_rows([("x", 12.0, 77.01), ("y", 12.0, 77.2)], st, hub=2)
    assert rows["x"] == {"it_trains_5km": 2, "it_stations_5km": 1, "it_hub_km": 1.1, "it_hub_trains": 2}
    assert rows["y"]["it_trains_5km"] == 0 and rows["y"]["it_hub_km"] == 21.8
