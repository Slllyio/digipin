from pipeline.realestate import nfhs

CSV = """State,ST_CEN_CD,District,DISTRICT,DT_CEN_CD,Category,Indicator,NFHS 5,NFHS 4
Delhi,7,South ,South_9,9,Nutrition,Children under 5 years who are stunted (height for age) (%),21.7,30
Delhi,7,South ,South_9,9,Adults,Male Elevated blood pressure or taking medicine to control blood pressure (%),0,0
Delhi,7,South ,South_9,9,Households,Households using clean fuel for cooking (%),99.1,95
"""


def test_table_picks_fields_and_skips_missing_zeros():
    t = nfhs.table(CSV)
    assert t["South_9"] == {"district": "South", "stunted_pct": 21.7, "clean_fuel_pct": 99.1}
