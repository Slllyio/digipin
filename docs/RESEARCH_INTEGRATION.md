# DigiPin Urban Intelligence Portal — Research Integration Document

**Version**: 1.0
**Date**: 2026-03-07
**Project**: DigiPin Urban Intelligence Portal — Indore Pilot
**Status**: Active Reference — Do Not Archive

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Data Source Priority Matrix](#2-data-source-priority-matrix)
3. [Score-to-Source Mapping](#3-score-to-source-mapping)
4. [DISHA LLM Architecture](#4-disha-llm-architecture)
5. [Missing Dimensions](#5-missing-dimensions)
6. [Implementation Roadmap](#6-implementation-roadmap)
7. [API Reference](#7-api-reference)

---

## 1. Executive Summary

### What We Have Built

The DigiPin Urban Intelligence Portal converts any 4x4m grid cell in India (identified by its 10-character DigiPin code) into a structured urban intelligence profile. The current system delivers:

- **160+ OSM features** classified into 13 categories (food, education, healthcare, finance, shopping, transport, government, leisure, entertainment, accommodation, landuse, infrastructure, business)
- **19 computed intelligence scores** (0-100 scale) derived from raw feature counts
- **4 real-time environmental signals** (temperature, humidity, AQI, UV index) from Open-Meteo and WAQI
- **Reverse geocoding** via Nominatim for human-readable addresses
- **Wikipedia cultural context** for nearby landmarks
- **Local LLM integration** via Ollama (Llama 3.1 8B) with sparse context encoding
- **12 urban planning query modes** for comparative analysis across visible map area

### What We Learned from Research

The following findings shaped this document and must guide all future development decisions:

**Finding 1 — OSM Data Quality is the Primary Constraint**
Overpass API coverage in Tier 2 and Tier 3 Indian cities (including Indore) is sparse compared to metro cities. In residential micro-neighborhoods, features like street lamps, cell towers, and coworking spaces are severely underrepresented. Scores derived purely from OSM counts have a systematic downward bias in lower-density areas. All scores should be interpreted as relative, not absolute.

**Finding 2 — AQI Data Resolution is Wrong**
The current WAQI integration uses a city-level AQI station lookup, which returns pollution readings for the city center regardless of the cell's actual location. A PM2.5 station in Palasia (Indore center) is used for cells in Mhow or Pithampur. This is misleading for users comparing cells across a city.

**Finding 3 — Flood Risk is a Critical Missing Dimension**
No current score captures flood or waterlogging risk. For real estate decisions and urban planning in Indore (which has a history of urban flooding in low-lying areas near Khan River), the absence of elevation + drainage data is a major gap that reduces the portal's credibility for homebuyer use cases.

**Finding 4 — Scores Lack Relative Calibration**
All 19 scores are computed from absolute feature counts against fixed normalization ceilings (e.g., `normalize(count, 30)`). A cell with 10 restaurants in a city that averages 2 per cell should score very differently than a cell with 10 restaurants in a city that averages 15. The current implementation does not capture relative density.

**Finding 5 — DISHA Context is OSM-Biased**
The DISHA context injection string contains only OSM features, weather, and AQI. It does not include elevation, land classification from ISRO/Bhuvan, property transaction data, or census population density. These additions would dramatically improve the quality of homebuyer and investment-oriented queries.

**Finding 6 — Real-Time Traffic and Mobility Data is Missing**
Connectivity Score relies solely on static transport infrastructure (bus stops, metro stations) from OSM. It has no dynamic signal — it cannot tell whether a location is actually well-connected at rush hour, or whether public transport is frequent.

**Finding 7 — Property Price Signals are Absent**
For the real estate growth score, the current proxy uses construction activity (OSM `landuse=construction`) and estate agents. This is a noisy signal. MagicBricks, 99acres, and PropEquity publish property price trends that could directly feed this score.

---

## 2. Data Source Priority Matrix

Each source is rated on two axes:
- **Impact**: How much does adding this source improve score accuracy or unlock new use cases?
- **Integration Effort**: Developer-days to wire into the existing DataFetcher pipeline

### Tier 1 — Integrate Immediately (High Impact, Low Effort)

| Source | Data Provided | Impact | Effort | Reason for Priority |
|--------|--------------|--------|--------|---------------------|
| **Open-Meteo** (current) | Weather, UV index | High | Done | Already integrated — expand to hourly forecasts and precipitation history |
| **Overpass API** (current) | 160+ OSM POI features | Very High | Done | Core data source — optimize query batching and add missing tags |
| **Nominatim** (current) | Address, admin boundaries | High | Done | Working — add ward-level boundary detection |
| **WAQI API** (upgrade) | AQI by geo-coordinates, not city name | High | 1 day | Replace city-name fallback with registered token + geo query |
| **Open-Meteo Historical** | Precipitation totals, flood-proxy | High | 1 day | Monthly rain accumulation as flood risk proxy — free, no key |
| **Wikipedia Geosearch** (current) | Cultural context | Medium | Done | Already integrated — increase search radius to 5km |

### Tier 2 — Integrate in Phase 2 (High Impact, Medium Effort)

| Source | Data Provided | Impact | Effort | Notes |
|--------|--------------|--------|--------|-------|
| **ISRO Bhuvan WMS** | Land use/land cover (LULC), soil type | Very High | 3-5 days | Free, government source, covers all of India at 30m resolution |
| **SRTM / Copernicus DEM** | Elevation, slope, flood basin detection | Very High | 3-5 days | 30m DEM tiles available free from NASA/ESA; elevation is critical for flood risk |
| **India Census 2011 API** | Ward-level population density, literacy | High | 2-3 days | Government open data; DataMeet has structured JSON |
| **MagicBricks / 99acres** | Property price per sq ft by locality | High | 3-5 days | No official API; requires scraping or data partnership |
| **GHSL (Global Human Settlement Layer)** | Built-up density, population grid at 100m | High | 2 days | Free EU JRC data; resolves OSM population proxy inaccuracy |
| **OpenCelliD** | Cell tower density, network coverage | Medium | 2 days | Free tier: 1000 requests/day; improves Digital Readiness score |

### Tier 3 — Integrate in Phase 3 (Strategic / Complex)

| Source | Data Provided | Impact | Effort | Notes |
|--------|--------------|--------|--------|-------|
| **RERA India** | Registered real estate projects, possession dates | Very High | 1-2 weeks | State-specific portals (MP RERA for Indore); no unified API |
| **NITI Aayog SDG Dashboard** | District-level development indices | Medium | 3-5 days | Useful for relative city comparison |
| **PropEquity / Liases Foras** | Transacted property price history | High | 2 weeks | Paid data; requires commercial agreement |
| **Google Maps Places API** | Richer POI data, ratings, review counts | Very High | 1 week | $17 per 1000 requests (Nearby Search); significant cost at scale |
| **Zomato / Swiggy API** | Active restaurant density, cuisine type | Medium | 1 week | Unofficial APIs; ToS risk |
| **IIFL / Housing Finance** | Home loan inquiry density by PIN | High | 2 weeks | Requires data partnership |
| **Twitter/X Firehose** | Hyperlocal event signals, complaints | Medium | 3 weeks | High cost and complexity; not MVP-critical |
| **Indore Smart City Dashboard** | City-specific sensor data (traffic, flood sensors) | Very High | 2-4 weeks | Requires formal partnership with IMC |

---

## 3. Score-to-Source Mapping

This section maps each of the 19 computed intelligence scores to the best data sources for computing them — current and proposed.

### Score 1: Walkability Score

**Current Formula**: restaurants + cafes + convenience stores + supermarkets + bus stops + parks + footpaths (normalized to 30)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | POI counts within 500m | Baseline |
| Phase 2 | GHSL | Built-up density grid | Corrects for low OSM coverage in dense areas |
| Phase 2 | SRTM DEM | Slope gradient | Penalize steep terrain that impedes walkability |
| Phase 3 | Google Maps Places | Place counts + ratings | Supplement sparse OSM areas |

**Score Formula Upgrade**:
```
walkability = normalize(
  osm_walkable_pois * osm_coverage_weight +
  ghsl_population_density * 0.3 +
  slope_penalty,           // -10 for slope > 10 degrees
  calibrated_city_ceiling  // derived from city-wide distribution, not fixed 30
)
```

### Score 2: Safety Index

**Current Formula**: police * 10 + fire * 10 + street_lamps + hospitals * 5 (normalized to 50)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Police, fire, hospitals | Baseline — very sparse in OSM India |
| Phase 2 | Census 2011 | Literacy rate, poverty index | Social safety proxy |
| Phase 3 | NCRB Crime Data | Ward-level crime statistics | Direct safety signal |
| Phase 3 | Indore Smart City | CCTV density | Infrastructure safety proxy |

**Known Issue**: Police stations are severely under-tagged in Indian OSM. A score of 0 almost always means "no data" not "no police presence." Add a data_confidence field to every score.

### Score 3: Green Index

**Current Formula**: parks * 5 + gardens * 3 + water bodies * 5 + nature reserves * 10 (normalized to 40)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Park polygons | Baseline |
| Phase 2 | ISRO Bhuvan LULC | Vegetation classification at 30m | Detects greenery without OSM tags |
| Phase 2 | Sentinel-2 NDVI | Normalized Difference Vegetation Index | Actual canopy cover, not just tagged parks |
| Phase 2 | Copernicus Urban Atlas | Tree cover density | Precise urban tree classification |

**High Priority**: NDVI via Sentinel-2 (available free from Copernicus Open Access Hub) would transform this score. A 100m NDVI tile can be computed in < 200ms via Google Earth Engine or the Copernicus Data Space REST API.

### Score 4: Connectivity Score

**Current Formula**: bus_stops * 2 + metro * 15 + railway * 10 + parking * 2 + roads (normalized to 50)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Static transport infrastructure | Baseline |
| Phase 2 | GTFS India | Bus route schedules, frequency | Dynamic service frequency (not just stop existence) |
| Phase 2 | OpenCelliD | 4G/5G tower density | Adds network connectivity dimension |
| Phase 3 | HERE / TomTom | Real-time traffic flow | Rush-hour accessibility |

**Note**: Indore has an AMTS (Atal Bus Service) GTFS feed — check for public availability. If published, bus frequency within 400m is a far better connectivity signal than a static stop count.

### Score 5: Commercial Vibrancy

**Current Formula**: malls * 10 + supermarkets * 3 + restaurants * 2 + offices * 3 + marketplaces * 5 (normalized to 50)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Commercial POI counts | Baseline |
| Phase 2 | GST Registration Data | Active business count by PIN code | Official business density signal |
| Phase 2 | GHSL | Built-up commercial area | Corrects for untagged commercial zones |
| Phase 3 | MagicBricks | Commercial property price/sqft | Price as vibrancy proxy |

### Score 6: Education Index

**Current Formula**: schools * 5 + colleges * 8 + universities * 15 + libraries * 5 (normalized to 50)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | OSM-tagged institutions | Baseline |
| Phase 2 | UDISE+ | Verified school enrollment, infrastructure ratings | Quality signal, not just count |
| Phase 2 | UGC AISHE | Accredited college/university list | Verified institution existence |
| Phase 3 | Census 2011 | Ward-level literacy rate | Population education level proxy |

### Score 7: Healthcare Access

**Current Formula**: hospitals * 10 + clinics * 3 + pharmacies * 2 + labs * 5 (normalized to 40)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Healthcare POIs | Baseline |
| Phase 2 | NHA (National Health Authority) | Empaneled hospital list, bed count | Quality and capacity signal |
| Phase 2 | CGHS Empaneled Hospitals | Government-verified hospitals | Verification layer |
| Phase 3 | HFR (Health Facility Registry) | All registered health facilities | Definitive national registry |

**Action Item**: India's Health Facility Registry (HFR) under Ayushman Bharat is a public API — register for an access key. It covers all hospitals including private and AYUSH facilities that OSM misses.

### Score 8: Entertainment Score

**Current Formula**: cinemas * 5 + parks * 3 + gyms * 3 + nightclubs * 5 + museums * 8 (normalized to 40)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Leisure POIs | Baseline |
| Phase 3 | BookMyShow API | Event density by area | Dynamic entertainment activity |
| Phase 3 | Google Places | Venue ratings, review volume | Quality signal |

### Score 9: Livability Index

**Current Formula**: Weighted average of walkability + safety + green + connectivity + healthcare + noise

This is a composite score — improving its input scores automatically improves livability. No new direct sources needed beyond what feeds the component scores.

**Formula Upgrade**: Replace equal weighting with a citizen-preference model. Homebuyers weight safety and green space highest; urban planners weight connectivity and healthcare. Expose weight sliders in the UI.

### Score 10: Investment Potential

**Current Formula**: construction * 10 + vacant * 5 + bus_stops * 2 + metro * 15 + coworking * 5 (normalized to 50)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Construction, vacant land | Weak proxy — OSM construction tags are rare |
| Phase 2 | RERA MP | Approved projects, completion dates | Definitive construction pipeline |
| Phase 3 | MagicBricks / 99acres | Price appreciation YoY by locality | Direct investment return signal |
| Phase 3 | SBI / LIC HFL | Loan disbursement density | Demand signal |

### Score 11: Tourism Appeal

**Current Formula**: hotels * 3 + monuments * 5 + museums * 8 + attractions * 5 + restaurants (normalized to 40)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Tourism-tagged POIs | Baseline |
| Phase 2 | India Tourism Statistics | Footfall at monuments | Demand signal |
| Phase 3 | TripAdvisor / Google Tourism | Ratings, review volume | Quality signal |

### Score 12: Infrastructure Maturity

**Current Formula**: street_lamps + cell_towers * 5 + power * 10 + post_offices * 5 + roads (normalized to 50)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Infrastructure POIs | Very sparse in Indian OSM |
| Phase 2 | OpenCelliD | Verified tower locations | Replaces OSM cell_tower count |
| Phase 2 | TRAI Coverage Maps | Network signal strength grid | Telco coverage supplement |
| Phase 2 | ISRO Bhuvan | Road network density | Verified road data |

### Score 13: Noise Estimate (Quietness)

**Current Formula**: 100 - normalize(bus_stops * 2 + industrial_areas * 10 + railway * 10 + nightclubs * 5, 40)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Noise-generating infrastructure | Proxy only |
| Phase 2 | SRTM DEM + road network | Traffic volume estimation via road type and ADT | Better proxy than raw bus stop count |
| Phase 3 | OpenSoundscape / EAR | Crowd-sourced noise measurement | Actual decibel readings |
| Phase 3 | Indore Smart City sensors | IoT noise monitoring (if available) | Real signal |

### Score 14: Population Density (Proxy)

**Current Formula**: residential_buildings * 3 + total_buildings / 10 + convenience_stores * 5 (normalized to 50)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Building counts | Highly inaccurate — OSM buildings are incomplete |
| Phase 2 | GHSL GHS-POP | 100m resolution population grid | Best free replacement — EU JRC, CC-BY |
| Phase 2 | Census 2011 Ward Data | Ward-level population | Admin-level ground truth |
| Phase 3 | Facebook / Meta HRSL | 30m resolution population estimates | Highest resolution available |

**Critical Upgrade**: GHSL GHS-POP replaces the current OSM building count proxy with actual modeled population at 100m resolution. This single addition improves 6 other scores that weight by population.

### Score 15: Food Diversity

**Current Formula**: restaurants + cafes + fast_food + bakeries + bars + ice_cream (normalized to 20)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Food POI counts | Baseline — reasonable coverage in Indian OSM |
| Phase 3 | Zomato / Swiggy | Active listings, cuisine tags | Cuisine diversity signal |

### Score 16: Religious Diversity

**Current Formula**: places_of_worship count (normalized to 10)

This score is a count, not a diversity measure. A cell with 5 temples and 0 mosques scores 50 — same as a cell with 3 temples, 1 mosque, and 1 church. This must be fixed.

**Formula Upgrade**:
```
religious_diversity = f(
  distinct_religion_types_count,  // OSM religion= tag
  total_worship_count,
  shannon_diversity_index          // H = -sum(p_i * log(p_i))
)
```

### Score 17: Public Service Access

**Current Formula**: post_offices * 5 + govt_offices * 5 + community_centers * 3 + toilets * 2 (normalized to 30)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Civic POIs | Baseline |
| Phase 2 | India Post GIS | Post office locations (verified) | India Post is the DigiPin authority — their data is authoritative |
| Phase 2 | Jan Seva Kendra list | CSC (Common Service Centre) locations | Major government service access point missing from OSM |

### Score 18: Real Estate Growth

**Current Formula**: construction * 15 + vacant * 8 + estate_agents * 10 + ev_charging * 5 (normalized to 50)

See Score 10 (Investment Potential) for source upgrades — both scores share the same data need.

**Note**: EV charging stations as a real estate growth proxy is interesting but noisy. Replace with RERA approved project count within 2km radius.

### Score 19: Digital Readiness

**Current Formula**: cell_towers * 5 + coworking * 10 + IT_companies * 8 + ev_charging * 5 (normalized to 40)

| Priority | Source | Data Used | Gap Addressed |
|----------|--------|-----------|---------------|
| Current | Overpass API | Digital infrastructure POIs | Severely underrepresented in OSM |
| Phase 2 | TRAI Coverage Checker API | 4G/5G signal strength by location | Definitive telecom coverage |
| Phase 2 | OpenCelliD | Tower geolocation database | Verified tower positions |
| Phase 3 | BIS / Meity | IT company registrations | Official tech industry presence |

---

## 4. DISHA LLM Architecture

### Current Architecture

```
User Click on DigiPin Cell
         |
         v
DataFetcher.fetchAllFeatures(lat, lng, 500m radius)
  |-- Overpass API  (OSM features)
  |-- Open-Meteo   (weather)
  |-- WAQI         (AQI)
  |-- Nominatim    (address)
  |-- Wikipedia    (cultural context)
         |
         v
computeScores(data)  --> 19 scores (0-100)
         |
         v
DISHA.buildContext(cell, data)  --> sparse context string ~500-800 tokens
         |
         v
Ollama (Llama 3.1 8B, local)
  system: SYSTEM_PROMPT (fixed, ~250 tokens)
  prompt: [CONTEXT]\n...\n[QUESTION]\n...
  options: temperature=0.3, num_ctx=8192, top_p=0.9
         |
         v
Streamed token response --> DISHAPanel UI
```

### Context Injection Design (Current)

The `buildContext()` function produces a sparse, key-value string:

```
CELL: 4PM-C4J-P2K3 | 22.71960,75.85770
LOCATION: Rajwada, Indore, Madhya Pradesh - 452002
ENV: 28C, humidity=62%, wind=14km/h, AQI=87, UV=6, Partly cloudy
SCORES: walkability=72, safety=45, green=38, connectivity=61, commercial=83...
FEATURES: Restaurantsx12, Cafex4, Bus Stopsx8, Pharmacyx3, Schoolx2...
NEARBY: Rajwada Palace (0.3km) - Rajwada is a historical palace in the heart...
```

**Why sparse encoding works**: The full data object has ~160 features, most with count=0 for any given cell. The sparse encoder filters to only non-zero features, compressing context from ~4,000 tokens to ~400-800 tokens. This leaves the 8192-token context window almost entirely free for multi-turn conversation.

### Context Injection Improvements

#### Improvement 1: Add Data Confidence Flags

Scores derived from sparse OSM data should include a confidence marker so DISHA can communicate uncertainty correctly:

```
SCORES: walkability=72(high_conf), safety=0(no_data), green=38(low_conf)...
```

Confidence rules:
- `high_conf`: >= 5 contributing features in the score formula have non-zero counts
- `low_conf`: 1-4 contributing features
- `no_data`: 0 contributing features (score is meaningless)

#### Improvement 2: Add Relative Ranking Context

```
CITY_CONTEXT: city=Indore, total_cells_analyzed=1420,
              this_cell_walkability_rank=top_15%, commercial_rank=top_5%
```

This prevents DISHA from saying a score of 45 is "below average" when it may be above average for that city tier.

#### Improvement 3: Add Elevation and Flood Risk

```
TERRAIN: elevation=553m, slope=1.2deg, flood_risk=low,
         nearest_water=Khan_River(2.1km)
```

#### Improvement 4: Add Population Ground Truth

```
DEMOGRAPHICS: ghsl_population_100m=~340_people,
              census_ward=Ward_42, ward_population=28000
```

### Prompt Design Guidelines

**System Prompt (current — keep as-is, well designed)**:
- Role is clear: urban planning advisor, India-specific
- Constraints are explicit: cite scores, use uncertainty language
- Response format is bounded: 3-5 sentences for simple, 2 paragraphs max for complex
- Score interpretation table is embedded
- Audience is defined: urban planners, real estate analysts, officials, citizens

**Prompt Template (current — keep as-is)**:
```
[CONTEXT]
{sparse context string}

[QUESTION]
{user question}
```

This is optimal. The section headers give the model clear parsing anchors. Do not add few-shot examples — they consume context without meaningful accuracy gain for this use case at temperature=0.3.

**Ollama Parameters (current — well tuned)**:
- `temperature=0.3`: Low — appropriate for factual, data-grounded responses. Do not raise.
- `num_ctx=8192`: Sufficient for current context size. Will need to increase to 16384 if Improvement 2 and 3 are added.
- `top_p=0.9`: Standard nucleus sampling — appropriate.
- `repeat_penalty=1.1`: Prevents repetition — appropriate.

### Multi-Turn Conversation Enhancement

The current implementation sends the full context with every message but does not maintain conversation history. The user cannot refer back to previous answers. To add conversation history:

```javascript
// In DISHA.ask(), accumulate history:
const conversationHistory = [];

function buildConversationPrompt(context, history, newQuestion) {
    const historyStr = history
        .map(h => `[${h.role.toUpperCase()}]: ${h.content}`)
        .join('\n');

    return `[CONTEXT]\n${context}\n\n[CONVERSATION]\n${historyStr}\n\n[QUESTION]\n${newQuestion}`;
}
```

Limit history to last 4 exchanges (8 messages) to stay within token budget.

### Suggested Question Logic

The current `getSuggestions()` function generates up to 4 context-aware questions based on score thresholds. This logic is well-designed. Additions:

```javascript
// Add flood risk suggestion when elevation data is available
if (terrain?.flood_risk === 'high') {
    suggestions.push('What are the flood risks at this location?');
}

// Add homebuyer-specific questions when livability is high
if (scores.livability?.value > 65 && scores.safety?.value > 50) {
    suggestions.push('Is this a good area to buy a home?');
}

// Investment query when growth signals are present
if (scores.real_estate_growth?.value > 60 && scores.investment?.value > 50) {
    suggestions.push('What is the investment potential of this cell?');
}
```

### Model Upgrade Path

| Model | When to Use | Tradeoff |
|-------|-------------|----------|
| Llama 3.1 8B (current) | Development, local inference | Fast, free, good for factual Q&A |
| Llama 3.1 70B | Production, Ollama on GPU server | 4x better reasoning, 8x slower |
| Gemma 3 27B | Multilingual (Hindi support) | Good Hindi comprehension |
| Mistral 7B Instruct | Low-memory devices | Smaller footprint than Llama 3.1 8B |
| Claude Haiku (API) | Cloud fallback | Best instruction following, paid |

For the Indore pilot with Hindi-speaking end users, Gemma 3 27B is strongly recommended as the production model due to its superior Hindi language handling.

---

## 5. Missing Dimensions

### Missing Dimension 1: Flood and Waterlogging Risk

**Why Critical**: Indore lies on the Malwa Plateau with multiple seasonal streams (Khan River, Saraswati River, Kanh River). Urban flooding is a recurring monsoon problem. For any homebuyer, investment, or urban planning query, the absence of flood risk data makes the portal unreliable for the most consequential decisions.

**Data Sources**:
1. **SRTM 30m DEM** — Free from NASA EarthData. Provides elevation per 30m grid. Cells below 3rd percentile elevation in their local watershed are flood-prone.
2. **NDEM (National DEM)** — 10m resolution from Survey of India (requires registration).
3. **Copernicus Emergency Management Service** — Post-flood extent data for historical events.
4. **Open-Meteo Historical Precipitation** — Already integrated for weather; add 30-day and annual rainfall accumulation to identify areas with high runoff.
5. **ISRO SAR Flood Maps** — ISRO Bhuvan publishes SAR-based flood extent maps after major events.

**Implementation Plan**:
```javascript
async function fetchElevation(lat, lng) {
    // Open-Meteo provides elevation for free as part of the weather API response
    // data.elevation is already returned in fetchWeather() — just expose it
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
    const data = await fetchWithRetry(url);
    return data.elevation; // meters above sea level
}
```

Note: `Open-Meteo` already returns `data.elevation` in the weather API call. This data point is already being fetched and discarded. Expose it immediately — zero additional API calls required.

**Flood Risk Score Formula**:
```
flood_risk_score = (
  elevation_percentile_in_city * 0.5 +
  distance_to_nearest_waterway_score * 0.3 +
  annual_precipitation_percentile * 0.2
)
// Higher score = lower flood risk (safer)
```

### Missing Dimension 2: Relative Scoring (Normalization vs City Baseline)

**Why Critical**: The current normalization formula `Math.min(100, Math.round((val / max) * 100))` uses fixed ceilings (e.g., `max=30` for walkability). These ceilings were set for a hypothetical dense urban area. In Indore, a cell with 8 restaurants may genuinely be a hotspot, but scores only 26/100 against a ceiling of 30. In a dense Mumbai neighborhood, 8 restaurants is unremarkable.

**Implementation Plan**:

Phase 1 — City-wide calibration (no new data source needed):
```javascript
// After running queries across a city grid, store score distributions
const cityBaseline = {
    walkability: { p25: 12, p50: 28, p75: 51, p90: 72 },
    commercial:  { p25: 8,  p50: 22, p75: 45, p90: 68 },
    // ...
};

function normalizeRelative(rawScore, cityPercentiles) {
    // Convert raw score to percentile rank within city
    if (rawScore <= cityPercentiles.p25) return Math.round(rawScore / cityPercentiles.p25 * 25);
    if (rawScore <= cityPercentiles.p50) return 25 + Math.round((rawScore - cityPercentiles.p25) / (cityPercentiles.p50 - cityPercentiles.p25) * 25);
    if (rawScore <= cityPercentiles.p75) return 50 + Math.round((rawScore - cityPercentiles.p50) / (cityPercentiles.p75 - cityPercentiles.p50) * 25);
    return 75 + Math.round((rawScore - cityPercentiles.p75) / (cityPercentiles.p90 - cityPercentiles.p75) * 25);
}
```

The calibration data can be built by running the 12-query engine in grid mode once per city and persisting the score distribution to a JSON file.

### Missing Dimension 3: Homebuyer-Oriented Query Mode

**Why Critical**: The Query Engine has 12 modes but none is designed for the most commercially valuable use case: a family deciding where to buy a home. The "Best Residential Area" query is close but does not consider school quality, property prices, commute time, or flood risk.

**New Query: Homebuyer Score**
```javascript
{
    id: 'homebuyer',
    name: 'Homebuyer Score',
    desc: 'Balanced safety, schools, healthcare, green space, and connectivity',
    weights: {
        livability: 3,
        safety: 3,
        education_score: 3,
        healthcare_access: 2,
        green: 2,
        connectivity: 2,
        noise_estimate: 2,
        flood_risk: 3,           // New score (Phase 2)
        commercial: 1,
        real_estate_growth: -1   // Penalize areas in active construction
    }
}
```

**New Query: Rental Yield Potential**
```javascript
{
    id: 'rental',
    name: 'Rental Yield Potential',
    desc: 'High connectivity, commercial activity, and proximity to employment hubs',
    weights: {
        connectivity: 3,
        commercial: 3,
        digital_readiness: 2,
        walkability: 2,
        food_diversity: 2,
        entertainment_score: 1,
        infra_maturity: 2
    }
}
```

### Missing Dimension 4: Time-of-Day Context

All current data is static. An area near a cinema and restaurants may be vibrant at 8pm but dead at 9am. DISHA has no awareness of temporal context.

**Short-term fix**: Inject current time into DISHA context.
```javascript
const timeContext = `TIME: ${new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit'
})}`;
```

This allows DISHA to reason: "It is currently 9pm on a Friday — the entertainment score of 78 suggests this area is likely active right now."

### Missing Dimension 5: Inter-Cell Comparison

Users cannot currently compare two DigiPin cells side by side. For real estate decisions, the ability to say "compare DigiPin A to DigiPin B" is essential.

**Implementation**: Store the last N cells fetched in a comparison buffer. Add a "Compare" button that displays a side-by-side score table and lets DISHA answer comparative questions using both cells' contexts concatenated.

---

## 6. Implementation Roadmap

### Phase 1 — Data Quality Fixes (Week 1-2)

**Goal**: Fix known inaccuracies in existing scores without adding new API dependencies.

| Task | File | Change | Priority |
|------|------|--------|----------|
| Expose elevation from Open-Meteo response | `data-fetcher.js` | `fetchWeather()` returns `data.elevation` — store in result.environment | Critical |
| Fix AQI geo-query | `data-fetcher.js` | Register WAQI account, use geo token, replace city-name fallback | Critical |
| Add data confidence to scores | `data-fetcher.js` | Add `confidence` field (high/low/no_data) to each score object | High |
| Fix religious diversity formula | `data-fetcher.js` | Compute Shannon diversity index from `religion=` OSM tags | High |
| Inject confidence into DISHA context | `disha.js` | Modify `buildContext()` to include `(conf)` suffix on scores | High |
| Inject current time into DISHA context | `disha.js` | Add TIME line to `buildContext()` | Medium |
| Add homebuyer query | `query-engine.js` | Add new query with flood_risk placeholder weight | Medium |
| Expand Wikipedia search radius | `data-fetcher.js` | Increase `gsradius` from 1000 to 5000 | Low |

### Phase 2 — New Data Sources (Week 3-6)

**Goal**: Add the Tier 2 sources that most improve score accuracy and unlock the flood risk dimension.

| Week | Task | Data Source | Score(s) Improved |
|------|------|-------------|-------------------|
| 3 | Integrate GHSL GHS-POP 100m grid | EU JRC GHSL | population_proxy, walkability, commercial |
| 3 | Add SRTM elevation tile fetch | NASA EarthData | new: flood_risk_score |
| 4 | Integrate Census 2011 ward boundaries | DataMeet / OpenCity | population_proxy, safety, education |
| 4 | Add TRAI coverage API | TRAI Open Data | digital_readiness, connectivity |
| 5 | Integrate OpenCelliD cell towers | OpenCelliD | digital_readiness, infra_maturity |
| 5 | Add HFR hospital registry | NHA / Ayushman Bharat | healthcare_access |
| 6 | Build city-wide baseline calibration | Internal (derived from existing Overpass data) | All 19 scores |
| 6 | Add relative score normalization | Internal | All 19 scores |

### Phase 3 — Production Hardening (Week 7-10)

**Goal**: Prepare for multi-city deployment beyond Indore.

| Week | Task | Notes |
|------|------|-------|
| 7 | RERA MP integration | Real estate growth score — scraping required, legal review needed |
| 7 | Backend API proxy server | Move API calls from browser to Node.js/FastAPI backend; enables API key management and caching |
| 8 | Redis caching layer | Cache Overpass results for 1 hour; avoid repeated identical queries |
| 8 | Multi-turn conversation history | DISHA context carries last 4 conversation turns |
| 9 | Hindi language mode | Switch to Gemma 3 27B or add translation layer |
| 9 | Cell comparison feature | Side-by-side DigiPin comparison UI and DISHA dual-context |
| 10 | City expansion: Bhopal, Ujjain | Test portability — calibrate city baselines for new cities |
| 10 | Export to PDF report | Generate a single-page DigiPin intelligence report for offline use |

### Architecture Evolution: Browser-only to Backend Pipeline

The current architecture runs all data fetching in the browser via `DataFetcher.fetchAllFeatures()`. This is appropriate for a prototype but has limitations:

1. API keys cannot be secured in browser JavaScript
2. Rate limiting cannot be coordinated across users
3. Overpass query results cannot be shared/cached across users
4. The 200ms artificial delay in query-engine.js serializes requests that could be parallelized

**Target Architecture (Phase 3)**:
```
Browser (Leaflet + DigiPin UI)
    |
    | REST API calls
    v
FastAPI Backend (Python)
    |-- /api/cell/{digipin}  --> Orchestrates all data fetches, returns unified JSON
    |-- /api/query/{type}    --> Runs grid query server-side with proper parallelism
    |-- /api/compare         --> Returns dual-cell context for DISHA comparison
    |
    |-- Redis cache (1h TTL for Overpass, 30m for weather)
    |-- PostgreSQL + PostGIS (city baseline distributions, GHSL tiles)
    |-- Celery workers (background tile ingestion)
    |
    v
External APIs (Overpass, Open-Meteo, WAQI, Nominatim, GHSL, etc.)
```

This backend architecture should use Apache Airflow for the batch ingestion jobs (GHSL tile download, Census data loading, RERA scraping) and FastAPI for the synchronous request path.

---

## 7. API Reference

### Currently Integrated APIs

#### 7.1 Overpass API (OpenStreetMap)

- **Base URL**: `https://overpass-api.de/api/interpreter`
- **Auth**: None required
- **Method**: POST with form-encoded body `data={overpass_ql_query}`
- **Rate Limit**: No official limit; de facto ~1 req/sec sustained; 45s timeout on query
- **Response Size**: Typically 50KB-500KB for 500m radius in Indian cities
- **Current Usage**: Single broad query per cell click; fetches all tagged elements in 13 tag categories within 500m radius
- **Known Issues**: India OSM coverage is 40-70% complete in Tier 2 cities; silent undercounting

**Query Format**:
```
[out:json][timeout:45];
(
  nwr[amenity](around:500,{lat},{lng});
  nwr[shop](around:500,{lat},{lng});
  ...
);out center body;
```

**Optimization Note**: The current query uses `nwr` (node + way + relation) for all tag types. For point features (ATMs, restaurants), `node` alone is faster and sufficient. Use `way` only for polygon features (parks, buildings, landuse).

**Alternative Instances** (for redundancy):
- `https://overpass.kumi.systems/api/interpreter`
- `https://maps.mail.ru/osm/tools/overpass/api/interpreter`

#### 7.2 Open-Meteo Weather API

- **Base URL**: `https://api.open-meteo.com/v1/forecast`
- **Auth**: None required (free, no key)
- **Method**: GET
- **Rate Limit**: 10,000 requests/day, 1 req/sec sustained
- **Response Time**: ~200ms typical
- **Current Usage**: Fetches current temperature, humidity, wind speed, UV index, weather code, and elevation

**Request**:
```
GET https://api.open-meteo.com/v1/forecast
  ?latitude={lat}
  &longitude={lng}
  &current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,uv_index
  &timezone=auto
```

**Additional Endpoints to Use**:
```
# Historical precipitation (Phase 2 — flood risk proxy)
GET https://archive-api.open-meteo.com/v1/archive
  ?latitude={lat}&longitude={lng}
  &start_date=2024-06-01&end_date=2024-09-30
  &daily=precipitation_sum
  &timezone=Asia%2FKolkata

# Elevation (already returned in current forecast call)
# data.elevation is in the forecast response body — just expose it
```

#### 7.3 WAQI Air Quality API

- **Base URL**: `https://api.waqi.info`
- **Auth**: Token in URL parameter (`?token=YOUR_TOKEN`)
- **Demo Token**: `demo` — works for city-name queries, returns wrong results for geo queries
- **Rate Limit**: Demo: 1000 req/day; Free registered token: 1000 req/day; Paid: higher
- **Current Usage**: City-name lookup (workaround for demo token geo limitation)

**Current (broken for hyperlocal)**:
```
GET https://api.waqi.info/feed/{city_name}/?token=demo
```

**Correct (requires registered free token)**:
```
GET https://api.waqi.info/feed/geo:{lat};{lng}/?token={YOUR_TOKEN}
```

**Registration**: https://aqicn.org/data-platform/token/ — Free, instant approval.

**Action Required**: Register for a free WAQI token. Replace `demo` token in `data-fetcher.js`. Switch from city-name endpoint to geo endpoint. This is the highest-priority single-line fix.

#### 7.4 Nominatim Reverse Geocoding (OpenStreetMap)

- **Base URL**: `https://nominatim.openstreetmap.org/reverse`
- **Auth**: None required; User-Agent header is mandatory
- **Method**: GET
- **Rate Limit**: 1 req/sec hard limit (enforced by User-Agent tracking); commercial use requires self-hosting or a paid tier
- **Current Usage**: Reverse geocode + city name for WAQI; detailed address for panel display

**Request**:
```
GET https://nominatim.openstreetmap.org/reverse
  ?format=json
  &lat={lat}&lon={lng}
  &zoom=18
  &addressdetails=1
  Headers: User-Agent: DigiPinUrbanIntelligence/1.0
```

**Note**: The current code calls Nominatim twice per cell click — once in `fetchAQI()` for city name, and once in `fetchAddress()` for full address. These should be deduplicated by passing city name from the address fetch to the AQI fetch.

#### 7.5 Wikipedia Geosearch API

- **Base URL**: `https://en.wikipedia.org/w/api.php`
- **Auth**: None required
- **Method**: GET with `origin=*` for CORS
- **Rate Limit**: Generous; ~200 req/sec; no per-IP limit documented
- **Current Usage**: Find nearest Wikipedia article within 1km; fetch intro summary

**Request (Phase 1 upgrade — increase radius to 5km)**:
```
GET https://en.wikipedia.org/w/api.php
  ?action=query
  &list=geosearch
  &gscoord={lat}|{lng}
  &gsradius=5000         # was 1000, increase to 5000
  &gslimit=3             # was 1, increase to get top 3
  &format=json
  &origin=*
```

#### 7.6 Ollama Local LLM API

- **Base URL**: `http://localhost:11434`
- **Auth**: None (local process)
- **Method**: POST (streaming)
- **Rate Limit**: Hardware-constrained; ~20-40 tokens/sec on a mid-range GPU

**Connection Check**:
```
GET http://localhost:11434/api/tags
Response: { models: [{name: "llama3.1:8b", ...}] }
```

**Generate (streaming)**:
```
POST http://localhost:11434/api/generate
{
  "model": "llama3.1:8b",
  "system": "{SYSTEM_PROMPT}",
  "prompt": "[CONTEXT]\n{context}\n\n[QUESTION]\n{question}",
  "stream": true,
  "options": {
    "temperature": 0.3,
    "num_ctx": 8192,
    "top_p": 0.9,
    "repeat_penalty": 1.1
  }
}
```

### APIs to Integrate (Phase 2)

#### 7.7 Global Human Settlement Layer (GHSL)

- **Provider**: European Commission, Joint Research Centre (JRC)
- **Base URL**: `https://ghsl.jrc.ec.europa.eu/ghs_pop2023.php`
- **Auth**: None — CC-BY 4.0 open data
- **Data Format**: GeoTIFF raster tiles (100m resolution)
- **Access Pattern**: Download relevant India tile (`GHS_POP_E2025_GLOBE_R2023A_54009_100_V1_0_R6_C27.tif`) once; serve from local server or CDN

**Integration Approach**:
```python
# Backend: Pre-load GHSL tile for India, query by lat/lng
import rasterio
from rasterio.warp import transform

def get_population_100m(lat, lng, tif_path):
    with rasterio.open(tif_path) as src:
        row, col = src.index(lng, lat)  # Note: lon, lat order for rasterio
        return src.read(1)[row, col]    # Returns population count in 100m cell
```

**Tile Index**: https://ghsl.jrc.ec.europa.eu/download.php?ds=pop

#### 7.8 TRAI Open Data API

- **Provider**: Telecom Regulatory Authority of India
- **Base URL**: `https://tarangsanchar.gov.in/EMFPortal`
- **Auth**: None — public portal
- **Data**: Cell tower locations, tower type (2G/3G/4G/5G), operator, pincode
- **Access Pattern**: Bulk download by district CSV, or web scrape by location
- **Update Frequency**: Monthly

**Note**: TRAI does not offer a REST API for real-time queries. The approach is to bulk-download the tower dataset for Madhya Pradesh, load it into a PostGIS database, and query by ST_DWithin radius.

#### 7.9 OpenCelliD

- **Base URL**: `https://opencellid.org/api`
- **Auth**: API key (free registration at https://opencellid.org/register)
- **Rate Limit**: Free tier: 1000 requests/day; Community: 10,000/day
- **Method**: GET

**Cell Tower Query by Location**:
```
GET https://opencellid.org/cell/getInArea
  ?key={API_KEY}
  &BBOX={south},{west},{north},{east}
  &format=json
```

**Response**: List of cell towers with lat/lng, radio type (LTE/NR/UMTS), MCC, MNC.

**Integration**: Use tower count within 500m as `cell_tower_density`; use presence of NR (5G) towers as a separate `has_5g` binary flag in the Digital Readiness score.

#### 7.10 Health Facility Registry (HFR) — Ayushman Bharat

- **Provider**: National Health Authority, Government of India
- **Base URL**: `https://facility.ndhm.gov.in`
- **Auth**: Registration required at NHA Developer Portal
- **Rate Limit**: Not officially documented; assume 100 req/min
- **Data**: All registered health facilities in India including name, type, specialties, location

**Search by Location**:
```
GET https://facility.ndhm.gov.in/api/v1/facility/search
  ?latitude={lat}&longitude={lng}&radius={radius_km}
  &facilityType=HOSPITAL,CLINIC,PHARMACY
Authorization: Bearer {token}
```

**Why HFR Over OSM**: HFR includes all CGHS-empaneled, PMJAY-empaneled, and standalone private hospitals that are never tagged in OSM. It is the authoritative national registry.

#### 7.11 India Census 2011 Open Data (DataMeet)

- **Provider**: DataMeet (community-cleaned Census 2011 data)
- **Base URL**: `https://api.data.gov.in/resource/`
- **Auth**: API key from data.gov.in (free registration)
- **Data**: Ward-level population, sex ratio, literacy rate by state/district/ward

**Ward Population Query**:
```
GET https://api.data.gov.in/resource/6db0bca7-42a8-4871-8a12-ba4a9b5c3bd9
  ?api-key={API_KEY}
  &format=json
  &filters[State_Name]=Madhya Pradesh
  &filters[District_Name]=Indore
```

**Note**: The 2011 Census data is the last available ward-level data. 2021 Census data is expected to be published by the Government in 2025-2026. Monitor the Census of India website.

#### 7.12 SRTM Elevation API (Open-Meteo — already fetched)

**This is already in the codebase and costs nothing.** Open-Meteo returns `data.elevation` (metres above sea level) in every weather API response. The `fetchWeather()` function in `data-fetcher.js` stores it as `data.elevation` in the returned object, but it is never exposed in `result.environment` or passed to DISHA.

**One-line fix in `data-fetcher.js`** (`fetchWeather()` return block):
```javascript
return {
    temperature: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    windSpeed: c.wind_speed_10m,
    uvIndex: c.uv_index,
    weatherCode: c.weather_code,
    weatherDesc: getWeatherDescription(c.weather_code),
    elevation: data.elevation   // <-- already fetched, just expose it
};
```

Then add to DISHA context builder:
```javascript
if (env.elevation != null) envParts.push(`elev=${env.elevation}m`);
```

This single change gives DISHA elevation data for every cell immediately, with no new API calls or costs.

---

## Appendix A: Score Quick Reference Table

| # | Score Key | Label | Current Sources | Max Input | Confidence in Indore |
|---|-----------|-------|-----------------|-----------|----------------------|
| 1 | walkability | Walkability Score | OSM POIs, footpaths | 30 | Medium |
| 2 | safety | Safety Index | OSM police, fire, lamps | 50 | Low |
| 3 | green | Green Index | OSM parks, water | 40 | Medium |
| 4 | connectivity | Connectivity Score | OSM transport | 50 | Medium |
| 5 | commercial | Commercial Vibrancy | OSM shops, offices | 50 | High |
| 6 | education_score | Education Index | OSM schools, colleges | 50 | Medium |
| 7 | healthcare_access | Healthcare Access | OSM hospitals, clinics | 40 | Low |
| 8 | entertainment_score | Entertainment Score | OSM leisure, cinema | 40 | Medium |
| 9 | livability | Livability Index | Composite (1-4, 7, 13) | — | Medium |
| 10 | investment | Investment Potential | OSM construction, metro | 50 | Low |
| 11 | tourism | Tourism Appeal | OSM hotels, monuments | 40 | High |
| 12 | infra_maturity | Infrastructure Maturity | OSM lamps, towers, roads | 50 | Low |
| 13 | noise_estimate | Quietness | OSM inverse noise proxy | 40 | Low |
| 14 | population_proxy | Population Density | OSM buildings | 50 | Low |
| 15 | food_diversity | Food Diversity | OSM food POIs | 20 | High |
| 16 | religious_diversity | Religious Diversity | OSM worship count | 10 | Medium |
| 17 | public_service | Public Service Access | OSM civic amenities | 30 | Low |
| 18 | real_estate_growth | Real Estate Growth | OSM construction, agents | 50 | Low |
| 19 | digital_readiness | Digital Readiness | OSM towers, coworking | 40 | Very Low |

**Confidence Definitions**:
- High: OSM India coverage adequate; scores are directionally reliable
- Medium: Partial coverage; scores indicate presence but undercount
- Low: Systematic undercounting; treat as floor, not actual value
- Very Low: Near-zero OSM tagging; score has no meaningful signal

## Appendix B: Key Files in This Project

| File | Role |
|------|------|
| `js/data-fetcher.js` | Core data pipeline: all API calls, classification, score computation |
| `js/disha.js` | DISHA LLM integration: context builder, Ollama streaming, suggestions |
| `js/disha-panel.js` | DISHA chat UI controller |
| `js/query-engine.js` | 12-query comparative analysis engine |
| `js/map.js` | Leaflet map, DigiPin grid overlay, cell selection |
| `js/panel.js` | Detail panel: score display, radar chart, feature tabs |
| `js/app.js` | Application bootstrap, search, sidebar |
| `js/digipin.js` | DigiPin encode/decode library (India Post algorithm) |
| `docs/RESEARCH_INTEGRATION.md` | This document |

## Appendix C: Immediate Action Items (Do These First)

These are zero-new-dependency changes that can be made today:

1. **Expose `data.elevation` from the existing `fetchWeather()` call** — `data-fetcher.js`, line ~464. One line change. Gives DISHA elevation for every cell.

2. **Register for WAQI free token** — https://aqicn.org/data-platform/token/. Takes 2 minutes. Then change `token=demo` to real token and switch to geo endpoint `feed/geo:{lat};{lng}/`.

3. **Deduplicate Nominatim calls** — `fetchAQI()` makes a redundant reverse geocode. Pass `cityName` from the address fetch to the AQI fetch to halve Nominatim load.

4. **Increase Wikipedia search radius** — Change `gsradius=1000` to `gsradius=5000` in `fetchWikipedia()`. Improves cultural context for cells outside dense urban cores.

5. **Add time injection to DISHA context** — 3 lines in `disha.js` `buildContext()`. Enables temporal reasoning at no cost.

6. **Fix religious diversity to use Shannon entropy** — Replace the current `normalize(worship_count, 10)` with a proper diversity formula using OSM `religion=` tag values.

7. **Add homebuyer and rental yield queries** to `query-engine.js` — Copy existing query structure, define new weight vectors from Section 5.

---

*This document is the authoritative technical reference for the DigiPin Urban Intelligence Portal. Update it whenever a new data source is integrated, a score formula is changed, or a new feature is added. The research integration phase is complete; execution begins now.*
