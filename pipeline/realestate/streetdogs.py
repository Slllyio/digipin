"""Street dogs by ward, Mumbai: BMC's 2024 street dog survey against 2014 (via OpenCity, public domain).

BMC and Humane World for Animals counted roaming dogs along sample street tracks in all 24 administrative wards in
January 2024, as they had in 2014, and noted which were sterilised (ear-notched). The survey estimates about 70,000
roaming dogs, down 22% in density since 2014. Every L7 block in a BMC ward (``wards`` dataset) carries its ward's figures
(dataset ``street_dogs``):

    sd_per_km          dogs counted per km of street, 2024
    sd_per_km_2014     dogs per km of street, 2014
    sd_change_pct      change in density 2014 to 2024 (%)
    sd_sterilised_pct  share of counted dogs sterilised, 2024 (R/N and R/C were reported together)
    sd_roaming         estimated roaming dogs on the ward's streets, 2024
    sd_ward_no         the ward's position in BMC_WARDS (A = 1 ... T = 24)

    python -m pipeline.realestate.streetdogs
"""
from __future__ import annotations

import argparse
import csv
import io
from pathlib import Path

from pipeline.realestate.census2011 import BMC_WARDS

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
B = "https://data.opencity.in/dataset/fe59118d-e545-4af8-be32-8316bc6f4378/resource/"
ROAMING = B + "4ba3e7ef-8ef7-44d9-88d9-75b51780d093/download/mum-ward-roaming-dogs.csv"
STERILISED = B + "1b9637f1-ce06-4874-aff3-8246c47d6f21/download/mum-sterilisation-wards.csv"
CHANGE = B + "c60f6ffe-7e88-4baa-951f-fec8838d15b8/download/mum-ward-wise-incr-dec.csv"


def _f(x):
    try:
        return float(str(x).strip())
    except ValueError:
        return None


def ward_keys(name):
    """BMC ward letters for a survey label: 'FN' -> ('F/N',), 'RC*' -> ('R/C',), 'RN and RC' -> ('R/N', 'R/C')."""
    out = []
    for part in name.replace("Ward ", "").replace("*", "").split(" and "):
        p = part.strip().upper()
        w = f"{p[0]}/{p[1]}" if len(p) == 2 else p
        if w in BMC_WARDS:
            out.append(w)
    return tuple(out)


def wards(roaming, sterilised, change):
    """{ward: fields} from the three survey tables (lists of dict rows)."""
    out = {w: {"sd_ward_no": i + 1} for i, w in enumerate(BMC_WARDS)}
    for r in roaming:
        for w in ward_keys(r.get("Ward_or_Track_ID") or ""):
            out[w].update(sd_per_km=_f(r.get("Dogs_counted_per_km")), sd_roaming=_f(r.get("Total_roaming_dogs")))
    for r in sterilised:
        for w in ward_keys(r.get("Ward_Number") or ""):
            out[w]["sd_sterilised_pct"] = _f(r.get("Percent_Total_Sterilized"))
    for r in change:
        for w in ward_keys(r.get("Ward") or ""):
            out[w].update(sd_per_km_2014=_f(r.get("Dogs_per_km_2014")), sd_change_pct=_f(r.get("Percent_Change")))
    return {w: {k: v for k, v in f.items() if v is not None} for w, f in out.items() if len(f) > 1}


def records(cells, ws):
    for code, w in cells:
        if w in ws:
            yield {"digipin": code, **ws[w]}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("sd_per_km", "Street dogs counted per km of street in the ward, 2024", agg="max", unit="dogs/km", domain=[0, 18], ramp="reds", higher_is="worse"),
        FieldSpec("sd_per_km_2014", "Street dogs per km of street in the ward, 2014", agg="max", unit="dogs/km", domain=[0, 18], ramp="reds", higher_is="worse"),
        FieldSpec("sd_change_pct", "Change in street dog density, 2014 to 2024", agg="max", unit="%", domain=[-70, 40], ramp="reds", higher_is="worse"),
        FieldSpec("sd_sterilised_pct", "Street dogs sterilised in the ward, 2024", agg="max", unit="%", domain=[40, 90], ramp="greens", higher_is="better"),
        FieldSpec("sd_roaming", "Estimated roaming dogs on the ward's streets, 2024", agg="max", unit="dogs", ramp="reds", higher_is=None),
        FieldSpec("sd_ward_no", "BMC ward (A = 1 ... T = 24)", agg="min", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="street_dogs", title="Street dogs by ward (BMC survey 2024 vs 2014)", level=LEVEL, fields=specs, group="Environment",
        description="Roaming dogs per km of street, sterilised share and change since 2014 in each of BMC's 24 wards, from "
                    "the January 2024 street dog survey (BMC with Humane World for Animals, via data.opencity.in); every "
                    "block carries its ward's figures.",
        source="pipeline/realestate/streetdogs.py (BMC street dog survey 2024 via OpenCity)",
        license="Public domain (BMC via data.opencity.in)", default_field="sd_per_km", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def _csv(url):
    import requests
    return list(csv.DictReader(io.StringIO(requests.get(url, timeout=120).content.decode("utf-8-sig"))))


def main(argv=None):
    from pipeline.realestate.census2011 import ward_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="mumbai")
    region = ap.parse_args(argv).region
    ws = wards(_csv(ROAMING), _csv(STERILISED), _csv(CHANGE))
    info = cell_dataset(region, list(records(ward_cells(region), ws)))
    print(f"{region}: {len(ws)} wards, {sum(1 for f in ws.values() if 'sd_per_km' in f)} with 2024 density, "
          f"{sum(1 for f in ws.values() if 'sd_change_pct' in f)} with 2014 change; {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
