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
        _clampElevationZoom(map);
        _regroundOnMoveEnd(map);
    }

    /**
     * Belt and braces for the same MapLibre 5 issue: if an animation still
     * finishes with the camera's ground elevation far off the real terrain
     * (it was sampled before the DEM tile arrived), re-ground it with a no-op
     * jump, which recomputes the elevation from the now-loaded tile.
     */
    function _regroundOnMoveEnd(map) {
        if (!map || map._digipinReground || typeof map.on !== 'function') return;
        map._digipinReground = true;
        // moveend can fire before the DEM tile lands; idle comes after it.
        const check = () => {
            if (!_enabled || !map.terrain || typeof map.getCenterElevation !== 'function') return;
            if (map.isMoving && map.isMoving()) return;
            try {
                const want = map.terrain.getElevationForLngLatZoom(map.getCenter(), map.getZoom());
                if (Number.isFinite(want) && Math.abs(map.getCenterElevation() - want) > 50) {
                    map.jumpTo({ center: map.getCenter() });
                }
            } catch { /* internals changed — leave the camera alone */ }
        };
        map.on('moveend', check);
        map.on('idle', check);
        map.on('sourcedata', (e) => { if (e && e.sourceId === SOURCE_ID && e.isSourceLoaded) check(); });
    }

    /**
     * MapLibre 5 samples the camera's ground elevation during ease/fly
     * animations at the *render* tile zoom, unclamped. Past the DEM's maxzoom
     * (15) no tile matches, the lookup returns 0 m, and on a raised city
     * (Indore ~550 m, ×1.5) the camera ends up under the terrain: a blank map
     * whenever you animate-zoom past z15 with terrain on. The same happens
     * mid-flight when the target's DEM tile hasn't loaded yet. So: clamp the
     * lookup zoom to the DEM maxzoom (MapLibre's own getElevationForLngLat
     * already does this) and, when that tile has no data yet, fall back to
     * the nearest coarser loaded tile. Idempotent; a no-op when the
     * internals are absent.
     */
    function _clampElevationZoom(map) {
        const t = map && map.terrain;
        if (!t || t._digipinClamped) return;
        const maxZ = () => (t.tileManager && Number.isFinite(t.tileManager.maxzoom)) ? t.tileManager.maxzoom : 15;
        for (const fn of ['getElevationForLngLatZoom', 'getMinTileElevationForLngLatZoom']) {
            if (typeof t[fn] !== 'function') continue;
            const orig = t[fn].bind(t);
            t[fn] = (lnglat, zoom) => elevationWithFallback(orig, lnglat, zoom, maxZ());
        }
        t._digipinClamped = true;
    }

    /**
     * Elevation lookup at min(zoom, maxZ), stepping to coarser zooms (up to 8
     * levels) while the result is empty (0 / not finite — i.e. no tile yet).
     * Pure given `lookup(lnglat, z)`.
     */
    function elevationWithFallback(lookup, lnglat, zoom, maxZ) {
        let z = Math.floor(Math.min(zoom, maxZ));
        const floor = Math.max(0, z - 8);
        let v = lookup(lnglat, z);
        while ((!Number.isFinite(v) || v === 0) && z > floor) {
            z--;
            v = lookup(lnglat, z);
        }
        return Number.isFinite(v) ? v : 0;
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
        _enabled = on;
        if (!on) { _detach(map); _emit(); return _enabled; }
        // MapLibre 4.1 throws inside its render loop (and silently stops
        // drawing) if terrain appears mid-easeTo: the ease never prepared an
        // elevation target. Attach once the camera is still.
        const attach = () => { if (_enabled) { _attach(map); _emit(); } };
        if (map.isMoving && map.isMoving()) map.once('moveend', attach);
        else attach();
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

    return { setEnabled, toggle, isEnabled, setExaggeration, demSource, hillshadePaint, elevationWithFallback,
        SOURCE_ID, HILLSHADE_ID, DEFAULT_EXAGGERATION };
})();

if (typeof window !== 'undefined') window.Terrain = Terrain;
