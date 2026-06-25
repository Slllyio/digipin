"""Build the committed flood Curve-Number summary for the FloodWarning widget.

Pulls together the data-driven CN engine into a small JSON artifact the browser
reads (analysis/output/flood_cn_guna.json), so the static PWA never parses big
rasters at runtime:

    WorldCover LULC  +  SoilGrids-derived HSG
              -> curve_number.CN_TABLE (per-cell CN)
              -> area-weighted CN at AMC I / II / III
              -> SCS-CN runoff for the 328 mm/24h event at Ia/S = 0.05 (and 0.20)

The runoff is reported as a dry->wet AMC band, not a single number: that band IS
the decision-grade-screening output. Outputs are labelled screening-level — SCS-CN
is not a validated extreme-event urban-depth model (see assumptions in the JSON).

HSG source of truth is per-cell SoilGrids texture; when that is unavailable the
summary falls back to a documented regional default (Guna = Malwa-plateau black-
cotton vertisols -> HSG D) and stamps confidence="reduced".
"""
from __future__ import annotations

import json
from pathlib import Path

import curve_number as cn
import hsg

# WorldCover class -> human label (subset used by the flood model).
CLASS_NAMES = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland",
    50: "Built-up", 60: "Bare/sparse", 70: "Snow/ice", 80: "Water",
    90: "Wetland", 95: "Mangroves", 100: "Moss/lichen",
}

GUNA_RAINFALL_MM = 328.0          # documented July-2025 Guna event (24 h)
IA_PRIMARY = 0.05                 # modern NRCS (2015)
IA_LEGACY = 0.20                  # classic SCS, for comparison
# Documented regional default when per-cell soil texture is unavailable.
DEFAULT_REGIONAL_HSG = "D"        # Malwa-plateau black-cotton vertisols


def _counts(lulc, hsg_codes) -> dict[tuple[int, str], int]:
    """(WorldCover class, HSG letter) -> pixel count, over known classes only."""
    import numpy as np

    lulc = np.asarray(lulc)
    hsg_codes = np.asarray(hsg_codes)
    counts: dict[tuple[int, str], int] = {}
    for klass in np.unique(lulc):
        klass = int(klass)
        if klass not in cn.CN_TABLE:
            continue
        class_mask = lulc == klass
        for code in np.unique(hsg_codes[class_mask]):
            n = int(np.count_nonzero(class_mask & (hsg_codes == code)))
            if n:
                counts[(klass, hsg.group_for(int(code)))] = n
    return counts


def summarize_cn(lulc, hsg_codes, rainfall_mm: float = GUNA_RAINFALL_MM) -> dict:
    """Assemble the CN/runoff summary from aligned LULC + HSG-code arrays (pure)."""
    import numpy as np

    from pipeline.scores import flood_scs

    # Guard a non-positive rainfall (would divide by zero in the runoff-ratio band).
    if not rainfall_mm or rainfall_mm <= 0:
        rainfall_mm = GUNA_RAINFALL_MM

    counts = _counts(lulc, hsg_codes)
    total = sum(counts.values()) or 1

    weighted = {amc: cn.weighted_cn(counts, amc) for amc in ("I", "II", "III")}

    # dry->wet runoff band at the primary (modern) Ia ratio
    runoff_band = {
        amc: flood_scs.runoff_mm(rainfall_mm, weighted[amc], IA_PRIMARY)
        for amc in ("I", "II", "III")
    }
    # Ia sensitivity at the normal antecedent condition (AMC II)
    ia_sensitivity = {
        f"ia_{IA_PRIMARY}": flood_scs.runoff_mm(rainfall_mm, weighted["II"], IA_PRIMARY),
        f"ia_{IA_LEGACY}": flood_scs.runoff_mm(rainfall_mm, weighted["II"], IA_LEGACY),
    }

    lulc_dist: dict[str, float] = {}
    hsg_dist: dict[str, float] = {"A": 0.0, "B": 0.0, "C": 0.0, "D": 0.0}
    for (klass, group), n in counts.items():
        name = CLASS_NAMES.get(klass, str(klass))
        lulc_dist[name] = round(lulc_dist.get(name, 0.0) + 100.0 * n / total, 2)
        hsg_dist[group] = round(hsg_dist[group] + 100.0 * n / total, 2)

    return {
        "rainfall_mm": rainfall_mm,
        "ia_ratio_primary": IA_PRIMARY,
        "weighted_cn": {k: round(v, 1) for k, v in {
            "amc_i": weighted["I"], "amc_ii": weighted["II"], "amc_iii": weighted["III"],
        }.items()},
        "runoff_band_mm": {
            "amc_i": round(runoff_band["I"], 1),
            "amc_ii": round(runoff_band["II"], 1),
            "amc_iii": round(runoff_band["III"], 1),
        },
        "runoff_ratio_band": {
            "amc_i": round(runoff_band["I"] / rainfall_mm, 3),
            "amc_ii": round(runoff_band["II"] / rainfall_mm, 3),
            "amc_iii": round(runoff_band["III"] / rainfall_mm, 3),
        },
        "ia_sensitivity_mm": {k: round(v, 1) for k, v in ia_sensitivity.items()},
        "lulc_distribution_pct": dict(sorted(lulc_dist.items(), key=lambda kv: -kv[1])),
        "hsg_distribution_pct": {k: v for k, v in hsg_dist.items() if v > 0},
    }


