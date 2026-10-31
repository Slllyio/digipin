"""Counted traffic at Bengaluru junctions and cordon roads, 2024: the survey tables in BBMP's traffic infrastructure plan (via OpenCity, public domain).

BBMP's Comprehensive Bengaluru City Traffic Management Infrastructure Plan (final feasibility report, December 2024)
reprints the classified counts its consultants made for the tunnel and grade-separator corridors: turning-volume
counts at 28 junctions on Tumkur Road, JC Road, Hosur Road and Mysore Road and in the north-south tunnel study (peak
hour vehicles and PCUs, morning and evening; daily totals for seven central junctions) and 24-hour counts at nine
cordon points on the roads into the core. These are measured numbers, not modelled ones. The tables were transcribed
by hand into ``JUNCTIONS`` and ``CORDONS``; each site is placed at its OpenStreetMap location (Nominatim, checked by
hand, a few placed by hand from the corridor order). Junctions counted twice (Hudson Circle, Corporation Circle and Town
Hall in both the JC Road and Mysore Road studies) are listed once. Per lived-in L7 block within ``REACH_KM`` of a
counted site (dataset ``junction_counts``):

    jc_peak_veh   vehicles through the nearest counted junction in its busier peak hour
    jc_peak_pcu   the same in passenger car units (consultants' PCU factors; the tunnel study's factors run higher)
    jc_km         distance to that junction
    jc_daily_veh  vehicles a day at the nearest site with a 24-hour count (seven junctions, nine cordon roads)
    jc_2km        counted junctions within 2 km

PCUs are not comparable across the studies (different factor sets), so the lens maps vehicles.

    python -m pipeline.realestate.junctioncounts
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
REACH_KM = 2.0
URL = ("https://data.opencity.in/dataset/2c324650-7caa-40b6-82ef-f99509d5b376/resource/"
       "be5f1ca6-4252-432b-b32a-caa54db69dd6/download/305c1726-cae5-43dc-81c1-c0ae0db22c92.pdf")
# (junction, lat, lng, (am vehicles, am PCUs), (pm vehicles, pm PCUs), daily vehicles or None, plan table)
JUNCTIONS = [
    ("Goraguntepalya junction", 13.0269, 77.5441, (10192, 8229), (11197, 8829), None, 10),
    ("SRS junction, Peenya", 13.0322, 77.5300, (9213, 6141), (9243, 6175), None, 10),
    ("Jalahalli junction", 13.0400, 77.5188, (8434, 6500), (10201, 7982), None, 10),
    ("Hesarghatta Main Road junction (8th Mile)", 13.0450, 77.5077, (7012, 5507), (8645, 6776), None, 10),
    ("Hudson Circle", 12.9671, 77.5882, (12572, 9270), (12697, 9419), None, 44),
    ("Urvashi Theatre junction", 12.9563, 77.5870, (7449, 4935), (7515, 5050), None, 44),
    ("Lalbagh West Gate junction", 12.9483, 77.5800, (13055, 8804), (13141, 8859), None, 44),
    ("Minerva Circle", 12.9552, 77.5800, (12320, 8383), (10793, 7649), None, 44),
    ("Town Hall junction", 12.9636, 77.5845, (12272, 8590), (11593, 8012), None, 44),
    ("Corporation Circle", 12.9667, 77.5880, (10416, 7717), (10285, 7639), None, 44),
    ("Vellara junction", 12.9608, 77.6070, (8015, 5271), (8049, 5224), None, 77),
    ("Adugodi junction", 12.9440, 77.6076, (13081, 8685), (13091, 8729), None, 77),
    ("Forum Mall junction", 12.9350, 77.6122, (11272, 7569), (11393, 7661), None, 77),
    ("Madivala Check Post junction", 12.9325, 77.6153, (12500, 8502), (12617, 8563), None, 77),
    ("St John's Hospital junction", 12.9290, 77.6205, (9276, 6613), (9289, 6436), None, 77),
    ("Madivala Traffic Police junction", 12.9210, 77.6207, (13577, 9360), (15089, 9873), None, 77),
    ("Begur Road junction", 12.9072, 77.6288, (11308, 8186), (11322, 8109), None, 77),
    ("KR Market", 12.9609, 77.5746, (10057, 6664), (10132, 6961), None, 93),
    ("TCM Royan Road junction", 12.9590, 77.5660, (6652, 4746), (7082, 5034), None, 93),
    ("Sirsi Circle", 12.9613, 77.5592, (13433, 9939), (13365, 9880), None, 93),
    ("Old Guddadahalli Road junction", 12.9562, 77.5462, (6702, 4846), (6920, 4911), None, 93),
    ("CNR Rao underpass junction", 13.0128, 77.5759, (13658, 12244), (12599, 11237), 172303, 158),
    ("Bangalore Cantonment junction", 12.9937, 77.5980, (12797, 11267), (12589, 11161), 170379, 158),
    ("Basaveshwara Circle", 12.9846, 77.5883, (15026, 13347), (16817, 15053), 238685, 158),
    ("KR Circle", 12.9757, 77.5872, (13119, 11432), (10901, 9686), 163363, 158),
    ("Cubbon Park UB City signal", 12.9719, 77.5957, (9681, 8351), (10617, 9453), 155057, 158),
    ("Shoolay Circle", 12.9662, 77.6068, (12574, 11160), (11619, 10335), 187462, 158),
    ("Lalbagh Chowk", 12.9541, 77.5857, (7451, 6581), (7925, 7034), 119980, 158),
]
# (cordon road, lat, lng, daily vehicles both ways), plan table 153
CORDONS = [
    ("NH-44 Bellary Road near Sahakar Nagar", 13.0590, 77.5940, 288243),
    ("Outer Ring Road near Nagavara", 13.0412, 77.6204, 222323),
    ("Outer Ring Road near Devinagar BEL Circle", 13.0450, 77.5600, 139793),
    ("Bellary Road near Science Gallery", 13.0256, 77.5846, 246077),
    ("Guttahalli Main Road near Uniworth Plaza", 12.9988, 77.5768, 203804),
    ("NR Road near Silver Jubilee Park", 12.9639, 77.5805, 180589),
    ("Siddapura Road near Maharaja Agrasena Bhavana", 12.9445, 77.5880, 65075),
    ("Marigowda Road near NIMHANS", 12.9375, 77.5941, 108421),
    ("Hosur Road near Madiwala footbridge", 12.9235, 77.6190, 232494),
]


def _km(la, lo, la2, lo2):
    return math.hypot((la - la2) * 110.57, (lo - lo2) * 111.32 * math.cos(math.radians(la)))


def block_rows(cells, junctions=JUNCTIONS, cordons=CORDONS, reach=REACH_KM):
    """{code: fields} for blocks [(code, lat, lng)] within ``reach`` km of a counted junction."""
    daily = [(j[1], j[2], j[5]) for j in junctions if j[5]] + [(c[1], c[2], c[3]) for c in cordons]
    rows = {}
    for code, la, lo in cells:
        d = [(_km(la, lo, j[1], j[2]), j) for j in junctions]
        m, j = min(d, key=lambda x: x[0])
        if m > reach:
            continue
        am, pm = j[3], j[4]
        busy = am if am[0] >= pm[0] else pm
        r = {"jc_peak_veh": busy[0], "jc_peak_pcu": busy[1], "jc_km": round(m, 2), "jc_2km": sum(1 for x, _ in d if x <= 2.0)}
        dd = min(((_km(la, lo, p[0], p[1]), p[2]) for p in daily), key=lambda x: x[0])
        if dd[0] <= reach:
            r["jc_daily_veh"] = dd[1]
        rows[code] = r
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("jc_peak_veh", "Vehicles through the nearest counted junction in its busier peak hour (2024)", agg="mean", unit="vehicles/h", domain=[6000, 17000], ramp="reds", higher_is="worse"),
        FieldSpec("jc_peak_pcu", "Peak hour PCUs at the nearest counted junction (study PCU factors)", agg="mean", unit="PCU/h", ramp="reds", higher_is="worse"),
        FieldSpec("jc_km", "Distance to the nearest counted junction", agg="mean", unit="km", domain=[0, 2], ramp="viridis", higher_is=None),
        FieldSpec("jc_daily_veh", "Vehicles a day at the nearest 24-hour count site", agg="mean", unit="vehicles/day", ramp="reds", higher_is="worse"),
        FieldSpec("jc_2km", "Counted junctions within 2 km", agg="mean", unit="junctions", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="junction_counts", title="Counted traffic at junctions (BBMP traffic plan surveys, 2024)", level=LEVEL, fields=specs,
        group="Mobility",
        description=f"Measured peak hour and daily traffic at {len(JUNCTIONS)} junctions and {len(CORDONS)} cordon roads, from the "
                    "survey tables of BBMP's Comprehensive Bengaluru City Traffic Management Infrastructure Plan (December 2024, "
                    "via data.opencity.in); sites placed at their OpenStreetMap location. Blocks within 2 km of a counted junction.",
        source="pipeline/realestate/junctioncounts.py (BBMP traffic infrastructure plan survey tables 10, 44, 77, 93, 153, 158)",
        license="Public domain (BBMP via data.opencity.in); sites © OpenStreetMap contributors (ODbL)",
        default_field="jc_peak_veh", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    region = ap.parse_args(argv).region
    rows = block_rows(lived_cells(region))
    info = cell_dataset(region, rows)
    print(f"{region}: {len(JUNCTIONS)} junctions, {len(CORDONS)} cordons; {len(rows)} blocks within {REACH_KM} km "
          f"({sum(1 for r in rows.values() if r['jc_peak_veh'] >= 12000)} near a junction over 12,000 vehicles/h); {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
