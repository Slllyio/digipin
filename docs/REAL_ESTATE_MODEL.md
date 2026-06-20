# Real Estate Growth Model (live)

`js/real-estate-model.js` (`RealEstateModel`) turns a cell's **live** data into a
growth-potential score, an estimated annual-appreciation band, and a ranked list
of drivers. It is the production-safe complement to the satellite-based
`GrowthScore`: that model needs Google Earth Engine COGs that aren't shipped, so
it returns null in the deployed app — this one runs on the OSM scores, building
morphology and live flood/air signals every cell already has.

## How it works

A transparent, hedonic-style multi-factor model. Each driver is oriented so
**higher = better for value**, scored 0–100, and given a weight whose *relative*
size reflects the empirical hedonic property-value literature:

| Group | Factors (weight) | Basis |
|---|---|---|
| **Demand** | transit/connectivity (1.0), jobs/commercial (0.9), walkability (0.8), green (0.6), schools (0.6), healthcare (0.4) | Rent-gradient & transit-premium studies; Walk Score capitalisation; urban-green premiums up to ~20% |
| **Supply / leading** | development potential / FSI headroom (0.9), construction pipeline (0.8), redevelopment scope (0.5), newer stock (0.3) | Unused development rights & active pipelines lead price growth |
| **Risk (discounts)** | flood safety (0.9), air quality (0.4), quietness (0.3) | Flood-zone discounts (~9% after events); pollution/noise discounts |

- **Score** = weighted average of available factors (0–100; neutral = 50).
- **Drivers** = each factor's signed contribution `weight × (value − 50)`, ranked
  — surfaced as "Drivers" (lift) vs "Drags" (pull-down).
- **Appreciation band** = a city baseline (~6%/yr, configurable) shifted by the
  score and widened by data confidence. It is a **relative** signal, not a price
  quote.
- **Confidence** = share of the 13 factors that had live data.

Flood safety prefers the live GloFAS `peak_ratio` (from `RealtimeFlood`), falling
back to the `flood_risk` score; air quality uses the live AQI reading.

## Where it shows

- **Cell panel** — the answer-first **🏠 Property Intelligence** card
  (`real-estate-widget.js`), inserted directly under the header. It fuses the
  three previously-scattered real-estate signals: the live outlook + drivers,
  the **Building Intelligence** built-form summary (with a link to the full
  dialog), and the satellite **Growth Forecast** folded in as a "Trajectory"
  sub-section — which gracefully degrades to the live model instead of showing
  an "unavailable" card when the satellite COGs aren't present.
- **DISHA** — an outlook line is injected into the assistant's context.

## Intent profiles (Live / Invest / Build)

`INTENT_PROFILES` re-weights the factors for who's asking; the panel exposes a
toggle that re-renders the verdict live:

| Intent | Emphasis |
|---|---|
| **Live** (homebuyer) | walkability, green, schools, healthcare, quiet, flood-safe; de-emphasises construction |
| **Invest** (default) | accessibility, jobs, construction pipeline, development potential |
| **Build** (developer) | development potential / FSI headroom, redevelopment scope, pipeline |

`balanced` (all multipliers = 1) is the model default, so `outlook(data)` without
an intent — including the DISHA context — is unchanged.

## Compare view

Pinning 2–3 cells (📌 Pin) and opening Compare shows a **verdict block at the
top** — each cell's growth score (best highlighted), outlook label and
appreciation band — above the per-score table and overlay radar.

## Calibrating to real prices

Two hooks make the model calibratable instead of purely heuristic:

1. **Per-city / per-locality baseline.** Set
   `window.DIGIPIN_CONFIG.realEstateBaselines = { "Indore": 9.5, "default": 5 }`
   (annual %); the appreciation band anchors to the cell's city, so the *level*
   reflects real local market data while the model supplies the *relative* tilt.

2. **`RealEstateModel.calibrate(samples, { ridge })`** — a ridge least-squares
   fit that learns factor weights from observed appreciation. Feed
   `[{ factors: { accessibility, walkability, … }, appreciationPct }]` built from
   locality price history (MagicBricks/99acres/PropEquity per
   `RESEARCH_INTEGRATION.md` §18) and it returns `{ intercept, weights, r2, n }`.
   Those learned weights can then replace the literature-based defaults.

## Research basis

The weights are ordinal (relative), grounded in hedonic-pricing findings rather
than fit to a transaction dataset (none is bundled). To calibrate to real prices,
feed locality price/appreciation data (MagicBricks/99acres/PropEquity per
`docs/RESEARCH_INTEGRATION.md` §18) and regress the factors to learn weights.

Sources:
- [Urban green space hedonic valuation (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S016920461300162X)
- [Urban green space & housing value (Taylor & Francis)](https://www.tandfonline.com/doi/full/10.1080/19498276.2024.2432758)
- [Neighbourhood services & land values, hedonic model (Springer)](https://link.springer.com/article/10.1007/s10708-019-10127-w)
- [House prices & flood-risk exposure (Springer)](https://link.springer.com/article/10.1007/s11146-022-09930-z)
