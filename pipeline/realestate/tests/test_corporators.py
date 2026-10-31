from pipeline.realestate import corporators as c


def test_pune_wards_carry_number_down_and_count_seats():
    rows = [{"Ward No.": "1", "Party": "BJP"}, {"Ward No.": "", "Party": "BJP"}, {"Ward No.": "", "Party": "NCP"}, {"Ward No.": "", "Party": "BJP"},
            {"Ward No.": "2", "Party": "NCP-SP"}, {"Ward No.": "", "Party": "INC"}, {"Ward No.": "", "Party": "INC"}, {"Ward No.": "", "Party": "NCP-SP"}]
    w = c.pune_wards(rows)
    assert w[1]["corp_party"] == "BJP" and w[1]["corp_seats"] == 4 and w[1]["corp_lead_seats"] == 3 and w[1]["corp_party_id"] == 1
    assert w[2]["corp_party"] == "NCP (SP)" and w[2]["corp_lead_seats"] == 2      # tie: first-listed party
    assert w[2]["corp_year"] == 2026


def test_ghmc_margin_and_renamed_party():
    rows = [{"Ward_No": "1", "Position": "1", "Party_Abbreviation": "TRS", "Votes": "8762", "Valid_Votes": "20464", "Voter_Turnout_Percentage": "45.14"},
            {"Ward_No": "1", "Position": "2", "Party_Abbreviation": "BJP", "Votes": "6684", "Valid_Votes": "20464"},
            {"Ward_No": "1", "Position": "3", "Party_Abbreviation": "INC", "Votes": "100", "Valid_Votes": "20464"}]
    w = c.ghmc_wards(rows)[1]
    assert w["corp_party"] == "BRS" and w["corp_margin_pct"] == 10.2 and w["corp_turnout_pct"] == 45.1 and w["corp_seats"] == 1
