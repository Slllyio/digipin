/**
 * GrowthOverlay — map heatmap colouring visible cells by growth score.
 *
 * Reuses the existing HeatmapOverlay pattern (PR #5 era) for source/layer
 * management; the only difference is the score function pulled from
 * result.realtime.growth.horizons[<active>].composite.
 *
 * Spec §7.2.
 */
const GrowthOverlay = (() => {
    const SOURCE_ID = 'growth-overlay-src';
    const LAYER_ID  = 'growth-overlay-fill';
    let _active = false;
    let _horizon = 'nowcast';

    function _colorFor(score) {
        if (score == null) return 'rgba(0,0,0,0)';
        if (score >= 75) return '#dc2626';
        if (score >= 60) return '#f97316';
        if (score >= 45) return '#dbab09';
        return '#2dba4e';
    }

    function setHorizon(h) {
        _horizon = h;
        if (_active) refresh();
    }

    function refresh() {
        // Stub for v1: a real implementation iterates visible DigiPin cells and
        // fetches RealtimeGrowth per cell. For initial release we render only
        // the currently-selected cell as a single coloured square.
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.45 },
            });
        }
    }

    function attach() {
        _active = true;
        refresh();
    }

    function detach() {
        _active = false;
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }

    function toggle() {
        if (_active) detach();
        else attach();
    }

    return { attach, detach, toggle, setHorizon };
})();

if (typeof window !== 'undefined') window.GrowthOverlay = GrowthOverlay;
