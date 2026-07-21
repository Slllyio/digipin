# AI Agents for the DigiPin Digital City — Research & Implementation Plan

> **Status:** research + implementation plan (no application code changed by this document).
> **Scope:** how DigiPin should adopt "AI agents," grounded in the code that exists today.
> **Companion:** builds on `docs/DIGITAL_TWIN_ARCHITECTURE.md`, `docs/PRECOMPUTE_PLAN.md`, `docs/METHODOLOGY.md`.

## 0. Why this document

A widely-shared framing of the modern smart city is a **six-layer digital-twin stack**:

1. **Data Sources** — cameras, IoT sensors, drones, satellite, weather, city databases, GIS/maps
2. **Data Engineering & Integration** — ingestion → cleaning/normalization → data fusion → time-sync → geo-referencing → a unified store
3. **AI & Analytics** — machine learning, computer vision, predictive analytics, simulation models
4. **The Digital Twin** — the live map/3D model of the city
5. **Applications** — traffic, air quality, flood prediction, energy, urban planning, emergency response
6. **Decision & Action** — dashboards, alerts, recommendations, automated actions, stakeholders

The current thesis in the field is that **AI agents** — LLMs that plan, call tools, observe results, and iterate — can now absorb the "heavy lifting" that used to cost budgets and years: cleaning and translating data across systems, running simulations on demand, and turning raw signals into decisions. This document asks the concrete question: **where do agents pay off *for DigiPin specifically*, given what we have already built?**

The answer is more encouraging than a greenfield "add AI" plan, because **DigiPin is already agent-shaped at three seams.** The rest of this document is that argument, a prioritized agent portfolio, and a buildable implementation plan for the first agent.

---

## 1. DigiPin on the six-layer reference model

DigiPin is a backend-free PWA (MapLibre GL + vanilla-JS IIFE modules in `js/`), fed live per-click from free public APIs, with a Python offline pipeline (`pipeline/`) that pre-bakes scores/rasters and a scraper framework (`scrapers/`) that commits real-time JSON snapshots. Pilot city: **Indore**.

| Layer | What DigiPin has **today** | **Missing / manual / stubbed** |
|---|---|---|
| **1. Data Sources** | OSM/Overpass, Nominatim, Overture tiles (`js/data-fetcher.js`, `js/overture-buildings.js`); Open-Meteo weather/AQI/solar/flood, WAQI, OpenAQ (`scrapers/sources/openaq_india.py`); MODIS NDVI/LST, GHSL pop, GLO-30 DEM, VIIRS, Google Open Buildings (`pipeline/growth/*`, `data/heat/*`); data.gov.in, IUDX catalogue, Wikipedia; 8 disaster/quake/weather feeds (`scrapers/sources/`) | **No cameras, drones, or video.** Live IoT/sensor streaming is aspirational (IUDX real-time not wired). Live traffic speeds (TomTom/HERE) absent — traffic is a precomputed betweenness grid. Growth COGs need GEE creds; not hosted in prod. |
| **2. Data Engineering** | Scraper framework with polite client, retry/jitter, JSONL/CSV storage, and **JSON-Schema quality contracts** (`scrapers/lib/{http,storage,quality}.py`, `scrapers/sources/schemas/`); precompute tile with OSM 400 m disc-kernel counting and **golden-file JS→Python parity tests** (`pipeline/scores/`); everything keyed to DigiPin cells | **No streaming data lake / real-time fusion** — integration is batch (cron → commit). Time-sync across sensors not implemented. National coverage unbuilt (Indore-only, Phase 0). |
| **3. AI & Analytics** | Deterministic unit-tested score models (heat/growth/flood-SCS); a **CA + Random-Forest** urban-growth model (`pipeline/growth/urban_ca_ml.py`); real-estate, scenario, flood-inundation, sun-study, viewshed, isochrone models; **DISHA** LLM assistant + **Text2Map** NL→ranked-cells with MiniLM embeddings (`js/text2map*.js`) | **No computer vision** (no image/video inputs). Growth surface is a static baked raster, not live-retrained. Server-side inference absent (user supplies LLM provider). |
| **4. Digital Twin** | MapLibre grid core; deck.gl + Overture 3D fill-extrusion buildings; pitch/tilt; sun-driven lighting; DTDL/RealEstateCore twin-graph export (`js/dtdl-export.js`) | No CesiumJS/photoreal mesh (Phase 3). Main buildings PMTiles not committed. Time-series animation limited to flood. |
| **5. Applications** | Overlays for traffic LOS, air quality/NDVI, flood, solar, growth/CA/scenario, real-estate, accessibility/15-min-city, bivariate, KDE, heat, mobility, wards; disaster alerts | Emergency response is **awareness-only** (no dispatch/routing). Traffic is diagnosis, not signal control/re-routing. |
| **6. Decision & Action** | Detail panel (160+ features), scores radar, site brief (`js/site-brief.js`), query-engine ranked answers, Text2Map recommendations, real-time alerts; **DISHA can drive the map** via `[ACTION]` directives (`js/disha-actions.js`); annotations/present/pitch/report/compare/export deliverables | **No real-world actuation** (DISHA acts on the *app*, not city systems). No push/webhook/email escalation of alerts. No role dashboards / multi-user. **No feedback loop** from decisions back into models. |

