/**
 * RealEstateModel — a research-grounded real-estate growth/appreciation model
 * that runs entirely on data the app already fetches live (OSM scores, building
 * morphology, live flood/air signals). No satellite COGs, no API key — so unlike
 * the GEE-backed GrowthScore it actually produces a result in the deployed app.
 *
 * It is a transparent hedonic-style multi-factor model: each driver is oriented
 * "higher = better for value", scored 0–100, and given a weight whose relative
 * magnitude reflects the empirical hedonic literature on what moves residential
 * property values:
 *   - Accessibility / transit proximity — a primary locational driver
 *     (monocentric-city rent gradient; transit premiums ~5–10%).
 *   - Walkability & neighbourhood amenities — capitalised into prices
 *     (Walk Score hedonic studies).
 *   - Green space — premiums up to ~20% for accessible green.
 *   - Jobs / commercial agglomeration, schools, healthcare — positive.
 *   - Supply-side leading indicators — development potential (FSI headroom,
 *     vacant land), an active construction pipeline, redevelopment scope.
 *   - Risk discounts — flood exposure (~9% discount after events), poor air,
 *     noise — pull the outlook down.
 *
 * Output: a 0–100 growth-potential score, a relative annual-appreciation band,
 * the ranked positive/negative drivers, and a data-confidence flag. Everything
 * is pure and unit-tested; the value is a *relative* signal, not a price quote.
 */
