from pipeline.realestate import districtincome as d


def test_state_table_ranks_and_skips_divisions():
    rows = [{"District": "Mumbai#", "Per Capita Nominal NDDP 2024-25+": "5,17,875", "Nominal GDDP 2024-25+": "9,13,316"},
            {"District": "Pune", "Per Capita Nominal NDDP 2024-25+": "4,26,720", "Nominal GDDP 2024-25+": "5,34,695"},
            {"District": "", "Per Capita Nominal NDDP 2024-25+": "1"},
            {"District": "PUNE DIV.", "Per Capita Nominal NDDP 2024-25+": "3,51,530"}]
    t = d.state_table(rows, 2024, "District", "Per Capita Nominal NDDP 2024-25+", "Nominal GDDP 2024-25+", 1)
    assert set(t) == {"mumbai", "pune"} and t["mumbai"]["di_rank"] == 1 and t["pune"]["di_gddp_cr"] == 534695


def test_aliases_only_on_lookup():
    rows = [{"District": "Medak", "PCI": "2,55,263"}, {"District": "Sangareddy", "PCI": "3,22,394"}]
    t = d.state_table(rows, 2022, "District", "PCI", "GDDP", 1)
    assert set(t) == {"medak", "sangareddy"}
    r = d.block_rows({"a": "Medak", "b": "Mumbai Suburban"}, {"Telangana": t})
    assert r["a"]["di_pci"] == 322394 and "b" not in r
