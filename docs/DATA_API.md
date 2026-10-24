# DigiPin open data API (static files)

Everything the app maps is plain static JSON under `data/cells/`, served by the same host as the app (and by GitHub). There is no server to call: read the catalog, pick a dataset and region, and fetch one file.

## 1. Find datasets: `data/cells/catalog.json`

Each entry has `id`, `title`, `description`, `source`, `license`, `level` (DIGIPIN level of its cells), `fields` (key, label, unit, agg, domain) and `regions` (name, bbox, cell count, file path). The full schema is in [CELL_STORE.md](CELL_STORE.md).

## 2. Find the cell

A DIGIPIN code's prefix is its parent cell, so a full 10-character address `39J-4M9-8PLC` sits in L7 block `39J4M98`, L6 `39J4M9` and L5 `39J4M`. For a dataset at level L, use the first L characters (dashes removed).

## 3. Fetch the region file

`regions[].json` is either a single file (`power_lines/delhi.json`, or `.json.gz` for big tables) or, for big cities, a template such as `places/bengaluru/{prefix}.json.gz` with `regions[].shards = {"prefixLen": 4, "keys": ["4P33", …]}`: put the first `prefixLen` characters of the code in `{prefix}`. Each file is columnar:

```json
{ "dataset": "power_lines", "region": "delhi", "level": 7,
  "fields": ["line_km", "corridor_pct", "max_kv", "substations"],
  "cells": ["39J2322", "39J2323"],
  "columns": { "line_km": [0.21, 0.0], "corridor_pct": [12.5, 0.0], "max_kv": [220, null], "substations": [0, 1] } }
```

Rows are sparse (only cells with data) and sorted by code, so a lookup is a binary search on `cells`. In gzipped files some numeric columns are stored as integers with a `scale` map (value = integer × scale); `pipeline/cells/store.py` (`read_region`) and `js/cell-store.js` undo it.

## 4. Or ask for everything at one place

```
python -m pipeline.cells.lookup 39J-4M9-8PLC          # every dataset, each at its own level
python -m pipeline.cells.lookup --lat 28.567 --lng 77.21 --json
```

In the browser, `CellStore` does the same (`CellStore.init()`, then `CellStore.load(id, region)`).

## Licences

Each dataset carries its own `license` in the catalog (ODbL for OpenStreetMap/Overture-derived data, CC BY for most satellite products, CC0 for Wikidata). Attribute the sources listed there when you reuse the data.
