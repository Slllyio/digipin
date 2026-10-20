/**
 * CellLayers — one renderer for every dataset in the cell-store registry
 * (js/cell-store.js, docs/CELL_STORE.md). No per-dataset layer code: the
 * catalog's field specs (type, domain, ramp, colors) drive the paint, so a
 * newly-built or user-dropped dataset is plottable the moment it's registered.
 *
 *   number   → interpolated colour ramp over the field's domain
 *   category → match expression (spec colours, else a qualitative palette)
 *   boolean  → highlight true cells
 *
 * Each dataset renders as 2D filled DIGIPIN cells or 3D extruded cells
 * (height ∝ value, `default.heightM` at the top of the domain), toggled live
 * from its legend. Standard overlay contract: idempotent show/hide/toggle,
 * one source + one layer per dataset, cleaned up on hide.
 *
 * mountPanel() adds a registry-driven group to the unified Layers dropdown,
 * re-rendered whenever the registry changes (catalog load, file dropped).
 * colorExpr/heightExpr/legendStops are pure and unit-tested.
 */
const CellLayers = (() => {
    const SRC = 'cell-layer-src-';
    const LYR = 'cell-layer-';
    const LEGEND_ID = 'cell-layer-legend';
    const NO_DATA = '#9ca3af';

    // 5-stop sequential ramps (low → high). Colour-blind-safe where possible.
    const RAMPS = {
        viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
        reds: ['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15'],
        greens: ['#edf8e9', '#bae4b3', '#74c476', '#31a354', '#006d2c'],
        blues: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'],
        heat: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'],
        diverging: ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'],
    };
    const QUALITATIVE = ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e',
        '#e6ab02', '#a6761d', '#666666', '#1f78b4', '#b2df8a', '#fb9a99', '#cab2d6'];

    const _active = new Map();   // id -> { field, extrude }
    let _map = null;
    let _popup = null;
    let _legendFor = null;       // dataset id the legend currently describes
    let _panel = null;           // { dropdown, group } once mounted

    function _map_() { return (typeof MapModule !== 'undefined') ? MapModule.getMap() : null; }

    function _domain(f) {
        const d = Array.isArray(f.domain) ? f.domain : null;
        if (f.type !== 'number') return d;
        if (!d || d.length !== 2 || !isFinite(d[0]) || !isFinite(d[1])) return [0, 1];
        return d[0] === d[1] ? [d[0], d[0] + 1] : d;
    }

    /** Categories of a category field, with a colour each. */
    function categoryColors(f) {
        const cats = Array.isArray(f.domain) ? f.domain : Object.keys(f.colors || {});
        return cats.map((c, i) => [String(c), (f.colors && f.colors[c]) || QUALITATIVE[i % QUALITATIVE.length]]);
    }

    /** MapLibre colour expression for a field spec. */
    function colorExpr(f) {
        const get = ['get', f.key];
        if (f.type === 'category') {
            const pairs = categoryColors(f);
            if (!pairs.length) return NO_DATA;
            return ['match', ['to-string', get], ...pairs.flat(), NO_DATA];
        }
        if (f.type === 'boolean') {
            return ['case', ['==', get, true], '#d7301f', 'rgba(0,0,0,0)'];
        }
        const [lo, hi] = _domain(f);
        const ramp = RAMPS[f.ramp] || RAMPS.viridis;
        const stops = [];
        ramp.forEach((c, i) => stops.push(lo + (hi - lo) * i / (ramp.length - 1), c));
        return ['case', ['==', get, null], NO_DATA,
            ['interpolate', ['linear'], ['to-number', get], ...stops]];
    }

    /** Extrusion height (m) expression: linear in the value for numbers. */
    function heightExpr(f, heightM) {
        const h = Number(heightM) || 400;
        const get = ['get', f.key];
        if (f.type === 'number') {
            const [lo, hi] = _domain(f);
            // Floor at 2% so the lowest cells still read as solid blocks.
            return ['*', h, ['max', 0.02, ['min', 1, ['/', ['-', ['to-number', get, lo], lo], hi - lo]]]];
        }
        if (f.type === 'boolean') return ['case', ['==', get, true], h, 0];
        return h * 0.35;
    }

    /** Legend rows [{ color, label }] for a field. */
    function legendStops(f) {
        if (f.type === 'category') return categoryColors(f).map(([c, color]) => ({ color, label: c }));
        if (f.type === 'boolean') return [{ color: '#d7301f', label: 'yes' }];
        const [lo, hi] = _domain(f);
        const ramp = RAMPS[f.ramp] || RAMPS.viridis;
        const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v)) ? String(Math.round(v)) : v.toFixed(2);
        return ramp.map((color, i) => ({ color, label: fmt(lo + (hi - lo) * i / (ramp.length - 1)) }));
    }

    function _esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ── map layers ──────────────────────────────────────────────────────────

    function _paint(spec, table, state) {
        const f = CellStore.field(spec, state.field) || spec.fields[0];
        const src = SRC + spec.id, lyr = LYR + spec.id;
        const data = CellStore.toGeoJSON(spec, table, f.key);
        if (_map.getSource(src)) _map.getSource(src).setData(data);
        else _map.addSource(src, { type: 'geojson', data });

        // 2D ↔ 3D swaps the layer type, so rebuild the layer (source is reused).
        if (_map.getLayer(lyr)) _map.removeLayer(lyr);
        if (state.extrude) {
            _map.addLayer({
                id: lyr, type: 'fill-extrusion', source: src,
                paint: {
                    'fill-extrusion-color': colorExpr(f),
                    'fill-extrusion-height': heightExpr(f, spec.default && spec.default.heightM),
                    'fill-extrusion-base': 0,
                    'fill-extrusion-opacity': 0.85,
                },
            });
            if (_map.getPitch && _map.getPitch() < 30 && _map.easeTo) _map.easeTo({ pitch: 55, duration: 600 });
        } else {
            _map.addLayer({
                id: lyr, type: 'fill', source: src,
                paint: {
                    'fill-color': colorExpr(f),
                    'fill-opacity': 0.6,
                    'fill-outline-color': 'rgba(255,255,255,0.25)',
                },
            });
        }
        _map.off('click', lyr, _onClick);
        _map.on('click', lyr, _onClick);
    }

    function _onClick(e) {
        const feat = e.features && e.features[0];
        if (!feat) return;
        const id = String(feat.layer && feat.layer.id || '').slice(LYR.length);
        const spec = CellStore.get(id);
        if (!spec) return;
        const p = feat.properties || {};
        const state = _active.get(id) || {};
        let html = `<div style="font-family:Inter,sans-serif;font-size:12px;max-width:260px;">`
            + `<strong>${_esc(spec.title)}</strong><br><span style="opacity:.7">${_esc(p.digipin)} · L${spec.level}</span>`;
        for (const f of spec.fields) {
            let v = p[f.key];
            if (v == null || v === 'null') continue;
            if (f.type === 'number' && !isNaN(v)) v = Math.round(Number(v) * 100) / 100;
            const bold = f.key === state.field ? 'font-weight:600;' : '';
            html += `<div style="${bold}">${_esc(f.label)}: ${_esc(v)}${f.unit && f.type === 'number' ? ' ' + _esc(f.unit) : ''}</div>`;
        }
        html += '</div>';
        if (_popup) _popup.remove();
        if (typeof maplibregl !== 'undefined') {
            _popup = new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(_map);
        }
    }

    /** Render a registry dataset. opts: { field, extrude }. Resolves true when painted. */
    async function show(id, opts = {}) {
        _map = _map_();
        if (!_map || typeof CellStore === 'undefined') return false;
        const spec = CellStore.get(id);
        if (!spec) return false;
        const prev = _active.get(id) || {};
        const def = spec.default || {};
        const state = {
            field: opts.field || prev.field || def.field || spec.fields[0].key,
            extrude: opts.extrude ?? prev.extrude ?? !!def.extrude,
        };
        _active.set(id, state);
        const table = await CellStore.load(id);
        if (!table) {
            _active.delete(id);
            if (typeof App !== 'undefined') App.showToast(spec.title, 'No data published for this layer yet.', 'info');
            _syncPanel();
            return false;
        }
        if (!_active.has(id)) return false;   // hidden while loading
        _paint(spec, table, state);
        _legendFor = id;
        _renderLegend();
        _syncPanel();
        return true;
    }

    function hide(id) {
        _active.delete(id);
        const map = _map_();
        if (map) {
            map.off('click', LYR + id, _onClick);
            if (map.getLayer(LYR + id)) map.removeLayer(LYR + id);
            if (map.getSource(SRC + id)) map.removeSource(SRC + id);
        }
        if (_legendFor === id) {
            _legendFor = [..._active.keys()].pop() || null;
            if (_popup) { _popup.remove(); _popup = null; }
            _renderLegend();
        }
        _syncPanel();
    }

    async function toggle(id, opts) {
        if (_active.has(id)) { hide(id); return false; }
        return show(id, opts);
    }

    function isVisible(id) { return _active.has(id); }
    function active() { return [..._active.keys()]; }
    function state(id) { return _active.has(id) ? { ..._active.get(id) } : null; }

    function setField(id, key) { return _active.has(id) ? show(id, { field: key }) : Promise.resolve(false); }
    function setExtrude(id, on) { return _active.has(id) ? show(id, { extrude: !!on }) : Promise.resolve(false); }

    function hideAll() { active().forEach(hide); }

    // ── legend (field picker + 2D/3D switch) ────────────────────────────────

    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }

    function _renderLegend() {
        if (typeof document === 'undefined') return;
        let el = document.getElementById(LEGEND_ID);
        const spec = _legendFor && CellStore.get(_legendFor);
        const st = spec && _active.get(spec.id);
        if (!spec || !st) { if (el) el.remove(); return; }
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            document.body.appendChild(el);
        }
        el.setAttribute('aria-label', `${spec.title} legend`);
        const pal = _palette();
        el.style.cssText = `position:absolute;bottom:36px;right:12px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:10px 12px;color:${pal.ink};`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);max-width:260px;';
        const f = CellStore.field(spec, st.field) || spec.fields[0];
        // "0-100"-style units restate the domain; only real units get a suffix.
        const unit = f.unit && !/^[\d.]+\s*[-–]\s*[\d.]+$/.test(f.unit) ? ' ' + _esc(f.unit) : '';
        const options = spec.fields.map(x =>
            `<option value="${_esc(x.key)}"${x.key === f.key ? ' selected' : ''}>${_esc(x.label)}</option>`).join('');
        const stops = legendStops(f);
        const swatches = f.type === 'number'
            ? `<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:6px;">${stops.map(s => `<span style="flex:1;background:${s.color}"></span>`).join('')}</div>`
              + `<div style="display:flex;justify-content:space-between;color:${pal.sub};font-size:11px;"><span>${_esc(stops[0].label)}</span><span>${_esc(stops[stops.length - 1].label)}${unit}</span></div>`
            : stops.map(s => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;"><span style="width:12px;height:12px;border-radius:2px;background:${s.color};flex:none;"></span><span style="color:${pal.sub};">${_esc(s.label)}</span></div>`).join('');
        const others = active().filter(id => id !== spec.id);
        const rebinnable = typeof CellIngest !== 'undefined' && CellIngest.isRebinnable(spec.id);
        el.innerHTML =
            `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">`
            + `<strong style="color:${pal.primary};font-size:13px;flex:1;">${_esc(spec.title)}</strong>`
            + `<button type="button" data-act="close" aria-label="Hide ${_esc(spec.title)}" style="background:none;border:none;color:${pal.sub};cursor:pointer;font-size:14px;">✕</button></div>`
            + `<select data-act="field" aria-label="Field to colour by" style="width:100%;margin-bottom:4px;">${options}</select>`
            + `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-act="extrude"${st.extrude ? ' checked' : ''}> 3D extruded cells</label>`
            + (rebinnable
                ? `<label style="display:flex;align-items:center;gap:6px;margin-top:2px;">Cell size <select data-act="level" aria-label="DIGIPIN level">${
                    [[5, '~3.9 km'], [6, '~1 km'], [7, '~244 m'], [8, '~61 m'], [9, '~15 m']].map(([L, m]) =>
                        `<option value="${L}"${L === spec.level ? ' selected' : ''}>L${L} · ${m}</option>`).join('')}</select></label>`
                : '')
            + swatches
            + `<div style="margin-top:6px;color:${pal.sub};font-size:11px;">DIGIPIN L${spec.level}${spec.approxCellM ? ` (~${spec.approxCellM} m cells)` : ''}${spec.source ? ' · ' + _esc(spec.source) : ''}</div>`
            + (others.length ? `<div style="margin-top:4px;font-size:11px;color:${pal.sub};">Also on: ${others.map(id => `<a href="#" data-act="focus" data-id="${_esc(id)}" style="color:${pal.primary};">${_esc((CellStore.get(id) || {}).title || id)}</a>`).join(', ')}</div>` : '');
        const id = spec.id;
        el.querySelector('[data-act="close"]').onclick = () => hide(id);
        el.querySelector('[data-act="field"]').onchange = (e) => setField(id, e.target.value);
        el.querySelector('[data-act="extrude"]').onchange = (e) => setExtrude(id, e.target.checked);
        const lvl = el.querySelector('[data-act="level"]');
        if (lvl) lvl.onchange = (e) => CellIngest.rebin(id, Number(e.target.value));
        el.querySelectorAll('[data-act="focus"]').forEach(a => {
            a.onclick = (e) => { e.preventDefault(); _legendFor = a.dataset.id; _renderLegend(); };
        });
    }

    // ── Layers-panel integration ────────────────────────────────────────────

    function _row(key, icon, name, onClick) {
        const item = document.createElement('div');
        item.className = 'dt-layer-item';
        item.dataset.layerKey = key;
        item.tabIndex = 0;
        item.setAttribute('role', 'switch');
        item.setAttribute('aria-checked', 'false');
        item.setAttribute('aria-label', name);
        item.innerHTML = '<span class="dt-layer-icon"></span><span class="dt-layer-name"></span>'
            + '<label class="dt-toggle-switch"><input type="checkbox" tabindex="-1" aria-hidden="true"><span class="dt-toggle-slider"></span></label>';
        item.querySelector('.dt-layer-icon').textContent = icon;
        item.querySelector('.dt-layer-name').textContent = name;
        item.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
        });
        // Source card (ⓘ) from the catalog's source/license — js/provenance.js.
        if (typeof Provenance !== 'undefined') Provenance.decorateRow(item);
        return item;
    }

    /** Rows for the registry, grouped by spec.group: [{ group, rows:[{id,title}] }]. */
    function panelGroups() {
        const groups = new Map();
        for (const d of CellStore.datasets()) {
            const g = d.group || 'Cell Data';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push({ id: d.id, title: d.title, level: d.level });
        }
        return [...groups].map(([group, rows]) => ({ group, rows }));
    }

    function _renderPanel() {
        if (!_panel) return;
        const { dropdown } = _panel;
        dropdown.querySelectorAll('.dt-layer-group[data-cell-store]').forEach(g => g.remove());
        const groups = panelGroups();
        if (!groups.some(g => g.group === 'Ingested data')) groups.push({ group: 'Ingested data', rows: [] });
        for (const { group, rows } of groups) {
            const groupDiv = document.createElement('div');
            groupDiv.className = 'dt-layer-group';
            groupDiv.dataset.cellStore = group;
            const header = document.createElement('button');
            header.className = 'dt-group-header-btn expanded';
            header.setAttribute('aria-expanded', 'true');
            header.innerHTML = '<span class="dt-group-title"></span><span class="dt-group-count"></span><span class="dt-group-chevron">▾</span>';
            header.querySelector('.dt-group-title').textContent = group;
            header.querySelector('.dt-group-count').textContent = String(rows.length);
            const content = document.createElement('div');
            content.className = 'dt-group-content open';
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = content.classList.toggle('open');
                header.classList.toggle('expanded', open);
                header.setAttribute('aria-expanded', String(open));
            });
            for (const r of rows) {
                content.appendChild(_row('_cell_' + r.id, '▦', `${r.title} · L${r.level}`, () => toggle(r.id)));
            }
            if (group === 'Ingested data' && typeof CellIngest !== 'undefined') {
                const add = _row('_cell_ingest', '➕', 'Plot a CSV / GeoJSON file…', () => CellIngest.pickFile());
                add.querySelector('.dt-toggle-switch').remove();
                add.setAttribute('role', 'button');
                add.removeAttribute('aria-checked');
                content.appendChild(add);
            }
            groupDiv.appendChild(header);
            groupDiv.appendChild(content);
            // Registry groups sit right after the search box, ahead of the static groups.
            const anchor = dropdown.querySelector('.dt-layer-group:not([data-cell-store])');
            dropdown.insertBefore(groupDiv, anchor);
        }
        _syncPanel();
    }

    function _syncPanel() {
        if (!_panel || typeof document === 'undefined') return;
        _panel.dropdown.querySelectorAll('.dt-layer-item[data-layer-key^="_cell_"]').forEach(item => {
            const id = item.dataset.layerKey.slice('_cell_'.length);
            const on = _active.has(id);
            const cb = item.querySelector('input[type=checkbox]');
            if (cb) cb.checked = on;
            if (item.getAttribute('role') === 'switch') item.setAttribute('aria-checked', String(on));
        });
    }

    /** Attach registry-driven rows to the Layers dropdown; idempotent. */
    function mountPanel(dropdown) {
        if (!dropdown || (_panel && _panel.dropdown === dropdown)) return;
        _panel = { dropdown };
        CellStore.onChange(_renderPanel);
        _renderPanel();
    }

    return {
        show, hide, toggle, hideAll, isVisible, active, state, setField, setExtrude,
        mountPanel, panelGroups, colorExpr, heightExpr, legendStops, categoryColors, RAMPS,
    };
})();

if (typeof window !== 'undefined') {
    window.CellLayers = CellLayers;
}
