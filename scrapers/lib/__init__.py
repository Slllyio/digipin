"""Shared infrastructure for DigiPin urban real-time scrapers.

`http` — polite Session with retry + jitter, modelled on the Astro_Data scraper.
`storage` — JSONL + CSV writers and a resume-via-seen-ids helper.
"""
