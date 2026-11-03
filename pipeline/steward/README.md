# Pipeline Steward

The supervising agent for DigiPin's self-refreshing data (`docs/AI_AGENTS.md` §5.2).
Deterministic, standard library only (plus optional `jsonschema`).

```sh
python -m pipeline.steward --stdout     # print the health report
python -m pipeline.steward              # write data/steward/{report.json,report.md,state.json}
python -m pipeline.steward --strict     # also exit 1 when anything fails
```

## What it checks

| Check | Severity | Source of truth |
|---|---|---|
| **wiring**: module, schema, CI matrix entry, quality-test row, committed snapshot | warn (fail for a matrix entry with no module) | `scrapers/sources/`, `realtime-scrape.yml`, `test_snapshot_quality.py` |
| **contract**: JSON Schema + primary-key uniqueness | fail | `scrapers/lib/quality.py` |
| **freshness**: `generated_at_iso` vs a per-source window (6h default, 24h for `imd_cityforecast`) | warn when late, fail after 7 days | `checks.STALE_AFTER` |
| **volume**: empty snapshot, or rows fell below half of the last run | fail if it went empty, warn if a keyed source is empty (likely a missing secret) | `data/steward/state.json` |
| **null_rate**: a field's empty share rose by 25 points or more | warn | `data/steward/state.json` |
| **products**: freshness of other scheduled outputs (the triage brief) | as freshness | `steward.PRODUCTS` |

Drift is measured against the previous run's profiles in `data/steward/state.json`, so the
first run only reports absolute problems.

The scheduled workflow (`.github/workflows/pipeline-steward.yml`, every 6h) commits the
report and keeps **one** GitHub issue labelled `pipeline-steward` in sync: created or
updated while anything is `warn`/`fail`, commented on and closed when all checks pass.
Like every scheduled workflow, it only runs from the default branch, which is also where
the scrapers commit their snapshots.

## Onboarding a source

```sh
python -m pipeline.steward scaffold cwc_flood_levels \
    --url https://example.gov.in/feed.json --format json --title "CWC flood levels" \
    --env CWC_API_KEY            # optional REQUIRED_ENV
```

This writes `scrapers/sources/<id>.py` (SOURCE_ID, FEED_URL, a `Record` dataclass with
`csv_fields()`, `fetch(client)`, `key_for()`), a starter `schemas/<id>.schema.json`, and
registers the source in the scrape matrix and the snapshot-quality table. Formats: `json`,
`geojson`, `rss`. Then check the field mapping against a real response, run
`python -m scrapers.cli <id> -v` and `pytest scrapers/sources/tests`, and add the source to
`scrapers/README.md`. The scrapers README's terms-of-service rules still apply.