**Read this table as the agent opportunity map.** The strongest layers (5, 6 in-app) are where an agent adds intelligence *now*; the manual entries in layers 1–3 are where an agent removes toil.

---

## 2. The thesis — DigiPin is already agent-ready at three seams

**Seam A — the in-app action layer already exists (but is single-shot).**
`js/disha-actions.js` is, in effect, a tool registry and dispatcher. Its `REGISTRY` maps directive types to handlers — `flyto`, `selectcell`, `overlay` (13 overlays), `query` (~40 pre-built planning intents defined across sectors in `js/query-engine.js`) — each validating its params and wrapped in try/catch. The model emits `[ACTION] <type> k:v` lines (the protocol is spelled out in the system prompt at `js/disha.js:96-101`); after the reply streams, `js/disha-panel.js` parses them, strips them from the shown text, executes them, and renders ✓/✗ confirmation chips.

What it is **not** yet: a loop. Actions run *after* the answer; their results are never fed back to the model; there is no plan→observe→continue cycle. **Closing that loop turns DISHA into an agent with very little new surface** — the tools, the parser, the validation gate, and the confirmation UI already exist.

**Seam B — the data layer is already partly autonomous.**
Two CI workflows already run without a human and self-commit with quality gates:
- `.github/workflows/realtime-scrape.yml` — 8 scrapers on a **15-minute cron**, each validated against a JSON-Schema contract (`scrapers/lib/quality.py`) before its `latest.json` is committed.
- `.github/workflows/precompute-scores.yml` — the OSM→score tile on a **monthly cron**, gated by `smoke_check.py`.

An agent here is a **supervisor**, not a builder: watch these runs, catch schema failures and data drift, and open issues/PRs.

**Seam C — the manual gaps are exactly the "heavy lifting" the field says agents can absorb.**
All Google-Earth-Engine COG extractors (`pipeline/growth/*.py`, `pipeline/heat/extract_modis_lst.py`), the CA growth model (`urban_ca_ml.py`), and the traffic/safety pipelines are run **by hand** (GEE `Export.image.toDrive` → Google Drive → move files into `data/`). Cross-city expansion is unbuilt even though `pipeline/_lib/regions.py` already defines 8 cities. This is toil an agent can drive.

---

## 3. Agent portfolio & prioritization

Recommended portfolio of four agents, prioritized. (The user asked the research to choose the focus; this is that recommendation.)

### Tier 1 — Urban Analyst Agent  ★ build first
**Layers:** 3 / 5 / 6. **Seam:** A. **Effort:** low–medium. **Risk:** low (browser-only).
Evolve DISHA from a single-shot assistant into a **closed-loop, tool-using agent** that can chain: rank candidate cells → read their data → compare them → generate a site brief → stage the map — to answer real planning questions end-to-end. Highest leverage because the seam already exists, it is immediately user-visible and demoable, and it adds no server infrastructure. **Full implementation plan in §4.**

