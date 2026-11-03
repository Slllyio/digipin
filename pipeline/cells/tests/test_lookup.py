import json

from pipeline.cells import lookup, store
from pipeline.cells.schema import DatasetSpec, FieldSpec


def test_lookup_reads_each_dataset_at_its_level(tmp_path):
    code7 = store.cell_code(7, 28.6, 77.2)
    specs = [FieldSpec("x", "X", agg="mean", unit="u")]
    spec = DatasetSpec(id="demo", title="Demo", level=7, fields=specs, group="Test", description="d", source="s", license="CC0",
                       default_field="x")
    store.write_dataset(tmp_path, spec, "delhi", store.bin_records([{"digipin": code7, "x": 3.5}], 7, specs), parquet=False)
    code10 = store.cell_code(10, 28.6, 77.2)
    res = lookup.lookup(code10, tmp_path)
    assert res["demo"]["code"] == code7
    assert res["demo"]["values"] == {"x": 3.5}
    assert json.loads((tmp_path / "catalog.json").read_text())["datasets"][0]["id"] == "demo"
    assert lookup.lookup(store.cell_code(10, 19.0, 72.8), tmp_path) == {}