const RealEstateModel = (() => {
    // Intent profiles — per-factor weight multipliers that retune the model for
    // who's asking. "balanced" (default) leaves the base weights untouched so the
    // model's default behaviour (and DISHA context) is unchanged. A homebuyer
    // weights amenity/safety/quiet; an investor weights appreciation drivers; a
    // developer weights supply-side headroom.
    const INTENT_PROFILES = {
        balanced: {},
        live: {
            walkability: 1.3, green: 1.4, schools: 1.4, healthcare: 1.3, quietness: 1.6,
            floodSafety: 1.5, airQuality: 1.4, jobs: 0.8,
            pipeline: 0.4, redevelopment: 0.4, devPotential: 0.5,
        },
        invest: {
            accessibility: 1.3, jobs: 1.4, pipeline: 1.5, devPotential: 1.3,
            walkability: 1.1, modernization: 1.1, quietness: 0.5, schools: 0.8,
        },
        build: {
            devPotential: 1.7, redevelopment: 1.7, pipeline: 1.3, accessibility: 1.1,
            walkability: 0.7, green: 0.6, schools: 0.6, healthcare: 0.6, quietness: 0.4,
        },
    };
    const INTENTS = Object.keys(INTENT_PROFILES);

    // Factor weights (relative). Sign is handled by orienting each value so that
    // higher always means "better for growth"; weights are therefore positive.
    // See the module header for the hedonic-literature basis of the ordering.
    const FACTORS = [
        // demand drivers
        { key: 'accessibility', label: 'Transit & connectivity', group: 'demand',  weight: 1.0, from: d => _score(d, 'connectivity') },
        { key: 'jobs',          label: 'Commercial / jobs access', group: 'demand', weight: 0.9, from: d => _score(d, 'commercial') },
        { key: 'walkability',   label: 'Walkability & amenities', group: 'demand',  weight: 0.8, from: d => _score(d, 'walkability') },
        { key: 'green',         label: 'Green space',           group: 'demand',    weight: 0.6, from: d => _score(d, 'green') },
        { key: 'schools',       label: 'Schools',               group: 'demand',    weight: 0.6, from: d => _score(d, 'education_score') },
        { key: 'healthcare',    label: 'Healthcare access',     group: 'demand',    weight: 0.4, from: d => _score(d, 'healthcare_access') },
        // supply-side / leading indicators of growth
        { key: 'devPotential',  label: 'Development potential', group: 'supply',    weight: 0.9, from: d => _score(d, 'development_potential') },
        { key: 'pipeline',      label: 'Construction pipeline', group: 'supply',    weight: 0.8, from: d => _score(d, 'real_estate_growth') },
        { key: 'redevelopment', label: 'Redevelopment scope',   group: 'supply',    weight: 0.5, from: d => _score(d, 'redevelopment_index') },
        { key: 'modernization', label: 'Newer building stock',  group: 'supply',    weight: 0.3, from: d => _score(d, 'modernization') },
        // risk discounts (oriented so higher = safer/better)
        { key: 'floodSafety',   label: 'Flood safety',          group: 'risk',      weight: 0.9, from: d => _floodSafety(d) },
        { key: 'airQuality',    label: 'Air quality',           group: 'risk',      weight: 0.4, from: d => _airQuality(d) },
        { key: 'quietness',     label: 'Quietness',             group: 'risk',      weight: 0.3, from: d => _score(d, 'noise_estimate') },
    ];

    // ---------- value extractors (return 0..100 or null when unavailable) ----------
    function _score(data, key) {
        const s = data && data.scores && data.scores[key];
        return (s && typeof s.value === 'number') ? Math.max(0, Math.min(100, s.value)) : null;
    }

    /** Flood SAFETY (higher = safer). Prefer the live GloFAS peak ratio, else the
     *  flood_risk score (which is oriented higher = more risk). */
    function _floodSafety(data) {
        const peak = data && data.realtime && data.realtime.flood
            && Number(data.realtime.flood.peak_ratio);
        if (Number.isFinite(peak)) {
            // 1× baseline ≈ safe(100); ≥4× ≈ severe(0). Linear in between.
            return Math.max(0, Math.min(100, 100 - (peak - 1) * (100 / 3)));
        }
        const risk = _score(data, 'flood_risk');
        return risk == null ? null : 100 - risk;
    }

    /** Air QUALITY 0..100 (higher = cleaner) from a live AQI reading if present. */
    function _airQuality(data) {
        const aqi = data && data.realtime && data.realtime.aqi && Number(data.realtime.aqi.aqi);
        if (!Number.isFinite(aqi)) return null;
        // US AQI: 0 great → 300 hazardous. Map to 100..0.
        return Math.max(0, Math.min(100, 100 - (aqi / 300) * 100));
    }

    /** Resolve every factor against the cell data; drop the ones with no value. */
    function factors(data) {
        return FACTORS.map(f => ({ ...f, value: f.from(data) }))
            .filter(f => f.value != null);
    }

    /** Weighted growth-potential score 0..100 + ranked drivers + confidence.
     *  Neutral is 50; a factor above 50 lifts the score, below 50 drags it.
     *  opts.intent ∈ {balanced,live,invest,build} retunes the factor weights. */
    function growthPotential(data, opts = {}) {
        const fs = factors(data);
        if (fs.length === 0) return { score: null, drivers: [], confidence: 'no_data', factorsUsed: 0 };

        const intent = INTENT_PROFILES[opts.intent] ? opts.intent : 'balanced';
        const profile = INTENT_PROFILES[intent];

        let wSum = 0, wValue = 0;
        const drivers = [];
        for (const f of fs) {
            const w = f.weight * (profile[f.key] != null ? profile[f.key] : 1);
            wSum += w;
            wValue += w * f.value;
            // signed contribution relative to neutral, for attribution
            drivers.push({
                key: f.key, label: f.label, group: f.group, value: Math.round(f.value),
                contribution: +(w * (f.value - 50)).toFixed(1),
            });
        }
        const score = Math.round(wValue / wSum);
        drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

        // Confidence from breadth of evidence (how many of the 13 factors had data).
        const ratio = fs.length / FACTORS.length;
        const confidence = ratio >= 0.6 ? 'high' : ratio >= 0.35 ? 'medium' : 'low';
        return { score, drivers, confidence, factorsUsed: fs.length };
    }

    /** Qualitative band for a 0..100 growth-potential score. */
    function outlookLabel(score) {
        if (score == null) return { band: 'unknown', label: 'Insufficient data' };
        if (score >= 70) return { band: 'strong',   label: 'Strong upside' };
        if (score >= 58) return { band: 'above',     label: 'Above-average upside' };
        if (score >= 43) return { band: 'stable',    label: 'Stable / market-rate' };
        if (score >= 30) return { band: 'soft',      label: 'Soft — limited upside' };
        return { band: 'weak', label: 'Weak / cooling' };
    }

    /** Relative annual-appreciation band (%) from the growth score.
     *  Anchored to a configurable city baseline (default ~6%/yr nominal, a
     *  reasonable Indian Tier-2 reference) and a spread; the confidence widens
     *  the band. This is a model-derived RELATIVE signal, not a price forecast. */
    function projectAppreciation(score, opts = {}) {
        if (score == null) return null;
        const base = opts.baselinePct != null ? opts.baselinePct : 6;
        const spread = opts.spreadPct != null ? opts.spreadPct : 6;
        const mid = base + ((score - 50) / 50) * spread;
        const band = opts.confidence === 'high' ? 1.5 : opts.confidence === 'medium' ? 2.5 : 4;
        const r = (x) => +x.toFixed(1);
        return { lowPct: r(mid - band), midPct: r(mid), highPct: r(mid + band) };
    }

    /** A compact built-form summary from BuildingIntelligence, for the verdict.
     *  Returns { text, redevelopment } or null when no building data exists. */
    function builtForm(data) {
        const bi = data && data.buildingIntel;
        if (!bi) return null;
        const b = bi.buildings || {};
        const m = bi.metrics || {};
        const parts = [];
        if (Number.isFinite(b.totalCount) && b.totalCount > 0) parts.push(`${b.totalCount} buildings`);
        if (Number.isFinite(b.avgLevels) && b.avgLevels > 0) parts.push(`avg ${b.avgLevels} floors`);
        if (Number.isFinite(m.fsi) && m.fsi > 0) parts.push(`FSI ${m.fsi}`);
        if (m.urbanForm) parts.push(m.urbanForm);
        else if (bi.lcz && bi.lcz.name) parts.push(bi.lcz.name);
        const redev = _score(data, 'redevelopment_index');
        return { text: parts.join(' · ') || null, redevelopment: redev };
    }

    /** One-line plain-English verdict from an outlook + built form. Pure. */
    function verdictSentence(o, data) {
        if (!o || o.score == null) return 'Not enough live data to assess this cell.';
        const pos = o.topPositives.map(d => d.label.toLowerCase());
        const neg = o.topNegatives.map(d => d.label.toLowerCase());
        let s = `${o.label} (${o.score}/100), an estimated ${o.appreciation.midPct}%/yr.`;
        if (pos.length) s += ` Lifted by ${pos.slice(0, 2).join(' and ')}.`;
        if (neg.length) s += ` Held back by ${neg.slice(0, 2).join(' and ')}.`;
        const bf = builtForm(data);
        if (bf && bf.redevelopment != null && bf.redevelopment >= 60) {
            s += ' Notable redevelopment headroom.';
        }
        return s;
    }

    /** Resolve the appreciation baseline (%/yr) for a cell: explicit opt →
     *  per-city config (window.DIGIPIN_CONFIG.realEstateBaselines) → default.
     *  Lets operators anchor the band to real locality appreciation data. */
    function _baselineFor(data, opts) {
        if (opts && Number.isFinite(opts.baselinePct)) return opts.baselinePct;
        const cfg = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG
            && window.DIGIPIN_CONFIG.realEstateBaselines) || null;
        if (cfg) {
            const city = data && data.address && data.address.city;
            if (city && Number.isFinite(cfg[city])) return cfg[city];
            if (Number.isFinite(cfg.default)) return cfg.default;
        }
        return 6;
    }

    /** Full outlook for a cell: score, label, appreciation band, ranked drivers.
     *  opts.intent retunes the weights; opts.baselinePct/spreadPct tune projection. */
    function outlook(data, opts = {}) {
        const gp = growthPotential(data, opts);
        const label = outlookLabel(gp.score);
        const baselinePct = _baselineFor(data, opts);
        const appreciation = projectAppreciation(gp.score,
            { ...opts, baselinePct, confidence: gp.confidence });
        const positives = gp.drivers.filter(d => d.contribution > 0).slice(0, 3);
        const negatives = gp.drivers.filter(d => d.contribution < 0).slice(0, 3);
        const out = {
            intent: INTENT_PROFILES[opts.intent] ? opts.intent : 'balanced',
            score: gp.score,
            band: label.band,
            label: label.label,
            confidence: gp.confidence,
            factorsUsed: gp.factorsUsed,
            appreciation,
            drivers: gp.drivers,
            topPositives: positives,
            topNegatives: negatives,
            builtForm: builtForm(data),
        };
        out.verdict = verdictSentence(out, data);
        return out;
    }

    // ---------- calibration (learn weights from observed price data) ----------
    /** Solve (A) x = (b) for a small square system by Gaussian elimination with
     *  partial pivoting. Returns x, or null if singular. Pure. */
    function _gaussSolve(A, b) {
        const n = A.length;
        const M = A.map((row, i) => [...row, b[i]]);   // augmented
        for (let col = 0; col < n; col++) {
            let piv = col;
            for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
            if (Math.abs(M[piv][col]) < 1e-12) return null;
            [M[col], M[piv]] = [M[piv], M[col]];
            for (let r = 0; r < n; r++) {
                if (r === col) continue;
                const f = M[r][col] / M[col][col];
                for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
            }
        }
        // Fully reduced → diagonal; x[i] = augmented RHS / diagonal.
        return M.map((row, i) => row[n] / row[i]);
    }

    /** Fit factor weights to observed appreciation via ridge regression.
     *  samples: [{ factors:{key:0..100}, appreciationPct }]. Returns
     *  { intercept, weights:{key:coef per +1.0 of normalised factor}, r2, n }
     *  or null when there isn't enough data. This is the path to calibrate the
     *  model against real locality price history (see docs/REAL_ESTATE_MODEL.md). */
    function calibrate(samples, opts = {}) {
        const keys = FACTORS.map(f => f.key);
        const lambda = Number.isFinite(opts.ridge) ? opts.ridge : 1.0;
        const X = [], y = [];
        for (const s of (samples || [])) {
            if (!s || !Number.isFinite(s.appreciationPct)) continue;
            const row = [1];   // intercept column
            for (const k of keys) {
                const v = s.factors && Number.isFinite(s.factors[k]) ? s.factors[k] : 50;
                row.push(v / 100);
            }
            X.push(row); y.push(s.appreciationPct);
        }
        const p = keys.length + 1;
        if (X.length < 2) return null;

        // Normal equations with ridge: (XᵀX + λI) b = Xᵀy  (intercept un-penalised)
        const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
        const Xty = new Array(p).fill(0);
        for (let i = 0; i < X.length; i++) {
            for (let a = 0; a < p; a++) {
                Xty[a] += X[i][a] * y[i];
                for (let c = 0; c < p; c++) XtX[a][c] += X[i][a] * X[i][c];
            }
        }
        for (let a = 1; a < p; a++) XtX[a][a] += lambda;
        const b = _gaussSolve(XtX, Xty);
        if (!b) return null;

        // R² on the fitted samples
        const meanY = y.reduce((s, v) => s + v, 0) / y.length;
        let resSS = 0, totSS = 0;
        for (let i = 0; i < X.length; i++) {
            const pred = X[i].reduce((s, v, j) => s + v * b[j], 0);
            resSS += (y[i] - pred) ** 2;
            totSS += (y[i] - meanY) ** 2;
        }
        const r2 = totSS === 0 ? 1 : Math.max(0, Math.min(1, 1 - resSS / totSS));
        const weights = {};
        keys.forEach((k, i) => { weights[k] = +b[i + 1].toFixed(4); });
        return { intercept: +b[0].toFixed(4), weights, r2: +r2.toFixed(3), n: X.length };
    }

    return { FACTORS, INTENTS, INTENT_PROFILES, factors, growthPotential,
        outlookLabel, projectAppreciation, builtForm, verdictSentence, outlook, calibrate };
})();

if (typeof window !== 'undefined') window.RealEstateModel = RealEstateModel;
