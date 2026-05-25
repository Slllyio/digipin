/**
 * DISHA — Digital Intelligence for Spatial & Human Analysis
 * Urban Intelligence Engine — LLM-linked data analysis
 *
 * Architecture:
 *   All Data Sources -> Rich Context Builder -> Intent Router -> Ollama LLM -> Streamed Reply
 *
 * Features:
 *   - Full context injection: OSM, IUDX, solar, AQI, building intel, health, elevation, population
 *   - Conversation memory: multi-turn chat with history fed to LLM
 *   - Intent routing: broad questions auto-run query engine, feed results to LLM
 *   - City-level analysis: multi-point sampling for "where is the best..." questions
 */

const DISHA = (() => {
    const OLLAMA_URL = 'http://localhost:11434';
    const MODEL = 'qwen2.5:latest';

    let _connected = false;
    let _abortController = null;
    let _conversationHistory = [];   // multi-turn memory
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

    // ===== CONNECTION =====
    async function checkConnection() {
        try {
            const resp = await fetch(`${OLLAMA_URL}/api/tags`, {
                signal: AbortSignal.timeout(3000)
            });
            if (!resp.ok) return { connected: false, reason: 'Ollama not responding' };
            const data = await resp.json();
            const models = (data.models || []).map(m => m.name);
            _connected = models.length > 0;
            return {
                connected: _connected,
                models,
                reason: _connected ? 'Ready' : 'No models found. Run: ollama pull qwen2.5'
            };
        } catch {
            _connected = false;
            return { connected: false, reason: 'Ollama not running. Start with: ollama serve' };
        }
    }

    // ===== RICH CONTEXT BUILDER =====
    // Injects ALL data sources into a structured context the LLM can reason over
    function buildContext(cell, data) {
        const lines = [];

        // --- Location Header ---
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
        const addr = data.address || {};
        if (addr.area || addr.city) {
            lines.push(`Address: ${[addr.area, addr.city, addr.district, addr.state].filter(Boolean).join(', ')}${addr.pincode ? ' (PIN: ' + addr.pincode + ')' : ''}`);
        }
        if (addr.fullAddress) {
            lines.push(`Full: ${addr.fullAddress}`);
        }

        // --- Weather & Environment ---
        const env = data.environment || {};
        const envParts = [];
        if (env.temperature != null) envParts.push(`Temp: ${env.temperature}C`);
        if (env.humidity != null) envParts.push(`Humidity: ${env.humidity}%`);
        if (env.windSpeed != null) envParts.push(`Wind: ${env.windSpeed}km/h`);
        if (env.weatherDesc) envParts.push(env.weatherDesc);
        if (envParts.length > 0) lines.push(`Weather: ${envParts.join(', ')}`);

        // --- Air Quality (detailed) ---
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

        // --- Solar Radiation ---
        const solar = env.solar;
        if (solar) {
            const solarParts = [`GHI=${solar.ghiDaily} kWh/m2/day`];
            if (solar.sunshineDuration != null) solarParts.push(`Sunshine=${solar.sunshineDuration}h`);
            if (solar.solarPotential) solarParts.push(`Potential: ${solar.solarPotential}`);
            lines.push(`Solar: ${solarParts.join(', ')}`);
        }

        // --- Elevation & Flood ---
        const elev = env.elevation;
        if (elev && typeof elev === 'object') {
            lines.push(`Elevation: ${elev.center}m (${elev.relative > 0 ? '+' : ''}${elev.relative.toFixed(1)}m vs surroundings)${elev.isLowLying ? ' [LOW-LYING]' : ''}`);
        }

        // --- Population ---
        const pop = env.populationDensity;
        if (pop) {
            lines.push(`Population: ${pop.personsPerHectare} persons/hectare (${pop.densityLevel})`);
        }

        // --- Intelligence Scores ---
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

        // --- Building Intelligence ---
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

        // --- IUDX Smart City Data ---
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

        // --- IUDX Catalogue (available datasets for this city) ---
        const catalogue = data.context?.iudxCatalogue;
        if (catalogue) {
            lines.push(`\n=== IUDX OPEN DATASETS (${catalogue.totalDatasets} for ${catalogue.city}) ===`);
            for (const [domain, datasets] of Object.entries(catalogue.byDomain || {})) {
                lines.push(`${domain.toUpperCase()}: ${datasets.map(d => d.label).join(', ')}`);
            }
        }

        // --- Health Facilities ---
        const health = data.context?.healthFacilities;
        if (health && health.nearbyFacilities?.length > 0) {
            lines.push(`\n=== HEALTH FACILITIES ===`);
            health.nearbyFacilities.forEach(h => {
                lines.push(`- ${h.name} (${h.type}, ${h.beds} beds)`);
            });
        }

        // --- CEPI Pollution Index ---
        const cepi = data.context?.cepi;
        if (cepi && cepi.clusters?.length > 0) {
            lines.push(`\n=== ENVIRONMENTAL POLLUTION INDEX (CEPI) ===`);
            cepi.clusters.forEach(c => {
                lines.push(`- ${c.name} (${c.state}): CEPI=${c.cepiScore2013 || c.cepiScore2011 || 'N/A'}/100, Moratorium: ${c.moratorium}`);
            });
        }

        // --- Nearby Post Offices ---
        const post = data.context?.postOffices;
        if (post && post.nearest?.length > 0) {
            lines.push(`\n=== POSTAL INFRASTRUCTURE ===`);
            lines.push(`District: ${post.district} (${post.totalInDistrict} post offices)`);
            post.nearest.forEach(p => {
                lines.push(`- ${p.name} (${p.type}, PIN ${p.pincode}) — ${p.distance}`);
            });
        }

        // --- Wikipedia Context ---
        const wiki = data.context?.wikipedia;
        if (wiki) {
            lines.push(`\n=== HISTORICAL CONTEXT ===`);
            lines.push(`${wiki.title} (${(wiki.distanceToCenter / 1000).toFixed(1)}km away): ${wiki.summary}`);
        }

        return lines.join('\n');
    }

    // ===== INTENT ROUTING =====
    // Detects whether the user's question needs multi-cell analysis
    function detectIntent(question) {
        const q = question.toLowerCase();

        // City-level / "where" questions — need multi-point sampling
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

        // Query engine match — map to closest sector query
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
            'solar|energy|panel|rooftop': null,  // handled by local context
            'building|density|fsi|floor area': null,
            'smart city|iudx|sensor': null,
            'bike|cycle|mybyk': null,
        };

        for (const [pattern, queryId] of Object.entries(queryKeywords)) {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(q) && queryId) {
                // Only return city_scan for "where/best" questions about these topics
                if (broadPatterns.some(p => p.test(q))) return 'city_scan';
            }
        }

        // Default: answer from current cell context
        return 'local';
    }

    // Detect which query engine query best matches the user's question
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
        return 'best_residential'; // fallback
    }

    // ===== CITY-LEVEL SCAN =====
    // Samples multiple points across the visible map area and feeds aggregated results to LLM
    async function cityScan(question, onStatus) {
        if (typeof MapModule === 'undefined') return null;

        const map = MapModule.getMap();
        const bounds = map.getBounds();
        const gridSize = 4; // 4x4 = 16 sample points
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

        // Determine which query to score by
        const queryId = matchQueryId(question);
        const queryDef = QueryEngine.getSectors()
            .flatMap(s => s.queries)
            .find(q => q.id === queryId);

        const weights = queryDef?.weights || {};
        const results = [];
        let done = 0;

        // Process in batches of 4
        for (let batch = 0; batch < points.length; batch += 4) {
            const chunk = points.slice(batch, batch + 4);
            const batchResults = await Promise.allSettled(
                chunk.map(async pt => {
                    const code = typeof DigiPin !== 'undefined' ? DigiPin.encode(pt.lat, pt.lng) : 'N/A';
                    const data = await DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400);
                    const score = QueryEngine.computeQueryScore(data.scores, weights);
                    // Build a mini summary for each point
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

            if (batch + 4 < points.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        // Sort by score, return top 5
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, 5);
    }

    // Build context from city scan results
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

            // Add key scores for this point
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
        // Trim to last MAX_HISTORY exchanges
        if (_conversationHistory.length > MAX_HISTORY * 2) {
            _conversationHistory = _conversationHistory.slice(-MAX_HISTORY * 2);
        }
    }

    function clearHistory() {
        _conversationHistory = [];
    }

    function getHistoryForPrompt() {
        if (_conversationHistory.length === 0) return '';
        const lines = ['\n=== CONVERSATION HISTORY ==='];
        _conversationHistory.forEach(msg => {
            const prefix = msg.role === 'user' ? 'User' : 'DISHA';
            // Truncate long responses in history to save context
            const content = msg.content.length > 300
                ? msg.content.substring(0, 300) + '...'
                : msg.content;
            lines.push(`${prefix}: ${content}`);
        });
        return lines.join('\n');
    }

    // ===== PROMPT ASSEMBLY =====
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

    // ===== STREAMING =====
    async function ask(context, question, onToken, onDone, onError, cityScanContext) {
        if (_abortController) {
            _abortController.abort();
        }
        _abortController = new AbortController();

        const prompt = assemblePrompt(context, question, cityScanContext);

        // Add user question to history
        addToHistory('user', question);

        try {
            const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: MODEL,
                    system: SYSTEM_PROMPT,
                    prompt: prompt,
                    stream: true,
                    options: {
                        temperature: 0.3,
                        num_ctx: 8192,
                        top_p: 0.9,
                        repeat_penalty: 1.1
                    }
                }),
                signal: _abortController.signal
            });

            if (!resp.ok) {
                throw new Error(`Ollama returned ${resp.status}`);
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullResponse = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.response) {
                            fullResponse += parsed.response;
                            onToken(parsed.response);
                        }
                        if (parsed.done) {
                            // Save assistant response to history
                            addToHistory('assistant', fullResponse);
                            if (onDone) onDone(parsed);
                            return;
                        }
                    } catch {
                        // Skip malformed JSON
                    }
                }
            }

            addToHistory('assistant', fullResponse);
            if (onDone) onDone({});
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
            suggestions.push('Is a hospital needed in this area?');
        }
        if ((scores.digital_readiness?.value || 0) > 40) {
            suggestions.push('Evaluate this for an IT park or tech hub');
        }

        // Always include a city-level question
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

        // Environment summary
        const env = data.environment || {};
        if (env.aqi != null) summary += `Air Quality: AQI ${env.aqi} (${getAQICategory(env.aqi)})\n`;
        if (env.solar) summary += `Solar: ${env.solar.ghiDaily} kWh/m2/day (${env.solar.solarPotential})\n`;
        if (env.populationDensity) summary += `Population: ${env.populationDensity.personsPerHectare} persons/ha\n`;

        const liv = scores.livability?.value || 0;
        summary += `\n**Verdict:** `;
        if (liv >= 70) summary += 'Good livability. Suitable for residential and mixed-use development.';
        else if (liv >= 40) summary += 'Moderate livability. Infrastructure gaps need addressing.';
        else summary += 'Low livability. Significant urban development investment needed.';

        summary += '\n\n[Offline mode — connect Ollama for full AI analysis]';
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

    function isConnected() { return _connected; }

    return {
        checkConnection,
        buildContext,
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
