# DIGIPIN — Deep Research Report

**Question:** Best-in-class inspiration for the DIGIPIN project — (1) the official DIGIPIN
addressing grid & its governance, (2) compelling geospatial civic-tech / open-data
visualization patterns, and (3) what makes government data/addressing products and their
explainer videos persuasive to public-sector stakeholders. Synthesized into concrete,
actionable ideas for the DigiPin web app and its explainer video.

**Method:** 5-angle fan-out web research → source fetch → adversarial confidence-grading and
contradiction-flagging → synthesis. Confidence and contradictions are preserved inline so the
team can tell verified fact from promotional noise. Date: 2026-06-17.

---

## 1. DIGIPIN — official design & governance (HIGH confidence, primary-sourced)

- **What it is:** an open-source national addressing grid assigning a unique **10-character
  alphanumeric code** to each **~4m × 4m** cell across India. Built by the **Department of
  Posts** with **IIT Hyderabad** and **ISRO/NRSC**, aligned to the **National Geospatial
  Policy 2022**. [indiapost.gov.in/digipin, github.com/INDIAPOST-gov/digipin]
- **Encoding algorithm:** bounding box **lat 2.5°N–38.5°N, lon 63.5°E–99.5°E** (EPSG:4326).
  **10-level hierarchical subdivision**, each level splitting the current box into a **4×4
  grid (16 cells)** and appending one symbol → the 10-char code. Finest cell ≈ **3.8m × 3.8m**
  (≈"4m × 4m"). [official `src/digipin.js`, en.wikipedia.org/wiki/National_Level_Addressing_Grid]
- **Symbol set (exactly 16, no vowels, no 0/1):** `2 3 4 5 6 7 8 9 C F J K L M P T`.
  The **label matrix is load-bearing** (not alphabetical):
  `row0 = F C 9 8`, `row1 = J 3 2 7`, `row2 = K 4 5 6`, `row3 = L M P T`. G/W/X were
  dropped in favour of C/F/T for phonetic/visual clarity. [official source code]
- **Deterministic & reversible & offline:** a pure function of lat/long; decodes back to the
  cell centroid; **no personal/address data stored** ("privacy-first" — location, not
  identity). [github.com/INDIAPOST-gov/digipin]
- **Display format:** **"3-4-3" grouping** for humans (e.g. `C4P 8K63 M4M`), but a
  **continuous 10-char string with NO spaces/hyphens/punctuation** for APIs/DBs.
  ⚠️ Hyphenated renderings seen on third-party blogs are **wrong** per the official README.
- **Governance / dates:** beta released for public comment **19 Jul 2024** (feedback by
  22 Sep 2024); **launched nationally 27 May 2025** with two portals — **"Know Your DIGIPIN"**
  and **"Know Your PIN Code."** Official web app: `dac.indiapost.gov.in/mydigipin` (no login).
  Reference implementation is **Node/Express, Apache License 2.0**.
  ⚠️ Some sources wrongly say **MIT** — it is **Apache 2.0**.
