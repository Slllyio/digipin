/**
 * CellRouting — turns exposure into an actionable evacuation plan: route each
 * at-risk DigiPin cell to its nearest SAFE cell. This is the "last-mile" payoff
 * of the real-time layer — a responder gets origin→destination directions, not
 * just a risk map.
 *
 * Honest framing: distances are great-circle with a road-circuity detour factor
 * (the same 1.3 the isochrone tool uses), not turn-by-turn routing — a defensible
 * "which way and how far" signal that needs no routing server. When a road graph
 * / OSRM is wired in later, only nearestSafe() changes; the plan shape is stable.
 *
 * Pure + unit-tested.
 *
 *   const plan = CellRouting.planEvacuation(rankedExposureCells, { safeBelow: 25 });
 *   plan.routes[0] -> { from:{code,exposure,center}, to:{code,center}, km, roadKm, direction }
 */
const CellRouting = (() => {
    const R_KM = 6371;
    const DETOUR = 1.3;                       // street circuity penalty (matches isochrone.js)
    const DIRS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const _rad = d => d * Math.PI / 180;

    function _center(c) { return (c && c.geometry && c.geometry.center) || (c && c.center) || null; }
    function _code(c) { return (c && c.digipin && c.digipin.code) || (c && c.code) || null; }

    /** Great-circle distance in km between {lat,lng} points. Pure. */
    function haversineKm(a, b) {
        if (!a || !b) return null;
        const dLat = _rad(b.lat - a.lat), dLng = _rad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(_rad(a.lat)) * Math.cos(_rad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /** Initial bearing a→b as {degrees, compass}. Pure. */
    function bearing(a, b) {
        const dLng = _rad(b.lng - a.lng);
        const y = Math.sin(dLng) * Math.cos(_rad(b.lat));
        const x = Math.cos(_rad(a.lat)) * Math.sin(_rad(b.lat))
            - Math.sin(_rad(a.lat)) * Math.cos(_rad(b.lat)) * Math.cos(dLng);
        const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        return { degrees: Math.round(deg), compass: DIRS8[Math.round(deg / 45) % 8] };
    }

    /** Nearest safe candidate to an origin point, within maxKm. Pure. */
    function nearestSafe(origin, safeCells, opts = {}) {
        const maxKm = opts.maxKm || Infinity;
        let best = null;
        for (const c of safeCells || []) {
            const ctr = _center(c);
            if (!ctr) continue;
            const km = haversineKm(origin, ctr);
            if (km == null || km > maxKm) continue;
            if (!best || km < best.km) best = { cell: c, km, center: ctr };
        }
        if (!best) return null;
        return {
            to: best.cell,
            km: +best.km.toFixed(2),
            roadKm: +(best.km * DETOUR).toFixed(2),
            direction: bearing(origin, best.center),
        };
    }

    /**
     * Build an evacuation plan from exposure-ranked cells. `ranked` items carry
     * {exposure, code/digipin, geometry/center}. Routes the top at-risk cells to
     * the nearest safe cell. Pure.
     */
    function planEvacuation(ranked, opts = {}) {
        const safeBelow = opts.safeBelow == null ? 25 : opts.safeBelow;
        const riskAbove = opts.riskAbove == null ? 45 : opts.riskAbove;
        const top = opts.top || 10;
        const maxKm = opts.maxKm || 10;

        const withCenter = (ranked || []).filter(_center);
        const safe = withCenter.filter(c => c.exposure != null && c.exposure <= safeBelow);
        const atRisk = withCenter.filter(c => c.exposure != null && c.exposure >= riskAbove).slice(0, top);

        const routes = atRisk.map(c => {
            const origin = _center(c);
            const ns = nearestSafe(origin, safe, { maxKm });
            return {
                from: { code: _code(c), exposure: c.exposure, center: origin },
                to: ns ? { code: _code(ns.to), center: _center(ns.to) } : null,
                km: ns ? ns.km : null,
                roadKm: ns ? ns.roadKm : null,
                direction: ns ? ns.direction : null,
            };
        });
        return {
            routes,
            summary: {
                atRisk: atRisk.length,
                safeCells: safe.length,
                routed: routes.filter(r => r.to).length,
                unreachable: routes.filter(r => !r.to).length,
            },
        };
    }

    /** Routes → GeoJSON LineStrings for map rendering. Pure. */
    function routesGeoJSON(plan) {
        const features = (plan && plan.routes || [])
            .filter(r => r.to && r.from.center && r.to.center)
            .map(r => ({
                type: 'Feature',
                properties: { from: r.from.code, to: r.to.code, roadKm: r.roadKm, exposure: r.from.exposure },
                geometry: { type: 'LineString', coordinates: [
                    [r.from.center.lng, r.from.center.lat],
                    [r.to.center.lng, r.to.center.lat],
                ] },
            }));
        return { type: 'FeatureCollection', features };
    }

    return { haversineKm, bearing, nearestSafe, planEvacuation, routesGeoJSON };
})();

if (typeof window !== 'undefined') window.CellRouting = CellRouting;
