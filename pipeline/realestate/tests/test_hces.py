from pipeline.realestate.hces import households, summary

K = {"FSU_Serial_No": "1", "Sample_Sub_Division_No": "", "Second_Stage_Stratum_No": "1"}


def test_households_and_summary():
    l15, l14 = [], []
    for h in range(60):
        k = dict(K, Sample_Household_No=str(h))
        l15.append(dict(k, Sector="2", HOUSEHOLD_SIZE="2", MULTIPLIER="100"))
        for q, code, v in (("F", "129", 3000), ("F", "219", 700), ("C", "529", 6000 if h % 2 else 0), ("C", "539", 9000), ("D", "379", 36500)):
            l14.append(dict(k, Questionnaire_No=q, ITEM_CODE=code, VALUE_RS=str(v)))
    l15.append(dict(K, Sample_Household_No="rural", Sector="1", HOUSEHOLD_SIZE="2", MULTIPLIER="1"))
    hh = households(l14, l15)
    assert len(hh) == 60
    _, _, d = hh[1]
    assert d["219"] == 3000 and d["379"] == 3000 and "539" not in d      # 7 days and 365 days to 30; imputed rent out
    s = summary(hh)
    assert s["hc_mpce"] == 6000 and s["hc_mpce_median"] == 4500        # ₹9,000 or ₹15,000 for two people
    assert s["hc_renters_pct"] == 50.0 and s["hc_rent"] == 6000
