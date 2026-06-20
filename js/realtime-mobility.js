/**
 * RealtimeMobility — Law & Order Mobility data layer for the cell panel.
 *
 * fetchCell(lat,lng) samples the precomputed MobilityGrid; scoreCell collapses it
 * to result.realtime.mobility. Mirrors realtime-traffic.js. Defensive framing:
 * access resilience for authorities/emergency planning (docs/MOBILITY_MODEL.md).
 */
const RealtimeMobility = (() => {
    /** Async — sample the precomputed MobilityGrid at a lat/lng; null on miss/error. */
    async function fetchCell(lat, lng) {
        if (typeof MobilityGrid === 'undefined') return null;
        try {
            return await MobilityGrid.sampleAt(lat, lng);
        } catch (e) {
            console.warn('[RealtimeMobility] grid sample failed', e);
            return null;
        }
    }

    /** Pure — collapse grid signals to the result.realtime.mobility schema; null when unscored. */
    function scoreCell(signals) {
        if (!signals || signals.mobility_risk == null) return null;
        return {
            mobility_risk: signals.mobility_risk,
            access_class: signals.access_class,
            sealable: !!signals.sealable,
            on_chokepoint: !!signals.on_chokepoint,
            nearest_police_km: signals.nearest_police_km,
            sources: { road_network: 'ok', police_osm: signals.nearest_police_km != null ? 'ok' : 'missing' },
            generated_at_iso: new Date().toISOString(),
        };
    }

    return { fetchCell, scoreCell };
})();

if (typeof window !== 'undefined') window.RealtimeMobility = RealtimeMobility;
