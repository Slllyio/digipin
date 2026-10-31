from pipeline.realestate import districtdev as d


def test_mh_table_reads_fields_and_skips_blanks():
    rows = [{"District": "Mumbai Suburban", d.MH_COLS["dd_banks_lakh"]: "15.1", d.MH_COLS["dd_ptr_elem"]: "-",
             d.UNDERWEIGHT[0]: "0.6", d.UNDERWEIGHT[1]: "7.3"},
            {"District": "Palghar", d.MH_COLS["dd_banks_lakh"]: "(-) 2.3"}]
    t = d.mh_table(rows)
    assert t["mumbai suburban"] == {"dd_banks_lakh": 15.1, "dd_underweight_pct": 7.9} and t["palghar"] == {}


def test_ka_table_sums_educational_districts_and_aliases():
    msme = [{"District": "Bengaluru (Urban)", "Total Enterprises": "633664", "Total Employed": "5099692"}]
    esh = [{"District": "Bengaluru Urban", "Percentage": "19.12"}]
    sslc = [{"District Name": "Bengaluru North", "2025 Appeared": "100", "2025 Passed": "80", "2024 appeared": "100", "2024 passed": "90"},
            {"District Name": "Bengaluru South", "2025 Appeared": "100", "2025 Passed": "90", "2024 appeared": "100", "2024 passed": "90"},
            {"District Name": "Bengaluru North", "2025 Appeared": "100", "2025 Passed": "80", "2024 appeared": "100", "2024 passed": "90"}]
    t = d.ka_table(msme, esh, sslc)
    r = d.block_rows({"a": "Bangalore", "b": "Mumbai"}, [t])
    assert r["a"] == {"dd_msme_units": 633664, "dd_msme_jobs": 5099692, "dd_eshram_pct": 19.1, "dd_sslc_pass_pct": 85.0, "dd_sslc_pass_2024": 90.0}
    assert "b" not in r
