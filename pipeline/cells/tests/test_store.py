"""Cell store: binning, schema validation, writers, catalog upserts."""
import json
from pathlib import Path

import pytest

from pipeline.cells import store
from pipeline.cells.schema import DatasetSpec, FieldSpec, validate

PARITY = Path(__file__).parent / "bin_parity.json"


def _fields(doc):
    return [FieldSpec(key=f["key"], label=f["label"], type=f["type"], agg=f["agg"]) for f in doc["fields"]]


def test_bin_records_matches_committed_parity_fixture():
    # The same fixture is asserted by tests/cell-store.test.js, so the Python
    # pipeline and the browser drop-ingest bin identically.
    doc = json.loads(PARITY.read_text())
    fields = _fields(doc)
    for case in doc["cases"]:
        t = store.bin_records(doc["records"], case["level"], fields)
        assert t.codes == case["cells"]
        for k, col in case["columns"].items():
            assert t.columns[k] == pytest.approx(col), (case["level"], k)


def test_codes_truncate_to_parent_cells():
    assert store.cell_code(6, code="34P-LLM-PKT9") == "34PLLM"
    assert store.cell_code(8, code="34PLLM") is None          # too coarse for L8
    assert store.cell_code(7, lat=1.0, lng=75.0) is None      # outside India
    full = store.cell_code(10, lat=22.7196, lng=75.8577)
    assert store.cell_code(6, lat=22.7196, lng=75.8577) == full[:6]


def test_aggs_and_sparse_drop():
    f = [FieldSpec("v", "V", agg="mean")]
    t = store.bin_records([{"lat": 22.72, "lng": 75.85, "v": None}], 7, f)
    assert len(t) == 0                                          # all-null cell dropped
    t = store.bin_records([{"lat": 22.72, "lng": 75.85, "v": 2},
                           {"lat": 22.72, "lng": 75.85, "v": 4}], 7, f)
    assert t.columns["v"] == [3.0]
    assert t.row(t.codes[0]) == {"v": 3.0}


@pytest.mark.parametrize("bad", [
    dict(id="Bad-Id"), dict(level=11), dict(fields=[]),
    dict(fields=[FieldSpec("lat", "x")]),
    dict(fields=[FieldSpec("a", "A", type="vector")]),
    dict(fields=[FieldSpec("a", "A", agg="median")]),
    dict(fields=[FieldSpec("a", "A", ramp="rainbow")]),
    dict(fields=[FieldSpec("a", "A"), FieldSpec("a", "B")]),
    dict(default_field="nope"),
])
def test_validate_rejects(bad):
    base = dict(id="ok", title="OK", level=7, fields=[FieldSpec("a", "A")])
    base.update(bad)
    with pytest.raises(ValueError):
        validate(DatasetSpec(**base))


def _spec(**kw):
    base = dict(id="demo", title="Demo", level=7, fields=[
        FieldSpec("risk", "Risk", agg="max", domain=[0, 100], ramp="reds"),
        FieldSpec("density", "Density", agg="mean"),
        FieldSpec("kind", "Kind", type="category", agg="mode"),
    ])
    base.update(kw)
    return DatasetSpec(**base)


def _table(level=7, lat=22.72):
    recs = [{"lat": lat, "lng": 75.85, "risk": 40, "density": 2.5, "kind": "a"},
            {"lat": lat + 0.01, "lng": 75.86, "risk": 90, "density": 7.5, "kind": "b"}]
    return store.bin_records(recs, level, _spec().fields)


def test_write_dataset_json_and_catalog(tmp_path):
    summary = store.write_dataset(tmp_path, _spec(), "indore_pilot", _table(), parquet=False)
    assert summary["cells"] == 2
    doc = json.loads((tmp_path / "demo" / "indore_pilot.json").read_text())
    assert doc["level"] == 7 and doc["fields"] == ["risk", "density", "kind"]
    assert len(doc["cells"]) == len(doc["columns"]["risk"]) == 2
    assert store.read_json(tmp_path / "demo" / "indore_pilot.json").codes == doc["cells"]

    cat = json.loads((tmp_path / "catalog.json").read_text())
    (d,) = cat["datasets"]
    assert d["id"] == "demo" and d["approxCellM"] == 244
    fields = {f["key"]: f for f in d["fields"]}
    assert fields["risk"]["domain"] == [0, 100]               # explicit kept
    assert fields["density"]["domain"] == [2.5, 7.5]          # data-derived
    assert fields["kind"]["domain"] == ["a", "b"]
    (r,) = d["regions"]
    assert r["json"] == "demo/indore_pilot.json" and r["parquet"] is None
    assert r["bbox"]["south"] < r["bbox"]["north"]


