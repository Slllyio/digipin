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
     *  Neutral is 50; a factor above 50 lifts the score, below 50 drags it. */
    function growthPotential(data) {
        const fs = factors(data);
        if (fs.length === 0) return { score: null, drivers: [], confidence: 'no_data', factorsUsed: 0 };

        let wSum = 0, wValue = 0;
        const drivers = [];
        for (const f of fs) {
            wSum += f.weight;
            wValue += f.weight * f.value;
            // signed contribution relative to neutral, for attribution
            drivers.push({
                key: f.key, label: f.label, group: f.group, value: Math.round(f.value),
                contribution: +(f.weight * (f.value - 50)).toFixed(1),
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

    /** Full outlook for a cell: score, label, appreciation band, ranked drivers. */
    function outlook(data, opts = {}) {
        const gp = growthPotential(data);
        const label = outlookLabel(gp.score);
        const appreciation = projectAppreciation(gp.score, { ...opts, confidence: gp.confidence });
        const positives = gp.drivers.filter(d => d.contribution > 0).slice(0, 3);
        const negatives = gp.drivers.filter(d => d.contribution < 0).slice(0, 3);
        return {
            score: gp.score,
            band: label.band,
            label: label.label,
            confidence: gp.confidence,
            factorsUsed: gp.factorsUsed,
            appreciation,
            drivers: gp.drivers,
            topPositives: positives,
            topNegatives: negatives,
        };
    }

    return { FACTORS, factors, growthPotential, outlookLabel, projectAppreciation, outlook };
})();

if (typeof window !== 'undefined') window.RealEstateModel = RealEstateModel;
