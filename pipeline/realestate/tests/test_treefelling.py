from pipeline.realestate import treefelling as t


def test_trees_split_along_alignment_and_counted_within_2km():
    notices = [(300, "line", 1, [(12.90, 77.50), (12.95, 77.50), (13.00, 77.50)]), (50, "site", 5, [(12.901, 77.501)])]
    r = t.block_rows([("a", 12.90, 77.50), ("b", 13.20, 77.50)], notices)
    assert r["a"]["tf_trees_2km"] == 150 and r["a"]["tf_notices_2km"] == 2 and r["a"]["tf_kind_nearest"] == 1
    assert r["b"]["tf_trees_2km"] == 0 and r["b"]["tf_km"] > 20


def test_notice_table_is_sane():
    assert len(t.NOTICES) == 56 and sum(n[0] for n in t.NOTICES) == 25386
    assert all(12.8 < la < 13.2 and 77.4 < lo < 77.8 for n in t.NOTICES for la, lo in n[3])
