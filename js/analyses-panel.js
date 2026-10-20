/**
 * AnalysesPanel — the app side of saved analyses (js/analysis.js).
 *
 * Lists the shipped analyses and the user's own (localStorage), picks an area
 * (the current map view, or a DIGIPIN prefix that defaults to the selected
 * cell's neighbourhood), runs one, paints its result as a 3D cell layer, and
 * opens the report in a dialog with Copy link / Download HTML / Download JSON /
 * Print / Re-run. Recent reports are kept so they can be reopened or re-run
 * later over fresh data.
 *
 * A link with ?analysis=<id>&area=p:<code> (or ?analysis_def=… for a custom
 * template) re-runs the analysis on open, so a report is shareable without a
 * server. Templates can be exported and imported as JSON files.
 *
 * load/save helpers are unit-tested; the DOM parts mirror js/saved-views.js.
 */
const AnalysesPanel = (() => {
    const STORE_KEY = 'digipin_analyses';
    const REPORTS_KEY = 'digipin_analysis_reports';
    const MAX_REPORTS = 12;
    const RESULT_ID = 'analysis_result';
    const PANEL_ID = 'analyses-panel';
    const DIALOG_ID = 'analysis-report-dialog';

    let _mine = [];
    let _reports = [];
    let _current = null;     // { report, image }
    let _areaMode = 'view';  // 'view' | 'code'

    // ── storage ─────────────────────────────────────────────────────────────

    function _read(key) {
        try {
            const v = JSON.parse(localStorage.getItem(key));
            return Array.isArray(v) ? v : [];
        } catch { return []; }
    }
    function _write(key, v) {
        try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; }
    }

    /** Saved templates that still validate (bad entries are dropped, not fatal). */
    function loadMine() {
        return _read(STORE_KEY).map(t => Analysis.validate(t, null)).filter(v => v.ok).map(v => v.template);
    }

    /** Save (or overwrite by id) a user template. Returns the validation result. */
    function saveTemplate(tpl) {
        const v = Analysis.validate(tpl, typeof CellStore !== 'undefined' && CellStore.isEnabled() ? CellStore : null);
        if (!v.ok) return v;
        // Never shadow a built-in: a copy of one gets its own id.
        if (Analysis.builtin(v.template.id)) v.template.id = `${v.template.id}-mine`;
        _mine = loadMine().filter(t => t.id !== v.template.id).concat([{ ...v.template, savedAt: new Date().toISOString() }]);
        _write(STORE_KEY, _mine);
        return v;
    }

    function removeTemplate(id) {
        _mine = loadMine().filter(t => t.id !== id);
        _write(STORE_KEY, _mine);
    }

    /** Recent reports, newest first. Map images are not stored (size). */
    function loadReports() {
        return _read(REPORTS_KEY).filter(r => r && r.schema === Analysis.REPORT_SCHEMA && r.analysis && r.area);
    }

    function _keepReport(report) {
        const key = (r) => `${r.analysis.id}|${Analysis.areaParam(r.area)}`;
        _reports = [report, ...loadReports().filter(r => key(r) !== key(report))].slice(0, MAX_REPORTS);
        if (!_write(REPORTS_KEY, _reports)) {
            // Storage full: keep fewer rather than none.
            _reports = _reports.slice(0, 3);
            _write(REPORTS_KEY, _reports);
        }
    }

    function all() { return [...Analysis.BUILTINS, ..._mine]; }

    // ── running ─────────────────────────────────────────────────────────────

    function _map() { return (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null; }

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind || 'info');
    }

    /** Wait (up to `ms`) for the cell-store catalog so a shared link can run on load. */
    function _storeReady(ms = 10000) {
        if (typeof CellStore === 'undefined') return Promise.resolve(false);
        if (CellStore.datasets().length) return Promise.resolve(true);
        return new Promise(resolve => {
            const off = CellStore.onChange(() => { off(); clearTimeout(t); resolve(true); });
            const t = setTimeout(() => { off(); resolve(false); }, ms);
        });
    }

    function _shareUrl(tpl, area) {
        const q = Analysis.shareQuery(tpl, area);
        if (typeof window === 'undefined') return `?${q}`;
        const { origin, pathname } = window.location;
        return `${origin}${pathname}?${q}`;
    }

    /** The area currently chosen in the panel. */
    function currentArea() {
        if (_areaMode === 'code') {
            const el = document.getElementById('an-area-code');
            return Analysis.parseArea({ code: el ? el.value : '' });
        }
        const map = _map();
        if (!map || !map.getBounds) return null;
        const b = map.getBounds();
        return Analysis.parseArea({ bbox: { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, label: 'Map view' });
    }

    /** Run a template over an area, paint it, open the report. */
    async function runTemplate(tpl, area, opts = {}) {
        area = Analysis.parseArea(area);
        if (!area) { _toast('Pick an area', 'Enter a DIGIPIN prefix (for example 34P-LL5) or use the map view.', 'warning'); return null; }
        await _storeReady();
        if (typeof CellStore === 'undefined' || !CellStore.datasets().length) {
            _toast('No cell data', 'The per-cell data store is not available, so analyses cannot run.', 'warning');
            return null;
        }
        _toast('Running analysis', `${tpl.title} · ${area.label}`, 'info');
        const store = { get: CellStore.get, load: CellStore.load, generated: () => CellStore.generated() };
        let report;
        try {
            report = await Analysis.run(tpl, area, store, { link: (t) => _shareUrl({ ...t, builtin: !!tpl.builtin }, area) });
        } catch (err) {
            _toast('Analysis failed', err.message || String(err), 'error');
            return null;
        }
        _keepReport(report);
        const image = opts.paint === false ? null : await _paint(report);
        _current = { report, image };
        openReport(report, image);
        renderPanel();
        return report;
    }

    /** Register the result as a runtime cell dataset, extrude it, frame the area, snapshot. */
    async function _paint(report) {
        const layer = report.map && report.map.layer;
        const map = _map();
        if (!layer || !map || typeof CellStore === 'undefined' || typeof CellLayers === 'undefined') return null;
        const f = layer.field;
        CellStore.register({
            id: RESULT_ID,
            title: `${report.analysis.title}: ${f.label}`,
            description: `Result of the "${report.analysis.title}" analysis over ${report.area.label}.`,
            source: 'js/analysis.js', license: 'Derived from the cell store', group: 'Analysis results',
            level: layer.level,
            fields: [{ key: f.key, label: f.label, type: 'number', agg: 'mean', unit: f.unit, ramp: f.higherIs === 'worse' ? 'reds' : 'viridis', higherIs: f.higherIs }],
            default: { field: f.key, extrude: true, heightM: layer.level >= 7 ? 250 : 600 },
        }, { level: layer.level, cells: layer.values.map(v => v[0]), columns: { [f.key]: layer.values.map(v => v[1]) } });
        await CellLayers.show(RESULT_ID, { field: f.key, extrude: true });
        const b = report.area.bbox;
        try {
            map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, pitch: 50, duration: 0, maxZoom: 16 });
        } catch { /* map not ready */ }
        return _snapshot(map);
    }

    /** PNG of the map once it has drawn the result, or null (tainted canvas, timeout). */
    function _snapshot(map) {
        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try {
                    const url = map.getCanvas().toDataURL('image/png');
                    resolve(url && url.length > 2000 ? url : null);
                } catch { resolve(null); }
            };
            map.once('idle', finish);
            setTimeout(finish, 4000);
        });
    }

    function clearResult() {
        if (typeof CellLayers !== 'undefined' && CellLayers.isVisible(RESULT_ID)) CellLayers.hide(RESULT_ID);
        if (typeof CellStore !== 'undefined' && CellStore.isLocal(RESULT_ID)) CellStore.unregister(RESULT_ID);
    }

    // ── files ───────────────────────────────────────────────────────────────

    function _download(name, text, type) {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function _fileBase(report) {
        const area = report.area.kind === 'prefix' ? report.area.code : 'map-view';
        return `${Analysis.slug(report.analysis.title)}_${area}_${report.ranAt.slice(0, 10)}`;
    }

    function _copy(text, label) {
        const ok = () => _toast('Link copied', label || 'Anyone with the link re-runs this analysis on open.', 'success');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok).catch(() => window.prompt('Copy this link:', text));
        } else {
            window.prompt('Copy this link:', text);
        }
    }

    function exportTemplate(tpl) {
        const { builtin: _b, savedAt: _s, ...clean } = tpl;
        _download(`${clean.id}.analysis.json`, JSON.stringify(clean, null, 2), 'application/json');
    }

    function _import(file) {
        const reader = new FileReader();
        reader.onload = () => {
            let parsed;
            try { parsed = JSON.parse(reader.result); } catch { _toast('Import failed', 'That file is not valid JSON.', 'error'); return; }
            const v = saveTemplate(parsed);
            if (v.ok) { _toast('Analysis imported', `"${v.template.title}" is in My analyses.`, 'success'); renderPanel(); }
            else _toast('Import failed', v.errors.slice(0, 3).join(' '), 'error');
        };
        reader.readAsText(file);
    }

    // ── panel ───────────────────────────────────────────────────────────────

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function _btn(label, onClick, cls) {
        const b = _el('button', cls || 'an-btn', label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    }

    function _defaultCode() {
        const sel = (typeof MapModule !== 'undefined' && MapModule.getSelectedCode) ? MapModule.getSelectedCode() : null;
        // A selected cell's level-6 parent (~1 km) is a sensible neighbourhood.
        return sel ? DigiPin.format(String(sel).replace(/-/g, '').slice(0, 6)) : '';
    }

    function _areaPicker() {
        const box = _el('div', 'an-area');
        box.appendChild(_el('div', 'an-label', 'Area'));
        const row = _el('div', 'an-area-row');
        const mk = (mode, label) => {
            const id = `an-area-${mode}`;
            const wrap = _el('label', 'an-radio');
            const r = document.createElement('input');
            r.type = 'radio'; r.name = 'an-area'; r.value = mode; r.id = id;
            r.checked = _areaMode === mode;
            r.addEventListener('change', () => { _areaMode = mode; renderPanel(); });
            wrap.appendChild(r);
            wrap.appendChild(document.createTextNode(` ${label}`));
            return wrap;
        };
        row.appendChild(mk('view', 'Map view'));
        row.appendChild(mk('code', 'DIGIPIN area'));
        box.appendChild(row);
        if (_areaMode === 'code') {
            const input = document.createElement('input');
            input.id = 'an-area-code';
            input.className = 'an-input';
            input.placeholder = 'e.g. 34P-LL5 (4–8 characters)';
            input.setAttribute('aria-label', 'DIGIPIN prefix of the area');
            input.value = _defaultCode();
            box.appendChild(input);
            box.appendChild(_el('div', 'an-hint', '5 characters ≈ 4 km, 6 ≈ 1 km, 7 ≈ 250 m.'));
        } else {
            box.appendChild(_el('div', 'an-hint', 'Runs over every cell visible on the map.'));
        }
        return box;
    }

    function _templateRow(tpl, isMine) {
        const item = _el('div', 'an-item');
        const info = _el('div', 'an-info');
        info.appendChild(_el('div', 'an-title', tpl.title));
        if (tpl.description) info.appendChild(_el('div', 'an-desc', tpl.description));
        const kinds = [...new Set(tpl.sections.map(s => s.type))].join(' · ');
        info.appendChild(_el('div', 'an-meta', `${tpl.sections.length} sections · ${kinds}`));
        item.appendChild(info);
        const actions = _el('div', 'an-actions');
        actions.appendChild(_btn('Run', () => runTemplate(tpl, currentArea()), 'an-btn an-btn--primary'));
        actions.appendChild(_btn(isMine ? 'Edit' : 'Copy', () => openEditor(isMine ? tpl : { ...tpl, id: `${tpl.id}-copy`, title: `${tpl.title} (copy)` })));
        actions.appendChild(_btn('Export', () => exportTemplate(tpl)));
        if (isMine) {
            actions.appendChild(_btn('Delete', () => {
                if (window.confirm(`Delete "${tpl.title}"?`)) { removeTemplate(tpl.id); renderPanel(); }
            }, 'an-btn an-btn--danger'));
        }
        item.appendChild(actions);
        return item;
    }

    function _reportRow(r) {
        const item = _el('div', 'an-item an-item--report');
        const info = _el('div', 'an-info');
        info.appendChild(_el('div', 'an-title', r.analysis.title));
        const when = new Date(r.ranAt);
        info.appendChild(_el('div', 'an-meta', `${r.area.label} · ${isNaN(when) ? r.ranAt : when.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`));
        item.appendChild(info);
        const actions = _el('div', 'an-actions');
        actions.appendChild(_btn('Open', () => { _current = { report: r, image: null }; openReport(r, null); }));
        actions.appendChild(_btn('Re-run', () => rerun(r)));
        item.appendChild(actions);
        return item;
    }

    function rerun(report) {
        const tpl = (report.analysis.builtin && Analysis.builtin(report.analysis.id)) || report.template;
        return runTemplate(tpl, report.area);
    }

    function renderPanel() {
        const list = document.getElementById('analyses-list');
        if (!list) return;
        list.replaceChildren();
        list.appendChild(_areaPicker());

        const tools = _el('div', 'an-tools');
        tools.appendChild(_btn('+ New analysis', () => openEditor(null), 'an-btn an-btn--primary'));
        const file = document.createElement('input');
        file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
        file.addEventListener('change', () => { if (file.files[0]) _import(file.files[0]); file.value = ''; });
        tools.appendChild(file);
        tools.appendChild(_btn('Import JSON', () => file.click()));
        if (typeof CellLayers !== 'undefined' && CellLayers.isVisible(RESULT_ID)) {
            tools.appendChild(_btn('Clear result layer', () => { clearResult(); renderPanel(); }));
        }
        list.appendChild(tools);

        if (_mine.length) {
            list.appendChild(_el('div', 'sv-templates-header', 'My analyses'));
            _mine.forEach(t => list.appendChild(_templateRow(t, true)));
        }
        list.appendChild(_el('div', 'sv-templates-header', 'Templates'));
        Analysis.BUILTINS.forEach(t => list.appendChild(_templateRow(t, false)));

        _reports = loadReports();
        if (_reports.length) {
            list.appendChild(_el('div', 'sv-templates-header', 'Recent reports'));
            _reports.forEach(r => list.appendChild(_reportRow(r)));
        }
    }

    function openPanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        _mine = loadMine();
        panel.classList.add('open');
        renderPanel();
    }

    function closePanel() {
        const panel = document.getElementById(PANEL_ID);
        if (panel) panel.classList.remove('open');
    }

    // ── editor (JSON, validated against the live store) ─────────────────────

    function _skeleton() {
        return {
            title: 'My analysis',
            description: 'What this analysis answers.',
            sections: [
                { type: 'index', title: 'My index', limit: 10, terms: [
                    { dataset: 'scores', field: 'livability', weight: 2 },
                    { dataset: 'scores', field: 'flood_risk', weight: 1 },
                ] },
                { type: 'summary', title: 'Averages', dataset: 'scores', fields: ['livability', 'flood_risk'] },
            ],
        };
    }

    function _fieldGuide() {
        if (typeof CellStore === 'undefined') return '';
        return CellStore.datasets().filter(d => d.id !== RESULT_ID)
            .map(d => `${d.id} (L${d.level}): ${d.fields.map(f => f.key).join(', ')}`).join('\n');
    }

    function openEditor(tpl) {
        const dlg = _dialog();
        const body = dlg.querySelector('.an-dlg-body');
        dlg.querySelector('.an-dlg-title').textContent = tpl ? `Edit: ${tpl.title}` : 'New analysis';
        const bar = dlg.querySelector('.an-dlg-bar');
        bar.replaceChildren();
        body.replaceChildren();
        const help = _el('p', 'an-hint', `Section types: ${Analysis.SECTION_TYPES.join(', ')}. Operators for filter rules: ${Analysis.OPS.join(' ')}. Fields marked "higher is worse" are inverted in an index.`);
        const ta = document.createElement('textarea');
        ta.className = 'an-json';
        ta.spellcheck = false;
        ta.setAttribute('aria-label', 'Analysis template JSON');
        const { builtin: _b, savedAt: _s, ...clean } = tpl || _skeleton();
        ta.value = JSON.stringify(clean, null, 2);
        const guide = _el('details', 'an-guide');
        guide.appendChild(_el('summary', null, 'Datasets and fields'));
        guide.appendChild(_el('pre', null, _fieldGuide() || 'The cell store has not loaded yet.'));
        const errs = _el('div', 'an-errors');
        errs.setAttribute('role', 'alert');
        body.append(help, ta, guide, errs);
        const parse = () => {
            try { return JSON.parse(ta.value); } catch (e) { errs.textContent = `JSON error: ${e.message}`; return null; }
        };
        bar.appendChild(_btn('Save', () => {
            const t = parse();
            if (!t) return;
            const v = saveTemplate(t);
            if (!v.ok) { errs.textContent = v.errors.join(' '); return; }
            _toast('Analysis saved', `"${v.template.title}" is in My analyses.`, 'success');
            closeDialog();
            renderPanel();
        }, 'an-btn an-btn--primary'));
        bar.appendChild(_btn('Run without saving', () => {
            const t = parse();
            if (!t) return;
            const v = Analysis.validate(t, CellStore);
            if (!v.ok) { errs.textContent = v.errors.join(' '); return; }
            runTemplate(v.template, currentArea());
        }));
        bar.appendChild(_btn('Close', closeDialog));
        dlg.classList.add('open');
        ta.focus();
    }

    // ── report dialog ───────────────────────────────────────────────────────

    function _dialog() {
        let dlg = document.getElementById(DIALOG_ID);
        if (dlg) return dlg;
        dlg = _el('div', 'an-dialog');
        dlg.id = DIALOG_ID;
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-modal', 'false');
        dlg.setAttribute('aria-labelledby', `${DIALOG_ID}-title`);
        const head = _el('div', 'an-dlg-head');
        const h = _el('h3', 'an-dlg-title');
        h.id = `${DIALOG_ID}-title`;
        const x = _btn('✕', closeDialog, 'close-btn');
        x.setAttribute('aria-label', 'Close');
        head.append(h, x);
        dlg.append(head, _el('div', 'an-dlg-bar'), _el('div', 'an-dlg-body'));
        document.body.appendChild(dlg);
        return dlg;
    }

    function closeDialog() {
        const dlg = document.getElementById(DIALOG_ID);
        if (dlg) dlg.classList.remove('open');
    }

    function isDialogOpen() {
        const dlg = document.getElementById(DIALOG_ID);
        return !!dlg && dlg.classList.contains('open');
    }

    function openReport(report, image) {
        const dlg = _dialog();
        dlg.querySelector('.an-dlg-title').textContent = `${report.analysis.title} · ${report.area.label}`;
        const bar = dlg.querySelector('.an-dlg-bar');
        bar.replaceChildren();
        const html = Analysis.toHTML(report, { image });
        const link = (report.map && report.map.link) || _shareUrl({ ...report.template, builtin: report.analysis.builtin }, report.area);
        bar.appendChild(_btn('Copy link', () => _copy(link)));
        bar.appendChild(_btn('Download HTML', () => _download(`${_fileBase(report)}.html`, html, 'text/html')));
        bar.appendChild(_btn('Download JSON', () => _download(`${_fileBase(report)}.report.json`, JSON.stringify(report, null, 2), 'application/json')));
        bar.appendChild(_btn('Print', () => {
            const f = dlg.querySelector('iframe');
            if (f && f.contentWindow) f.contentWindow.print();
        }));
        bar.appendChild(_btn('Re-run', () => rerun(report)));
        if (report.map && report.map.layer && !(typeof CellLayers !== 'undefined' && CellLayers.isVisible(RESULT_ID))) {
            bar.appendChild(_btn('Show on map', async () => { const img = await _paint(report); if (_current) _current.image = img; }));
        }
        const body = dlg.querySelector('.an-dlg-body');
        body.replaceChildren();
        const frame = document.createElement('iframe');
        frame.className = 'an-frame';
        frame.title = `${report.analysis.title} report`;
        frame.srcdoc = html;
        body.appendChild(frame);
        dlg.classList.add('open');
    }

    // ── init ────────────────────────────────────────────────────────────────

    async function _runFromLink() {
        if (typeof window === 'undefined') return;
        const shared = Analysis.parseShare(window.location.search);
        if (!shared) return;
        const map = _map();
        if (map && map.loaded && !map.loaded()) await new Promise(r => map.once('load', r));
        await runTemplate(shared.template, shared.area);
    }

    function init() {
        _mine = loadMine();
        _reports = loadReports();
        const btn = document.getElementById('btn-analyses');
        if (btn) btn.addEventListener('click', openPanel);
        _runFromLink();
    }

    return {
        init, openPanel, closePanel, renderPanel, openEditor, openReport, closeDialog, isDialogOpen,
        runTemplate, rerun, currentArea, clearResult, exportTemplate,
        loadMine, saveTemplate, removeTemplate, loadReports, all,
    };
})();

if (typeof window !== 'undefined') {
    window.AnalysesPanel = AnalysesPanel;
}
