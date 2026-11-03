import math

from pipeline.realestate import neighbourhoods as nb


def _bin(y, x):
    return math.floor(y / nb.PIN_BIN), math.floor(x / nb.PIN_BIN)


def test_pin_vote_picks_the_nearby_majority():
    bins = {_bin(28.5, 77.2): {"110017": 30, "110030": 2}, _bin(28.504, 77.2): {"110030": 40}}
    out = nb.pin_vote([("A", 28.5, 77.2), ("B", 28.504, 77.2), ("C", 28.6, 77.2)], bins)
    assert out["A"][0] == "110017" and out["A"][1] > 50
    assert out["B"][0] == "110030"
    assert "C" not in out                 # nothing within reach


def test_nearest_name_within_reach():
    out = nb.nearest([("A", 28.5, 77.2), ("B", 28.7, 77.2)], [(28.501, 77.2, "Saket")])
    assert out == {"A": "Saket"}
