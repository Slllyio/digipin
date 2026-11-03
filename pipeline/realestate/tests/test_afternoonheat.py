from pipeline.realestate import afternoonheat as ah


def test_ist_window():
    assert ah.ist_minutes("2024-04-05T08:33:44.000Z") == 14 * 60 + 3
    assert ah.afternoon("2024-04-05T08:33:44.000Z") and not ah.afternoon("2024-04-05T04:33:44.000Z")


def test_scene_key_groups_tiles():
    assert ah.scene_key("ECOv002_L2T_LSTE_32588_003_43RGM_20240405T043344_0711_01") == "32588_003"


def test_anomalies_remove_scene_weather(monkeypatch):
    monkeypatch.setattr(ah, "MIN_SCENE_BLOCKS", 3)
    s1 = {"a": 40.0, "b": 45.0, "c": 50.0}
    s2 = {"a": 30.0, "b": 35.0, "c": 40.0}
    tiny = {"a": 99.0}
    out = ah.anomalies([s1, s2, tiny])
    assert out["a"] == (35.0, -5.0, 2) and out["c"] == (45.0, 5.0, 2)
