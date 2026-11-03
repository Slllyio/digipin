"""Lightning flash density per block from the NASA LIS/OTD climatology.

The LIS/OTD 0.5° High Resolution Flash Climatology (Cecil et al. 2014, V2.3.2015) gives
the mean total flash rate from 1995–2014 satellite lightning sensors. Per L6 block
(dataset ``lightning``), interpolated bilinearly to the block centre:

    flash_rate      total flashes (in-cloud and cloud-to-ground) per km² per year
    cg_rate         estimated cloud-to-ground strikes per km² per year, using the
                    Prentice & Mackerras (1977) latitude rule for the ground share

The file sits behind NASA Earthdata login. Set EARTHDATA_TOKEN (a bearer token from
urs.earthdata.nasa.gov) or pass --file with a local copy. It is a fixed climatology, so
one bake is enough.

    python -m pipeline.safety.lightning --region all
"""
from __future__ import annotations

import argparse
import json
import math
import os
import urllib.request
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 6
URL = "https://data.ghrc.earthdata.nasa.gov/ghrcw-protected/lohrfc__2.3.2015/LISOTD_HRFC_V2.3.2015.nc"


def cg_fraction(lat):
    """Share of flashes that strike the ground: 1 / (1 + Z), Z = 4.16 + 2.16 cos(3 × latitude)."""
    z = 4.16 + 2.16 * math.cos(math.radians(3 * lat))
    return 1 / (1 + z)


def bilinear(grid, lats, lons, lat, lon):
    """Bilinear value at (lat, lon) on a regular grid of cell centres, ignoring missing (≤ 0) corners."""
    dlat, dlon = lats[1] - lats[0], lons[1] - lons[0]
    fi, fj = (lat - lats[0]) / dlat, (lon - lons[0]) / dlon
    i0, j0 = max(0, min(len(lats) - 2, math.floor(fi))), max(0, min(len(lons) - 2, math.floor(fj)))
    ti, tj = min(1.0, max(0.0, fi - i0)), min(1.0, max(0.0, fj - j0))
    acc = wsum = 0.0
    for di, wi in ((0, 1 - ti), (1, ti)):
        for dj, wj in ((0, 1 - tj), (1, tj)):
            v = float(grid[i0 + di][j0 + dj])
            if v > 0 and wi * wj > 0:
                acc += v * wi * wj
                wsum += wi * wj
    return acc / wsum if wsum else None


def download(dest):
    req = urllib.request.Request(URL)
    tok = os.environ.get("EARTHDATA_TOKEN")
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    with urllib.request.urlopen(req, timeout=300) as r:
        dest.write_bytes(r.read())
    return dest


def load(path):
    import h5py
    f = h5py.File(path, "r")
    return {
        "lat": f["Latitude"][:].tolist(), "lon": f["Longitude"][:].tolist(), "fr": f["HRFC_COM_FR"][:]}


def rows_for(region, clim):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next((r for r in pop["regions"] if r["name"] == region), None)
    if entry is None:
        return []
    rows = []
    for code in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(code)
        lat, lon = (b["south"] + b["north"]) / 2, (b["west"] + b["east"]) / 2
        fr = bilinear(clim["fr"], clim["lat"], clim["lon"], lat, lon)
        if fr is None:
            continue
        rows.append({"digipin": code, "flash_rate": round(fr, 2), "cg_rate": round(fr * cg_fraction(lat), 2)})
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("flash_rate", "Lightning flashes per km² per year (all types)", agg="mean", unit="flashes/km²/yr", domain=[0, 40],
                  ramp="heat", higher_is="worse"),
        FieldSpec("cg_rate", "Estimated ground strikes per km² per year", agg="mean", unit="strikes/km²/yr", domain=[0, 8],
                  ramp="heat", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="lightning", title="Lightning (NASA LIS/OTD)", level=LEVEL, fields=specs, group="Hazards",
        description="NASA LIS/OTD 0.5° High Resolution Flash Climatology (Cecil et al. 2014), the 1995–2014 mean of total "
                    "lightning seen from orbit, interpolated to each block. Ground strikes use the Prentice & Mackerras (1977) "
                    "latitude rule for the cloud-to-ground share (about 15–19% across India). The grid is about 55 km, so "
                    "this shows the regional lightning climate, not differences between neighbouring streets.",
        source="pipeline/safety/lightning.py (NASA GHRC DAAC, LISOTD_HRFC_V2.3.2015)",
        license="NASA open data (no restrictions)", default_field="cg_rate", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    p.add_argument("--file", type=Path, help="local LISOTD_HRFC_V2.3.2015.nc (downloaded when absent)")
    a = p.parse_args(argv)
    path = a.file or Path(os.environ.get("TMPDIR", "/tmp")) / "LISOTD_HRFC_V2.3.2015.nc"
    if not path.exists():
        download(path)
    clim = load(path)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = rows_for(r, clim)
        if rows:
            mean = sum(x["cg_rate"] for x in rows) / len(rows)
            print(f"{r}: {len(rows)} blocks, {mean:.1f} ground strikes/km²/yr")
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