def test_catalog_upsert_keeps_other_regions_and_widens_domains(tmp_path):
    store.write_dataset(tmp_path, _spec(), "indore_pilot", _table(), parquet=False)
    t2 = store.bin_records([{"lat": 23.25, "lng": 77.40, "risk": 10, "density": 50, "kind": "c"}],
                           7, _spec().fields)
    store.write_dataset(tmp_path, _spec(), "bhopal", t2, parquet=False)
    store.write_dataset(tmp_path, _spec(), "bhopal", t2, parquet=False)   # idempotent
    (d,) = json.loads((tmp_path / "catalog.json").read_text())["datasets"]
    assert [r["name"] for r in d["regions"]] == ["bhopal", "indore_pilot"]
    fields = {f["key"]: f for f in d["fields"]}
    assert fields["density"]["domain"] == [2.5, 50]
    assert fields["kind"]["domain"] == ["a", "b", "c"]
    assert fields["risk"]["domain"] == [0, 100]


def test_level_mismatch_rejected(tmp_path):
    with pytest.raises(ValueError):
        store.write_dataset(tmp_path, _spec(level=8), "x", _table(level=7), parquet=False)


def test_polygon_wkb_roundtrip():
    import struct
    b = {"west": 75.0, "south": 22.0, "east": 75.5, "north": 22.5}
    wkb = store._polygon_wkb(b)
    order, gtype, rings, npts = struct.unpack("<BIII", wkb[:13])
    assert (order, gtype, rings, npts) == (1, 3, 1, 5)
    pts = [struct.unpack("<dd", wkb[13 + 16 * i: 29 + 16 * i]) for i in range(5)]
    assert pts[0] == pts[-1] == (75.0, 22.0)


def test_write_parquet_is_valid_geoparquet(tmp_path):
    pq = pytest.importorskip("pyarrow.parquet")
    store.write_dataset(tmp_path, _spec(), "indore_pilot", _table(), parquet=True)
    path = tmp_path / "demo" / "indore_pilot.parquet"
    t = pq.read_table(path)
    assert t.column_names[:4] == ["digipin", "level", "lat", "lng"]
    assert {"risk", "density", "kind", "bbox", "geometry"} <= set(t.column_names)
    geo = json.loads(t.schema.metadata[b"geo"])
    assert geo["primary_column"] == "geometry"
    col = geo["columns"]["geometry"]
    assert col["encoding"] == "WKB" and col["geometry_types"] == ["Polygon"]
    assert len(col["bbox"]) == 4
    spec = json.loads(t.schema.metadata[b"digipin_cells"])
    assert spec["id"] == "demo"
    assert t.column("level").to_pylist() == [7, 7]


def _many(n_side=100, level=8):
    # A dense block of L8 cells (~61 m) -> well over the shard threshold.
    recs = [{"lat": 22.70 + i * 0.0006, "lng": 75.80 + j * 0.0006, "risk": i, "density": j, "kind": "a"}
            for i in range(n_side) for j in range(n_side)]
    return store.bin_records(recs, level, _spec(level=level).fields)


def test_shard_prefix_len_auto():
    assert store.shard_prefix_len(7, 100) is None
    assert store.shard_prefix_len(7, store.SHARD_THRESHOLD + 1) == 4
    assert store.shard_prefix_len(8, 10**6) == 5


def test_big_regions_are_sharded_and_read_back(tmp_path):
    t = _many()
    assert len(t) > store.SHARD_THRESHOLD
    s = store.write_dataset(tmp_path, _spec(level=8), "r", t, parquet=False)
    assert s["shards"] > 1
    (d,) = json.loads((tmp_path / "catalog.json").read_text())["datasets"]
    (r,) = d["regions"]
    assert r["json"] == "demo/r/{prefix}.json" and r["shards"]["prefixLen"] == 5
    for key in r["shards"]["keys"]:
        part = store.read_json(tmp_path / "demo" / "r" / f"{key}.json")
        assert part.codes and all(c.startswith(key) for c in part.codes)
    back = store.read_region(tmp_path, r)
    assert back.codes == t.codes and back.columns == t.columns
    assert not (tmp_path / "demo" / "r.json").exists()


