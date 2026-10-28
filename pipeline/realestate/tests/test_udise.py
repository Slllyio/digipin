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
