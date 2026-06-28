# DigiPin Urban Intelligence — a grid-native intelligence layer for Indian ULBs

**Strategy blueprint.** Audience: municipal bodies (ULBs) and the India Post–NUDM–IUDX ecosystem.
Scope: turn the existing DigiPin platform into a coherent, governable urban-intelligence system spanning
four pillars — a per-cell feature store, predictive models, real-time early-warning, and agentic
decision-support — all on one DigiPin substrate.

---

## 1. Context

**DIGIPIN** is India's official national addressing grid (India Post + IIT-Hyderabad + ISRO-NRSC,
launched May 2025): a 10-character code over a recursive 4×4 quadtree, ~4 m cells at level 10, offered as
**Digital Public Infrastructure** ("Address-as-a-Service"). Policy tailwinds — the **National Urban
Digital Mission** (NUDM, ₹1,250 cr for 2025–26), **IUDX**, **Bhuvan**, and **NDEM** — push every ULB
toward shared, geo-indexed data. Yet municipal data still sits in disconnected silos: property tax,
water, building permits, disaster management, mobility, each in its own legacy system.

**This platform already proves the core idea.** DigiPin is implemented here as a *true spatial index*,
not a mere address string:

- `js/digipin.js` + `pipeline/_lib/digipin.py` — spec-accurate encode/decode, hierarchy via code
  truncation.
- Per-cell intelligence stored as code-keyed JSON shards with O(1) lookup
  (`pipeline/scores/build_tile.py`, `js/precomputed-scores.js`, manifest `data/scores/coverage.json`).
- ~15 working capabilities on top: heat (MODIS LST), growth (CA-ML + Open Buildings Temporal), flood
  (SCS-CN), traffic LOS, law-&-order mobility, accessibility/isochrones, real-estate, the **DISHA**
  grounded LLM assistant, **8 real-time feeds** (NDMA / IMD / NCS / USGS / GDACS / OpenAQ), and the Guna
  scenario twin.

**The gap is consolidation and deployment, not invention.** The capabilities are a sprawl of map
overlays; they are not yet a single, governable, queryable *substrate* a ULB can run, trust, and
integrate with its own systems. This blueprint defines how to turn the existing assets into a coherent
**DigiPin Urban Intelligence (DUI)** platform for government decision-making.

---

## 2. Thesis

**The DigiPin cell is the atomic unit of urban intelligence.** Every dataset, model output, alert, and
service event is keyed to a DigiPin cell — producing a national, interoperable, multi-resolution
intelligence substrate that moves ULBs from siloed, static planning to real-time, grid-indexed
decisions.

Three resolutions do most of the work, and they are all the *same code, truncated*:

| Level | Cell size | Primary role |
|-------|-----------|--------------|
| **L6** | ~244 m | Planning & analytics (wards, zones, choropleths) |
| **L8** | ~15 m  | Parcel / operations (buildings, assets, routing) |
| **L10**| ~4 m   | Addressing / last-mile (the DIGIPIN address itself) |

Because a coarser cell is just a prefix of a finer one, analytics roll up and drill down for free.

---

## 3. Architecture (seven layers)

- **L0 — Spatial primitive (DigiPin).** The universal join key; hierarchy by truncation.
  *Reuse:* `js/digipin.js`, `pipeline/_lib/grid.py`, `pipeline/_lib/regions.py`.
- **L1 — Ingestion & harmonisation.** Adapters bin every source onto cells: satellite/EO via **GEE**
  (extend `pipeline/heat`, `pipeline/growth`), OSM/Overture, **IUDX** sensors, **Bhuvan** / **NDEM**, the
  realtime `scrapers/`, and ULB legacy registries (tax / water / permits) via a DigiPin geocoder.
- **L2 — Per-cell Feature Store (Pillar 1, the foundation).** One versioned, multi-level cell record
  fusing all domains — generalise today's score-shard pattern into a documented schema plus the
  `coverage.json` manifest. Static tiles now (GitHub / Cloudflare Pages + R2); optional PostGIS / cloud
  at full ULB scale.
- **L3 — Intelligence & models (Pillar 2).** Deterministic scores + predictive models (CA-ML growth,
  SCS-CN flood, MODIS heat, service demand) + EO foundation models (**Prithvi-EO-2.0** for footprints /
  LULC / change detection) + a per-cell **spatial knowledge graph** for multi-hop reasoning. Keep the
  existing pure/testable model pattern and honest-framing disclaimers.
- **L4 — Real-time / operational (Pillar 3).** Fuse the 8 live feeds per cell → **exposure** (population
  and assets at risk) → alerting + response routing on the road graph.
- **L5 — Serving & access (Pillar 4 + APIs).** Map UI, role-based **ward / department dashboards**, an
  **agentic DISHA** that answers municipal questions and *takes* map/analysis actions, and an
  **Intelligence-as-a-Service API** (per-cell query) offered alongside DIGIPIN Address-as-a-Service.
- **L6 — Governance.** Data lineage, privacy (aggregation thresholds, no PII at cell level, consent for
  citizen data), open standards (IUDX / NUDM schemas), security / RBAC, model transparency + audit.

---

## 4. The four pillars

1. **Per-cell feature store — the foundation.** A universal cell record (EO, OSM, sensors, realtime,
   admin), versioned and multi-resolution. Builds on `build_tile.py` / `precomputed-scores.js`.
   *ULB value:* one trustworthy, cross-department source of truth per location.
