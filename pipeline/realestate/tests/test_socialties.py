from pipeline.realestate import socialties as st


def test_split():
    assert st._split("MumbaiSuburban") == "Mumbai Suburban"
    assert st._split("NCTofDelhi") == "Delhi" and st._split("Hailakandi") == "Hailakandi"


def test_ties():
    state = {"c": "Karnataka", "k2": "Karnataka", "a1": "Assam", "t1": "TamilNadu"}
    names = {"a1": "Hailakandi", "t1": "Krishnagiri"}
    dom = st.domestic([("c", "k2", 900), ("c", "a1", 200), ("c", "t1", 100), ("x", "a1", 999)], ["c"], state)
    t = st.ties(dom, {"IN": 1, "AE": 6000, "SG": 9000, "LU": 100, "SA": 3000}, {"AE": 3000, "SG": 1000, "LU": 1, "SA": 3000},
                "Karnataka", state, names, top=2)
    assert t["districts"] == [["Hailakandi", "Assam", 200], ["Krishnagiri", "Tamil Nadu", 100]]
    assert t["countries"][0] == ["Singapore", 9000]
    assert t["distinct"] == [["Singapore", 9.0], ["the UAE", 2.0]]
    assert t["fields"] == {"st_top_out_sci": 200, "st_gulf_sci": 4500, "st_abroad_ratio": 9.0}
