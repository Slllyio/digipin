from pipeline.realestate import udise


def _school(code, pin, mgmt, kind="3"):
    return {"pseudocode": code, "pincode": pin, "managment": mgmt, "school_type": kind}


def test_by_pin_counts_government_schools_only_for_quality():
    prof = [_school("1", "110001", "1"), _school("2", "110001", "1", kind="1"), _school("3", "110001", "5"), _school("4", "11000", "1")]
    fac = [{"pseudocode": "1", "classrooms_in_good_condition": "8", "classrooms_needs_minor_repair": "0", "classrooms_needs_major_repair": "2",
            "total_girls_func_toilet": "0", "library_availability": "1"},
           {"pseudocode": "2", "classrooms_in_good_condition": "10", "classrooms_needs_major_repair": "0", "total_girls_func_toilet": "0",
            "library_availability": "2"}]
    enr = [{"pseudocode": "1", "item_group": "1", "c1_b": "100", "c1_g": "100"}, {"pseudocode": "2", "item_group": "1", "c1_b": "200"},
           {"pseudocode": "3", "item_group": "1", "c1_b": "500"}, {"pseudocode": "1", "item_group": "2", "c1_b": "999"}]
    tch = [{"pseudocode": "1", "total_tch": "5"}, {"pseudocode": "2", "total_tch": "5"}, {"pseudocode": "3", "total_tch": "50"}]
    out = udise.by_pin(prof, fac, enr, tch)
    assert list(out) == ["110001"]                       # the malformed PIN code is dropped
    r = out["110001"]
    assert r["schools"] == 3 and r["govt_pct"] == 67 and r["private_pct"] == 33
    assert r["govt_pupils"] == 400 and r["pupils_per_teacher"] == 40.0      # private school and other item groups excluded
    assert r["repair_pct"] == 10.0
    assert r["girls_toilet_pct"] == 0                    # the boys-only school is not counted
    assert r["library_pct"] == 50


def test_by_pin_needs_three_schools():
    prof = [_school("1", "560001", "1"), _school("2", "560001", "5")]
    assert udise.by_pin(prof, [], [], []) == {}


def test_enrolment_trend_reads_both_years():
    new_prof = [{"pseudocode": "a", "pincode": "110001", "managment": "1"}, {"pseudocode": "b", "pincode": "110001", "managment": "5"}]
    new_enr = [{"pseudocode": "a", "item_group": "1", "c1_b": "150", "c1_g": "150"}, {"pseudocode": "a", "item_group": "2", "c1_b": "999"},
               {"pseudocode": "b", "item_group": "1", "c1_b": "300", "c1_g": "300"}]
    old_prof = [{"psuedocode": "a", "pincode": "110001", "managment": "1"}, {"psuedocode": "b", "pincode": "110001", "managment": "5"}]
    old_enr = [{"psuedocode": "a", "item_desc": "General", "c1_b": "200", "c1_g": "100"}, {"psuedocode": "a", "item_desc": "SC", "c1_b": "100"},
               {"psuedocode": "a", "item_desc": "Muslim", "c1_b": "400"}, {"psuedocode": "b", "item_desc": "OBC", "c1_g": "500"}]
    new, old = udise.enrolment_by_pin(new_prof, new_enr), udise.enrolment_by_pin(old_prof, old_enr)
    assert new["110001"] == (300, 600) and old["110001"] == (400, 500)
    assert udise.trend(new, old)["110001"] == {"govt_share_pct": 33.3, "govt_share_change_pp": -11.1}
    assert udise.trend({"1": (100, 100)}, {"1": (50, 40)}) == {"1": {"govt_share_pct": 50.0}}
    assert udise.trend({"1": (60, 40)}, {}) == {}
