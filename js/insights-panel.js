/**
 * InsightsPanel — the Urban Intelligence dialog over js/urban-insights.js.
 *
 * Four tabs, all computed in the browser from the cell store:
 *   City       key indicators, the city's rank among every covered city, its
 *              monthly environment series, a ranking heat-table, best/worst zones
 *   Here       "what's notable here" for the selected cell's neighbourhood (or
 *              the map view): ranked findings, hotspots, trends and anomalies
 *   Compare    two areas or cities side by side, indicator by indicator
 *   What-if    a new park, more density, or a flood event: affected cells and
 *              buildings, painted as a 3D cell layer and onto the buildings
 *
 * Every finding has a Map button (puts its dataset on the map with the right
 * field), cell chips that open the cell, and an ⓘ source card from
 * js/provenance.js. The detail panel also gets a compact "What's notable"
 * card (attachTo). Map additions are one highlight source plus the runtime
 * `whatif` dataset; both are removed by clear().
 */
const InsightsPanel = (() => {
    const DIALOG_ID = 'insights-dialog';
    const HL_SRC = 'urban-insights-hl';
    const HL_FILL = 'urban-insights-hl-fill';
    const HL_LINE = 'urban-insights-hl-line';
    const WHATIF_ID = 'whatif';
    const CARD_ATTR = 'data-insights-card';
    const KIND = {
        strength: { label: 'Strength', icon: '▲' },
        concern: { label: 'Concern', icon: '▼' },
        notable: { label: 'Notable', icon: '◆' },
        trend: { label: 'Trend', icon: '↗' },
        anomaly: { label: 'Anomaly', icon: '⚡' },
    };

    let _tab = 'city';
    let _city = null;          // dashboard city (region name)
    let _hereMode = 'hood';    // 'hood' (L5 of selection) | 'cell' (L6) | 'view'
    let _scenario = { type: 'park', boost: 40, factor: 1.5, level: 'severe' };
    let _cmp = { a: null, b: null };
    let _dash = null;          // cached dashboard
    let _seq = 0;
    let _cardSeq = 0;

    // ── tiny DOM helpers ────────────────────────────────────────────────────

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function _btn(label, onClick, cls, title) {
        const b = _el('button', cls || 'ui-btn', label);
        b.type = 'button';
        if (title) b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
        return b;
    }

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind || 'info');
    }

    function _map() { return (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null; }

    function _store() { return (typeof CellStore !== 'undefined' && CellStore.isEnabled()) ? CellStore : null; }

    function _selected() {
        return (typeof MapModule !== 'undefined' && MapModule.getSelectedCode) ? MapModule.getSelectedCode() : null;
    }

    function _viewBbox() {
        const m = _map();
        if (!m || !m.getBounds) return null;
        const b = m.getBounds();
        return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
    }

    function _viewCity(store) {
        const sel = _selected();
        if (sel) {
            try { const c = DigiPin.decodePartial(sel.replace(/-/g, '')); return UrbanInsights.cityAt(store, c.lat, c.lng); } catch { /* fall through */ }
        }
        const m = _map();
        if (m && m.getCenter) { const c = m.getCenter(); return UrbanInsights.cityAt(store, c.lat, c.lng); }
        return null;
    }

    function _storeReady(ms = 10000) {
        if (typeof CellStore === 'undefined') return Promise.resolve(false);
        if (CellStore.datasets().length) return Promise.resolve(true);
        return new Promise(resolve => {
            const off = CellStore.onChange(() => { off(); clearTimeout(t); resolve(true); });
            const t = setTimeout(() => { off(); resolve(false); }, ms);
        });
    }

    // ── map: highlight + layers ─────────────────────────────────────────────

    function _cellPolygon(code) {
        const b = DigiPin.decodePartial(String(code).replace(/-/g, '')).bounds;
        return [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]];
    }

    /** Outline cells on the map: [{ code, kind }]. Replaces the previous highlight. */
    function highlight(cells, opts = {}) {
        const map = _map();
        if (!map || !map.getSource) return;
        const features = [];
        for (const c of cells || []) {
            try { features.push({ type: 'Feature', properties: { kind: c.kind || 'notable' }, geometry: { type: 'Polygon', coordinates: _cellPolygon(c.code) } }); } catch { /* bad code */ }
        }
        const data = { type: 'FeatureCollection', features };
        const color = ['match', ['get', 'kind'], 'strength', '#16a34a', 'concern', '#dc2626', 'anomaly', '#f59e0b', 'trend', '#6366f1', '#0ea5e9'];
        if (map.getSource(HL_SRC)) map.getSource(HL_SRC).setData(data);
        else {
            map.addSource(HL_SRC, { type: 'geojson', data });
            map.addLayer({ id: HL_FILL, type: 'fill', source: HL_SRC, paint: { 'fill-color': color, 'fill-opacity': 0.18 } });
            map.addLayer({ id: HL_LINE, type: 'line', source: HL_SRC, paint: { 'line-color': color, 'line-width': 2.5, 'line-dasharray': [2, 1] } });
        }
        if (opts.fit && features.length) {
            let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
            for (const f of features) for (const [x, y] of f.geometry.coordinates[0]) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y); }
            try { map.fitBounds([[w, s], [e, n]], { padding: 80, maxZoom: 15.5, duration: 800 }); } catch { /* not ready */ }
        }
    }

    function _clearHighlight() {
        const map = _map();
        if (!map || !map.getLayer) return;
        [HL_LINE, HL_FILL].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
        if (map.getSource(HL_SRC)) map.removeSource(HL_SRC);
    }

    function _clearWhatIf() {
        if (typeof CellLayers !== 'undefined' && CellLayers.isVisible(WHATIF_ID)) CellLayers.hide(WHATIF_ID);
        if (typeof BuildingData !== 'undefined' && BuildingData.get && String(BuildingData.get().color || '').startsWith(`${WHATIF_ID}:`)) BuildingData.set({ color: null });
        if (typeof CellStore !== 'undefined' && CellStore.isLocal(WHATIF_ID)) CellStore.unregister(WHATIF_ID);
    }

    /** Remove everything this panel put on the map. */
    function clear() {
        _clearHighlight();
        _clearWhatIf();
    }

    async function _showField(dataset, field) {
        if (typeof CellLayers === 'undefined') return;
        const ok = await CellLayers.show(dataset, { field });
        if (!ok) _toast('Layer unavailable', `Could not show ${dataset} here.`, 'warning');
    }

    function _openCell(code) {
        if (typeof MapModule !== 'undefined' && MapModule.selectByCode) MapModule.selectByCode(code);
    }

    function _flyToCode(code) {
        try {
            const c = DigiPin.decodePartial(String(code).replace(/-/g, ''));
            if (typeof MapModule !== 'undefined') MapModule.flyTo(c.lat, c.lng, Math.min(16, 7 + code.replace(/-/g, '').length));
        } catch { /* bad code */ }
    }

    // ── shared bits ─────────────────────────────────────────────────────────

    function _sourceToggle(datasetIds) {
        const wrap = _el('div', 'ui-src');
        const btn = _btn('ⓘ Source', () => {
            const open = wrap.querySelector('.ui-src-cards');
            if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
            const box = _el('div', 'ui-src-cards');
            for (const id of datasetIds) {
                const spec = CellStore.get(id);
                if (!spec || typeof Provenance === 'undefined') continue;
                const head = _el('div', 'ui-src-title', spec.title || id);
                box.append(head, Provenance.renderCard(Provenance.fromSpec(spec, CellStore.generated(), CellStore.isLocal(id))));
            }
            wrap.appendChild(box);
            btn.setAttribute('aria-expanded', 'true');
        }, 'ui-chip', 'Where these numbers come from');
        btn.setAttribute('aria-expanded', 'false');
        wrap.appendChild(btn);
        return wrap;
    }

    function _sourcesFooter(sources) {
        const f = _el('div', 'ui-footer');
        f.appendChild(_el('span', null, `Sources: ${sources.map(s => s.title).join(' · ')}`));
        f.appendChild(_sourceToggle(sources.map(s => s.id)));
        return f;
    }

    function _codeChip(code, label) {
        const c = _btn(label || code, () => _openCell(code), 'ui-chip ui-chip--code', `Open ${code}`);
        return c;
    }

    /** SVG sparkline of one or two aligned series (area vs city). */
    function sparkline(series, opts = {}) {
        const w = opts.w || 220, h = opts.h || 44, pad = 3;
        const all = series.flatMap(s => s.values).filter(v => v != null && Number.isFinite(v));
        if (all.length < 2) return null;
        const lo = Math.min(...all), hi = Math.max(...all);
        const n = Math.max(...series.map(s => s.values.length));
        const x = (i) => pad + (i / Math.max(1, n - 1)) * (w - pad * 2);
        const y = (v) => h - pad - ((v - lo) / ((hi - lo) || 1)) * (h - pad * 2);
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('class', 'ui-spark');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', opts.label || 'Trend');
        for (const s of series) {
            let d = '';
            s.values.forEach((v, i) => {
                if (v == null || !Number.isFinite(v)) return;
                d += `${d && s.values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
            });
            const p = document.createElementNS(ns, 'path');
            p.setAttribute('d', d);
            p.setAttribute('class', `ui-spark-line ${s.cls || ''}`);
            svg.appendChild(p);
        }
        return svg;
    }

    /** Horizontal gauge: area value vs city baseline on the field's span. */
    function _gauge(f) {
        if (f.value == null || f.baseline == null || f.unit === '%') return null;
        const lo = Math.min(0, f.value, f.baseline), hi = Math.max(f.value, f.baseline) * 1.15 || 1;
        const pos = (v) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
        const g = _el('div', 'ui-gauge');
        const bar = _el('div', `ui-gauge-bar ui-k-${f.kind}`);
        bar.style.width = pos(f.value);
        const tick = _el('div', 'ui-gauge-tick');
        tick.style.left = pos(f.baseline);
        tick.title = `City average ${UrbanInsights.fmt(f.baseline, f.unit)}`;
        g.append(bar, tick);
        return g;
    }

    function findingCard(f, opts = {}) {
        const k = KIND[f.kind] || KIND.notable;
        const card = _el('div', `ui-finding ui-k-${f.kind}${f.kind === 'trend' && f.good === false ? ' ui-bad' : ''}${f.kind === 'trend' && f.good === true ? ' ui-good' : ''}`);
        const top = _el('div', 'ui-finding-top');
        top.appendChild(_el('span', `ui-badge ui-k-${f.kind}`, `${k.icon} ${k.label}`));
        top.appendChild(_el('span', 'ui-finding-ds', f.label));
        card.appendChild(top);
        card.appendChild(_el('div', 'ui-finding-title', f.title));
        if (!opts.compact) {
            card.appendChild(_el('div', 'ui-finding-detail', f.detail));
            const g = _gauge(f);
            if (g) card.appendChild(g);
            if (f.series) {
                const sp = sparkline([{ values: f.series.city, cls: 'is-city' }, { values: f.series.area, cls: 'is-area' }], { label: `${f.label} over time` });
                if (sp) {
                    const box = _el('div', 'ui-spark-box');
                    box.appendChild(sp);
                    box.appendChild(_el('div', 'ui-spark-legend', `${f.series.steps[0]} → ${f.series.steps[f.series.steps.length - 1]} · here vs city`));
                    card.appendChild(box);
                }
            }
            if (f.drivers && f.drivers.parts.length) {
                const d = _el('div', 'ui-drivers');
                d.appendChild(_el('div', 'ui-drivers-h', 'What drives it'));
                f.drivers.parts.slice(0, 3).forEach(p => {
                    d.appendChild(_el('div', `ui-driver ${p.contribution < 0 ? 'neg' : 'pos'}`,
                        `${p.label}: ${p.area} vs ${p.city} (${p.contribution > 0 ? '+' : ''}${p.contribution} pts)`));
                });
                d.title = f.drivers.formula;
                card.appendChild(d);
            }
        }
        const act = _el('div', 'ui-actions');
        (f.cells || []).slice(0, opts.compact ? 2 : 3).forEach(c => act.appendChild(_codeChip(c.digipin)));
        act.appendChild(_btn('Map', () => {
            _showField(f.dataset, f.key);
            if (f.cells && f.cells.length) highlight(f.cells.map(c => ({ code: c.code || c.digipin, kind: f.kind })));
        }, 'ui-chip', `Show ${f.label} on the map`));
        if (!opts.compact) act.appendChild(_sourceToggle(f.sources));
        card.appendChild(act);
        return card;
    }

    // ── dialog shell ────────────────────────────────────────────────────────

    function _dialog() {
        let dlg = document.getElementById(DIALOG_ID);
        if (dlg) return dlg;
        dlg = _el('aside', 'ui-dialog');
        dlg.id = DIALOG_ID;
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-label', 'Urban Intelligence');
        const head = _el('div', 'ui-head');
        const title = _el('div', 'ui-title');
        title.appendChild(_el('span', 'ui-logo', '◎'));
        title.appendChild(_el('span', null, 'Urban Intelligence'));
        title.appendChild(_el('span', 'ui-sub', ''));
        const x = _btn('✕', close, 'close-btn', 'Close');
        x.setAttribute('aria-label', 'Close Urban Intelligence');
        const tools = _el('div', 'ui-head-tools');
        const share = _btn('🔗 Share', shareLink, 'ui-chip', 'Copy a link that reopens this exact Intel view');
        const brief = _btn('📄 Brief', () => openBrief(_briefContext()), 'ui-chip', 'Open a printable brief of this city (and area or scenario) with sources');
        tools.append(share, brief, x);
        head.append(title, tools);
        const tabs = _el('div', 'ui-tabs');
        tabs.setAttribute('role', 'tablist');
        [['city', 'City'], ['here', 'Here'], ['compare', 'Compare'], ['whatif', 'What-if']].forEach(([id, label]) => {
            const t = _btn(label, () => { _tab = id; render(); }, 'ui-tab');
            t.dataset.tab = id;
            t.setAttribute('role', 'tab');
            tabs.appendChild(t);
        });
        dlg.append(head, tabs, _el('div', 'ui-body'));
        document.body.appendChild(dlg);
        return dlg;
    }

    function isOpen() {
        const d = document.getElementById(DIALOG_ID);
        return !!d && d.classList.contains('open');
    }

    async function open(tab) {
        if (tab) _tab = tab;
        const dlg = _dialog();
        dlg.classList.add('open');
        document.getElementById('btn-insights')?.classList.add('active');
        if (typeof FloatingDialogs !== 'undefined' && FloatingDialogs.bringToFront) FloatingDialogs.bringToFront(dlg);
        await render();
    }

    function close() {
        const dlg = document.getElementById(DIALOG_ID);
        if (dlg) dlg.classList.remove('open');
        document.getElementById('btn-insights')?.classList.remove('active');
        _clearHighlight();
    }

    function toggle() { return isOpen() ? close() : open(); }

    function _body(msg) {
        const dlg = _dialog();
        dlg.querySelectorAll('.ui-tab').forEach(t => {
            const on = t.dataset.tab === _tab;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', String(on));
        });
        const body = dlg.querySelector('.ui-body');
        body.replaceChildren();
        if (msg) body.appendChild(_el('div', 'ui-empty', msg));
        return body;
    }

    async function render() {
        const seq = ++_seq;
        _body('Reading the cell store…');
        await _storeReady();
        const store = _store();
        if (!store) { _body('The per-cell data store is not available, so there is nothing to analyse yet.'); return; }
        if (!_city) _city = _viewCity(store) || (UrbanInsights.cities(store)[0] || {}).name || null;
        const sub = _dialog().querySelector('.ui-sub');
        sub.textContent = UrbanInsights.cityLabel(_city);
        try {
            const draw = { city: _renderCity, here: _renderHere, compare: _renderCompare, whatif: _renderWhatIf }[_tab] || _renderCity;
            await draw(store, seq);
        } catch (e) {
            if (seq === _seq) _body(`Could not compute this: ${e && e.message ? e.message : e}`);
        }
    }

    // ── City tab ────────────────────────────────────────────────────────────

    async function _renderCity(store, seq) {
        if (!_dash) _dash = await UrbanInsights.cityDashboard(store);
        if (seq !== _seq) return;
        const d = _dash;
        const body = _body();
        if (!d.cities.length) { body.appendChild(_el('div', 'ui-empty', 'No city has a score grid yet.')); return; }
        const cur = d.cities.find(c => c.region === _city) || d.cities[0];
        _city = cur.region;
        _dialog().querySelector('.ui-sub').textContent = cur.label;

        const pick = _el('div', 'ui-citypick');
        d.cities.forEach(c => {
            const b = _btn(c.label, () => { _city = c.region; render(); }, `ui-chip${c.region === cur.region ? ' active' : ''}`);
            pick.appendChild(b);
        });
        body.appendChild(pick);

        const hero = _el('div', 'ui-hero');
        const big = _el('div', 'ui-hero-score');
        big.appendChild(_el('div', 'ui-hero-num', String(cur.index ?? '—')));
        big.appendChild(_el('div', 'ui-hero-lbl', 'Urban index'));
        const txt = _el('div', 'ui-hero-txt');
        txt.appendChild(_el('div', 'ui-hero-rank', `#${cur.rank} of ${d.cities.length} cities`));
        txt.appendChild(_el('div', null, `Best at ${cur.strengths.map(s => s.label.toLowerCase()).join(' and ')}; weakest at ${cur.weaknesses.map(s => s.label.toLowerCase()).join(' and ')}.`));
        txt.appendChild(_el('div', 'ui-muted', `${cur.active.toLocaleString('en-IN')} built-up cells (~${cur.areaKm2.toLocaleString('en-IN')} km²) of ${cur.cells.toLocaleString('en-IN')} on the grid`));
        hero.append(big, txt);
        body.appendChild(hero);

        const kpis = _el('div', 'ui-kpis');
        for (const f of d.fields) {
            const ind = cur.indicators[f.key];
            const best = Math.max(...d.cities.map(c => c.indicators[f.key].mean || 0)) || 1;
            const tile = _el('button', 'ui-kpi');
            tile.type = 'button';
            tile.title = `Show ${f.label} on the map`;
            tile.addEventListener('click', () => _showField(d.dataset, f.key));
            tile.appendChild(_el('div', 'ui-kpi-lbl', f.label));
            tile.appendChild(_el('div', 'ui-kpi-val', UrbanInsights.fmt(ind.mean, f.unit)));
            const bar = _el('div', 'ui-kpi-bar');
            const fill = _el('div', `ui-kpi-fill ${f.higherIs === 'worse' ? 'is-worse' : ''}`);
            fill.style.width = `${Math.min(100, ((ind.mean || 0) / best) * 100)}%`;
            bar.appendChild(fill);
            tile.appendChild(bar);
            const r = ind.rank;
            tile.appendChild(_el('div', `ui-kpi-rank ${r === 1 ? 'is-top' : r === d.cities.length ? 'is-bottom' : ''}`, r ? `#${r}` : ''));
            kpis.appendChild(tile);
        }
        body.appendChild(kpis);

        if (cur.extras.length) {
            body.appendChild(_el('h4', 'ui-h', 'Environment, month by month'));
            const env = _el('div', 'ui-env');
            for (const e of cur.extras) {
                const t = _el('button', 'ui-env-tile');
                t.type = 'button';
                t.title = `Show ${e.label} on the map (use the time slider to play it)`;
                t.addEventListener('click', () => _showField(e.dataset, e.key));
                t.appendChild(_el('div', 'ui-kpi-lbl', e.label));
                t.appendChild(_el('div', 'ui-kpi-val', UrbanInsights.fmt(e.mean, e.unit)));
                if (e.yoy != null) {
                    const bad = e.higherIs === 'worse' ? e.yoy > 0 : e.higherIs === 'better' ? e.yoy < 0 : null;
                    t.appendChild(_el('div', `ui-yoy ${bad === true ? 'is-bad' : bad === false ? 'is-good' : ''}`, `${e.yoy > 0 ? '▲ +' : '▼ '}${UrbanInsights.fmt(e.yoy, e.unit)} year on year`));
                }
                if (e.series) {
                    const sp = sparkline([{ values: e.series, cls: 'is-area' }], { label: `${e.label} monthly`, w: 180, h: 36 });
                    if (sp) t.appendChild(sp);
                }
                env.appendChild(t);
            }
            body.appendChild(env);
        }

        body.appendChild(_el('h4', 'ui-h', 'How the cities rank'));
        const tbl = _el('div', 'ui-rank-wrap');
        const table = _el('table', 'ui-rank');
        const hr = _el('tr');
        hr.appendChild(_el('th', null, 'City'));
        hr.appendChild(_el('th', null, 'Index'));
        d.fields.forEach(f => { const th = _el('th', null, f.label.replace(/ (Index|Score)$/, '')); th.title = f.label; hr.appendChild(th); });
        const thead = _el('thead'); thead.appendChild(hr);
        const tb = _el('tbody');
        for (const c of d.cities) {
            const tr = _el('tr', c.region === cur.region ? 'is-cur' : '');
            tr.addEventListener('click', () => { _city = c.region; render(); });
            tr.appendChild(_el('td', 'ui-rank-city', `${c.rank}. ${c.label}`));
            tr.appendChild(_el('td', 'ui-rank-idx', String(c.index ?? '—')));
            d.fields.forEach(f => {
                const ind = c.indicators[f.key];
                const td = _el('td', 'ui-rank-cell', ind.mean == null ? '—' : String(Math.round(ind.mean)));
                const t = ind.rank ? 1 - (ind.rank - 1) / Math.max(1, d.cities.length - 1) : null;
                if (t != null) td.style.background = `hsl(${Math.round(t * 120)} 70% 45% / 0.28)`;
                td.title = `${f.label}: ${UrbanInsights.fmt(ind.mean, f.unit)} (rank ${ind.rank})`;
                tr.appendChild(td);
            });
            tb.appendChild(tr);
        }
        table.append(thead, tb);
        tbl.appendChild(table);
        body.appendChild(tbl);

        const z = cur.zones;
        body.appendChild(_el('h4', 'ui-h', `Zones of ${cur.label} (~4 km)`));
        const zones = _el('div', 'ui-zones');
        const zoneCol = (title, rows, kind, field) => {
            const col = _el('div', 'ui-zone-col');
            col.appendChild(_el('div', `ui-zone-h ui-k-${kind}`, title));
            rows.forEach(r => {
                const row = _el('button', 'ui-zone');
                row.type = 'button';
                row.appendChild(_el('span', 'ui-zone-code', r.digipin));
                row.appendChild(_el('span', 'ui-zone-val', `${r.mean}`));
                row.title = `${field} ${r.mean} over ${r.cells} cells: show its insights`;
                row.addEventListener('click', () => {
                    highlight([{ code: r.code, kind }], { fit: true });
                    _hereArea = { code: r.code, label: `Zone ${r.digipin}` };
                    _tab = 'here';
                    render();
                });
                col.appendChild(row);
            });
            return col;
        };
        zones.append(zoneCol('Most livable', z.best, 'strength', 'Livability'), zoneCol('Least livable', z.worst, 'concern', 'Livability'),
            zoneCol('Flood hotspots', z.flood, 'concern', 'Flood risk'));
        body.appendChild(zones);
        body.appendChild(_el('p', 'ui-method', d.method));
        body.appendChild(_sourcesFooter(d.sources));
    }

    // ── Here tab ────────────────────────────────────────────────────────────

    let _hereArea = null;      // explicit area (a zone clicked on the City tab)

    function _hereChoice() {
        if (_hereArea) return _hereArea;
        const sel = _selected();
        const code = sel ? sel.replace(/-/g, '') : null;
        if (_hereMode === 'view' || !code) {
            const b = _viewBbox();
            return b ? { bbox: b, label: 'The map view' } : null;
        }
        const n = _hereMode === 'cell' ? 6 : 5;
        return { code: code.slice(0, n), label: `${n === 5 ? 'The neighbourhood' : 'The cell'} ${DigiPin.format(code.slice(0, n))}` };
    }

    async function _renderHere(store, seq) {
        const body = _body();
        const modes = _el('div', 'ui-seg');
        const sel = _selected();
        [['hood', 'Area · 4 km'], ['cell', 'Cell · 1 km'], ['view', 'Map view']].forEach(([m, label]) => {
            const b = _btn(label, () => { _hereMode = m; _hereArea = null; render(); },
                `ui-seg-btn${!_hereArea && _hereMode === m ? ' active' : ''}`);
            if (m !== 'view' && !sel) { b.disabled = true; b.title = 'Click a cell on the map first'; }
            modes.appendChild(b);
        });
        body.appendChild(modes);
        const area = _hereChoice();
        if (!area) { body.appendChild(_el('div', 'ui-empty', 'Click a cell on the map, or pan to an area, to see what is notable there.')); return; }
        const wait = _el('div', 'ui-empty', `Reading every dataset for ${area.label}…`);
        body.appendChild(wait);
        const r = await UrbanInsights.areaInsights(area, store, { limit: 10 });
        if (seq !== _seq) return;
        wait.remove();
        _lastInsights = r;
        body.appendChild(_el('div', 'ui-headline', r.headline));
        const cov = _el('div', 'ui-muted', `${r.coverage.length} datasets · ${r.coverage.reduce((a, c) => a + c.cells, 0).toLocaleString('en-IN')} cell values compared with ${r.cityLabel}${r.more ? ` · ${r.more} smaller findings hidden` : ''}`);
        body.appendChild(cov);
        if (r.hotspots.length) {
            body.appendChild(_el('h4', 'ui-h', 'Hotspots'));
            const hs = _el('div', 'ui-hotspots');
            r.hotspots.forEach(h => {
                const row = _btn('', () => { highlight([{ code: h.code, kind: h.kind }], { fit: true }); _showField(h.dataset, h.field); }, `ui-hotspot ui-k-${h.kind}`, 'Show on the map');
                row.appendChild(_el('span', 'ui-zone-code', h.digipin));
                row.appendChild(_el('span', null, h.why));
                hs.appendChild(row);
            });
            const all = _btn('Outline all hotspots', () => highlight(r.hotspots.map(h => ({ code: h.code, kind: h.kind })), { fit: true }), 'ui-chip');
            hs.appendChild(all);
            body.appendChild(hs);
        }
        body.appendChild(_el('h4', 'ui-h', 'What stands out'));
        if (!r.findings.length) body.appendChild(_el('div', 'ui-empty', `Nothing here stands out from ${r.cityLabel} in the published data.`));
        r.findings.forEach(f => body.appendChild(findingCard(f)));
        const tools = _el('div', 'ui-actions');
        tools.appendChild(_btn('Copy as text', () => _copy(UrbanInsights.toText(r)), 'ui-chip'));
        tools.appendChild(_btn('Download JSON', () => _download(`insights_${(area.code || 'view')}.json`, JSON.stringify(r, null, 2)), 'ui-chip'));
        tools.appendChild(_btn('Printable brief', () => openBrief({ area }), 'ui-chip'));
        if (area.code) tools.appendChild(_btn('Compare with the city', () => { _cmp = { a: { code: area.code, label: area.label }, b: { city: r.city } }; _tab = 'compare'; render(); }, 'ui-chip'));
        body.appendChild(tools);
        body.appendChild(_el('p', 'ui-method', r.method));
        body.appendChild(_sourcesFooter(r.sources));
    }

    let _lastInsights = null;

    function _copy(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => _toast('Copied', 'Insights copied as text.', 'success')).catch(() => window.prompt('Copy:', text));
        } else window.prompt('Copy:', text);
    }

    function _download(name, text) {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ── Compare tab ─────────────────────────────────────────────────────────

    function _areaOptions(store) {
        const opts = UrbanInsights.cities(store).map(c => ({ value: `city:${c.name}`, label: c.label, area: { city: c.name } }));
        const sel = _selected();
        if (sel) {
            const c = sel.replace(/-/g, '');
            opts.unshift({ value: `p:${c.slice(0, 5)}`, label: `Selected neighbourhood ${DigiPin.format(c.slice(0, 5))}`, area: { code: c.slice(0, 5), label: `Neighbourhood ${DigiPin.format(c.slice(0, 5))}` } });
        }
        const b = _viewBbox();
        if (b) opts.unshift({ value: 'view', label: 'Map view', area: { bbox: b, label: 'Map view' } });
        return opts;
    }

    function _areaKey(a) {
        if (!a) return '';
        if (a.city) return `city:${a.city}`;
        if (a.code) return `p:${a.code}`;
        return 'view';
    }

    function _picker(label, which, opts) {
        const wrap = _el('label', 'ui-pick');
        wrap.appendChild(_el('span', 'ui-pick-lbl', label));
        const s = document.createElement('select');
        s.className = 'ui-select';
        opts.forEach(o => { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; s.appendChild(op); });
        const cur = _areaKey(_cmp[which]);
        const extra = _cmp[which] && !opts.some(o => o.value === cur);
        if (extra) { const op = document.createElement('option'); op.value = cur; op.textContent = _cmp[which].label || cur; s.insertBefore(op, s.firstChild); }
        s.value = cur || (opts[which === 'a' ? 0 : Math.min(1, opts.length - 1)] || {}).value;
        s.addEventListener('change', () => {
            const o = opts.find(x => x.value === s.value);
            if (o) { _cmp[which] = o.area; render(); }
        });
        if (!_cmp[which]) { const o = opts.find(x => x.value === s.value); if (o) _cmp[which] = o.area; }
        wrap.appendChild(s);
        return wrap;
    }

    async function _renderCompare(store, seq) {
        const body = _body();
        const opts = _areaOptions(store);
        if (!_cmp.a && !_cmp.b) {
            const cities = opts.filter(o => o.value.startsWith('city:'));
            const here = opts.find(o => o.value === `city:${_city}`) || cities[0];
            const other = cities.find(o => o !== here) || here;
            _cmp = { a: here && here.area, b: other && other.area };
        }
        const row = _el('div', 'ui-cmp-pick');
        row.append(_picker('A', 'a', opts), _el('span', 'ui-vs', 'vs'), _picker('B', 'b', opts));
        body.appendChild(row);
        const r = await UrbanInsights.compare(_cmp.a, _cmp.b, store);
        if (seq !== _seq) return;
        const verdict = _el('div', 'ui-headline', r.summary);
        body.appendChild(verdict);
        const score = _el('div', 'ui-cmp-score');
        score.appendChild(_el('span', 'ui-cmp-a', `${r.a.label}: ${r.wins.a}`));
        score.appendChild(_el('span', 'ui-muted', `${r.wins.tie} ties · ${r.rows.length - r.directional} context only`));
        score.appendChild(_el('span', 'ui-cmp-b', `${r.b.label}: ${r.wins.b}`));
        body.appendChild(score);
        const list = _el('div', 'ui-cmp');
        for (const x of r.rows) {
            const it = _el('div', `ui-cmp-row win-${x.winner}`);
            const head = _el('div', 'ui-cmp-head');
            head.appendChild(_el('span', 'ui-cmp-lbl', x.label));
            head.appendChild(_el('span', 'ui-muted', x.higherIs ? (x.higherIs === 'better' ? 'higher is better' : 'lower is better') : ''));
            it.appendChild(head);
            const max = Math.max(Math.abs(x.a), Math.abs(x.b)) || 1;
            [['a', x.a], ['b', x.b]].forEach(([side, v]) => {
                const line = _el('div', 'ui-cmp-line');
                const bar = _el('div', `ui-cmp-bar is-${side}`);
                bar.style.width = `${Math.max(2, (Math.abs(v) / max) * 100)}%`;
                line.appendChild(bar);
                line.appendChild(_el('span', `ui-cmp-v${x.winner === side ? ' is-win' : ''}`, `${UrbanInsights.fmt(v, x.unit)}${x.winner === side ? ' ✓' : ''}`));
                it.appendChild(line);
            });
            it.title = `${x.dataset}.${x.key} · ${x.na} vs ${x.nb} cells`;
            it.addEventListener('click', () => _showField(x.dataset, x.key));
            list.appendChild(it);
        }
        body.appendChild(list);
        body.appendChild(_el('p', 'ui-method', 'Means over each side’s cells (built-up cells only for cities and map views). A side wins an indicator when it is better by at least 5% of the indicator’s range. Click a row to map it.'));
        body.appendChild(_sourcesFooter(r.sources));
    }

    // ── What-if tab ─────────────────────────────────────────────────────────

    function _slider(label, key, min, max, step, suffix) {
        const wrap = _el('label', 'ui-slider');
        const txt = _el('span', 'ui-pick-lbl', `${label}: ${_scenario[key]}${suffix}`);
        const r = document.createElement('input');
        r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = _scenario[key];
        r.addEventListener('input', () => { _scenario[key] = Number(r.value); txt.textContent = `${label}: ${r.value}${suffix}`; });
        wrap.append(txt, r);
        return wrap;
    }

    async function _renderWhatIf(store, seq) {
        const body = _body();
        const seg = _el('div', 'ui-seg');
        [['park', '🌳 New park'], ['density', '🏢 More density'], ['flood', '🌊 Flood event']].forEach(([t, label]) => {
            seg.appendChild(_btn(label, () => { _scenario.type = t; render(); }, `ui-seg-btn${_scenario.type === t ? ' active' : ''}`));
        });
        body.appendChild(seg);
        const sel = _selected() || _scenario.code || null;
        const form = _el('div', 'ui-form');
        const t = _scenario.type;
        if (t === 'park' || t === 'density') {
            form.appendChild(_el('div', 'ui-muted', sel ? `Site: the ~1 km cell ${DigiPin.format(sel.replace(/-/g, '').slice(0, 6))} (the selected cell).` : 'Click a cell on the map to pick the site.'));
            if (t === 'park') form.appendChild(_slider('Green boost in the park cell', 'boost', 10, 80, 5, ' pts'));
            else form.appendChild(_slider('Residents', 'factor', 1.2, 4, 0.1, '×'));
        } else {
            const s = document.createElement('select');
            s.className = 'ui-select';
            [['moderate', 'Moderate (riskiest 10%)'], ['severe', 'Severe (riskiest 25%)'], ['extreme', 'Extreme (riskiest 50%)']].forEach(([v, l]) => {
                const o = document.createElement('option'); o.value = v; o.textContent = l; s.appendChild(o);
            });
            s.value = _scenario.level;
            s.addEventListener('change', () => { _scenario.level = s.value; });
            const lab = _el('label', 'ui-pick');
            lab.append(_el('span', 'ui-pick-lbl', 'Event'), s);
            form.appendChild(lab);
            form.appendChild(_el('div', 'ui-muted', `Area: the map view, within ${UrbanInsights.cityLabel(_city)}.`));
        }
        const run = _btn('Run scenario', () => _runScenario(store, out), 'ui-btn ui-btn--primary');
        if ((t === 'park' || t === 'density') && !sel) run.disabled = true;
        form.appendChild(run);
        body.appendChild(form);
        const out = _el('div', 'ui-whatif-out');
        body.appendChild(out);
        if (_autoRun) { _autoRun = false; await _runScenario(store, out); }
        else if (_lastWhatIf && _lastWhatIf.type === t) _drawWhatIf(out, _lastWhatIf);
    }

    let _lastWhatIf = null;
    let _autoRun = false;      // a shared what-if link runs its scenario on open

    async function _runScenario(store, out) {
        out.replaceChildren(_el('div', 'ui-empty', 'Running the scenario…'));
        const sel = _selected();
        const sc = { type: _scenario.type };
        let heights = null;
        try {
            if (sc.type === 'park' || sc.type === 'density') {
                sc.code = (sel || _scenario.code || '').replace(/-/g, '');
                if (sc.type === 'park') sc.boost = _scenario.boost; else sc.factor = _scenario.factor;
                if (sc.type === 'density') {
                    const c = DigiPin.decodePartial(sc.code);
                    heights = await UrbanInsights.loadHeights(c.lat, c.lng);
                }
            } else {
                sc.level = _scenario.level;
                const b = _viewBbox();
                sc.area = b ? { bbox: b, label: 'the map view' } : null;
                sc.city = _city;
                const m = _map();
                if (m) { const c = m.getCenter(); heights = await UrbanInsights.loadHeights(c.lat, c.lng); }
            }
            const r = await UrbanInsights.whatIf(sc, store, { heights });
            _lastWhatIf = r;
            _drawWhatIf(out, r);
            await _paintWhatIf(r);
        } catch (e) {
            out.replaceChildren(_el('div', 'ui-empty', e && e.message ? e.message : String(e)));
        }
    }

    async function _paintWhatIf(r) {
        const layer = UrbanInsights.toLayer(r, WHATIF_ID);
        if (!layer || typeof CellStore === 'undefined' || typeof CellLayers === 'undefined') return;
        _clearWhatIf();
        CellStore.register(layer.spec, layer.table);
        await CellLayers.show(WHATIF_ID, { field: layer.spec.fields[0].key, extrude: true });
        const top = r.cells.slice(0, 40).map(c => ({ code: c.code, kind: r.type === 'flood' ? 'concern' : 'strength' }));
        highlight(top, { fit: r.type !== 'flood' });
    }

    function _drawWhatIf(out, r) {
        out.replaceChildren();
        out.appendChild(_el('div', 'ui-whatif-title', r.title));
        out.appendChild(_el('div', 'ui-headline', r.summary));
        const tbl = _el('div', 'ui-metrics');
        r.metrics.forEach(m => {
            const row = _el('div', `ui-metric${m.flag ? ' is-flag' : ''}`);
            row.appendChild(_el('span', 'ui-metric-lbl', m.label));
            if (m.value != null) row.appendChild(_el('span', 'ui-metric-val', String(m.value)));
            else {
                const v = _el('span', 'ui-metric-val');
                v.appendChild(_el('span', 'ui-before', String(m.before)));
                v.appendChild(document.createTextNode(' → '));
                v.appendChild(_el('strong', null, String(m.after)));
                row.appendChild(v);
            }
            tbl.appendChild(row);
        });
        out.appendChild(tbl);
        if (r.cells && r.cells.length) {
            out.appendChild(_el('h4', 'ui-h', r.type === 'flood' ? `Most exposed cells (${r.cells.length})` : 'Cells affected'));
            const chips = _el('div', 'ui-actions');
            r.cells.slice(0, 12).forEach(c => chips.appendChild(_codeChip(c.digipin, `${c.digipin}${c.delta != null ? ` +${c.delta}` : c.exposure != null ? ` · ${c.exposure}` : ''}`)));
            out.appendChild(chips);
        }
        const act = _el('div', 'ui-actions');
        act.appendChild(_btn('Show as 3D layer', () => _paintWhatIf(r), 'ui-chip'));
        if (typeof BuildingData !== 'undefined' && BuildingData.set) {
            act.appendChild(_btn('Colour the 3D buildings', async () => {
                if (!CellStore.get(WHATIF_ID)) await _paintWhatIf(r);
                await BuildingData.set({ color: `${WHATIF_ID}:${r.layer.key}` });
                _toast('Buildings coloured', 'Turn on 3D buildings to see the scenario on each building.', 'info');
            }, 'ui-chip'));
        }
        act.appendChild(_btn('Clear', () => { clear(); _lastWhatIf = null; out.replaceChildren(); }, 'ui-chip'));
        act.appendChild(_btn('Copy as text', () => _copy(UrbanInsights.toText(r)), 'ui-chip'));
        act.appendChild(_btn('Printable brief', () => openBrief({ whatif: r, area: r.area && !r.area.city ? r.area : null }), 'ui-chip'));
        out.appendChild(act);
        const how = _el('details', 'ui-how');
        how.appendChild(_el('summary', null, 'How this is computed'));
        how.appendChild(_el('div', 'ui-formula', r.formula));
        const ul = _el('ul');
        r.assumptions.forEach(a => ul.appendChild(_el('li', null, a)));
        how.appendChild(ul);
        out.appendChild(how);
        out.appendChild(_sourcesFooter(r.sources));
    }

    // ── detail-panel card ───────────────────────────────────────────────────

    /** "What's notable here" card in the cell panel: top findings for the cell's neighbourhood. */
    async function attachTo(containerEl, cell) {
        const store = _store();
        if (!containerEl || !cell || !store || !cell.code || typeof UrbanInsights === 'undefined') return null;
        const seq = ++_cardSeq;
        const code = cell.code.replace(/-/g, '').slice(0, 5);
        let r;
        try { r = await UrbanInsights.areaInsights({ code, label: `Around ${DigiPin.format(code)}` }, store, { limit: 3 }); } catch { return null; }
        if (seq !== _cardSeq || !containerEl.isConnected) return null;
        containerEl.querySelectorAll(`[${CARD_ATTR}]`).forEach(e => e.remove());
        const wrap = _el('div', 'growth-widget ui-card');
        wrap.setAttribute(CARD_ATTR, '');
        const head = _el('div', 'growth-widget__header');
        head.appendChild(_el('div', 'growth-widget__title', '◎ What’s notable here'));
        head.appendChild(_btn('Open', () => { _hereArea = null; _hereMode = 'hood'; open('here'); }, 'ui-chip', 'Full insights for this neighbourhood'));
        wrap.appendChild(head);
        wrap.appendChild(_el('div', 'growth-widget__msg', r.headline));
        r.findings.forEach(f => wrap.appendChild(findingCard(f, { compact: true })));
        const first = containerEl.querySelector('.growth-widget');
        if (first) containerEl.insertBefore(wrap, first); else containerEl.appendChild(wrap);
        return r;
    }

    // ── share links + briefs ────────────────────────────────────────────────

    /** The open dialog's state for a share link (IntelBrief params), or null. */
    function linkState() {
        if (!isOpen()) return null;
        const st = { tab: _tab, city: _city };
        if (_tab === 'here') {
            const a = _hereChoice();
            if (a) st.a = a;
        } else if (_tab === 'compare') {
            st.a = _cmp.a; st.b = _cmp.b;
        } else if (_tab === 'whatif') {
            const sel = _selected();
            const s = { ..._scenario };
            if (sel) s.code = sel.replace(/-/g, '').slice(0, 6);
            else if (s.code) s.code = s.code.slice(0, 6);
            st.scenario = s;
        }
        return st;
    }

    /** Reopen the dialog from a share link's state. */
    async function applyLink(st) {
        if (!st || !st.tab) return;
        if (st.city) _city = st.city;
        if (st.tab === 'here' && st.a) {
            if (st.a.code || st.a.bbox) _hereArea = st.a;
            else if (st.a.city) _hereArea = st.a;
        }
        if (st.tab === 'compare' && (st.a || st.b)) _cmp = { a: st.a || null, b: st.b || null };
        if (st.tab === 'whatif' && st.scenario) {
            _scenario = { ..._scenario, ...st.scenario };
            _autoRun = st.scenario.type === 'flood' || !!st.scenario.code;
        }
        // A link's fly-to is still animating: the Here view and a flood event read
        // the map extent, so let the camera land first (bounded wait).
        const m = _map();
        if (m && m.isMoving && m.isMoving()) {
            await new Promise(res => { const t = setTimeout(res, 6000); m.once('moveend', () => { clearTimeout(t); res(); }); });
        }
        await open(st.tab);
    }

    /** What the header Brief button adds to the city: the Here area or the last what-if. */
    function _briefContext() {
        if (_tab === 'here') { const a = _hereChoice(); return a && !a.city ? { area: a } : {}; }
        if (_tab === 'whatif' && _lastWhatIf && _lastWhatIf.type === _scenario.type) return { whatif: _lastWhatIf };
        return {};
    }

    function _shareUrl() {
        if (typeof URLState !== 'undefined' && URLState.buildUrl && URLState.capture) return URLState.buildUrl(URLState.capture());
        const qs = new URLSearchParams(IntelBrief.toParams(linkState())).toString();
        return `${location.origin}${location.pathname}${qs ? `?${qs}` : ''}`;
    }

    function shareLink() {
        const url = _shareUrl();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url)
                .then(() => _toast('Link copied', 'Anyone with the link opens this Intel view.', 'success'))
                .catch(() => window.prompt('Copy this link:', url));
        } else window.prompt('Copy this link:', url);
        return url;
    }

    /**
     * Build a brief for the current city (plus opts.area / opts.whatif) and open
     * it in a new tab for printing; falls back to a download if pop-ups are blocked.
     */
    async function openBrief(opts = {}) {
        const store = _store();
        if (!store || typeof IntelBrief === 'undefined') return null;
        _toast('Building the brief', `Reading every dataset for ${UrbanInsights.cityLabel(_city)}…`, 'info');
        let html;
        try {
            const b = await IntelBrief.build({ city: (opts.whatif && opts.whatif.city) || _city, area: opts.area || null, whatif: opts.whatif || null, link: _shareUrl() }, store);
            html = IntelBrief.toHTML(b);
        } catch (e) {
            _toast('Brief failed', e && e.message ? e.message : String(e), 'error');
            return null;
        }
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const w = window.open(url, '_blank');
        if (!w) {
            const a = document.createElement('a');
            a.href = url; a.download = `digipin_brief_${_city || 'city'}.html`;
            document.body.appendChild(a); a.click(); a.remove();
        }
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return html;
    }

    // ── init ────────────────────────────────────────────────────────────────

    function init() {
        const btn = document.getElementById('btn-insights');
        if (btn) btn.addEventListener('click', toggle);
        if (typeof CellStore !== 'undefined' && CellStore.onChange) CellStore.onChange(() => { _dash = null; });
        // Keyboard: "i" opens the dialog when focus is not in a field.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'i' || e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            toggle();
        });
    }

    return {
        init, open, close, toggle, isOpen, render, attachTo, highlight, clear,
        findingCard, sparkline, linkState, applyLink, shareLink, openBrief,
        get lastInsights() { return _lastInsights; },
    };
})();

if (typeof window !== 'undefined') {
    window.InsightsPanel = InsightsPanel;
}