- **Positioning:** **complements, does NOT replace** the 6-digit PIN code (despite "goodbye
  PIN code" headlines). Targets last-mile delivery, emergency response, disaster management,
  e-commerce/logistics, and "Address-as-a-Service."

## 2. DIGIPIN adoption & use cases (MIXED confidence — promotional noise flagged)

- **Verified benefits framing (Medium):** precise addressing for rural/unaddressed areas,
  reduced return-to-origin in delivery, faster emergency response, beneficiary geotagging for
  welfare schemes (PMAY, Ujjwala, Jal Jeevan) — these are *stated/illustrative*, not confirmed
  live deployments.
- ⚠️ **LOW-confidence / unconfirmed claims to AVOID asserting:**
  - **No confirmed corporate pilots.** Lists of "Flipkart/Amazon/Swiggy/Delhivery/Google Maps
    DIGIPIN pilots" trace only to SEO blogs — **no company or primary confirmation**.
  - **RBI does NOT name/mandate DIGIPIN.** 2025 RBI KYC amendments permit geolocation-based
    address verification *in general*; blogs implying an RBI–DIGIPIN mandate **conflate two
    separate developments**.
  - The "10 million DIGIPINs by end-2025" target and specific NE-India health-camp pilots are
    **unverified**.
- **Comparison (HIGH) — DIGIPIN's genuine differentiators for the pitch:**
  - vs **what3words** (3m×3m words): w3w is **proprietary/licensed**; DIGIPIN is
    **open-source & government-run**, alphanumeric.
  - vs **Plus Codes / Open Location Code** (Google, open): conceptually closest — both open,
    deterministic, offline. DIGIPIN differs by being **sovereign/government-owned and tuned to
    India's bounding box** with a phonetically-cleaned alphabet.
  - vs **Eircode (Ireland):** database-backed random code needing lookup; DIGIPIN is
    **algorithmic — no central DB needed to decode.**
  - vs **GhanaPostGPS:** national postal digital-address system made **mandatory** and widely
    judged unsuccessful after ~8 yrs (compliance ≠ adoption). DIGIPIN is **voluntary/
    complementary** — a deliberate, defensible design contrast and the central adoption risk.

## 3. Geospatial visualization patterns (HIGH confidence)

**Choropleths / color**
- **Normalize — never map raw counts** (rates/per-capita), else you just remap population.
  [datawrapper, handsondataviz]
- **Palette ↔ semantics:** sequential for low→high, **diverging only with a real midpoint**
  (and always label the center), qualitative for categories.
- **Classification changes the map:** equal-interval (even data), quantiles (skewed), Jenks
  (compromise). Avoid arbitrary manual breaks.
- **~5–8 steps max**; rounded legend values; **ColorBrewer colorblind-safe** schemes;
  **perceptually-uniform ramps (viridis/magma) over rainbow/jet** (jet creates false
  boundaries & harms accuracy).
- **Never encode by color alone** (WCAG 1.4.1/1.4.3) — add labels/patterns/contrast.
- **"High = alarming" reverse ramp is the canonical USGS ShakeMap convention** (dark red =
  extreme). ✅ This validates our heat-map fix (tall = red).
- **Bivariate:** 3×3 (9 classes) is the practical max; blend so "both-high" corner is most
  salient; **store the combined class in the data** (enables per-cell web interactivity).

**3D / camera / scrollytelling**
- **`fill-extrusion`** reads building height straight from vector-tile attributes — fast,
  data-efficient; set **pitch + bearing** for cinematic oblique views. MapLibre natively
  supports globe, 3D terrain, custom layers.
- **Scrollytelling = map "chapters" + `flyTo`/`easeTo` keyed to scroll** (the NYT/Reuters
  pattern). `flyTo` = flight-arc zoom+pan; `easeTo` = linear.
- Cinematic moves need **position AND pitch/bearing together** (FreeCamera API; orbiting).

**Aggregation / hazard heatmaps**
- **deck.gl HexagonLayer** bins+extrudes; default ramp is ColorBrewer **YlOrRd** (the alarming
  ramp), `SUM` aggregation; set explicit `colorDomain` for cross-dataset comparability.
- **HeatmapLayer** = GPU Gaussian KDE for smooth red-hotspot density; **kepler.gl** exposes
  these with drag-and-drop.
- Implement reverse ramps via **`d3.scaleSequential(interpolateYlOrRd)`** (Observable Plot/D3).

## 4. "15-minute city" & address-to-map UX (HIGH/MEDIUM)

- **15-min city (Moreno, 2016):** 6 functions (live/work/commerce/health/education/leisure),
  4 pillars (proximity/density/diversity/digitalization).
- **Measure with network isochrones**, not radial buffers — **Euclidean buffers overestimate**
  access (ignore street connectivity). Trade-off is accuracy vs compute.
- **Tooling & hard limits (verified specs):**
  - **Mapbox Isochrone:** ≤4 contours, ≤60 min, ≤100 km, 300 req/min, **1 coord/request**.
  - **OpenRouteService:** **5 locations/request**, isochrone **intersections**, and a
    **wheelchair profile** (accessibility edge Mapbox lacks).
  - **Valhalla (OSM):** free public endpoint, self-hostable — no-cost bulk option.
  - **OSMnx** (Python): one-call network download → reachable-subgraph hull = isochrone.
- **Compelling viz:** mode toggles (walk/cycle/transit), per-amenity catchments **merged into
  one "accessible zone" per service**, "access-score" choropleths, histograms (HeiGIT DC
  walkability template). ✅ Validates our 15-minute-city scene.

**Address-to-map / "text-to-map"**
- Forward (text→coord) vs reverse (coord→text) geocoding are the two primitives.
- **Best-practice search UX = two-call `suggest → retrieve`** (suggestions carry only an id;
  coordinates fetched only on selection) — deliberately defers the lookup; cheaper than
  per-keystroke geocoding. **Address Autofill** = the "type once, fill the whole form" variant.
- **what3words** (context): **3m×3m, ~57 *trillion* squares** (⚠️ secondary sources garble
  this as "57 *billion*" — wrong); similar-sounding triples are placed on **different
  continents**, shorter words in dense cities, offensive words/homophones filtered.

## 5. Persuading public-sector stakeholders + explainer-video craft (HIGH, w/ caveats)

**Product narrative (GDS / USDS / India-Stack canon)**
1. **Lead with citizen need, not tech/org** (GDS & USDS principle #1).
2. **Frame as reusable public infrastructure** — "a register/API others build on," not "an app."
3. **"Make things open"** — open standards & interoperability are themselves selling points.
4. **"This is for everyone"** — inclusion/accessibility as a primary lever (the unaddressed:
   slums, rural, informal settlements).
5. **Use the "Digital Public Infrastructure / population-scale" frame** (India Stack, G20).
6. **One dramatic before→after unit-cost number beats vague "efficiency"** (the e-KYC
   ₹1,000→₹6 trope) — but cite it *as the Economic Survey's figure*, not audited fact.
7. **Design with data / live counters** (lookups served, area covered) as proof of scale.
8. **Procurement buyers want total value + auditability/transparency, not lowest price.**

**Explainer video**
9. **Keep it short — ≤~90s**; engagement falls past the 1–2 min band (vendor data, direction
   robust). *(Note: our current cut is 6:00 — see recommendation below.)*
10. **Hook in the first ~10s**; land the value prop within 60–90s.
11. **Structure: Hook → Problem → Solution → Proof → Vision/CTA.**
12. **Always caption / design sound-off** (≈85% of social video watched muted; captions raise
    completion) — also a gov accessibility requirement.
13. **Ground in one relatable individual, then zoom to population scale** (experience-based
    stories build more trust than abstract policy).

⚠️ **Adversarial caveat — the DPI macro-economic story is contested.** CSEP's independent
assessment estimates DPI's GDP contribution at **<1%** with no significant state-growth
correlation. **Implication:** in the pitch, lean on *verifiable* per-service gains (inclusion
reach, per-lookup cost, live adoption counters) and **avoid GDP-transformation claims** that
sophisticated stakeholders will challenge.

---

## Actionable ideas for the DigiPin app & video

**App**
- Add a **"Know Your DIGIPIN" two-call suggest→retrieve search** mirroring the official UX, and
  surface the **decode-to-centroid** path prominently (it's the system's core magic).
- Make every hazard/score layer obey **USGS reverse-ramp + colorblind-safe ColorBrewer**, with
  a labeled legend and **patterns/labels (not color alone)**. (Heat-map fix already aligns.)
- For the 15-minute-city feature, **upgrade radial buffers → network isochrones** (ORS free
  tier or self-hosted Valhalla) and show **merged per-service accessible zones** + an
  access-score choropleth; call out the wheelchair profile for an inclusion angle.
- Store **combined bivariate classes in the data** for per-cell interactivity.
- Add a **live "DIGIPINs decoded / area covered" counter** as on-page proof of scale.

**Video (recommended changes)**
- Cut a **≤90s "stakeholder" version** alongside the 6-min deep cut: **10s hook on one
  citizen's undeliverable address → DIGIPIN solution → conservative verified proof → "for
  everyone / population-scale" vision.**
- **Frame DIGIPIN honestly:** open-source (Apache 2.0), government-owned, *complements* the PIN
  code, deterministic/offline — and **explicitly contrast with proprietary what3words and
  mandatory-but-failed GhanaPostGPS** (voluntary + open is the strength).
- **Drop unverifiable adoption claims** (corporate pilots, RBI mandate, 10M target). Use only
  verified framing + live app telemetry.
- **Add burned-in captions** for accessibility/sound-off and gov-audience compliance.

---

### Confidence & contradiction ledger
- **HIGH (primary-sourced):** DIGIPIN algorithm/spec/governance/dates; viz techniques; isochrone
  API limits; geocoding UX; GDS/USDS principles.
- **Corrected misinformation:** Apache-2.0 (not MIT); *complements* (not replaces) PIN; no
  confirmed RBI mandate or corporate pilots; w3w = 57 *trillion* (not billion) squares.
- **CONTESTED:** DPI macro-economic impact (<1% per CSEP) — avoid GDP claims.
- **Vendor-sourced (direction robust, exact % indicative):** video length & captioning stats.

### Key primary sources
- DIGIPIN: indiapost.gov.in/digipin · github.com/INDIAPOST-gov/digipin · en.wikipedia.org/wiki/National_Level_Addressing_Grid
- Viz: handsondataviz.org · datawrapper.de/blog · colorbrewer2.org · earthquake.usgs.gov/education/shakingsimulations/colors.php · maplibre.org · deck.gl · joshuastevens.net
- Accessibility/isochrones: docs.mapbox.com/api/navigation/isochrone · openrouteservice.org/restrictions · geoffboeing.com · heigit.org
- Geocoding: docs.mapbox.com/api/search/search-box · what3words.com/about
- Gov-tech: gov.uk/guidance/government-design-principles · playbook.usds.gov · csep.org (DPI impact assessment) · wistia.com/learn/marketing/optimal-video-length
