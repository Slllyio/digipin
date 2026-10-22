"""Road traffic noise and exhaust per DIGIPIN cell, from the demand model.

Inputs are the modelled roads in data/traffic/<region>/road_los.geojson
(pcu_daily, speed_peak, ffs from demand_model.py) and the population grid.

Noise follows the UK Calculation of Road Traffic Noise (CRTN, 1988), the
simplest road method with published coefficients, then converts to Lden:

    L10,18h = 29.1 + 10·log10(Q18) + 33·log10(V + 40 + 500/V)
              + 10·log10(1 + 5p/V) − 68.8 − 10·log10(d'/13.5)
    Lden    ≈ 0.90 · L10,18h + 3.77          (Abbott & Nelson 2002)

with Q18 the vehicles 06:00–24:00 (``SHARE_18H`` of the day from the
hourly profile), V a daily mean speed between free-flow and the peak, p the
heavy-vehicle share and d' the slant distance from a 0.5 m source to a
receptor at 4 m. Each home cell (L7 centre) energy-sums every modelled road
within ``REACH_M``. Arterials only, no barriers or facades: it shows where
main-road noise reaches homes, not the quiet side of a building.

Exhaust: vehicle-km in a cell times fleet-average emission factors for an
Indian city mix (``EF_*``, BS-IV/VI era, ARAI/COPERT-India ranges).

Outputs: dataset ``traffic_noise`` (L7) with lden_db, l10_18h_db, nox_kg_day,
pm25_exhaust_g_day, co2_t_day, and a ``noise_air`` block in summary.json
with the residents above WHO's 53 dB Lden road guideline and above 65 dB,
plus the rank correlation between modelled NOx and Sentinel-5P NO₂ per
~4 km cell (L5) as a sanity check.

    python -m pipeline.traffic.noise_air --region all
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"

LEVEL = 7
REACH_M = 300.0              # roads further than this add < 1 dB near an arterial
VEH_PER_PCU = 1.4            # 2-wheeler-heavy mix: more vehicles than PCUs
HEAVY_SHARE = 5.0            # % heavy vehicles (buses + goods) on urban arterials
SHARE_18H = sum(dm.HOURLY_SHARE[6:24]) / 100
SOURCE_H, RECEIVER_H = 0.5, 4.0
WHO_LDEN = 53.0              # WHO Europe 2018 road traffic guideline
HIGH_LDEN = 65.0
# Fleet-average emission factors per vehicle-km (mixed 2W/car/auto/bus/LCV).
EF_NOX_G = 0.45
EF_PM25_G = 0.025
EF_CO2_G = 110.0


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def crtn_l10_18h(q18, speed_kmh, dist_m, heavy_pct=HEAVY_SHARE):
    """CRTN L10(18h) in dB(A) at ``dist_m`` from the kerb (≥ 4 m)."""
    if q18 <= 0:
        return float("-inf")
    v = max(speed_kmh, 20.0)
    d = max(dist_m, 4.0)
    slant = math.sqrt((d + 3.5) ** 2 + (RECEIVER_H - SOURCE_H) ** 2)
    return (29.1 + 10 * math.log10(q18) + 33 * math.log10(v + 40 + 500 / v)
            + 10 * math.log10(1 + 5 * heavy_pct / v) - 68.8
            - 10 * math.log10(slant / 13.5))


def lden_from_l10(l10):
    return 0.90 * l10 + 3.77


def energy_sum(levels):
    s = sum(10 ** (x / 10) for x in levels if x > -1e9)
    return 10 * math.log10(s) if s > 0 else float("-inf")


def spearman(xs, ys):
    """Spearman rank correlation (average ranks for ties)."""
    def ranks(a):
        order = sorted(range(len(a)), key=lambda i: a[i])
        r = [0.0] * len(a)
        i = 0
        while i < len(a):
            j = i
            while j + 1 < len(a) and a[order[j + 1]] == a[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2
            i = j + 1
        return r
    if len(xs) < 3:
        return None
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    sxy = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    sxx = sum((a - mx) ** 2 for a in rx)
    syy = sum((b - my) ** 2 for b in ry)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None


def _seg_dist_m(px, py, ax, ay, bx, by, kx):
    """Point-to-segment distance in metres (equirectangular, kx = cos(lat))."""
    ax, bx = (ax - px) * kx, (bx - px) * kx
    ay, by = ay - py, by - py
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
    x, y = ax + t * dx, ay + t * dy
    return math.hypot(x, y) * 111_320


# ── run ─────────────────────────────────────────────────────────────────────

def road_sources(features):
    """[(segments, q18 vehicles, mean speed, daily vehicles)] for modelled roads."""
    out = []
    for f in features:
        p = f.get("properties") or {}
        pcu = p.get("pcu_daily")
        if not pcu:
            continue
        ffs = p.get("ffs") or dm.road_params(p.get("highway"))[0]
        sp = p.get("speed_peak") or ffs
        veh = pcu * VEH_PER_PCU
        g = f.get("geometry") or {}
        parts = [g["coordinates"]] if g.get("type") == "LineString" else \
            g.get("coordinates", []) if g.get("type") == "MultiLineString" else []
        segs = [(c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]) for c in parts for i in range(len(c) - 1)]
        if segs:
            out.append((segs, veh * SHARE_18H, (ffs + sp) / 2, veh))
    return out


def compute(region, log=print):
    path = REPO / "data" / "traffic" / region / "road_los.geojson"
    feats = json.loads(path.read_text())["features"]
    srcs = road_sources(feats)
    pop = dm._read("population", region)
    if pop is None:
        raise RuntimeError(f"no population grid for {region}")
    # Spatial hash of segments (≈ 300 m cells).
    G = 0.003
    grid: dict = {}
    for ri, (segs, *_r) in enumerate(srcs):
        for si, (ax, ay, bx, by) in enumerate(segs):
            for gx in range(int(min(ax, bx) / G), int(max(ax, bx) / G) + 1):
                for gy in range(int(min(ay, by) / G), int(max(ay, by) / G) + 1):
                    grid.setdefault((gx, gy), []).append((ri, si))
    rows = {}
    for code, p in zip(pop.codes, pop.columns["population"]):
        b = digipin.decode_partial(code)["bounds"]
        x, y = (b["west"] + b["east"]) / 2, (b["south"] + b["north"]) / 2
        kx = math.cos(math.radians(y))
        gx, gy = int(x / G), int(y / G)
        best: dict = {}
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ri, si in grid.get((gx + dx, gy + dy), ()):
                    d = _seg_dist_m(x, y, *srcs[ri][0][si], kx)
                    if d <= REACH_M and d < best.get(ri, 1e18):
                        best[ri] = d
        if not best:
            continue
        l10 = energy_sum([crtn_l10_18h(srcs[ri][1], srcs[ri][2], d) for ri, d in best.items()])
        rows[code[:LEVEL]] = {"l10_18h_db": round(l10, 1), "lden_db": round(lden_from_l10(l10), 1),
                              "_pop": p or 0}
    # Exhaust from vehicle-km driven inside each cell (segment midpoints).
    for segs, _q, _v, veh in srcs:
        for ax, ay, bx, by in segs:
            mx, my = (ax + bx) / 2, (ay + by) / 2
            km = _seg_dist_m(ax, ay, bx, by, bx, by, math.cos(math.radians(ay))) / 1000
            code = digipin.encode(my, mx).replace("-", "")[:LEVEL]
            r = rows.setdefault(code, {"_pop": 0})
            r["_vkm"] = r.get("_vkm", 0.0) + veh * km
    for r in rows.values():
        vkm = r.pop("_vkm", 0.0)
        r["nox_kg_day"] = round(vkm * EF_NOX_G / 1000, 2)
        r["pm25_exhaust_g_day"] = round(vkm * EF_PM25_G, 1)
        r["co2_t_day"] = round(vkm * EF_CO2_G / 1e6, 3)
    return rows


def summarise(region, rows):
    people = sum(r["_pop"] for r in rows.values())
    total = sum(p or 0 for p in dm._read("population", region).columns["population"])
    who = sum(r["_pop"] for r in rows.values() if r.get("lden_db", -1) >= WHO_LDEN)
    high = sum(r["_pop"] for r in rows.values() if r.get("lden_db", -1) >= HIGH_LDEN)
    # NOx vs Sentinel-5P NO2 per L5.
    rho, n5 = None, 0
    air = dm._read("air_quality", region)
    if air is not None:
        nox5: dict = {}
        for code, r in rows.items():
            nox5[code[:5]] = nox5.get(code[:5], 0.0) + r.get("nox_kg_day", 0.0)
        agg: dict = {}                      # NO2 is L6: average per L5
        for c, v in zip(air.codes, air.columns["no2_umol_m2"]):
            if v is not None:
                a = agg.setdefault(c[:5], [0.0, 0])
                a[0] += v
                a[1] += 1
        pairs = [(nox5[k], agg[k][0] / agg[k][1]) for k in nox5 if k in agg]
        n5 = len(pairs)
        rho = spearman([a for a, _ in pairs], [b for _, b in pairs])
    return {
        "residents_total": round(total), "residents_near_modelled_roads": round(people),
        "residents_lden_ge_53": round(who), "residents_lden_ge_65": round(high),
        "nox_t_day": round(sum(r.get("nox_kg_day", 0) for r in rows.values()) / 1000, 2),
        "co2_t_day": round(sum(r.get("co2_t_day", 0) for r in rows.values()), 1),
        "nox_vs_s5p_no2_spearman_l5": None if rho is None else round(rho, 2), "l5_cells_compared": n5,
        "assumptions": {"veh_per_pcu": VEH_PER_PCU, "heavy_pct": HEAVY_SHARE, "share_18h": round(SHARE_18H, 3),
                        "ef_g_per_vkm": {"nox": EF_NOX_G, "pm25": EF_PM25_G, "co2": EF_CO2_G},
                        "reach_m": REACH_M, "method": "CRTN 1988 + Abbott & Nelson 2002 Lden"},
    }


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("lden_db", "Road noise at home (Lden)", agg="max", unit="dB(A)", domain=[45, 80],
                  ramp="heat", higher_is="worse"),
        FieldSpec("l10_18h_db", "Road noise L10 (06–24 h)", agg="max", unit="dB(A)", domain=[45, 85],
                  ramp="heat", higher_is="worse"),
        FieldSpec("nox_kg_day", "Traffic NOx emitted", agg="sum", unit="kg/day", ramp="heat",
                  higher_is="worse"),
        FieldSpec("pm25_exhaust_g_day", "Traffic exhaust PM2.5", agg="sum", unit="g/day", ramp="heat",
                  higher_is="worse"),
        FieldSpec("co2_t_day", "Traffic CO2", agg="sum", unit="t/day", ramp="heat", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="traffic_noise", title="Road noise & exhaust (modelled)", level=LEVEL, fields=specs,
        group="Traffic & mobility",
        description="From the traffic demand model's daily volumes on the arterials: road noise at each "
                    "home cell by the UK CRTN method (all modelled roads within 300 m, energy-summed, "
                    "converted to Lden), and exhaust from vehicle-km driven in the cell with fleet-average "
                    f"factors (NOx {EF_NOX_G} g, PM2.5 {EF_PM25_G} g, CO2 {EF_CO2_G} g per vehicle-km). "
                    "No barriers, facades or local streets; modelled, not measured.",
        source="pipeline/traffic/noise_air.py over data/traffic road_los.geojson + GHSL population",
        license="ODbL (OpenStreetMap) + CC BY 4.0 (GHSL)",
        default_field="lden_db", extrude=False)
    clean = ({"digipin": c, **{k: v for k, v in r.items() if not k.startswith("_")}} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, log=print):
    rows = compute(region, log)
    res = cell_dataset(region, rows)
    summ = REPO / "data" / "traffic" / region / "summary.json"
    s = json.loads(summ.read_text()) if summ.exists() else {}
    s["noise_air"] = summarise(region, rows)
    summ.write_text(json.dumps(s, indent=2) + "\n")
    log(f"{region}: {json.dumps(s['noise_air'])[:300]}")
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
