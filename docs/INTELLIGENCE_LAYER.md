# DigiPin Urban Intelligence — implementation notes

This documents the intelligence layer built on the DigiPin substrate, realising the
pillars in [`URBAN_INTELLIGENCE_BLUEPRINT.md`](./URBAN_INTELLIGENCE_BLUEPRINT.md).
Everything keys to a **DigiPin cell** — the universal join key — and degrades
gracefully (modules no-op when their data/deps are absent).

## Module stack (load order in `app.html`, precached in `sw.js`)

| Module | Global | Pillar | Role |
|--------|--------|--------|------|
| `js/digipin.js` | `DigiPin` | L0 | Spec-accurate encode/decode + hierarchy |
| `js/precomputed-scores.js` | `PrecomputedScores` | L2 | Per-cell score shards (O(1) lookup) |
| `js/feature-store.js` | `DigiPinIntel` | **P1** | Unified per-cell record + ranking + schema |
| `js/intelligence-indices.js` | `IntelIndices` | **P2** | Composite indices (diversified use cases) |
| `js/cell-exposure.js` | `CellExposure` | **P3** | Live-hazard per-cell exposure & priority |
| `js/disha-agent.js` | `DishaAgent` | **P4** | Agentic municipal skills over the above |
| `js/disha-actions.js` | `DISHAActions` | **P4** | `[ACTION] agent skill:…` execution |
| `js/cell-routing.js` | `CellRouting` | **P6** | Evacuation routing (at-risk → nearest safe cell) |
| `js/utility-estimates.js` | `UtilityEstimates` | **P9** | Estimated electricity/water/waste/solar + supply stress |
| `js/priority-analysis.js` | `PriorityAnalysis` | **P13** | MCDA "where to act" playbooks (drainage/clinics/schools/parks/transit/…) |
| `js/intel-report.js` | `IntelReport` | **P7** | ULB brief + Intelligence-as-a-Service JSON payload |
| `js/intel-panel.js` | `IntelPanel` | **P8** | Floating UI panel: indices, flags, agent box, export, paint chips |
| `js/intel-map-layer.js` | `IntelMapLayer` | **P10–12** | Map render: choropleth (legend, auto-fit, click-through), routes, heatmap |

All scoring/planning helpers are **pure and unit-tested** (`tests/feature-store`,
`intelligence-indices`, `cell-exposure`, `disha-agent`).

## API surface

```js
// Feature Store — one fused record per cell (always returns a DigiPin address)
const rec = await DigiPinIntel.cell(22.72, 75.86);
//   { digipin:{code, levels:{6,8,10}}, geometry, region, available, features:{…20}, domains }
DigiPinIntel.rank(cells, { flood_risk: 1, population_proxy: 0.5 });   // polarity-aware
DigiPinIntel.schema();                                                // field + domain catalogue

// Composite indices (transparent signed-weight blends + explainable drivers)
IntelIndices.all(rec.features);            // livability, climateResilience, disasterRisk,
                                           // serviceGap, investmentPotential, economicVitality, sustainability
IntelIndices.compute(rec.features, 'disasterRisk');   // { value, band, highMeans, drivers }

// Real-time exposure (operational)
const hazard = CellExposure.hazardProfile(alert);     // {kind, severity, weight}
CellExposure.rank(cells, hazard);                     // ranked w/ Critical/High/Moderate/Low
await CellExposure.assess(bounds, { city: 'Indore' });// viewport × live alerts → ranked exposure

// Agentic skills (DISHA can emit these, or call directly)
await DishaAgent.ask('where is flood risk highest?'); // NL → plan → ranked cells + map actions
await DishaAgent.run('scenario', { code, field: 'green', delta: 30 });
```

DISHA invokes skills in-chat via directives, e.g.
`[ACTION] agent skill:serviceGaps top:10` — parsed/executed by `DISHAActions`.

## Diversified use cases (what a ULB can now ask)

| Department | Index / skill |
|------------|---------------|
| Town planning | `livability`, `sustainability`; `findCells`, `scenario` (what-if) |
| Climate adaptation | `climateResilience`; `findCells` |
| Disaster management | `disasterRisk` + `CellExposure` live ranking; `exposure` + `evacuate` skills (route at-risk → nearest safe cell) |
| Works / equity | `serviceGap`; `serviceGaps` skill |
| Revenue / economy | `investmentPotential`, `economicVitality`; `findCells` |
| Utilities / energy | `UtilityEstimates` (electricity, water, waste, rooftop-solar, carbon, supply stress); `utilities` skill |
| Any (front office) | `assessCell` brief, `compareCells` site selection; the **Urban Intelligence panel** + JSON export |

## Governance

- **Transparency:** every index is a published, signed-weight blend (`IntelIndices.DEFS`);
  results carry `drivers`. Exposure vulnerability mapping is field-driven and documented.
  No black-box scores.
- **Honest framing:** retained from the platform norm — exposure is relative within a
  text-matched area until CAP polygons are parsed; forecasts are screening-grade.
- **Privacy:** only aggregated per-cell metrics are surfaced; no PII at cell level. Any
  citizen-sourced data must be consented + audited before joining the cell record.
- **Interoperability:** the cell code is the foreign key for IUDX/NUDM/Bhuvan/NDEM joins;
  the Feature Store schema (`DigiPinIntel.schema()`) is the contract.

## Extending

- **New region:** add a bbox to `pipeline/_lib/regions.py`, run the scores pipeline →
  `coverage.json` auto-discovers it; the whole intelligence layer works with no JS change.
- **New index:** add an entry to `IntelIndices.DEFS` (id, label, highMeans, signed weights)
  + a test. It immediately appears in `all()` and is selectable by `findCells`.
- **New agent skill:** add an executor to `DishaAgent.EXEC` + a `skills()` entry + teach the
  DISHA prompt; the `[ACTION] agent` plumbing already routes to it.

Verified end-to-end on the Indore pilot: a real DigiPin cell returns 20 fused features,
indices compute, and the agent ranks real cells from plain-language questions.
