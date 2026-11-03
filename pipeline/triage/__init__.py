"""Alert Triage & Correlation — the Tier-2 decision-layer agent.

Fuses the committed real-time hazard feeds (data/realtime/<source>/latest.json)
with the precomputed per-cell score tile (data/scores/) to answer the question
the raw feeds cannot: *which* active hazards actually matter for a DigiPin
region, ranked by severity x hazard-relevance x population exposure.

Pure-Python and deterministic (no heavy deps, no network): it reads committed
JSON, produces a ranked situational brief (JSON + Markdown), and is unit-tested
with the same discipline as the score pipeline. LLM narration and external
delivery are optional add-ons layered on top (see __main__), never required.

See docs/AI_AGENTS.md section 5.1.
"""
