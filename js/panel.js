/**
 * Detail Panel — Floating draggable/resizable dialog showing 160+ features for selected DigiPin
 */

const Panel = (() => {
    let panelEl, contentEl, titleEl, currentCell, currentData;
    let _featureMarkers = null; // Leaflet layer group for feature location markers

    /** Escape HTML to prevent XSS from external API data */
    function esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function init() {
        panelEl = document.getElementById('detail-panel');
        contentEl = document.getElementById('panel-content');
        titleEl = document.getElementById('panel-title-text');
    }

    function show(cell) {
        currentCell = cell;
        titleEl.textContent = cell.code;
        panelEl.classList.add('open');
        if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(panelEl);
        contentEl.innerHTML = buildLoadingHTML(cell);
    }

    function update(cell, data) {
        if (cell.code !== currentCell?.code) return;
        contentEl.innerHTML = buildFullHTML(cell, data);
        currentData = data;

        const dishaBtn = document.getElementById('ask-disha-btn');
        if (dishaBtn) {
            dishaBtn.addEventListener('click', () => {
                if (currentCell && currentData) DISHAPanel.open(currentCell, currentData);
            });
        }

        const biBtn = document.getElementById('open-building-intel-btn');
        if (biBtn) {
            biBtn.addEventListener('click', () => {
                if (currentData && currentData.buildingIntel) {
                    BuildingIntelDialog.open(currentData.buildingIntel, currentCell);
                }
            });
        }

        const scoresBtn = document.getElementById('open-scores-btn');
        if (scoresBtn) {
            scoresBtn.addEventListener('click', () => {
                if (currentData && currentData.scores) {
                    ScoresDialog.open(currentData.scores, currentCell);
                }
            });
        }

        // Action buttons
        const pinBtn = document.getElementById('btn-pin-compare');
        if (pinBtn) pinBtn.addEventListener('click', () => { if (currentCell && currentData) Compare.pin(currentCell, currentData); });

        const bmBtn = document.getElementById('btn-bookmark-cell');
        if (bmBtn) bmBtn.addEventListener('click', () => { if (currentCell) Bookmarks.add(currentCell); });

        const isoBtn = document.getElementById('btn-isochrone');
        if (isoBtn) isoBtn.addEventListener('click', () => { if (currentCell) Isochrone.show(currentCell.center.lat, currentCell.center.lng); });

        const reportBtn = document.getElementById('btn-report');
        if (reportBtn) reportBtn.addEventListener('click', () => { if (currentCell && currentData) Report.generate(currentCell, currentData); });

        // Expandable feature cards — click to show/hide full names list + map markers
        document.querySelectorAll('.feature-card.expandable').forEach(card => {
            card.addEventListener('click', () => {
                // Collapse any other expanded card first
                const prev = document.querySelector('.feature-card.expanded');
                if (prev && prev !== card) {
                    prev.classList.remove('expanded');
                    const pPreview = prev.querySelector('.feature-names-preview');
                    const pFull = prev.querySelector('.feature-names-full');
                    if (pPreview) pPreview.style.display = '';
                    if (pFull) pFull.style.display = 'none';
                }
                clearFeatureMarkers();

                const preview = card.querySelector('.feature-names-preview');
                const full = card.querySelector('.feature-names-full');
                const isExpanded = card.classList.toggle('expanded');
                if (preview) preview.style.display = isExpanded ? 'none' : '';
                if (full) full.style.display = isExpanded ? 'block' : 'none';

                // Show markers on map
                if (isExpanded) showFeatureOnMap(card);
            });
        });
    }

    function showError(cell, msg) {
        contentEl.innerHTML = `
            <div class="panel-header">
                <div class="digipin-code">${esc(cell.code)}</div>
            </div>
            <div class="error-msg">
                <span class="error-icon">&#9888;&#65039;</span>
                <p>Failed to load data</p>
                <small>${esc(msg)}</small>
            </div>`;
    }

    function close() {
        panelEl.classList.remove('open');
        currentCell = null;
        clearFeatureMarkers();
    }

    function buildLoadingHTML(cell) {
        return `
            <div class="panel-header">
                <div class="digipin-code-section">
                    <div class="digipin-code">${esc(cell.code)}</div>
                    <button class="copy-btn" onclick="Panel.copyCode('${esc(cell.code)}')">&#128203;</button>
                </div>
                <div class="coords">${cell.center.lat.toFixed(6)}&deg;N, ${cell.center.lng.toFixed(6)}&deg;E</div>
            </div>
            <div class="loading-section">
                <div class="spinner"></div>
                <p>Fetching 160+ urban features...</p>
                <div class="loading-categories">
                    ${Object.values(DataFetcher.CATEGORIES).map(c =>
            `<div class="loading-cat">${esc(c.icon)} ${esc(c.name)}</div>`
        ).join('')}
                </div>
            </div>`;
    }

    function buildFullHTML(cell, data) {
        const addr = data.address || {};
        const env = data.environment || {};
        const scores = data.scores || {};
        const code = esc(cell.code);

        let html = `
            <div class="panel-header">
                <div class="digipin-code-section">
                    <div class="digipin-code">${code}</div>
                    <button class="copy-btn" onclick="Panel.copyCode('${code}')" title="Copy DigiPin">&#128203;</button>
                    <button class="export-btn" id="export-json-btn" title="Export to JSON">JSON</button>
                    <button class="export-btn" id="export-csv-btn" title="Export to CSV">CSV</button>
                </div>
                <div class="panel-actions">
                    <button class="action-btn" id="btn-pin-compare" title="Pin for Compare">&#128204; Pin</button>
                    <button class="action-btn" id="btn-bookmark-cell" title="Bookmark this cell">&#9733; Save</button>
                    <button class="action-btn" id="btn-isochrone" title="Walking zones">&#128694; Walk</button>
                    <button class="action-btn" id="btn-report" title="Generate PDF Report">&#128196; Report</button>
                </div>
                <div class="coords">${cell.center.lat.toFixed(6)}&deg;N, ${cell.center.lng.toFixed(6)}&deg;E</div>
                ${addr.fullAddress ? `<div class="address">${esc(addr.area || addr.city)}, ${esc(addr.district)}, ${esc(addr.state)} ${addr.pincode ? '- ' + esc(addr.pincode) : ''}</div>` : ''}
            </div>`;

        // Environment card — numeric values are safe, but weatherDesc comes from our lookup so esc() for defense-in-depth
        html += `<div class="env-card">
            <div class="env-items">
                ${env.temperature != null ? `<div class="env-item"><span class="env-val">${esc(env.temperature)}&deg;C</span><span class="env-label">Temp</span></div>` : ''}
                ${env.humidity != null ? `<div class="env-item"><span class="env-val">${esc(env.humidity)}%</span><span class="env-label">Humidity</span></div>` : ''}
                ${env.windSpeed != null ? `<div class="env-item"><span class="env-val">${esc(env.windSpeed)}</span><span class="env-label">Wind km/h</span></div>` : ''}
                ${env.aqi != null ? `<div class="env-item ${getAQIClass(env.aqi)}"><span class="env-val">${esc(env.aqi)}</span><span class="env-label">AQI${env.aqiSource ? ' (' + esc(env.aqiSource) + ')' : ''}</span></div>` : ''}
                ${env.uvIndex != null ? `<div class="env-item"><span class="env-val">${esc(env.uvIndex)}</span><span class="env-label">UV Index</span></div>` : ''}
                ${env.weatherDesc ? `<div class="env-item"><span class="env-val">${esc(env.weatherDesc)}</span><span class="env-label">Weather</span></div>` : ''}
            </div>
        </div>`;

        // Detailed Air Quality breakdown (pollutants)
        if (env.pm25 != null || env.pm10 != null || env.no2 != null) {
            html += `<div class="data-card">
                <div class="data-card-title">&#128168; Air Quality Details</div>
                <div class="env-items">
                    ${env.pm25 != null ? `<div class="env-item"><span class="env-val">${esc(Math.round(env.pm25 * 10) / 10)}</span><span class="env-label">PM2.5 &#181;g/m&#179;</span></div>` : ''}
                    ${env.pm10 != null ? `<div class="env-item"><span class="env-val">${esc(Math.round(env.pm10 * 10) / 10)}</span><span class="env-label">PM10 &#181;g/m&#179;</span></div>` : ''}
                    ${env.no2 != null ? `<div class="env-item"><span class="env-val">${esc(Math.round(env.no2 * 10) / 10)}</span><span class="env-label">NO&#8322;</span></div>` : ''}
                    ${env.so2 != null ? `<div class="env-item"><span class="env-val">${esc(Math.round(env.so2 * 10) / 10)}</span><span class="env-label">SO&#8322;</span></div>` : ''}
                    ${env.o3 != null ? `<div class="env-item"><span class="env-val">${esc(Math.round(env.o3 * 10) / 10)}</span><span class="env-label">O&#8323;</span></div>` : ''}
                    ${env.co != null ? `<div class="env-item"><span class="env-val">${esc(Math.round(env.co))}</span><span class="env-label">CO &#181;g/m&#179;</span></div>` : ''}
                </div>
            </div>`;
        }

        // Solar Radiation card
        const solar = env.solar;
        if (solar) {
            html += `<div class="data-card">
                <div class="data-card-title">&#9728;&#65039; Solar Potential <span class="data-badge ${solar.solarPotential === 'Excellent' ? 'badge-green' : solar.solarPotential === 'Good' ? 'badge-cyan' : 'badge-dim'}">${esc(solar.solarPotential)}</span></div>
                <div class="env-items">
                    ${solar.ghiDaily != null ? `<div class="env-item"><span class="env-val">${esc(solar.ghiDaily)}</span><span class="env-label">kWh/m²/day</span></div>` : ''}
                    ${solar.ghiMJ != null ? `<div class="env-item"><span class="env-val">${esc(solar.ghiMJ)}</span><span class="env-label">MJ/m²/day</span></div>` : ''}
                    ${solar.sunshineDuration != null ? `<div class="env-item"><span class="env-val">${esc(solar.sunshineDuration)}h</span><span class="env-label">Sunshine</span></div>` : ''}
                </div>
            </div>`;
        }

        // Bhoonidhi Satellite Data
        const satellite = data.context?.satellite;
        if (satellite) {
            html += `<div class="data-card">
                <div class="data-card-title">&#128752; ISRO Satellite Data <span class="data-badge badge-cyan">${esc(satellite.totalImages)} images</span></div>
                ${satellite.recentImages?.length > 0 ? `<div class="satellite-list">${satellite.recentImages.map(img =>
                    `<div class="satellite-item"><span class="sat-name">${esc(img.satellite)}</span><span class="sat-date">${esc(img.date)}</span>${img.cloudCover !== 'N/A' ? `<span class="sat-cloud">&#9729; ${esc(img.cloudCover)}%</span>` : ''}</div>`
                ).join('')}</div>` : '<div class="data-muted">No recent imagery found</div>'}
            </div>`;
        }

        // OGD Health Facilities
        const health = data.context?.healthFacilities;
        if (health && health.nearbyFacilities?.length > 0) {
            html += `<div class="data-card">
                <div class="data-card-title">&#127973; Govt Health Facilities <span class="data-badge badge-dim">${esc(health.totalInState)} in state</span></div>
                <div class="health-list">${health.nearbyFacilities.map(f =>
                    `<div class="health-item"><span class="health-name">${esc(f.name)}</span>${f.type ? `<span class="health-type">${esc(f.type)}</span>` : ''}${f.beds !== 'N/A' ? `<span class="health-beds">${esc(f.beds)} beds</span>` : ''}</div>`
                ).join('')}</div>
            </div>`;
        }

        // IUDX Smart City Data
        const iudx = data.context?.iudx;
        if (iudx) {
            html += `<div class="data-card">
                <div class="data-card-title">&#128300; Smart City (IUDX) <span class="data-badge badge-cyan">${esc(iudx.totalNearby)} nearest</span></div>
                <div class="iudx-list">`;
            for (const [, cat] of Object.entries(iudx.nearby)) {
                if (cat.items.length === 0) continue;
                html += `<div class="iudx-category"><span class="iudx-cat-label">${esc(cat.icon)} ${esc(cat.label)} <span class="data-badge badge-dim">${esc(cat.total)} total</span></span>`;
                cat.items.forEach(item => {
                    html += `<div class="health-item"><span class="health-name">${esc(item.name)}</span><span class="health-type">${esc(item.distance)}</span></div>`;
                });
                html += `</div>`;
            }
            html += `</div></div>`;
        }

        // Wikipedia Context — title and summary from external API, MUST escape
        const wiki = data.context?.wikipedia;
        if (wiki) {
            // wiki.url is constructed by us from a pageId, but sanitize href anyway
            const safeUrl = esc(wiki.url);
            html += `<div class="context-card">
                <div class="context-title">&#128218; Historical Context: <a href="${safeUrl}" target="_blank" rel="noopener">${esc(wiki.title)}</a> <span class="context-dist">(${(wiki.distanceToCenter / 1000).toFixed(1)}km away)</span></div>
                <div class="context-summary">${esc(wiki.summary)}</div>
            </div>`;
        }

        // Building Intelligence — opens as independent floating dialog
        if (data.buildingIntel) {
            html += `<button class="open-dialog-btn" id="open-building-intel-btn">
                <span class="dialog-btn-icon">&#127959;&#65039;</span> Building Intelligence
                <span class="dialog-btn-arrow">&#8599;</span>
            </button>`;
        }

        // Ask DISHA — opens as independent floating dialog
        html += `<button class="open-dialog-btn disha-variant" id="ask-disha-btn">
            <span class="disha-logo">D</span> Ask DISHA &mdash; AI Analysis
            <span class="dialog-btn-arrow">&#8599;</span>
        </button>`;

        // Intelligence Scores — opens as independent floating dialog
        if (Object.keys(scores).length > 0) {
            html += `<button class="open-dialog-btn scores-variant" id="open-scores-btn">
                <span class="dialog-btn-icon">&#129504;</span> Intelligence Scores
                <span class="dialog-btn-arrow">&#8599;</span>
            </button>`;
        }

        // Category tabs
        html += `<div class="category-tabs" id="cat-tabs" role="tablist" aria-label="Feature categories">`;
        Object.entries(data.categories || {}).forEach(([key, cat], idx) => {
            const total = Object.values(cat.features || {}).reduce((s, f) => s + (f.count || 0), 0);
            html += `<button class="cat-tab ${idx === 0 ? 'active' : ''}" onclick="Panel.switchTab('${esc(key)}')" data-cat="${esc(key)}" role="tab" aria-selected="${idx === 0}">
                ${esc(cat.icon)} <span class="cat-count">${total}</span>
            </button>`;
        });
        html += `</div>`;

        // Category content
        html += `<div class="categories-content" id="cat-content">`;
        Object.entries(data.categories || {}).forEach(([key, cat], idx) => {
            html += `<div class="cat-section ${idx === 0 ? 'active' : ''}" data-cat="${esc(key)}" role="tabpanel">
                <h3>${esc(cat.icon)} ${esc(cat.name)}</h3>
                <div class="features-grid">`;
            Object.entries(cat.features || {}).forEach(([fKey, f]) => {
                const hasNames = f.names && f.names.length > 0;
                const hasItems = f.items && f.items.length > 0;
                const isExpandable = hasNames || hasItems;
                const itemsJson = hasItems ? esc(JSON.stringify(f.items)) : '';
                html += `<div class="feature-card ${f.count > 0 ? 'has-data' : ''} ${isExpandable ? 'expandable' : ''}" ${isExpandable ? `data-feature="${esc(key)}-${esc(fKey)}"` : ''} ${hasItems ? `data-items="${itemsJson}"` : ''}>
                    <div class="feature-count">${f.count}</div>
                    <div class="feature-label">${esc(f.label)}</div>
                    ${hasNames ? `<div class="feature-names-preview">${f.names.slice(0, 3).map(n => esc(n)).join(', ')}${f.names.length > 3 ? ` <span class="more-count">+${f.names.length - 3}</span>` : ''}</div>` : ''}
                    ${hasNames ? `<div class="feature-names-full" style="display:none"><ol class="names-list">${f.names.map(n => `<li>${esc(n)}</li>`).join('')}</ol></div>` : ''}
                </div>`;
            });
            html += `</div></div>`;
        });
        html += `</div>`;

        // Attach event listeners for export buttons after DOM insertion
        setTimeout(() => {
            const btnJson = document.getElementById('export-json-btn');
            const btnCsv = document.getElementById('export-csv-btn');
            if (btnJson) btnJson.onclick = () => DataFetcher.exportToJSON(data, `digipin_${cell.code}.json`);
            if (btnCsv) btnCsv.onclick = () => DataFetcher.exportToCSV(data, `digipin_${cell.code}_features.csv`);
        }, 50);

        return html;
    }

    function switchTab(catKey) {
        clearFeatureMarkers();
        document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.cat-tab[data-cat="${catKey}"]`)?.classList.add('active');
        document.querySelectorAll('.cat-section').forEach(s => s.classList.remove('active'));
        document.querySelector(`.cat-section[data-cat="${catKey}"]`)?.classList.add('active');
    }

    function showFeatureOnMap(card) {
        const itemsStr = card.getAttribute('data-items');
        if (!itemsStr) return;
        try {
            const items = JSON.parse(itemsStr);
            if (!items.length) return;
            const map = MapModule.getMap();
            _featureMarkers = L.layerGroup().addTo(map);
            const label = card.querySelector('.feature-label')?.textContent || '';
            items.forEach((item, i) => {
                if (!item.lat || !item.lng) return;
                const marker = L.marker([item.lat, item.lng], {
                    icon: L.divIcon({
                        className: 'feature-map-marker',
                        html: `<div class="fmm-dot">${i + 1}</div>`,
                        iconSize: [24, 24],
                        iconAnchor: [12, 12]
                    })
                });
                marker.bindPopup(
                    `<div style="font-family:Inter,sans-serif;font-size:12px"><strong>${esc(item.name || 'Unnamed')}</strong><br><span style="color:#94a3b8;font-size:10px">${esc(label)}</span></div>`,
                    { className: 'feature-marker-popup' }
                );
                _featureMarkers.addLayer(marker);
            });
            // Fit map to show all markers + current cell
            if (items.length > 0) {
                const bounds = _featureMarkers.getBounds();
                if (bounds.isValid()) map.fitBounds(bounds.pad(0.3));
            }
        } catch (e) { /* invalid JSON — skip */ }
    }

    function clearFeatureMarkers() {
        if (_featureMarkers) {
            _featureMarkers.clearLayers();
            MapModule.getMap().removeLayer(_featureMarkers);
            _featureMarkers = null;
        }
    }

    function getAQIClass(aqi) {
        if (aqi <= 50) return 'aqi-good';
        if (aqi <= 100) return 'aqi-moderate';
        if (aqi <= 150) return 'aqi-unhealthy-sg';
        if (aqi <= 200) return 'aqi-unhealthy';
        return 'aqi-hazardous';
    }

    function copyCode(code) {
        navigator.clipboard.writeText(code).then(() => {
            const btn = document.querySelector('.copy-btn');
            if (btn) { btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋', 1500); }
        });
    }

    return { init, show, update, showError, close, switchTab, copyCode };
})();
