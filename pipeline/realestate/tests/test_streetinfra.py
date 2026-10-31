from pipeline.realestate import streetinfra as si


def test_every_class_maps_to_one_kind():
    assert si._KIND_OF["lift_gate"] == "gates"
    assert si._KIND_OF["fire_hydrant"] == "hydrants"
    assert len(si._KIND_OF) == sum(len(v) for v in si.KINDS.values())


def test_rows_count_points_per_block(monkeypatch):
    from pipeline.cells import store
    monkeypatch.setattr(store, "cell_code", lambda level, lat, lng: "A" if lat < 1 else "B")
    rows = si.rows_for([("toilets", 0.5, 0), ("toilets", 0.6, 0), ("gates", 2, 0)])
    by = {r["digipin"]: r for r in rows}
    assert by["A"]["toilets"] == 2 and by["A"]["gates"] == 0
    assert by["B"]["gates"] == 1
