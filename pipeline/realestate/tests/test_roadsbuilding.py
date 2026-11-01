from pipeline.realestate.roadsbuilding import kind_of, pieces, rows_from


def test_kind_of():
    assert kind_of("trunk") == "major" and kind_of("residential") == "minor" and kind_of("footway") is None


def test_pieces_cover_the_line():
    p = pieces("LINESTRING (77.2 28.6, 77.21 28.6)", 97900)
    assert abs(sum(m for _, _, m in p) - 979) < 1 and len(p) == 20


def test_rows_from_sums_and_drops_slivers():
    rows = rows_from([(28.6, 77.2, "primary", 40.0, True), (28.6, 77.2, "service", 10.0, False), (19.1, 72.9, "service", 5.0, False)])
    assert list(rows.values()) == [{"rb_major_m": 40, "rb_minor_m": 10, "rb_elevated_m": 40}]
