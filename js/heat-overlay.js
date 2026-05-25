/**
 * HeatOverlay — map heatmap colouring visible cells by Urban Heat Index intensity.
 *
 * Scaffold mirrors GrowthOverlay (PR #13). v1 renders only the currently-selected
 * cell as a coloured square; a follow-up will iterate the visible DigiPin viewport
 * and batch-score via RealtimeHeat.
 */
const HeatOverlay = (() => {
    const SOURCE_ID = 'heat-overlay-src';
    const LAYER_ID  = 'heat-overlay-fill';
    let _active = false;

    function _colorFor(score) {
        if (score == null) return 'rgba(0,0,0,0)';
        if (score >= 80) return '#7f1d1d';
        if (score >= 60) return '#dc2626';
        if (score >= 45) return '#f97316';
        if (score >= 25) return '#dbab09';
        return '#2dba4e';
    }

    function refresh() {
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.5 },
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

    return { attach, detach, toggle };
})();

if (typeof window !== 'undefined') window.HeatOverlay = HeatOverlay;