### Tier 2a — Alert Triage & Correlation Agent
**Layer:** 6. **Seam:** B (consumes) + the actuation gap. **Effort:** medium. **Risk:** medium (delivery/escalation).
Today the 8 real-time feeds (NDMA SACHET, IMD warnings/nowcast, USGS + NCS quakes, GDACS, OpenAQ) are surfaced **in-app only**. This agent runs on a schedule, **fuses the feeds with the per-cell score tile** (`data/scores/`), and prioritizes by `population_proxy × hazard × exposure` (e.g. a flood/heat alert intersected with high-`flood_risk`, high-density cells), then drafts a ranked situational brief and **delivers it** (webhook/email/issue). This is the smallest step from "awareness" to "action," and it reuses assets that are already automated. Design sketch in §5.

### Tier 2b — Pipeline Steward Agent
**Layers:** 1 / 2. **Seam:** B + C. **Effort:** medium. **Risk:** low–medium.
A CI/GitHub-Action agent that (i) **supervises** the cron outputs — flags schema-contract failures, stale snapshots, and data drift using `scrapers/lib/quality.py` — and (ii) **scaffolds a new data source** from a dataset URL: generate `scrapers/sources/<name>.py` + `schemas/<name>.schema.json` following the framework convention, run it, and open a PR. This is the post's "data cleaning + cross-system translation" made literal, and the framework's extension seam is deliberately low-friction. Design sketch in §5.

### Tier 3 — Raster / GEE Extraction + Cross-City Precompute Agent
**Layer:** 2. **Seam:** C. **Effort:** high. **Risk:** medium–high (credentials, hosting).
Automate the manual GEE → Drive → `data/` COG pipeline (growth, heat) and drive the `regions.py` matrix to expand past Indore, honoring the parity/smoke gates. Biggest infrastructure lift (GEE service-account creds, R2/asset hosting per `docs/PRECOMPUTE_PLAN.md` phases 1–3); sequence last. Sketch in §6.

**Portfolio shape:** Tier 1 makes the city *smarter to use*; Tier 2 makes it *act and stay healthy*; Tier 3 makes it *scale*. They map cleanly onto layers 5/6 (Tier 1), 6 + 1/2 (Tier 2), and 2 (Tier 3).

---

## 4. Flagship implementation — Urban Analyst Agent (DISHA closed-loop)

This section is the buildable spec. All file/function references below were verified against the current tree.

### 4.1 Architecture

A new IIFE module **`js/disha-agent.js`** (`DISHAAgent`) owns a **ReAct loop** — *plan → act → observe → continue*. The panel stays the view layer; **all side effects remain in `DISHAActions.REGISTRY`**; the agent only sequences turns.

```
DISHAAgent.run(question, ground, hooks):
  state = initState(question, ground)          // { messages, iter:0, budget, transcript }
  while state.iter < MAX_ITERS (=4):
    turn    = await DISHA.complete(state)       // one full model turn → string
    acts    = DISHAActions.parseActions(turn)   // reuse the existing pure parser
    hooks.onAssistant(DISHAActions.stripActions(turn))   // stream visible prose
    if isFinal(turn, acts): break               // termination (see 4.3)
    results = DISHAActions.executeActions(acts, ACTIONS_PER_STEP=3)
    hooks.onChips(results)                       // reuse _renderActionChips
    obs     = buildObservation(results)          // pure → text
    state   = nextMessages(state, turn, obs)     // append assistant + observation(user); budget--
  return final stripped text
```

**New primitive — `DISHA.complete({system, messages, prompt, signal})` in `js/disha.js`.** It wraps `DISHAProviders.stream(...)`, which **already resolves to the full response string** (both `streamOllama` and `streamOpenAI` `return fullResponse`; `Text2Map.parseWithLLM` already relies on this) — so we can `await` a complete turn without re-plumbing callbacks. Unlike the existing `ask()`, `complete()` does **not** use the response cache (each loop turn is unique) and does **not** mutate `_conversationHistory` (the agent owns `state.messages`). `ask()` remains the single-shot path for non-agent questions.

