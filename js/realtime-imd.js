/**
 * RealtimeIMD — surfaces IMD 5-day district warnings + 7-day city
 * forecasts in the portal. Reads data/realtime/imd_warnings/latest.json
 * and data/realtime/imd_cityforecast/latest.json (produced by the cron
 * workflow once IMD_API_KEY + IMD_API_TOKEN secrets are configured).
 *
 * Behaviour when snapshots are empty (keys not yet set): every getter
 * returns [] / null. The portal degrades cleanly — no errors, just no
 * IMD section in the panel.
 */

const RealtimeIMD = (() => {
    const WARNINGS_PATH = 'data/realtime/imd_warnings/latest.json';
    const FORECAST_PATH = 'data/realtime/imd_cityforecast/latest.json';
    const TTL_MS = 15 * 60 * 1000;
    const COLOR_RANK = { red: 4, orange: 3, yellow: 2, green: 1 };

    const _state = {
        warnings: null,
        forecasts: null,
        warningsAt: 0,
        forecastsAt: 0,
    };

    // Returns null on failure (network/timeout/non-OK) so callers can distinguish
    // "genuinely empty" from "fetch failed" and avoid caching a transient failure
    // as an empty result for the whole TTL.
    async function _load(path) {
        try {
            const r = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
            if (!r.ok) return null;
            const data = await r.json();
            return Array.isArray(data.records) ? data.records : [];
        } catch {
            return null;
        }
    }

    async function getWarnings() {
        if (_state.warnings && Date.now() - _state.warningsAt < TTL_MS) return _state.warnings;
        const loaded = await _load(WARNINGS_PATH);
        if (loaded !== null) { _state.warnings = loaded; _state.warningsAt = Date.now(); }
        return _state.warnings || [];
    }

    async function getForecasts() {
        if (_state.forecasts && Date.now() - _state.forecastsAt < TTL_MS) return _state.forecasts;
        const loaded = await _load(FORECAST_PATH);
        if (loaded !== null) { _state.forecasts = loaded; _state.forecastsAt = Date.now(); }
        return _state.forecasts || [];
    }

    function _matchesLocation(record, district, city) {
        const blob = [
            record.district_name, record.city_name,
            record.district_id, record.city_id,
        ].filter(Boolean).join(' ').toLowerCase();
        if (district && blob.includes(district.toLowerCase())) return true;
        if (city && blob.includes(city.toLowerCase())) return true;
        return false;
    }

    async function getWarningsForLocation(district, city) {
        const all = await getWarnings();
        return all.filter(w => _matchesLocation(w, district, city));
    }

    async function getForecastForLocation(district, city) {
        const all = await getForecasts();
        return all.filter(f => _matchesLocation(f, district, city));
    }

    function worstColor(warnings) {
        if (!warnings || warnings.length === 0) return null;
        return warnings.reduce((worst, w) => {
            const rank = COLOR_RANK[w.color] || 0;
            return rank > (COLOR_RANK[worst] || 0) ? w.color : worst;
        }, 'green');
    }

    return {
        getWarnings,
        getForecasts,
        getWarningsForLocation,
        getForecastForLocation,
        worstColor,
    };
})();

if (typeof window !== 'undefined') {
    window.RealtimeIMD = RealtimeIMD;
}
