"""Businesses and services per block from Overture Maps places.

Per L7 block (dataset ``places``), counting Overture places with confidence
>= MIN_CONF and not marked closed:

    places              all places
    food, shopping, services, health, education, lodging, leisure, culture,
    community, transport  counts by Overture taxonomy level 1
    offices             IT, software, professional and business services
    finance             banks, ATMs and other financial services
    property_agents     real-estate agents and services (a market-activity proxy)
    hospitals, colleges, coaching, malls, coworking, hostels, post_offices, police, fire_stations,
                        pharmacies, grocers, preschools, libraries, community_centres, fuel, worship, tech, corporate,
                        obgyn, paediatric, events, freight, wholesale, diagnostics, dental, eyecare, elder_homes
                        exact Overture categories (see ANCHORS), for demand-anchor and service-reach lenses
    branded_pct         share of places that carry a brand (chains)
    diversity           Shannon evenness of the level-1 mix (0 = one kind, 1 = even)

    python -m pipeline.realestate.places --region all
"""
from __future__ import annotations

import argparse
import math
from collections import defaultdict
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS, bbox_for

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RELEASE = "2026-10-21.0"
MIN_CONF = 0.6
GROUPS = {
    "food_and_drink": "food", "shopping": "shopping", "services_and_business": "services", "health_care": "health",
    "education": "education", "lodging": "lodging", "sports_and_recreation": "leisure", "arts_and_entertainment": "leisure",
    "lifestyle_services": "leisure", "cultural_and_historic": "culture", "community_and_government": "community",
    "travel_and_transportation": "transport",
}
KINDS = sorted(set(GROUPS.values()))
OFFICE_WORDS = ("software", "information_technology", "professional_service", "b2b_", "corporate", "consult", "marketing",
                "advertising", "legal", "lawyer", "accountant", "accounting", "engineering_service", "coworking", "office")
FINANCE_WORDS = ("bank", "atm", "financial", "credit_union", "insurance", "stock_and_bond", "investing")
PROPERTY_WORDS = ("real_estate", "property_management", "apartment_agent", "builder", "home_developer")
ANCHORS = {
    "hospitals": ("hospital", "childrens_hospital"),
    "colleges": ("college_university",),
    "coaching": ("tutoring_service", "computer_coaching", "test_preparation", "private_tutor"),
    "malls": ("shopping_mall",),
    "coworking": ("coworking_space",),
    "hostels": ("hostel",),
    "post_offices": ("post_office",),
    "police": ("police_station",),
    "fire_stations": ("fire_station",),
    "pharmacies": ("pharmacy",),
    "grocers": ("grocery_store", "indian_grocery_store", "organic_grocery_store", "supermarket", "convenience_store"),
    "preschools": ("preschool", "day_care_preschool", "child_care_and_day_care"),
    "libraries": ("library",),
    "community_centres": ("community_center",),
    "fuel": ("gas_station",),
    "tech": ("software_development", "information_technology_company", "biotechnology_company", "b2b_science_and_technology_service"),
    "corporate": ("corporate_or_business_office",),
    "obgyn": ("obstetrics_and_gynecology", "maternity_center"),
    "paediatric": ("pediatric_clinic",),
    "events": ("party_and_event_planning", "event_venue", "wedding_planning", "wedding_chapel", "caterer"),
    "freight": ("freight_and_cargo_service", "freight_forwarding_agency", "motor_freight_trucking", "railroad_freight", "shipping_center",
                "courier_and_delivery_service", "warehouse", "storage_facility", "distribution_service", "b2b_transportation_and_storage_service"),
    "wholesale": ("wholesaler",),               # plus every '*_wholesaler' and 'wholesale_*' category, see anchor_of()     # plus every other 'pediatric_*' specialty, see anchor_of()
    "diagnostics": ("diagnostic_imaging", "laboratory_testing", "laboratory", "radiology", "medical_laboratory"),
    "dental": ("dental_clinic", "dentist", "general_dentistry", "pediatric_dentist", "orthodontist", "endodontist", "periodontist"),
    "eyecare": ("vision_or_eye_care_clinic", "ophthalmologist", "optometrist", "eye_care_clinic"),
    "elder_homes": ("retirement_home", "senior_citizen_service", "assisted_living_facility", "nursing_home"),
    "worship": ("place_of_worship",),          # plus every '<faith>_place_of_worship' category, see anchor_of()
}
_ANCHOR_OF = {cat: k for k, cats in ANCHORS.items() for cat in cats}


def anchor_of(primary):
    """The ANCHORS key for an Overture primary category, or None."""
    if primary in _ANCHOR_OF:
        return _ANCHOR_OF[primary]
    if primary and primary.endswith("_place_of_worship"):
        return "worship"
    if primary == "pediatric_dentist":
        return "dental"
    if primary and primary.startswith("pediatric_"):
        return "paediatric"
    return "wholesale" if primary and (primary.endswith("_wholesaler") or primary.startswith("wholesale_")) else None


def classify(level1, primary):
    """(group or None, is_office, is_finance, is_property) for one place."""
    p = primary or ""
    return (GROUPS.get(level1), any(w in p for w in OFFICE_WORDS), any(w in p for w in FINANCE_WORDS),
            any(w in p for w in PROPERTY_WORDS))


def evenness(counts):
    """Shannon evenness of a {kind: count} mix, 0..1; None when fewer than 3 places."""
    tot = sum(counts.values())
    if tot < 3:
        return None
    h = -sum(c / tot * math.log(c / tot) for c in counts.values() if c)
    return h / math.log(len(KINDS))


