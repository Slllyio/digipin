/**
 * RealtimeTraffic — the structural-traffic data layer for the cell panel.
 *
 * Two responsibilities (mirrors realtime-growth.js):
 *   1. fetchCell(lat, lng) — async; samples the precomputed TrafficGrid, returns
 *      a raw signal bundle (or nulls when the grid isn't present).
 *   2. scoreCell(signals)  — pure; collapses signals to the result.realtime.traffic
 *      schema the widget / overlay / real-estate model read.
 *
 * Honest framing: structural congestion (network betweenness ÷ road capacity →
 * LOS) + GTFS transit access — NOT real-time delays. See docs/TRAFFIC_MODEL.md.
 */
const RealtimeTraffic = (() => {
    /** Async — sample the precomputed grid for this cell. */
    async function fetchCell(lat, lng) {
        if (typeof TrafficGrid === 'undefined') return null;
        try {
            return await TrafficGrid.sampleAt(lat, lng);
        } catch (e) {
            console.warn('[RealtimeTraffic] grid sample failed', e);
            return null;
        }
    }

    /** Pure — collapse the sampled signals to the result.realtime.traffic schema. */
    function scoreCell(signals) {
        if (!signals) return null;
        const hasRoad = signals.congestion_risk != null || signals.los_grade != null;
        const hasTransit = (signals.transit_stops != null && signals.transit_stops > 0)
            || (signals.transit_access != null && signals.transit_access > 0);
        if (!hasRoad && !hasTransit) return null;

        const transit = hasTransit ? {
            stops: signals.transit_stops,
            routes: signals.transit_routes,
            headway_min: signals.transit_headway_min,
            access_score: signals.transit_access != null ? signals.transit_access
                : (typeof TrafficScore !== 'undefined'
                    ? TrafficScore.transitAccessScore(signals.transit_headway_min, signals.transit_routes)
                    : null),
            source: signals.transit_source || null,   // 'osm_stops' (coverage) | 'gtfs' (frequency)
        } : null;

        return {
            congestion_risk: signals.congestion_risk,
            los_grade: signals.los_grade,
            dominant_road_class: signals.dominant_class,
            road_density_m: signals.road_density_m,
            has_critical_link: !!signals.has_critical_link,
            transit,
            sources: {
                road_network: hasRoad ? 'ok' : 'missing',
                transit_gtfs: hasTransit ? 'ok' : 'missing',
            },
            generated_at_iso: new Date().toISOString(),
        };
    }

    return { fetchCell, scoreCell };
})();

if (typeof window !== 'undefined') window.RealtimeTraffic = RealtimeTraffic;
