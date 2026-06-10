/**
 * PrecomputedScores — read per-cell intelligence scores from static JSON shards
 * instead of fetching ~15 live APIs per click.
 *
 * The pipeline (pipeline/scores/build_tile.py) emits, per covered region:
 *   - data/scores/coverage.json   — manifest: { version, generated, radiusM,
 *       fields:[scoreId...], regions:[{name, level, shardPrefixLen, shards:[],
 *       bbox, path}] }
 *   - data/scores/<region>/<prefix>.json — { "<dashless-code>": [v1..vN] } with
 *       values in `fields` order.
 *
 * This module looks scores up from those files and returns them in the exact
 * shape every consumer already reads: result.scores = { id: { label, value } }.
 * When coverage.json is absent (404) or DIGIPIN_CONFIG.precomputedScores is
 * false, it stays silently disabled and the app uses the live path unchanged.
 *
 * Config (window.DIGIPIN_CONFIG):
 *   precomputedScores: false   — kill switch
 *   scoresBase: 'https://r2…/' — override the data/scores/ base (future R2)
 */
const PrecomputedScores = (() => {
    let _coverage = null;       // parsed coverage.json (null until init resolves)
    let _enabled = false;
    let _labels = {};           // scoreId -> human label, from DataFetcher
    const _shardCache = new Map();   // "<region>/<prefix>" -> Promise<obj>
    const _regionCells = new Map();  // region.name -> Promise<[{code,bounds,center,values}]>

    function _base() {
        const cfg = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG) || {};
        return cfg.scoresBase || 'data/scores/';
    }

    function _disabled() {
        const cfg = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG) || {};
        return cfg.precomputedScores === false;
    }

    /** Fetch coverage.json + cache the score labels. Idempotent — re-initialises
     *  cleanly (clears caches), so it's safe to call again after config changes. */
    async function init() {
        _coverage = null;
        _enabled = false;
        _labels = {};
        _shardCache.clear();
        _regionCells.clear();
        if (_disabled()) return false;
        try {
            const resp = await fetch(`${_base()}coverage.json`, { cache: 'no-cache' });
            if (!resp.ok) return false;
            const cov = await resp.json();
            if (!cov || !Array.isArray(cov.regions) || !Array.isArray(cov.fields)) return false;
            _coverage = cov;
            _labels = _buildLabels();
            _enabled = cov.regions.length > 0;
            return _enabled;
        } catch {
            return false;
        }
    }

    function _buildLabels() {
        // Source-of-truth labels from the live model, keyed by score id.
        if (typeof DataFetcher === 'undefined' || !DataFetcher.computeScores) return {};
        const map = {};
        const base = DataFetcher.computeScores({});
        for (const [id, sc] of Object.entries(base)) map[id] = sc.label;
        return map;
    }

    function isEnabled() { return _enabled; }

    /** Coverage regions (for layers that render the tile, e.g. the choropleth). */
    function getRegions() { return _enabled ? _coverage.regions : []; }

    function _inBbox(b, lat, lng) {
        return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
    }

    /** The region covering a point, or null. */
    function regionFor(lat, lng) {
        if (!_enabled) return null;
        return _coverage.regions.find(r => _inBbox(r.bbox, lat, lng)) || null;
    }

    function hasCoverage(lat, lng) { return regionFor(lat, lng) !== null; }

    function _cellCode(region, lat, lng) {
        return DigiPin.encode(lat, lng).replace(/-/g, '').slice(0, region.level);
    }

    function _rehydrate(values) {
        const fields = _coverage.fields;
        const scores = {};
        for (let i = 0; i < fields.length; i++) {
            const id = fields[i];
            scores[id] = { label: _labels[id] || id, value: values[i] };
        }
        return scores;
    }

    async function _shard(region, prefix) {
        const key = `${region.name}/${prefix}`;
        if (!_shardCache.has(key)) {
            _shardCache.set(key, (async () => {
                try {
                    const resp = await fetch(`${_base()}${region.name}/${prefix}.json`, { cache: 'no-cache' });
                    return resp.ok ? await resp.json() : {};
                } catch { return {}; }
            })());
        }
        return _shardCache.get(key);
    }

    /** Scores for the cell at (lat,lng), or null if not covered / not found. */
    async function lookup(lat, lng) {
        const region = regionFor(lat, lng);
        if (!region) return null;
        const code = _cellCode(region, lat, lng);
        const shard = await _shard(region, code.slice(0, region.shardPrefixLen));
        const values = shard[code];
        if (!values) return null;
        return { code: DigiPin.format(code), scores: _rehydrate(values) };
    }

    /** All cells of a region, decoded once (code, bounds, center, values). */
    async function _loadRegion(region) {
        if (!_regionCells.has(region.name)) {
            _regionCells.set(region.name, (async () => {
                const shards = await Promise.all(
                    (region.shards || []).map(p => _shard(region, p)));
                const cells = [];
                for (const obj of shards) {
                    for (const [code, values] of Object.entries(obj)) {
                        const d = DigiPin.decodePartial(code);
                        cells.push({
                            code: DigiPin.format(code),
                            bounds: d.bounds,
                            center: { lat: d.lat, lng: d.lng },
                            values,
                        });
                    }
                }
                return cells;
            })());
        }
        return _regionCells.get(region.name);
    }

    function _intersects(b, vb) {
        return !(b.north < vb.south || b.south > vb.north || b.east < vb.west || b.west > vb.east);
    }

    /**
     * Every covered cell intersecting `bounds` ({south,west,north,east}), with
     * rehydrated scores. The one-shot replacement for an overlay's live grid
     * sampling — returns true DIGIPIN cell rectangles. null if no region covers
     * the viewport centre.
     */
    async function lookupViewport(bounds) {
        const cLat = (bounds.south + bounds.north) / 2;
        const cLng = (bounds.west + bounds.east) / 2;
        const region = regionFor(cLat, cLng);
        if (!region) return null;
        const cells = await _loadRegion(region);
        return cells
            .filter(c => _intersects(c.bounds, bounds))
            .map(c => ({ code: c.code, bounds: c.bounds, center: c.center, scores: _rehydrate(c.values) }));
    }

    return { init, isEnabled, getRegions, hasCoverage, regionFor, lookup, lookupViewport };
})();

if (typeof window !== 'undefined') {
    window.PrecomputedScores = PrecomputedScores;
}
