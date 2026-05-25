/**
 * RealtimeQuakes — surfaces recent earthquakes near a DigiPin cell.
 *
 * Reads data/realtime/ncs_earthquakes/latest.json (refreshed by the
 * CI cron) and exposes proximity filtering. Earthquakes hundreds of
 * km away are still relevant for context (DISHA can mention "recent
 * regional activity") but the panel only highlights events within
 * 200 km by default.
 *
 * Distance is haversine — a small approximation good to ~0.5% over
 * the distances we care about (sub-1000 km).
 */

const RealtimeQuakes = (() => {
    const FEED_PATH = 'data/realtime/ncs_earthquakes/latest.json';
    const TTL_MS = 5 * 60 * 1000;
    const EARTH_R_KM = 6371.0088;

    let _cache = null;
    let _fetchedAt = 0;

    async function getQuakes() {
        if (_cache && Date.now() - _fetchedAt < TTL_MS) return _cache;
        try {
            const r = await fetch(FEED_PATH, { cache: 'no-store' });
            if (!r.ok) return [];
            const data = await r.json();
            _cache = Array.isArray(data.records) ? data.records : [];
            _fetchedAt = Date.now();
            return _cache;
        } catch {
            return [];
        }
    }

    function _toRad(deg) { return deg * Math.PI / 180; }

    function distanceKm(lat1, lng1, lat2, lng2) {
        const dLat = _toRad(lat2 - lat1);
        const dLng = _toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(_toRad(lat1)) * Math.cos(_toRad(lat2)) *
                  Math.sin(dLng / 2) ** 2;
        return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    async function getNearby(lat, lng, radiusKm = 200) {
        const all = await getQuakes();
        return all
            .map(q => ({ ...q, distance_km: distanceKm(lat, lng, q.latitude, q.longitude) }))
            .filter(q => q.distance_km <= radiusKm)
            .sort((a, b) => a.distance_km - b.distance_km);
    }

    async function getRecentLargeQuakes(minMagnitude = 4.0, limit = 5) {
        const all = await getQuakes();
        return all
            .filter(q => q.magnitude >= minMagnitude)
            .sort((a, b) => a.origin_time < b.origin_time ? 1 : -1)
            .slice(0, limit);
    }

    return { getQuakes, getNearby, getRecentLargeQuakes, distanceKm };
})();

if (typeof window !== 'undefined') {
    window.RealtimeQuakes = RealtimeQuakes;
}
