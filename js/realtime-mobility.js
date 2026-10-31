/**
 * RealtimeMobility — Law & Order Mobility data layer for the cell panel.
 *
 * fetchCell(lat,lng) samples BOTH precomputed grids (MobilityGrid for
 * chokepoints/sealability/police-reach + TrafficGrid for road-network movement);
 * scoreCell collapses them to result.realtime.mobility and adds the Emergency
 * Accessibility Index (emergency_index/band/components). Mirrors
 * realtime-traffic.js. Defensive framing: access resilience for
 * authorities/emergency planning (docs/MOBILITY_MODEL.md).
 */
const RealtimeMobility = (() => {
    /** Async — sample both grids at a lat/lng; returns { mobility, traffic } (each may be null). */
    async function fetchCell(lat, lng) {
        const out = { mobility: null, traffic: null };
        if (typeof MobilityGrid !== 'undefined') {
            try { out.mobility = await MobilityGrid.sampleAt(lat, lng); }
            catch (e) { console.warn('[RealtimeMobility] mobility grid sample failed', e); }
        }
        if (typeof TrafficGrid !== 'undefined') {
            try { out.traffic = await TrafficGrid.sampleAt(lat, lng); }
            catch (e) { console.warn('[RealtimeMobility] traffic grid sample failed', e); }
        }
        return out;
    }

    /** Pure — collapse the two grid samples to the result.realtime.mobility
     *  schema, including the Emergency Accessibility Index. Null when neither the
     *  base mobility record nor the EAI is available (no road). */
    function scoreCell(signals) {
        if (!signals) return null;
        const mob = signals.mobility || null;
        const traf = signals.traffic || null;

        let eai = null;
        if (typeof EmergencyAccess !== 'undefined' && typeof EmergencyAccessScore !== 'undefined') {
            eai = EmergencyAccessScore.computeIndex(EmergencyAccess.combine(mob, traf));
        }
        if ((!mob || mob.mobility_risk == null) && !eai) return null;

        const result = {
            mobility_risk: mob ? mob.mobility_risk : null,
            access_class: mob ? mob.access_class : null,
            sealable: !!(mob && mob.sealable),
            on_chokepoint: !!(mob && mob.on_chokepoint),
            nearest_police_km: mob ? mob.nearest_police_km : null,
            sources: {
                road_network: (mob || traf) ? 'ok' : 'missing',
                police_osm: (mob && mob.nearest_police_km != null) ? 'ok' : 'missing',
            },
            generated_at_iso: new Date().toISOString(),
        };
        if (eai) {
            result.emergency_index = eai.index;
            result.emergency_band = eai.band;
            result.emergency_components = eai.components;
        }
        return result;
    }

    return { fetchCell, scoreCell };
})();

if (typeof window !== 'undefined') window.RealtimeMobility = RealtimeMobility;
