"""Ground under water in a named flood, from radar: Earth Observatory of Singapore flood proxy maps (via HDX, CC BY 4.0).

The Earth Observatory of Singapore Remote Sensing Lab (EOS-RS, with NASA-JPL as ARIA-SG for older events) maps likely
flooded ground from Copernicus Sentinel-1 radar by comparing an image taken during a flood with images from before;
each pixel is about 30 m. Two events fall on DigiPin cities:

    delhi    12 July 2023, the Yamuna flood (river at a record 208.66 m on 13 July)
    kolkata  22 May 2020, Cyclone Amphan

Per lived-in L7 block, over the ~9 x 9 pixels (about 250 m) around its centre (dataset ``sar_floods``):

    sf_flooded_pct   share of the ground flagged as likely flooded on the event date
    sf_damage_pct    share flagged by the event's damage proxy map (radar change before and after; Amphan only)
    sf_year          year of the event

Radar sees open water well and flooded streets between tall buildings poorly, so built-up blocks are under-counted;
EOS-RS say the maps "may be less reliable over urban and vegetated areas".

    python -m pipeline.realestate.sarfloods --region delhi,kolkata
"""
from __future__ import annotations

import argparse
import io
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
HDX = "https://data.humdata.org/api/3/action/package_show?id="
HALF = 4            # window half-width in pixels (9 x 9, about 250 m)
# region -> damage proxy map ZIP in the same HDX package (Kolkata sits on track P048)
DAMAGE = {"kolkata": "EOS_ARIA-SG_20200522_DPM_India_Bangladesh_Cyclone_Amphan_P048_v0.4.zip"}
# region -> (HDX package, resource name, year, label)
EVENTS = {
    "delhi": ("eos-rs-india-floods-jul-2023", "EOS-RS_20230712_FPM_S1_India_NewDelhi_Floods_v0.9.zip", 2023,
              "Yamuna flood, 12 July 2023"),
    "kolkata": ("eos-rs-india-bangladesh-cyclone-amphan-may-2020", "EOS_ARIA-SG_20200522_FPM_India_Cyclone_Amphan_v0.8.zip", 2020,
                "Cyclone Amphan, 22 May 2020"),
}


def _share(arr, index, la, lo, test, half=HALF):
    r, c = index(lo, la)
    h, w = arr.shape
    if not (half <= r < h - half and half <= c < w - half):
        return None
    return round(100 * float(test(arr[r - half:r + half + 1, c - half:c + half + 1]).mean()))


def block_rows(cells, arr, index, year, half=HALF, damage=None):
    """cells [(code, lat, lng)]; arr 0/1 flood raster; index(lng, lat) -> (row, col); damage (arr, index) optional."""
    rows = {}
    for code, la, lo in cells:
        v = _share(arr, index, la, lo, lambda x: x == 1, half)
        if v is None:
            continue
        rows[code] = {"sf_flooded_pct": v, "sf_year": year}
        if damage is not None:
            d = _share(damage[0], damage[1], la, lo, lambda x: x > 0, half)
            if d is not None:
                rows[code]["sf_damage_pct"] = d
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pkg, _, year, label = EVENTS[region]
    specs = [
        FieldSpec("sf_flooded_pct", "Ground flagged as flooded by radar in the event (share of block)", agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("sf_damage_pct", "Ground flagged by the radar damage proxy map (share of block)", agg="mean", unit="%", domain=[0, 30], ramp="reds", higher_is="worse"),
        FieldSpec("sf_year", "Year of the mapped flood", agg="max", unit="year", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="sar_floods", title="Flooded in a named event (Sentinel-1 radar, EOS-RS)", level=LEVEL, fields=specs, group="Hazards",
        description=f"Share of each block's ground the Earth Observatory of Singapore's Sentinel-1 flood proxy map flags as "
                    f"likely flooded: {label}. About 30 m pixels; less reliable over dense buildings and vegetation.",
        source=f"pipeline/realestate/sarfloods.py (EOS-RS flood proxy map via HDX: {pkg})",
        license="CC BY 4.0 (Earth Observatory of Singapore Remote Sensing Lab; contains modified Copernicus Sentinel data)",
        default_field="sf_flooded_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def _tif(requests, url):
    """Download a ZIP, write its GeoTIFF to a temporary file and return the path."""
    import tempfile
    z = zipfile.ZipFile(io.BytesIO(requests.get(url, timeout=600).content))
    tif = next(n for n in z.namelist() if n.lower().endswith(".tif"))
    f = tempfile.NamedTemporaryFile(suffix=".tif", delete=False)
    f.write(z.read(tif))
    f.close()
    return f.name


def main(argv=None):
    import rasterio
    import requests

    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(EVENTS))
    for region in ap.parse_args(argv).region.split(","):
        pkg, name, year, label = EVENTS[region]
        res = requests.get(HDX + pkg, timeout=60).json()["result"]["resources"]
        url = next(r["url"] for r in res if r["name"] == name)
        damage = None
        if region in DAMAGE:
            with rasterio.open(_tif(requests, next(r["url"] for r in res if r["name"] == DAMAGE[region]))) as dd:
                damage = (dd.read(1), dd.index)
        with rasterio.open(_tif(requests, url)) as ds:
            arr = ds.read(1)
            rows = block_rows(lived_cells(region), arr, ds.index, year, damage=damage)
        info = cell_dataset(region, rows)
        print(f"{region} ({label}): {len(rows)} blocks, {sum(r['sf_flooded_pct'] >= 50 for r in rows.values())} mostly flagged; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
