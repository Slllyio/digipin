from pipeline.realestate.publicland import records

BB = (77.45, 12.83, 77.78, 13.14)


def row(q, d, a="100"):
    return {"Quality": q, "Latitude": "12.97", "Longitude": "77.59", "Area (sq. m)": a, "Property Details": d}


def test_only_unique_rows_and_uses():
    recs = list(records([row("approximate", "x"), row("unique", "ಬಿ.ಬಿ.ಎಂ.ಪಿ. ಖಾಲಿಜಾಗ", "250"), row("unique", "ಅಂಗನವಾಡಿ ಕೇಂದ್ರ"),
                         row("unique", "park", "n/a")], BB))
    assert len(recs) == 3
    assert recs[0]["vacant_plots"] == 1 and recs[0]["vacant_m2"] == 250
    assert recs[1]["amenity_plots"] == 1 and "vacant_plots" not in recs[1]
    assert recs[2]["gba_land_m2"] == 0