2. **Predictive / forecasting.** Growth, flood, heat, and service demand per cell and per horizon,
   hardened with Prithvi and hindcast validation (Figure-of-Merit / Cohen's Kappa — already present for
   growth) plus per-cell confidence. *ULB value:* anticipate expansion, risk, and demand before they
   hit.
3. **Real-time early-warning.** Per-cell operational alerting (flood / heat / AQI / disaster) with
   exposure and responder/citizen routing. *ULB value:* closes the well-documented last-mile gap in
   Indian urban disaster response.
4. **Agentic decision-support.** Evolve DISHA from chat into an agentic GIS — e.g. *"show the 50
   highest flood-risk cells in Ward 12 and evacuation routes to shelters"* — composing scenarios and
   emitting map actions. *ULB value:* planners and responders query in plain language, no GIS skills
   required.

---

## 5. Government / ULB deployment specifics

**Use-cases mapped to departments**

| Department | DigiPin-native capability |
|------------|---------------------------|
| Revenue / property tax | Satellite footprints vs tax rolls → per-cell under-assessment flags |
| Disaster management | Per-cell inundation + exposure + evacuation routing |
| Mobility / transport | LOS + access resilience + transit-gap mapping |
| Services / sanitation | DigiPin-routed water tankers, waste collection, outreach |
| Town planning | Zoning and what-if scenarios at cell resolution |
| Inclusion | Informal-settlement detection → "claim your address" |

**Interoperability.** IUDX adapters (in and out), NUDM-aligned schemas, Bhuvan / NDEM ingestion, and
India Post DIGIPIN as the canonical address key. DUI is an *intelligence layer on national DPI*, not a
competing silo.

**Deployment model.** Static-PWA pilot (≈ $0/month) → cloud or on-prem for production with data
sovereignty; role-based dashboards per department; a public citizen portal.

**Privacy & governance.** Publish only aggregated cell metrics; consent + audit for any citizen-sourced
data; transparent model lineage and disclaimers (already the codebase norm).

---

## 6. Phased roadmap (outcomes, not dates)

- **P0 — Consolidate.** Unify the current overlays onto one multi-level cell substrate + manifest; prove
  end-to-end on Indore + Guna. → *One coherent substrate, not a feature sprawl.*
- **P1 — Feature store + API.** Documented per-cell schema, versioning, an Intelligence-as-a-Service
  query API, and the first IUDX adapter. → *Any ULB system can read cell intelligence.*
- **P2 — Predictive hardening.** Prithvi-backed footprints / LULC; validated growth / flood / heat with
  confidence. → *Defensible forecasts.*
- **P3 — Real-time operational.** Per-cell exposure + alerting + routing; responder dashboard. →
  *Operational early-warning, not just maps.*
- **P4 — Agentic + scenarios.** DISHA actions + scenario simulation + department dashboards. →
  *Plain-language decision support.*
- **P5 — Scale & govern.** Multi-city, NUDM / IUDX alignment, citizen portal, AaaS positioning. →
  *Deployable national-grade platform.*

---

## 7. Success metrics (ULB-relevant)

Coverage (% of ULB area with current cell data), data freshness, forecast accuracy (FoM / Kappa, flood
hit-rate), early-warning lead-time and exposure precision, revenue uplift from under-assessment flags,
service-routing efficiency, and adoption (departments live, agentic queries served).

---

## 8. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Data gaps in tier-2/3 cities | EO-first features that need no local data |
| Model trust | Pure, validated models + honest-framing disclaimers |
| Privacy | Aggregation thresholds + consent + audit |
| Adoption | Ride NUDM / IUDX / DIGIPIN rather than compete |
| Sustainability | Static-first, cheap to run; cloud only where scale demands |

---

## 9. Reuse vs build

**Reuse:** DigiPin core, the score-shard substrate, all existing models / overlays, DISHA, realtime
scrapers, the region pipeline, and the Guna scenario twin.

**Build (later phases):** the unified cell schema + versioning, the query API, IUDX / NUDM adapters,
Prithvi integration, per-cell exposure / routing, the agentic action layer, department dashboards, and
governance tooling.

---

## 10. Verification — how we'd prove it

A single-region pilot (Indore or Guna) demonstrating:

1. A cell returning fused multi-domain features via the API.
2. A validated forecast (hindcast FoM / Kappa).
3. A real-time alert with correct per-cell exposure.
4. An agentic query returning a correct action (ranked cells + route).

Plus a ULB feedback loop on one department use-case (e.g. flood exposure or tax under-assessment) as the
adoption proof.

---

## Appendix — references

- India Post DIGIPIN: official portal (indiapost.gov.in/digipin), PIB releases, ESRI India explainer.
- Policy: National Urban Digital Mission (smartcities.gov.in/nudm), IUDX (iudx.org.in), Bhuvan
  (bhuvan.nrsc.gov.in), NDEM (ndem.nrsc.gov.in).
- Patterns: discrete global grids (H3 / S2 / Geohash) as join keys; urban digital twins (Virtual
  Singapore, Helsinki 3D+, ArcGIS Urban); GeoAI (Prithvi-EO-2.0, agentic GIS, spatial knowledge graphs).
