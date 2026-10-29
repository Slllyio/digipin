from pipeline.realestate.streetgrid import degrees, records


def test_degrees_and_records():
    segs = [
        [{"connector_id": "a", "at": 0.0}, {"connector_id": "b", "at": 1.0}],
        [{"connector_id": "b", "at": 0.0}, {"connector_id": "c", "at": 1.0}],
        [{"connector_id": "b", "at": 0.0}, {"connector_id": "d", "at": 1.0}],
        [{"connector_id": "e", "at": 0.0}, {"connector_id": "f", "at": 0.5}, {"connector_id": "g", "at": 1.0}],
        [{"connector_id": "f", "at": 0.0}, {"connector_id": "h", "at": 1.0}],
    ]
    deg = degrees(segs)
    assert deg["b"] == 3 and deg["a"] == 1 and deg["f"] == 3
    recs = list(records([("a", 1, 2), ("b", 3, 4), ("f", 5, 6), ("x", 7, 8)], deg))
    assert {"lat": 2, "lng": 1, "dead_ends": 1} in recs
    assert sum("intersections" in r for r in recs) == 2 and len(recs) == 3
