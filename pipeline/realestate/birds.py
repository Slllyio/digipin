"""Bird species per ~1 km block from GBIF occurrence records (CC0 and CC BY 4.0 only; mostly eBird and iNaturalist).

Per L6 block (dataset ``birds``):

    records     bird records since 2015 (survey effort)
    species     bird species recorded
    rich200     expected species in 200 records (rarefied richness; only where there are 200 or more records), the
                fair comparison between a birding hotspot and a block visited a few times

One GBIF occurrence search per block, faceted by species (the API needs no key), with records under CC BY-NC left
out. Rarefaction uses the hypergeometric expectation E[S_n] = sum_i 1 - C(N - N_i, n) / C(N, n).

    python -m pipeline.realestate.birds --region bengaluru,pune
"""
from __future__ import annotations

import argparse
import math
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 6
STEP = 36 / 4 ** LEVEL      # DIGIPIN cell size at LEVEL in degrees
API = "https://api.gbif.org/v1/occurrence/search"
AVES = 212
SINCE = 2015
RARE_N = 200
CITIES = ("pune", "mumbai", "bengaluru", "hyderabad", "chennai", "delhi", "jaipur", "ahmedabad", "lucknow", "kolkata", "bhopal", "guna")


def rarefied(counts, n=RARE_N):
    """Expected species among n records drawn without replacement from per-species counts; None when fewer records."""
    total = sum(counts)
    if total < n:
        return None
    lc = lambda a, b: math.lgamma(a + 1) - math.lgamma(b + 1) - math.lgamma(a - b + 1)
    base = lc(total, n)
    return sum(1 - (math.exp(lc(total - k, n) - base) if total - k >= n else 0) for k in counts)


def blocks(bbox):
    """L6 codes whose cells cover the bbox."""
    from pipeline.cells.store import cell_code
    w, s, e, n = bbox
    out, lat = set(), s + STEP / 2
    while lat < n + STEP / 2:
        lng = w + STEP / 2
        while lng < e + STEP / 2:
            c = cell_code(LEVEL, min(lat, n), min(lng, e), None)
            if c:
                out.add(c)
            lng += STEP
        lat += STEP
    return sorted(out)


def query(code, session):
    from pipeline.cells.store import cell_bounds
    b = cell_bounds(code)
    poly = f"POLYGON(({b['west']} {b['south']},{b['east']} {b['south']},{b['east']} {b['north']},{b['west']} {b['north']},{b['west']} {b['south']}))"
    params = [("limit", 0), ("taxonKey", AVES), ("geometry", poly), ("year", f"{SINCE},2100"), ("hasCoordinate", "true"),
              ("hasGeospatialIssue", "false"), ("license", "CC0_1_0"), ("license", "CC_BY_4_0"), ("facet", "speciesKey"), ("facetLimit", 1500)]
    for attempt in range(5):
        try:
            r = session.get(API, params=params, timeout=60)
            if r.status_code == 429 or r.status_code >= 500:
                raise IOError(r.status_code)
            d = r.json()
            counts = [f["count"] for f in (d.get("facets") or [{}])[0].get("counts", [])] if d.get("facets") else []
            return code, d.get("count", 0), counts
        except (IOError, ValueError, OSError):
            time.sleep(2 ** attempt)
    return code, None, None


def fetch(region, workers=8, log=print):
    import requests

    from pipeline._lib.regions import bbox_for
    codes = blocks(bbox_for(region))
    s = requests.Session()
    out, failed = {}, 0
    with ThreadPoolExecutor(workers) as ex:
        for code, n, counts in ex.map(lambda c: query(c, s), codes):
            if n is None:
                failed += 1
            elif n:
                r = rarefied(counts)
                out[code] = {"records": n, "species": len(counts), **({"rich200": round(r, 1)} if r is not None else {})}
    log(f"{region}: {len(codes)} blocks queried, {len(out)} with bird records, {failed} failed")
    if failed > len(codes) * 0.02:
        raise RuntimeError(f"{region}: {failed} GBIF queries failed")
    return out


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("records", f"Bird records since {SINCE} (GBIF, survey effort)", agg="sum", unit="records", ramp="blues", higher_is="better"),
        FieldSpec("species", f"Bird species recorded since {SINCE}", agg="max", unit="species", ramp="greens", higher_is="better"),
        FieldSpec("rich200", f"Bird species expected in {RARE_N} records (rarefied)", agg="mean", unit="species", ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="birds", title="Bird species (GBIF citizen science)", level=LEVEL, fields=specs, group="Environment",
        description=f"Bird records and species per ~1 km block since {SINCE} from GBIF occurrence data under CC0 or CC BY 4.0 "
                    f"(mostly the eBird Observation Dataset and iNaturalist research-grade), with species richness rarefied "
                    f"to {RARE_N} records so heavily and lightly birded blocks compare fairly.",
        source="pipeline/realestate/birds.py (GBIF occurrence search API, faceted by species)",
        license="CC BY 4.0 and CC0 (GBIF.org occurrence data; eBird, iNaturalist and other publishers)", default_field="rich200", extrude=False)
    recs = ({"digipin": c, **v} for c, v in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(CITIES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        info = cell_dataset(r, fetch(r))
        print(f"{r}: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
