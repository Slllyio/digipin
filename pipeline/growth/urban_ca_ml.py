"""Cellular-Automata + Random-Forest urban-growth predictor.

Trains a transition-potential model on the OBSERVED building-change history
(`buildings_temporal_2016-2023_<region>.tif`) against spatial driver layers
(slope, distance-to-roads/water/built-up, population, night-lights — see
`ca_drivers.py`), then runs a constrained CA simulation forward to a horizon
year, producing a per-cell urbanization-probability COG:

    data/growth/ca_urban_prediction_<region>.tif   (1 band, P(urban) 0..1)

Crucially — unlike a synthetic demo — it **hindcast-validates**: train on
2016→2020, simulate to 2023, score against the observed 2023 map with the two
metrics the urban-CA literature uses, **Figure of Merit** and **Cohen's Kappa**,
written to `data/growth/ca_validation_<region>.json`.

Design: this is the standard CA-RF hybrid (cf. SLEUTH / CA-Markov family). RF
gives the per-cell transition *potential*; a Markov *demand* sets how many cells
urbanize per step; a 3×3 *neighbourhood* term enforces spatial contiguity; the CA
allocates the top-scoring non-urban cells each step.

The pure array helpers (allocate/neighbourhood/Kappa/FoM/demand) are numpy-only
and unit-tested; the RF fit and raster IO are imported lazily (so tests don't
require scikit-learn/rasterio and CI skips cleanly when they're absent).
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import numpy as np

from pipeline._lib.regions import get_default_bbox, get_default_region_name

log = logging.getLogger("pipeline.growth.ca_ml")

PRESENCE_THRESHOLD = 0.5   # building-presence ≥ this ⇒ "urban"
YEARS = list(range(2016, 2024))


# ───────────────────────── pure CA / metric helpers (numpy only) ─────────────
def urban_mask(presence_band, threshold=PRESENCE_THRESHOLD):
    """Boolean urban mask from a building-presence band."""
    return np.asarray(presence_band) >= threshold


def neighbourhood(mask):
    """Fraction (0..1) of the 8-neighbourhood that is urban, per cell. Pure."""
    m = np.asarray(mask, dtype="float32")
    acc = np.zeros_like(m)
    cnt = np.zeros_like(m)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            shifted = np.roll(np.roll(m, dy, axis=0), dx, axis=1)
            # zero the wrapped edges so borders aren't contaminated
            if dy == 1:
                shifted[0, :] = 0
            if dy == -1:
                shifted[-1, :] = 0
            if dx == 1:
                shifted[:, 0] = 0
            if dx == -1:
                shifted[:, -1] = 0
            acc += shifted
            cnt += 1
    return acc / np.maximum(cnt, 1)


def markov_demand(masks):
    """Mean count of newly-urbanised cells per step across a list of yearly masks."""
    masks = [np.asarray(m, dtype=bool) for m in masks]
    if len(masks) < 2:
        return 0
    gains = [int((masks[i] & ~masks[i - 1]).sum()) for i in range(1, len(masks))]
    return max(0, int(round(sum(gains) / len(gains))))


def allocate_step(potential, urban, demand, neighbour_weight=0.5):
    """Urbanise the `demand` highest-scoring non-urban cells. Pure.

    score = potential × (1 + neighbour_weight × neighbourhood(urban)); only
    non-urban cells are eligible. Returns the new urban mask (bool)."""
    urban = np.asarray(urban, dtype=bool)
    if demand <= 0:
        return urban.copy()
    pot = np.asarray(potential, dtype="float32")
    score = pot * (1.0 + neighbour_weight * neighbourhood(urban))
    score = np.where(urban, -1.0, score)            # exclude already-urban
    flat = score.ravel()
    eligible = int((flat > 0).sum())
    k = min(demand, eligible)
    out = urban.copy()
    if k > 0:
        idx = np.argpartition(flat, -k)[-k:]
        out.ravel()[idx] = True
    return out


def figure_of_merit(obs_t0, obs_t1, pred_t1):
    """Pontius Figure of Merit on the CHANGE class: hits/(hits+misses+false alarms)."""
    o0 = np.asarray(obs_t0, dtype=bool)
    o1 = np.asarray(obs_t1, dtype=bool)
    p1 = np.asarray(pred_t1, dtype=bool)
    obs_change = o1 & ~o0
    pred_change = p1 & ~o0
    hits = int((obs_change & pred_change).sum())
    misses = int((obs_change & ~pred_change).sum())
    false_alarms = int((~obs_change & pred_change).sum())
    denom = hits + misses + false_alarms
    return round(hits / denom, 4) if denom else 0.0


def kappa(obs, pred):
    """Cohen's Kappa for two binary maps. Pure."""
    o = np.asarray(obs, dtype=bool).ravel()
    p = np.asarray(pred, dtype=bool).ravel()
    n = o.size
    if n == 0:
        return 0.0
    po = float((o == p).sum()) / n
    po1, pp1 = o.mean(), p.mean()
    pe = po1 * pp1 + (1 - po1) * (1 - pp1)
    return round((po - pe) / (1 - pe), 4) if pe < 1 else 1.0


# ───────────────────────── RF + simulation (lazy heavy deps) ─────────────────
def _features(driver_stack):
    """(H,W,K) driver stack → (H*W, K) feature matrix."""
    h, w, k = driver_stack.shape
    return driver_stack.reshape(h * w, k)


