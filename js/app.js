/**
 * Main App Initialization
 */

const App = (() => {
    function init() {
        // Embed mode — hide chrome
        const isEmbed = new URLSearchParams(window.location.search).has('embed');
        if (isEmbed) {
            document.getElementById('top-bar')?.classList.add('hidden');
            document.getElementById('sidebar')?.classList.add('hidden');
            document.getElementById('toolbar')?.classList.add('hidden');
        }

        MapModule.init();
        Panel.init();
        DISHAPanel.init();
        BuildingIntelDialog.init();
        ScoresDialog.init();
        FloatingDialogs.init();
        CitySelector.init();
        Bookmarks.init();
        initSearch();
        initQueryPanel();
        initSidebar();
        initToolbar();
        registerServiceWorker();

        const city = CitySelector.getCurrent();
        showToast('Welcome to DigiPin Urban Intelligence', `${city.name}, ${city.state} \u2022 160+ Features \u2022 Click any grid cell`, 'info');
    }

    function initSearch() {
        const searchInput = document.getElementById('search-input');
        const searchBtn = document.getElementById('search-btn');
        let searching = false;

        const setSearching = (active) => {
            searching = active;
            searchBtn.disabled = active;
            searchInput.disabled = active;
            searchBtn.textContent = active ? '\u2026' : '\uD83D\uDD0D';
            searchBtn.setAttribute('aria-busy', String(active));
        };

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
                    const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=1`, {
                        headers: { 'User-Agent': 'DigiPinUrbanIntelligence/1.0' }
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
                    showToast('Search Error', e.message, 'error');
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
                        HeatmapOverlay.show(opt.key);
                    }
                });
                heatmapDrop.appendChild(item);
            });

            heatmapBtn.addEventListener('click', () => {
                heatmapDrop.classList.toggle('open');
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
        let lczLayer = null;
        if (lczBtn) {
            lczBtn.addEventListener('click', () => {
                const map = MapModule.getMap();
                if (lczLayer) {
                    map.removeLayer(lczLayer);
                    lczLayer = null;
                    lczBtn.classList.remove('active');
                } else {
                    lczLayer = BuildingIntelligence.getLCZTileLayer();
                    if (lczLayer) {
                        lczLayer.addTo(map);
                        lczBtn.classList.add('active');
                    }
                }
            });
        }

        // Overture Buildings toggle
        const buildingsBtn = document.getElementById('btn-buildings');
        if (buildingsBtn) {
            buildingsBtn.addEventListener('click', () => {
                const map = MapModule.getMap();
                const isOn = OvertureBuildings.toggle(map);
                buildingsBtn.classList.toggle('active', isOn);
                if (isOn) {
                    showToast('Buildings Overlay', 'Overture Maps — 2.3B footprints. Zoom to 13+ to see buildings.', 'info');
                }
            });
        }

        // Bhuvan LULC Overlay toggle (ISRO Land Use / Land Cover via WMS — no auth needed)
        const lulcBtn = document.getElementById('btn-lulc');
        let lulcLayer = null;
        if (lulcBtn) {
            lulcBtn.addEventListener('click', () => {
                const map = MapModule.getMap();
                if (lulcLayer) {
                    map.removeLayer(lulcLayer);
                    lulcLayer = null;
                    lulcBtn.classList.remove('active');
                } else {
                    // Bhuvan GeoServer WMS — LULC 50K (2011-12 cycle)
                    // Loaded as <img> tiles, bypassing CORS
                    lulcLayer = L.tileLayer.wms('https://bhuvan-vec2.nrsc.gov.in/bhuvan/wms', {
                        layers: 'lulc:lulc50k_1112',
                        format: 'image/png',
                        transparent: true,
                        opacity: 0.5,
                        attribution: 'LULC &copy; ISRO/NRSC Bhuvan'
                    });
                    lulcLayer.addTo(map);
                    lulcBtn.classList.add('active');
                    showToast('LULC Overlay', 'ISRO Bhuvan — Land Use/Land Cover (54 classes, 1:50K)', 'info');
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
    }

    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js').catch(() => {});
        }
    }

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
