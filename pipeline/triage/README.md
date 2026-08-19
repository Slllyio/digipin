# Alert Triage & Correlation (`pipeline/triage`)

The Tier-2 decision-layer agent from [`docs/AI_AGENTS.md`](../../docs/AI_AGENTS.md) §5.1.

The eight real-time scrapers commit hazard snapshots to `data/realtime/<source>/latest.json`,
but they answer *"what alerts exist across India?"* — not *"which ones matter here?"*.
This module fuses those feeds with the precomputed per-cell score tile (`data/scores/`)
to produce a **ranked situational brief** for a DigiPin region:

```
priority = severity × hazard-relevance × population-exposure
```

It is deterministic and dependency-free (standard library only), so it runs in CI and is
unit-tested with the same discipline as the score pipeline. LLM narration and delivery are
optional add-ons, never required.

## Run

```bash
python -m pipeline.triage                 # default region → data/triage/<region>/{latest.json,brief.md}
python -m pipeline.triage --region pune
python -m pipeline.triage --stdout        # print the Markdown brief, write nothing
```

Region is taken from `--region`, else `DIGIPIN_REGION`, else `indore_pilot`.

## How it works

| Step | File | What |
|------|------|------|
| Normalize | `feeds.py` | Each feed's records → a common `HazardEvent` (hazard vocabulary + 0..1 severity). Empty/key-gated feeds (imd_*, openaq) yield nothing; `imd_cityforecast` is a plain forecast and is skipped. |
| Correlate | `correlate.py` | Geo events (earthquakes, air stations) point-test against the region bbox; name-only events (NDMA/IMD/GDACS) match the region gazetteer (`regionmeta.py`) — place names in the text, an IMD district id in the event id, or a GDACS country. |
| Exposure | `scoretile.py` | Read `data/scores/` shards, decode cell keys with `digipin.decode_partial`, aggregate `population_proxy` / `flood_risk`. Geo hazards use cells within ~6 km; name hazards use the region aggregate. |
| Rank | `triage.py` | `priority` per match, sorted; assembles the result object. |
| Render | `brief.py` | `latest.json` (machine) + `brief.md` (a human situational brief). |

## Extending

- **New pilot city:** add its bbox to `pipeline/_lib/regions.py` and a `RegionMeta` entry
  (place names, IMD district/city ids) to `regionmeta.py`.
- **New feed:** add a normalizer to `feeds.py` `_PARSERS`. Coordinates → geo matching for free;
  text-only feeds need the region's names/ids in `regionmeta.py`.

## Optional delivery

Set `TRIAGE_WEBHOOK_URL` (env / Actions secret) to POST the JSON brief after building.
Unset → skipped cleanly. The scheduled run lives in `.github/workflows/alert-triage.yml`.

## Scope

Advisory only. This drafts and (optionally) notifies; it does **not** actuate city systems —
that trust boundary stays human-gated (see `docs/AI_AGENTS.md` §9).

## Tests

```bash
python -m pytest pipeline/triage/tests -q
```
