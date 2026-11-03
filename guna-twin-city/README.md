# guna-twin-city/ — Guna prototype

A separate digital-twin prototype for Guna (Madhya Pradesh). It is not part of
the main PWA and is not deployed to Pages.

- `index.html` loads its own `js/` plus shared modules from the main app via
  `../js/...`, so this folder has to stay a sibling of the root `js/`.
- `pipeline/` and `js/` contain files with the same names as the main app's
  (`map.js`, `download_vectors.py`, ...). They have diverged and are not
  duplicates.
- `analysis/` and `traffic-analysis/` hold one-off analyses (flood, SUMO
  one-way simulations) with their outputs committed alongside.

Serve the repo root (`python serve.py`) and open `/guna-twin-city/`.
