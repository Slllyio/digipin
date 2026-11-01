"""Who lived here in 1975? Residents per block in each GHSL epoch since 1975, from the JRC Global Human Settlement Layer
GHS-POP R2023A (100 m, via Earth Engine ``JRC/GHSL/P2023A/GHS_POP/<year>``; CC BY 4.0).

The existing ``population`` dataset carries 2020 residents (calibrated in six cities) and 2000-2020 growth. This adds the
long view at L7 (dataset ``pop_history``):

    pop_1975 / pop_1990 / pop_2000 / pop_2010 / pop_2020   GHSL residents in the block (raw, uncalibrated)
    empty_1975        1 if the block had under 300 people per km² in 1975 (fields, villages, scrub), else 0
    boom_period       the epoch gap that added the most residents per year: 1 = 1975-90, 2 = 1990-2000, 3 = 2000-10, 4 = 2010-20

GHSL back-casts older epochs from Landsat built-up area and census totals, so 1975 densities inside old cores are
smoothed; read single blocks with care and districts with more confidence.

    python -m pipeline.realestate.popsince1975 --region delhi
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
YEARS = (1975, 1990, 2000, 2010, 2020)
EMPTY_KM2 = 300


def row_from(dens, area_km2):
    """dens {year: people/km² or None}, block area -> row, or None when 2020 is missing."""
    if dens.get(2020) is None:
        return None
    pop = {y: (dens[y] or 0) * area_km2 for y in YEARS}
    gains = [(pop[b] - pop[a]) / (b - a) for a, b in zip(YEARS, YEARS[1:])]  # per year: the first gap is 15 years
    row = {f"pop_{y}": round(pop[y]) for y in YEARS}
    row["empty_1975"] = 1 if (dens.get(1975) or 0) < EMPTY_KM2 else 0
    if max(gains) > 0:
        row["boom_period"] = gains.index(max(gains)) + 1
    return row


def fetch(region):
    from pipeline.cells import earthengine as gee
    from pipeline.cells import ee_layers as el
    from pipeline.realestate.powerplants import lived_cells
    ee = gee.init()
    _, bbox = el._bbox(region)
    img = ee.Image.cat([ee.Image(f"JRC/GHSL/P2023A/GHS_POP/{y}").divide(ee.Image.pixelArea().divide(1e6)).rename(f"d{y}")
                        for y in YEARS])
    raw = gee.fetch(gee.to_cells(img, 100), bbox, LEVEL)
    lived = {c for c, _, _ in lived_cells(region)}
    out = {}
    for code, v in raw.items():
        if code not in lived:
            continue
        r = row_from({y: v.get(f"d{y}") for y in YEARS}, gee.cell_area_km2(code))
        if r:
            out[code] = r
    return out


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec(f"pop_{y}", f"Residents {y} (GHSL, uncalibrated)", agg="sum", unit="people", ramp="viridis") for y in YEARS]
    specs += [
        FieldSpec("empty_1975", "Almost empty in 1975 (under 300 people/km²)", agg="mean", unit="share", domain=[0, 1], ramp="viridis"),
        FieldSpec("boom_period", "Period that added the most residents (1 = 1975-90 … 4 = 2010-20)", agg="mode", unit="period", domain=[1, 4], ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="pop_history", title="Residents since 1975 (GHSL GHS-POP epochs)", level=LEVEL, fields=specs, group="Real estate",
        description="JRC GHS-POP R2023A residents per lived-in block in 1975, 1990, 2000, 2010 and 2020 (100 m, back-cast from "
                    "Landsat built-up area and census totals), whether the block was almost empty in 1975, and which period added "
                    "the most people.",
        source="pipeline/realestate/popsince1975.py (JRC/GHSL/P2023A/GHS_POP via Earth Engine)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, GHS-POP R2023A, doi:10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE)",
        default_field="boom_period", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        rows = fetch(region)
        if not rows:
            print(f"{region}: none")
            continue
        info = cell_dataset(region, rows)
        p75, p20 = sum(r["pop_1975"] for r in rows.values()), sum(r["pop_2020"] for r in rows.values())
        empty = sum(r["pop_2020"] for r in rows.values() if r["empty_1975"])
        print(f"{region}: {len(rows)} blocks, {p75 / 1e5:.1f} lakh in 1975 -> {p20 / 1e5:.1f} lakh in 2020; "
              f"{100 * empty / max(p20, 1):.0f}% now live in blocks almost empty in 1975; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