def _load_band(path: Path):
    import rasterio

    with rasterio.open(path) as src:
        return src.read(1), src.profile


def _hsg_grid(lulc, lulc_profile, raster_dir: Path, city: str):
    """Per-cell HSG codes aligned to the LULC grid; documented fallback if no texture."""
    import numpy as np

    sand_p = raster_dir / f"soilgrids_sand_0-5cm_{city}.tif"
    clay_p = raster_dir / f"soilgrids_clay_0-5cm_{city}.tif"
    if not (sand_p.exists() and clay_p.exists()):
        codes = np.full(lulc.shape, hsg.code_for(DEFAULT_REGIONAL_HSG), dtype="uint8")
        return codes, "reduced", (
            f"SoilGrids texture unavailable; using documented regional default "
            f"HSG {DEFAULT_REGIONAL_HSG} (Malwa-plateau black-cotton vertisols)."
        )

    import rasterio
    from rasterio.warp import reproject, Resampling

    def _aligned(path: Path):
        dst = np.zeros(lulc.shape, dtype="float32")
        with rasterio.open(path) as src:
            reproject(
                source=rasterio.band(src, 1), destination=dst,
                dst_transform=lulc_profile["transform"], dst_crs=lulc_profile["crs"],
                resampling=Resampling.nearest,
            )
        return dst

    codes = hsg.hsg_code_grid(_aligned(sand_p), _aligned(clay_p))
    return codes, "data-derived", "Per-cell HSG from SoilGrids 250 m sand/clay."


def build(raster_dir: Path, out_path: Path, city: str = "guna") -> dict:
    """Load rasters, summarise, and write the committed JSON. Returns the summary."""
    lulc, profile = _load_band(raster_dir / f"worldcover_10m_{city}.tif")
    hsg_codes, hsg_confidence, hsg_note = _hsg_grid(lulc, profile, raster_dir, city)

    summary = summarize_cn(lulc, hsg_codes)
    summary["source"] = {
        "lulc": "ESA WorldCover 10 m (2021)",
        "soil": "ISRIC SoilGrids 250 m (sand/clay -> HSG)",
        "method": "USDA TR-55 SCS Curve Number; AMC: Sobhani 1975 / Hawkins 1985",
        "event": "Guna 328 mm/24 h (July 2025)",
    }
    summary["confidence"] = hsg_confidence
    summary["assumptions"] = [
        hsg_note,
        "Screening-level: SCS-CN gives runoff volume, not validated flood depth. "
        "328 mm is beyond the method's design-storm range; treat as early-warning, "
        "not engineering design.",
        f"Ia/S = {IA_PRIMARY} (modern NRCS 2015) primary; {IA_LEGACY} shown for comparison.",
        "Runoff reported as an antecedent-moisture band (dry/normal/wet), not a point value.",
    ]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def main() -> None:
    here = Path(__file__).resolve().parent.parent  # guna-twin-city/
    summary = build(
        raster_dir=here / "data" / "rasters",
        out_path=here / "analysis" / "output" / "flood_cn_guna.json",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