### 4.2 Observation feedback

Read-tool handlers return their data (see 4.4); `buildObservation(results)` renders results to a plain-text block appended as the **next user turn**:

```
[OBSERVATION]
rankCells ok — top: 4FJ-2K-9L (health_gap=83), 4FJ-2K-8T (77), 4FK-3C-42 (71)
getCellData 4FJ-2K-9L ok — healthcare_access=18, population_proxy=88, safety=61, flood_risk=22
```

Because the channel is text, the identical loop runs on Ollama (default, prompt-based) and on Groq/Custom (messages array) with no provider-specific branching.

### 4.3 Termination

- **Primary:** a turn that emits **zero `[ACTION]` directives** is the final answer (the model has stopped calling tools and is explaining).
- **Explicit:** recognize a bare `[DONE]` marker or `[ACTION] finish` (registered as a no-op read tool, so a model trained to "call a finish tool" also terminates cleanly).
- **Hard stop:** `iter === MAX_ITERS` **or** `AGENT_BUDGET (=8 total tool calls) ≤ 0` → one forced final synthesis turn with tools disabled in the prompt ("Tools are exhausted; give your final answer now.").

### 4.4 Tool protocol — one schema, dual render

A new **pure** module **`js/disha-tools.js`** (`DISHATools`) holds a single declarative `TOOLS` array — the source of truth — and derives everything else:

- `DISHATools.renderSystemPrompt(TOOLS)` → the `[ACTION]` instruction block. **This replaces the hand-written block at `js/disha.js:96-101`**, so the prompt can never drift from the registry.
- `DISHATools.toOpenAI(TOOLS)` → an OpenAI `tools: [{type:'function', function:{name, parameters}}]` array, consumed only when the provider is OpenAI-type and a feature flag is on.
- `DISHATools.validateArgs(tool, params)` → the safety gate (4.5).

**Recommendation: keep `[ACTION]` text directives as the universal execution path; treat native function-calling as an optional accelerator.** The default provider is **Ollama**, whose `/api/generate` cannot do native tool-calls, and `streamOpenAI` today hardcodes the request body with no `tools` field and reads only `choices[0].delta.content` (ignoring `delta.tool_calls`). A text protocol that already works on every provider and is already unit-tested is the pragmatic substrate. **Phase 2** extends `streamOpenAI` to pass `tools`/`tool_choice` and accumulate `delta.tool_calls` fragments, normalizing them onto the **same** `DISHAActions.REGISTRY` — native and text tool-calls converge on one dispatcher.

### 4.5 Tool registry expansion

Extend the handler contract: a handler may return a **string** (state-changing, label only, as today) or **`{label, observation}`** (read tools that feed data back). `executeActions` attaches `observation` to its result objects; the per-action try/catch and `slice(0, max)` cap are unchanged.

| Tool | kind | Wraps (verified) |
|------|------|-------|
| `rankCells` | read+state | `Text2Map.run(question, bounds)` (`js/text2map.js:280`) → `Text2MapResultsLayer.show`. Inherits Text2Map's `validateWeights` allowlist (`js/text2map.js:69`) for free. Observation = top-N `{code, score}`. |
| `getCellData` | read | `DISHACache.getCellData(lat,lng)` (`js/disha-cache.js:175`), fallback `DataFetcher.fetchAllFeatures` (`js/data-fetcher.js:640`); `DigiPin.decode(code)` for coords. Observation = that cell's non-zero scores. The read-back tool. |
| `compareCells` | read+state | `Compare.pin` + `Compare.compareBriefModel(pinned)` (`js/compare.js:423`, exported :523). Module caps at `MAX_PINS=3`. Observation = the metric matrix. |
| `generateSiteBrief` | read+state | `SiteBrief.build(cellData, cell)` + `SiteBrief.narrative(model)` (`js/site-brief.js:41,109`) — both pure, so no DOM needed for the loop. |
| `runIsochrone` | state | `Isochrone.show(lat,lng)` (`js/isochrone.js:60`). Offline, synchronous. |
| `scenarioWhatIf` | read | `ScenarioModel.adjust(scenario, ctx)` + `ScenarioModel.summarize(cells)` (`js/scenario-model.js:33,63`) for read-back; `ScenarioPanel.toggle` for the visual overlay. |

