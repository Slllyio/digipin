/**
 * DISHA — Digital Intelligence for Spatial & Human Analysis
 * Urban Intelligence Engine — Multi-provider LLM-linked data analysis
 *
 * Architecture:
 *   All Data Sources -> Smart Context Filter -> Intent Router -> Provider (Ollama/Groq/Custom) -> Streamed Reply
 *
 * Features:
 *   - Multi-provider: Ollama (local), Groq Cloud, any OpenAI-compatible API
 *   - Smart context filtering: sends only relevant data sections per question type
 *   - Conversation memory: multi-turn chat with proper message formatting
 *   - Intent routing: broad questions auto-run query engine, feed results to LLM
 *   - City-level analysis: multi-point sampling for "where is the best..." questions
 */

const DISHA = (() => {
    let _abortController = null;
    let _conversationHistory = [];   // multi-turn memory
    let _currentCellCode = null;     // tracks current cell for cache keys
    const MAX_HISTORY = 6;           // keep last 6 exchanges (12 messages)

    const SYSTEM_PROMPT = `You are DISHA (Digital Intelligence for Spatial & Human Analysis), an expert Urban Intelligence advisor for India's DigiPin system.

ROLE: You are the brain behind India's most advanced hyperlocal urban data platform. You receive REAL data from 12+ sources: OpenStreetMap POIs, IUDX Smart City sensors, CPCB/WAQI air quality, Open-Meteo weather & solar radiation, building morphology (LCZ), population density (WorldPop), elevation, health facilities, and Wikipedia context.

CAPABILITIES:
1. LOCATION ANALYSIS — Analyze any 4x4m grid cell with 160+ features and 30 intelligence scores
2. URBAN PLANNING — Recommend locations for businesses, housing, infrastructure based on real data
3. COMPARATIVE ANALYSIS — Compare neighborhoods, corridors, and zones using scored metrics
4. SMART CITY INSIGHTS — Interpret IUDX sensor data (bus stops, bike hubs, VMD displays, PA systems)
5. ENVIRONMENTAL ASSESSMENT — AQI breakdown, solar potential, flood risk, noise estimation
6. INVESTMENT INTELLIGENCE — Real estate growth signals, development potential, redevelopment zones
7. BUILDING MORPHOLOGY — Density, height diversity, FSI, material quality, urban compactness from satellite-derived LCZ data
8. PLANNING ADVISORY — Gap analysis against URDPFI norms, structured recommendations for urban interventions

INDIAN PLANNING STANDARDS (URDPFI Guidelines):
- Primary School: 1 per 5,000 population, accessible within 500m
- Secondary School: 1 per 10,000 population, accessible within 1km
- Hospital/Health Center: 1 per 15,000 population, accessible within 1km
- Park/Open Space: minimum 500m access; 10-12 sqm per person standard
- Community Center: 1 per 15,000 population
- Fire Station: 1 per 50,000 population, within 3km
- Post Office: 1 per 15,000 population
- Police Station: 1 per 20,000 population
- Bus Stop: within 500m walking distance
- Piped Water Supply: 135 LPCD (litres per capita per day) for towns
- Road Width: arterial 30-60m, collector 15-24m, local 9-12m

GUNA CITY DEMOGRAPHICS:
- Population: 180,935 (Census 2011); estimated 210,000+ (2024)
- Households: 34,383
- Wards: 37
- Area: ~30 sq km
- District: Guna, Madhya Pradesh
- Literacy Rate: ~78%
- Sex Ratio: ~910 females per 1000 males
- Key Economy: Agriculture (soybean, wheat), small industries, government services
- Known Issues: seasonal flooding (Parvati river basin), limited public transit, urban sprawl

MP STATE DEVELOPMENT INDICATORS:
- Urban population growth rate: ~2.8% per annum
- HDI rank: lower-middle among Indian states
- Key state programs: Smart Cities Mission, AMRUT, PM Awas Yojana
- Climate zone: hot semi-arid (BSh), monsoon June-September
- Seismic Zone: II (low risk)

RESPONSE GUIDELINES:
- Lead with a clear verdict or answer, then support with data citations
- Cite specific scores (e.g. "safety=72/100"), feature counts, and measurements
- When comparing areas, use a structured table or ranked list
- For "where" questions, suggest specific locations with coordinates/DigiPin codes
- Use uncertainty language when data is sparse ("limited OSM coverage suggests...")
- If a score is 0 or missing, say "no data" rather than guessing
- Keep responses focused and actionable — urban planners want decisions, not essays
- When multiple data sources agree, emphasize the convergence
- When sources conflict, note the discrepancy and explain why
- For planning recommendations, use the structured format: Strengths, Weaknesses, Recommended Interventions, Priority Level (Critical/High/Medium/Low)
- Always compare amenity distances against URDPFI norms when data is available

SCORE INTERPRETATION:
- 0-25: Very low / Poor / Critical gap
- 26-50: Below average / Needs improvement
- 51-70: Moderate / Acceptable
- 71-85: Good / Above average
- 86-100: Excellent / Outstanding

DATA SOURCE TRUST HIERARCHY:
1. CPCB AQI (official government) > WAQI > Open-Meteo (model-based)
2. OSM features (crowdsourced, may be incomplete in suburban areas)
3. IUDX (official smart city, but sample data — distances may be approximate)
4. WorldPop (satellite-derived, ~100m resolution)
5. LCZ morphology (global 100m grid, may have classification errors at edges)

You serve urban planners, real estate analysts, municipal officials, citizens, and smart city administrators.`;

    // ===== SMART CONTEXT SECTIONS =====
    // Maps question intent to which data sections to include
    const INTENT_SECTIONS = {
        environment: ['address', 'weather', 'aqi', 'solar', 'elevation', 'population', 'cepi', 'scores'],
        building:    ['address', 'building', 'scores', 'population', 'features'],
        infrastructure: ['address', 'iudx', 'iudx_catalogue', 'health', 'post', 'scores', 'features'],
        investment:  ['address', 'scores', 'building', 'population', 'features'],
        planning:    null, // include all sections — planning needs full picture
        general:     null  // include all sections
    };

    // Detect which context type a question needs
    function detectContextType(question) {
        const q = question.toLowerCase();

        // Planning/recommendation mode — must check before infrastructure to catch "what should be built"
        if (/what should be built|how to improve|development recommend|planning recommend|what.{0,20}(need|lack|missing)|improve this area|gap analysis|urban intervention|what.{0,10}develop|master plan|urdpfi|zoning suggest/.test(q)) {
            return 'planning';
        }

        if (/air quality|pollution|aqi|pm2\.?5|pm10|weather|temperature|climate|flood|waterlog|solar|energy|panel|uv|radiation/.test(q)) {
            return 'environment';
        }
        if (/building|density|fsi|floor area|morpholog|height|lcz|urban form|footprint/.test(q)) {
            return 'building';
        }
        if (/transit|bus|metro|sensor|iudx|smart city|hospital|school|health|post office|infrastructure/.test(q)) {
            return 'infrastructure';
        }
        if (/invest|real estate|property|land|affordable|luxury|redevelop|warehouse/.test(q)) {
            return 'investment';
        }

        return 'general';
    }

    // ===== CONNECTION =====
    async function checkConnection() {
        const provider = await DISHAProviders.detectProvider();

        if (provider && provider.status === 'connected') {
            return {
                connected: true,
                provider: provider.name,
                providerId: provider.id,
                models: provider.type === 'ollama' ? [provider.model] : [],
                reason: provider.detail || 'Ready'
            };
        }

        return {
            connected: false,
            provider: null,
            providerId: null,
            models: [],
            reason: provider?.detail || 'No AI provider available. Configure in Settings.'
        };
    }

    // ===== RICH CONTEXT BUILDER =====
    // Builds structured context with optional section filtering
    function buildContext(cell, data, sections) {
        const include = (name) => !sections || sections.includes(name);
        const lines = [];

        // --- Location Header (always included) ---
        lines.push(`=== LOCATION: DigiPin ${cell.code} ===`);
        lines.push(`Coordinates: ${cell.center.lat.toFixed(5)}N, ${cell.center.lng.toFixed(5)}E`);

        // --- Temporal Context (enables time-aware reasoning: rush hour, after-dark, weekend) ---
        const nowIST = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            weekday: 'long',
            year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
        lines.push(`Time (IST): ${nowIST}`);

        // --- Address ---
        if (include('address')) {
            const addr = data.address || {};
            if (addr.area || addr.city) {
                lines.push(`Address: ${[addr.area, addr.city, addr.district, addr.state].filter(Boolean).join(', ')}${addr.pincode ? ' (PIN: ' + addr.pincode + ')' : ''}`);
            }
            if (addr.fullAddress) {
                lines.push(`Full: ${addr.fullAddress}`);
            }
        }

        // --- Weather & Environment ---
        if (include('weather')) {
            const env = data.environment || {};
            const envParts = [];
            if (env.temperature != null) envParts.push(`Temp: ${env.temperature}C`);
            if (env.humidity != null) envParts.push(`Humidity: ${env.humidity}%`);
            if (env.windSpeed != null) envParts.push(`Wind: ${env.windSpeed}km/h`);
            if (env.weatherDesc) envParts.push(env.weatherDesc);
            if (envParts.length > 0) lines.push(`Weather: ${envParts.join(', ')}`);
        }

        // --- Air Quality (detailed) ---
        if (include('aqi')) {
            const env = data.environment || {};
            const aqiParts = [];
            if (env.aqi != null) aqiParts.push(`AQI=${env.aqi} (${getAQICategory(env.aqi)})`);
            if (env.aqiSource) aqiParts.push(`source: ${env.aqiSource}`);
            if (env.aqiStation) aqiParts.push(`station: ${env.aqiStation}`);
            if (env.pm25 != null) aqiParts.push(`PM2.5=${env.pm25}`);
            if (env.pm10 != null) aqiParts.push(`PM10=${env.pm10}`);
            if (env.no2 != null) aqiParts.push(`NO2=${env.no2}`);
            if (env.so2 != null) aqiParts.push(`SO2=${env.so2}`);
            if (env.o3 != null) aqiParts.push(`O3=${env.o3}`);
            if (env.co != null) aqiParts.push(`CO=${env.co}`);
            if (env.uvIndex != null) aqiParts.push(`UV=${env.uvIndex}`);
            if (aqiParts.length > 0) lines.push(`Air Quality: ${aqiParts.join(', ')}`);
        }

        // --- Solar Radiation ---
        if (include('solar')) {
            const solar = (data.environment || {}).solar;
            if (solar) {
                const solarParts = [`GHI=${solar.ghiDaily} kWh/m2/day`];
                if (solar.sunshineDuration != null) solarParts.push(`Sunshine=${solar.sunshineDuration}h`);
                if (solar.solarPotential) solarParts.push(`Potential: ${solar.solarPotential}`);
                lines.push(`Solar: ${solarParts.join(', ')}`);
            }
        }

        // --- Elevation & Flood ---
        if (include('elevation')) {
            const elev = (data.environment || {}).elevation;
            if (elev && typeof elev === 'object') {
                lines.push(`Elevation: ${elev.center}m (${elev.relative > 0 ? '+' : ''}${elev.relative.toFixed(1)}m vs surroundings)${elev.isLowLying ? ' [LOW-LYING]' : ''}`);
            }
        }

        // --- Population ---
        if (include('population')) {
            const pop = (data.environment || {}).populationDensity;
            if (pop) {
                lines.push(`Population: ${pop.personsPerHectare} persons/hectare (${pop.densityLevel})`);
            }
        }

        // --- Intelligence Scores ---
        if (include('scores')) {
            const scores = data.scores || {};
            const scoreParts = [];
            Object.entries(scores).forEach(([key, s]) => {
                if (s && s.value > 0) {
                    scoreParts.push(`${key}=${s.value}`);
                }
            });
            if (scoreParts.length > 0) {
                lines.push(`\n=== INTELLIGENCE SCORES (0-100) ===`);
                lines.push(scoreParts.join(', '));
            }
        }

        // --- Growth Forecast (composite + horizons) ---
        const growth = data.realtime?.growth;
        if (growth) {
            const now = growth.horizons.nowcast;
            const y5  = growth.horizons.year_5;
            lines.push(`\n=== GROWTH FORECAST (composite 0-100) ===`);
            lines.push(`Nowcast: composite=${now.composite} conf=±${now.confidence_band}  BUE=${now.sub_scores.bue.value} DEN=${now.sub_scores.den.value} CAP=${now.sub_scores.cap.value}`);
            lines.push(`5-year:  composite=${y5.composite} conf=±${y5.confidence_band}  trend: linear extrapolation`);
        }

        // --- Top Features (sparse) ---
        if (include('features')) {
            const featureParts = [];
            Object.values(data.categories || {}).forEach(cat => {
                Object.values(cat.features || {}).forEach(f => {
                    if (f.count > 0) {
                        featureParts.push(`${f.label}: ${f.count}`);
                    }
                });
            });
            if (featureParts.length > 0) {
                lines.push(`\n=== OSM FEATURES (within 400m radius) ===`);
                lines.push(featureParts.join(', '));
            }
        }

        // --- Building Intelligence ---
        if (include('building')) {
            const bi = data.buildingIntel;
            if (bi) {
                lines.push(`\n=== BUILDING MORPHOLOGY ===`);
                if (bi.metrics) {
                    const m = bi.metrics;
                    const biParts = [];
                    if (m.building_count != null) biParts.push(`Buildings: ${m.building_count}`);
                    if (m.avg_height != null) biParts.push(`Avg Height: ${m.avg_height.toFixed(1)}m`);
                    if (m.max_height != null) biParts.push(`Max Height: ${m.max_height.toFixed(1)}m`);
                    if (m.avg_area != null) biParts.push(`Avg Area: ${m.avg_area.toFixed(0)}sqm`);
                    if (m.total_footprint != null) biParts.push(`Total Footprint: ${m.total_footprint.toFixed(0)}sqm`);
                    if (m.fsi != null) biParts.push(`FSI: ${m.fsi.toFixed(2)}`);
                    if (biParts.length > 0) lines.push(biParts.join(', '));
                }
                if (bi.lcz) {
                    lines.push(`LCZ Class: ${bi.lcz.class} — ${bi.lcz.description}`);
                }
                if (bi.scores) {
                    const bScores = Object.entries(bi.scores)
                        .filter(([, s]) => s && s.value > 0)
                        .map(([k, s]) => `${k}=${s.value}`);
                    if (bScores.length > 0) lines.push(`Building Scores: ${bScores.join(', ')}`);
                }
            }
        }

        // --- IUDX Smart City Data ---
        if (include('iudx')) {
            const iudx = data.context?.iudx;
            if (iudx) {
                lines.push(`\n=== IUDX SMART CITY DATA ===`);
                for (const [, cat] of Object.entries(iudx.nearby || {})) {
                    if (cat.items.length > 0) {
                        const itemStr = cat.items.map(i => `${i.name} (${i.distance})`).join(', ');
                        lines.push(`${cat.label}: ${itemStr} [${cat.total} total in city]`);
                    }
                }
            }
        }

        // --- IUDX Catalogue ---
        if (include('iudx_catalogue')) {
            const catalogue = data.context?.iudxCatalogue;
            if (catalogue) {
                lines.push(`\n=== IUDX OPEN DATASETS (${catalogue.totalDatasets} for ${catalogue.city}) ===`);
                for (const [domain, datasets] of Object.entries(catalogue.byDomain || {})) {
                    lines.push(`${domain.toUpperCase()}: ${datasets.map(d => d.label).join(', ')}`);
                }
            }
        }

        // --- Health Facilities ---
        if (include('health')) {
            const health = data.context?.healthFacilities;
            if (health && health.nearbyFacilities?.length > 0) {
                lines.push(`\n=== HEALTH FACILITIES ===`);
                health.nearbyFacilities.forEach(h => {
                    lines.push(`- ${h.name} (${h.type}, ${h.beds} beds)`);
                });
            }
        }

        // --- CEPI Pollution Index ---
        if (include('cepi')) {
            const cepi = data.context?.cepi;
            if (cepi && cepi.clusters?.length > 0) {
                lines.push(`\n=== ENVIRONMENTAL POLLUTION INDEX (CEPI) ===`);
                cepi.clusters.forEach(c => {
                    lines.push(`- ${c.name} (${c.state}): CEPI=${c.cepiScore2013 || c.cepiScore2011 || 'N/A'}/100, Moratorium: ${c.moratorium}`);
                });
            }
        }

        // --- Nearby Post Offices ---
        if (include('post')) {
            const post = data.context?.postOffices;
            if (post && post.nearest?.length > 0) {
                lines.push(`\n=== POSTAL INFRASTRUCTURE ===`);
                lines.push(`District: ${post.district} (${post.totalInDistrict} post offices)`);
                post.nearest.forEach(p => {
                    lines.push(`- ${p.name} (${p.type}, PIN ${p.pincode}) — ${p.distance}`);
                });
            }
        }

        // --- Wikipedia Context ---
        if (include('wikipedia')) {
            const wiki = data.context?.wikipedia;
            if (wiki) {
                lines.push(`\n=== HISTORICAL CONTEXT ===`);
                lines.push(`${wiki.title} (${(wiki.distanceToCenter / 1000).toFixed(1)}km away): ${wiki.summary}`);
            }
        }

        return lines.join('\n');
    }

    // ===== URDPFI GAP ANALYSIS =====
    // Compare amenity distances against Indian planning norms
    function buildURDPFIGapAnalysis(data) {
        const lines = [];
        const gaps = [];
        const compliant = [];

        // Extract feature counts and distances from OSM data
        const features = {};
        Object.values(data.categories || {}).forEach(cat => {
            Object.values(cat.features || {}).forEach(f => {
                features[f.label.toLowerCase()] = f.count || 0;
            });
        });

        // Extract health facility distances
        const healthFacilities = data.context?.healthFacilities?.nearbyFacilities || [];
        const nearestHospital = healthFacilities.length > 0 ? healthFacilities[0] : null;

        // School check (within 500m radius — our data covers 400m)
        const schoolCount = (features['school'] || 0) + (features['college'] || 0) + (features['university'] || 0);
        if (schoolCount === 0) {
            gaps.push({ norm: 'Primary School within 500m (URDPFI)', status: 'NO school found within 400m scan radius', priority: 'High' });
        } else {
            compliant.push({ norm: 'School Access (500m)', status: schoolCount + ' school(s) found nearby' });
        }

        // Hospital check (within 1km)
        const hospitalCount = (features['hospital'] || 0) + (features['clinic'] || 0) + (features['doctors'] || 0);
        if (hospitalCount === 0 && !nearestHospital) {
            gaps.push({ norm: 'Hospital/Health Center within 1km (URDPFI)', status: 'NO health facility found within scan radius', priority: 'Critical' });
        } else {
            const facilityInfo = nearestHospital ? nearestHospital.name : (hospitalCount + ' facility/ies');
            compliant.push({ norm: 'Healthcare Access (1km)', status: facilityInfo + ' found nearby' });
        }

        // Park/Open Space check (within 500m)
        const parkCount = (features['park'] || 0) + (features['garden'] || 0) + (features['playground'] || 0) + (features['recreation ground'] || 0);
        if (parkCount === 0) {
            gaps.push({ norm: 'Park/Open Space within 500m (URDPFI)', status: 'NO park or open space found within scan radius', priority: 'High' });
        } else {
            compliant.push({ norm: 'Green Space Access (500m)', status: parkCount + ' park/open space(s) found' });
        }

        // Bus stop / transit check (within 500m)
        const transitCount = (features['bus stop'] || 0) + (features['bus station'] || 0);
        if (transitCount === 0) {
            gaps.push({ norm: 'Bus Stop within 500m (URDPFI)', status: 'NO public transit stop found within scan radius', priority: 'Medium' });
        } else {
            compliant.push({ norm: 'Transit Access (500m)', status: transitCount + ' transit stop(s) found' });
        }

        // Post office check
        const postOffices = data.context?.postOffices?.nearest || [];
        if (postOffices.length === 0) {
            gaps.push({ norm: 'Post Office accessibility', status: 'No post office data within range', priority: 'Low' });
        } else {
            compliant.push({ norm: 'Postal Access', status: postOffices[0].name + ' (' + postOffices[0].distance + ')' });
        }

        if (gaps.length > 0 || compliant.length > 0) {
            lines.push('\n=== URDPFI GAP ANALYSIS ===');
            if (gaps.length > 0) {
                lines.push('GAPS (non-compliant with Indian planning norms):');
                gaps.forEach(g => {
                    lines.push('  [' + g.priority + '] ' + g.norm + ' — ' + g.status);
                });
            }
            if (compliant.length > 0) {
                lines.push('COMPLIANT:');
                compliant.forEach(c => {
                    lines.push('  [OK] ' + c.norm + ' — ' + c.status);
                });
            }
        }

        return lines.join('\n');
    }

    // ===== COMPARATIVE ANALYSIS =====
    // Compare cell scores against city average
    function buildComparativeContext(data) {
        const scores = data.scores || {};
        const scoreEntries = Object.entries(scores).filter(([, s]) => s && s.value > 0);

        if (scoreEntries.length < 3) return '';

        // Compute simple city average from available scores (self-referential baseline)
        // In a real deployment this would come from a precomputed city average dataset
        const values = scoreEntries.map(([, s]) => s.value);
        const cellAvg = values.reduce((sum, v) => sum + v, 0) / values.length;

        // Use 50 as the normalized midpoint baseline for comparison
        const CITY_BASELINE = 50;

        const lines = [];
        lines.push('\n=== COMPARATIVE ANALYSIS (vs city baseline 50/100) ===');
        lines.push('Cell average score: ' + cellAvg.toFixed(1) + '/100 (' + (cellAvg >= CITY_BASELINE ? 'above' : 'below') + ' baseline)');

        // Find top 3 strengths (highest above baseline)
        const sorted = [...scoreEntries].sort((a, b) => b[1].value - a[1].value);
        const strengths = sorted.slice(0, 3);
        const weaknesses = [...scoreEntries].sort((a, b) => a[1].value - b[1].value).slice(0, 3);

        lines.push('\nTOP 3 STRENGTHS:');
        strengths.forEach(([key, s]) => {
            const diff = s.value - CITY_BASELINE;
            lines.push('  ' + (s.label || key) + ': ' + s.value + '/100 (' + (diff >= 0 ? '+' : '') + diff.toFixed(0) + ' vs baseline)');
        });

        lines.push('\nTOP 3 DEFICIENCIES:');
        weaknesses.forEach(([key, s]) => {
            const diff = s.value - CITY_BASELINE;
            lines.push('  ' + (s.label || key) + ': ' + s.value + '/100 (' + (diff >= 0 ? '+' : '') + diff.toFixed(0) + ' vs baseline)');
        });

        return lines.join('\n');
    }

    // ===== PLANNING PROMPT INJECTION =====
    // When planning mode is detected, append structured instruction
    function buildPlanningInstruction(question) {
        const q = question.toLowerCase();
        if (/what should be built|how to improve|development recommend|planning recommend|what.{0,20}(need|lack|missing)|improve this area|gap analysis|urban intervention|what.{0,10}develop|master plan|urdpfi|zoning suggest/.test(q)) {
            return '\n\n=== PLANNING RESPONSE FORMAT ===\n' +
                'Structure your response as follows:\n' +
                '1. **Strengths** — What this area does well (cite scores and features)\n' +
                '2. **Weaknesses** — Key deficiencies and gaps (reference URDPFI norms)\n' +
                '3. **Recommended Interventions** — Specific actions ranked by impact (e.g., "Build a primary health center", "Develop a neighborhood park of 0.5 hectare")\n' +
                '4. **Priority Level** — Classify each intervention as Critical / High / Medium / Low\n' +
                '5. **Estimated Impact** — How the interventions would change key scores\n' +
                'Use URDPFI norms and Guna demographics to justify each recommendation.';
        }
        return '';
    }

    // Build context filtered by question intent (smart filtering)
    function buildFilteredContext(cell, data, question) {
        _currentCellCode = cell.code; // track for cache keying
        const contextType = detectContextType(question);
        const sections = INTENT_SECTIONS[contextType];
        let context = buildContext(cell, data, sections);

        // Append comparative analysis for any cell-specific question
        context += buildComparativeContext(data);

        // Append URDPFI gap analysis when relevant
        if (contextType === 'planning' || contextType === 'infrastructure' || contextType === 'general') {
            context += buildURDPFIGapAnalysis(data);
        }

        // Append structured planning instruction if planning question detected
        context += buildPlanningInstruction(question);

        return context;
    }

    // ===== INTENT ROUTING =====
    function detectIntent(question) {
        const q = question.toLowerCase();

        const broadPatterns = [
            /where\s+(should|can|to|is the best|would)/,
            /best\s+(location|area|place|spot|zone|neighborhood)/,
            /find\s+(me\s+)?(a|the|best)\s+/,
            /recommend\s+(a|the|best|some)/,
            /which\s+(area|zone|neighborhood|part|ward)/,
            /compare\s+(areas?|zones?|neighborhoods?)/,
            /top\s+\d+\s+(areas?|locations?|places?)/,
            /city[\s-]?wide|across the city|entire city/,
            /hotspot|gap|deficit|surplus/
        ];

        for (const pat of broadPatterns) {
            if (pat.test(q)) return 'city_scan';
        }

        const queryKeywords = {
            'restaurant|food|dining|eat': 'restaurant',
            'mall|shopping|retail': 'mall',
            'hospital|health|medical|clinic': 'hospital',
            'school|education|college|university': 'school',
            'park|green|garden|nature': 'green',
            'hotel|tourism|tourist|heritage': 'tourism',
            'it hub|tech|coworking|startup': 'ithub',
            'ev|electric vehicle|charging': 'ev',
            'transit|bus|metro|transport': 'transit',
            'flood|waterlog|drainage': 'flood',
            'noise|quiet|peaceful': 'noise_hotspot',
            'air quality|pollution|aqi|pm2.5': 'air_quality',
            'safety|crime|safe|dangerous': 'safety_concern',
            'residential|living|house|flat|apartment': 'best_residential',
            'investment|real estate|property|land': 'realestate',
            'warehouse|logistics|industrial': 're_warehouse',
            'highrise|tower|tall building': 're_highrise',
            'affordable|budget|cheap': 'affordable',
            'luxury|premium|upscale': 'luxury',
            'redevelop|old building|demolish': 're_redevelop',
            'student|college area': 'student',
            'senior|elderly|retirement': 'senior',
            'family|kid|children|playground': 'family',
            'parking|park.car': 'parking',
            'solar|energy|panel|rooftop': null,
            'building|density|fsi|floor area': null,
            'smart city|iudx|sensor': null,
            'bike|cycle|mybyk': null,
        };

        for (const [pattern, queryId] of Object.entries(queryKeywords)) {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(q) && queryId) {
                if (broadPatterns.some(p => p.test(q))) return 'city_scan';
            }
        }

        return 'local';
    }

    function matchQueryId(question) {
        const q = question.toLowerCase();
        const mappings = [
            [/restaurant|food|dining|eat/, 'restaurant'],
            [/mall|shopping|retail|shop/, 'mall'],
            [/hospital|health|medical|clinic/, 'hospital'],
            [/school|education|college|university/, 'school'],
            [/park|green|garden|nature/, 'green'],
            [/hotel|tourism|tourist|heritage/, 'tourism'],
            [/it hub|tech|coworking|startup/, 'ithub'],
            [/ev|electric vehicle|charging/, 'ev'],
            [/transit|bus|metro|transport/, 'transit'],
            [/flood|waterlog|drainage/, 'flood'],
            [/noise|quiet|peaceful/, 'noise_hotspot'],
            [/air quality|pollution|aqi/, 'air_quality'],
            [/safety|crime|safe|dangerous/, 'safety_concern'],
            [/residential|living|house|flat/, 'best_residential'],
            [/investment|real estate|property/, 'realestate'],
            [/warehouse|logistics|industrial/, 're_warehouse'],
            [/highrise|tower|tall/, 're_highrise'],
            [/affordable|budget|cheap/, 'affordable'],
            [/luxury|premium|upscale/, 'luxury'],
            [/redevelop|old building/, 're_redevelop'],
            [/student|college area/, 'student'],
            [/senior|elderly|retirement/, 'senior'],
            [/family|kid|children/, 'family'],
            [/parking/, 'parking'],
        ];

        for (const [pattern, id] of mappings) {
            if (pattern.test(q)) return id;
        }
        return 'best_residential';
    }

    // ===== CITY-LEVEL SCAN (optimized) =====
    // Batches of 8, cell caching, faster processing
    async function cityScan(question, onStatus) {
        if (typeof MapModule === 'undefined') return null;

        const map = MapModule.getMap();
        const bounds = map.getBounds();
        const gridSize = 4;
        const latStep = (bounds.getNorth() - bounds.getSouth()) / gridSize;
        const lngStep = (bounds.getEast() - bounds.getWest()) / gridSize;

        const points = [];
        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                points.push({
                    lat: bounds.getSouth() + latStep * (i + 0.5),
                    lng: bounds.getWest() + lngStep * (j + 0.5)
                });
            }
        }

        if (onStatus) onStatus('Scanning city... 0/' + points.length);

        const queryId = matchQueryId(question);
        const queryDef = QueryEngine.getSectors()
            .flatMap(s => s.queries)
            .find(q => q.id === queryId);

        const weights = queryDef?.weights || {};
        const results = [];
        let done = 0;

        const hasCache = typeof DISHACache !== 'undefined';
        const BATCH_SIZE = 8; // 2x larger batches for faster scanning

        for (let batch = 0; batch < points.length; batch += BATCH_SIZE) {
            const chunk = points.slice(batch, batch + BATCH_SIZE);
            const batchResults = await Promise.allSettled(
                chunk.map(async pt => {
                    const code = typeof DigiPin !== 'undefined' ? DigiPin.encode(pt.lat, pt.lng) : 'N/A';

                    // Check cell cache first
                    let data = null;
                    if (hasCache) {
                        data = await DISHACache.getCellData(pt.lat, pt.lng);
                    }

                    if (!data) {
                        data = await DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400);
                        // Cache for future scans
                        if (hasCache) {
                            DISHACache.putCellData(pt.lat, pt.lng, data);
                        }
                    }

                    const score = QueryEngine.computeQueryScore(data.scores, weights);
                    const addr = data.address || {};
                    const area = addr.area || addr.city || '';
                    return { lat: pt.lat, lng: pt.lng, code, score, area, scores: data.scores, data };
                })
            );

            batchResults.forEach(r => {
                if (r.status === 'fulfilled') results.push(r.value);
                done++;
            });

            if (onStatus) onStatus(`Scanning city... ${done}/${points.length}`);

            if (batch + BATCH_SIZE < points.length) {
                await new Promise(r => setTimeout(r, 100)); // shorter delay with larger batches
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, 5);
    }

    function buildCityScanContext(results, question) {
        const lines = [];
        lines.push(`=== CITY-LEVEL SCAN RESULTS ===`);
        lines.push(`Question: "${question}"`);
        lines.push(`Sampled ${results.length > 5 ? '16' : results.length} points across visible map area.`);
        lines.push(`Top ${results.length} locations ranked by relevance:\n`);

        results.forEach((r, i) => {
            lines.push(`#${i + 1}: DigiPin ${r.code} (${r.area || 'Unknown'})`);
            lines.push(`   Coordinates: ${r.lat.toFixed(4)}N, ${r.lng.toFixed(4)}E`);
            lines.push(`   Match Score: ${r.score.toFixed(1)}/100`);

            const topScores = Object.entries(r.scores || {})
                .filter(([, s]) => s && s.value > 0)
                .sort((a, b) => b[1].value - a[1].value)
                .slice(0, 8)
                .map(([k, s]) => `${k}=${s.value}`)
                .join(', ');
            if (topScores) lines.push(`   Scores: ${topScores}`);
            lines.push('');
        });

        return lines.join('\n');
    }

    // ===== CONVERSATION MEMORY =====
    function addToHistory(role, content) {
        _conversationHistory.push({ role, content });
        if (_conversationHistory.length > MAX_HISTORY * 2) {
            _conversationHistory = _conversationHistory.slice(-MAX_HISTORY * 2);
        }
    }

    function clearHistory() {
        _conversationHistory = [];
    }

    // Format history as text block (for Ollama prompt-style)
    function getHistoryForPrompt() {
        if (_conversationHistory.length === 0) return '';
        const lines = ['\n=== CONVERSATION HISTORY ==='];
        _conversationHistory.forEach(msg => {
            const prefix = msg.role === 'user' ? 'User' : 'DISHA';
            const content = msg.content.length > 300
                ? msg.content.substring(0, 300) + '...'
                : msg.content;
            lines.push(`${prefix}: ${content}`);
        });
        return lines.join('\n');
    }

    // Format history as messages array (for OpenAI-compatible APIs)
    function getHistoryAsMessages() {
        return _conversationHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content.length > 500
                ? msg.content.substring(0, 500) + '...'
                : msg.content
        }));
    }

    // ===== PROMPT ASSEMBLY (Ollama) =====
    function assemblePrompt(context, question, cityScanContext) {
        let prompt = '';

        if (cityScanContext) {
            prompt += cityScanContext + '\n\n';
        }

        prompt += `[LOCATION DATA]\n${context}`;

        const history = getHistoryForPrompt();
        if (history) {
            prompt += '\n' + history;
        }

        prompt += `\n\n[CURRENT QUESTION]\n${question}`;

        return prompt;
    }

    // ===== STREAMING (via DISHAProviders, with cache) =====
    async function ask(context, question, onToken, onDone, onError, cityScanContext) {
        if (_abortController) {
            _abortController.abort();
        }
        _abortController = new AbortController();

        // Determine context type for cache key
        const contextType = detectContextType(question);

        // Check cache first (skip for city scans — they have unique scan data)
        if (!cityScanContext && _currentCellCode && typeof DISHACache !== 'undefined') {
            const cached = await DISHACache.getResponse(_currentCellCode, contextType, question);
            if (cached) {
                addToHistory('user', question);
                addToHistory('assistant', cached.response);
                // Simulate streaming for cached response (fast typewriter)
                const words = cached.response.split(' ');
                let i = 0;
                const chunkSize = 3;
                const interval = setInterval(() => {
                    if (i >= words.length) {
                        clearInterval(interval);
                        if (onDone) onDone({ cached: true });
                        _abortController = null;
                        return;
                    }
                    const chunk = words.slice(i, i + chunkSize).join(' ') + (i + chunkSize < words.length ? ' ' : '');
                    onToken(chunk);
                    i += chunkSize;
                }, 20);
                return;
            }
        }

        addToHistory('user', question);

        const provider = DISHAProviders.getActive();
        if (!provider) {
            if (onError) onError(new Error('No AI provider available'));
            return;
        }

        try {
            if (provider.type === 'ollama') {
                const prompt = assemblePrompt(context, question, cityScanContext);
                await DISHAProviders.stream({
                    system: SYSTEM_PROMPT,
                    prompt,
                    onToken,
                    onDone: (resp) => {
                        addToHistory('assistant', resp);
                        // Cache the response
                        if (!cityScanContext && _currentCellCode && typeof DISHACache !== 'undefined') {
                            DISHACache.putResponse(_currentCellCode, contextType, question, resp, provider.id);
                        }
                        if (onDone) onDone({});
                    },
                    onError,
                    signal: _abortController.signal
                });
            } else {
                let systemContent = SYSTEM_PROMPT + '\n\n[LOCATION DATA]\n' + context;
                if (cityScanContext) {
                    systemContent += '\n\n' + cityScanContext;
                }

                const historyMessages = getHistoryAsMessages();
                historyMessages.pop();
                const messages = [
                    ...historyMessages,
                    { role: 'user', content: question }
                ];

                await DISHAProviders.stream({
                    system: systemContent,
                    messages,
                    onToken,
                    onDone: (resp) => {
                        addToHistory('assistant', resp);
                        if (!cityScanContext && _currentCellCode && typeof DISHACache !== 'undefined') {
                            DISHACache.putResponse(_currentCellCode, contextType, question, resp, provider.id);
                        }
                        if (onDone) onDone({});
                    },
                    onError,
                    signal: _abortController.signal
                });
            }
        } catch (err) {
            if (err.name === 'AbortError') return;
            if (onError) onError(err);
        } finally {
            _abortController = null;
        }
    }

    function cancel() {
        if (_abortController) {
            _abortController.abort();
            _abortController = null;
        }
    }

    // ===== SMART SUGGESTIONS =====
    function getSuggestions(data) {
        const scores = data.scores || {};
        const suggestions = [];

        suggestions.push('Give me a full urban intelligence briefing');
        suggestions.push('What should be built here? Development recommendations');

        if ((scores.livability?.value || 0) > 60) {
            suggestions.push('Rate this area for residential living');
        }
        if ((scores.commercial?.value || 0) > 50) {
            suggestions.push('What business would thrive here?');
        }
        if ((scores.safety?.value || 0) < 40) {
            suggestions.push('Why is safety low here? What can improve it?');
        }
        if (data.context?.iudx) {
            suggestions.push('What smart city infrastructure is nearby?');
        }
        if (data.buildingIntel) {
            suggestions.push('Analyze building morphology and development potential');
        }
        if ((scores.flood_risk?.value || 0) > 50) {
            suggestions.push('Assess flood risk and mitigation options');
        }
        if (data.environment?.solar) {
            suggestions.push('Is this location good for solar panels?');
        }
        if ((scores.healthcare_access?.value || 0) < 30) {
            suggestions.push('How to improve healthcare access here?');
        }
        if ((scores.digital_readiness?.value || 0) > 40) {
            suggestions.push('Evaluate this for an IT park or tech hub');
        }

        suggestions.push('Run a gap analysis against URDPFI norms');
        suggestions.push('Where is the best location for a restaurant in this area?');

        return suggestions.slice(0, 5);
    }

    // ===== OFFLINE FALLBACK =====
    function offlineSummary(cell, data) {
        const scores = data.scores || {};
        const sorted = Object.entries(scores)
            .filter(([, s]) => s && s.value > 0)
            .sort((a, b) => b[1].value - a[1].value);

        if (sorted.length === 0) return 'No data available for analysis.';

        const top5 = sorted.slice(0, 5).map(([, s]) => `${s.label}: ${s.value}/100`);
        const bottom3 = sorted.slice(-3).map(([, s]) => `${s.label}: ${s.value}/100`);

        const addr = data.address || {};
        const location = [addr.area, addr.city].filter(Boolean).join(', ') || cell.code;

        let summary = `**Urban Intelligence Report** — DigiPin ${cell.code}\n`;
        summary += `Location: ${location}\n\n`;
        summary += `**Top Strengths:**\n${top5.map(s => '- ' + s).join('\n')}\n\n`;
        summary += `**Gaps:**\n${bottom3.map(s => '- ' + s).join('\n')}\n\n`;

        const env = data.environment || {};
        if (env.aqi != null) summary += `Air Quality: AQI ${env.aqi} (${getAQICategory(env.aqi)})\n`;
        if (env.solar) summary += `Solar: ${env.solar.ghiDaily} kWh/m2/day (${env.solar.solarPotential})\n`;
        if (env.populationDensity) summary += `Population: ${env.populationDensity.personsPerHectare} persons/ha\n`;

        const liv = scores.livability?.value || 0;
        summary += `\n**Verdict:** `;
        if (liv >= 70) summary += 'Good livability. Suitable for residential and mixed-use development.';
        else if (liv >= 40) summary += 'Moderate livability. Infrastructure gaps need addressing.';
        else summary += 'Low livability. Significant urban development investment needed.';

        summary += '\n\n[Offline — open Settings to configure a cloud AI provider]';
        return summary;
    }

    // ===== HELPERS =====
    function getAQICategory(aqi) {
        if (aqi <= 50) return 'Good';
        if (aqi <= 100) return 'Satisfactory';
        if (aqi <= 200) return 'Moderate';
        if (aqi <= 300) return 'Poor';
        if (aqi <= 400) return 'Very Poor';
        return 'Severe';
    }

    function isConnected() {
        return DISHAProviders.isConnected();
    }

    return {
        checkConnection,
        buildContext,
        buildFilteredContext,
        detectContextType,
        detectIntent,
        matchQueryId,
        cityScan,
        buildCityScanContext,
        ask,
        cancel,
        getSuggestions,
        offlineSummary,
        clearHistory,
        isConnected,
        getAQICategory
    };
})();
