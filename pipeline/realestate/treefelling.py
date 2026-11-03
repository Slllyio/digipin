"""Trees approved for felling near each block: Bengaluru Forest Department public notices (via OpenCity, public domain).

OpenCity's "Tree cutting in Bengaluru" collection holds the Forest Department's public notices and orders for felling
trees for metro, suburban rail, road, defence and public-building projects. Each notice gives the number of trees and
the project; the notices have no coordinates, so each project is placed by hand at its site, or at points along its
alignment for metro, rail, road and power lines (trees shared equally between the points). Places come from
OpenStreetMap (Nominatim) and the project descriptions; two notices whose sites could not be found are left out.

Per lived-in L7 block in Bengaluru (dataset ``tree_felling``):

    tf_trees_2km      trees in felling notices within 2 km
    tf_notices_2km    notices with a site or alignment point within 2 km
    tf_km             distance to the nearest notice point
    tf_trees_nearest  trees in that nearest notice
    tf_kind_nearest   its kind (1 metro, 2 suburban or main-line rail, 3 road, 4 defence, 5 public building or campus,
                      6 drain, power line or plant)

    python -m pipeline.realestate.treefelling
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NEAR_KM = 2.0
KINDS = ["", "metro", "rail", "road", "defence", "public building or campus", "drain, power line or plant"]
# (trees, project, kind, [(lat, lng), ...]) from the notice titles and descriptions. The BMRCL Phase 3 Corridor 1
# Package 1 public notice (2,174 trees) is left out: its official memorandum (2,184 trees) covers the same stretch.
NOTICES = [
    (58, "Cauvery Theatre junction to Mekhri Circle road widening", 3, [(13.0034, 77.5840), (13.0146, 77.5853)]),
    (140, "Uttarahalli-Manavarthe Kaval depot", 5, [(12.8900, 77.5050)]),
    (253, "BMRCL Reach 6 (Pink line)", 1, [(12.9370, 77.6020), (12.9850, 77.6050), (13.0100, 77.6150), (13.0400, 77.6230)]),
    (343, "BMRCL Reach 6 (Pink line)", 1, [(12.9370, 77.6020), (12.9850, 77.6050), (13.0100, 77.6150), (13.0400, 77.6230)]),
    (1026, "BMRCL Phase 2A Package 2, Kadubeesanahalli to K R Puram (ORR)", 1, [(12.9390, 77.6964), (12.9553, 77.6984), (12.9850, 77.6900), (13.0005, 77.6755)]),
    (264, "Uttarahalli Main Road widening", 3, [(12.9050, 77.5450), (12.9200, 77.5250)]),
    (8, "NES Circle to Yelahanka station subway", 3, [(13.1050, 77.5919)]),
    (236, "BMRCL Phase 2B Package 1 (Airport line)", 1, [(13.0015, 77.6512), (13.0200, 77.6400), (13.0400, 77.6230), (13.0479, 77.6096)]),
    (1507, "BMRCL Phase 2B Package 1, Kasturinagar to Kempapura", 1, [(13.0015, 77.6512), (13.0200, 77.6400), (13.0400, 77.6230), (13.0479, 77.6096)]),
    (156, "National Military Memorial", 5, [(12.9855, 77.5907)]),
    (95, "Kengeri ORR grade separator at Annapoorneshwarinagar", 3, [(12.9655, 77.5050)]),
    (234, "Koramangala 100 Feet Road flyover ramps", 3, [(12.9322, 77.6230)]),
    (120, "Channasandra railway station remodelling", 2, [(12.9873, 77.7539)]),
    (385, "Bangalore Cantonment railway station", 2, [(12.9937, 77.5980)]),
    (48, "Old Airport Road signal-free corridor, Command Hospital to Hope Farm", 3, [(12.9641, 77.6262), (12.9600, 77.7000), (12.9873, 77.7539)]),
    (1430, "Suburban rail (BSRP) Corridor 2 Package 1 from Baiyappanahalli", 2, [(12.9907, 77.6524), (13.0130, 77.6500), (13.0382, 77.5919)]),
    (96, "Ejipura to Kendriya Sadan elevated corridor", 3, [(12.9452, 77.6275), (12.9300, 77.6250)]),
    (155, "HAL ACD Division parking", 4, [(12.9580, 77.6650)]),
    (568, "HAL helicopter engine facility (RWRDC)", 4, [(12.9620, 77.6720)]),
    (63, "Malleshwaram railway station", 2, [(13.0006, 77.5635)]),
    (352, "Council of Architecture centre, Jnanabharathi", 5, [(12.9354, 77.5122)]),
    (170, "HAL Vimanapura helicopter division", 4, [(12.9622, 77.6635)]),
    (1537, "Defence ASC Centre North", 4, [(12.9550, 77.6250)]),
    (253, "Yeshwanthpur railway station redevelopment", 2, [(13.0238, 77.5508)]),
    (101, "Air Force Station Jalahalli East", 4, [(13.0678, 77.5446)]),
    (242, "Air Force Station Jalahalli", 4, [(13.0400, 77.5400)]),
    (1227, "Suburban rail (BSRP) Corridor 2", 2, [(13.0382, 77.5919), (13.0300, 77.5650), (13.0238, 77.5508), (13.0747, 77.5056)]),
    (749, "Command Hospital main building", 4, [(12.9641, 77.6262)]),
    (2184, "BMRCL Phase 3 Corridor 1 Package 1, JP Nagar 4th Phase to Mysore Road", 1, [(12.9070, 77.5850), (12.9130, 77.5600), (12.9250, 77.5400), (12.9460, 77.5300)]),
    (777, "Government First Grade College, Kengeri", 5, [(12.9177, 77.4838)]),
    (648, "GAIL compressed biogas plant, Haralakunte", 6, [(12.9030, 77.6400)]),
    (1128, "Bellary Road underpass, Hebbal to UAS (GKVK)", 3, [(13.0450, 77.5900), (13.0650, 77.5850)]),
    (105, "Hoodi Big Bazaar junction underpass", 3, [(12.9959, 77.7193)]),
    (71, "Defence Baird Barracks, Dickenson Road", 4, [(12.9780, 77.6130)]),
    (184, "BDA HSR Layout shopping complex", 5, [(12.9137, 77.6375)]),
    (65, "National Tuberculosis Institute (NCDC building)", 5, [(13.0060, 77.5850)]),
    (340, "KPTCL 220 kV line, Hoodi to EDC to NGEF", 6, [(12.9959, 77.7193), (12.9950, 77.6850), (12.9947, 77.6489)]),
    (628, "Sericulture Department Reshme Bhavan, Okalipuram", 5, [(12.9852, 77.5645)]),
    (3627, "BMRCL Phase 3 Corridor 2 Package 4, Hosahalli to Kadabagere", 1, [(12.9750, 77.5350), (12.9850, 77.5000), (12.9890, 77.4492)]),
    (61, "Indian Institute of Astrophysics, Koramangala", 5, [(12.9265, 77.6213)]),
    (50, "IWST eco sewage treatment plant, Malleshwaram", 6, [(13.0110, 77.5700)]),
    (419, "Bangalore University academic blocks", 5, [(12.9439, 77.5092)]),
    (936, "BEL export manufacturing and EVM plant", 5, [(13.0499, 77.5620)]),
    (500, "GKVK cashew orchard", 5, [(13.0780, 77.5770)]),
    (254, "Kendriya Vidyalaya, K R Puram", 5, [(13.0050, 77.6800)]),
    (129, "RLDA MG Railway Colony quarters", 2, [(12.9750, 77.5600)]),
    (52, "Police quarters, Ananda Rao Circle", 5, [(12.9817, 77.5746)]),
    (60, "RMV 2nd Stage storm-water drain widening", 6, [(13.0360, 77.5695)]),
    (380, "CRPF Yelahanka peripheral road", 4, [(13.1229, 77.5756)]),
    (98, "HAL ARDC hangars", 4, [(12.9550, 77.6750)]),
    (55, "Air Force Station Chimney Hills quarters", 4, [(13.0720, 77.4996)]),
    (114, "Attur Lake to Puttenahalli Lake drains", 6, [(13.1115, 77.5631), (13.1120, 77.5771)]),
    (141, "BSF, Air Force Station Yelahanka road widening", 4, [(13.1376, 77.6040)]),
    (49, "Government Model ITI, Hosur Road", 5, [(12.9400, 77.6090)]),
    (103, "K C General Hospital, Malleshwaram", 5, [(13.0005, 77.5700)]),
    (412, "Government First Grade College, Ullal", 5, [(12.9546, 77.4788)]),
]


def block_rows(cells, notices=NOTICES, near_km=NEAR_KM):
    """{code: fields} for each (code, lat, lng) block."""
    import numpy as np
    if not cells:
        return {}
    lat0 = sum(c[1] for c in cells) / len(cells)
    kx = 111.32 * math.cos(math.radians(lat0))
    pts = [(k, la, lo) for k, n in enumerate(notices) for la, lo in n[3]]
    P = np.array([(la * 110.57, lo * kx) for _, la, lo in pts])
    owner = np.array([k for k, _, _ in pts])
    share = np.array([notices[k][0] / len(notices[k][3]) for k, _, _ in pts])
    rows = {}
    for code, lat, lng in cells:
        d = np.hypot(P[:, 0] - lat * 110.57, P[:, 1] - lng * kx)
        j = int(d.argmin())
        near = d <= near_km
        n = notices[owner[j]]
        rows[code] = {"tf_trees_2km": int(round(float(share[near].sum()))), "tf_notices_2km": len(set(owner[near].tolist())),
                      "tf_km": round(float(d[j]), 2), "tf_trees_nearest": n[0], "tf_kind_nearest": n[2]}
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("tf_trees_2km", "Trees in felling notices within 2 km", agg="mean", unit="trees", domain=[0, 3000], ramp="reds", higher_is="worse"),
        FieldSpec("tf_notices_2km", "Tree-felling notices within 2 km", agg="mean", unit="notices", domain=[0, 8], ramp="reds", higher_is="worse"),
        FieldSpec("tf_km", "Distance to the nearest tree-felling project", agg="mean", unit="km", domain=[0, 10], ramp="viridis", higher_is=None),
        FieldSpec("tf_trees_nearest", "Trees in the nearest felling notice", agg="mean", unit="trees", ramp="reds", higher_is=None),
        FieldSpec("tf_kind_nearest", "Kind of the nearest felling project (1 metro, 2 rail, 3 road, 4 defence, 5 public building, 6 utility)", agg="mode", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="tree_felling", title="Trees approved for felling (Bengaluru Forest Department notices)", level=LEVEL, fields=specs, group="Environment",
        description="Trees in the Forest Department's public tree-felling notices for metro, rail, road, defence and public-building "
                    "projects within 2 km of each block, the nearest project and its size, from the notices collected on "
                    "data.opencity.in. Notices have no coordinates; projects are placed by hand at their site or along their "
                    "alignment (OpenStreetMap places).",
        source="pipeline/realestate/treefelling.py (Bengaluru tree-cutting notices via OpenCity, placed by hand)",
        license="Public domain (Karnataka Forest Department via data.opencity.in); places © OpenStreetMap contributors (ODbL)",
        default_field="tf_trees_2km", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    region = ap.parse_args(argv).region
    rows = block_rows(lived_cells(region))
    cell_dataset(region, rows)
    t = sorted(r["tf_trees_2km"] for r in rows.values())
    print(f"{region}: {len(NOTICES)} notices, {sum(n[0] for n in NOTICES)} trees, {len(rows)} blocks, "
          f"median {t[len(t) // 2]} trees within 2 km, max {t[-1]}, {sum(1 for x in t if x)} blocks with any")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