Existing `flyto` / `selectcell` / `overlay` / `query` are unchanged (state-changing, label-only). Note: `matchQueryId` (used to map a question to a canned `query` id) lives in `js/disha.js:620`, not in `query-engine.js`.

### 4.6 Safety

- **Argument validation** — `DISHATools.validateArgs` mirrors `Text2Map.validateWeights` (`js/text2map.js:69`): drop unknown arg keys, coerce/clamp types, and validate `digipin`-typed args against the `23456789CFJKLMPT` alphabet (the same check `js/disha-panel.js` uses when linkifying codes). `rankCells` inherits Text2Map's anti-hallucination gate automatically.
- **Containment** — keep the existing per-action try/catch and `slice(0, max)` cap in `executeActions`; one bad tool cannot break the turn.
- **Read vs. state** — the `kind` field lets the loop call read tools freely up to budget while **capping map-mutating tools harder (≤ 2 per run)** so the agent cannot thrash the camera/markers. `compareCells` already self-caps at `MAX_PINS=3`.
- **Budget** — `AGENT_BUDGET` (total tool calls across all iterations, e.g. 8) on top of `ACTIONS_PER_STEP=3` and `MAX_ITERS=4`.
- **Auditability** — the agent re-renders `DISHAPanel._renderActionChips` after **every** iteration, so each tool call is visible ✓/✗ in-UI, not hidden.
- **Client-side key exposure** *(call-out)* — Groq/Custom keys live in `localStorage` (`disha_provider_config`) and are sent from the browser; a multi-step loop multiplies request count (≥ 4 turns + a parse call per `rankCells`), raising cost, rate-limit pressure, and key exposure. **Mitigations:** keep Ollama the default, gate the agent behind an explicit toggle, cap `MAX_ITERS`, and recommend a server-side proxy for shared deployments (the repo already has the `DataFetcher`/Cloudflare-Worker proxy pattern to model on).

### 4.7 Files

**Create**
- `js/disha-agent.js` — `DISHAAgent`: the loop + **pure** helpers `initState`, `buildObservation`, `isFinal`, `nextMessages` (exported for tests).
- `js/disha-tools.js` — `DISHATools`: `TOOLS` schema, `renderSystemPrompt`, `toOpenAI`, `validateArgs` (all pure).
- `tests/disha-agent.test.js`, `tests/disha-tools.test.js`.

**Modify**
- `js/disha-actions.js` — register new tools; extend return contract to `{label, observation}`; thread `validateArgs`; keep cap + try/catch.
- `js/disha.js` — add `complete()`; replace the `[ACTION]` block (`96-101`) with `renderSystemPrompt(...)`; add an agent-mode branch alongside `detectIntent`.
- `js/disha-panel.js` — in `send()` route agent-eligible questions to `DISHAAgent.run(...)`; refactor the `onDone` parse→strip→execute→chips block so it is reused **per iteration**.
- `js/disha-providers.js` — *(Phase 2 only)* `streamOpenAI` gains `tools`/`tool_choice` passthrough and `delta.tool_calls` accumulation.
- `app.html` — add two `<script defer>` tags for `js/disha-tools.js` and `js/disha-agent.js` **before** `js/disha-panel.js`.
- `tests/setup.js` — expose the new globals (and `text2map.js` / `site-brief.js` / `isochrone.js` if not already) for vitest.

**Extend**
- `tests/disha-actions.test.js` — cases for each new handler (stub `Text2Map`, `Compare`, `SiteBrief`, `Isochrone`, `DISHACache` on `globalThis` exactly as it already stubs `MapModule`/`HeatOverlay`/`WardOverlay`/`OvertureBuildings`); assert read tools return `{label, observation}` and that `validateArgs` rejects hallucinated keys / bad DIGIPIN codes.

