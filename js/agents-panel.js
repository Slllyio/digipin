/**
 * AgentsPanel — the Agents gallery over js/urban-agents.js.
 *
 *   Gallery   pick an agent (area brief, site suitability, flood, heat,
 *             15-minute access, growth hotspots, what changed)
 *   Setup     choose the area and parameters; the plan is shown before
 *             anything runs
 *   Run       each planned step ticks off live
 *   Report    summary, key numbers, findings with cell chips, the result
 *             layer (painted as a 3D cell layer), sources, method, run log;
 *             share link, printable report, and an optional DISHA read-out
 *   My runs   every finished report, saved in this browser; reopening one
 *             restores its layer by re-running the agent on the same input
 *
 * Share links carry `ag` (agent), `aa` (area token, js/intel-brief.js) and
 * `ap` (params) through js/url-state.js; opening one runs the agent.
 */
const AgentsPanel = (() => {
    const DIALOG_ID = 'agents-dialog';
    const STORE_KEY = 'digipin_agent_runs';
    const MAX_RUNS = 25;
    const KIND = {
        strength: { label: 'Strength', icon: '▲' },
        concern: { label: 'Concern', icon: '▼' },
        notable: { label: 'Notable', icon: '◆' },
        trend: { label: 'Trend', icon: '↗' },
        anomaly: { label: 'Anomaly', icon: '⚡' },
        site: { label: 'Site', icon: '◎' },
    };
    const AREA_MODES = [['hood', 'Selected neighbourhood'], ['view', 'Map view'], ['city', 'Whole city']];

    let _tab = 'gallery';      // 'gallery' | 'runs'
    let _view = 'gallery';     // 'gallery' | 'setup' | 'run' | 'report' | 'runs'
    let _agent = null;
    let _params = {};
    let _areaMode = 'hood';
    let _city = null;
    let _report = null;
    let _steps = [];
    let _layers = new Map();   // runtime layer id → { spec, table }
    let _shown = null;         // layer id currently on the map
    let _running = false;

    // ── DOM helpers ─────────────────────────────────────────────────────────

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
    function _selected() { return (typeof MapModule !== 'undefined' && MapModule.getSelectedCode) ? MapModule.getSelectedCode() : null; }

    function _storeReady(ms = 10000) {
        if (typeof CellStore === 'undefined') return Promise.resolve(false);
        if (CellStore.datasets().length) return Promise.resolve(true);
        return new Promise(resolve => {
            const off = CellStore.onChange(() => { off(); clearTimeout(t); resolve(true); });
            const t = setTimeout(() => { off(); resolve(false); }, ms);
        });
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

    function _when(iso) {
        try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
    }

    // ── saved runs ──────────────────────────────────────────────────────────

    function savedRuns() {
        try {
            const a = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
            return Array.isArray(a) ? a.filter(r => r && r.schema === UrbanAgents.SCHEMA) : [];
        } catch { return []; }
    }

    function _saveRun(report) {
        const runs = [report, ...savedRuns().filter(r => r.id !== report.id)].slice(0, MAX_RUNS);
        try { localStorage.setItem(STORE_KEY, JSON.stringify(runs)); } catch { /* quota or private mode */ }
    }

    function _deleteRun(id) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(savedRuns().filter(r => r.id !== id))); } catch { /* ignore */ }
    }

    // ── area ────────────────────────────────────────────────────────────────

    // Agents that check the whole project (data health) take no area.
    const PROJECT_AREA = { project: true, label: 'All live feeds' };
    const _projectScope = (id) => { const t = UrbanAgents.template(id); return !!(t && t.scope === 'project'); };

    /** The area the setup's choice points at, or null with a reason. */
    function _area(store) {
        if (_projectScope(_agent)) return { area: PROJECT_AREA };
        if (_areaMode === 'city') {
            const c = _city || _viewCity(store);
            return c ? { area: { city: c, label: UrbanInsights.cityLabel(c) } } : { why: 'No covered city is in view.' };
        }
        if (_areaMode === 'view') {
            const b = _viewBbox();
            return b ? { area: { bbox: b, label: 'The map view' } } : { why: 'The map is not ready.' };
        }
        const sel = _selected();
        if (!sel) return { why: 'Select a cell on the map first, or pick Map view or Whole city.' };
        const code = sel.replace(/-/g, '').slice(0, 5);
        return { area: { code, label: `Neighbourhood ${DigiPin.format(code)}` } };
    }

    // ── map: layers + highlight ─────────────────────────────────────────────

    function _hideLayer() {
        if (_shown && typeof CellLayers !== 'undefined' && CellLayers.isVisible(_shown)) CellLayers.hide(_shown);
        _shown = null;
    }

    function _unregisterAll() {
        _hideLayer();
        if (typeof CellStore === 'undefined') return;
        for (const id of _layers.keys()) if (CellStore.isLocal(id)) CellStore.unregister(id);
        _layers.clear();
    }

    async function _showLayer(entry, report) {
        if (typeof CellLayers === 'undefined' || typeof CellStore === 'undefined') return false;
        if (entry.runtime && !CellStore.get(entry.id)) {
            // A reopened run: rebuild the layer by re-running the same input.
            if (!_layers.has(entry.id)) {
                _toast('Restoring the layer', `Re-running ${report.title} for ${report.area.label}…`, 'info');
                try {
                    const { layer } = await UrbanAgents.run(report.input, _store());
                    if (layer) _layers.set(layer.spec.id, layer);
                } catch (e) { _toast('Could not restore the layer', e.message, 'error'); return false; }
            }
            const l = _layers.get(entry.id);
            if (!l) return false;
            CellStore.register(l.spec, l.table);
        }
        _hideLayer();
        const ok = await CellLayers.show(entry.id, { field: entry.field, extrude: !!entry.runtime });
        if (ok) _shown = entry.id;
        else _toast('Layer unavailable', `Could not show ${entry.title} here.`, 'warning');
        return ok;
    }

    function _highlight(codes, kind) {
        if (typeof InsightsPanel !== 'undefined' && InsightsPanel.highlight) {
            InsightsPanel.highlight(codes.map(code => ({ code, kind: kind === 'site' ? 'strength' : kind })), { fit: true });
        }
    }

    function _openCell(code) {
        if (typeof MapModule !== 'undefined' && MapModule.selectByCode) MapModule.selectByCode(code);
    }

    // ── dialog shell ────────────────────────────────────────────────────────

    function _dialog() {
        let dlg = document.getElementById(DIALOG_ID);
        if (dlg) return dlg;
        dlg = _el('aside', 'ui-dialog ag-dialog');
        dlg.id = DIALOG_ID;
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-label', 'Agents');
        const head = _el('div', 'ui-head');
        const title = _el('div', 'ui-title');
        title.append(_el('span', 'ui-logo', '✦'), _el('span', null, 'Agents'), _el('span', 'ui-sub', ''));
        const x = _btn('✕', close, 'close-btn', 'Close');
        x.setAttribute('aria-label', 'Close Agents');
        const tools = _el('div', 'ui-head-tools');
        tools.appendChild(x);
        head.append(title, tools);
        const tabs = _el('div', 'ui-tabs');
        tabs.setAttribute('role', 'tablist');
        [['gallery', 'Gallery'], ['runs', 'My runs']].forEach(([id, label]) => {
            const t = _btn(label, () => { _tab = id; _view = id; render(); }, 'ui-tab');
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

    async function open(view) {
        if (view) { _view = view; _tab = view === 'runs' ? 'runs' : 'gallery'; }
        const dlg = _dialog();
        dlg.classList.add('open');
        document.getElementById('btn-agents')?.classList.add('active');
        if (typeof FloatingDialogs !== 'undefined' && FloatingDialogs.bringToFront) FloatingDialogs.bringToFront(dlg);
        await render();
    }

    function close() {
        const dlg = document.getElementById(DIALOG_ID);
        if (dlg) dlg.classList.remove('open');
        document.getElementById('btn-agents')?.classList.remove('active');
    }

    function toggle() { return isOpen() ? close() : open(); }

    function _body() {
        const dlg = _dialog();
        dlg.querySelectorAll('.ui-tab').forEach(t => {
            const on = t.dataset.tab === _tab;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', String(on));
        });
        const body = dlg.querySelector('.ui-body');
        body.replaceChildren();
        return body;
    }

    async function render() {
        const body = _body();
        body.appendChild(_el('div', 'ui-empty', 'Reading the cell store…'));
        await _storeReady();
        const store = _store();
        if (!store) { _body().appendChild(_el('div', 'ui-empty', 'The per-cell data store is not available, so agents have nothing to analyse yet.')); return; }
        if (!_city) _city = _viewCity(store) || (UrbanInsights.cities(store)[0] || {}).name || null;
        _dialog().querySelector('.ui-sub').textContent = _city ? UrbanInsights.cityLabel(_city) : '';
        const draw = { gallery: _renderGallery, setup: _renderSetup, run: () => _renderRun(), report: _renderReport, runs: _renderRuns }[_view] || _renderGallery;
        draw(store);
    }

    // ── gallery ─────────────────────────────────────────────────────────────

    function _renderGallery() {
        const body = _body();
        body.appendChild(_el('div', 'ag-intro', 'Agents run a fixed, explainable analysis on an area and hand back a report and a map layer. You see the plan before anything runs.'));
        const grid = _el('div', 'ag-grid');
        for (const t of UrbanAgents.TEMPLATES) {
            const card = _el('button', 'ag-card');
            card.type = 'button';
            card.dataset.agent = t.id;
            card.append(_el('span', 'ag-card-icon', t.icon), _el('span', 'ag-card-title', t.title),
                _el('span', 'ag-card-q', t.question), _el('span', 'ag-card-blurb', t.blurb));
            card.addEventListener('click', () => pick(t.id));
            grid.appendChild(card);
        }
        body.appendChild(grid);
    }

    /** Open an agent's setup (plan preview). */
    function pick(id, params) {
        const t = UrbanAgents.template(id);
        if (!t) return;
        _agent = t.id;
        _params = params ? { ...params } : {};
        for (const p of t.params) if (!_params[p.key]) _params[p.key] = p.default;
        if (!_selected() && _areaMode === 'hood') _areaMode = 'view';
        _view = 'setup';
        _tab = 'gallery';
        render();
    }

    // ── setup + plan ────────────────────────────────────────────────────────

    function _renderSetup(store) {
        const t = UrbanAgents.template(_agent);
        const body = _body();
        body.appendChild(_btn('← All agents', () => { _view = 'gallery'; render(); }, 'ag-back'));
        const head = _el('div', 'ag-head');
        head.append(_el('span', 'ag-head-icon', t.icon), _el('div', 'ag-head-text'));
        head.lastChild.append(_el('div', 'ag-head-title', t.title), _el('div', 'ui-muted', t.question));
        body.appendChild(head);
        body.appendChild(_el('div', 'ag-blurb', t.blurb));

        if (!_projectScope(_agent)) _areaPicker(body, store);
        const a = _area(store);
        if (_projectScope(_agent)) body.appendChild(_el('div', 'ag-area', a.area.label));


        for (const p of t.params) {
            body.appendChild(_el('div', 'ui-h', p.label));
            const ps = _el('div', 'ui-seg');
            for (const o of p.options) {
                const on = _params[p.key] === o.value;
                const b = _btn(o.label, () => { _params[p.key] = o.value; render(); }, `ui-seg-btn${on ? ' active' : ''}`);
                b.setAttribute('aria-pressed', String(on));
                ps.appendChild(b);
            }
            body.appendChild(ps);
        }

        body.appendChild(_el('div', 'ui-h', 'Plan'));
        const pl = UrbanAgents.plan({ agent: _agent, params: _params });
        body.appendChild(_planList(pl.steps.map(s => ({ ...s, status: 'pending' }))));

        const go = _btn('Run agent', () => run(), 'ui-btn ui-btn--primary ag-run');
        go.disabled = !a.area || _running;
        body.appendChild(go);
    }

    function _areaPicker(body, store) {
        body.appendChild(_el('div', 'ui-h', 'Area'));
        const seg = _el('div', 'ui-seg');
        for (const [mode, label] of AREA_MODES) {
            const b = _btn(label, () => { _areaMode = mode; render(); }, `ui-seg-btn${_areaMode === mode ? ' active' : ''}`);
            b.setAttribute('aria-pressed', String(_areaMode === mode));
            seg.appendChild(b);
        }
        body.appendChild(seg);
        if (_areaMode === 'city') {
            const sel = _el('select', 'ag-select');
            sel.setAttribute('aria-label', 'City');
            for (const c of UrbanInsights.cities(store)) {
                const o = _el('option', null, c.label);
                o.value = c.name;
                if (c.name === _city) o.selected = true;
                sel.appendChild(o);
            }
            sel.addEventListener('change', () => { _city = sel.value; render(); });
            body.appendChild(sel);
        }
        const a = _area(store);
        body.appendChild(_el('div', `ag-area${a.area ? '' : ' is-missing'}`, a.area ? a.area.label : a.why));
    }

    function _planList(steps) {
        const ol = _el('ol', 'ag-plan');
        for (const s of steps) {
            const li = _el('li', `ag-step is-${s.status}`);
            const mark = { pending: '○', running: '◌', done: '✓', failed: '✕', skipped: '–' }[s.status] || '○';
            li.appendChild(_el('span', 'ag-step-mark', mark));
            const txt = _el('div', 'ag-step-text');
            const top = _el('div', 'ag-step-label');
            top.append(_el('code', 'ag-tool', s.tool), document.createTextNode(` ${s.label}`));
            txt.appendChild(top);
            if (s.detail) txt.appendChild(_el('div', 'ag-step-detail', s.detail));
            if (s.result) txt.appendChild(_el('div', 'ag-step-result', s.result));
            li.appendChild(txt);
            ol.appendChild(li);
        }
        return ol;
    }

    // ── run ─────────────────────────────────────────────────────────────────

    /**
     * Run the current setup (or `input`) with live steps, then show and save
     * the report. Resolves to the report, or null on failure.
     */
    async function run(input) {
        if (_running) return null;
        const store = _store();
        if (!store) return null;
        let inp = input;
        if (!inp) {
            const a = _area(store);
            if (!a.area) { _toast('Pick an area', a.why, 'warning'); return null; }
            inp = { agent: _agent, area: a.area, params: _params };
        }
        _agent = inp.agent;
        const pl = UrbanAgents.plan(inp);
        _steps = pl.steps.map(s => ({ ...s, status: 'pending' }));
        _running = true;
        _view = 'run';
        if (isOpen()) render();
        try {
            const { report, layer } = await UrbanAgents.run(inp, store, {
                onStep: (s) => {
                    _steps[s.i] = { ...s };
                    if (isOpen() && _view === 'run') _renderRun();
                },
            });
            _unregisterAll();
            if (layer) _layers.set(layer.spec.id, layer);
            _report = report;
            _saveRun(report);
            _view = 'report';
            if (isOpen()) render();
            const main = report.layers[0];
            if (main && main.runtime && await _showLayer(main, report) && _report === report && _view === 'report' && isOpen()) _renderReport();
            const cells = report.findings.flatMap(f => f.cells || []).slice(0, 8);
            if (cells.length) _highlight(cells, report.findings[0].kind);
            return report;
        } catch (e) {
            _toast(`${pl.title} failed`, e && e.message ? e.message : String(e), 'error');
            if (isOpen() && _view === 'run') _renderRun(e);
            return null;
        } finally {
            _running = false;
        }
    }

    function _renderRun(err) {
        const t = UrbanAgents.template(_agent);
        const body = _body();
        const head = _el('div', 'ag-head');
        head.append(_el('span', 'ag-head-icon', t.icon), _el('div', 'ag-head-text'));
        head.lastChild.append(_el('div', 'ag-head-title', `Running ${t.title}`), _el('div', 'ui-muted', t.question));
        body.appendChild(head);
        body.appendChild(_planList(_steps));
        if (err instanceof Error) {
            body.appendChild(_el('div', 'ag-error', err.message));
            body.appendChild(_btn('← Back to setup', () => { _view = 'setup'; render(); }, 'ui-btn'));
        }
    }

    // ── report ──────────────────────────────────────────────────────────────

    function _findingCard(f) {
        const k = KIND[f.kind] || KIND.notable;
        const card = _el('div', `ui-finding ui-k-${f.kind === 'site' ? 'strength' : f.kind}`);
        const top = _el('div', 'ui-finding-top');
        top.appendChild(_el('span', `ui-badge ui-k-${f.kind === 'site' ? 'strength' : f.kind}`, `${k.icon} ${k.label}`));
        card.appendChild(top);
        card.appendChild(_el('div', 'ui-finding-title', f.title));
        if (f.detail) card.appendChild(_el('div', 'ui-finding-detail', f.detail));
        const act = _el('div', 'ui-actions');
        (f.cells || []).slice(0, 3).forEach(c => act.appendChild(_btn(DigiPin.format(c), () => _openCell(c), 'ui-chip ui-chip--code', `Open ${DigiPin.format(c)}`)));
        if ((f.cells || []).length) act.appendChild(_btn('Show', () => _highlight(f.cells, f.kind), 'ui-chip', 'Outline these cells on the map'));
        if (f.sources && f.sources.length) act.appendChild(_sourceToggle(f.sources));
        card.appendChild(act);
        return card;
    }

    function _sourceToggle(ids) {
        const wrap = _el('div', 'ui-src');
        const btn = _btn('ⓘ Source', () => {
            const openBox = wrap.querySelector('.ui-src-cards');
            if (openBox) { openBox.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
            const box = _el('div', 'ui-src-cards');
            for (const id of ids) {
                const spec = CellStore.get(id);
                if (!spec || typeof Provenance === 'undefined') continue;
                box.append(_el('div', 'ui-src-title', spec.title || id),
                    Provenance.renderCard(Provenance.fromSpec(spec, CellStore.generated(), CellStore.isLocal(id))));
            }
            if (!box.childNodes.length) box.appendChild(_el('div', 'ui-muted', ids.join(', ')));
            wrap.appendChild(box);
            btn.setAttribute('aria-expanded', 'true');
        }, 'ui-chip', 'Where these numbers come from');
        btn.setAttribute('aria-expanded', 'false');
        wrap.appendChild(btn);
        return wrap;
    }

    function _details(summary, child) {
        const d = _el('details', 'ag-details');
        d.appendChild(_el('summary', null, summary));
        d.appendChild(child);
        return d;
    }

    function _renderReport() {
        const r = _report;
        const body = _body();
        if (!r) { body.appendChild(_el('div', 'ui-empty', 'No report yet.')); return; }
        body.appendChild(_btn('← All agents', () => { _view = 'gallery'; _tab = 'gallery'; render(); }, 'ag-back'));
        const head = _el('div', 'ag-head');
        head.append(_el('span', 'ag-head-icon', r.icon), _el('div', 'ag-head-text'));
        const where = r.cityLabel && r.cityLabel !== r.area.label ? `${r.area.label} · ${r.cityLabel}` : r.area.label;
        head.lastChild.append(_el('div', 'ag-head-title', r.title), _el('div', 'ui-muted', `${where} · ${_when(r.ranAt)}`));
        body.appendChild(head);
        body.appendChild(_el('div', 'ui-headline ag-summary', r.summary));

        if (r.metrics.length) {
            const m = _el('div', 'ag-metrics');
            for (const x of r.metrics) {
                const c = _el('div', 'ag-metric');
                c.append(_el('div', 'ag-metric-v', x.value), _el('div', 'ag-metric-l', x.label));
                m.appendChild(c);
            }
            body.appendChild(m);
        }

        const tools = _el('div', 'ag-tools');
        tools.append(
            _btn('🔗 Share', () => shareLink(r), 'ui-chip', 'Copy a link that re-runs this agent on this area'),
            _btn('📄 Report', () => openPrintable(r), 'ui-chip', 'Open a printable report with sources'),
            _btn('↻ Re-run', () => run(r.input), 'ui-chip', 'Run again on the same area'),
        );
        const ready = typeof DISHA !== 'undefined' && DISHA.complete && typeof DISHAProviders !== 'undefined' && DISHAProviders.isConnected && DISHAProviders.isConnected();
        const ask = _btn('✦ DISHA’s read', () => narrate(r), 'ui-chip', ready ? 'Ask DISHA to explain this report' : 'Connect an AI provider in Settings to use DISHA');
        ask.disabled = !ready || !!r.narration;
        tools.appendChild(ask);
        body.appendChild(tools);
        if (r.narration) {
            const n = _el('div', 'ag-narration');
            n.append(_el('div', 'ag-narration-h', 'DISHA’s read'), _el('div', null, r.narration));
            body.appendChild(n);
        }

        if (r.layers.length) {
            body.appendChild(_el('div', 'ui-h', 'Layers'));
            for (const l of r.layers) {
                const row = _el('div', 'ag-layer');
                row.appendChild(_el('span', 'ag-layer-title', `${l.title}${l.unit ? ` (${l.unit})` : ''}`));
                const on = _shown === l.id;
                row.appendChild(_btn(on ? 'Hide' : 'Show', async () => {
                    if (_shown === l.id) _hideLayer(); else await _showLayer(l, r);
                    _renderReport();
                }, `ui-chip${on ? ' active' : ''}`));
                body.appendChild(row);
            }
        }

        if (r.findings.length) {
            body.appendChild(_el('div', 'ui-h', 'Findings'));
            r.findings.forEach(f => body.appendChild(_findingCard(f)));
        }

        if (r.sources.length) {
            const ul = _el('ul', 'ag-sources');
            r.sources.forEach(s => ul.appendChild(_el('li', null, `${s.title || s.id}${s.license ? ` — ${s.license}` : ''}`)));
            body.appendChild(_details(`Sources (${r.sources.length})`, ul));
        }
        if (r.method) {
            const m = _el('div', 'ui-method', r.method);
            if (r.refs) m.appendChild(_el('div', 'ag-refs', r.refs));
            body.appendChild(_details('Method', m));
        }
        body.appendChild(_details('How this ran', _planList(r.steps.map(s => ({ ...s })))));
    }

    /** Ask DISHA for a short read-out of a report; saved with the run. */
    async function narrate(r) {
        if (typeof DISHA === 'undefined' || !DISHA.complete) return null;
        _toast('Asking DISHA', 'Reading the report…', 'info');
        try {
            const text = await DISHA.complete({
                system: 'You are DISHA, an urban analyst for Indian cities. Explain an analysis report to a city official in plain language. '
                    + 'Use only the numbers in the report, name the places by their DIGIPIN codes, and end with one concrete next step. At most 5 sentences.',
                messages: [{ role: 'user', content: UrbanAgents.toText(r) }],
            });
            r.narration = String(text || '').trim();
            if (r.narration) _saveRun(r);
            if (_report === r && isOpen()) _renderReport();
            return r.narration;
        } catch (e) {
            _toast('DISHA could not answer', e && e.message ? e.message : String(e), 'error');
            return null;
        }
    }

    // ── my runs ─────────────────────────────────────────────────────────────

    function _renderRuns() {
        const body = _body();
        const runs = savedRuns();
        if (!runs.length) {
            body.appendChild(_el('div', 'ui-empty', 'No runs yet. Pick an agent in the Gallery; every finished run is saved here in this browser.'));
            return;
        }
        for (const r of runs) {
            const row = _el('div', 'ag-run-row');
            const main = _el('button', 'ag-run-open');
            main.type = 'button';
            main.append(_el('span', 'ag-card-icon', r.icon || '✦'), _el('span', 'ag-run-text'));
            main.lastChild.append(_el('span', 'ag-run-title', `${r.title} · ${r.area.label}`), _el('span', 'ag-run-sub', `${_when(r.ranAt)} — ${r.summary}`));
            main.addEventListener('click', () => { _unregisterAll(); _report = r; _view = 'report'; render(); });
            const del = _btn('✕', () => { _deleteRun(r.id); _renderRuns(); }, 'ag-run-del', 'Remove this run');
            del.setAttribute('aria-label', `Remove ${r.title} run`);
            row.append(main, del);
            body.appendChild(row);
        }
    }

    // ── share + print ───────────────────────────────────────────────────────

    /** Link params for a run input: [[key, value], …]. Pure. */
    function toParams(input) {
        if (!input || !UrbanAgents.template(input.agent)) return [];
        const out = [['ag', input.agent]];
        const tok = typeof IntelBrief !== 'undefined' ? IntelBrief.areaToken(input.area) : '';
        if (tok) out.push(['aa', tok]);
        const ps = Object.entries(input.params || {}).filter(([k, v]) => /^[a-z_]+$/.test(k) && /^[a-z0-9_]+$/.test(String(v)));
        if (ps.length) out.push(['ap', ps.map(([k, v]) => `${k}:${v}`).join(',')]);
        return out;
    }

    /** URLSearchParams → run input, or null. Pure. */
    function parseParams(p) {
        const ag = p.get('ag');
        if (!ag || !UrbanAgents.template(ag)) return null;
        const area = p.get('aa') && typeof IntelBrief !== 'undefined' ? IntelBrief.parseAreaToken(p.get('aa')) : null;
        const params = {};
        for (const kv of String(p.get('ap') || '').split(',')) {
            const [k, v] = kv.split(':');
            if (/^[a-z_]+$/.test(k || '') && /^[a-z0-9_]+$/.test(v || '')) params[k] = v;
        }
        return { agent: ag, area, params };
    }

    /** What a share link should carry right now (the open report), or null. */
    function linkState() {
        return isOpen() && _view === 'report' && _report ? _report.input : null;
    }

    /** Open a shared run: re-run it and show the report. */
    async function applyLink(input) {
        if (!input) return null;
        await _storeReady();
        _agent = input.agent;
        _params = { ...(input.params || {}) };
        if (!input.area && _projectScope(input.agent)) input = { ...input, area: PROJECT_AREA };
        if (!input.area) { pick(input.agent, input.params); return open(); }
        _steps = UrbanAgents.plan(input).steps.map(s => ({ ...s, status: 'pending' }));
        await open('run');
        return run(input);
    }

    function _shareUrl(r) {
        const qs = new URLSearchParams(toParams(r.input)).toString();
        if (typeof URLState !== 'undefined' && URLState.buildUrl && URLState.capture) {
            const st = URLState.capture();
            st.agent = r.input;
            delete st.intel;
            return URLState.buildUrl(st);
        }
        return `${location.origin}${location.pathname}${qs ? `?${qs}` : ''}`;
    }

    function shareLink(r) {
        const url = _shareUrl(r || _report);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url)
                .then(() => _toast('Link copied', 'Anyone with the link re-runs this agent on the same area.', 'success'))
                .catch(() => window.prompt('Copy this link:', url));
        } else window.prompt('Copy this link:', url);
        return url;
    }

    function _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /** A self-contained printable HTML report. Pure. */
    function toHTML(r, link) {
        const where = r.cityLabel && r.cityLabel !== r.area.label ? `${r.area.label}, ${r.cityLabel}` : r.area.label;
        const metrics = r.metrics.map(m => `<div class="m"><b>${_esc(m.value)}</b><span>${_esc(m.label)}</span></div>`).join('');
        const findings = r.findings.map(f => `<li class="${_esc(f.kind)}"><b>${_esc(f.title)}</b>${f.detail ? `<br>${_esc(f.detail)}` : ''}`
            + `${(f.cells || []).length ? `<br><small>Cells: ${f.cells.slice(0, 6).map(c => _esc(DigiPin.format(c))).join(', ')}</small>` : ''}</li>`).join('');
        const sources = r.sources.map(s => `<li>${_esc(s.title || s.id)}${s.source ? ` — ${_esc(s.source)}` : ''}${s.license ? ` (${_esc(s.license)})` : ''}</li>`).join('');
        const steps = r.steps.map(s => `<li>${_esc(s.label)}${s.result ? ` — <i>${_esc(s.result)}</i>` : ''}</li>`).join('');
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${_esc(r.title)} — ${_esc(where)}</title>
<style>
body{font:14px/1.5 Inter,system-ui,sans-serif;color:#222;max-width:780px;margin:32px auto;padding:0 18px}
h1{font-size:22px;margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#666;margin:26px 0 8px}
.sub{color:#666;margin:4px 0 16px}.sum{font-size:16px;font-weight:600}
.ms{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.m{border:1px solid #ddd;border-radius:8px;padding:8px 10px}
.m b{display:block;font-size:17px}.m span{color:#666;font-size:12px}
ul{padding-left:18px}li{margin:6px 0}li.concern b{color:#b3392f}li.strength b,li.site b{color:#3f7a3a}
.n{background:#f5f5f2;border-radius:8px;padding:10px 12px}.foot{color:#888;font-size:12px;margin-top:28px}
@media print{a{color:inherit}}
</style></head><body>
<h1>${_esc(r.icon)} ${_esc(r.title)}</h1>
<div class="sub">${_esc(where)} · ${_esc(new Date(r.ranAt).toUTCString())} · ${_esc(r.question)}</div>
<p class="sum">${_esc(r.summary)}</p>
${metrics ? `<div class="ms">${metrics}</div>` : ''}
${r.narration ? `<h2>DISHA’s read</h2><div class="n">${_esc(r.narration)}</div>` : ''}
${findings ? `<h2>Findings</h2><ul>${findings}</ul>` : ''}
${r.method ? `<h2>Method</h2><p>${_esc(r.method)}</p>${r.refs ? `<p><small>${_esc(r.refs)}</small></p>` : ''}` : ''}
${sources ? `<h2>Sources</h2><ul>${sources}</ul>` : ''}
<h2>How this ran</h2><ol>${steps}</ol>
<div class="foot">DigiPin agent report (${_esc(r.schema)}). ${link ? `Re-run: <a href="${_esc(link)}">${_esc(link)}</a>` : ''}</div>
</body></html>`;
    }

    function openPrintable(r) {
        r = r || _report;
        if (!r) return null;
        const html = toHTML(r, _shareUrl(r));
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const w = window.open(url, '_blank');
        if (!w) {
            const a = document.createElement('a');
            a.href = url; a.download = `digipin_${r.agent}_report.html`;
            document.body.appendChild(a); a.click(); a.remove();
        }
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return html;
    }

    // ── DISHA entry point ───────────────────────────────────────────────────

    /**
     * Run an agent for DISHA: on the selected neighbourhood when there is one,
     * otherwise the map view. Opens the dialog so the user sees the run.
     */
    async function runFor(agentId, params = {}) {
        if (!UrbanAgents.template(agentId)) throw new Error(`Unknown agent "${agentId}".`);
        await _storeReady();
        const store = _store();
        if (!store) throw new Error('The cell store is not available.');
        _agent = agentId;
        _params = { ...params };
        _areaMode = _selected() ? 'hood' : 'view';
        const a = _area(store);
        if (!a.area) throw new Error(a.why);
        _steps = UrbanAgents.plan({ agent: agentId, params }).steps.map(s => ({ ...s, status: 'pending' }));
        await open('run');
        const r = await run({ agent: agentId, area: a.area, params });
        if (!r) throw new Error('The agent run failed.');
        return r;
    }

    // ── init ────────────────────────────────────────────────────────────────

    function init() {
        const btn = document.getElementById('btn-agents');
        if (btn) btn.addEventListener('click', toggle);
    }

    return {
        init, open, close, toggle, isOpen, render, pick, run, runFor, narrate,
        savedRuns, toParams, parseParams, linkState, applyLink, shareLink, toHTML, openPrintable,
        get report() { return _report; },
    };
})();

if (typeof window !== 'undefined') {
    window.AgentsPanel = AgentsPanel;
}
