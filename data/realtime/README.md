# `data/realtime/`

Output directory for the real-time scrapers in [`../../scrapers/`](../../scrapers/).
Each source gets its own subdirectory:

```
data/realtime/
├── .gitignore                       # ignores jsonl/csv/seen — only latest.json commits
├── ndma_sachet/
│   └── latest.json                  # current snapshot (committed by CI cron)
└── <other-sources>/
```

`latest.json` is the **only** committed artifact per source — it's small,
overwritten on every run, and what the frontend (`js/realtime-alerts.js`)
reads. The append-only `*.jsonl`, `*.csv`, and `seen_ids.txt` files are
intentionally `.gitignore`d because they grow unbounded under the cron
refresh schedule.

If you want the full historical log, run the scraper locally — those
files are produced alongside `latest.json` but stay out of git.
