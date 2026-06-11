/**
 * ScoreChoropleth — paint the precomputed score tile as an instant choropleth.
 *
 * Reads data/scores/<region>/scores.pmtiles (emitted by build_tile --pmtiles)
 * as a MapLibre vector source and colours each DIGIPIN cell by a chosen score,
 * with zero live fetches. This is the "instant first-paint" layer: the whole
 * scored grid renders the moment it's toggled, because the data is static.
 *
 * Mirrors the established pmtiles source+layer+toggle pattern (overture-buildings
 * .js / digital-twin-layers.js): add-once guard on the source, fill layer with
 * source-layer "scores" (the tiler's layer name), data-driven fill colour.
 * Disabled gracefully when no tile is published yet.
 */
const ScoreChoropleth = (() => {
    const SOURCE_PREFIX = 'score-choro-src-';
    const LAYER_PREFIX = 'score-choro-fill-';
    let _map = null;
    let _active = false;
    let _scoreKey = 'livability';
    let _layers = [];   // [{ source, layer }]

    function _base() {
        const cfg = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG) || {};
        return cfg.scoresBase || 'data/scores/';
    }

    /** PMTiles URL for a coverage region, honouring a scoresBase override. */
    function pmtilesUrl(region) {
        const path = region.path || `data/scores/${region.name}/`;
        const rel = path.replace(/^data\/scores\//, '');   // region-relative part
        return `${_base()}${rel}scores.pmtiles`;
    }

    /** Data-driven fill colour: a 0-100 score property -> red/orange/yellow/green. */
    function colorExpr(scoreKey) {
        return ['step', ['coalesce', ['to-number', ['get', scoreKey]], 0],
            '#ef4444', 20, '#f97316', 40, '#eab308', 70, '#22c55e'];
    }

    function clear() {
        if (_map) {
            _layers.forEach(({ layer, source }) => {
                if (_map.getLayer(layer)) _map.removeLayer(layer);
                if (_map.getSource(source)) _map.removeSource(source);
            });
        }
        _layers = [];
        _active = false;
    }

    function show(scoreKey) {
        if (scoreKey) _scoreKey = scoreKey;
        if (typeof MapModule === 'undefined') return false;
        _map = MapModule.getMap();
        if (!_map) return false;
        clear();

        const regions = (typeof PrecomputedScores !== 'undefined' && PrecomputedScores.getRegions)
            ? PrecomputedScores.getRegions() : [];
        if (!regions.length) {
            if (typeof App !== 'undefined') {
                App.showToast('Score Choropleth',
                    'No precomputed tiles published yet — run the precompute workflow.', 'info');
            }
            return false;
        }

        regions.forEach((region, i) => {
            const source = SOURCE_PREFIX + i;
            const layer = LAYER_PREFIX + i;
            if (!_map.getSource(source)) {
                _map.addSource(source, { type: 'vector', url: `pmtiles://${pmtilesUrl(region)}` });
            }
            _map.addLayer({
                id: layer,
                type: 'fill',
                source,
                'source-layer': 'scores',
                paint: { 'fill-color': colorExpr(_scoreKey), 'fill-opacity': 0.55 },
            });
            _layers.push({ source, layer });
        });

        _active = true;
        if (typeof App !== 'undefined') {
            App.showToast('Score Choropleth', `${_scoreKey} from precomputed tiles — instant.`, 'success');
        }
        return true;
    }

    function setScore(scoreKey) {
        _scoreKey = scoreKey;
        if (_active) {
            _layers.forEach(({ layer }) => {
                if (_map.getLayer(layer)) _map.setPaintProperty(layer, 'fill-color', colorExpr(scoreKey));
            });
        }
    }

    function toggle() {
        if (_active) { clear(); return false; }
        return show(_scoreKey);
    }

    function isActive() { return _active; }

    function getScoreKey() { return _scoreKey; }

    return { show, clear, toggle, isActive, setScore, getScoreKey, colorExpr, pmtilesUrl };
})();

if (typeof window !== 'undefined') {
    window.ScoreChoropleth = ScoreChoropleth;
}
