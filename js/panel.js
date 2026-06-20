/**
 * Detail Panel — Floating draggable/resizable dialog showing 160+ features for selected DigiPin
 */

const Panel = (() => {
    let panelEl, contentEl, titleEl, currentCell, currentData;
    let _featureMarkers = []; // Array of maplibregl.Marker
    let _restoreFocus = null; // element to return focus to when the panel closes

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

    // Honest data coverage: show which sources loaded vs failed, so a missing
    // card reads as "AQI unavailable" rather than a silent gap. Driven by
    // result.sourceStatus from DataFetcher.fetchAllFeatures.
    const _SOURCE_LABELS = {
        osm: 'OSM', weather: 'Weather', aqi: 'Air Quality', elevation: 'Elevation',
        population: 'Population', wikipedia: 'Wikipedia', solar: 'Solar',
        health: 'Health', iudx: 'IUDX', evCharging: 'EV', utilities: 'Utilities',
    };

    // Live hazards layer (NDMA SACHET alerts, IMD warnings, nearby earthquakes,
    // GloFAS flood forecast). All four were fetched per click but never shown;
    // this consolidates them into one strip of severity-coloured chips, with a
    // freshness label on the snapshot-backed alert feed.
    const _HAZ_CLASS = { red: 'haz-red', orange: 'haz-orange', yellow: 'haz-yellow', green: 'haz-green' };

    /** Render one severity-coloured hazard chip (icon + text). */
    function _hazChip(color, icon, text) {
        return `<span class="haz-chip ${_HAZ_CLASS[color] || 'haz-yellow'}">${icon} ${text}</span>`;
    }

    /** Build the live-hazards strip (SACHET alerts, IMD warnings, quakes, flood) from realtime data; returns '' when none. */
    function buildHazardsHTML(data) {
        const rt = (data && data.realtime) || {};
        const chips = [];

        const s = rt.sachet;
        if (s && s.alerts && s.alerts.length) {
            const total = (s.summary && s.summary.total) || s.alerts.length;
            const severe = s.severeCount > 0;
            let fresh = '';
            if (typeof RealtimeAlerts !== 'undefined' && RealtimeAlerts.staleness) {
                const f = RealtimeAlerts.staleness(s.generatedAt);
                if (f) fresh = ` &middot; ${esc(f.label)}${f.stale ? ' (stale)' : ''}`;
            }
            chips.push(_hazChip(severe ? 'red' : 'yellow', '&#9888;&#65039;',
                `${severe ? esc(s.severeCount) + ' severe / ' : ''}${esc(total)} alert${total === 1 ? '' : 's'}${fresh}`));
        }

        const imd = rt.imd;
        if (imd && imd.warnings && imd.warnings.length) {
            chips.push(_hazChip(imd.worstColor || 'yellow', '&#127783;&#65039;',
                `IMD ${esc(imd.worstColor || '')} &middot; ${esc(imd.warnings.length)} warning${imd.warnings.length === 1 ? '' : 's'}`));
        }

        const q = rt.quakes;
        if (q && q.count_within_200km > 0 && q.largest_nearby) {
            const m = q.largest_nearby.magnitude;
            const d = Math.round(q.largest_nearby.distance_km || 0);
            chips.push(_hazChip(m >= 5 ? 'orange' : 'green', '&#127757;',
                `M${esc(m)} quake &middot; ${esc(d)} km`));
        }

        const fl = rt.flood;
        const lvl = fl && fl.overall_risk && fl.overall_risk.level;
        if (lvl && !/^(low|normal|none)$/i.test(lvl)) {
            chips.push(_hazChip((fl.overall_risk.color) || 'orange', '&#127754;', `Flood: ${esc(lvl)}`));
        }

        if (chips.length === 0) return '';
        return `<div class="hazard-strip">
            <div class="hazard-head">Live hazards</div>
            <div class="hazard-chips">${chips.join('')}</div>
        </div>`;
    }

    /** Build the data-coverage strip showing which data sources loaded vs. failed; returns '' when no status present. */
    function buildSourceStatusHTML(data) {
        const st = data && data.sourceStatus;
        if (!st) return '';
        const entries = Object.entries(_SOURCE_LABELS).filter(([k]) => k in st);
        if (entries.length === 0) return '';
        const okCount = entries.filter(([k]) => st[k] === 'ok').length;
        // Every source failed — collapse the wall of "off" chips into one honest
        // banner instead (usually means offline or a network outage).
        if (okCount === 0) {
            return `<div class="source-status source-offline" role="status">
                <span class="src-chip src-off">&#9888;&#65039; No live sources reached</span>
                <span class="source-status-note">You may be offline — showing cached or limited data.</span>
            </div>`;
        }
        const chips = entries.map(([k, label]) => {
            const ok = st[k] === 'ok';
            return `<span class="src-chip ${ok ? 'src-ok' : 'src-off'}" title="${esc(label)}: ${ok ? 'loaded' : 'unavailable'}">${esc(label)}</span>`;
        }).join('');
        return `<div class="source-status">
            <div class="source-status-head">Data coverage <span class="data-badge badge-dim">${okCount}/${entries.length} sources</span></div>
            <div class="source-chips">${chips}</div>
        </div>`;
    }

    /** Cache references to the panel's DOM elements. Call once after the DOM is ready. */
    function init() {
        panelEl = document.getElementById('detail-panel');
        contentEl = document.getElementById('panel-content');
        titleEl = document.getElementById('panel-title-text');
    }

    /** Open the panel for a cell, show its loading state, and move focus into it. */
    function show(cell) {
        currentCell = cell;
        titleEl.textContent = cell.code;
        // Remember where focus was (the map/skip-link/etc.) so close() can
        // return it — and move focus into the panel so keyboard & screen-reader
        // users land on the new content (preventScroll avoids a visual jump;
        // programmatic focus doesn't trigger a :focus-visible ring for mouse users).
        const active = (typeof document !== 'undefined') ? document.activeElement : null;
        if (active instanceof HTMLElement && active !== panelEl) _restoreFocus = active;
        panelEl.classList.add('open');
        if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(panelEl);
        contentEl.innerHTML = buildLoadingHTML(cell);
        if (!panelEl.hasAttribute('tabindex')) panelEl.setAttribute('tabindex', '-1');
        try { panelEl.focus({ preventScroll: true }); } catch { /* older browsers */ }
    }

    /** Replace loading state with full feature content for the cell, then attach all sub-widgets and button handlers. Ignored if the cell is no longer current. */
    function update(cell, data) {
        if (cell.code !== currentCell?.code) return;
        // Drop any inundation overlay from a previous render before rebuilding;
        // the widget re-attaches on demand via its "Show inundation" button.
        if (typeof FloodInundation !== 'undefined') FloodInundation.detach();
        contentEl.innerHTML = buildFullHTML(cell, data);
        currentData = data;

        // Answer-first Property Intelligence card (verdict + intent toggle).
        // It folds in the Growth Forecast as its "Trajectory" sub-section, so the
        // standalone growth widget is no longer attached separately. It inserts
        // itself just below the header (top of the scroll).
        if (typeof RealEstateWidget !== 'undefined') {
            RealEstateWidget.attachTo(contentEl, data, cell);
        }

        if (typeof HeatWidget !== 'undefined') {
            HeatWidget.attachTo(contentEl, data?.realtime?.heat || null, cell);
        }

        if (typeof TrafficWidget !== 'undefined') {
            TrafficWidget.attachTo(contentEl, data?.realtime?.traffic || null, cell);
        }

        if (typeof MobilityWidget !== 'undefined') {
            MobilityWidget.attachTo(contentEl, data?.realtime?.mobility || null, cell);
        }

        if (typeof FloodAnimation !== 'undefined') {
            FloodAnimation.attachTo(contentEl, data?.realtime?.flood || null, cell);
        }

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

    /** Render an error state in the panel for a cell that failed to load. */
    function showError(cell, msg) {
        contentEl.innerHTML = `
            <div class="panel-header">
                <div class="digipin-code">${esc(cell.code)}</div>
            </div>
            <div class="error-msg" role="alert">
                <span class="error-icon">&#9888;&#65039;</span>
                <p>Couldn't load data for this cell</p>
                <small>${esc(msg)}</small>
                <button class="retry-btn" id="panel-retry" type="button">&#8635; Retry</button>
            </div>`;
        const retry = contentEl.querySelector('#panel-retry');
        if (retry) {
            retry.addEventListener('click', () => {
                if (typeof MapModule !== 'undefined' && MapModule.selectByCode) {
                    MapModule.selectByCode(cell.code);
                }
            });
        }
    }

    /** Close the panel, clear map markers, and restore focus to where it was before opening. */
    function close() {
        panelEl.classList.remove('open');
        if (typeof FloodInundation !== 'undefined') FloodInundation.detach();
        currentCell = null;
        clearFeatureMarkers();
        // Return focus to wherever it was before the panel opened.
        if (_restoreFocus && typeof document !== 'undefined' && document.contains(_restoreFocus)) {
            try { _restoreFocus.focus({ preventScroll: true }); } catch { /* noop */ }
        }
        _restoreFocus = null;
    }

    /** Build the loading-state markup (code, coords, spinner, category list) for a cell. */
    function buildLoadingHTML(cell) {
        return `
            <div class="panel-header">
                <div class="digipin-code-section">
                    <div class="digipin-code">${esc(cell.code)}</div>
                    <button class="copy-btn" onclick="Panel.copyCode('${esc(cell.code)}')">&#128203;</button>
                </div>
                <div class="coords">${cell.center.lat.toFixed(6)}&deg;N, ${cell.center.lng.toFixed(6)}&deg;E</div>
            </div>
            <div class="loading-section" role="status" aria-live="polite" aria-label="Loading cell data">
                <div class="spinner"></div>
                <p>Fetching 160+ urban features...</p>
                <div class="loading-categories">
                    ${Object.values(DataFetcher.CATEGORIES).map(c =>
            `<div class="loading-cat">${esc(c.icon)} ${esc(c.name)}</div>`
        ).join('')}
                </div>
            </div>`;
    }

    /** Build the "Utilities & infrastructure" card (7 honestly-sourced readings). */
    function buildUtilitiesHTML(data) {
        const u = data.utilities;
        if (!u) return '';
        const radius = data.radius || 400;
        const rows = [];
        const row = (name, value, detail) =>
            `<div class="health-item"><span class="health-name">${esc(name)}</span>`
            + `<span class="health-type">${esc(value)}</span>`
            + (detail ? `<span class="health-beds">${esc(detail)}</span>` : '')
            + `</div>`;

        // 1. Sound / noise (modeled)
        if (u.noise) {
            rows.push(row('Sound / noise', `${u.noise.value}/100 · ${u.noise.band}`, u.noise.source));
        } else {
            rows.push(row('Sound / noise', 'estimate unavailable', 'modeled'));
        }
        // 2. Ground water level (regional)
        if (u.groundwater_level) {
            const g = u.groundwater_level;
            rows.push(row('Ground water level', `~${g.depth_m_bgl} m bgl`,
                `${g.category}${g.trend ? ' · ' + g.trend : ''}`));
        } else {
            rows.push(row('Ground water level', 'regional data: pilot only', 'CGWB'));
        }
        // 3. Sewer lines (OSM)
        rows.push(u.sewer && u.sewer.count > 0
            ? row('Sewer lines', `${u.sewer.count} mapped ≤${radius}m`,
                u.sewer.nearest_m != null ? `nearest ~${u.sewer.nearest_m}m` : 'OSM')
            : row('Sewer lines', 'none mapped nearby', 'OSM coverage sparse'));
        // 4. Water pipelines (OSM)
        rows.push(u.water && u.water.count > 0
            ? row('Water pipelines', `${u.water.count} mapped ≤${radius}m`,
                u.water.nearest_m != null ? `nearest ~${u.water.nearest_m}m` : 'OSM')
            : row('Water pipelines', 'none mapped nearby', 'OSM coverage sparse'));
        // 5. Gas connection (PNG)
        if (u.gas_png && u.gas_png.available) {
            rows.push(row('Gas connection (PNG)', u.gas_png.operator || 'available',
                u.gas_png.source || 'CGD'));
        } else {
            rows.push(row('Gas connection (PNG)', 'CGD status: pilot only', 'PNGRB'));
        }
        // 6. Ground water quality (regional)
        if (u.groundwater_quality) {
            rows.push(row('Ground water quality', u.groundwater_quality.label,
                u.groundwater_quality.source || 'CGWB'));
        } else {
            rows.push(row('Ground water quality', 'regional data: pilot only', 'CGWB'));
        }
        // 7. Electricity connection type (OSM + regional operator)
        const e = u.electricity || {};
        const typeLabel = { overhead: 'Overhead', underground: 'Underground', mixed: 'Mixed', unknown: 'Typical: overhead LV' }[e.type] || 'Unknown';
        const eDetail = [e.operator, e.nearest_substation_m != null ? `substation ~${e.nearest_substation_m}m` : null]
            .filter(Boolean).join(' · ') || e.source;
        rows.push(row('Electricity connection', typeLabel, eDetail));

        return `<div class="data-card">
            <div class="data-card-title">&#128736;&#65039; Utilities &amp; infrastructure <span class="data-badge badge-dim">7 layers</span></div>
            <div class="health-list">${rows.join('')}</div>
            <div class="data-card-sub">OSM pipes/power are sparsely mapped; ground water &amp; PNG are regional (CGWB/PNGRB) for the Indore pilot. See docs/UTILITIES_MODEL.md.</div>
        </div>`;
    }

    /** Build the full panel markup for a cell: header, hazards, environment/AQI, solar, satellite, health, EV, IUDX, Wikipedia, action buttons, and category tabs. */
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
                    <button class="export-btn" id="export-open-btn" title="Export this cell (GeoJSON / JSON / CSV)">⭳ Export</button>
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

        html += buildHazardsHTML(data);
        html += buildSourceStatusHTML(data);

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

        // EV Charging (OpenChargeMap)
        const ev = data.context?.evCharging;
        if (ev && ev.count > 0) {
            const fast = ev.fastCount > 0 ? `<span class="data-badge badge-cyan">${esc(ev.fastCount)} fast</span>` : '';
            html += `<div class="data-card">
                <div class="data-card-title">&#128267; EV Charging <span class="data-badge badge-dim">${esc(ev.count)} within 8km</span> ${fast}</div>
                <div class="health-list">${ev.stations.map(s =>
                    `<div class="health-item"><span class="health-name">${esc(s.name)}</span>${s.maxPowerKW != null ? `<span class="health-type">${esc(s.maxPowerKW)} kW</span>` : ''}${s.distanceKm != null ? `<span class="health-beds">${esc(s.distanceKm)} km</span>` : ''}</div>`
                ).join('')}</div>
                ${ev.operators.length > 0 ? `<div class="data-card-sub">Operators: ${esc(ev.operators.join(', '))}</div>` : ''}
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

        // Utilities & infrastructure (7 layers: noise, ground water, sewer,
        // water, gas/PNG, water quality, electricity)
        html += buildUtilitiesHTML(data);

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

        // Attach the export action after DOM insertion — opens the format
        // dialog (GeoJSON/JSON/CSV with content counts; js/export-dialog.js).
        setTimeout(() => {
            const btnExport = document.getElementById('export-open-btn');
            if (btnExport) {
                btnExport.onclick = () => {
                    if (typeof ExportDialog !== 'undefined') ExportDialog.open(cell, data);
                    else DataFetcher.exportToJSON(data, `digipin_${cell.code}.json`);
                };
            }
        }, 50);

        return html;
    }

    /** Activate the category tab and section matching catKey, clearing any feature markers. */
    function switchTab(catKey) {
        clearFeatureMarkers();
        document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.cat-tab[data-cat="${catKey}"]`)?.classList.add('active');
        document.querySelectorAll('.cat-section').forEach(s => s.classList.remove('active'));
        document.querySelector(`.cat-section[data-cat="${catKey}"]`)?.classList.add('active');
    }

    /** Plot a feature card's items as numbered markers on the map and fit the view to them. */
    function showFeatureOnMap(card) {
        const itemsStr = card.getAttribute('data-items');
        if (!itemsStr) return;
        try {
            const items = JSON.parse(itemsStr);
            if (!items.length) return;
            const map = MapModule.getMap();
            
            // Clear existing markers
            clearFeatureMarkers();
            
            const label = card.querySelector('.feature-label')?.textContent || '';
            const bounds = new maplibregl.LngLatBounds();
            
            items.forEach((item, i) => {
                if (!item.lat || !item.lng) return;
                
                const el = document.createElement('div');
                el.className = 'feature-map-marker';
                el.innerHTML = `<div class="fmm-dot" style="background:#2563eb;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;border:2px solid #fff;box-shadow:0 2px 4px rgba(0,0,0,0.3);">${i + 1}</div>`;
                
                const popupHTML = `<div style="font-family:Inter,sans-serif;font-size:12px"><strong>${esc(item.name || 'Unnamed')}</strong><br><span style="color:#94a3b8;font-size:10px">${esc(label)}</span></div>`;
                const popup = new maplibregl.Popup({ offset: 15, className: 'feature-marker-popup' }).setHTML(popupHTML);
                
                const marker = new maplibregl.Marker({ element: el })
                    .setLngLat([item.lng, item.lat])
                    .setPopup(popup)
                    .addTo(map);
                    
                _featureMarkers.push(marker);
                bounds.extend([item.lng, item.lat]);
            });
            
            // Fit map to show all markers
            if (items.length > 0 && !bounds.isEmpty()) {
                map.fitBounds(bounds, { padding: 50 });
            }
        } catch (e) { /* invalid JSON — skip */ }
    }

    /** Remove all feature markers currently shown on the map. */
    function clearFeatureMarkers() {
        if (_featureMarkers && _featureMarkers.length > 0) {
            _featureMarkers.forEach(m => m.remove());
            _featureMarkers = [];
        }
    }

    /** Map an AQI value to its severity CSS class (good → hazardous). */
    function getAQIClass(aqi) {
        if (aqi <= 50) return 'aqi-good';
        if (aqi <= 100) return 'aqi-moderate';
        if (aqi <= 150) return 'aqi-unhealthy-sg';
        if (aqi <= 200) return 'aqi-unhealthy';
        return 'aqi-hazardous';
    }

    /** Copy a DigiPin code to the clipboard and briefly flash the copy button. */
    function copyCode(code) {
        navigator.clipboard.writeText(code).then(() => {
            const btn = document.querySelector('.copy-btn');
            if (btn) { btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋', 1500); }
        }).catch(() => {
            if (typeof App !== 'undefined') App.showToast('Copy failed',
                'Clipboard unavailable (needs a secure context or permission).', 'warning');
        });
    }

    /** Return the cell currently displayed in the panel, or null. */
    function getCurrentCell() { return currentCell; }
    /** Return the data currently displayed in the panel, or undefined. */
    function getCurrentData() { return currentData; }

    return { init, show, update, showError, close, switchTab, copyCode, getCurrentCell, getCurrentData };
})();
