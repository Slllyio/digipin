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
- **Auth**: none
- **Update frequency**: continuous (new alerts appear within minutes
  of issuance)
- **Coverage**: nationwide, district-level granularity in the
  free-text area field

### `imd_warnings` — IMD 5-day district color-coded warnings

- **What**: 5-day forward warnings (green / yellow / orange / red)
  for selected Indian districts. Indore is in the default set.
- **Endpoint**: `https://api.imd.gov.in/api/v1/districtwarning?id=<district_id>`
- **Auth**: **required** — `X-API-Key` + `Authorization: Bearer <jwt>`.
  Register at <https://api.imd.gov.in/> (free), then set:
  ```sh
  export IMD_API_KEY=...
  export IMD_API_TOKEN=...
  ```
  Without these the scraper logs a warning, skips, and exits cleanly —
  so the cron keeps refreshing the other sources.
- **Update frequency**: daily (forecast is issued morning + evening)
- **Coverage**: every IMD-listed district; default set in
  `DEFAULT_DISTRICTS` covers Indore + 9 metros. Expand by inspecting
  the dropdowns at <https://mausam.imd.gov.in/>.
- **Stale doc warning**: the public API reference page advertises
  "no auth" but live probing on 2026-05-24 returned `401 API key missing`.
  The docstring captures the discrepancy verbatim.

### `imd_cityforecast` — IMD 7-day city forecast

- **What**: 7-day forecast per city (max/min temp, humidity, rainfall,
  sunrise / sunset, weather description)
- **Endpoint**: `https://api.imd.gov.in/api/v1/cityforecast?id=<city_id>`
- **Auth**: same as `imd_warnings` (`IMD_API_KEY` + `IMD_API_TOKEN`)
- **Update frequency**: 12 hours
- **Coverage**: every IMD-listed city; default set covers Indore +
  major metros. The city IDs come from the dropdown at
  <https://city.imd.gov.in/citywx/city_weather.php> — re-verify them
  after registration since IMD occasionally renumbers.

### `ncs_earthquakes` — National Center for Seismology recent earthquakes

- **What**: 150 most recent earthquakes monitored by India's national
  seismic network (160+ stations). Magnitude / origin time / lat /
  long / depth / region / location / review status
- **URL**: <https://riseq.seismo.gov.in/>
- **Auth**: **none**
- **Update frequency**: continuous; new events appear within minutes
  of detection
- **Coverage**: global, with denser coverage in / around the Indian
  subcontinent. Verified live: 117 of 150 recent events were
  in-or-near India on the test run
- **Implementation note**: scrapes the `<table id="eqdatalist">` from
  the RISEQ HTML. The parent `seismo.gov.in` domain has an SSL legacy
  renegotiation issue that breaks modern clients — RISEQ is on a
  sibling subdomain with a working cert

### `usgs_earthquakes` — USGS global M4.5+ earthquakes (past 24h)

- **What**: every M4.5+ earthquake on the planet in the last 24 hours.
  Complements `ncs_earthquakes` (India-centric, fixed window of 150
  events) with a denser global view filtered to user-relevant magnitudes
- **URL**: <https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson>
- **Auth**: **none**
- **Format**: GeoJSON FeatureCollection
- **Update frequency**: 1 minute
- **Why M4.5 floor**: the `all_day` feed is ~10MB of mostly tiny events;
  M4.5+ is the threshold where the portal actually wants to surface
  the event to a user

### `gdacs_disasters` — GDACS global disaster alerts

- **What**: current global disasters across types — earthquake, tropical
  cyclone, flood, volcano, drought, wildfire — with the international
  alert score (Green/Orange/Red) used by UN-OCHA and the World Bank
- **URL**: <https://www.gdacs.org/xml/rss.xml>
- **Auth**: **none**
- **Format**: RSS 2.0 with GDACS extensions
- **Update frequency**: continuous; alerts appear within minutes of
  trigger
- **Why this matters for DigiPin**: fills the flood-awareness gap (CWC
  is a JS SPA we couldn't scrape — GDACS picks up the same events from
  satellite + ground sensor fusion). Also gives international event
  awareness — a Bay of Bengal cyclone tracked by JTWC appears here
  before reaching IMD's domestic feed

### `imd_nowcast` — IMD district nowcast (next 3 hours)

- **What**: real-time weather category 1-19 per district with color
  severity and consolidated message. Covers the full acute-weather
  spectrum from clear sky through extreme thunderstorms
