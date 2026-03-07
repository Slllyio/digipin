/**
 * Urban Intelligence — Training Data Generator
 *
 * Generates Q&A training pairs from real urban data for fine-tuning
 * a local LLM (qwen2.5 / llama3) on urban intelligence tasks.
 *
 * Usage (in browser console):
 *   const dataset = await TrainingDataGen.generate({ points: 100, city: 'indore' });
 *   TrainingDataGen.exportJSON(dataset);      // → digipin_training_data.json
 *   TrainingDataGen.exportAlpaca(dataset);    // → Alpaca format for unsloth/axolotl
 *
 * Output format: Array of { instruction, input, output } objects
 * Compatible with: Alpaca, ShareGPT, OpenAI fine-tune formats
 */

const TrainingDataGen = (() => {

    // ===== Q&A TEMPLATES =====
    // Each template generates a question + expected structured answer from cell data
    const TEMPLATES = [
        // --- General Analysis ---
        {
            id: 'general_briefing',
            question: () => 'Give me a full urban intelligence briefing for this location.',
            answer: (d, ctx) => {
                const top3 = getTopScores(d, 3);
                const bottom3 = getBottomScores(d, 3);
                const addr = formatAddr(d);
                const liv = d.scores?.livability?.value || 0;
                const verdict = liv >= 70 ? 'Good' : liv >= 40 ? 'Moderate' : 'Poor';

                return `**Verdict:** ${verdict}\n\n` +
                    `**Location:** ${addr}\n\n` +
                    `**Top Strengths:**\n${top3.map(s => `- ${s.label}: ${s.value}/100`).join('\n')}\n\n` +
                    `**Key Gaps:**\n${bottom3.map(s => `- ${s.label}: ${s.value}/100`).join('\n')}\n\n` +
                    `**Environment:** ${formatEnv(d)}\n\n` +
                    `**Best For:** ${suggestBestUse(d)}\n` +
                    `**Action:** ${suggestAction(d)}`;
            }
        },
        // --- Safety ---
        {
            id: 'safety_analysis',
            question: () => 'Is this area safe? What affects the safety score?',
            answer: (d) => {
                const safety = d.scores?.safety?.value || 0;
                const lamps = getFeatureCount(d, 'infrastructure', 'street_lamps');
                const police = getFeatureCount(d, 'government', 'police');
                const verdict = safety >= 70 ? 'Good' : safety >= 40 ? 'Moderate' : 'Poor';

                return `**Safety Rating:** ${verdict} (safety=${safety}/100)\n\n` +
                    `- Street lamps: ${lamps} (${lamps > 30 ? 'well-lit' : lamps > 10 ? 'moderate lighting' : 'poorly lit'})\n` +
                    `- Police stations: ${police} nearby\n` +
                    `- Quietness: ${d.scores?.noise_estimate?.value || 0}/100\n\n` +
                    (safety < 50 ? `**Improvements needed:** More street lighting, CCTV coverage, and police patrolling would improve safety scores.` :
                        `**Assessment:** This area has adequate safety infrastructure for residential and commercial use.`);
            }
        },
        // --- Residential Suitability ---
        {
            id: 'residential_suitability',
            question: () => 'Rate this area for residential living. Is it suitable for families?',
            answer: (d) => {
                const liv = d.scores?.livability?.value || 0;
                const green = d.scores?.green?.value || 0;
                const healthcare = d.scores?.healthcare_access?.value || 0;
                const edu = d.scores?.education_score?.value || 0;
                const safety = d.scores?.safety?.value || 0;
                const noise = d.scores?.noise_estimate?.value || 0;

                const rating = liv >= 70 ? 'Excellent' : liv >= 50 ? 'Good' : liv >= 30 ? 'Below Average' : 'Poor';

                return `**Residential Rating:** ${rating} (livability=${liv}/100)\n\n` +
                    `- Green spaces: ${green}/100 ${green > 50 ? '(adequate parks/gardens)' : '(limited greenery)'}\n` +
                    `- Healthcare: ${healthcare}/100 ${healthcare > 50 ? '(hospitals/clinics accessible)' : '(medical access gap)'}\n` +
                    `- Education: ${edu}/100 ${edu > 50 ? '(schools nearby)' : '(limited schools)'}\n` +
                    `- Safety: ${safety}/100\n` +
                    `- Quietness: ${noise}/100\n\n` +
                    `**For Families:** ${edu > 40 && safety > 40 && green > 30 ? 'Yes, suitable for families with children.' : 'Gaps in education/safety/green space may be concerns for families.'}`;
            }
        },
        // --- Commercial Potential ---
        {
            id: 'commercial_potential',
            question: () => 'What business would thrive here? Analyze commercial potential.',
            answer: (d) => {
                const comm = d.scores?.commercial?.value || 0;
                const food = d.scores?.food_diversity?.value || 0;
                const walk = d.scores?.walkability?.value || 0;
                const pop = d.scores?.population_proxy?.value || 0;
                const digital = d.scores?.digital_readiness?.value || 0;

                const suggestions = [];
                if (food < 30 && pop > 40) suggestions.push('Restaurant/food court (food gap in populated area)');
                if (comm > 50 && digital > 40) suggestions.push('IT services/coworking space');
                if (pop > 50 && comm < 30) suggestions.push('Retail store/convenience shop (underserved residential)');
                if (walk > 50 && food > 30) suggestions.push('Cafe/bakery (high foot traffic)');
                if (pop > 40 && d.scores?.healthcare_access?.value < 30) suggestions.push('Pharmacy/clinic (healthcare gap)');
                if (suggestions.length === 0) suggestions.push('Mixed retail — moderate potential across categories');

                return `**Commercial Vibrancy:** ${comm}/100\n` +
                    `**Walkability:** ${walk}/100 | **Population:** ${pop}/100 | **Digital:** ${digital}/100\n\n` +
                    `**Recommended Businesses:**\n${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
                    `**Rationale:** ${comm > 50 ? 'High existing commercial activity suggests a proven market.' : 'Lower commercial density means less competition but also less proven demand.'}`;
            }
        },
        // --- AQI & Environment ---
        {
            id: 'environment_assessment',
            question: () => 'How is the air quality and environment here?',
            answer: (d) => {
                const env = d.environment || {};
                const aqi = env.aqi;
                const pm25 = env.pm25;
                const solar = env.solar;
                const flood = d.scores?.flood_risk?.value || 0;

                const aqiCat = aqi != null ? DISHA.getAQICategory(aqi) : 'No data';

                return `**Air Quality:** AQI=${aqi || 'N/A'} (${aqiCat})\n` +
                    (pm25 != null ? `- PM2.5: ${pm25} ug/m3 ${pm25 > 60 ? '(above safe limits)' : '(within acceptable range)'}\n` : '') +
                    (env.pm10 != null ? `- PM10: ${env.pm10} ug/m3\n` : '') +
                    `\n**Weather:** ${env.temperature || 'N/A'}C, ${env.humidity || 'N/A'}% humidity, ${env.weatherDesc || ''}\n` +
                    (solar ? `\n**Solar Potential:** ${solar.ghiDaily} kWh/m2/day (${solar.solarPotential})` +
                        (solar.sunshineDuration ? `, ${solar.sunshineDuration}h sunshine` : '') + '\n' : '') +
                    `\n**Flood Risk:** ${flood}/100 ${flood > 60 ? '(HIGH — low-lying area near water bodies)' : flood > 40 ? '(moderate)' : '(low)'}`;
            }
        },
        // --- Smart City / IUDX ---
        {
            id: 'smart_city',
            question: () => 'What smart city infrastructure is nearby?',
            answer: (d) => {
                const iudx = d.context?.iudx;
                if (!iudx) return 'No IUDX smart city data available for this location. The city may not be covered by the India Urban Data Exchange.';

                let text = `**Smart City Infrastructure (IUDX Data)**\n\n`;
                for (const [, cat] of Object.entries(iudx.nearby || {})) {
                    if (cat.items.length > 0) {
                        text += `**${cat.label}** (${cat.total} total in city):\n`;
                        cat.items.forEach(item => {
                            text += `- ${item.name} — ${item.distance}\n`;
                        });
                        text += '\n';
                    }
                }
                text += `**Assessment:** ${iudx.totalNearby > 8 ? 'Well-connected to smart city infrastructure.' : 'Limited smart city coverage — may need more sensors/displays.'}`;
                return text;
            }
        },
        // --- Building Morphology ---
        {
            id: 'building_analysis',
            question: () => 'Analyze building morphology and development potential.',
            answer: (d) => {
                const bi = d.buildingIntel;
                if (!bi) return 'No building intelligence data available. This may indicate a low-density or unmapped area.';

                const m = bi.metrics || {};
                const lcz = bi.lcz;
                const devPot = bi.scores?.development_potential?.value || 0;
                const redev = bi.scores?.redevelopment_index?.value || 0;

                return `**Building Morphology**\n\n` +
                    (lcz ? `- LCZ Class: ${lcz.class} (${lcz.description})\n` : '') +
                    (m.building_count != null ? `- Buildings: ${m.building_count}\n` : '') +
                    (m.avg_height != null ? `- Average height: ${m.avg_height.toFixed(1)}m\n` : '') +
                    (m.max_height != null ? `- Max height: ${m.max_height.toFixed(1)}m\n` : '') +
                    (m.fsi != null ? `- FSI: ${m.fsi.toFixed(2)}\n` : '') +
                    `\n**Development Potential:** ${devPot}/100\n` +
                    `**Redevelopment Index:** ${redev}/100\n\n` +
                    (devPot > 60 ? '**Opportunity:** High development potential — suitable for new construction or vertical expansion.' :
                        redev > 60 ? '**Opportunity:** High redevelopment index — aging structures could be replaced with modern buildings.' :
                            '**Assessment:** Area is moderately developed. Limited immediate development opportunity.');
            }
        },
        // --- Solar Potential ---
        {
            id: 'solar_potential',
            question: () => 'Is this location good for solar panels?',
            answer: (d) => {
                const solar = d.environment?.solar;
                if (!solar) return 'No solar radiation data available for this location.';

                return `**Solar Assessment**\n\n` +
                    `- Daily GHI: ${solar.ghiDaily} kWh/m2/day (${solar.solarPotential})\n` +
                    `- Raw radiation: ${solar.ghiMJ} MJ/m2/day\n` +
                    (solar.sunshineDuration != null ? `- Sunshine: ${solar.sunshineDuration} hours/day\n` : '') +
                    `\n**Verdict:** ${solar.solarPotential === 'Excellent' ? 'Excellent location for rooftop solar. Expected annual generation of ~1,500-1,800 kWh per kW installed.' :
                        solar.solarPotential === 'Good' ? 'Good solar potential. Rooftop panels would be cost-effective with 4-5 year payback.' :
                            'Moderate solar potential. May need larger panel area for desired output.'}`;
            }
        },
        // --- Investment ---
        {
            id: 'investment_analysis',
            question: () => 'Analyze this area for real estate investment.',
            answer: (d) => {
                const growth = d.scores?.real_estate_growth?.value || 0;
                const invest = d.scores?.investment?.value || 0;
                const conn = d.scores?.connectivity?.value || 0;
                const infra = d.scores?.infra_maturity?.value || 0;
                const comm = d.scores?.commercial?.value || 0;

                const rating = (growth + invest) / 2;
                const verdict = rating >= 60 ? 'Strong Buy' : rating >= 40 ? 'Hold/Monitor' : 'Weak';

                return `**Investment Signal:** ${verdict}\n\n` +
                    `- Real Estate Growth: ${growth}/100\n` +
                    `- Investment Potential: ${invest}/100\n` +
                    `- Connectivity: ${conn}/100\n` +
                    `- Infrastructure: ${infra}/100\n` +
                    `- Commercial Activity: ${comm}/100\n\n` +
                    (rating >= 60 ? '**Outlook:** Active construction and infrastructure development indicate growth trajectory. Consider commercial or mixed-use investment.' :
                        rating >= 40 ? '**Outlook:** Moderate growth signals. Area may appreciate with planned infrastructure upgrades.' :
                            '**Outlook:** Limited growth indicators. Long-term hold only if infrastructure plans are confirmed.');
            }
        },
        // --- Comparative Question ---
        {
            id: 'best_use',
            question: () => 'What is this location best suited for?',
            answer: (d, ctx) => {
                const bestUse = suggestBestUse(d);
                const top3 = getTopScores(d, 3);

                return `**Best Use:** ${bestUse}\n\n` +
                    `**Supporting Data:**\n${top3.map(s => `- ${s.label}: ${s.value}/100`).join('\n')}\n\n` +
                    `**Location:** ${formatAddr(d)}`;
            }
        }
    ];

    // ===== HELPER FUNCTIONS =====

    function getTopScores(d, n) {
        return Object.entries(d.scores || {})
            .filter(([, s]) => s && s.value > 0)
            .sort((a, b) => b[1].value - a[1].value)
            .slice(0, n)
            .map(([k, s]) => ({ key: k, label: s.label, value: s.value }));
    }

    function getBottomScores(d, n) {
        return Object.entries(d.scores || {})
            .filter(([, s]) => s && s.value > 0)
            .sort((a, b) => a[1].value - b[1].value)
            .slice(0, n)
            .map(([k, s]) => ({ key: k, label: s.label, value: s.value }));
    }

    function getFeatureCount(d, cat, feature) {
        return d.categories?.[cat]?.features?.[feature]?.count || 0;
    }

    function formatAddr(d) {
        const addr = d.address || {};
        return [addr.area, addr.city, addr.state].filter(Boolean).join(', ') || 'Unknown';
    }

    function formatEnv(d) {
        const env = d.environment || {};
        const parts = [];
        if (env.temperature != null) parts.push(`${env.temperature}C`);
        if (env.aqi != null) parts.push(`AQI ${env.aqi}`);
        if (env.solar?.solarPotential) parts.push(`Solar: ${env.solar.solarPotential}`);
        return parts.join(', ') || 'No environmental data';
    }

    function suggestBestUse(d) {
        const scores = d.scores || {};
        const top = Object.entries(scores)
            .filter(([, s]) => s && s.value > 0)
            .sort((a, b) => b[1].value - a[1].value);

        if (top.length === 0) return 'Insufficient data for recommendation';

        const topKey = top[0][0];
        const map = {
            walkability: 'Pedestrian-friendly mixed-use zone',
            safety: 'Residential development (safe neighborhood)',
            green: 'Eco-residential or park expansion',
            connectivity: 'Transit-oriented development',
            commercial: 'Commercial/retail hub',
            education_score: 'Educational campus or student housing',
            healthcare_access: 'Medical/wellness zone',
            entertainment_score: 'Entertainment and cultural district',
            livability: 'Premium residential area',
            investment: 'Real estate investment zone',
            tourism: 'Tourism and hospitality development',
            digital_readiness: 'IT park or tech startup hub',
            food_diversity: 'Food court or restaurant cluster'
        };

        return map[topKey] || 'Mixed-use urban development';
    }

    function suggestAction(d) {
        const bottom = getBottomScores(d, 1);
        if (bottom.length === 0) return 'Continue monitoring urban development indicators.';

        const gap = bottom[0];
        const actions = {
            safety: 'Install more street lighting and CCTV cameras',
            green: 'Develop a community park or urban garden',
            healthcare_access: 'Establish a primary health center',
            education_score: 'Plan a new school or library',
            connectivity: 'Add bus stops or improve road access',
            digital_readiness: 'Deploy cell towers and public WiFi',
            walkability: 'Build pedestrian paths and crossings'
        };

        return actions[gap.key] || `Address ${gap.label} (currently ${gap.value}/100)`;
    }

    // ===== CITY GRID SAMPLING =====

    function generateSamplePoints(bounds, count) {
        const points = [];
        const gridSize = Math.ceil(Math.sqrt(count));
        const latStep = (bounds.north - bounds.south) / gridSize;
        const lngStep = (bounds.east - bounds.west) / gridSize;

        for (let i = 0; i < gridSize && points.length < count; i++) {
            for (let j = 0; j < gridSize && points.length < count; j++) {
                // Add small random jitter to avoid grid artifacts
                const jitterLat = (Math.random() - 0.5) * latStep * 0.3;
                const jitterLng = (Math.random() - 0.5) * lngStep * 0.3;
                points.push({
                    lat: bounds.south + latStep * (i + 0.5) + jitterLat,
                    lng: bounds.west + lngStep * (j + 0.5) + jitterLng
                });
            }
        }

        return points;
    }

    // ===== MAIN GENERATOR =====

    async function generate(options = {}) {
        const {
            points: numPoints = 50,
            batchSize = 3,
            delayMs = 500,
            bounds = { south: 22.65, north: 22.80, west: 75.80, east: 75.94 }, // Indore
            onProgress = null
        } = options;

        const samplePoints = generateSamplePoints(bounds, numPoints);
        const dataset = [];
        let completed = 0;

        console.log(`[TrainingDataGen] Starting generation: ${samplePoints.length} points x ${TEMPLATES.length} templates = ~${samplePoints.length * TEMPLATES.length} training pairs`);

        for (let batch = 0; batch < samplePoints.length; batch += batchSize) {
            const chunk = samplePoints.slice(batch, batch + batchSize);

            const results = await Promise.allSettled(
                chunk.map(async (pt) => {
                    const data = await DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400);
                    const code = typeof DigiPin !== 'undefined' ? DigiPin.encode(pt.lat, pt.lng) : 'UNKNOWN';
                    const cell = { code, center: { lat: pt.lat, lng: pt.lng } };
                    const context = DISHA.buildContext(cell, data);

                    // Generate Q&A pairs from each template
                    const pairs = [];
                    TEMPLATES.forEach(tmpl => {
                        try {
                            const question = tmpl.question(data);
                            const answer = tmpl.answer(data, context);

                            // Only include if answer has meaningful content
                            if (answer && answer.length > 50) {
                                pairs.push({
                                    instruction: question,
                                    input: context,
                                    output: answer,
                                    metadata: {
                                        template_id: tmpl.id,
                                        digipin: code,
                                        lat: pt.lat,
                                        lng: pt.lng,
                                        timestamp: new Date().toISOString()
                                    }
                                });
                            }
                        } catch {
                            // Skip failed templates
                        }
                    });

                    return pairs;
                })
            );

            results.forEach(r => {
                if (r.status === 'fulfilled' && r.value) {
                    dataset.push(...r.value);
                }
                completed++;
            });

            if (onProgress) {
                onProgress(completed, samplePoints.length, dataset.length);
            }

            console.log(`[TrainingDataGen] ${completed}/${samplePoints.length} points | ${dataset.length} pairs generated`);

            if (batch + batchSize < samplePoints.length) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        }

        console.log(`[TrainingDataGen] Complete! ${dataset.length} training pairs from ${completed} points`);
        return dataset;
    }

    // ===== EXPORT FORMATS =====

    function exportJSON(dataset, filename = 'digipin_training_data.json') {
        const json = JSON.stringify(dataset, null, 2);
        downloadBlob(json, filename, 'application/json');
        console.log(`[TrainingDataGen] Exported ${dataset.length} pairs to ${filename}`);
    }

    // Alpaca format (for unsloth / axolotl fine-tuning)
    function exportAlpaca(dataset, filename = 'digipin_alpaca.json') {
        const alpaca = dataset.map(d => ({
            instruction: d.instruction,
            input: d.input,
            output: d.output
        }));
        const json = JSON.stringify(alpaca, null, 2);
        downloadBlob(json, filename, 'application/json');
        console.log(`[TrainingDataGen] Exported ${alpaca.length} Alpaca pairs to ${filename}`);
    }

    // ShareGPT format (for LLaMA-Factory)
    function exportShareGPT(dataset, filename = 'digipin_sharegpt.json') {
        const sharegpt = dataset.map(d => ({
            conversations: [
                { from: 'system', value: 'You are DISHA, an expert urban intelligence advisor for India\'s DigiPin system. You analyze real urban data including OSM features, weather, AQI, solar radiation, building morphology, IUDX smart city sensors, and 30 intelligence scores.' },
                { from: 'human', value: `[CONTEXT]\n${d.input}\n\n[QUESTION]\n${d.instruction}` },
                { from: 'gpt', value: d.output }
            ]
        }));
        const json = JSON.stringify(sharegpt, null, 2);
        downloadBlob(json, filename, 'application/json');
        console.log(`[TrainingDataGen] Exported ${sharegpt.length} ShareGPT pairs to ${filename}`);
    }

    // Stats summary
    function stats(dataset) {
        const templateCounts = {};
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        dataset.forEach(d => {
            const id = d.metadata?.template_id || 'unknown';
            templateCounts[id] = (templateCounts[id] || 0) + 1;
            // Rough token estimate (words / 0.75)
            totalInputTokens += Math.ceil(d.input.split(/\s+/).length / 0.75);
            totalOutputTokens += Math.ceil(d.output.split(/\s+/).length / 0.75);
        });

        return {
            totalPairs: dataset.length,
            templateBreakdown: templateCounts,
            avgInputTokens: Math.round(totalInputTokens / dataset.length),
            avgOutputTokens: Math.round(totalOutputTokens / dataset.length),
            uniqueLocations: new Set(dataset.map(d => d.metadata?.digipin)).size
        };
    }

    function downloadBlob(content, filename, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    return {
        generate,
        exportJSON,
        exportAlpaca,
        exportShareGPT,
        stats,
        TEMPLATES
    };
})();
