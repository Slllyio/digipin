/**
 * Main App Initialization
 */

const App = (() => {
    /** Bootstrap the whole app: handle embed mode, then initialise every module/widget in isolated steps. */
    function init() {
        // Embed mode — hide chrome
        const isEmbed = new URLSearchParams(window.location.search).has('embed');
        if (isEmbed) {
            document.getElementById('top-bar')?.classList.add('hidden');
            document.getElementById('sidebar')?.classList.add('hidden');
            document.getElementById('toolbar')?.classList.add('hidden');
        }

        // Run each step in isolation: one widget throwing must not skip the
        // rest of init (e.g. a dialog bug shouldn't block the toolbar or the
        // service-worker registration that provides offline support).
        /** Run one init step in isolation; on failure log it and toast a warning without aborting the rest of init. */
        const step = (name, fn) => {
            try { fn(); } catch (e) {
                console.error(`[init] ${name} failed:`, e);
                // Surface it (not just to the console) so a broken widget is
                // visible — the rest of init still runs, so it's a warning.
                try { showToast(`${name} unavailable`, 'This part failed to load; the rest of the app still works.', 'warning'); }
                catch { /* toast itself unavailable this early — console.error already logged it */ }
            }
        };

        // Theme first: MapModule.init reads Theme for the basemap + grid colours.
        step('Theme', () => {
            if (typeof Theme !== 'undefined') Theme.init();
            // Localize the static chrome (top-bar/toolbar/DISHA) to the saved language.
            if (typeof I18n !== 'undefined') I18n.init();
        });
        step('MapModule', () => MapModule.init());
        // Kick off precomputed-score coverage load (async, non-blocking). When
        // data/scores/coverage.json is absent it stays disabled and the app uses
        // the live path unchanged.
        step('PrecomputedScores', () => {
            if (typeof PrecomputedScores !== 'undefined') PrecomputedScores.init();
        });
        step('Panel', () => Panel.init());
        step('DISHAPanel', () => DISHAPanel.init());
        step('BuildingIntelDialog', () => BuildingIntelDialog.init());
        step('ScoresDialog', () => ScoresDialog.init());
        step('FloatingDialogs', () => FloatingDialogs.init());
        step('CitySelector', () => CitySelector.init());
        step('Bookmarks', () => Bookmarks.init());
        step('SavedViews', () => {
            if (typeof SavedViews !== 'undefined') SavedViews.init();
        });
        step('search', () => initSearch());
        step('queryPanel', () => initQueryPanel());
        step('sidebar', () => initSidebar());
        step('toolbar', () => initToolbar());
        // Deep-link state: wire the Share button + apply any ?cell/?ll/?score/?q.
        step('URLState', () => {
            if (typeof URLState !== 'undefined') URLState.init();
        });
        step('keyboardNav', () => { if (typeof KeyboardNav !== 'undefined') KeyboardNav.init(); });
        step('serviceWorker', () => registerServiceWorker());

        // Connectivity feedback: tell the user when live data pauses/resumes so a
        // wall of "unavailable" sources reads as "offline", not "broken".
        step('connectivity', () => {
            window.addEventListener('offline', () =>
                showToast('You’re offline', 'Showing cached data — live sources are paused.', 'warning'));
            window.addEventListener('online', () =>
                showToast('Back online', 'Live data sources reconnected.', 'info'));
        });

        step('welcome', () => {
            const city = CitySelector.getCurrent();
            showToast('Welcome to DigiPin Urban Intelligence', `${city.name}, ${city.state} \u2022 160+ Features \u2022 Click any grid cell`, 'info');
        });

        // Global Escape-to-close: register every dialog/panel/dropdown with
        // FloatingDialogs so one Escape press peels back the top-most open
        // surface, calling each component's own close() (keeping `.open`
        // state consistent). Priority: dropdown > dialog > side panel > detail.
        step('EscapeToClose', () => {
            if (typeof FloatingDialogs === 'undefined' || !FloatingDialogs.registerClosable) return;
            /** True if the element with the given id exists and has the `open` class. */
            const hasOpen = (id) => {
                const el = document.getElementById(id);
                return !!el && el.classList.contains('open');
            };
            /** Remove the `open` class from the element with the given id, if present. */
            const removeOpen = (id) => document.getElementById(id)?.classList.remove('open');
            /** Register a closable surface (id + close fn + priority) with FloatingDialogs for Escape-to-close. */
            const reg = (id, close, priority) =>
                FloatingDialogs.registerClosable({ isOpen: () => hasOpen(id), close, priority });

            reg('dt-layers-dropdown', () => removeOpen('dt-layers-dropdown'), 40);
            reg('heatmap-dropdown', () => removeOpen('heatmap-dropdown'), 40);
            reg('building-intel-dialog', () => BuildingIntelDialog.close(), 30);
            reg('scores-dialog', () => ScoresDialog.close(), 30);
            reg('disha-panel', () => DISHAPanel.close(), 20);
            reg('compare-panel', () => Compare.closePanel(), 20);
            reg('bookmarks-panel', () => Bookmarks.closePanel(), 20);
            reg('saved-views-panel', () => SavedViews.closePanel(), 20);
            reg('detail-panel', () => Panel.close(), 10);
            reg('results-panel', () => removeOpen('results-panel'), 10);
        });

        // First-run onboarding: a once-per-visitor card explaining the two
        // headline interactions. Self-gates on localStorage (no-op on return
        // visits), so it's safe to call unconditionally.
        step('Onboarding', () => {
            if (typeof Onboarding !== 'undefined') Onboarding.init();
        });
    }

    /** Wire up the search box: resolve DigiPin codes locally or geocode free-text via Nominatim, flying the map to the result. */
    function initSearch() {
        const searchInput = document.getElementById('search-input');
        const searchBtn = document.getElementById('search-btn');
        let searching = false;

        /** Toggle the searching state, disabling the input/button and updating the button's busy indicator. */
        const setSearching = (active) => {
            searching = active;
            searchBtn.disabled = active;
            searchInput.disabled = active;
            searchBtn.textContent = active ? '\u2026' : '\uD83D\uDD0D';
            searchBtn.setAttribute('aria-busy', String(active));
        };

        /** Run the current search: decode a DigiPin code if the query looks like one, otherwise geocode it via Nominatim. */
        const doSearch = async () => {
            const query = searchInput.value.trim();
            if (!query || searching) return;

            const cleaned = query.replace(/-/g, '').toUpperCase();
            const validChars = new Set('23456789CFJKLMPT'.split(''));
            const isDigiPin = cleaned.length >= 3 && cleaned.length <= 10 && [...cleaned].every(c => validChars.has(c));

            if (isDigiPin) {
                try {
                    const decoded = cleaned.length === 10 ? DigiPin.decode(query) : DigiPin.decodePartial(cleaned);
                    MapModule.flyTo(decoded.lat, decoded.lng, Math.min(18, 8 + cleaned.length));
                    showToast('DigiPin Found', `${DigiPin.format(cleaned)} \u2192 ${decoded.lat.toFixed(4)}\u00b0N, ${decoded.lng.toFixed(4)}\u00b0E`, 'success');
                } catch (e) {
                    showToast('Invalid DigiPin', e.message, 'error');
                }
            } else {
                setSearching(true);
                try {
                    // Cap the geocoder request \u2014 a slow/unreachable Nominatim
                    // would otherwise leave the search button spinning forever.
                    const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=1`, {
                        headers: { 'User-Agent': 'DigiPinUrbanIntelligence/1.0' },
                        signal: AbortSignal.timeout(8000)
                    });
                    const results = await resp.json();
                    if (results.length > 0) {
                        const r = results[0];
                        MapModule.flyTo(parseFloat(r.lat), parseFloat(r.lon), 15);
                        const dp = DigiPin.encode(parseFloat(r.lat), parseFloat(r.lon));
                        showToast('Location Found', `${r.display_name.split(',').slice(0, 2).join(',')} \u2022 DigiPin: ${dp}`, 'success');
                    } else {
                        showToast('Not Found', 'No results for "' + query + '"', 'error');
                    }
                } catch (e) {
                    const msg = (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
                        ? 'Search timed out \u2014 please try again.'
                        : (e && e.message) || 'Search failed.';
                    showToast('Search Error', msg, 'error');
                } finally {
                    setSearching(false);
                }
            }
        };

        searchBtn.addEventListener('click', doSearch);
        searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    }

    /**
     * Build sector-based accordion with expandable groups
     */
    function initQueryPanel() {
        const container = document.getElementById('query-list');
        if (!container) return;

        const sectors = QueryEngine.getSectors();
        const totalQueries = sectors.reduce((sum, s) => sum + s.queries.length, 0);

        // Update sidebar title with count
        const titleEl = container.parentElement?.querySelector('.sidebar-title');
        if (titleEl) titleEl.textContent = `\uD83E\uDDE0 Urban Queries (${totalQueries})`;

        sectors.forEach((sector, sIdx) => {
            const sectorDiv = document.createElement('div');
            sectorDiv.className = 'query-sector';

            // Sector header (clickable to expand/collapse)
            const headerBtn = document.createElement('button');
            headerBtn.className = 'sector-header';
            headerBtn.setAttribute('aria-expanded', sIdx === 0 ? 'true' : 'false');

            const headerLeft = document.createElement('span');
            headerLeft.className = 'sector-header-left';
            headerLeft.textContent = `${sector.icon} ${sector.name}`;

            const badge = document.createElement('span');
            badge.className = 'sector-badge';
            badge.textContent = String(sector.queries.length);

            const chevron = document.createElement('span');
            chevron.className = 'sector-chevron';
            chevron.textContent = '\u25BE';

            headerBtn.appendChild(headerLeft);
            headerBtn.appendChild(badge);
            headerBtn.appendChild(chevron);

            // Queries container
            const queriesDiv = document.createElement('div');
            queriesDiv.className = 'sector-queries';
            if (sIdx === 0) queriesDiv.classList.add('open');

            sector.queries.forEach(q => {
                const card = document.createElement('div');
                card.className = 'query-card';
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                card.setAttribute('aria-label', `Run query: ${q.name}`);

                const iconDiv = document.createElement('div');
                iconDiv.className = 'query-icon';
                iconDiv.textContent = q.icon;

                const infoDiv = document.createElement('div');
                infoDiv.className = 'query-info';
                const nameDiv = document.createElement('div');
                nameDiv.className = 'query-name';
                nameDiv.textContent = q.name;
                const descDiv = document.createElement('div');
                descDiv.className = 'query-desc';
                descDiv.textContent = q.desc;
                infoDiv.appendChild(nameDiv);
                infoDiv.appendChild(descDiv);

                card.appendChild(iconDiv);
                card.appendChild(infoDiv);

                card.addEventListener('click', () => runQueryUI(q));
                card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runQueryUI(q); } });
                queriesDiv.appendChild(card);
            });

            // Toggle expand/collapse
            headerBtn.addEventListener('click', () => {
                const isOpen = queriesDiv.classList.contains('open');
                queriesDiv.classList.toggle('open');
                headerBtn.setAttribute('aria-expanded', String(!isOpen));
                chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
            });

            // Set initial chevron for first sector
            if (sIdx === 0) chevron.style.transform = 'rotate(180deg)';

            sectorDiv.appendChild(headerBtn);
            sectorDiv.appendChild(queriesDiv);
            container.appendChild(sectorDiv);
        });
    }

    /** Run a saved urban query over the visible area, showing progress toasts and rendering ranked results. */
    async function runQueryUI(query) {
        if (QueryEngine.isQueryRunning()) {
            showToast('Query Running', 'Please wait for the current query to finish', 'warning');
            return;
        }

        const progressEl = document.getElementById('query-progress');
        const progressBar = document.getElementById('query-progress-bar');
        const progressText = document.getElementById('query-progress-text');

        progressEl.classList.add('visible');
        progressText.textContent = `Running: ${query.name}...`;

        showToast('Query Started', `${query.icon} ${query.name} \u2014 Analyzing visible area...`, 'info');

        try {
            const results = await QueryEngine.runQuery(query.id, (done, total) => {
                const pct = Math.round((done / total) * 100);
                progressBar.style.width = pct + '%';
                progressText.textContent = `${query.name}: ${done}/${total} points analyzed`;
            });

            progressEl.classList.remove('visible');

            if (results && results.length > 0) {
                showToast('Query Complete', `${query.icon} Top result: ${results[0].code} (Score: ${results[0].score.toFixed(1)})`, 'success');
                showQueryResults(query, results);
            } else {
                showToast('No Results', 'Try zooming into a city area', 'warning');
            }
        } catch (e) {
            progressEl.classList.remove('visible');
            showToast('Query Failed', e.message, 'error');
        }
    }

    /** Render the top query results into the results panel as a ranked, clickable list that flies the map to each cell. */
    function showQueryResults(query, results) {
        const panel = document.getElementById('results-panel');
        panel.classList.add('open');

        while (panel.firstChild) panel.removeChild(panel.firstChild);

        const header = document.createElement('div');
        header.className = 'results-header';
        const h3 = document.createElement('h3');
        h3.textContent = `${query.icon} ${query.name}`;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'close-btn';
        closeBtn.textContent = '\u2715';
        closeBtn.setAttribute('aria-label', 'Close results');
        closeBtn.addEventListener('click', () => { panel.classList.remove('open'); MapModule.clearHeatmap(); });
        header.appendChild(h3);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const list = document.createElement('div');
        list.className = 'results-list';
        list.setAttribute('role', 'list');

        results.slice(0, 10).forEach((r, idx) => {
            const item = document.createElement('div');
            item.className = 'result-item';
            item.setAttribute('role', 'listitem');
            item.setAttribute('tabindex', '0');
            item.addEventListener('click', () => MapModule.flyTo(r.lat, r.lng, 17));
            item.addEventListener('keydown', e => { if (e.key === 'Enter') MapModule.flyTo(r.lat, r.lng, 17); });

            const rank = document.createElement('div');
            rank.className = 'result-rank';
            rank.textContent = `#${idx + 1}`;

            const info = document.createElement('div');
            info.className = 'result-info';
            const code = document.createElement('div');
            code.className = 'result-code';
            code.textContent = r.code;
            const score = document.createElement('div');
            score.className = 'result-score';
            score.textContent = `Score: ${r.score.toFixed(1)}`;
            info.appendChild(code);
            info.appendChild(score);

            const barBg = document.createElement('div');
            barBg.className = 'result-bar-bg';
            const bar = document.createElement('div');
            bar.className = 'result-bar';
            bar.style.width = `${r.score}%`;
            barBg.appendChild(bar);

            item.appendChild(rank);
            item.appendChild(info);
            item.appendChild(barBg);
            list.appendChild(item);
        });

        panel.appendChild(list);
    }

    /** Wire the sidebar collapse/expand toggle button. */
    function initSidebar() {
        const toggleBtn = document.getElementById('sidebar-toggle');
        const sidebar = document.getElementById('sidebar');
        if (toggleBtn && sidebar) {
            toggleBtn.addEventListener('click', () => {
                sidebar.classList.toggle('collapsed');
                const collapsed = sidebar.classList.contains('collapsed');
                toggleBtn.textContent = collapsed ? '\u2192' : '\u2190';
                toggleBtn.setAttribute('aria-expanded', String(!collapsed));
            });
        }
    }


    /**
     * Toolbar — Heatmap, Wards, Compare, Bookmarks
     */
    function initToolbar() {
        // Heatmap toggle + dropdown
        const heatmapBtn = document.getElementById('btn-heatmap');
        const heatmapDrop = document.getElementById('heatmap-dropdown');
        if (heatmapBtn && heatmapDrop) {
            HeatmapOverlay.getOptions().forEach(opt => {
                const item = document.createElement('button');
                item.className = 'dropdown-item';
                item.textContent = opt.label;
                item.addEventListener('click', () => {
                    heatmapDrop.classList.remove('open');
                    if (HeatmapOverlay.getActive() === opt.key) {
                        HeatmapOverlay.clear();
                    } else {
                        HeatmapOverlay.show(opt.key, { reverse: !!opt.reverse });
                    }
                });
                heatmapDrop.appendChild(item);
            });

            heatmapBtn.addEventListener('click', () => {
                const isOpen = heatmapDrop.classList.toggle('open');
                if (isOpen) {
                    const rect = heatmapBtn.getBoundingClientRect();
                    heatmapDrop.style.top = rect.top + 'px';
                    heatmapDrop.style.right = (window.innerWidth - rect.left + 6) + 'px';
                }
            });

            // Close dropdown on outside click
            document.addEventListener('click', (e) => {
                if (!heatmapBtn.contains(e.target) && !heatmapDrop.contains(e.target)) {
                    heatmapDrop.classList.remove('open');
                }
            });
        }

        // Wards toggle
        const wardsBtn = document.getElementById('btn-wards');
        if (wardsBtn) {
            wardsBtn.addEventListener('click', () => {
                if (WardOverlay.isVisible()) {
                    WardOverlay.clear();
                    wardsBtn.classList.remove('active');
                } else {
                    WardOverlay.show();
                    wardsBtn.classList.add('active');
                }
            });
        }

        // LCZ Overlay toggle
        const lczBtn = document.getElementById('btn-lcz');
        let lczActive = false;
        if (lczBtn) {
            lczBtn.addEventListener('click', () => {
                const map = MapModule.getMap();
                lczActive = !lczActive;
                if (!lczActive) {
                    if (map.getLayer('lcz-layer')) map.setLayoutProperty('lcz-layer', 'visibility', 'none');
                    lczBtn.classList.remove('active');
                } else {
                    const url = BuildingIntelligence.getLCZURL();
                    if (url) {
                        if (!map.getSource('lcz-tms')) {
                            map.addSource('lcz-tms', {
                                type: 'raster',
                                tiles: [url],
                                tileSize: 256,
                                attribution: 'LCZ &copy; <a href="https://lcz-generator.rub.de">RUB/WUDAPT</a>'
                            });
                        }
                        // Insert layer below grid lines so we can still see the grid
                        let beforeId = map.getLayer('digipin-grid-line') ? 'digipin-grid-line' : undefined;
                        if (!map.getLayer('lcz-layer')) {
                            map.addLayer({
                                id: 'lcz-layer',
                                type: 'raster',
                                source: 'lcz-tms',
                                paint: { 'raster-opacity': 0.5 }
                            }, beforeId);
                        } else {
                            map.setLayoutProperty('lcz-layer', 'visibility', 'visible');
                        }
                        lczBtn.classList.add('active');
                    }
                }
            });
        }

        // Buildings toggle — 3D Overture footprints (streamed from the Overture
        // S3 PMTiles; no local data file, so it works on GitHub Pages). On/off.
        const buildingsBtn = document.getElementById('btn-buildings');
        if (buildingsBtn && typeof OvertureBuildings !== 'undefined') {
            buildingsBtn.addEventListener('click', () => {
                const map = MapModule.getMap();
                try {
                    OvertureBuildings.toggle(map);
                    const on = OvertureBuildings.isActive();
                    buildingsBtn.classList.toggle('active', on);
                    const label = buildingsBtn.querySelector('.tb-label');
                    if (label) label.textContent = on ? '3D' : 'Buildings';
                    showToast('Overture Buildings',
                        on ? 'Global 3D building footprints — extrusion on.' : 'Buildings hidden.',
                        'info');
                } catch (err) {
                    showToast('Buildings Error', err.message, 'error');
                }
            });
        }

        // 3D Mode toggle — pitches map and auto-enables 3D buildings
        const btn3d = document.getElementById('btn-3d');
        if (btn3d) {
            let is3d = false;
            btn3d.addEventListener('click', async () => {
                const map = MapModule.getMap();
                is3d = !is3d;
                btn3d.classList.toggle('active', is3d);
                if (is3d) {
                    map.easeTo({ pitch: 60, duration: 1000 });
                    // Auto-enable 3D buildings (Overture) if none are showing yet.
                    if (typeof OvertureBuildings !== 'undefined' && !OvertureBuildings.isActive()) {
                        try {
                            OvertureBuildings.toggle(map);
                            const bBtn = document.getElementById('btn-buildings');
                            if (bBtn) {
                                bBtn.classList.add('active');
                                const lbl = bBtn.querySelector('.tb-label');
                                if (lbl) lbl.textContent = '3D';
                            }
                        } catch { /* silent */ }
                    }
                    showToast('3D Mode', 'Map pitched to 60\u00b0. Right-click + drag to rotate.', 'success');
                } else {
                    map.easeTo({ pitch: 0, bearing: 0, duration: 1000 });
                    showToast('2D Mode', 'Returned to top-down view.', 'info');
                }
            });
        }

        // Bhuvan LULC Overlay toggle (ISRO Land Use / Land Cover via WMS)
        const lulcBtn = document.getElementById('btn-lulc');
        let lulcActive = false;
        if (lulcBtn) {
            lulcBtn.addEventListener('click', () => {
                const map = MapModule.getMap();
                lulcActive = !lulcActive;
                if (!lulcActive) {
                    if (map.getLayer('bhuvan-lulc-layer')) map.setLayoutProperty('bhuvan-lulc-layer', 'visibility', 'none');
                    lulcBtn.classList.remove('active');
                } else {
                    if (!map.getSource('bhuvan-lulc')) {
                        map.addSource('bhuvan-lulc', {
                            type: 'raster',
                            tiles: [
                                'https://bhuvan-vec2.nrsc.gov.in/bhuvan/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=lulc:lulc50k_1112&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'
                            ],
                            tileSize: 256,
                            attribution: 'LULC &copy; ISRO/NRSC Bhuvan'
                        });
                    }
                    let beforeId = map.getLayer('digipin-grid-line') ? 'digipin-grid-line' : undefined;
                    if (!map.getLayer('bhuvan-lulc-layer')) {
                        map.addLayer({
                            id: 'bhuvan-lulc-layer',
                            type: 'raster',
                            source: 'bhuvan-lulc',
                            paint: { 'raster-opacity': 0.5 }
                        }, beforeId);
                    } else {
                        map.setLayoutProperty('bhuvan-lulc-layer', 'visibility', 'visible');
                    }
                    lulcBtn.classList.add('active');
                    showToast('LULC Overlay', 'ISRO Bhuvan — Land Use/Land Cover (54 classes, 1:50K)', 'info');
                }
            });
        }

        // Roads toggle — cycles: Off → Color-coded → Minimal → Off
        const roadsBtn = document.getElementById('btn-roads');
        if (roadsBtn) {
            let roadMode = 'off'; // off | color | minimal
            roadsBtn.addEventListener('click', async () => {
                const map = MapModule.getMap();
                try {
                    if (roadMode === 'off') {
                        // Turn on color-coded roads (Overture)
                        await DigitalTwinLayers.toggle('overture_roads', map);
                        roadMode = 'color';
                        roadsBtn.classList.add('active');
                        roadsBtn.querySelector('.tb-label').textContent = 'Color';
                        showToast('Roads Overlay', 'Overture road network — color-coded by class.', 'info');
                    } else if (roadMode === 'color') {
                        // Switch to minimal (single-color) — toggle off color, toggle on OSM roads
                        await DigitalTwinLayers.toggle('overture_roads', map);
                        await DigitalTwinLayers.toggle('osm_roads', map);
                        roadMode = 'minimal';
                        roadsBtn.querySelector('.tb-label').textContent = 'Minimal';
                        showToast('Roads Overlay', 'OSM road network — minimal outline mode.', 'info');
                    } else {
                        // Turn off
                        if (DigitalTwinLayers.isVisible('osm_roads')) {
                            await DigitalTwinLayers.toggle('osm_roads', map);
                        }
                        if (DigitalTwinLayers.isVisible('overture_roads')) {
                            await DigitalTwinLayers.toggle('overture_roads', map);
                        }
                        roadMode = 'off';
                        roadsBtn.classList.remove('active');
                        roadsBtn.querySelector('.tb-label').textContent = 'Roads';
                    }
                } catch (err) {
                    showToast('Roads Error', err.message, 'error');
                }
            });
        }

        // ═══ Unified Layers Panel — ALL layers in one expandable dropdown ═══
        const dtLayersBtn = document.getElementById('btn-dt-layers');
        const dtLayersDrop = document.getElementById('dt-layers-dropdown');
        if (dtLayersBtn && dtLayersDrop) {
            const layerDefs = DigitalTwinLayers.getLayerDefs();

            // Quick overlays: toolbar-level features exposed in the layers panel
            const QUICK_OVERLAYS = [
                { key: '_wards', name: 'Ward Boundaries', icon: '\u25A6', group: 'Quick Overlays' },
                { key: '_lcz', name: 'Local Climate Zones', icon: '\uD83C\uDFD9', group: 'Quick Overlays' },
                { key: '_lulc', name: 'ISRO Bhuvan LULC', icon: '\uD83C\uDF0E', group: 'Quick Overlays' },
            ];

            // Heatmap options as individual entries in Quick Overlays
            const heatmapEntries = HeatmapOverlay.getOptions().map(opt => ({
                key: '_heat_' + opt.key, name: 'Heatmap: ' + opt.label, icon: '\u25A0', group: 'Quick Overlays', _heatKey: opt.key
            }));

            const ALL_ENTRIES = [
                ...QUICK_OVERLAYS,
                ...heatmapEntries,
                // Analytics overlays (NDVI, bivariate, viewshed, KDE, growth…)
                // folded in from their toolbar buttons — see js/layers-panel.js.
                ...((typeof LayersPanel !== 'undefined') ? LayersPanel.entries() : []),
                ...layerDefs,
            ];

            // Group entries by group name preserving insertion order
            const groupOrder = [];
            const groupMap = {};
            ALL_ENTRIES.forEach(entry => {
                if (!groupMap[entry.group]) {
                    groupMap[entry.group] = [];
                    groupOrder.push(entry.group);
                }
                groupMap[entry.group].push(entry);
            });

            // Search box — type-filter the ~30 layer rows (LayersPanel.filterMatch).
            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.className = 'dt-layer-search';
            searchInput.placeholder = 'Filter layers…';
            searchInput.setAttribute('aria-label', 'Filter layers');
            searchInput.addEventListener('click', (e) => e.stopPropagation());
            searchInput.addEventListener('input', () => {
                const q = searchInput.value;
                dtLayersDrop.querySelectorAll('.dt-layer-group').forEach(group => {
                    let anyVisible = false;
                    group.querySelectorAll('.dt-layer-item').forEach(item => {
                        const name = item.querySelector('.dt-layer-name')?.textContent || '';
                        const show = LayersPanel.filterMatch(name, q);
                        item.classList.toggle('dt-hidden', !show);
                        if (show) anyVisible = true;
                    });
                    group.classList.toggle('dt-hidden', !anyVisible);
                    // While filtering, force-open matching groups so hits are visible.
                    if (q.trim()) {
                        group.querySelector('.dt-group-content')?.classList.toggle('open', anyVisible);
                        group.querySelector('.dt-group-header-btn')?.classList.toggle('expanded', anyVisible);
                    }
                });
            });
            dtLayersDrop.setAttribute('role', 'group');
            dtLayersDrop.setAttribute('aria-label', 'Map layers');
            dtLayersDrop.appendChild(searchInput);

            // Render collapsible groups
            groupOrder.forEach((groupName, gIdx) => {
                const entries = groupMap[groupName];
                const groupDiv = document.createElement('div');
                groupDiv.className = 'dt-layer-group';

                // Collapsible group header
                const headerBtn = document.createElement('button');
                headerBtn.className = 'dt-group-header-btn';
                const titleSpan = document.createElement('span');
                titleSpan.className = 'dt-group-title';
                titleSpan.textContent = groupName;
                const countSpan = document.createElement('span');
                countSpan.className = 'dt-group-count';
                countSpan.textContent = String(entries.length);
                const chevSpan = document.createElement('span');
                chevSpan.className = 'dt-group-chevron';
                chevSpan.textContent = '\u25BE';
                headerBtn.appendChild(titleSpan);
                headerBtn.appendChild(countSpan);
                headerBtn.appendChild(chevSpan);

                const contentDiv = document.createElement('div');
                contentDiv.className = 'dt-group-content';
                // First two groups expanded by default
                if (gIdx < 2) {
                    contentDiv.classList.add('open');
                    headerBtn.classList.add('expanded');
                }
                headerBtn.setAttribute('aria-expanded', String(gIdx < 2));

                headerBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isOpen = contentDiv.classList.toggle('open');
                    headerBtn.classList.toggle('expanded', isOpen);
                    headerBtn.setAttribute('aria-expanded', String(isOpen));
                });

                // Render each layer item with toggle switch
                entries.forEach(ld => {
                    const item = document.createElement('div');
                    item.className = 'dt-layer-item';
                    item.dataset.layerKey = ld.key;
                    // Keyboard + screen-reader: each row is an operable switch
                    // (was a plain <div> with a tabindex:-1 checkbox = unreachable).
                    item.tabIndex = 0;
                    item.setAttribute('role', 'switch');
                    item.setAttribute('aria-checked', 'false');
                    item.setAttribute('aria-label', ld.name);

                    const iconEl = document.createElement('span');
                    iconEl.className = 'dt-layer-icon';
                    iconEl.textContent = ld.icon;

                    const nameEl = document.createElement('span');
                    nameEl.className = 'dt-layer-name';
                    nameEl.textContent = ld.name;

                    // Toggle switch
                    const toggleLabel = document.createElement('label');
                    toggleLabel.className = 'dt-toggle-switch';
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.tabIndex = -1;
                    checkbox.setAttribute('aria-hidden', 'true');   // the row (role=switch) is the control
                    const sliderSpan = document.createElement('span');
                    sliderSpan.className = 'dt-toggle-slider';
                    toggleLabel.appendChild(checkbox);
                    toggleLabel.appendChild(sliderSpan);

                    item.appendChild(iconEl);
                    item.appendChild(nameEl);
                    item.appendChild(toggleLabel);

                    // Click handler by layer type
                    if (ld._heatKey) {
                        // Heatmap option
                        item.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (HeatmapOverlay.getActive() === ld._heatKey) {
                                HeatmapOverlay.clear();
                                checkbox.checked = false;
                            } else {
                                HeatmapOverlay.show(ld._heatKey);
                                // Uncheck other heatmap toggles
                                dtLayersDrop.querySelectorAll('[data-layer-key^="_heat_"] input[type=checkbox]').forEach(c => { c.checked = false; });
                                checkbox.checked = true;
                            }
                        });
                    } else if (ld.key === '_wards') {
                        item.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (WardOverlay.isVisible()) {
                                WardOverlay.clear();
                                checkbox.checked = false;
                                wardsBtn?.classList.remove('active');
                            } else {
                                WardOverlay.show();
                                checkbox.checked = true;
                                wardsBtn?.classList.add('active');
                            }
                        });
                    } else if (ld.key === '_lcz') {
                        item.addEventListener('click', (e) => {
                            e.stopPropagation();
                            // Non-bubbling: keep the panel open (a bubbled
                            // synthetic click would hit the outside-click closer).
                            lczBtn?.dispatchEvent(new MouseEvent('click', { bubbles: false }));
                            setTimeout(() => { checkbox.checked = lczActive; }, 100);
                        });
                    } else if (ld.key === '_lulc') {
                        item.addEventListener('click', (e) => {
                            e.stopPropagation();
                            lulcBtn?.dispatchEvent(new MouseEvent('click', { bubbles: false }));
                            setTimeout(() => { checkbox.checked = lulcActive; }, 100);
                        });
                    } else if (ld._btnId) {
                        // Analytics overlay — drive its (hidden) toolbar button
                        // so the bespoke toggle logic + multi-state cycles are
                        // reused, never duplicated (see js/layers-panel.js).
                        item.addEventListener('click', (e) => {
                            e.stopPropagation();
                            LayersPanel.drive(ld._btnId);
                            setTimeout(() => {
                                const on = LayersPanel.isActive(ld._btnId);
                                checkbox.checked = on;
                                if (ld._stateful) {
                                    const mode = LayersPanel.stateLabel(ld._btnId);
                                    nameEl.textContent = on && mode ? `${ld.name} · ${mode}` : ld.name;
                                }
                            }, 100);
                        });
                    } else {
                        // DigitalTwinLayers toggle
                        item.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            const m = MapModule.getMap();
                            try {
                                // Mutual exclusion for buildings
                                const counterpart = ld.key === 'google_buildings' ? 'google_buildings_flat'
                                    : ld.key === 'google_buildings_flat' ? 'google_buildings' : null;
                                if (counterpart && DigitalTwinLayers.isVisible(counterpart)) {
                                    await DigitalTwinLayers.toggle(counterpart, m);
                                    const cCb = dtLayersDrop.querySelector('[data-layer-key="' + counterpart + '"] input[type=checkbox]');
                                    if (cCb) cCb.checked = false;
                                }

                                const isOn = await DigitalTwinLayers.toggle(ld.key, m);
                                checkbox.checked = isOn;
                                if (isOn) {
                                    const count = DigitalTwinLayers.getFeatureCount(ld.key);
                                    const label = count > 1 ? count.toLocaleString() + ' features' : 'Tile layer active';
                                    showToast('Layer Loaded', ld.icon + ' ' + ld.name + ' \u2014 ' + label, 'success');
                                }
                            } catch (err) {
                                checkbox.checked = false;
                                // Only a genuine 404 / "no data source" means the
                                // layer simply isn't deployed (most OSM vector
                                // layers are pipeline-generated per city) — present
                                // that as a calm "not available" note. _loadGeoJSON
                                // throws "Failed to load <name>: <status>" for ANY
                                // non-OK status, so match the 404 specifically and
                                // surface 5xx/403/429 etc. as real errors.
                                const msg = String((err && err.message) || err || '');
                                const missing = /\b404\b|No data source|Not Found/i.test(msg);
                                if (missing) {
                                    showToast('Layer not available', ld.name + ' isn’t available in this deployment yet.', 'info');
                                } else {
                                    showToast('Layer Unavailable', ld.name + ': ' + msg, 'error');
                                }
                            }
                        });
                    }

                    // Enter/Space activate the row (it owns its click handler
                    // above); mirror the resulting state to aria-checked after the
                    // handler's own (≤100ms) state update settles.
                    item.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
                    });
                    item.addEventListener('click', () => {
                        setTimeout(() => item.setAttribute('aria-checked', String(checkbox.checked)), 160);
                    });

                    contentDiv.appendChild(item);
                });

                groupDiv.appendChild(headerBtn);
                groupDiv.appendChild(contentDiv);
                dtLayersDrop.appendChild(groupDiv);
            });

            // Proactively dim Digital-Twin layers whose data file isn't deployed
            // (most OSM vector layers are generated per-city by the pipeline and
            // aren't shipped to Pages), so users see "no data" rather than clicking
            // a dead row. PMTiles/WMS layers always report available. One-shot,
            // fire-and-forget HEAD probes run once at startup.
            if (typeof DigitalTwinLayers.checkAvailability === 'function') {
                layerDefs.forEach(ld => {
                    DigitalTwinLayers.checkAvailability(ld.key).then(ok => {
                        if (ok) return;
                        const item = dtLayersDrop.querySelector('.dt-layer-item[data-layer-key="' + ld.key + '"]');
                        if (!item) return;
                        item.classList.add('dt-unavailable');
                        item.title = 'Not available in this deployment';
                        const nm = item.querySelector('.dt-layer-name');
                        if (nm && !/· no data$/.test(nm.textContent)) nm.textContent += ' · no data';
                    }).catch(() => { /* probe is best-effort */ });
                });
            }

            dtLayersBtn.setAttribute('aria-haspopup', 'true');
            dtLayersBtn.setAttribute('aria-expanded', 'false');
            dtLayersBtn.addEventListener('click', () => {
                const isOpen = dtLayersDrop.classList.toggle('open');
                dtLayersBtn.setAttribute('aria-expanded', String(isOpen));
                if (isOpen) {
                    const rect = dtLayersBtn.getBoundingClientRect();
                    dtLayersDrop.style.left = 'auto';
                    dtLayersDrop.style.top = rect.top + 'px';
                    dtLayersDrop.style.right = (window.innerWidth - rect.left + 6) + 'px';
                    // Clamp within the viewport (phones: the toolbar wraps and the
                    // right-anchored menu can spill off the top/left edge).
                    requestAnimationFrame(() => {
                        const dropRect = dtLayersDrop.getBoundingClientRect();
                        if (dropRect.bottom > window.innerHeight - 8) {
                            dtLayersDrop.style.top = Math.max(8, window.innerHeight - dropRect.height - 8) + 'px';
                        }
                        if (dropRect.left < 8) {
                            dtLayersDrop.style.right = 'auto';
                            dtLayersDrop.style.left = '8px';
                        }
                    });
                }
            });

            document.addEventListener('click', (e) => {
                if (!dtLayersBtn.contains(e.target) && !dtLayersDrop.contains(e.target)) {
                    dtLayersDrop.classList.remove('open');
                }
            });
        }

        // Compare
        const compareBtn = document.getElementById('btn-compare');
        if (compareBtn) {
            compareBtn.addEventListener('click', () => Compare.openPanel());
        }

        // Bookmarks
        const bmBtn = document.getElementById('btn-bookmarks');
        if (bmBtn) {
            bmBtn.addEventListener('click', () => Bookmarks.openPanel());
        }

        // Saved Views & templates
        const svBtn = document.getElementById('btn-saved-views');
        if (svBtn) {
            svBtn.addEventListener('click', () => SavedViews.openPanel());
        }
    }

    /** Register the service worker for offline support and prompt to refresh when an update is installed. */
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js').then(reg => {
            // When a new SW is found and finishes installing while an old one is
            // still controlling the page, the fresh app shell is cached but not
            // yet live — nudge the user to refresh rather than serve stale code.
            reg.addEventListener('updatefound', () => {
                const sw = reg.installing;
                if (!sw) return;
                sw.addEventListener('statechange', () => {
                    if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                        showToast('Update ready', 'Refresh to load the latest DigiPin', 'info');
                    }
                });
            });
        }).catch(() => { /* SW unsupported or registration blocked — app still works online */ });
    }

    /** Show a transient toast notification (title + message) that auto-dismisses after a few seconds. */
    function showToast(title, message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', 'alert');

        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = title;

        const msgEl = document.createElement('div');
        msgEl.className = 'toast-msg';
        msgEl.textContent = message;

        toast.appendChild(titleEl);
        toast.appendChild(msgEl);
        container.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    return { init, showToast };
})();

// Boot
document.addEventListener('DOMContentLoaded', App.init);
