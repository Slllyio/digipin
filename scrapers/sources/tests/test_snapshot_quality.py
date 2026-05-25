"""Data-quality validation for scraper snapshot files.

For every source that has both a JSON Schema (under
scrapers/sources/schemas/) AND a committed snapshot (under
data/realtime/<source>/latest.json), run the full 4-dimension check:
completeness, uniqueness, validity, timeliness.

Adding coverage for a new source is purely declarative:
  1. Drop scrapers/sources/schemas/<source>.schema.json
  2. Add a row to the SOURCES table below

The pytest parametrize then auto-runs the new check.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from scrapers.lib.quality import validate_snapshot

REPO_ROOT = Path(__file__).resolve().parents[3]


# Each row: (source_id, primary_key_field, max_staleness_seconds_or_None)
# max_staleness=None means "don't check timeliness" — appropriate when the
# committed snapshot is stale on purpose (e.g. last manual run, not
# CI-refreshed).
SOURCES = [
    # source              pk     stale-seconds
    ("ndma_sachet",      "id",   None),
    ("ncs_earthquakes",  "id",   None),
    # NOTE: add more sources as schemas land. See scrapers/lib/quality.py
    # docstring for the pattern. New schemas go in scrapers/sources/schemas/.
]


def _snapshot_path(source: str) -> Path:
    return REPO_ROOT / "data" / "realtime" / source / "latest.json"


def _schema_path(source: str) -> Path:
    return REPO_ROOT / "scrapers" / "sources" / "schemas" / f"{source}.schema.json"


@pytest.mark.parametrize("source, primary_key, max_stale", SOURCES)
def test_snapshot_meets_schema_and_invariants(source, primary_key, max_stale):
    snapshot = _snapshot_path(source)
    schema = _schema_path(source)

    # Skip — not fail — if the snapshot file isn't committed. This keeps the
    # test suite green on a fresh clone where the CI cron hasn't run yet.
    if not snapshot.is_file():
        pytest.skip(f"no committed snapshot for {source!r} — CI cron will produce one")

    assert schema.is_file(), (
        f"declared source {source!r} has no schema at {schema}. "
        f"Either add the schema or remove the row from SOURCES."
    )

    result = validate_snapshot(
        snapshot_path=snapshot,
        schema_path=schema,
        primary_key=primary_key,
        max_staleness_seconds=max_stale,
    )
    assert result.passed, result.report()


def test_every_schema_has_a_source_row():
    """Reverse coverage — every schema in the directory must be in SOURCES.

    Catches the 'shipped a schema, forgot to enable validation' case.
    """
    schemas_dir = REPO_ROOT / "scrapers" / "sources" / "schemas"
    if not schemas_dir.is_dir():
        return
    declared = {row[0] for row in SOURCES}
    on_disk = {p.stem.replace(".schema", "") for p in schemas_dir.glob("*.schema.json")}
    missing = on_disk - declared
    assert not missing, (
        f"schemas exist for {missing} but they're not in SOURCES — "
        f"add them so they're actually checked"
    )
