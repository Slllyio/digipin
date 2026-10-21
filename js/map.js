/**
 * Interactive Map Module — MapLibre GL JS + DigiPin Grid Overlay
 * Pilot City: Indore (22.7196°N, 75.8577°E)
 *
 * The grid is multi-resolution: its DIGIPIN level follows the zoom
 * (DigiPin.levelForZoom: z13–14 → L6 ~1 km, z15–16 → L7 ~245 m, z17–18 → L8
 * ~61 m), so a click always selects a cell of the level you're looking at.
 * A readout shows the code under the pointer, and the selected cell keeps its
 * own outline layer so it stays visible when the grid changes level.
 */

const MapModule = (() => {
    let map;
    let _gridDebounceTimer = null;
    let selectedCellId = null;
    let selectedCellCode = null; // DigiPin code of selected cell (persists across grid updates)
    let _selectEpoch = 0;        // bumped per selection; stale async fetches bail (no panel overwrite)
    let hoveredCellId = null;
    let currentCells = new Map(); // Store cell data by ID
    let codeToCellId = new Map(); // DigiPin code -> numeric feature ID

    let gridLevel = null;        // DIGIPIN level the grid is drawn at
    let _refreshReadout = () => {};
    const INDORE = { lat: 22.7196, lng: 75.8577 };
    const INITIAL_ZOOM = 13;

    function init() {
        // Add PMTiles protocol globally
        if (typeof maplibregl !== 'undefined' && typeof pmtiles !== 'undefined') {
            const protocol = new pmtiles.Protocol();
            maplibregl.addProtocol('pmtiles', protocol.tile);
            // Cap and retry stalled range reads, or one hung directory read
            // silently empties every PMTiles source for the session.
            if (typeof OvertureRelease !== 'undefined' && OvertureRelease.guardRangeReads) OvertureRelease.guardRangeReads(pmtiles);
        }

        const styleUrl = (typeof Theme !== 'undefined') ? Theme.mapStyleUrl()
            : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
        map = new maplibregl.Map({
            container: 'map',
            // Basemap follows the active theme (dark-matter / positron). A theme
            // change reloads the app, so picking the style at init is enough.
            style: styleUrl,
            center: [INDORE.lng, INDORE.lat], // MapLibre uses [lng, lat]
            zoom: INITIAL_ZOOM,
            pitch: 0,
            bearing: 0,
            attributionControl: false,
            // Keep the WebGL drawing buffer readable so PitchMap can export the
            // styled view as a PNG (getCanvas().toBlob). Minor, known perf cost —
            // acceptable for a client-side map-image export. (MapLibre 5 moved
            // WebGL context flags under canvasContextAttributes.)
            canvasContextAttributes: { preserveDrawingBuffer: true }
        });

        // Controls
        map.addControl(new maplibregl.NavigationControl({
            visualizePitch: true
        }), 'bottom-right');
        
        map.addControl(new maplibregl.ScaleControl({
            maxWidth: 100,
            unit: 'metric'
        }), 'bottom-left');

        map.addControl(new maplibregl.AttributionControl({
            compact: false,
            customAttribution: '&copy; DigiPin by India Post | &copy; Overture Maps | &copy; CARTO'
        }), 'bottom-left');

        installBasemapGuard(styleUrl);

        map.on('load', () => {
            setupGridLayers();
            setupHeatmapLayers();
            updateGrid();

            // Bharatlas init — pre-attaches invisible lookup PMTiles
            // (states, districts, sub-districts, pincodes) so the cell
            // detail panel can resolve admin/postal containment without
            // hitting Overpass.
            if (typeof Bharatlas !== 'undefined') Bharatlas.init(map);

            // Debounced updates
            const debouncedUpdate = () => {
                clearTimeout(_gridDebounceTimer);
                _gridDebounceTimer = setTimeout(updateGrid, 150);
            };
            map.on('moveend', debouncedUpdate);
            map.on('zoomend', debouncedUpdate);
        });

        return map;
    }

    /**
     * Basemap resilience. If the CARTO style itself cannot be fetched (CDN
     * blocked, captive portal, offline first visit) MapLibre never fires
     * `load`, so no grid or data layer would ever appear. Swap in a plain
     * inline style so the DIGIPIN grid and every own-origin layer still work,
     * and say so. Once the style is up, a burst of tile failures gets a
     * dismissible notice instead of a silently blank map.
     */
    const FALLBACK_STYLE = () => ({
        version: 8,
        name: 'digipin-fallback',
        glyphs: 'https://basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
        sources: {},
        layers: [{
            id: 'background', type: 'background',
            paint: { 'background-color': (typeof Theme !== 'undefined' && Theme.get() === 'light') ? '#e9e6df' : '#0b0e14' },
        }],
    });

    function installBasemapGuard(styleUrl) {
        let styleOk = false;
        let fellBack = false;
        let tileErrors = 0;
        let tileWindowStart = 0;
        const status = (key, opts) => { if (typeof DataStatus !== 'undefined') { if (opts) DataStatus.set(key, opts); else DataStatus.clear(key); } };

        map.on('style.load', () => { styleOk = true; });

        map.on('error', (e) => {
            const err = (e && e.error) || {};
            if (!styleOk && !fellBack && !e.sourceId) {
                // Style document failed → fall back so `load` can fire.
                fellBack = true;
                console.warn('[map] basemap style failed, using fallback:', err.message || err);
                try { map.setStyle(FALLBACK_STYLE()); } catch (ex) { console.error('[map] fallback style failed too', ex); return; }
                status('basemap', {
                    text: 'Basemap could not be loaded. Showing the grid and data layers on a plain background.',
                    kind: 'warning',
                    action: { label: 'Retry', run: () => { try { window.location.reload(); } catch { /* ignore */ } } },
                });
                return;
            }
            if (styleOk && e.sourceId && !fellBack) {
                const now = Date.now();
                if (now - tileWindowStart > 15000) { tileWindowStart = now; tileErrors = 0; }
                tileErrors += 1;
                if (tileErrors === 8) {
                    status('tiles', {
                        text: 'Map tiles are not loading right now. Data layers still work.',
                        kind: 'warning',
                    });
                }
            }
        });
        // A tile that does arrive means the network is back → drop the notice.
        map.on('data', (e) => {
            if (e && e.dataType === 'source' && e.tile && tileErrors > 0) {
                tileErrors = 0;
                status('tiles');
            }
        });
        // Expose for tests / diagnostics.
        _basemapState = () => ({ styleOk, fellBack, tileErrors, styleUrl });
    }
    let _basemapState = () => ({ styleOk: false, fellBack: false, tileErrors: 0 });

    function setupGridLayers() {
        // Grid colours follow the active theme (neon cyan/purple on dark,
        // coral/violet on paper-light). Theme switches reload, so init-time is enough.
        const gc = (typeof Theme !== 'undefined') ? Theme.gridColors()
            : { base: '#00f5ff', selected: '#a855f7' };

        // Source for grid polygons
        map.addSource('digipin-grid', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });

        // Fill layer
        map.addLayer({
            id: 'digipin-grid-fill',
            type: 'fill',
            source: 'digipin-grid',
            paint: {
                'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], gc.selected, gc.base],
                'fill-opacity': [
                    'case',
                    ['boolean', ['feature-state', 'selected'], false], 0.25,
                    ['boolean', ['feature-state', 'hover'], false], 0.15,
                    0.05
                ]
            }
        });

        // Outline layer
        map.addLayer({
            id: 'digipin-grid-line',
            type: 'line',
            source: 'digipin-grid',
            paint: {
                'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], gc.selected, gc.base],
                'line-width': [
                    'case',
                    ['boolean', ['feature-state', 'selected'], false], 3,
                    ['boolean', ['feature-state', 'hover'], false], 2,
                    1
                ],
                'line-opacity': [
                    'case',
                    ['boolean', ['feature-state', 'selected'], false], 1.0,
                    ['boolean', ['feature-state', 'hover'], false], 0.8,
                    0.4
                ]
            }
        });

        // Hover events — mousemove fires 60+×/sec; coalesce to one
        // setFeatureState per animation frame so fast drags don't thrash.
        let _hoverRaf = null, _pendingHoverId = null;
        const _applyHover = () => {
            _hoverRaf = null;
            const id = _pendingHoverId;
            if (id == null) return;
            if (hoveredCellId !== null && hoveredCellId !== id) {
                map.setFeatureState({ source: 'digipin-grid', id: hoveredCellId }, { hover: false });
            }
            hoveredCellId = id;
            map.setFeatureState({ source: 'digipin-grid', id }, { hover: true });
            map.getCanvas().style.cursor = 'pointer';
        };
        map.on('mousemove', 'digipin-grid-fill', (e) => {
            if (e.features.length === 0) return;
            _pendingHoverId = e.features[0].id;
            if (_hoverRaf == null) _hoverRaf = requestAnimationFrame(_applyHover);
        });

        map.on('mouseleave', 'digipin-grid-fill', () => {
            if (_hoverRaf != null) { cancelAnimationFrame(_hoverRaf); _hoverRaf = null; }
            _pendingHoverId = null;
            if (hoveredCellId !== null) {
                map.setFeatureState({ source: 'digipin-grid', id: hoveredCellId }, { hover: false });
            }
            hoveredCellId = null;
            map.getCanvas().style.cursor = '';
        });

        // Selected-cell outline: independent of the grid, so a selection made
        // at one level stays visible after zooming to another.
        map.addSource('digipin-selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: 'digipin-selected-line', type: 'line', source: 'digipin-selected',
            paint: { 'line-color': gc.selected, 'line-width': 3, 'line-dasharray': [2, 1] },
        });

        _setupReadout();

        // Click event
        map.on('click', 'digipin-grid-fill', (e) => {
            // A drawing tool owns clicks while it is active.
            if (typeof InsightsPanel !== 'undefined' && InsightsPanel.isDrawing && InsightsPanel.isDrawing()) return;
            if (typeof MassingSketch !== 'undefined' && MassingSketch.isDrawing()) return;
            if (e.features.length > 0) {
                const feature = e.features[0];
                const cellData = currentCells.get(feature.id);
                if (cellData) selectCell(cellData);
            }
        });
    }

    /** Outline the selected cell (any level) on its own layer. */
    function _drawSelected(code) {
        const src = map && map.getSource('digipin-selected');
        if (!src) return;
        let feature = null;
        try {
            const b = DigiPin.cellBounds(code).bounds;
            feature = {
                type: 'Feature', properties: { code: DigiPin.format(code) },
                geometry: { type: 'Polygon', coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]] },
            };
        } catch { /* invalid code: clear */ }
        src.setData({ type: 'FeatureCollection', features: feature ? [feature] : [] });
    }

    /**
     * Readout chip: the code of the cell under the pointer at the grid's level,
     * its size, and the full 10-symbol code of the point. Click copies the code.
     */
    function _setupReadout() {
        if (typeof document === 'undefined' || document.getElementById('digipin-readout')) return;
        const el = document.createElement('button');
        el.id = 'digipin-readout';
        el.type = 'button';
        el.className = 'digipin-readout';
        el.title = 'DIGIPIN under the pointer: click to copy';
        el.setAttribute('aria-live', 'off');
        el.hidden = true;
        (map.getContainer() || document.body).appendChild(el);
        let raf = null, last = null;
        const render = () => {
            raf = null;
            if (!last) return;
            let cell, point;
            try {
                const L = gridLevel || DigiPin.levelForZoom(map.getZoom());
                cell = DigiPin.encodeLevel(last.lat, last.lng, L);
                point = DigiPin.encode(last.lat, last.lng);
            } catch { el.hidden = true; return; }
            el.hidden = false;
            el.dataset.code = DigiPin.format(cell);
            el.innerHTML = `<strong>${DigiPin.format(cell)}</strong> <span>L${cell.length} · ${DigiPin.sizeLabel(cell.length, last.lat)}</span> <span class="digipin-readout-point">${point}</span>`;
        };
        map.on('mousemove', (e) => {
            last = e.lngLat;
            if (raf == null) raf = requestAnimationFrame(render);
        });
        map.on('mouseout', () => { el.hidden = true; });
        // The grid's level changes with zoom; redraw the readout when it does.
        _refreshReadout = () => { if (last && raf == null) raf = requestAnimationFrame(render); };
        el.addEventListener('click', () => {
            const code = el.dataset.code;
            if (code && navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
        });
    }

    function setupHeatmapLayers() {
        map.addSource('heatmap-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });

        map.addLayer({
            id: 'heatmap-circles',
            type: 'circle',
            source: 'heatmap-source',
            paint: {
                'circle-radius': ['get', 'radius'],
                'circle-color': ['get', 'color'],
                'circle-opacity': ['get', 'opacity'],
                'circle-stroke-width': 2,
                'circle-stroke-color': ['get', 'color'],
                'circle-stroke-opacity': ['get', 'opacity']
            }
        });

        map.on('click', 'heatmap-circles', (e) => {
            if (e.features.length > 0) {
                const props = e.features[0].properties;
                new maplibregl.Popup({ closeButton: false, className: 'dt-popup' })
                    .setLngLat(e.lngLat)
                    .setHTML(`<div style="text-align:center;font-family:Inter,sans-serif;">
                        <strong>#${props.rank}</strong> — ${props.code}<br>
                        <strong>Score: </strong><strong>${props.score}</strong>
                    </div>`)
                    .addTo(map);
            }
        });

        map.on('mouseenter', 'heatmap-circles', () => map.getCanvas().style.cursor = 'pointer');
        map.on('mouseleave', 'heatmap-circles', () => map.getCanvas().style.cursor = '');
    }

    function updateGrid() {
        const zoom = map.getZoom();
        
        if (zoom < 4) {
            // clear grid
            if (map.getSource('digipin-grid')) {
                map.getSource('digipin-grid').setData({ type: 'FeatureCollection', features: [] });
            }
            return;
        }

        const bounds = map.getBounds();
        const mapBounds = {
            south: bounds.getSouth(),
            north: bounds.getNorth(),
            west: bounds.getWest(),
            east: bounds.getEast()
        };

        const cells = DigiPin.getGridCells(mapBounds, zoom);
        gridLevel = cells.length ? cells[0].level : null;
        _refreshReadout();
        
        const features = [];
        currentCells.clear();
        codeToCellId.clear();

        cells.forEach((cell, index) => {
            // Use sequential index as feature ID — guaranteed unique per render
            const featureId = index + 1;

            currentCells.set(featureId, Object.assign({}, cell, { id: featureId }));
            codeToCellId.set(cell.code, featureId);

            features.push({
                type: 'Feature',
                id: featureId,
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [cell.bounds.west, cell.bounds.north],
                        [cell.bounds.east, cell.bounds.north],
                        [cell.bounds.east, cell.bounds.south],
                        [cell.bounds.west, cell.bounds.south],
                        [cell.bounds.west, cell.bounds.north]
                    ]]
                },
                properties: {
                    code: cell.code,
                    level: cell.level
                }
            });
        });

        if (map.getSource('digipin-grid')) {
            map.getSource('digipin-grid').setData({
                type: 'FeatureCollection',
                features: features
            });

            // Re-apply selection if the selected cell is still in the new grid
            if (selectedCellCode && codeToCellId.has(selectedCellCode)) {
                const newId = codeToCellId.get(selectedCellCode);
                selectedCellId = newId;
                map.setFeatureState({ source: 'digipin-grid', id: newId }, { selected: true });
            } else if (selectedCellCode && !codeToCellId.has(selectedCellCode)) {
                // Selected cell scrolled out of view — clear tracked ID but keep code
                selectedCellId = null;
            }
        }
    }

    async function selectCell(cellData) {
        // Per-selection epoch: a slow fetch for a previously-clicked cell must not
        // overwrite the panel after the user has already clicked a different cell.
        const epoch = ++_selectEpoch;
        // Deselect previous
        if (selectedCellId !== null) {
            try { map.setFeatureState({ source: 'digipin-grid', id: selectedCellId }, { selected: false }); } catch { /* grid may have regenerated */ }
        }

        selectedCellId = cellData.id != null ? cellData.id : null;
        selectedCellCode = cellData.code;
        _drawSelected(cellData.code);
        // Highlight only when the cell is an actually-rendered grid feature
        // (deep-linked cells may sit outside the current grid render).
        if (selectedCellId != null) {
            try { map.setFeatureState({ source: 'digipin-grid', id: selectedCellId }, { selected: true }); } catch { /* not rendered */ }
        }

        // Show panel
        Panel.show(cellData);

        // Tie the 3D "digital twin" focus (range rings + amber selected
        // buildings) to the chosen cell — a no-op unless that overlay is on.
        if (typeof OvertureBuildings !== 'undefined' && OvertureBuildings.focusCell && cellData.center) {
            OvertureBuildings.focusCell(cellData.center);
        }

        // Fetch data
        try {
            const data = await DataFetcher.fetchAllFeatures(cellData.center.lat, cellData.center.lng, 500);
            if (epoch !== _selectEpoch) return;   // superseded by a newer selection
            Panel.update(cellData, data);
        } catch (err) {
            if (epoch !== _selectEpoch) return;
            console.error('Data fetch error:', err);
            Panel.showError(cellData, err.message);
        }
    }

    function flyTo(lat, lng, zoom = 16) {
        map.flyTo({ center: [lng, lat], zoom: zoom, duration: 1500 });
    }

    function showHeatmap(results) {
        const gc = (typeof Theme !== 'undefined') ? Theme.gridColors()
            : { base: '#00f5ff', selected: '#a855f7' };
        const features = results.map((r, idx) => {
            const intensity = 1 - (idx / results.length);
            const color = interpolateColor(gc.selected, gc.base, intensity);
            
            return {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [r.lng, r.lat]
                },
                properties: {
                    rank: idx + 1,
                    code: r.code,
                    score: parseFloat(r.score.toFixed(1)),
                    radius: 8 + Math.round(intensity * 12),
                    color: color,
                    opacity: 0.4 + intensity * 0.3
                }
            };
        });

        if (map.getSource('heatmap-source')) {
            map.getSource('heatmap-source').setData({
                type: 'FeatureCollection',
                features: features
            });
        }
    }

    function clearHeatmap() {
        if (map.getSource('heatmap-source')) {
            map.getSource('heatmap-source').setData({
                type: 'FeatureCollection',
                features: []
            });
        }
    }

    function interpolateColor(c1, c2, t) {
        const hex = c => parseInt(c, 16);
        const r = Math.round(hex(c1.slice(1, 3)) + t * (hex(c2.slice(1, 3)) - hex(c1.slice(1, 3))));
        const g = Math.round(hex(c1.slice(3, 5)) + t * (hex(c2.slice(3, 5)) - hex(c1.slice(3, 5))));
        const b = Math.round(hex(c1.slice(5, 7)) + t * (hex(c2.slice(5, 7)) - hex(c1.slice(5, 7))));
        return `rgb(${r},${g},${b})`;
    }

    function getMap() { return map; }

    function getSelectedCode() { return selectedCellCode; }

    /**
     * Deep-link into a DIGIPIN cell by code: fly to it, then (once the grid has
     * re-rendered) select it — opening the panel and fetching data. The feature
     * highlight is best-effort (the cell may render at a different precision than
     * the code's length); the panel + data load are the guaranteed outcome.
     */
    function selectByCode(code) {
        if (!map || !code) return;
        const clean = code.replace(/-/g, '').toUpperCase();
        let decoded;
        if (DigiPin.isValid && !DigiPin.isValid(clean)) return;
        try { decoded = DigiPin.decodePartial(clean); } catch { return; }
        // Fly to the zoom whose grid is this code's level, so the selection
        // lands on a rendered grid cell of the same size.
        const zoom = DigiPin.zoomForLevel ? DigiPin.zoomForLevel(clean.length) : Math.min(18, 8 + clean.length);
        _drawSelected(clean);
        flyTo(decoded.lat, decoded.lng, zoom);
        _afterFly(() => {
            const formatted = DigiPin.format(clean);
            const fid = codeToCellId.has(formatted) ? codeToCellId.get(formatted)
                : (codeToCellId.has(clean) ? codeToCellId.get(clean) : null);
            selectCell({
                id: fid,
                code: formatted,
                center: { lat: decoded.lat, lng: decoded.lng },
                bounds: decoded.bounds,
            });
        });
    }

    /**
     * Run cb once the flyTo has landed and the grid had a chance to render.
     * 'idle' alone was the trigger before, but with the 3D buildings overlay
     * (or a tile that keeps retrying) the map can stay busy for a long time
     * and the selection never opened; so wait for moveend, then the next
     * idle or 1.5 s, whichever is first, with a hard 5 s backstop.
     */
    function _afterFly(cb) {
        let done = false;
        const fire = () => { if (done) return; done = true; clearTimeout(hard); map.off('idle', fire); cb(); };
        const hard = setTimeout(fire, 5000);
        map.once('moveend', () => {
            if (done) return;
            map.once('idle', fire);
            setTimeout(fire, 1500);
        });
    }

    function getGridLevel() { return gridLevel; }

    return { init, flyTo, showHeatmap, clearHeatmap, getMap, updateGrid, selectByCode, getSelectedCode, getGridLevel,
        basemapState: () => _basemapState() };
})();
