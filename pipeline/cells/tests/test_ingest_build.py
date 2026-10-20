"""Generic CSV/GeoJSON ingest + the built-in dataset adapters."""
import json

import pytest

from pipeline.cells import adapters, build, ingest, store


def test_slug():
    assert ingest.slug("Beds (ICU)") == "beds_icu"
    assert ingest.slug("2024 total") == "f_2024_total"


def test_csv_ingest_infers_fields(tmp_path):
    p = tmp_path / "hospitals.csv"
    p.write_text("name,Latitude,Longitude,beds,type\n"
                 "A,22.7196,75.8577,120,govt\n"
                 "B,22.7197,75.8578,\"1,000\",private\n"
                 "C,22.7500,75.9000,30,govt\n")
    out = tmp_path / "cells"
    s = ingest.ingest(p, "hospitals", "Hospitals", 7, "indore_pilot", out, parquet=False)
    assert s["cells"] == 2
    cat = json.loads((out / "catalog.json").read_text())
    (d,) = cat["datasets"]
    keys = {f["key"]: f for f in d["fields"]}
    # Low-cardinality text (even `name`, 3 values) is a category; lat/lng are location.
    assert set(keys) == {"count", "name", "beds", "type"}
    assert keys["beds"]["agg"] == "mean" and keys["type"]["type"] == "category"
    t = store.read_json(out / "hospitals" / "indore_pilot.json")
    i = t.columns["count"].index(2)
    assert t.columns["beds"][i] == 560


def test_geojson_and_digipin_location(tmp_path):
    gj = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [75.8577, 22.7196]},
         "properties": {"aqi": 80}},
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[75.85, 22.71], [75.86, 22.71],
                                                                             [75.86, 22.72], [75.85, 22.71]]]},
         "properties": {"aqi": 100}},
    ]}
    p = tmp_path / "aq.geojson"
    p.write_text(json.dumps(gj))
    rows = ingest.read_rows(p)
    assert rows[0]["lat"] == 22.7196 and rows[1]["lng"] == pytest.approx(75.855)

    c = tmp_path / "pins.csv"
    c.write_text("digipin,score\n34P-LLM-PKT9,5\n34PLLMPKT8,7\n")
    rows = ingest.read_rows(c)
    fields, src = ingest.infer_fields(rows)
    t = store.bin_records(ingest.to_records(rows, fields, src), 6, fields)
    assert t.codes == ["34PLLM"] and t.columns["count"] == [2] and t.columns["score"] == [6.0]


def test_ingest_agg_override(tmp_path):
    p = tmp_path / "x.csv"
    p.write_text("lat,lng,pop\n22.7196,75.8577,10\n22.7197,75.8578,5\n")
    ingest.ingest(p, "x", "X", 7, "r", tmp_path, aggs={"pop": "sum"}, parquet=False)
    assert store.read_json(tmp_path / "x" / "r.json").columns["pop"] == [15]


def test_grid_records_pixel_centres_and_keep():
    grid = {"bounds": {"west": 75.0, "south": 22.0, "east": 75.2, "north": 22.2}, "nx": 2, "ny": 2,
            "v": [1, None, 3, 4]}
    recs = list(adapters.grid_records(grid, ["v"], keep=lambda r: r["v"] is not None))
    assert [r["v"] for r in recs] == [1, 3, 4]
    assert recs[0]["lat"] == pytest.approx(22.15) and recs[0]["lng"] == pytest.approx(75.05)  # row 0 = north
    assert recs[1]["lat"] == pytest.approx(22.05)


def test_score_shard_records(tmp_path):
    (tmp_path / "r").mkdir()
    (tmp_path / "coverage.json").write_text(json.dumps({
        "fields": ["a", "b"], "regions": [{"name": "r", "level": 6, "shards": ["34", "zz"]}]}))
    (tmp_path / "r" / "34.json").write_text(json.dumps({"34PLLM": [1, 2]}))
    fields, recs = adapters.score_shard_records(tmp_path, "r")
    assert fields == ["a", "b"] and list(recs) == [{"digipin": "34PLLM", "a": 1, "b": 2}]
    with pytest.raises(ValueError):
        adapters.score_shard_records(tmp_path, "nope")


@pytest.mark.parametrize("name", sorted(build.BUILTINS))
def test_builtins_build_from_committed_data(name):
    built = build.BUILTINS[name]("indore_pilot")
    if built is None:
        pytest.skip(f"{name} input not in this checkout")
    spec, table = built
    assert len(table) > 100 and table.level == spec.level
    for f in spec.fields:
        assert len(table.columns[f.key]) == len(table)


def test_committed_catalog_lists_the_builtins():
    cat_path = build.DATA / "cells" / "catalog.json"
    if not cat_path.exists():
        pytest.skip("cell store not built in this checkout")
    cat = json.loads(cat_path.read_text())
    ids = {d["id"] for d in cat["datasets"]}
    assert set(build.BUILTINS) <= ids
    for d in cat["datasets"]:
        for r in d["regions"]:
            t = store.read_region(build.DATA / "cells", r)    # sharded or single file
            assert len(t) == r["cells"]


def test_coverage_matrix_marks_missing_cities():
    from pipeline.cells.coverage import matrix
    cat = {"datasets": [{"id": "t", "level": 7, "regions": [{"name": "a", "cells": 1234}]}]}
    out = matrix(cat, cities=("a", "b"))
    assert "| a | 1,234 |" in out and "| b | — |" in out
    assert "1 of 2" in out
