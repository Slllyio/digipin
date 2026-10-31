"""Who puts soot into the air around a block: EDGAR 2025 1 km emission grids for 2024 (European Commission JRC, CC BY 4.0).

EDGAR (Emissions Database for Global Atmospheric Research) is the JRC's global emission inventory. Its 2025 release has
1 km grids (0.01 degree) of the tonnes of fine particles (PM2.5) and nitrogen oxides (NOx) emitted in 2024, split into
sectors: industry, residential (cooking and heating fuel in homes, mostly wood, dung and kerosene in India),
transport (road vehicle exhaust), energy (power plants), agriculture and international (shipping and aviation), plus waste for NOx. It is a
modelled inventory: national fuel and activity totals are spread over the map with point-source lists, population, roads
and land use, so a pixel is an estimate, not a measurement. It counts what chimneys, stoves and tailpipes emit; road
dust, construction dust and secondary particles formed in the air are not in it, so it is not a source apportionment of
the air people breathe. In Indian cities industry and homes dominate EDGAR's direct PM2.5; vehicles show up in NOx.

Per lived-in L7 block, over the 1 km pixels whose centre lies within ``REACH_KM`` (dataset ``emission_sources``):

    es_pm25_t         tonnes of PM2.5 emitted a year within ``REACH_KM``
    es_industry_pct   industry's share of that PM2.5
    es_homes_pct      residential (household fuel) share
    es_power_pct      power plants' share
    es_traffic_pct    road transport's share
    es_nox_t          tonnes of NOx emitted a year within ``REACH_KM``
    es_nox_traffic_pct  road transport's share of that NOx
    es_pm25_pctile    where es_pm25_t sits among the city's blocks (0-100)

    python -m pipeline.realestate.emissionsources --dir folder_with_the_unzipped_tifs
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
REACH_KM = 2.0
BASE = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/EDGAR/datasets/EDGAR_2025_1km/"
YEAR = 2024
SECTORS = ("Industry", "Residential", "Transport", "Energy", "Agriculture", "International", "Waste")
SHARE = {"es_industry_pct": "Industry", "es_homes_pct": "Residential", "es_power_pct": "Energy", "es_traffic_pct": "Transport"}


def kernel(lat, reach=REACH_KM, step=0.01):
    """Pixel offsets (dy, dx) whose centres lie within ``reach`` km of a pixel centre at this latitude."""
    ky, kx = 110.57 * step, 111.32 * step * math.cos(math.radians(lat))
    ny, nx = int(reach // ky) + 1, int(reach // kx) + 1
    return [(dy, dx) for dy in range(-ny, ny + 1) for dx in range(-nx, nx + 1) if math.hypot(dy * ky, dx * kx) <= reach]


def disk_sum(a, offs):
    """Sum of ``a`` over the offsets around every pixel (zero outside the array)."""
    import numpy as np
    out = np.zeros_like(a, dtype="float64")
    h, w = a.shape
    for dy, dx in offs:
        ys, yd = (slice(dy, h), slice(0, h - dy)) if dy >= 0 else (slice(0, h + dy), slice(-dy, h))
        xs, xd = (slice(dx, w), slice(0, w - dx)) if dx >= 0 else (slice(0, w + dx), slice(-dx, w))
        out[yd, xd] += a[ys, xs]
    return out


def percentile_ranks(values):
    """{key: 0-100 rank} (share of the other values at or below each one)."""
    keys = sorted(values, key=lambda k: values[k])
    n = len(keys)
    if n < 2:
        return {k: 50 for k in keys}
    out, i = {}, 0
    while i < n:
        j = i
        while j + 1 < n and values[keys[j + 1]] == values[keys[i]]:
            j += 1
        for k in keys[i:j + 1]:
            out[k] = round(100 * j / (n - 1))
        i = j + 1
    return out


def block_rows(cells, grids, transform, reach=REACH_KM):
    """cells [(code, lat, lng)]; grids {'pm25'|'nox': {sector: 2-D array}} on one window with ``transform`` (rasterio Affine)."""
    if not cells:
        return {}
    lat = sum(c[1] for c in cells) / len(cells)
    offs = kernel(lat, reach, abs(transform.a))
    near = {g: {s: disk_sum(a, offs) for s, a in by.items()} for g, by in grids.items()}
    inv = ~transform
    rows = {}
    for code, la, lo in cells:
        x, y = inv * (lo, la)
        y, x = int(y), int(x)
        pm = {s: float(a[y, x]) for s, a in near["pm25"].items()}
        tot = sum(pm.values())
        if tot <= 0:
            continue
        row = {"es_pm25_t": round(tot, 1)}
        for k, s in SHARE.items():
            row[k] = round(100 * pm.get(s, 0) / tot)
        if "nox" in near:
            nx = {s: float(a[y, x]) for s, a in near["nox"].items()}
            nt = sum(nx.values())
            if nt > 0:
                row["es_nox_t"] = round(nt, 1)
                row["es_nox_traffic_pct"] = round(100 * nx.get("Transport", 0) / nt)
        rows[code] = row
    for code, p in percentile_ranks({c: r["es_pm25_t"] for c, r in rows.items()}).items():
        rows[code]["es_pm25_pctile"] = p
    return rows


def read_grids(folder, cells, margin=0.05):
    import rasterio
    la0, la1 = min(c[1] for c in cells) - margin, max(c[1] for c in cells) + margin
    lo0, lo1 = min(c[2] for c in cells) - margin, max(c[2] for c in cells) + margin
    grids, transform = {}, None
    for gas, tag in (("pm25", "PM2.5"), ("nox", "NOx")):
        for s in SECTORS:
            p = Path(folder) / f"{tag}_{YEAR}_{s}.tif"
            if not p.exists():
                continue
            with rasterio.open(p) as r:
                w = r.window(lo0, la0, lo1, la1).round_offsets().round_lengths()
                grids.setdefault(gas, {})[s] = r.read(1, window=w).astype("float64")
                transform = r.window_transform(w)
    return grids, transform


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pct = lambda k, label: FieldSpec(k, label, agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is=None)
    specs = [
        FieldSpec("es_pm25_t", "PM2.5 emitted within 2 km a year (EDGAR 2024)", agg="mean", unit="t/yr", ramp="reds", higher_is="worse"),
        pct("es_industry_pct", "Industry's share of the PM2.5 emitted within 2 km"),
        pct("es_homes_pct", "Household fuel's share of the PM2.5 emitted within 2 km"),
        pct("es_power_pct", "Power plants' share of the PM2.5 emitted within 2 km"),
        pct("es_traffic_pct", "Vehicle exhaust's share of the PM2.5 emitted within 2 km"),
        FieldSpec("es_nox_t", "NOx emitted within 2 km a year (EDGAR 2024)", agg="mean", unit="t/yr", ramp="reds", higher_is="worse"),
        pct("es_nox_traffic_pct", "Vehicle exhaust's share of the NOx emitted within 2 km"),
        FieldSpec("es_pm25_pctile", "PM2.5 emitted nearby, rank among the city's blocks", agg="mean", unit="percentile", domain=[0, 100], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="emission_sources", title="Who emits the soot nearby (EDGAR 2025, 1 km)", level=LEVEL, fields=specs, group="Environment",
        description="Tonnes of PM2.5 and NOx emitted in 2024 within 2 km of each block and the share from industry, household fuel, "
                    "power plants and vehicle exhaust, from the European Commission JRC's EDGAR 2025 1 km emission grids. A modelled "
                    "inventory of direct emissions: road and construction dust and particles formed in the air are not included.",
        source="pipeline/realestate/emissionsources.py (EDGAR_2025_1km PM2.5 and NOx, 2024)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, EDGAR 2025, edgar.jrc.ec.europa.eu/dataset_ghg2025)",
        default_field="es_pm25_t", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def download(folder):
    import io
    import zipfile

    import requests
    for tag in ("PM2.5", "NOx"):
        r = requests.get(f"{BASE}{tag}/EDGAR_2025_1km_{tag}_{YEAR}.zip", timeout=3600)
        r.raise_for_status()
        zipfile.ZipFile(io.BytesIO(r.content)).extractall(folder)


def main(argv=None):
    import json

    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", required=True, help="folder with the unzipped EDGAR 1 km tifs (downloaded there if missing)")
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    if not any(Path(a.dir).glob("PM2.5_*_Industry.tif")):
        download(a.dir)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        cells = lived_cells(region)
        grids, transform = read_grids(a.dir, cells)
        rows = block_rows(cells, grids, transform)
        info = cell_dataset(region, rows)
        vals = sorted(r["es_pm25_t"] for r in rows.values())
        ind = sum(1 for r in rows.values() if r["es_industry_pct"] >= 50)
        print(f"{region}: {len(rows)} blocks, median PM2.5 within 2 km {vals[len(vals) // 2]} t/yr, "
              f"{ind} blocks industry-led; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
