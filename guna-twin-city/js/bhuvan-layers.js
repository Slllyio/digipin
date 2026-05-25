/**
 * Bhuvan (ISRO) WMS Satellite Layers — Guna Digital Twin
 * ========================================================
 * Adds ISRO Bhuvan WMS raster overlays to the MapLibre map:
 *   - LULC (Land Use Land Cover) 50k
 *   - NDVI (Vegetation Index)
 *   - DEM Hillshade
 *
 * Each layer has toggle controls and an opacity slider.
 * Integrates into the existing DT Layers dropdown panel.
 *
 * SECURITY: All DOM built via createElement / textContent. No innerHTML.
 */

const BhuvanLayers = (() => {
    // ─── Constants ───────────────────────────────────────────────
    const BHUVAN_WMS_BASE = 'https://bhuvan-vec2.nrsc.gov.in/bhuvan/wms';

    const LAYER_DEFS = {
        bhuvan_lulc_50k: {
            name: 'LULC 50K (Bhuvan)',
            icon: '\uD83C\uDF3E',
            wmsLayer: 'lulc_50k',
            group: 'Bhuvan Satellite',
            description: 'Land Use Land Cover at 1:50K scale',
            defaultOpacity: 0.6
        },
        bhuvan_ndvi: {
            name: 'NDVI Vegetation (Bhuvan)',
            icon: '\uD83C\uDF3F',
            wmsLayer: 'ndvi',
            group: 'Bhuvan Satellite',
            description: 'Normalized Difference Vegetation Index',
            defaultOpacity: 0.6
        },
        bhuvan_dem_hillshade: {
            name: 'DEM Hillshade (Bhuvan)',
            icon: '\u26F0',
            wmsLayer: 'dem_hillshade',
            group: 'Bhuvan Satellite',
            description: 'Digital Elevation Model with hillshade',
            defaultOpacity: 0.5
        }
    };

    let _map = null;
    const _state = {};

    // Initialize state for each layer
    Object.keys(LAYER_DEFS).forEach(key => {
        _state[key] = {
            visible: false,
            opacity: LAYER_DEFS[key].defaultOpacity,
            sourceId: `bhuvan-src-${key}`,
            layerId: `bhuvan-lyr-${key}`,
            errorState: false
        };
    });

    // ─── WMS Source/Layer Management ─────────────────────────────

    function _buildWMSTileUrl(wmsLayerName) {
        return BHUVAN_WMS_BASE
            + '?service=WMS&version=1.1.1&request=GetMap'
            + '&layers=' + encodeURIComponent(wmsLayerName)
            + '&srs=EPSG:3857&format=image/png&transparent=true'
            + '&width=256&height=256&bbox={bbox-epsg-3857}';
    }

    function _addSource(key) {
        const def = LAYER_DEFS[key];
        const st = _state[key];

        if (_map.getSource(st.sourceId)) return;

        _map.addSource(st.sourceId, {
            type: 'raster',
            tiles: [_buildWMSTileUrl(def.wmsLayer)],
            tileSize: 256,
            attribution: '&copy; ISRO/NRSC Bhuvan'
        });
    }

    function _addLayer(key) {
        const st = _state[key];

        if (_map.getLayer(st.layerId)) {
            _map.setLayoutProperty(st.layerId, 'visibility', 'visible');
            _map.setPaintProperty(st.layerId, 'raster-opacity', st.opacity);
            return;
        }

        _map.addLayer({
            id: st.layerId,
            type: 'raster',
            source: st.sourceId,
            minzoom: 5,
            paint: { 'raster-opacity': st.opacity },
            layout: { visibility: 'visible' }
        });
    }

    function _hideLayer(key) {
        const st = _state[key];
        if (_map.getLayer(st.layerId)) {
            _map.setLayoutProperty(st.layerId, 'visibility', 'none');
        }
    }

    // ─── Public API ──────────────────────────────────────────────

    function toggle(key) {
        if (!_map) return false;

        const st = _state[key];
        const def = LAYER_DEFS[key];
        if (!st || !def) {
            console.warn('[BhuvanLayers] Unknown layer key:', key);
            return false;
        }

        if (st.visible) {
            _hideLayer(key);
            st.visible = false;
            st.errorState = false;
            return false;
        }

        try {
            _addSource(key);
            _addLayer(key);
            st.visible = true;
            st.errorState = false;

            // Listen for tile errors (CORS, server issues)
            _map.on('error', (e) => {
                if (e.sourceId === st.sourceId && !st.errorState) {
                    st.errorState = true;
                    console.warn(
                        '[BhuvanLayers] Tile load error for ' + def.name
                        + '. Bhuvan WMS may have CORS restrictions or be temporarily unavailable.'
                    );
                    _showToast(
                        def.name + ': Tile loading failed. '
                        + 'Bhuvan WMS may have CORS restrictions or be temporarily unavailable.',
                        'warning'
                    );
                }
            });

            return true;
        } catch (err) {
            console.error('[BhuvanLayers] Failed to add ' + def.name + ':', err);
            _showToast(
                'Failed to add ' + def.name + ': ' + err.message,
                'error'
            );
            return false;
        }
    }

    function setOpacity(key, opacity) {
        const clamped = Math.max(0, Math.min(1, opacity));
        const st = _state[key];
        if (!st) return;

        st.opacity = clamped;
        if (_map && _map.getLayer(st.layerId)) {
            _map.setPaintProperty(st.layerId, 'raster-opacity', clamped);
        }
    }

    function isVisible(key) {
        return _state[key]?.visible || false;
    }

    function getOpacity(key) {
        return _state[key]?.opacity ?? 0.6;
    }

    function getLayerDefs() {
        return Object.entries(LAYER_DEFS).map(([key, def]) => ({
            key,
            name: def.name,
            icon: def.icon,
            group: def.group,
            description: def.description,
            visible: _state[key]?.visible || false
        }));
    }

    function clearAll() {
        Object.keys(LAYER_DEFS).forEach(key => {
            if (_state[key].visible) {
                _hideLayer(key);
                _state[key].visible = false;
                _state[key].errorState = false;
            }
        });
    }

    // ─── Toast Helper ────────────────────────────────────────────

    function _showToast(message, type) {
        const container = document.getElementById('toast-container');
        if (!container) {
            console.warn('[BhuvanLayers]', message);
            return;
        }

        const toast = document.createElement('div');
        toast.className = 'toast';
        if (type === 'warning') {
            toast.style.background = 'rgba(234, 179, 8, 0.9)';
            toast.style.color = '#000';
        } else if (type === 'error') {
            toast.style.background = 'rgba(239, 68, 68, 0.9)';
        }
        toast.textContent = message;

        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.4s';
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 400);
        }, 5000);
    }

    // ─── UI: Build Bhuvan Section in DT Layers Dropdown ─────────

    function _buildLayersPanelSection() {
        const dropdown = document.getElementById('dt-layers-dropdown');
        if (!dropdown) return;

        // Create a group container matching existing DT layers style
        const groupDiv = document.createElement('div');
        groupDiv.className = 'dt-layer-group';
        groupDiv.id = 'bhuvan-layers-group';

        // Collapsible group header
        const headerBtn = document.createElement('button');
        headerBtn.className = 'dt-group-header-btn';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'dt-group-title';
        titleSpan.textContent = 'Bhuvan Satellite';

        const countSpan = document.createElement('span');
        countSpan.className = 'dt-group-count';
        countSpan.textContent = String(Object.keys(LAYER_DEFS).length);

        const chevSpan = document.createElement('span');
        chevSpan.className = 'dt-group-chevron';
        chevSpan.textContent = '\u25BE';

        headerBtn.appendChild(titleSpan);
        headerBtn.appendChild(countSpan);
        headerBtn.appendChild(chevSpan);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'dt-group-content';

        headerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = contentDiv.classList.toggle('open');
            headerBtn.classList.toggle('expanded', isOpen);
        });

        // Build each layer item
        Object.entries(LAYER_DEFS).forEach(([key, def]) => {
            const item = document.createElement('div');
            item.className = 'dt-layer-item';
            item.dataset.layerKey = key;
            item.style.flexWrap = 'wrap';

            // Icon
            const iconEl = document.createElement('span');
            iconEl.className = 'dt-layer-icon';
            iconEl.textContent = def.icon;

            // Name
            const nameEl = document.createElement('span');
            nameEl.className = 'dt-layer-name';
            nameEl.textContent = def.name;

            // Toggle switch
            const toggleLabel = document.createElement('label');
            toggleLabel.className = 'dt-toggle-switch';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.tabIndex = -1;
            const sliderSpan = document.createElement('span');
            sliderSpan.className = 'dt-toggle-slider';
            toggleLabel.appendChild(checkbox);
            toggleLabel.appendChild(sliderSpan);

            item.appendChild(iconEl);
            item.appendChild(nameEl);
            item.appendChild(toggleLabel);

            // Opacity slider row (hidden until layer is active)
            const sliderRow = document.createElement('div');
            sliderRow.className = 'bhuvan-opacity-row';
            sliderRow.style.display = 'none';
            sliderRow.style.width = '100%';
            sliderRow.style.padding = '4px 8px 6px 28px';
            sliderRow.style.alignItems = 'center';

            const sliderLabel = document.createElement('span');
            sliderLabel.style.fontSize = '11px';
            sliderLabel.style.color = '#94a3b8';
            sliderLabel.style.marginRight = '8px';
            sliderLabel.style.whiteSpace = 'nowrap';
            sliderLabel.textContent = 'Opacity';

            const rangeInput = document.createElement('input');
            rangeInput.type = 'range';
            rangeInput.min = '0';
            rangeInput.max = '100';
            rangeInput.value = String(Math.round(def.defaultOpacity * 100));
            rangeInput.style.flex = '1';
            rangeInput.style.accentColor = '#3b82f6';
            rangeInput.style.cursor = 'pointer';
            rangeInput.style.height = '4px';

            const pctLabel = document.createElement('span');
            pctLabel.style.fontSize = '11px';
            pctLabel.style.color = '#94a3b8';
            pctLabel.style.marginLeft = '8px';
            pctLabel.style.minWidth = '32px';
            pctLabel.style.textAlign = 'right';
            pctLabel.textContent = Math.round(def.defaultOpacity * 100) + '%';

            rangeInput.addEventListener('input', (e) => {
                e.stopPropagation();
                const val = parseInt(e.target.value, 10);
                pctLabel.textContent = val + '%';
                setOpacity(key, val / 100);
            });

            // Prevent slider drag from closing dropdown
            rangeInput.addEventListener('click', (e) => e.stopPropagation());
            rangeInput.addEventListener('mousedown', (e) => e.stopPropagation());

            sliderRow.appendChild(sliderLabel);
            sliderRow.appendChild(rangeInput);
            sliderRow.appendChild(pctLabel);
            item.appendChild(sliderRow);

            // Toggle handler
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const nowVisible = toggle(key);
                checkbox.checked = nowVisible;
                sliderRow.style.display = nowVisible ? 'flex' : 'none';
            });

            contentDiv.appendChild(item);
        });

        groupDiv.appendChild(headerBtn);
        groupDiv.appendChild(contentDiv);
        dropdown.appendChild(groupDiv);
    }

    // ─── Initialization ──────────────────────────────────────────

    function init() {
        const waitForMap = setInterval(() => {
            if (typeof MapModule !== 'undefined' && MapModule.getMap()) {
                clearInterval(waitForMap);
                _map = MapModule.getMap();
                _buildLayersPanelSection();
                console.log('[BhuvanLayers] Module initialized — 3 satellite layers available');
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ─── Public Interface ────────────────────────────────────────

    return {
        toggle,
        setOpacity,
        isVisible,
        getOpacity,
        getLayerDefs,
        clearAll,
        init
    };
})();
