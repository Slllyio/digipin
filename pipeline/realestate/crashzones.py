"""Accident-prone junctions near each block: Delhi Traffic Police and BBMP lists (via OpenCity, public domain).

Two official lists name the junctions where crashes cluster: Delhi Traffic Police's accident-prone zones of 2021 and
BBMP's Suraksha-75 junctions in Bengaluru, picked in 2025 for safety redesign. Both give names only, so each junction
is placed at its OpenStreetMap location (``ZONES``, found with Nominatim and checked by hand); names that could not be
placed with confidence are left out. Per lived-in L7 block (dataset ``crash_zones``):

    cz_km      distance to the nearest listed junction
    cz_1km     listed junctions within 1 km
    cz_500m    1 when one is within 500 m

    python -m pipeline.realestate.crashzones --region delhi,bengaluru
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
SOURCE = {"delhi": "Delhi Traffic Police, accident-prone zones 2021", "bengaluru": "BBMP Suraksha-75 junctions (2025)"}
# region -> [(name, lat, lng)]; Nominatim hits checked by hand, a few well-known junctions placed by hand where it
# found nothing; Delhi has 87 listed zones and Bengaluru 75, of which these could be placed
ZONES = {
    "delhi": [
        ("Mukarba Chowk", 28.7349, 77.1555), ("Punjabi Bagh Chowk", 28.6738, 77.1405), ("Zakhira Flyover", 28.6676, 77.1674),
        ("Mukundpur Chowk", 28.7337, 77.1834), ("Moti Bagh Flyover", 28.5781, 77.1764), ("Nangli Poona", 28.7732, 77.1433),
        ("Majnu Ka Tila", 28.6987, 77.226), ("Swaroop Nagar", 28.7596, 77.1517), ("Wazirabad", 28.7298, 77.2213),
        ("Jharera Village", 28.5798, 77.1448), ("Gagan Cinema", 28.6957, 77.3154), ("C-1 Janakpuri", 28.6171, 77.0788),
        ("Rajdhani Park", 28.6823, 77.0439), ("Peeragarhi Chowk", 28.6791, 77.096), ("Dhaula Kuan", 28.5919, 77.1617),
        ("Rajouri Garden", 28.6491, 77.1227), ("Vijay Ghat", 28.6559, 77.2471), ("Anand Vihar Isbt", 28.6468, 77.318),
        ("Naraina", 28.6265, 77.135), ("Shahdara Flyover", 28.676, 77.296), ("Modi Mill Flyover", 28.5576, 77.2707),
        ("Chirag Delhi Flyover", 28.5407, 77.2352), ("Shastri Park Metro Station", 28.6684, 77.2503), ("Jasola Vihar", 28.5427, 77.2913),
        ("Esi Hospital Ring Road", 28.6591, 77.1288), ("Power House Pitampura", 28.7079, 77.1352), ("Dilshad Garden", 28.6759, 77.3214),
        ("Gokalpuri", 28.6954, 77.2913), ("Sarita Vihar Flyover", 28.5365, 77.2846), ("Mahipalpur Flyover", 28.5462, 77.123),
        ("Nirankari Colony", 28.7166, 77.2064), ("Bhalswa Chowk", 28.7395, 77.163), ("Mool Chand", 28.5653, 77.2343),
        ("Akshardham Mandir", 28.6127, 77.2773), ("Azadpur Sabzi Mandi", 28.7125, 77.175), ("Nigam Bodh Ghat", 28.665, 77.2365),
        ("RML Hospital", 28.6264, 77.2007), ("Panchsheel Flyover", 28.5404, 77.219), ("Tees Hazari Red Light", 28.667, 77.216),
        ("Subhash Nagar Metro Station", 28.64, 77.1046), ("Mundka Metro Station", 28.6828, 77.031), ("Tughlakabad Metro Station", 28.5025, 77.2994),
        ("Hyatt Hotel", 28.5684, 77.1857), ("Lajpat Rai Market", 28.6563, 77.2318), ("Metro Station Madipur", 28.6787, 77.1204),
        ("Metro Station Haider Pur", 28.721, 77.149), ("Seelampur T Point", 28.6703, 77.2669), ("Toll Plaza Badarpur", 28.4895, 77.3034),
        ("Burari Chowk", 28.7286, 77.1993),
    ],
    "bengaluru": [
        ("Minsk Square", 12.9808, 77.5974), ("Basaveshwara Circle", 12.9846, 77.5883), ("Windsor Manor junction", 12.9942, 77.586),
        ("Anil Kumble Circle", 12.9765, 77.6018), ("Domlur HAL Old Airport Road junction", 12.9611, 77.637), ("Hosur Road Adugodi junction", 12.9445, 77.6075),
        ("Trinity Circle", 12.9707, 77.6197), ("Nagarbhavi junction Outer Ring Road", 12.9665, 77.51), ("Nayandahalli junction", 12.9453, 77.5281),
        ("Nagarbhavi Circle", 12.9585, 77.519), ("Vidyaranyapura Main Road", 13.0854, 77.5572), ("Palanahalli", 13.1163, 77.6147),
        ("Kogilu Cross", 13.1046, 77.6005), ("Byatarayanapura", 13.0683, 77.591), ("K R Market", 12.9609, 77.5747),
        ("Sirsi Circle", 12.9613, 77.5592), ("Vijayanagar", 12.971, 77.5374), ("Nandi Link Grounds", 12.9411, 77.5309),
        ("Vijayanagar Bus Stand", 12.9652, 77.5346), ("Hongasandra", 12.8986, 77.6287), ("HSR Layout 27th Main", 12.916, 77.6518),
        ("Arekere", 12.8872, 77.596), ("Kudlu Gate", 12.8896, 77.6395), ("Sarakki Junction", 12.9065, 77.5733),
        ("Tin Factory", 12.9965, 77.6705), ("K R Puram", 13.0005, 77.6755), ("Marathahalli", 12.9553, 77.6984),
        ("Benniganahalli", 12.9934, 77.6651), ("Doddanekundi", 12.9713, 77.6965), ("Varthur Kodi", 12.9564, 77.7456),
        ("Kundalahalli junction", 12.9559, 77.7148), ("Mahadevapura Lake", 12.9874, 77.6922), ("Embassy Tech Village", 12.9307, 77.6914),
        ("Bagmane Tech Park", 12.9788, 77.6589), ("Jayanna Circle Kenchenahalli", 12.9264, 77.5145), ("Goraguntepalya", 13.0269, 77.5441),
        ("BEL Circle", 13.0456, 77.5564), ("Sumanahalli junction", 12.9875, 77.5192), ("Veerannapalya", 13.0425, 77.6133),
        ("Nagavara junction", 13.0401, 77.6241), ("Hennur Cross", 13.032, 77.6361), ("NICE Road Hosur Road junction", 12.8575, 77.6634),
        ("Kengeri TTMC", 12.9137, 77.4871), ("Kengeri NICE Road junction", 12.9045, 77.4707), ("Makkala Koota", 12.9577, 77.5739),
        ("SJP Road", 12.9642, 77.5801), ("8th Mile", 13.0482, 77.5081), ("Nagasandra", 13.048, 77.5001),
        ("Jalahalli Cross", 13.0398, 77.5183), ("Dasarahalli", 13.0433, 77.5126), ("Vega City Mall", 12.9078, 77.6012),
        ("Vatal Nagaraj Road", 12.9849, 77.5535), ("Chord Road Basaveshwaranagar", 12.9979, 77.5501), ("NES bus stop Yelahanka", 13.0978, 77.5918),
        ("Yelahanka New Town", 13.0978, 77.5812), ("Forum Mall Koramangala", 12.935, 77.6121), ("Devegowda Petrol Bunk", 12.9222, 77.56),
        ("Sarjapur Road signal near Iblur lake", 12.9235, 77.6655), ("Mysore Sandal Soap Factory junction", 13.013, 77.556), ("Yeshwanthpur junction", 13.0236, 77.5508),
        ("Magadi Road Toll Gate junction", 12.975, 77.556), ("Chowdaiah Road", 12.9946, 77.5839), ("Lalbagh-Hosur Road junction", 12.9558, 77.5975),
    ],
}


def block_rows(cells, zones):
    if not zones:
        return {}
    lat0 = sum(z[1] for z in zones) / len(zones)
    kx = 111.32 * math.cos(math.radians(lat0))
    rows = {}
    for code, la, lo in cells:
        d = [math.hypot((la - z[1]) * 110.57, (lo - z[2]) * kx) for z in zones]
        m = min(d)
        rows[code] = {"cz_km": round(m, 2), "cz_1km": sum(1 for x in d if x <= 1.0), "cz_500m": int(m <= 0.5)}
    return rows


def cell_dataset(region, rows, n):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("cz_km", "Distance to the nearest officially listed accident-prone junction", agg="mean", unit="km", domain=[0, 5], ramp="viridis", higher_is=None),
        FieldSpec("cz_1km", "Listed accident-prone junctions within 1 km", agg="mean", unit="junctions", ramp="reds", higher_is="worse"),
        FieldSpec("cz_500m", "Within 500 m of a listed accident-prone junction", agg="max", unit="yes/no", domain=[0, 1], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="crash_zones", title="Accident-prone junctions (Delhi Traffic Police, BBMP)", level=LEVEL, fields=specs, group="Mobility",
        description=f"Distance to the nearest of {n} junctions on the official list for the city ({SOURCE.get(region, '')}), via "
                    f"data.opencity.in; junctions placed at their OpenStreetMap location by name.",
        source="pipeline/realestate/crashzones.py (Delhi Traffic Police accident-prone zones; BBMP Suraksha-75; sites from OpenStreetMap)",
        license="Public domain (Delhi Traffic Police, BBMP via data.opencity.in); sites © OpenStreetMap contributors (ODbL)", default_field="cz_km", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="delhi,bengaluru")
    for region in ap.parse_args(argv).region.split(","):
        zones = ZONES.get(region, [])
        rows = block_rows(lived_cells(region), zones)
        if rows:
            cell_dataset(region, rows, len(zones))
        print(f"{region}: {len(zones)} junctions, {len(rows)} blocks, {sum(r['cz_500m'] for r in rows.values())} within 500 m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
