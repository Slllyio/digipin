# Docs index

Design notes, model write-ups and plans for DigiPin Urban Intelligence. Start
with the top-level [README](../README.md) for what the app is and how to run it,
and [CONTRIBUTING](../CONTRIBUTING.md) for where things live and how to work in
the repo.

## Architecture and data

| Doc | What it covers |
|---|---|
| [DIGITAL_TWIN_ARCHITECTURE.md](DIGITAL_TWIN_ARCHITECTURE.md) | Data formats, tiling and serving choices for the digital twin |
| [CELL_STORE.md](CELL_STORE.md) | Per-DIGIPIN-cell data store (`data/cells/`), layer registry, ingest API |
| [METHODOLOGY.md](METHODOLOGY.md) | How the scores are computed and which sources feed them |
| [ANALYSES.md](ANALYSES.md) | Saved analyses: JSON templates that re-run over any area into a sourced report |

## Score and layer models

| Doc | What it covers |
|---|---|
| [GROWTH_FORECAST.md](GROWTH_FORECAST.md) | Growth Forecast widget (nowcast, 1-2 yr, 5 yr horizons) |
| [CA_GROWTH_MODEL.md](CA_GROWTH_MODEL.md) | Cellular-automata + random-forest growth prediction |
| [FUTURE_GROWTH_DATA.md](FUTURE_GROWTH_DATA.md) | Building-change and future-growth source data, how to regenerate it |
| [TRAFFIC_MODEL.md](TRAFFIC_MODEL.md) | Structural congestion model (no live-traffic API) |
| [MOBILITY_MODEL.md](MOBILITY_MODEL.md) | Law and order mobility / access-resilience layer |
| [REAL_ESTATE_MODEL.md](REAL_ESTATE_MODEL.md) | Live real-estate growth-potential score |
| [UTILITIES_MODEL.md](UTILITIES_MODEL.md) | Per-cell utilities and infrastructure readings |

## Precompute pipeline

| Doc | What it covers |
|---|---|
| [PRECOMPUTE_PLAN.md](PRECOMPUTE_PLAN.md) | National precompute plan (from per-click fetches to precomputed tiles) |
| [PRECOMPUTE_PHASE1.md](PRECOMPUTE_PHASE1.md) | Phase 1 multi-city rollout |

Module-level notes sit next to the code: [`pipeline/`](../pipeline/README.md),
[`pipeline/scores/`](../pipeline/scores/README.md),
[`pipeline/heat/`](../pipeline/heat/README.md),
[`pipeline/growth/`](../pipeline/growth/README.md),
[`pipeline/triage/`](../pipeline/triage/README.md),
[`scrapers/`](../scrapers/README.md), [`proxy/`](../proxy/README.md).

## AI and research

| Doc | What it covers |
|---|---|
| [AI_AGENTS.md](AI_AGENTS.md) | AI agent research and implementation plan (DISHA analyst, alert triage) |
| [RESEARCH_INTEGRATION.md](RESEARCH_INTEGRATION.md) | Research survey that shaped the portal |

## Archive

[`archive/`](archive/) holds finished session handoffs and superseded notes,
kept for history. Nothing in it describes the current state.

## Adding a doc

Put cross-cutting docs here as `UPPER_SNAKE_CASE.md` and add a row to this
index. Notes that only concern one module go in a `README.md` inside that
module's folder instead.
