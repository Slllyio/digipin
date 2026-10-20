/**
 * Terrain — real ground elevation under the 3D city.
 *
 * Drapes the map (basemap, DIGIPIN grid, overlays, extruded buildings) on a
 * MapLibre raster-dem built from the free AWS Terrain Tiles (Terrarium-encoded
 * PNGs: SRTM ~30 m over India, no API key), and adds a hillshade so the relief
 * reads even from overhead. Indore's relief is gentle (~500–600 m), so the
 * default exaggeration is 1.5×.
 *
 * Buildings follow automatically: MapLibre fill-extrusion layers sit on the
 * terrain. deck.gl's non-interleaved overlay does not, so OvertureBuildings
 * listens for the `terrain:change` window event and swaps to its MapLibre
 * renderer while terrain is on.
 */

const Terrain = (() => {
    const SOURCE_ID = 'terrain-dem';
    const HILLSHADE_SRC = 'terrain-hillshade-dem';
    const HILLSHADE_ID = 'terrain-hillshade';
    const TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
    const DEFAULT_EXAGGERATION = 1.5;

    let _enabled = false;
    let _exaggeration = DEFAULT_EXAGGERATION;

    /** True when the Aino paper-light theme is active. */
    function isLight() {
        return typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light';
    }

    /** raster-dem source definition for the AWS Terrarium tiles. Pure. */
    function demSource() {
        return {
            type: 'raster-dem',
            tiles: [TILES],
            encoding: 'terrarium',
            tileSize: 256,
            maxzoom: 15,
            attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (SRTM, Mapzen)'
        };
    }

    /** Hillshade paint tuned per theme: soft grey on paper, cool blue-black on dark. Pure. */
    function hillshadePaint(light) {
        return light ? {
            'hillshade-shadow-color': '#8a8f96',
            'hillshade-highlight-color': '#ffffff',
            'hillshade-accent-color': '#b9bec4',
            'hillshade-exaggeration': 0.35
        } : {
            'hillshade-shadow-color': '#02080d',
            'hillshade-highlight-color': '#3a6f80',
            'hillshade-accent-color': '#0b2a35',
            'hillshade-exaggeration': 0.45
        };
    }

    /** Id of the first symbol layer, so the hillshade sits under labels. */
    function _firstSymbolId(map) {
        const layers = (map.getStyle && map.getStyle().layers) || [];
        const sym = layers.find(l => l.type === 'symbol');
        return sym ? sym.id : undefined;
    }

    function _attach(map) {
        // Separate DEM sources for terrain and hillshade: MapLibre warns that
        // sharing one degrades the hillshade (it resamples terrain tiles).
        if (!map.getSource(SOURCE_ID)) map.addSource(SOURCE_ID, demSource());
        if (!map.getSource(HILLSHADE_SRC)) map.addSource(HILLSHADE_SRC, demSource());
        if (!map.getLayer(HILLSHADE_ID)) {
            map.addLayer({
                id: HILLSHADE_ID,
                type: 'hillshade',
                source: HILLSHADE_SRC,
                paint: hillshadePaint(isLight())
            }, _firstSymbolId(map));
        }
        map.setTerrain({ source: SOURCE_ID, exaggeration: _exaggeration });
    }

    function _detach(map) {
        try { map.setTerrain(null); } catch { /* no terrain set */ }
        if (map.getLayer(HILLSHADE_ID)) map.removeLayer(HILLSHADE_ID);
        // Sources stay: re-enabling reuses the cached DEM tiles.
    }

    function _emit() {
        if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('terrain:change', { detail: { enabled: _enabled } }));
        }
    }

    /** Turn terrain on/off; returns the new state. */
    function setEnabled(map, on) {
        if (!map) return _enabled;
        on = !!on;
        if (on === _enabled) return _enabled;
        if (on) _attach(map); else _detach(map);
        _enabled = on;
        _emit();
        return _enabled;
    }

    /** Flip terrain on/off; returns the new state. */
    function toggle(map) { return setEnabled(map, !_enabled); }

    /** Vertical exaggeration of the ground (applies live when terrain is on). */
    function setExaggeration(map, x) {
        if (!(Number.isFinite(+x) && +x > 0)) return _exaggeration;
        _exaggeration = +x;
        if (_enabled && map) map.setTerrain({ source: SOURCE_ID, exaggeration: _exaggeration });
        return _exaggeration;
    }

    /** True while terrain is draped. */
    function isEnabled() { return _enabled; }

    return { setEnabled, toggle, isEnabled, setExaggeration, demSource, hillshadePaint,
        SOURCE_ID, HILLSHADE_ID, DEFAULT_EXAGGERATION };
})();

if (typeof window !== 'undefined') window.Terrain = Terrain;
