# pipeline/ — offline data builds

Python jobs that download, extract and precompute data the app then serves as
static files from `data/`. Nothing here runs in the browser. Run modules from
the repo root with `python -m pipeline.<package>.<module>` so `pipeline._lib`
imports resolve.

| Path | What it builds |
|---|---|
| `_lib/` | Shared helpers: DIGIPIN encode/grid, regions (`regions.py`), IO |
| `scores/` | Precomputed score tiles → `data/scores/` (Python ports pinned to the JS models by golden tests) |
| `cells/` | Per-cell data store and layer registry → `data/cells/` |
| `heat/` | MODIS land-surface-temperature extraction → `data/heat/` |
| `growth/` | Building-change, population and CA growth inputs → `data/growth/` |
| `traffic/` | Structural congestion grid → `data/traffic/` |
| `safety/` | Law and order mobility grid → `data/safety/` |
| `triage/` | Alert triage: ranks real-time alerts against score tiles |
| `buildings/` | Building footprint grid |
| `download_*.py`, `config.py`, `geojson_to_pmtiles.py`, `generate_tethers.py` | Original digital-twin download scripts and the pure-Python PMTiles converter |

Each package keeps its own `requirements.txt` and a `tests/` folder (collected
by the root `pytest.ini`).

Note: `guna-twin-city/pipeline/` holds a diverged copy of the top-level
`download_*.py` scripts for the Guna prototype. Change the one you mean.
