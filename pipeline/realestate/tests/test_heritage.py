from pipeline.realestate import heritage as h


def _b(qid, d, lng=77.2, lat=28.6):
    return {"m": {"value": f"http://www.wikidata.org/entity/{qid}"}, "mLabel": {"value": qid},
            "c": {"value": f"Point({lng} {lat})"}, "d": {"value": f"http://www.wikidata.org/entity/{d}"}}


def test_parse_keeps_strongest_designation():
    items = h.parse([_b("Q1", "Q999"), _b("Q1", h.NATIONAL), _b("Q2", h.STATE, 77.3, 28.7)])
    kinds = {q: k for q, _, _, _, k in items}
    assert kinds == {"Q1": "national", "Q2": "state"}
    q1 = next(x for x in items if x[0] == "Q1")
    assert (q1[2], q1[3]) == (28.6, 77.2)


def test_zone_shares():
    b = {"west": 77.2, "east": 77.2025, "south": 28.6, "north": 28.6025}      # ~245 m block
    pro, reg, near = h.zone_shares(b, [(28.60125, 77.20125)])              # monument at the block centre
    assert near < 1
    assert 20 < pro < 60 and pro + reg == 100
    pro, reg, near = h.zone_shares(b, [(28.7, 77.3)])
    assert (pro, reg) == (0.0, 0.0) and near > 10_000
