from pipeline.realestate import floodspots as fs

TEXT = """
                Chronic Inundation Locations During Monsoon - 2015
  1        I          1             7                 0              6      14
                         Depth of Inundation During Monsoon - 2015
S.No   Zone  Ward   Location
 1      1     5     TH Road jn.of MRF Road                          Yes
 2      1     6     Kalaignar nagar          Yes
 3      1     6     Second street                                   Yes
                    Wrapped name
 4      9    113                                                    Yes
                Chronic Inundation Locations During Monsoon - 2017
                   Vulnerable Locations During Monsoon-2023
 9       IX          0              1                1                  1            3
 1      15   194    Royal Enclave                            -       Yes
                         NORTHEASTMONSOON-2024
                          VULNERABLE LOCATIONS – 2024
 1        1       2        Thilagar Nagar                         Yes
 2        1       2        Anna Nagar                             Yes
 2        1       2        repeated serial                        Yes
"""


def test_spots_reads_lists_and_skips_abstracts():
    s = fs.spots(TEXT)
    assert s == {2015: {5: 1, 6: 2, 113: 1}, 2023: {194: 1}, 2024: {2: 2}}


def test_ward_figures_and_records():
    f = fs.ward_figures({2015: {5: 1}, 2021: {5: 3, 6: 1}, 2024: {5: 2}})
    assert f[5] == {"fs_ward": 5, "fs_years": 3, "fs_spots": 6, "fs_2015": 1, "fs_2021": 3, "fs_2024": 2, "fs_recent": 2}
    recs = list(fs.records([("a", 5), ("b", 7), ("c", 0)], f))
    assert [r["digipin"] for r in recs] == ["a", "b"] and recs[1]["fs_years"] == 0 and recs[1]["fs_ward"] == 7
