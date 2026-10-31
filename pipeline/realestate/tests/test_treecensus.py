import io

from pipeline.realestate import treecensus as tc


def test_species_key_keeps_genus_and_species():
    assert tc.species_key("Albizia Lebbeck (L.) Benth.") == "albizia lebbeck"
    assert tc.species_key("Neem") == "neem"
    assert tc.species_key("") is None


def test_acc_counts_invasives_big_trees_and_condition():
    a = tc.Acc()
    a.add("leucaena leucocephala", "Leucaena leucocephala Subabul", 40, 2, "Good")
    a.add("ficus benghalensis", "Ficus benghalensis Banyan", 320, 12, "Average")
    a.add("leucaena leucocephala", "Leucaena leucocephala Subabul", None, None, "Dead")
    a.add(None, "Unknown", None, None, None)
    r = a.row(True)
    assert r["trees"] == 4 and r["species"] == 2
    assert r["invasive_pct"] == 50.0
    assert r["top_share"] == 67
    assert r["big_trees"] == 1
    assert r["poor_pct"] == 66.7
    assert "big_trees" not in a.row(False)


def test_pune_rows_bins_points_to_blocks():
    csv_text = ("geom,botanical_name,common_name,girth_cm,canopy_dia_m,condition\n"
                "POINT (73.85 18.52),Azadirachta indica,Neem,160,6,Good\n"
                "POINT (73.85 18.52),Leucaena leucocephala,Subabul,20,1,Poor\n"
                ",Mangifera indica,Mango,50,3,Good\n")
    accs = {}
    tc.pune_rows(io.StringIO(csv_text, newline=""), accs)
    assert len(accs) == 1
    (acc,) = accs.values()
    assert acc.n == 2 and acc.inv == 1 and acc.big == 1
