from pipeline.realestate import schoolsafety as ss


def test_by_pin_counts_yes_over_answered_and_government_audits():
    prof = [{"pseudocode": str(k), "pincode": "560001", "managment": "1" if k < 2 else "5"} for k in range(4)]
    prof.append({"pseudocode": "9", "pincode": "", "managment": "1"})
    safety = [{"pseudocode": "0", "struct_safaud_yn": "1", "cctv_cam_yn": "1", "slfdef_grt_yn": "9"},
              {"pseudocode": "1", "struct_safaud_yn": "2", "cctv_cam_yn": "1", "slfdef_grt_yn": "9"},
              {"pseudocode": "2", "struct_safaud_yn": "1", "cctv_cam_yn": "2", "slfdef_grt_yn": "1"},
              {"pseudocode": "3", "struct_safaud_yn": "1", "cctv_cam_yn": "1", "slfdef_grt_yn": "9"},
              {"pseudocode": "9", "struct_safaud_yn": "1"}]
    r = ss.by_pin(prof, safety)["560001"]
    assert r["ss_schools"] == 4 and r["ss_audit_pct"] == 75 and r["ss_cctv_pct"] == 75
    assert "ss_selfdef_pct" not in r and "ss_govt_audit_pct" not in r   # under MIN_SCHOOLS answers
