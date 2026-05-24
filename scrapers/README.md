# DigiPin Real-Time Scrapers

Pulls real-time / near-real-time urban data from Indian public sources
that don't have clean REST APIs. Output feeds the DigiPin portal so that
when a user clicks a 4×4m cell, they see live disaster alerts, weather
warnings, and other time-sensitive context alongside the static OSM /
score data.

Pattern adapted from [`Astro_Data/scraper.py`](../../Astro_Data/scraper.py)
(if you have it locally): polite Session with retry + jitter, JSONL
output, resume via `seen_ids.txt`. Generalised across multiple sources.

## Layout

```
scrapers/
├── lib/
│   ├── http.py          # PoliteClient — Session + retry + jitter
│   └── storage.py       # JSONL + CSV writers, seen-ids resume helper
├── sources/
│   ├── ndma_sachet.py   # NDMA SACHET CAP disaster alerts (All India)
│   └── ...              # add one file per new source
├── cli.py               # `python -m scrapers.cli <source>`
└── requirements.txt
```

Each source defines:

| Symbol | Purpose |
|---|---|
| `SOURCE_ID` (str) | filesystem-safe id, used as output dir name |
| `FEED_URL` (str) | feed URL (or build it in `fetch()`) |
| `Alert` / `Record` dataclass | one row's shape, plus `csv_fields()` static method |
| `fetch(client) -> list[Record]` | does the network work, returns parsed records |
| `key_for(record) -> str` | dedup / resume identifier |

## Setup

```sh
python -m venv .venv
source .venv/bin/activate          # or .venv\Scripts\activate on Windows
pip install -r scrapers/requirements.txt
```

## Run

```sh
# Default: writes data/realtime/<source>/{alerts.jsonl,alerts.csv,seen_ids.txt,latest.json}
python -m scrapers.cli ndma_sachet

# Verbose, slower (1s base delay), no latest.json snapshot
python -m scrapers.cli ndma_sachet --delay 1.0 --no-snapshot -v

# For sites with broken SSL (e.g. some state .gov.in portals)
python -m scrapers.cli some_source --insecure
```

## Output

Per source, written to `data/realtime/<source>/`:

- `alerts.jsonl` — append-only full history (one record per line)
- `alerts.csv` — flat mirror for spot-checking
- `seen_ids.txt` — resume marker, re-runs skip already-fetched ids
- `latest.json` — current snapshot, fetched by the frontend at runtime

The frontend (`js/realtime-alerts.js`) reads `latest.json` directly via
HTTP and overlays active alerts on the map / DISHA context.

## Sources

### `ndma_sachet` — NDMA SACHET disaster alerts (All India)

- **What**: thunderstorm, heatwave, flood, cyclone, earthquake alerts
  issued by Indian state meteorological centres and aggregated by NDMA
- **Format**: RSS 2.0 wrapping CAP 1.2 entries
- **URL**: <https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml>
- **Update frequency**: continuous (new alerts appear within minutes
  of issuance)
- **Coverage**: nationwide, district-level granularity in the
  free-text area field

## Adding a new source

1. Create `scrapers/sources/<name>.py` following the convention.
2. Implement `fetch(client)` returning a list of dataclass records.
3. Run `python -m scrapers.cli <name>` to verify.
4. Wire the frontend in `js/realtime-alerts.js` if you want UI
   visibility (optional — the JSONL is useful on its own for analytics).

## Politeness rules

- Default 0.6s + jitter between requests. Don't lower below 0.5s.
- User-Agent identifies the scraper and links to the GitHub repo, so
  site operators can reach us.
- Respect `robots.txt` and any rate-limit headers (the scraper does
  exponential backoff on non-200, but does not currently honour
  `Retry-After` — see the `--delay` knob if a site complains).
- Don't bulk-scrape commercial property sites (99acres, MagicBricks)
  — ToS risk and no public license.
