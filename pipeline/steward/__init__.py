"""Pipeline Steward — supervises DigiPin's self-refreshing data (docs/AI_AGENTS.md §5.2).

Deterministic, stdlib-only core: inventory the scraper sources and their
wiring, re-run the snapshot quality contracts, check freshness, and detect
drift (row count / null rate) against the previous run's profile. Output is a
health report (JSON + Markdown) that CI commits and mirrors into one GitHub
issue. ``python -m pipeline.steward scaffold`` generates a new conforming
source.
"""
