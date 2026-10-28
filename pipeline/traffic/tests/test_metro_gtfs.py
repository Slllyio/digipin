from pipeline.traffic import metro_gtfs
from pipeline.traffic.gtfs_cells import cell_rows, summarise_stops


def test_feeds_are_open_urls():
    assert all(f["url"].startswith("https://") and f["license"] for f in metro_gtfs.FEEDS.values())


def test_platform_headway_from_peak_departures():
    times = [{"trip_id": f"t{k}", "stop_id": "P1", "departure_time": f"{7 + k // 20:02d}:{(k * 3) % 60:02d}:00"} for k in range(60)]
    per = summarise_stops(times, {f"t{k}": "RED" for k in range(60)})
    (r,) = cell_rows({"P1": (17.4, 78.5)}, per).values()
    assert r["peak_departures_hr"] == 20.0 and r["best_headway_min"] == 3.0
