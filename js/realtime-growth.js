/**
 * RealtimeGrowth — Urban Growth Forecast data layer.
 *
 * Two responsibilities (kept narrow per spec §7.5 + harness principles):
 *   1. fetchCell(lat, lng)  — async; reads COGs + RERA snapshot, returns raw signal bundle
 *   2. scoreCell(signals)   — pure; collapses signals to the result.realtime.growth schema
 *
 * The orchestrator in data-fetcher.js calls fetchCell(...).then(scoreCell)
 * and stashes the result on result.realtime.growth.
 *
 * Spec: docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md §4.1 (schema) + §5 (math)
 */

const RealtimeGrowth = (() => {
    const COG_BUILDINGS  = 'data/growth/buildings_temporal_2016-2023.tif';
    const COG_VIIRS      = 'data/growth/viirs_2016-2024.tif';
    const COG_GHSL       = 'data/growth/ghsl_pop_2025.tif';
    const RERA_SNAPSHOT  = 'data/realtime/rera_mp/latest.json';
    const RERA_RADIUS_KM = 2.0;
    const RERA_TTL_MS    = 5 * 60 * 1000;

    let _reraCache = null;
    let _reraFetchedAt = 0;

    function _haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
                  Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
                  Math.sin(dLng/2)**2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    async function _readCog(url, lat, lng) {
        // Uses georaster.browser.bundle.min.js loaded by index.html.
        // Returns Array<number> (one value per band) or null on failure.
        try {
            if (typeof parseGeoraster !== 'function') return null;
            const resp = await fetch(url, { cache: 'force-cache' });
            if (!resp.ok) return null;
            const buf = await resp.arrayBuffer();
            const gr = await parseGeoraster(buf);
            const [px, py] = gr.toCanvasCoords([lng, lat]);
            if (px < 0 || py < 0 || px >= gr.width || py >= gr.height) return null;
            const out = [];
            for (let b = 0; b < gr.values.length; b++) {
                out.push(gr.values[b][py][px]);
            }
            return out;
        } catch (e) {
            console.warn('[RealtimeGrowth] COG read failed', url, e);
            return null;
        }
    }

    async function _loadReraSnapshot() {
        if (_reraCache && Date.now() - _reraFetchedAt < RERA_TTL_MS) return _reraCache;
        try {
            const r = await fetch(RERA_SNAPSHOT, { cache: 'no-store' });
            if (!r.ok) return null;
            const data = await r.json();
            _reraCache = data;
            _reraFetchedAt = Date.now();
            return data;
        } catch {
            return null;
        }
    }

    async function _reraNearby(lat, lng) {
        const snap = await _loadReraSnapshot();
        if (!snap || !Array.isArray(snap.records)) return null;
        const nearby = [];
        const nowMs = Date.now();
        for (const p of snap.records) {
            const d = _haversineKm(lat, lng, p.lat, p.lng);
            if (d > RERA_RADIUS_KM) continue;
            const approval = new Date(p.approval_date_iso || '2020-01-01').getTime();
            const ageYrs = Math.max(0, (nowMs - approval) / (365.25 * 24 * 3600 * 1000));
            nearby.push({
                value: p.value_rupees || 0,
                age_yrs: ageYrs,
                distance_km: d,
                name: p.name,
            });
        }
        return nearby;
    }

    /** Async — reads all four sources, returns raw signal bundle. */
    async function fetchCell(lat, lng, opts = {}) {
        // OSM-construction count comes from result.categories already populated
        // by data-fetcher.js's main fetch; passed in via opts.
        const [buildings, viirs, ghsl, rera] = await Promise.all([
            _readCog(COG_BUILDINGS, lat, lng),
            _readCog(COG_VIIRS, lat, lng),
            _readCog(COG_GHSL, lat, lng),
            _reraNearby(lat, lng),
        ]);
        // GHSL is single-band; derive pct-change 2020→2025 from the value (placeholder
        // until we have a 2020 layer too — for v1 we approximate by treating the value
        // as already-normalised pop density and use osm signals to infer change).
        // Spec §5 calls this out as a known simplification.
        const popValue = ghsl ? ghsl[0] : null;
        return {
            buildings_temporal: buildings,
            heights: null,   // Phase 2 — temporal V1 also has height bands; defer
            viirs,
            ghsl_pop_5yr_pct: popValue != null ? Math.min(20, popValue / 50) : null,
            osm_commercial_density: opts.osm_commercial_density || 0,
            osm_construction_count: opts.osm_construction_count || 0,
            rera_projects: rera,
        };
    }

    /** Pure — collapses signals to the result.realtime.growth schema. */
    function scoreCell(signals) {
        if (typeof GrowthScore === 'undefined') return null;

        const bue = GrowthScore.bueSubScore(signals);
        const den = GrowthScore.denSubScore(signals);
        const cap = GrowthScore.capSubScore(signals);

        if (bue == null && den == null && cap == null) return null;

        const sub = { bue, den, cap };
        const nowcast = GrowthScore.composite(sub, 'nowcast');
        const year_2  = GrowthScore.composite(sub, 'year_2');

        // Year-5: linear-trend extrapolation over building presence
        const trend = GrowthScore.linearTrend(signals.buildings_temporal);
        const r2 = trend ? trend.r_squared : null;
        const year_5_value = trend
            ? Math.max(0, Math.min(100, nowcast.composite + trend.slope * 5 * 200))
            : nowcast.composite;
        const year_5 = { composite: Math.round(year_5_value), effective_weights: nowcast.effective_weights };

        function buildHorizon(c, horizon, sub) {
            const direction = (s) => s == null ? '—' : (s > 60 ? '▲' : s > 45 ? '▶' : '▽');
            return {
                composite: c.composite,
                confidence_band: GrowthScore.confidenceBand(horizon, r2),
                sub_scores: {
                    bue: { value: sub.bue, direction: direction(sub.bue), driver: '' },
                    den: { value: sub.den, direction: direction(sub.den), driver: '' },
                    cap: { value: sub.cap, direction: direction(sub.cap), driver: '' },
                },
                effective_weights: c.effective_weights,
                ...(horizon === 'year_5' ? { r_squared: r2 } : {}),
            };
        }

        return {
            active_horizon: 'nowcast',
            horizons: {
                nowcast: buildHorizon(nowcast, 'nowcast', sub),
                year_2:  buildHorizon(year_2,  'year_2',  sub),
                year_5:  buildHorizon(year_5,  'year_5',  sub),
            },
            sources: {
                buildings_temporal: signals.buildings_temporal ? 'ok' : 'missing',
                viirs:              signals.viirs              ? 'ok' : 'missing',
                ghsl_pop:           signals.ghsl_pop_5yr_pct != null ? 'ok' : 'missing',
                rera_mp:            signals.rera_projects === null ? 'out_of_state'
                                  : signals.rera_projects.length === 0 ? 'ok'  // empty, but state covered
                                  : 'ok',
                osm:                'ok',  // always available from data-fetcher's main pass
            },
            generated_at_iso: new Date().toISOString(),
        };
    }

    return { fetchCell, scoreCell };
})();

if (typeof window !== 'undefined') {
    window.RealtimeGrowth = RealtimeGrowth;
}
