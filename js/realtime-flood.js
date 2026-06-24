/**
 * RealtimeFlood — fetches a 7-day river-discharge forecast for any lat/lng.
 *
 * Source: Open-Meteo Flood API at https://flood-api.open-meteo.com/v1/flood
 * Powered by GloFAS (Global Flood Awareness System / ECMWF / Copernicus),
 * the international standard for flood forecasting. Free, no auth.
 *
 * Why on-demand (not cron-cached): the forecast is per-lat/lng and
 * DigiPin cells can be anywhere in India. Pre-warming the cron cache for
 * 1.3B possible 4×4m cells is impossible — cell-click-time fetch is the
 * right granularity. ~300ms latency, acceptable for a click interaction.
 *
 * Caching: in-memory LRU keyed by lat/lng to ~4 decimals (≈11m). Adjacent
 * cells in the same DigiPin column will share the cache hit.
 *
 * Risk thresholds: relative to the forecast period's own baseline (day 0).
 * Absolute thresholds (return periods) would need per-station calibration
 * data which Open-Meteo doesn't ship.
 */

const RealtimeFlood = (() => {
    const ENDPOINT = 'https://flood-api.open-meteo.com/v1/flood';
    const CACHE_MAX = 64;
    const _cache = new Map();   // insertion-ordered; we evict the oldest

    // Thresholds as multipliers of day-0 discharge. Calibrated against
    // visible flood events on GloFAS — 2× baseline is where minor flooding
    // typically begins, 4× is moderate, 6× is severe.
    const RISK_THRESHOLDS = [
        { ratio: 1.2, level: 'low',       color: '#2dba4e' },
        { ratio: 2.0, level: 'elevated',  color: '#dbab09' },
        { ratio: 4.0, level: 'high',      color: '#f97316' },
        { ratio: 6.0, level: 'severe',    color: '#dc2626' },
        { ratio: Infinity, level: 'extreme', color: '#7f1d1d' },
    ];

    function _keyFor(lat, lng) {
        return `${lat.toFixed(4)},${lng.toFixed(4)}`;
    }

    function _classifyRisk(discharge, baseline) {
        if (!baseline || baseline <= 0) return RISK_THRESHOLDS[0];
        const ratio = discharge / baseline;
        return RISK_THRESHOLDS.find(t => ratio < t.ratio) || RISK_THRESHOLDS[0];
    }

    async function getForecast(lat, lng) {
        const key = _keyFor(lat, lng);
        if (_cache.has(key)) {
            // refresh insertion order so it survives eviction
            const cached = _cache.get(key);
            _cache.delete(key);
            _cache.set(key, cached);
            return cached;
        }

        const url = `${ENDPOINT}?latitude=${lat}&longitude=${lng}` +
                    `&daily=river_discharge,river_discharge_max,river_discharge_min` +
                    `&forecast_days=7&timezone=Asia%2FKolkata`;

        let payload;
        try {
            const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
            if (!r.ok) return null;
            payload = await r.json();
        } catch {
            return null;
        }

        const daily = payload?.daily;
        if (!daily?.time || daily.time.length === 0) return null;

        const days = daily.time.map((date, i) => {
            const discharge = daily.river_discharge?.[i] ?? 0;
            const baseline = daily.river_discharge?.[0] ?? discharge;
            const risk = _classifyRisk(discharge, baseline);
            return {
                date,
                discharge,
                min: daily.river_discharge_min?.[i] ?? discharge,
                max: daily.river_discharge_max?.[i] ?? discharge,
                risk_level: risk.level,
                risk_color: risk.color,
            };
        });

        const peak = days.reduce((p, d) => d.max > p.max ? d : p, days[0]);
        const baseline = days[0].discharge;
        const peakRatio = baseline > 0 ? peak.max / baseline : 1;

        const result = {
            location: { lat, lng },
            generated_utc: new Date().toISOString(),
            baseline_m3s: baseline,
            peak_day: peak,
            peak_ratio: peakRatio,
            overall_risk: _classifyRisk(peak.max, baseline),
            days,
            source: 'Open-Meteo Flood API (GloFAS)',
        };

        if (_cache.size >= CACHE_MAX) {
            const firstKey = _cache.keys().next().value;
            _cache.delete(firstKey);
        }
        _cache.set(key, result);
        return result;
    }

    function clearCache() { _cache.clear(); }

    return { getForecast, clearCache, RISK_THRESHOLDS };
})();

if (typeof window !== 'undefined') {
    window.RealtimeFlood = RealtimeFlood;
}