**Testable pure surfaces** (kept side-effect-free by design): `buildObservation`, `isFinal`, `nextMessages`, `renderSystemPrompt`, `toOpenAI`, `validateArgs` — mirroring the repo's existing "pure functions are unit-tested" convention in `disha-actions.js`.

### 4.8 Worked example

**User:** *"Where should the city add a new primary health centre, and why?"*

`send()` detects an agent-eligible question (matches the `/where\s+should/`-style intent in `detectIntent`, `js/disha.js:562`) → `DISHAAgent.run(question, ground={cell,data,bounds})`.

- **Iter 1 — plan/act.** `I'll find under-served, high-population cells.`
  `[ACTION] rankCells brief:"health-centre gap: high population, low healthcare access, good road connectivity"`
  → `Text2Map.run` over the viewport; `parseWithLLM`→`validateWeights` yields weights over real ids (`population_proxy`↑, `healthcare_access`↓, `connectivity`↑); results painted.
  **Observation:** `top: 4FJ-2K-9L (gap=83), 4FJ-2K-8T (77), 4FK-3C-42 (71)`. Budget 7.
- **Iter 2 — observe/act.** `[ACTION] getCellData code:4FJ-2K-9L` ×3.
  **Observation:** per-cell `healthcare_access`, `population_proxy`, `safety`, `flood_risk`, `connectivity`. Budget 4.
- **Iter 3 — observe/act.** `[ACTION] compareCells code:4FJ-2K-9L code:4FJ-2K-8T code:4FK-3C-42`.
  **Observation:** metric matrix; #1 has the largest healthcare deficit *and* highest population with low flood risk. Budget 3.
- **Iter 4 — commit + finish.** `[ACTION] generateSiteBrief code:4FJ-2K-9L` + `[ACTION] selectCell code:4FJ-2K-9L`, then prose + `[DONE]`.
  `isFinal()` true → loop exits; the panel shows the narrative plus per-iteration ✓/✗ chips — a fully auditable chain from ranking → read-back → comparison → brief.

---

## 5. Tier-2 design sketches

### 5.1 Alert Triage & Correlation Agent
**Run as** a scheduled GitHub Action (reusing the `realtime-scrape.yml` cadence) or a small worker — **not** in the browser.
**Inputs:** `data/realtime/*/latest.json` (already committed by the scrapers) + `data/scores/<region>/*.json`.
**Loop:** read active alerts → for each, spatially intersect its area with the score tile → score priority `= population_proxy × hazard_severity × exposure` (e.g. `flood_risk` for GloFAS/IMD flood, heat-score for heatwave, proximity for quakes) → the LLM drafts a ranked, human-readable brief with the top affected DigiPin cells and a recommended action → **deliver** via webhook/email/GitHub issue.
**Reuses:** `js/realtime-alerts.js`, `js/realtime-flood.js`, `js/realtime-quakes.js`, `js/realtime-imd.js` (for the parsing/severity logic to port), the score tile, and the scraper quality contracts.
**Trust boundary:** this drafts and *notifies*; it does not actuate city systems. Keep a human approval step before any external dispatch integration.

### 5.2 Pipeline Steward Agent
**Run as** CI (on cron-run completion) + an on-demand "onboard a source" action.
**Supervise:** after each `realtime-scrape.yml` / `precompute-scores.yml` run, check freshness (`generated_at_iso`), re-run `scrapers/lib/quality.py` contracts, and detect drift (row-count / null-rate deltas vs. the previous snapshot); on failure, open an issue or a fix PR.
**Scaffold:** given a dataset URL, generate a conforming `scrapers/sources/<name>.py` (`SOURCE_ID`, `FEED_URL`, a `Record` dataclass with `csv_fields()`, `fetch(client)`, `key_for()`) + `schemas/<name>.schema.json`, wire the CI matrix entry, run it once, and open a PR — the `scrapers/README.md` convention is the spec the agent follows.
**Guardrails:** honor the README's ToS rules (e.g. no commercial property-site scraping); every generated source must pass the schema + `test_snapshot_quality.py` gates before the PR is opened.

