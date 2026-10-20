# Saved analyses and reports

An **analysis** is a JSON template that re-runs over any area and produces a
**report** with its sources attached. Everything runs in the browser over the
per-cell data store ([CELL_STORE.md](CELL_STORE.md)); there is no server.

- `js/analysis.js`: pure engine (validate, run, report HTML, share links), unit-tested in `tests/analysis.test.js`.
- `js/analyses-panel.js`: toolbar **Analyses** panel, editor, report dialog, recent reports.

## Template (`digipin.analysis/1`)

```json
{
  "title": "Family home finder",
  "description": "What the analysis answers",
  "sections": [
    { "type": "index", "title": "Family-fit index", "limit": 10, "terms": [
      { "dataset": "scores", "field": "livability", "weight": 3 },
      { "dataset": "scores", "field": "flood_risk", "weight": 2 },
      { "dataset": "traffic", "field": "congestion_risk", "weight": 1 } ] },
    { "type": "filter", "dataset": "scores", "where": [{ "field": "flood_risk", "op": "<=", "value": 40 }] },
    { "type": "summary", "dataset": "scores", "fields": ["livability", "flood_risk"] },
    { "type": "rank", "dataset": "scores", "field": "livability", "order": "desc", "limit": 5 },
    { "type": "distribution", "dataset": "traffic", "field": "worst_los" }
  ]
}
```

| Section | Output |
|---|---|
| `summary` | mean / min / max / cell count per field |
| `index` | weighted 0–100 score per cell; fields with `higherIs: "worse"` are inverted; terms at different levels join on the DIGIPIN prefix (finer cells are averaged into their parent) |
| `rank` | top cells by one field |
| `filter` | cells meeting every rule (`> >= < <= == != in`), with count and share |
| `distribution` | histogram (numbers) or counts (categories) |

## Areas

A DIGIPIN prefix (`34P-LL5`, 5 chars ≈ 4 km, 6 ≈ 1 km, 7 ≈ 250 m) or the map
view (a bbox; cells are picked by centre). A dataset coarser than the area
reports the one cell that contains it, with a warning.

## Report (`digipin.report/1`)

`{ schema, analysis, template, ranAt, area, highlights[], sections[], sources[], map:{ link, layer }, warnings[] }`.
Each section lists its `sources`; each source card carries the dataset's
title, level, cell count in the area, builder script and licence. The report
downloads as standalone HTML (no scripts, map PNG or SVG cell map inline) or JSON.

## Sharing

`app.html?analysis=<builtin-id>&area=p:<code>` (or `area=b:w,s,e,n`) re-runs on
open. A custom template travels inline as `analysis_def=<base64url JSON>`, so
the link works for someone who never saved it. Templates export and import as
`.analysis.json` files; saved ones live in `localStorage` (`digipin_analyses`).