def train_transition(driver_stack, urban_t0, urban_t1, **rf_kwargs):
    """Fit a RandomForest on non-urban@t0 cells → urbanised-by-t1 label.
    Returns (model, potential_surface HxW in 0..1)."""
    from sklearn.ensemble import RandomForestClassifier
    h, w, _ = driver_stack.shape
    X = _features(driver_stack)
    o0 = urban_mask(urban_t0).ravel()
    label = (urban_mask(urban_t1).ravel() & ~o0).astype(int)
    train_idx = ~o0                                   # only model cells that could change
    Xt, yt = X[train_idx], label[train_idx]
    params = dict(n_estimators=200, max_depth=12, min_samples_leaf=5,
                  class_weight="balanced", n_jobs=-1, random_state=42)
    params.update(rf_kwargs)
    model = RandomForestClassifier(**params)
    if len(np.unique(yt)) < 2:                         # degenerate (no change) → flat potential
        pot = np.zeros(h * w, dtype="float32")
    else:
        model.fit(Xt, yt)
        pot = model.predict_proba(X)[:, 1].astype("float32")
    pot[o0] = 0.0                                      # already urban → no transition potential
    return model, pot.reshape(h, w)


def simulate(potential, urban0, demand_per_step, steps, neighbour_weight=0.5):
    """Run the CA forward `steps` years; return the final urban mask."""
    urban = urban_mask(urban0) if np.asarray(urban0).dtype != bool else np.asarray(urban0)
    urban = urban.copy()
    for _ in range(max(0, steps)):
        urban = allocate_step(potential, urban, demand_per_step, neighbour_weight)
    return urban


def hindcast(driver_stack_t0, urban_2016, urban_2020, urban_2023):
    """Train 2016→2020, simulate 3 yrs to 2023, score vs observed. Returns metrics."""
    _, pot = train_transition(driver_stack_t0, urban_2016, urban_2020)
    demand = markov_demand([urban_mask(urban_2016), urban_mask(urban_2020)])
    pred_2023 = simulate(pot, urban_2020, demand, steps=3)   # RF potential drives the CA
    return {
        "figure_of_merit": figure_of_merit(urban_mask(urban_2020), urban_mask(urban_2023), pred_2023),
        "kappa": kappa(urban_mask(urban_2023), pred_2023),
        "demand_per_step": demand,
    }


# ───────────────────────── orchestration (raster IO) ─────────────────────────
def run(region=None, horizon=2035, out=None):
    """Full pipeline: read temporal + drivers, train, hindcast, simulate, write COG."""
    import rasterio
    from pipeline.growth import ca_drivers

    region = region or get_default_region_name()
    bbox = get_default_bbox()
    temporal = Path(f"data/growth/buildings_temporal_2016-2023_{region}.tif")
    if not temporal.exists():
        raise SystemExit(f"missing {temporal} — run download_temporal_gcs first")

    with rasterio.open(temporal) as src:
        bands = src.read().astype("float32")          # (8, H, W)
        profile = src.profile
        transform, crs = src.transform, src.crs

    drivers = ca_drivers.build_stack(region, bbox, ref_profile=profile)  # (H,W,K)
    u2016, u2020, u2023 = bands[0], bands[YEARS.index(2020)], bands[-1]

    metrics = hindcast(drivers, u2016, u2020, u2023)
    log.info("hindcast: FoM=%.3f Kappa=%.3f demand/step=%d",
             metrics["figure_of_merit"], metrics["kappa"], metrics["demand_per_step"])
    Path(f"data/growth/ca_validation_{region}.json").write_text(json.dumps(metrics, indent=1))

    # Train on the full record (2016→2023) and project to horizon.
    _, pot = train_transition(drivers, u2016, u2023)
    demand = markov_demand([urban_mask(bands[i]) for i in range(len(YEARS))])
    steps = max(0, horizon - YEARS[-1])
    # accumulate yearly newly-urban into a probability-like surface (earlier = higher)
    urban = urban_mask(u2023).copy()
    prob = np.where(urban, 1.0, 0.0).astype("float32")
    for s in range(steps):
        nxt = allocate_step(pot, urban, demand)
        newly = nxt & ~urban
        prob[newly] = 1.0 - (s / max(1, steps)) * 0.6   # sooner ⇒ higher confidence
        urban = nxt
    # blend in raw RF potential for cells never allocated (low but non-zero signal)
    prob = np.maximum(prob, pot * 0.4).astype("float32")

    out = Path(out) if out else Path(f"data/growth/ca_urban_prediction_{region}.tif")
    out.parent.mkdir(parents=True, exist_ok=True)
    profile.update(count=1, dtype="float32", compress="deflate", tiled=True,
                   blockxsize=256, blockysize=256)
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(prob, 1)
        dst.set_band_description(1, f"P(urban by {horizon})")
    log.info("wrote %s (%.1f KB)", out, out.stat().st_size / 1024)
    return metrics


def main():
    """CLI: run the CA-RF urban-growth hindcast/projection and write outputs."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--horizon", type=int, default=2035)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    run(horizon=args.horizon, out=args.out)


if __name__ == "__main__":
    main()
