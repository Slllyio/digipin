---
name: new-realtime-source
description: Scaffold a new scrapers/sources/<name>.py + frontend module + workflow matrix entry + README section for a DigiPin real-time data source. Follows the established pattern (PoliteClient, dataclass with csv_fields(), fetch(client), key_for(record), env-var auth with graceful skip).
disable-model-invocation: true
---

# `/new-realtime-source` — scaffold a new real-time data source

## Usage

```
/new-realtime-source <source-id> <feed-url> [--auth=none|env|api-key] [--no-frontend]
```

Examples:
```
/new-realtime-source incois_ocean https://incois.gov.in/...   --auth=none
/new-realtime-source mppcb_aqi    https://mppcb.mp.gov.in/... --auth=env
```

## What the skill does

When invoked, follow this checklist exactly. Each step is required unless the user explicitly opts out.

### 1. Pick the right base branch

- The scraper framework lives on `agents/realtime-urban-scrapers` (PR #5). If that branch is merged to `main`, work from `main`. Otherwise stack the new branch on PR #5 or whichever is the latest scraper branch.
- New branch name: `agents/realtime-<source-id>`

### 2. Create `scrapers/sources/<source-id>.py`

Use the template at the end of this file. Customise:
- `SOURCE_ID` to match the filename (without `.py`)
- `FEED_URL` to the live endpoint
- `Record` dataclass with the fields the user wants per row
- `Record.csv_fields()` static method for flat output (required by the CLI)
- `fetch(client)` to do the parsing
- `key_for(record)` to return the dedup identifier

Auth handling:
- `--auth=none`: omit the `_auth_headers()` helper
- `--auth=env`: read two env vars `<SOURCE_ID_UPPER>_API_KEY` and `<SOURCE_ID_UPPER>_API_TOKEN`, skip gracefully with `log.warning(...)` if either is missing
- `--auth=api-key`: single env var `<SOURCE_ID_UPPER>_API_KEY` only

### 3. Run the scraper once locally to verify

```sh
python -m scrapers.cli <source-id> -v
```

Confirm:
- Records are parsed (non-zero count in logs)
- `data/realtime/<source-id>/latest.json` is written
- `data/realtime/<source-id>/alerts.jsonl` accumulates
- For auth-required sources without keys: graceful skip, log shows the warning, latest.json still written (with empty records list)

### 4. Add to the workflow matrix

Edit `.github/workflows/realtime-scrape.yml` — append `<source-id>` to the `matrix.source` list. If the source needs env vars, add them under the step's `env:` block (sourced from `${{ secrets.<KEY_NAME> }}`).

### 5. Append a section to `scrapers/README.md`

Match the existing source sections exactly:
```
### `<source-id>` — <Human description>

- **What**: <one-line summary of the data>
- **URL** or **Endpoint**: <link>
- **Auth**: none / required (KEY1 + KEY2) / API key required
- **Format**: RSS / GeoJSON / JSON / HTML
- **Update frequency**: <how often upstream refreshes>
- **Coverage**: <area + granularity>
- **Why this matters for DigiPin**: <one sentence>
```

### 6. (Optional, unless `--no-frontend`) Frontend module `js/realtime-<source-id>.js`

Create a small client matching the pattern in `js/realtime-alerts.js` / `js/realtime-imd.js`:
- Module-level cache with 5-minute TTL
- `async function getRecords()` reads `data/realtime/<source-id>/latest.json`
- Filter helpers appropriate to the data type
- Attach to `window.Realtime<PascalCase>` global

Add the script tag to `index.html` immediately after the other `realtime-*.js` tags, before `data-fetcher.js`.

### 7. Wire into orchestrator (only if frontend module was added)

In `js/data-fetcher.js`, find the `result.realtime = result.realtime || {};` block and add:
```javascript
if (typeof Realtime<PascalCase> !== 'undefined') {
    try {
        const records = await Realtime<PascalCase>.getRecords();
        result.realtime.<sourceId> = { records, count: records.length };
    } catch { /* skip */ }
}
```

### 8. Commit + push + open PR

Commit message format (no Co-Authored-By footer — globally disabled):
```
feat: add <source-id> as a new real-time source

<one-paragraph why this source matters>

<one-paragraph on the data shape: what records contain, frequency, coverage>

<one-paragraph on auth (none / required) and graceful-skip behavior>

Verified live: <number of records pulled on test run, plus a sample>.
```

PR template: invoke the `/stacked-pr` skill with the parent branch as base.

## Python source template

```python
"""<Source Name> — <one-line description>.

Endpoint: <URL>

<Two or three paragraphs about the source: who publishes it, what
makes it useful for DigiPin, any quirks like SSL issues or rate limits.>

Auth: <none | required>
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.<source_id>")

SOURCE_ID = "<source_id>"
ENDPOINT = "<feed-url>"


@dataclass
class Record:
    id: str
    # ... domain-specific fields
    tags: list[str] = field(default_factory=list)

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id",
            # ... mirror the dataclass field order, omitting internal-only
        ]


def _auth_headers() -> dict[str, str] | None:
    """Only for auth=env or auth=api-key variants. Delete if auth=none."""
    key = os.environ.get("<SOURCE_ID_UPPER>_API_KEY")
    if not key:
        return None
    return {"X-API-Key": key}


def fetch(client: PoliteClient) -> list[Record]:
    headers = _auth_headers()
    if headers is None:
        log.warning(
            "<SOURCE_ID_UPPER>_API_KEY not set — skipping <source_id>. "
            "Register at <registration url> and set the env var."
        )
        return []
    client._session.headers.update(headers)

    body = client.get(ENDPOINT)
    if body is None:
        return []

    # parse body (JSON / XML / HTML — bs4 for HTML, ElementTree for XML)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        log.error("non-JSON response — schema may have changed")
        return []

    records: list[Record] = []
    for raw in payload.get("results", []):
        records.append(Record(
            id=str(raw.get("id", "")),
            # ... populate dataclass fields
        ))
    log.info("<source_id>: parsed %d record(s)", len(records))
    return records


def key_for(record: Record) -> str:
    return record.id
```

## JS frontend module template

```javascript
const Realtime<PascalCase> = (() => {
    const FEED_PATH = 'data/realtime/<source_id>/latest.json';
    const TTL_MS = 5 * 60 * 1000;

    let _cache = null;
    let _fetchedAt = 0;

    async function getRecords() {
        if (_cache && Date.now() - _fetchedAt < TTL_MS) return _cache;
        try {
            const r = await fetch(FEED_PATH, { cache: 'no-store' });
            if (!r.ok) return [];
            const data = await r.json();
            _cache = Array.isArray(data.records) ? data.records : [];
            _fetchedAt = Date.now();
            return _cache;
        } catch { return []; }
    }

    return { getRecords };
})();

if (typeof window !== 'undefined') {
    window.Realtime<PascalCase> = Realtime<PascalCase>;
}
```

## When to update this skill

If the scraper framework's `lib/` or `cli.py` change shape, update the template here. The reviewer agent `scraper-source-reviewer` enforces this template.