---

## 6. Tier-3 sketch — GEE / raster automation + cross-city precompute

**Goal:** remove the last manual step and scale past Indore.
**Automate the COG dance:** wrap the GEE extractors (`pipeline/growth/extract_*.py`, `download_temporal_gcs.py`, `pipeline/heat/extract_modis_lst.py`) with a service-account auth flow so exports land directly in object storage instead of a human's Google Drive; validate band counts/geotransforms; commit or host the COGs.
**Cross-city matrix:** drive `pipeline/_lib/regions.py` (8 cities already defined) through `build_tile.py` + `smoke_check.py`, honoring the golden-file parity gates, one PR per city.
**Prerequisites:** GEE service-account credentials, R2/asset hosting (per `docs/PRECOMPUTE_PLAN.md` phases 1–3), and CI runners that can reach Geofabrik/GEE. This is the highest-infrastructure item — do it once Tiers 1–2 have proven the pattern.

---

## 7. Cross-cutting concerns

- **Agent runtime & tool schema.** One declarative `TOOLS` source (`js/disha-tools.js`) rendered to both the text protocol and native function-calling keeps the in-app agent honest; the Tier-2/3 agents can reuse the same *conceptual* registry server-side.
- **Safety model.** Allowlist-validated args (the `validateWeights` pattern), read/state tool separation with per-run mutation caps, bounded iterations/budget, and human-visible confirmation are the four pillars; the awareness→actuation boundary stays human-gated until explicitly productized.
- **Provider / cost / latency.** Ollama (local, free, private, no native tools) is the safe default; Groq (fast, cheap, native tools) is the cloud accelerator; a server proxy is the right answer for any shared/public deployment (keys must not ship to browsers at scale).
- **Evaluation.** Adopt the repo's **golden-file** culture for agents: record canonical transcripts and assert the **pure** loop-state functions (`buildObservation`, `isFinal`, `nextMessages`) and `validateArgs` are deterministic — the same discipline `pipeline/scores/` uses for JS↔Python parity.

---

## 8. Phased roadmap

| Phase | Deliverable | Entry criteria | Demoable outcome |
|---|---|---|---|
| **P0** | Urban Analyst Agent — text-protocol loop (§4, minus Phase-2 native tools) | none (all seams exist) | DISHA answers a multi-step planning question end-to-end with visible tool chips |
| **P1** | Native function-calling on OpenAI-type providers **+** Alert Triage Agent (§5.1) | P0 shipped; a webhook/email target chosen | Faster/cleaner tool-calls on Groq; a scheduled situational brief delivered |
| **P2** | Pipeline Steward Agent (§5.2) | P1; CI agent runner available | Auto-flagged data failures; a new source onboarded via PR |
| **P3** | GEE/raster automation + cross-city precompute (§6) | GEE creds + hosting provisioned | Growth/heat COGs refreshed without a human; a second city live |

---

## 9. Risks & open questions

- **Client-side API keys & cost** — multi-step loops multiply requests; keep Ollama default, gate the agent, and move to a proxy for shared deploys. *(§4.6)*
- **Hallucinated tool arguments** — mitigated by the `validateArgs` allowlist inherited from `Text2Map.validateWeights`.
- **Map thrash** — mitigated by the read/state split and the ≤ 2 map-mutations-per-run cap.
- **Actuation trust** — Tier-2 agents draft and notify; real dispatch/control stays human-approved until a deliberate productization step.
- **Where should Tier-2/3 agents live** — CI (cheapest, already present) vs. a new lightweight always-on service? Open decision; CI is recommended first.
- **Scope of "agent-eligible"** — which questions route to the loop vs. the fast single-shot `ask()`? Start narrow (explicit "where should…/compare…/plan…" intents) and widen with evidence.

---

*This document changes no application code. It specifies the work; §4 is ready to hand to a build session, starting with P0.*
