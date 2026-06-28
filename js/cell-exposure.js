/**
 * CellExposure — turns live alerts into per-DigiPin-cell operational exposure.
 *
 * The realtime feeds (NDMA SACHET, IMD, GDACS, NCS/USGS quakes, OpenAQ — see
 * js/realtime-alerts.js) are area/severity records, not polygons. This module
 * fuses a hazard with the Feature Store so a responder sees WHICH cells are most
 * exposed and in what order: exposure = severity × (population × hazard-specific
 * vulnerability). It closes the "last-mile" gap — an alert becomes a ranked,
 * actionable cell list rather than a district-level text blob.
 *
 * Honest framing: until CAP polygons are parsed, area matching is text-based; the
 * per-cell ranking reflects relative exposure WITHIN a matched area, not absolute
 * inundation. The vulnerability mapping is transparent and field-driven.
 *
 * Pure core (hazardProfile, cellExposure, priority, rank, summary) is unit-tested;
 * assess() is a thin async wrapper that pulls viewport cells + live alerts.
 *
 *   CellExposure.rank(cells, CellExposure.hazardProfile(alert))
 *   await CellExposure.assess(bounds, { city: 'Indore' })
 */
const CellExposure = (() => {
    const SEVERITY = { extreme: 1.0, severe: 0.85, red: 1.0, orange: 0.8,
                       moderate: 0.55, yellow: 0.55, minor: 0.3, green: 0.3 };

    /** Classify an alert into a hazard kind + a 0..1 severity weight. Pure. */
    function hazardProfile(alert) {
        const a = alert || {};
        const text = `${a.category || ''} ${a.event || ''} ${a.headline || ''} ${a.type || ''}`.toLowerCase();
        let kind = 'generic';
        if (/flood|rain|inundat|deluge|waterlog/.test(text)) kind = 'flood';
        else if (/heat|heatwave|temperature|warm/.test(text)) kind = 'heat';
        else if (/air|aqi|pollut|pm2|smog/.test(text)) kind = 'air';
        else if (/quake|seismic|earthquake/.test(text)) kind = 'quake';
        else if (/cyclone|storm|wind|thunder|squall/.test(text)) kind = 'storm';
        const sevKey = String(a.severity || a.alertlevel || a.color || '').toLowerCase();
        let weight = SEVERITY[sevKey];
        if (weight == null && Number.isFinite(+a.magnitude)) {       // quake magnitude → weight
            weight = Math.max(0.3, Math.min(1, (+a.magnitude - 3) / 4));
        }
        return { kind, severity: sevKey || null, weight: weight == null ? 0.6 : weight };
    }

    function _num(v, dflt) { return v == null || !Number.isFinite(+v) ? dflt : +v; }

    /** Hazard-specific vulnerability 0..1 from a cell's feature map. Pure. */
    function vulnerability(features, kind) {
        const f = features || {};
        switch (kind) {
            case 'flood': return _num(f.flood_risk, 50) / 100;
            case 'heat':  return (100 - _num(f.green, 50)) / 100;          // less green = hotter
            case 'air':   return 0.6;                                       // fairly uniform across a city
            case 'quake':
            case 'storm': return (100 - _num(f.infra_maturity, 50)) / 100; // weaker infra = more damage
            default:      return 0.5;
        }
    }

    /** Per-cell exposure 0..100 = severity × (population × vulnerability). Pure. */
    function cellExposure(cellOrFeatures, hazard) {
        const features = cellOrFeatures && cellOrFeatures.features ? cellOrFeatures.features : cellOrFeatures;
        const h = hazard || { kind: 'generic', weight: 0.6 };
        const pop = _num(features && features.population_proxy, 40) / 100;
        const vuln = vulnerability(features, h.kind);
        const v = (h.weight || 0.6) * (0.55 * pop + 0.45 * vuln) * 100;
        return Math.max(0, Math.min(100, Math.round(v)));
    }

    function priority(value) {
        if (value == null) return 'none';
        return value >= 70 ? 'Critical' : value >= 45 ? 'High' : value >= 25 ? 'Moderate' : 'Low';
    }

    /** Rank cell records by exposure to a hazard. Returns new sorted array. Pure. */
    function rank(cells, hazard) {
        return (cells || [])
            .map(c => {
                const exposure = cellExposure(c, hazard);
                return { ...c, exposure, priority: priority(exposure) };
            })
            .filter(c => c.exposure > 0)
            .sort((a, b) => b.exposure - a.exposure);
    }

    /** Operational rollup of a ranked list. Pure. */
    function summary(ranked) {
        const byPriority = { Critical: 0, High: 0, Moderate: 0, Low: 0 };
        let exposedPop = 0;
        for (const c of ranked || []) {
            byPriority[c.priority] = (byPriority[c.priority] || 0) + 1;
            if (c.priority === 'Critical' || c.priority === 'High') {
                exposedPop += _num(c.features && c.features.population_proxy, 0);
            }
        }
        return { cells: (ranked || []).length, byPriority, exposedPopulationProxy: Math.round(exposedPop) };
    }

    /**
     * End-to-end operational assessment for a viewport: pull covered cells +
     * live alerts, pick the most severe relevant hazard, and return the ranked
     * exposed cells with a summary. Async; degrades to [] when deps/data absent.
     */
    async function assess(bounds, opts = {}) {
        const cells = (typeof DigiPinIntel !== 'undefined' && DigiPinIntel.viewport)
            ? await DigiPinIntel.viewport(bounds) : [];
        if (!cells.length) return { hazard: null, ranked: [], summary: summary([]) };

        let alerts = [];
        if (typeof RealtimeAlerts !== 'undefined' && RealtimeAlerts.getForLocation) {
            try { alerts = await RealtimeAlerts.getForLocation(opts.state, opts.city) || []; } catch { alerts = []; }
        }
        if (opts.alert) alerts = [opts.alert, ...alerts];
        if (!alerts.length) return { hazard: null, ranked: [], summary: summary([]), cells: cells.length };

        // most severe alert drives the assessment
        const hazards = alerts.map(hazardProfile).sort((a, b) => b.weight - a.weight);
        const hazard = hazards[0];
        const ranked = rank(cells, hazard);
        return { hazard, ranked, summary: summary(ranked) };
    }

    return { hazardProfile, vulnerability, cellExposure, priority, rank, summary, assess };
})();

if (typeof window !== 'undefined') window.CellExposure = CellExposure;
