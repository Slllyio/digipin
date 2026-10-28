"""Tree census per block: every counted tree in Pune (PMC 2019) and Bengaluru (BBMP, July 2026), via OpenCity.

Dataset ``tree_census`` (L7):

    trees          trees counted in the block
    species        distinct species
    top_share      share of the commonest species (%): high means a monoculture
    invasive_pct   share of invasive exotics (subabul, mesquite, earleaf acacia, gliricidia) (%)
    big_trees      trees of 150 cm girth or more (Pune; the canopy and shade they give is out of proportion)
    canopy_m2      crown area from the canopy diameter (Pune)
    poor_pct       trees recorded dead, poor or average (Pune) (%)

Pune's census (about 4 million trees, 17 CSV parts, public domain) records girth, height, canopy and condition;
Bengaluru's ongoing census (KGIS GeoJSON) records species and location only.

    python -m pipeline.realestate.treecensus --region pune,bengaluru
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import tempfile
import time
import zipfile
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PUNE_PKG = "https://data.opencity.in/api/3/action/package_show?id=pune-tree-census-2019"
BLR_ZIP = ("https://data.opencity.in/dataset/9151032e-4423-4697-81a2-e29018a4facd/resource/368572d6-e3dc-4088-acd8-a243c440ebea/"
           "download/bbmp_tree_census_july_2026.zip")
INVASIVE = re.compile(r"leucaena|subabul|prosopis|mesquite|acacia auriculiformis|earleaf|gliricidia|giripushpa", re.IGNORECASE)
BIG_CM = 150
POINT = re.compile(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)")


def species_key(name):
    """Genus and species, lower case: 'Albizia Lebbeck (L.) Benth.' -> 'albizia lebbeck'."""
    w = re.findall(r"[a-z]+", (name or "").lower())
    return " ".join(w[:2]) if w else None


class Acc:
    def __init__(self):
        self.n, self.sp, self.inv, self.big, self.canopy, self.poor, self.cond = 0, Counter(), 0, 0, 0.0, 0, 0

    def add(self, species, name, girth=None, canopy=None, condition=None):
        self.n += 1
        if species:
            self.sp[species] += 1
        if INVASIVE.search(name or ""):
            self.inv += 1
        if girth is not None and girth >= BIG_CM:
            self.big += 1
        if canopy:
            self.canopy += math.pi * (canopy / 2) ** 2
        if condition:
            self.cond += 1
            self.poor += condition.strip().lower() in ("dead", "poor", "average")

    def row(self, detailed):
        r = {"trees": self.n, "species": len(self.sp), "invasive_pct": round(100 * self.inv / self.n, 1)}
        if self.sp:
            r["top_share"] = round(100 * self.sp.most_common(1)[0][1] / sum(self.sp.values()))
        if detailed:
            r["big_trees"] = self.big
            r["canopy_m2"] = round(self.canopy)
            if self.cond:
                r["poor_pct"] = round(100 * self.poor / self.cond, 1)
        return r


def _f(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def pune_rows(lines, accs):
    from pipeline.cells.store import cell_code
    for r in csv.DictReader(lines):
        m = POINT.search(r.get("geom") or "")
        if not m:
            continue
        code = cell_code(LEVEL, float(m.group(2)), float(m.group(1)), None)
        if code is None:
            continue
        name = f"{r.get('botanical_name') or ''} {r.get('common_name') or ''}"
        accs.setdefault(code, Acc()).add(species_key(r.get("botanical_name") or r.get("common_name")), name,
                                         _f(r.get("girth_cm")), _f(r.get("canopy_dia_m")), r.get("condition"))


def fetch_pune(log=print):
    import requests
    accs = {}
    res = [r for r in json.loads(requests.get(PUNE_PKG, timeout=120).text)["result"]["resources"] if r["url"].endswith(".csv")]
    for k, r in enumerate(res, 1):
        # Parts run to ~70 MB and the server drops long streams: land each on disk first, with retries.
        with tempfile.TemporaryDirectory() as tmp:
            dst = os.path.join(tmp, "part.csv")
            for attempt in range(4):
                try:
                    with requests.get(r["url"], stream=True, timeout=600) as resp, open(dst, "wb") as f:
                        resp.raise_for_status()
                        f.writelines(resp.iter_content(1 << 20))
                    break
                except (requests.RequestException, OSError):
                    if attempt == 3:
                        raise
                    time.sleep(2 ** (attempt + 1))
            with open(dst, encoding="utf-8", errors="replace", newline="") as fh:
                pune_rows(fh, accs)
        log(f"pune: part {k}/{len(res)}, {sum(a.n for a in accs.values())} trees so far")
    return accs


def fetch_bengaluru(log=print):
    import requests

    from pipeline.cells.store import cell_code
    dst = Path(tempfile.gettempdir()) / "bbmp_tree_census.zip"
    with requests.get(BLR_ZIP, stream=True, timeout=600) as resp, open(dst, "wb") as f:
        resp.raise_for_status()
        f.writelines(resp.iter_content(1 << 20))
    accs = {}
    with zipfile.ZipFile(dst) as z:
        name = next(n for n in z.namelist() if n.endswith(".geojson"))
        with z.open(name) as fh:
            for line in io.TextIOWrapper(fh, encoding="utf-8"):
                line = line.strip().rstrip(",")
                if not line.startswith('{"type": "Feature"'):
                    continue
                ft = json.loads(line)
                lng, lat = ft["geometry"]["coordinates"][:2]
                code = cell_code(LEVEL, lat, lng, None)
                if code is not None:
                    t = (ft.get("properties") or {}).get("TreeName")
                    accs.setdefault(code, Acc()).add(species_key(t), t)
    log(f"bengaluru: {sum(a.n for a in accs.values())} trees")
    return accs


def cell_dataset(region, accs, detailed):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("trees", "Trees counted (municipal tree census)", agg="sum", unit="trees", ramp="greens", higher_is="better"),
        FieldSpec("species", "Tree species", agg="max", unit="species", ramp="greens", higher_is="better"),
        FieldSpec("top_share", "Share of the commonest species", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("invasive_pct", "Invasive exotic trees (subabul, mesquite, earleaf acacia, gliricidia)", agg="mean", unit="%", domain=[0, 60], ramp="reds", higher_is="worse"),
        FieldSpec("big_trees", "Trees of 150 cm girth or more (Pune)", agg="sum", unit="trees", ramp="greens", higher_is="better"),
        FieldSpec("canopy_m2", "Tree crown area (Pune)", agg="sum", unit="m²", ramp="greens", higher_is="better"),
        FieldSpec("poor_pct", "Trees recorded dead, poor or average (Pune)", agg="mean", unit="%", domain=[0, 30], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="tree_census", title="Municipal tree census (Pune 2019, Bengaluru 2026)", level=LEVEL, fields=specs, group="Environment",
        description="Every tree in the municipal tree census, counted per block: trees, species, the commonest species' "
                    "share, invasive exotics and, for Pune, big trees, crown area and condition. Pune Municipal Corporation "
                    "2019 census (about 4 million trees) and BBMP's ongoing census (July 2026 release), via data.opencity.in.",
        source="pipeline/realestate/treecensus.py (OpenCity tree census files)",
        license="Public domain (PMC and BBMP via data.opencity.in)", default_field="trees", extrude=False)
    recs = ({"digipin": c, **a.row(detailed)} for c, a in accs.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="pune,bengaluru")
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        accs = fetch_pune() if r == "pune" else fetch_bengaluru()
        info = cell_dataset(r, accs, detailed=r == "pune")
        print(f"{r}: {sum(x.n for x in accs.values())} trees in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
