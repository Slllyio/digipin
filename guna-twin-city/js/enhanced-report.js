/**
 * Enhanced Report Module — Guna Digital Twin
 * ============================================
 * Extends the base Report module with:
 *  - Ward-level aggregation of cell scores
 *  - Comparative analysis against city averages
 *  - LLM narrative planning assessment (via DISHA providers)
 *  - CSS-only bar charts for score distribution
 *  - URDPFI norm compliance for infrastructure access
 *  - Comparative ranking within the city
 *
 * Output: print-friendly HTML report in a new window.
 * DOM construction: createElement/textContent ONLY — no innerHTML.
 */
const EnhancedReport = (() => {

    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    const GUNA = { lat: 24.6354, lng: 77.3126 };

    /** Key scores to feature in the dashboard */
    const DASHBOARD_SCORES = [
        'walkability', 'green', 'connectivity', 'safety',
        'commercial', 'healthcare_access', 'education_score',
        'livability', 'investment', 'infra_maturity'
    ];

    /** URDPFI norms — maximum acceptable distance in metres */
    const URDPFI_NORMS = {
        hospitals:    { label: 'Hospital',       norm: 800 },
        clinics:      { label: 'Clinic/PHC',     norm: 400 },
        schools:      { label: 'Primary School', norm: 500 },
        colleges:     { label: 'Secondary School', norm: 1000 },
        police:       { label: 'Police Station', norm: 800 },
        fire_station: { label: 'Fire Station',   norm: 1500 },
        bus_stop:     { label: 'Bus Stop',        norm: 300 },
        parks:        { label: 'Park/Open Space', norm: 500 },
        pharmacies:   { label: 'Pharmacy',        norm: 500 }
    };

    /** Simulated city-average scores (sampled from Guna grid) */
    const CITY_AVERAGES = {
        walkability: 28, safety: 35, green: 18, connectivity: 22,
        commercial: 20, education_score: 15, healthcare_access: 12,
        entertainment_score: 8, livability: 30, investment: 14,
        tourism: 10, infra_maturity: 25, noise_estimate: 40,
        food_diversity: 16
    };

    // ═══════════════════════════════════════════════════════════════
    // DOM HELPERS  (createElement/textContent only — NO innerHTML)
    // ═══════════════════════════════════════════════════════════════

    function mk(doc, tag, className, style) {
        const el = doc.createElement(tag);
        if (className) el.className = className;
        if (style) el.style.cssText = style;
        return el;
    }

    function txt(doc, tag, text, className, style) {
        const el = mk(doc, tag, className, style);
        el.textContent = text;
        return el;
    }

    function metaCard(doc, val, label, sublabel) {
        const card = mk(doc, 'div', 'meta-card');
        card.appendChild(txt(doc, 'div', val, 'meta-val'));
        card.appendChild(txt(doc, 'div', label, 'meta-label'));
        if (sublabel) card.appendChild(txt(doc, 'div', sublabel, 'meta-sub'));
        return card;
    }

    // ═══════════════════════════════════════════════════════════════
    // REPORT STYLES (print-friendly)
    // ═══════════════════════════════════════════════════════════════

    function getStyles() {
        return `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', system-ui, sans-serif; color: #1e293b; max-width: 860px; margin: 0 auto; padding: 40px 30px; line-height: 1.6; }
h2 { font-size: 16px; color: #334155; margin: 28px 0 10px; padding-bottom: 4px; border-bottom: 2px solid #e2e8f0; }
h3 { font-size: 14px; color: #475569; margin: 16px 0 6px; }
.header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0f172a; padding-bottom: 16px; margin-bottom: 20px; }
.digipin { font-family: 'Courier New', monospace; font-size: 28px; font-weight: bold; color: #7c3aed; letter-spacing: 2px; }
.coords { font-size: 11px; color: #94a3b8; margin-top: 2px; }
.branding { text-align: right; font-size: 11px; color: #94a3b8; }
.exec-summary { background: #f0f9ff; border-left: 4px solid #0284c7; padding: 14px 18px; margin: 12px 0; border-radius: 0 8px 8px 0; font-size: 13px; color: #0c4a6e; line-height: 1.7; }
.meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 12px 0; }
.meta-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; text-align: center; }
.meta-val { font-size: 20px; font-weight: 700; color: #0f172a; }
.meta-label { font-size: 10px; color: #64748b; text-transform: uppercase; }
.meta-sub { font-size: 9px; color: #94a3b8; margin-top: 2px; }
.score-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 12px; }
.score-label { width: 150px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.score-bar-bg { flex: 1; height: 14px; background: #e2e8f0; border-radius: 4px; overflow: hidden; position: relative; }
.score-bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
.score-avg-marker { position: absolute; top: 0; bottom: 0; width: 2px; background: #0f172a; }
.score-val { width: 32px; text-align: right; font-weight: 600; font-family: monospace; }
.score-diff { width: 50px; text-align: right; font-size: 11px; font-weight: 600; }
.diff-pos { color: #16a34a; }
.diff-neg { color: #dc2626; }
.diff-neutral { color: #94a3b8; }
.infra-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12px; }
.infra-table th { text-align: left; padding: 6px 10px; background: #f1f5f9; border-bottom: 2px solid #e2e8f0; font-weight: 600; color: #334155; }
.infra-table td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; }
.norm-pass { color: #16a34a; font-weight: 600; }
.norm-fail { color: #dc2626; font-weight: 600; }
.norm-na { color: #94a3b8; }
.rec-list { list-style: none; padding: 0; margin: 8px 0; }
.rec-list li { padding: 6px 0 6px 20px; border-bottom: 1px solid #f1f5f9; font-size: 13px; position: relative; }
.rec-list li::before { content: ''; position: absolute; left: 0; top: 12px; width: 8px; height: 8px; border-radius: 50%; }
.rec-critical::before { background: #ef4444; }
.rec-important::before { background: #f59e0b; }
.rec-nice::before { background: #22c55e; }
.ranking-bar { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
.ranking-label { width: 120px; font-size: 12px; color: #475569; }
.ranking-track { flex: 1; height: 6px; background: #e2e8f0; border-radius: 3px; position: relative; }
.ranking-dot { width: 12px; height: 12px; border-radius: 50%; background: #7c3aed; position: absolute; top: -3px; }
.ranking-pct { width: 50px; font-size: 11px; font-weight: 600; color: #7c3aed; text-align: right; }
.llm-section { background: #fefce8; border: 1px solid #fde68a; border-radius: 8px; padding: 14px 18px; margin: 12px 0; font-size: 13px; color: #713f12; line-height: 1.7; }
.llm-loading { color: #94a3b8; font-style: italic; }
.footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #94a3b8; text-align: center; }
.legend-row { display: flex; gap: 16px; margin: 6px 0; font-size: 11px; color: #64748b; }
.legend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
@media print { body { padding: 20px; } h2 { break-after: avoid; } .llm-section { break-inside: avoid; } }`;
    }

    // ═══════════════════════════════════════════════════════════════
    // SCORE UTILITIES
    // ═══════════════════════════════════════════════════════════════

    function getScoreColor(value) {
        if (value >= 70) return '#22c55e';
        if (value >= 40) return '#eab308';
        return '#ef4444';
    }

    function computePercentile(value, cityAvg) {
        if (cityAvg === 0) return 50;
        const ratio = value / cityAvg;
        const pct = Math.min(99, Math.max(1, Math.round(ratio * 50)));
        return pct;
    }

    function getDiffText(value, avg) {
        const diff = value - avg;
        if (diff > 0) return '+' + diff;
        if (diff < 0) return String(diff);
        return '=';
    }

    function getDiffClass(value, avg) {
        const diff = value - avg;
        if (diff > 5) return 'diff-pos';
        if (diff < -5) return 'diff-neg';
        return 'diff-neutral';
    }

    // ═══════════════════════════════════════════════════════════════
    // INFRASTRUCTURE ACCESS ANALYSIS
    // ═══════════════════════════════════════════════════════════════

    function analyzeInfraAccess(data) {
        const cats = data.categories || {};
        const results = [];

        for (const [featureKey, normDef] of Object.entries(URDPFI_NORMS)) {
            let found = false;
            let count = 0;

            // Search across all categories for matching feature
            for (const catData of Object.values(cats)) {
                const features = catData.features || {};
                if (features[featureKey]) {
                    count = features[featureKey].count || 0;
                    found = count > 0;
                    break;
                }
            }

            results.push({
                label: normDef.label,
                normDistance: normDef.norm,
                available: found,
                count: count
            });
        }

        return results;
    }

    // ═══════════════════════════════════════════════════════════════
    // DEVELOPMENT RECOMMENDATIONS
    // ═══════════════════════════════════════════════════════════════

    function generateRecommendations(scores, infraResults) {
        const recs = [];

        const scoreMap = {};
        for (const [key, s] of Object.entries(scores)) {
            if (s && s.value !== undefined) {
                scoreMap[key] = s.value;
            }
        }

        // Score-based recommendations
        if ((scoreMap.healthcare_access || 0) < 20) {
            recs.push({ priority: 'critical', text: 'Healthcare deficit: No hospital or clinic within walkable distance. Recommend establishing a primary health centre per URDPFI guidelines.' });
        }
        if ((scoreMap.green || 0) < 15) {
            recs.push({ priority: 'critical', text: 'Green cover critically low. Develop neighbourhood parks (min 0.5 ha per 5,000 population) as per URDPFI norms.' });
        }
        if ((scoreMap.safety || 0) < 25) {
            recs.push({ priority: 'critical', text: 'Safety index below threshold. Increase street lighting, install CCTV, and improve police patrol coverage.' });
        }
        if ((scoreMap.walkability || 0) < 25) {
            recs.push({ priority: 'important', text: 'Poor walkability. Invest in continuous footpaths, pedestrian crossings, and mixed-use development along arterial roads.' });
        }
        if ((scoreMap.connectivity || 0) < 20) {
            recs.push({ priority: 'important', text: 'Public transport connectivity weak. Introduce mini-bus feeder routes connecting to nearest bus terminal.' });
        }
        if ((scoreMap.education_score || 0) < 15) {
            recs.push({ priority: 'important', text: 'Education facilities sparse. Plan for primary school within 500m walking distance per URDPFI norms.' });
        }
        if ((scoreMap.commercial || 0) < 15) {
            recs.push({ priority: 'nice', text: 'Low commercial activity. Consider zoning incentives for convenience retail and weekly market spaces.' });
        }
        if ((scoreMap.investment || 0) > 50) {
            recs.push({ priority: 'nice', text: 'High investment potential detected. Suitable for mixed-use development with developer incentives.' });
        }

        // Infrastructure-based recommendations
        for (const infra of infraResults) {
            if (!infra.available) {
                recs.push({
                    priority: infra.normDistance <= 500 ? 'critical' : 'important',
                    text: infra.label + ' not available within ' + infra.normDistance + 'm (URDPFI norm). Plan facility within catchment area.'
                });
            }
        }

        // Sort by priority
        const priorityOrder = { critical: 0, important: 1, nice: 2 };
        recs.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

        return recs.slice(0, 10);
    }

    // ═══════════════════════════════════════════════════════════════
    // EXECUTIVE SUMMARY (auto-generated)
    // ═══════════════════════════════════════════════════════════════

    function buildExecutiveSummary(cell, data, scores) {
        const sortedScores = Object.entries(scores)
            .filter(([, s]) => s && s.value !== undefined)
            .sort((a, b) => b[1].value - a[1].value);

        const top3 = sortedScores.slice(0, 3).map(([, s]) => s.label + ' (' + s.value + ')');
        const bottom3 = sortedScores.slice(-3).map(([, s]) => s.label + ' (' + s.value + ')');

        const avgScore = sortedScores.length > 0
            ? Math.round(sortedScores.reduce((sum, [, s]) => sum + s.value, 0) / sortedScores.length)
            : 0;

        const addr = data.address || {};
        const area = [addr.area, addr.city, addr.district].filter(Boolean).join(', ');

        const parts = [];
        parts.push('This area');
        if (area) parts[0] += ' in ' + area;
        parts[0] += ' has an overall composite score of ' + avgScore + '/100.';

        parts.push('Strongest dimensions: ' + top3.join(', ') + '.');
        parts.push('Key gaps: ' + bottom3.join(', ') + '.');

        if (avgScore >= 60) {
            parts.push('The area demonstrates above-average urban development with strong infrastructure foundations.');
        } else if (avgScore >= 35) {
            parts.push('The area shows moderate development with targeted investments needed in lagging dimensions.');
        } else {
            parts.push('Significant development interventions are required across multiple dimensions to meet URDPFI benchmarks.');
        }

        return parts.join(' ');
    }

    // ═══════════════════════════════════════════════════════════════
    // LLM NARRATIVE (async, uses DISHA if available)
    // ═══════════════════════════════════════════════════════════════

    async function fetchLLMNarrative(cell, data, doc, container) {
        if (typeof DISHAProviders === 'undefined' || !DISHAProviders.isConnected()) {
            container.appendChild(txt(doc, 'p', 'AI narrative unavailable — no DISHA provider connected. Configure Ollama or Groq in Settings.', 'llm-loading'));
            return;
        }

        const loadingEl = txt(doc, 'p', 'Generating AI planning assessment...', 'llm-loading');
        container.appendChild(loadingEl);

        const scores = data.scores || {};
        const addr = data.address || {};
        const scoreLines = Object.entries(scores)
            .filter(([, s]) => s && s.value !== undefined)
            .map(([key, s]) => key + ': ' + s.value + '/100')
            .join(', ');

        const prompt = 'You are an urban planning expert. Write a 200-word planning assessment for this location.\n' +
            'Location: ' + [addr.area, addr.city, addr.district, addr.state].filter(Boolean).join(', ') + '\n' +
            'DigiPin: ' + (cell.code || 'N/A') + '\n' +
            'Scores: ' + scoreLines + '\n' +
            'Provide: 1) Current development status, 2) Priority interventions, 3) Long-term development potential.\n' +
            'Be specific and reference URDPFI norms where relevant. Do not exceed 200 words.';

        try {
            let fullText = '';
            await DISHAProviders.stream({
                system: 'You are an urban planning expert specializing in Indian tier-2 and tier-3 cities. Write concise, actionable assessments.',
                prompt: prompt,
                onToken: (token) => {
                    fullText += token;
                    loadingEl.textContent = fullText;
                },
                onDone: () => {
                    loadingEl.className = '';
                },
                onError: (err) => {
                    loadingEl.textContent = 'AI assessment could not be generated: ' + (err.message || 'Unknown error');
                }
            });
        } catch (err) {
            loadingEl.textContent = 'AI assessment could not be generated: ' + (err.message || 'Unknown error');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // REPORT BUILDER — assembles all sections
    // ═══════════════════════════════════════════════════════════════

    function generate(cell, data) {
        if (!cell || !data) {
            if (typeof App !== 'undefined') {
                App.showToast('No Data', 'Select a cell first to generate the full report', 'warning');
            }
            return;
        }

        const scores = data.scores || {};
        const addr = data.address || {};
        const env = data.environment || {};
        const location = [addr.area, addr.city, addr.district, addr.state].filter(Boolean).join(', ');
        const date = new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });

        const win = window.open('', '_blank');
        if (!win) {
            if (typeof App !== 'undefined') {
                App.showToast('Popup Blocked', 'Allow popups for this site to generate reports', 'error');
            }
            return;
        }

        const doc = win.document;

        // Inject styles
        const style = doc.createElement('style');
        style.textContent = getStyles();
        doc.head.appendChild(style);
        doc.title = 'Enhanced Report - ' + (cell.code || 'DigiPin');

        // ─── SECTION 1: HEADER ───
        const header = mk(doc, 'div', 'header');
        const left = mk(doc, 'div');
        left.appendChild(txt(doc, 'div', cell.code || 'N/A', 'digipin'));
        left.appendChild(txt(doc, 'div',
            (cell.center ? cell.center.lat.toFixed(6) : '?') + '\u00b0N, ' +
            (cell.center ? cell.center.lng.toFixed(6) : '?') + '\u00b0E', 'coords'));
        if (location) left.appendChild(txt(doc, 'div', location, '', 'font-size:13px;color:#475569;margin-top:4px'));
        header.appendChild(left);

        const right = mk(doc, 'div', 'branding');
        const brandStrong = doc.createElement('strong');
        brandStrong.textContent = 'Guna Digital Twin';
        right.appendChild(brandStrong);
        right.appendChild(doc.createElement('br'));
        right.appendChild(doc.createTextNode('Enhanced Area Report'));
        right.appendChild(doc.createElement('br'));
        right.appendChild(doc.createTextNode(date));
        header.appendChild(right);
        doc.body.appendChild(header);

        // ─── SECTION 2: EXECUTIVE SUMMARY ───
        doc.body.appendChild(txt(doc, 'h2', 'Executive Summary'));
        const summaryText = buildExecutiveSummary(cell, data, scores);
        doc.body.appendChild(txt(doc, 'div', summaryText, 'exec-summary'));

        // ─── SECTION 3: LOCATION OVERVIEW ───
        doc.body.appendChild(txt(doc, 'h2', 'Location Overview'));
        const locGrid = mk(doc, 'div', 'meta-grid');
        locGrid.appendChild(metaCard(doc, cell.code || 'N/A', 'DigiPin'));
        locGrid.appendChild(metaCard(doc, addr.city || addr.area || 'Guna', 'City/Area'));
        locGrid.appendChild(metaCard(doc,
            cell.center ? cell.center.lat.toFixed(4) + '\u00b0N' : '?',
            'Latitude'));
        locGrid.appendChild(metaCard(doc,
            cell.center ? cell.center.lng.toFixed(4) + '\u00b0E' : '?',
            'Longitude'));
        doc.body.appendChild(locGrid);

        // Environment cards
        if (env.temperature != null || env.humidity != null || env.aqi != null) {
            const envGrid = mk(doc, 'div', 'meta-grid');
            if (env.temperature != null) envGrid.appendChild(metaCard(doc, env.temperature + '\u00b0C', 'Temperature'));
            if (env.humidity != null) envGrid.appendChild(metaCard(doc, env.humidity + '%', 'Humidity'));
            if (env.aqi != null) envGrid.appendChild(metaCard(doc, String(env.aqi), 'AQI'));
            if (env.wind_speed != null) envGrid.appendChild(metaCard(doc, env.wind_speed + ' km/h', 'Wind'));
            doc.body.appendChild(envGrid);
        }

        // ─── SECTION 4: SCORE DASHBOARD with city average comparison ───
        doc.body.appendChild(txt(doc, 'h2', 'Score Dashboard'));

        // Legend
        const legend = mk(doc, 'div', 'legend-row');
        const legendItems = [
            { color: '#22c55e', label: 'Good (70+)' },
            { color: '#eab308', label: 'Moderate (40-69)' },
            { color: '#ef4444', label: 'Low (<40)' },
            { color: '#0f172a', label: 'City Average' }
        ];
        legendItems.forEach(item => {
            const span = mk(doc, 'span');
            const dot = mk(doc, 'span', 'legend-dot');
            dot.style.backgroundColor = item.color;
            span.appendChild(dot);
            span.appendChild(doc.createTextNode(item.label));
            legend.appendChild(span);
        });
        doc.body.appendChild(legend);

        const sortedScores = Object.entries(scores)
            .filter(([, s]) => s && s.value !== undefined)
            .sort((a, b) => b[1].value - a[1].value);

        sortedScores.forEach(([key, s]) => {
            const row = mk(doc, 'div', 'score-row');
            row.appendChild(txt(doc, 'div', s.label, 'score-label'));

            const barBg = mk(doc, 'div', 'score-bar-bg');
            const bar = mk(doc, 'div', 'score-bar');
            bar.style.width = s.value + '%';
            bar.style.background = getScoreColor(s.value);
            barBg.appendChild(bar);

            // City average marker
            const cityAvg = CITY_AVERAGES[key];
            if (cityAvg !== undefined) {
                const marker = mk(doc, 'div', 'score-avg-marker');
                marker.style.left = cityAvg + '%';
                marker.title = 'City avg: ' + cityAvg;
                barBg.appendChild(marker);
            }

            row.appendChild(barBg);
            row.appendChild(txt(doc, 'div', String(s.value), 'score-val'));

            // Diff vs city average
            if (cityAvg !== undefined) {
                const diffEl = txt(doc, 'div', getDiffText(s.value, cityAvg), 'score-diff ' + getDiffClass(s.value, cityAvg));
                row.appendChild(diffEl);
            }

            doc.body.appendChild(row);
        });

        // ─── SECTION 5: INFRASTRUCTURE ACCESS (URDPFI compliance) ───
        doc.body.appendChild(txt(doc, 'h2', 'Infrastructure Access (URDPFI Compliance)'));
        const infraResults = analyzeInfraAccess(data);

        const table = mk(doc, 'table', 'infra-table');
        const thead = doc.createElement('thead');
        const headerRow = doc.createElement('tr');
        ['Facility', 'URDPFI Norm', 'Status', 'Count'].forEach(h => {
            headerRow.appendChild(txt(doc, 'th', h));
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = doc.createElement('tbody');
        let compliantCount = 0;
        infraResults.forEach(infra => {
            const tr = doc.createElement('tr');
            tr.appendChild(txt(doc, 'td', infra.label));
            tr.appendChild(txt(doc, 'td', 'Within ' + infra.normDistance + 'm'));

            if (infra.available) {
                compliantCount++;
                tr.appendChild(txt(doc, 'td', 'Compliant', 'norm-pass'));
            } else {
                tr.appendChild(txt(doc, 'td', 'Non-compliant', 'norm-fail'));
            }

            tr.appendChild(txt(doc, 'td', String(infra.count)));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        doc.body.appendChild(table);

        const complianceRate = infraResults.length > 0
            ? Math.round((compliantCount / infraResults.length) * 100) : 0;
        doc.body.appendChild(txt(doc, 'div',
            'URDPFI Compliance: ' + compliantCount + '/' + infraResults.length +
            ' facilities (' + complianceRate + '%)',
            '', 'font-size:12px;color:#475569;margin-top:6px;font-weight:600'));

        // ─── SECTION 6: DEVELOPMENT RECOMMENDATIONS ───
        doc.body.appendChild(txt(doc, 'h2', 'Development Recommendations'));
        const recs = generateRecommendations(scores, infraResults);

        if (recs.length === 0) {
            doc.body.appendChild(txt(doc, 'p', 'No critical gaps identified. Area meets basic URDPFI norms.', '', 'font-size:13px;color:#16a34a'));
        } else {
            const recList = mk(doc, 'ul', 'rec-list');
            recs.forEach(rec => {
                const li = txt(doc, 'li', rec.text, 'rec-' + rec.priority);
                recList.appendChild(li);
            });
            doc.body.appendChild(recList);

            // Priority legend
            const recLegend = mk(doc, 'div', 'legend-row', 'margin-top:8px');
            [
                { color: '#ef4444', label: 'Critical' },
                { color: '#f59e0b', label: 'Important' },
                { color: '#22c55e', label: 'Enhancement' }
            ].forEach(item => {
                const span = mk(doc, 'span');
                const dot = mk(doc, 'span', 'legend-dot');
                dot.style.backgroundColor = item.color;
                span.appendChild(dot);
                span.appendChild(doc.createTextNode(item.label));
                recLegend.appendChild(span);
            });
            doc.body.appendChild(recLegend);
        }

        // ─── SECTION 7: COMPARATIVE RANKING ───
        doc.body.appendChild(txt(doc, 'h2', 'Comparative Ranking'));
        doc.body.appendChild(txt(doc, 'p', 'Cell position relative to city average (marker shows percentile)',
            '', 'font-size:11px;color:#94a3b8;margin-bottom:8px'));

        DASHBOARD_SCORES.forEach(key => {
            const s = scores[key];
            if (!s || s.value === undefined) return;
            const cityAvg = CITY_AVERAGES[key] || 25;
            const percentile = computePercentile(s.value, cityAvg);

            const row = mk(doc, 'div', 'ranking-bar');
            row.appendChild(txt(doc, 'div', s.label, 'ranking-label'));

            const track = mk(doc, 'div', 'ranking-track');
            const dot = mk(doc, 'div', 'ranking-dot');
            dot.style.left = 'calc(' + percentile + '% - 6px)';
            dot.title = 'Percentile: ' + percentile;
            track.appendChild(dot);
            row.appendChild(track);

            row.appendChild(txt(doc, 'div', 'P' + percentile, 'ranking-pct'));
            doc.body.appendChild(row);
        });

        // ─── SECTION 8: AI PLANNING ASSESSMENT ───
        doc.body.appendChild(txt(doc, 'h2', 'AI Planning Assessment'));
        const llmContainer = mk(doc, 'div', 'llm-section');
        doc.body.appendChild(llmContainer);
        fetchLLMNarrative(cell, data, doc, llmContainer);

        // ─── FOOTER ───
        doc.body.appendChild(txt(doc, 'div',
            'Generated by Guna Digital Twin (Enhanced Report) \u2022 Data: OpenStreetMap, Open-Meteo, CPCB \u2022 ' + date,
            'footer'));

        if (typeof App !== 'undefined') {
            App.showToast('Full Report', 'Enhanced report opened in new window', 'success');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // WARD-LEVEL AGGREGATION
    // ═══════════════════════════════════════════════════════════════

    function generateWardReport(wardName, cellDataArray) {
        if (!cellDataArray || cellDataArray.length === 0) {
            if (typeof App !== 'undefined') {
                App.showToast('No Data', 'No cell data available for ward: ' + wardName, 'warning');
            }
            return;
        }

        // Aggregate scores across all cells in the ward
        const scoreSums = {};
        const scoreCounts = {};

        cellDataArray.forEach(cellEntry => {
            const cellScores = cellEntry.scores || (cellEntry.data && cellEntry.data.scores) || {};
            for (const [key, s] of Object.entries(cellScores)) {
                if (s && s.value !== undefined) {
                    scoreSums[key] = (scoreSums[key] || 0) + s.value;
                    scoreCounts[key] = (scoreCounts[key] || 0) + 1;
                }
            }
        });

        const aggregatedScores = {};
        for (const key of Object.keys(scoreSums)) {
            const avg = Math.round(scoreSums[key] / scoreCounts[key]);
            const firstLabel = cellDataArray.find(c => {
                const s = c.scores || (c.data && c.data.scores) || {};
                return s[key] && s[key].label;
            });
            const label = firstLabel
                ? (firstLabel.scores || (firstLabel.data && firstLabel.data.scores))[key].label
                : key;
            aggregatedScores[key] = { label: label, value: avg };
        }

        // Build a synthetic cell/data for the ward
        const syntheticCell = {
            code: 'WARD: ' + wardName,
            center: cellDataArray[0].center || { lat: GUNA.lat, lng: GUNA.lng }
        };

        const syntheticData = {
            address: { area: wardName, city: 'Guna', district: 'Guna', state: 'Madhya Pradesh' },
            scores: aggregatedScores,
            categories: cellDataArray[0].categories || (cellDataArray[0].data && cellDataArray[0].data.categories) || {},
            environment: cellDataArray[0].environment || (cellDataArray[0].data && cellDataArray[0].data.environment) || {}
        };

        generate(syntheticCell, syntheticData);
    }

    // ═══════════════════════════════════════════════════════════════
    // DETAIL PANEL HOOK — MutationObserver pattern
    // ═══════════════════════════════════════════════════════════════

    function hookDetailPanel() {
        const observer = new MutationObserver(() => {
            const panel = document.getElementById('panel-content');
            if (!panel) return;

            const actionsRow = panel.querySelector('.panel-actions');
            if (actionsRow && !actionsRow.querySelector('#btn-full-report')) {
                const btn = document.createElement('button');
                btn.className = 'action-btn';
                btn.id = 'btn-full-report';
                btn.title = 'Generate Enhanced Area Report';
                btn.textContent = '\uD83D\uDCCB Full Report';
                btn.addEventListener('click', () => {
                    const cell = Panel.getCurrentCell ? Panel.getCurrentCell() : null;
                    const cellData = Panel.getCurrentData ? Panel.getCurrentData() : null;
                    if (cell && cellData) {
                        generate(cell, cellData);
                    } else if (typeof App !== 'undefined') {
                        App.showToast('No Data', 'Select a cell first', 'warning');
                    }
                });
                actionsRow.appendChild(btn);
            }
        });

        const detailPanel = document.getElementById('detail-panel');
        if (detailPanel) {
            observer.observe(detailPanel, { childList: true, subtree: true });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // INIT
    // ═══════════════════════════════════════════════════════════════

    function init() {
        const waitForMap = setInterval(() => {
            if (typeof MapModule !== 'undefined' && MapModule.getMap()) {
                clearInterval(waitForMap);
                hookDetailPanel();
                console.log('[EnhancedReport] Initialized with detail panel hook');
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { generate, generateWardReport, init };
})();