- **Endpoint**: `https://api.imd.gov.in/api/v1/districtnowcast?id=<district_id>`
- **Auth**: same as `imd_warnings` (`IMD_API_KEY` + `IMD_API_TOKEN`)
- **Update frequency**: every 3 hours (nowcast definition)
- **Districts**: reuses `DEFAULT_DISTRICTS` from `imd_warnings` for
  consistency (Indore + 9 metros)

### `openaq_india` — OpenAQ v3 station-level AQI for India

- **What**: every air-quality monitoring station in India known to
  OpenAQ (typically 300-700 stations, denser than the CPCB-only feed
  we already use). Latest reading per pollutant per station
- **Endpoint**: `https://api.openaq.org/v3/locations?iso=IN`
- **Auth**: **required** — \`X-API-Key\`. Register free at
  <https://explore.openaq.org/register>, then:
  \`\`\`sh
  export OPENAQ_API_KEY=...
  \`\`\`
- **Update frequency**: depends on upstream — CPCB stations update
  hourly; independent monitors vary
- **Why both this and CPCB**: OpenAQ aggregates CPCB *and* independent
  monitors (research, embassies, citizen networks). In Tier 2/3 cities
  where CPCB has 1-2 stations, OpenAQ may expose 5-10 once those
  independents are included

## Adding a new source

1. Create `scrapers/sources/<name>.py` following the convention.
2. Implement `fetch(client)` returning a list of dataclass records.
3. Run `python -m scrapers.cli <name>` to verify.
4. Wire the frontend in `js/realtime-alerts.js` if you want UI
   visibility (optional — the JSONL is useful on its own for analytics).
5. Add a quality contract — see "Data quality" below.

## Data quality

Every snapshot the scrapers commit is validated against a JSON Schema
contract before it's allowed into the portal. This gives us four of the
six [classical data-quality dimensions](https://en.wikipedia.org/wiki/Data_quality)
— completeness, uniqueness, validity, timeliness — at the cost of a
single tiny dep (`jsonschema`).

The framework lives in [`scrapers/lib/quality.py`](lib/quality.py) and
is exercised by [`scrapers/sources/tests/test_snapshot_quality.py`](sources/tests/test_snapshot_quality.py).

### Coverage

| Source | Schema | In SOURCES table |
|---|---|---|
| `ndma_sachet` | ✅ | ✅ |
| `ncs_earthquakes` | ✅ | ✅ |
| `imd_warnings` | TODO | — |
| `imd_cityforecast` | TODO | — |
| `imd_nowcast` | TODO | — |
| `usgs_earthquakes` | TODO | — |
| `gdacs_disasters` | TODO | — |
| `openaq_india` | TODO | — |

### Adding a contract for a source

1. **Draft the schema.** Inspect `data/realtime/<source>/latest.json`
   and write `scrapers/sources/schemas/<source>.schema.json` (Draft
   2020-12). Required fields go in `properties.records.items.required`;
   constrain enums + numeric ranges where the domain supports it.
2. **Declare the source in the test table.** Add a row to `SOURCES` in
   `scrapers/sources/tests/test_snapshot_quality.py`:
   ```python
   SOURCES = [
       ...,
       ("<source>", "id", None),   # (source_id, primary_key, max_staleness_seconds)
   ]
   ```
   `max_staleness_seconds=None` skips timeliness; otherwise the test
   fails if `generated_at_iso` is older than the configured window.
3. **Run the harness.**
   ```sh
   PYTHONIOENCODING=utf-8 python -m pytest scrapers/sources/tests/test_snapshot_quality.py -v
   ```
4. **Fix the snapshot, not the schema.** If validation fails for the
   *real* data, the bug is upstream — either widen the scraper, fix a
   parser, or drop the offending records. Don't loosen the contract
   just to make the test green.

### Reverse coverage

`test_every_schema_has_a_source_row` makes it impossible to ship a
schema file without also declaring the source — guards against the
"I added a schema and forgot to actually validate against it" mistake.

## Politeness rules

- Default 0.6s + jitter between requests. Don't lower below 0.5s.
- User-Agent identifies the scraper and links to the GitHub repo, so
  site operators can reach us.
- Respect `robots.txt` and any rate-limit headers (the scraper does
  exponential backoff on non-200, but does not currently honour
  `Retry-After` — see the `--delay` knob if a site complains).
- Don't bulk-scrape commercial property sites (99acres, MagicBricks)
  — ToS risk and no public license.
