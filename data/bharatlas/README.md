# `data/bharatlas/` — Bharatlas mirror cache

This directory holds locally-cached PMTiles + parquet files from
[bharatlas.com](https://bharatlas.com), the open atlas of India's
curated geospatial layers.

**The actual data files are gitignored** because they total ~1 GB just
for PMTiles. Only the upstream `catalog.json` index, the local
`MANIFEST.json` (which records what was last mirrored), and this
README are committed.

## How to populate this directory

```bash
python pipeline/bharatlas/fetch_all.py
```

This pulls every layer's PMTiles (default ~1 GB) into the canonical
upstream layout — `admin/states/LGD_States.pmtiles`,
`postal/boundaries/Datagov_Pincode_Boundaries.pmtiles`, etc. — and
writes `MANIFEST.json` summarising what was fetched.

Re-runs are idempotent: layers whose local file size matches the
catalog's expected `bytes` (±1 %) are skipped.

See `pipeline/bharatlas/README.md` for full documentation.