def rows_from(points):
    """points: iterable of (lng, lat, level1, primary, brand) → {code: row}."""
    acc = defaultdict(lambda: {"n": 0, "brand": 0, "office": 0, "finance": 0, "prop": 0, "mix": defaultdict(int), "anchor": defaultdict(int)})
    for x, y, l1, tp, br in points:
        try:
            code = digipin.encode(y, x).replace("-", "")[:LEVEL]
        except ValueError:
            continue
        a = acc[code]
        grp, off, fin, prop = classify(l1, tp)
        a["n"] += 1
        a["brand"] += bool(br)
        a["office"] += off
        a["finance"] += fin
        a["prop"] += prop
        k = anchor_of(tp)
        if k:
            a["anchor"][k] += 1
        if grp:
            a["mix"][grp] += 1
    rows = {}
    for code, a in acc.items():
        r = {"places": a["n"], **{k: a["mix"].get(k, 0) for k in KINDS}, "offices": a["office"], "finance": a["finance"],
             "property_agents": a["prop"], **{k: a["anchor"].get(k, 0) for k in ANCHORS}, "branded_pct": round(100 * a["brand"] / a["n"], 1)}
        ev = evenness(a["mix"])
        r["diversity"] = round(ev, 3) if ev is not None else None
        rows[code] = r
    return rows


def fetch(region, release=RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    return con.execute(f"""
        SELECT (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2, taxonomy.hierarchy[1], taxonomy.primary, brand.names.primary
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}
          AND confidence >= {MIN_CONF} AND coalesce(operating_status, 'open') <> 'permanently_closed'
    """).fetchall()


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    labels = {"food": "Restaurants, cafés and food", "shopping": "Shops", "services": "Business and household services",
              "health": "Clinics, hospitals and pharmacies", "education": "Schools, colleges and coaching",
              "lodging": "Hotels and stays", "leisure": "Gyms, salons, sport and entertainment", "culture": "Cultural and historic places",
              "community": "Government and community places", "transport": "Travel and transport places"}
    specs = [FieldSpec("places", "Businesses and services (Overture places)", agg="sum", unit="places", ramp="viridis", higher_is="better")]
    specs += [FieldSpec(k, labels[k], agg="sum", unit="places", ramp="viridis", higher_is="better") for k in KINDS]
    specs += [
        FieldSpec("offices", "Offices: IT, professional and business services", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("finance", "Banks, ATMs and financial services", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("property_agents", "Real-estate agents and services", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("hospitals", "Hospitals", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("colleges", "Colleges and universities", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("coaching", "Coaching centres and tutors", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("malls", "Shopping malls", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("coworking", "Co-working spaces", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("hostels", "Hostels", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("post_offices", "Post offices", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("police", "Police stations", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("fire_stations", "Fire stations", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("pharmacies", "Pharmacies", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("grocers", "Grocery and convenience stores", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("preschools", "Preschools and day care", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("libraries", "Libraries", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("community_centres", "Community centres", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("fuel", "Petrol pumps and fuel stations", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("worship", "Temples, mosques, churches, gurdwaras and other places of worship", agg="sum", unit="places", ramp="viridis",
                  higher_is=None),
        FieldSpec("tech", "Software, IT, biotech and science firms", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("corporate", "Corporate and business offices", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("obgyn", "Obstetrics, gynaecology and maternity centres", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("paediatric", "Children's doctors and clinics", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("events", "Banquet halls, event venues, wedding and party services", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("freight", "Freight, cargo, courier and warehousing", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("wholesale", "Wholesalers", agg="sum", unit="places", ramp="viridis", higher_is=None),
        FieldSpec("diagnostics", "Diagnostic labs, imaging and radiology centres", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("dental", "Dentists and dental clinics", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("eyecare", "Eye clinics, ophthalmologists and optometrists", agg="sum", unit="places", ramp="viridis", higher_is="better"),
        FieldSpec("elder_homes", "Old-age homes, retirement homes and senior citizen services", agg="sum", unit="places", ramp="viridis",
                  higher_is=None),
        FieldSpec("branded_pct", "Share of places that are chains or brands", agg="mean", unit="%", domain=[0, 30], ramp="viridis", higher_is=None),
        FieldSpec("diversity", "Mix of business types (0 = one kind, 1 = even)", agg="mean", unit="0-1", domain=[0, 1], ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="places", title="Businesses and services (Overture)", level=LEVEL, fields=specs, group="Real estate",
        description=f"Overture Maps places (release {RELEASE}, confidence ≥ {MIN_CONF}, not marked closed) counted per "
                    "block by Overture's taxonomy: food, shops, services, health, education, stays, leisure, culture, "
                    "community and transport, plus offices, finance, real-estate agents, hospitals, colleges, coaching, malls, co-working, hostels, post offices, police and fire stations, pharmacies, grocers, preschools, libraries, community centres, fuel stations, places of worship, tech firms, corporate offices, maternity and children's doctors, event venues, freight and wholesale, diagnostic labs, dentists, eye clinics, old-age homes, brand share and business mix. "
                    "Overture merges Meta and Microsoft listings with open data, so coverage follows where businesses "
                    "list themselves online: dense in markets, thin in informal and older areas.",
        source="pipeline/realestate/places.py (Overture Maps places theme via DuckDB)",
        license="CDLA-Permissive-2.0 (Overture Maps places)", default_field="places", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = rows_from(fetch(r))
        print(f"{r}: {sum(x['places'] for x in rows.values())} places in {len(rows)} blocks")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
