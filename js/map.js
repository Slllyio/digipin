/**
 * Interactive Map Module — Leaflet.js + DigiPin Grid Overlay
 * Pilot City: Indore (22.7196°N, 75.8577°E)
 */

const MapModule = (() => {
    let map, gridLayer, selectedCell, heatmapLayer;
    let _gridDebounceTimer = null;
    const INDORE = { lat: 22.7196, lng: 75.8577 };
    const INITIAL_ZOOM = 13;

    function init() {
        map = L.map('map', {
            center: [INDORE.lat, INDORE.lng],
            zoom: INITIAL_ZOOM,
            zoomControl: false,
            attributionControl: false
        });

        // Dark CartoDB tiles
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 20,
            subdomains: 'abcd'
        }).addTo(map);

        // Custom zoom control position
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // Attribution
        L.control.attribution({ position: 'bottomleft', prefix: false })
            .addAttribution('&copy; <a href="https://openstreetmap.org">OSM</a> | &copy; <a href="https://carto.com">CARTO</a> | DigiPin by India Post')
            .addTo(map);

        // Grid overlay layer group
        gridLayer = L.layerGroup().addTo(map);

        // Debounced grid updates to prevent jank during rapid pan/zoom
        const debouncedUpdate = () => {
            clearTimeout(_gridDebounceTimer);
            _gridDebounceTimer = setTimeout(updateGrid, 150);
        };
        map.on('moveend', debouncedUpdate);
        map.on('zoomend', debouncedUpdate);

        // Initial grid render
        setTimeout(updateGrid, 500);

        // Scale control
        L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

        return map;
    }

    function updateGrid() {
        const zoom = map.getZoom();
        gridLayer.clearLayers();

        if (zoom < 8) return; // Too zoomed out

        const bounds = map.getBounds();
        const mapBounds = {
            south: bounds.getSouth(),
            north: bounds.getNorth(),
            west: bounds.getWest(),
            east: bounds.getEast()
        };

        const cells = DigiPin.getGridCells(mapBounds, zoom);

        cells.forEach(cell => {
            const rect = L.rectangle(
                [[cell.bounds.south, cell.bounds.west], [cell.bounds.north, cell.bounds.east]],
                {
                    color: '#00f5ff',
                    weight: 1,
                    opacity: 0.4,
                    fillColor: '#00f5ff',
                    fillOpacity: 0.05,
                    className: 'digipin-cell'
                }
            );

            rect.on('mouseover', function () {
                if (this !== selectedCell) {
                    this.setStyle({ fillOpacity: 0.15, opacity: 0.8, weight: 2 });
                }
            });

            rect.on('mouseout', function () {
                if (this !== selectedCell) {
                    this.setStyle({ fillOpacity: 0.05, opacity: 0.4, weight: 1 });
                }
            });

            rect.on('click', () => selectCell(cell, rect));

            // Add DigiPin label at sufficient zoom
            if (zoom >= 14) {
                const label = L.tooltip({
                    permanent: true,
                    direction: 'center',
                    className: 'digipin-label',
                    offset: [0, 0]
                }).setContent(cell.code);
                rect.bindTooltip(label);
            }

            gridLayer.addLayer(rect);
        });
    }

    async function selectCell(cell, rect) {
        // Deselect previous
        if (selectedCell) {
            selectedCell.setStyle({ fillOpacity: 0.05, opacity: 0.4, weight: 1, color: '#00f5ff', fillColor: '#00f5ff' });
        }

        selectedCell = rect;
        rect.setStyle({
            fillOpacity: 0.25,
            opacity: 1,
            weight: 3,
            color: '#a855f7',
            fillColor: '#a855f7'
        });

        // Show panel with loading state
        Panel.show(cell);

        // Fetch data
        try {
            const data = await DataFetcher.fetchAllFeatures(cell.center.lat, cell.center.lng, 500);
            Panel.update(cell, data);
        } catch (err) {
            console.error('Data fetch error:', err);
            Panel.showError(cell, err.message);
        }
    }

    /**
     * Navigate to a location
     */
    function flyTo(lat, lng, zoom = 16) {
        map.flyTo([lat, lng], zoom, { duration: 1.5 });
    }

    /**
     * Show heatmap overlay for query results
     */
    function showHeatmap(results) {
        clearHeatmap();
        heatmapLayer = L.layerGroup().addTo(map);

        results.forEach((r, idx) => {
            const intensity = 1 - (idx / results.length);
            const color = interpolateColor('#a855f7', '#00f5ff', intensity);

            const circle = L.circleMarker([r.lat, r.lng], {
                radius: 8 + intensity * 12,
                color: color,
                fillColor: color,
                fillOpacity: 0.4 + intensity * 0.3,
                weight: 2
            });

            // Safe popup: code comes from our encoder, score is numeric — but use textContent pattern
            const popupDiv = document.createElement('div');
            popupDiv.style.cssText = 'text-align:center;font-family:Inter,sans-serif;';
            const rank = document.createElement('strong');
            rank.textContent = `#${idx + 1}`;
            popupDiv.appendChild(rank);
            popupDiv.appendChild(document.createTextNode(` \u2014 ${r.code}`));
            popupDiv.appendChild(document.createElement('br'));
            const scoreLabel = document.createElement('strong');
            scoreLabel.textContent = r.score.toFixed(1);
            popupDiv.appendChild(document.createTextNode('Score: '));
            popupDiv.appendChild(scoreLabel);
            circle.bindPopup(popupDiv);

            heatmapLayer.addLayer(circle);
        });
    }

    function clearHeatmap() {
        if (heatmapLayer) {
            map.removeLayer(heatmapLayer);
            heatmapLayer = null;
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
