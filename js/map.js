/**
 * Interactive Map Module — MapLibre GL JS + DigiPin Grid Overlay
 * Pilot City: Indore (22.7196°N, 75.8577°E)
 */

const MapModule = (() => {
    let map;
    let _gridDebounceTimer = null;
    let selectedCellId = null;
    let selectedCellCode = null; // DigiPin code of selected cell (persists across grid updates)
    let hoveredCellId = null;
    let currentCells = new Map(); // Store cell data by ID
    let codeToCellId = new Map(); // DigiPin code -> numeric feature ID

    const INDORE = { lat: 22.7196, lng: 75.8577 };
    const INITIAL_ZOOM = 13;

    function init() {
        // Add PMTiles protocol globally
        if (typeof maplibregl !== 'undefined' && typeof pmtiles !== 'undefined') {
            const protocol = new pmtiles.Protocol();
            maplibregl.addProtocol('pmtiles', protocol.tile);
        }

        map = new maplibregl.Map({
            container: 'map',
            style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
            center: [INDORE.lng, INDORE.lat], // MapLibre uses [lng, lat]
            zoom: INITIAL_ZOOM,
            pitch: 0,
            bearing: 0,
            attributionControl: false
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

        map.on('load', () => {
            setupGridLayers();
            setupHeatmapLayers();
            updateGrid();

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

    function setupGridLayers() {
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
                'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#a855f7', '#00f5ff'],
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
                'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#a855f7', '#00f5ff'],
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

        // Hover events
        map.on('mousemove', 'digipin-grid-fill', (e) => {
            if (e.features.length > 0) {
                if (hoveredCellId !== null && hoveredCellId !== e.features[0].id) {
                    map.setFeatureState({ source: 'digipin-grid', id: hoveredCellId }, { hover: false });
                }
                hoveredCellId = e.features[0].id;
                map.setFeatureState({ source: 'digipin-grid', id: hoveredCellId }, { hover: true });
                map.getCanvas().style.cursor = 'pointer';
            }
        });

        map.on('mouseleave', 'digipin-grid-fill', () => {
            if (hoveredCellId !== null) {
                map.setFeatureState({ source: 'digipin-grid', id: hoveredCellId }, { hover: false });
            }
            hoveredCellId = null;
            map.getCanvas().style.cursor = '';
        });

        // Click event
        map.on('click', 'digipin-grid-fill', (e) => {
            if (e.features.length > 0) {
                const feature = e.features[0];
                const cellData = currentCells.get(feature.id);
                if (cellData) selectCell(cellData);
            }
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
        
        if (zoom < 8) {
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
                    code: cell.code
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
        // Deselect previous
        if (selectedCellId !== null) {
            try { map.setFeatureState({ source: 'digipin-grid', id: selectedCellId }, { selected: false }); } catch { /* grid may have regenerated */ }
        }

        selectedCellId = cellData.id;
        selectedCellCode = cellData.code;
        map.setFeatureState({ source: 'digipin-grid', id: selectedCellId }, { selected: true });

        // Show panel
        Panel.show(cellData);

        // Fetch data
        try {
            const data = await DataFetcher.fetchAllFeatures(cellData.center.lat, cellData.center.lng, 500);
            Panel.update(cellData, data);
        } catch (err) {
            console.error('Data fetch error:', err);
            Panel.showError(cellData, err.message);
        }
    }

    function flyTo(lat, lng, zoom = 16) {
        map.flyTo({ center: [lng, lat], zoom: zoom, duration: 1500 });
    }

    function showHeatmap(results) {
        const features = results.map((r, idx) => {
            const intensity = 1 - (idx / results.length);
            const color = interpolateColor('#a855f7', '#00f5ff', intensity);
            
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

    return { init, flyTo, showHeatmap, clearHeatmap, getMap, updateGrid };
})();