def test_switching_layout_removes_stale_files(tmp_path):
    store.write_dataset(tmp_path, _spec(level=8), "r", _many(), parquet=False)
    small = store.bin_records([{"lat": 22.72, "lng": 75.85, "risk": 1, "density": 1, "kind": "a"}],
                              8, _spec(level=8).fields)
    s = store.write_dataset(tmp_path, _spec(level=8), "r", small, parquet=False)
    assert s["shards"] == 0
    assert (tmp_path / "demo" / "r.json").exists()
    assert not list((tmp_path / "demo" / "r").glob("*.json"))
    (d,) = json.loads((tmp_path / "catalog.json").read_text())["datasets"]
    assert "shards" not in d["regions"][0]
    # Forcing a prefix length works for small tables too.
    s = store.write_dataset(tmp_path, _spec(level=8), "r", small, parquet=False, shard=3)
    assert s["shards"] == 1
# ── time series ─────────────────────────────────────────────────────────────

def _tspec(**kw):
    from pipeline.cells.schema import TimeSpec
    base = dict(id="lst", title="LST", level=6, fields=[FieldSpec("lst", "LST", unit="°C", ramp="heat")],
                time=TimeSpec("month", ["2025-01", "2025-02", "2025-03"]))
    base.update(kw)
    return DatasetSpec(**base)


def test_series_table_truncates_cleans_and_drops_empty():
    t = store.series_table(6, ["2025-01", "2025-02", "2025-03"], {
        "34PLLMP": {"lst": [30, float("nan"), 32.5]},
        "34PLLM": {"lst": [None, None, None]},          # all-null → dropped
        "34PLLJ": {"lst": [28, 29, None]},
    }, ["lst"])
    assert t.codes == ["34PLLJ", "34PLLM"]
    assert t.times == ["2025-01", "2025-02", "2025-03"]
    assert t.columns["lst"] == [[28.0, 29.0, None], [30.0, None, 32.5]]
    with pytest.raises(ValueError):
        store.series_table(6, ["2025-01"], {"34PLLM": {"lst": [1, 2]}}, ["lst"])


@pytest.mark.parametrize("bad", [
    dict(unit="week"), dict(steps=[]), dict(steps=["2025-02", "2025-01"]),
    dict(steps=["2025-01", "2025-01"]), dict(steps=["2025/01"]), dict(default="2024-12"),
])
def test_validate_rejects_bad_time(bad):
    from pipeline.cells.schema import TimeSpec
    t = dict(unit="month", steps=["2025-01", "2025-02"])
    t.update(bad)
    with pytest.raises(ValueError):
        validate(_tspec(time=TimeSpec(**t)))


def test_temporal_dataset_rejects_category_fields():
    with pytest.raises(ValueError):
        validate(_tspec(fields=[FieldSpec("k", "K", type="category", agg="mode")]))


def test_write_temporal_dataset_json_catalog_and_parquet(tmp_path):
    steps = ["2025-01", "2025-02", "2025-03"]
    t = store.series_table(6, steps, {"34PLLM": {"lst": [30.123456, None, 41]},
                                      "34PLLJ": {"lst": [20, 25, 27]}}, ["lst"])
    with pytest.raises(ValueError):          # table without times for a temporal spec
        store.write_dataset(tmp_path, _tspec(), "x", store.CellTable(6, t.codes, t.columns), parquet=False)
    store.write_dataset(tmp_path, _tspec(), "indore_pilot", t, parquet=False)
    doc = json.loads((tmp_path / "lst" / "indore_pilot.json").read_text())
    assert doc["times"] == steps
    assert doc["columns"]["lst"] == [[20, 25, 27], [30.1235, None, 41]]
    back = store.read_json(tmp_path / "lst" / "indore_pilot.json")
    assert back.times == steps
    (d,) = json.loads((tmp_path / "catalog.json").read_text())["datasets"]
    assert d["time"] == {"unit": "month", "steps": steps, "default": "2025-03"}
    assert d["fields"][0]["domain"] == [20, 41]                 # over every step

    pq = pytest.importorskip("pyarrow.parquet")
    store.write_dataset(tmp_path, _tspec(), "indore_pilot", t, parquet=True)
    tbl = pq.read_table(tmp_path / "lst" / "indore_pilot.parquet")
    assert tbl.column("lst").to_pylist()[1] == [30.123456, None, 41.0]
    assert json.loads(tbl.schema.metadata[b"digipin_cells"])["time"]["steps"] == steps
