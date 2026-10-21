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
 * Level of detail: a dataset renders at the DIGIPIN level that suits the zoom
 * (targetLevel), rolled up the hierarchy by CellStore.loadAt when that is
 * coarser than the data, so zoomed out you see ~1 km or ~4 km parents and
 * zoomed in the native cells. The legend's Detail picker pins a level.
 *
 * Category legends double as filters (click a row to hide that category), and
 * a click opens an inspector that pages through every active dataset's cell
 * under the pointer ("1 of N"), with a copy button and the dataset's source.
 *
 * Temporal datasets (spec.time) paint step `state.t` by pointing the colour
 * and height expressions at that step's feature property, so setTime() is a
 * setPaintProperty call — cheap enough to animate (js/time-slider.js drives
 * it). Their inspector shows the value at the current step plus an SVG chart
 * of the cell's whole series.
 *
 * mountPanel() adds a registry-driven group to the unified Layers dropdown,
 * re-rendered whenever the registry changes (catalog load, file dropped).
 * colorExpr/heightExpr/legendStops/filterExpr/inspectorRows/inspectorText/
 * propsAt/seriesOf/sparkline are pure and unit-tested.
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

    const _active = new Map();   // id -> { field, extrude, hidden:[category], cells }
    const _loading = new Set();   // ids whose parts are being fetched (Layers panel shows them busy)
    const GAPS = 'cellgaps:';          // DataStatus key prefix for a layer whose parts did not all load
    let _map = null;
    let _popup = null;
    let _legendFor = null;       // dataset id the legend currently describes
    let _panel = null;           // { dropdown, group } once mounted
    let _lastClick = null;       // originalEvent of the last handled click (one per click, not per layer)
    let _rerenderInspector = null;   // re-draws the open inspector (time changes)
    const _listeners = new Set();    // active-set / time changes (TimeSlider)

    function onChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
    function _emit() { _listeners.forEach(fn => { try { fn(); } catch { /* listener errors are theirs */ } }); }

    function _temporal(spec) { return typeof CellStore !== 'undefined' && CellStore.isTemporal(spec); }

    /** Index of the step a temporal dataset opens on (time.default, else the latest). */
    function defaultStep(spec) {
        if (!spec || !spec.time || !Array.isArray(spec.time.steps) || !spec.time.steps.length) return 0;
        const i = spec.time.steps.indexOf(spec.time.default);
        return i >= 0 ? i : spec.time.steps.length - 1;
    }

    /** The field spec as painted at step t: same styling, key → that step's property. */
    function fieldAt(f, t) { return { ...f, key: `${f.key}@${t}` }; }

    /** Feature props of a temporal cell reduced to one step: { digipin, key: value }. */
    function propsAt(spec, props, t) {
        const p = props || {};
        const out = { digipin: p.digipin };
        for (const f of spec.fields || []) {
            const v = p[`${f.key}@${t}`];
            out[f.key] = v === 'null' ? null : v;
        }
        return out;
    }

    /** A temporal cell's series for one field, aligned with spec.time.steps. */
    function seriesOf(spec, props, key) {
        const n = (spec.time && spec.time.steps && spec.time.steps.length) || 0;
        const p = props || {};
        return Array.from({ length: n }, (_, t) => {
            const v = p[`${key}@${t}`];
            return v == null || v === 'null' || !isFinite(v) ? null : Number(v);
        });
    }

    /**
     * Line chart geometry for a series with gaps: { path, points, lo, hi }.
     * points[i] is [x, y] or null; path breaks at nulls. y is flipped (SVG).
     */
    function sparkline(values, w, h, domain) {
        const present = values.filter(v => v != null);
        let [lo, hi] = Array.isArray(domain) && domain.length === 2 ? domain : [Math.min(...present), Math.max(...present)];
        if (!present.length) return { path: '', points: values.map(() => null), lo: 0, hi: 1 };
        lo = Math.min(lo, ...present); hi = Math.max(hi, ...present);
        if (hi === lo) hi = lo + 1;
        const n = values.length;
        const x = i => (n > 1 ? (i * w) / (n - 1) : w / 2);
        const y = v => h - ((v - lo) / (hi - lo)) * h;
        const r = v => Math.round(v * 10) / 10;
        const points = values.map((v, i) => (v == null ? null : [r(x(i)), r(y(v))]));
        let path = '', pen = false;
        points.forEach(pt => {
            if (!pt) { pen = false; return; }
            path += `${pen ? 'L' : 'M'}${pt[0]} ${pt[1]}`;
            pen = true;
        });
        return { path, points, lo, hi };
    }

    function _map_() { return (typeof MapModule !== 'undefined') ? MapModule.getMap() : null; }

    /**
     * Level to draw a dataset at for a zoom: one level finer than the grid
     * (DigiPin.levelForZoom), never finer than the data. `pinned` overrides.
     */
    function targetLevel(spec, zoom, pinned) {
        const native = spec.level;
        if (pinned) return Math.max(1, Math.min(native, pinned));
        if (zoom == null || typeof DigiPin === 'undefined' || !DigiPin.levelForZoom) return native;
        return Math.max(1, Math.min(native, DigiPin.levelForZoom(zoom) + 1));
    }

    /**
     * A field spec fit for a rolled-up table: sum/count fields grow with the
     * parent's size, so their legend domain is re-derived from the data.
     */
    function fieldAtLevel(f, table) {
        if (!f || !table || !table.counts || f.type !== 'number' || !['sum', 'count'].includes(f.agg)) return f;
        const d = CellStore.dataDomain(f, (table.columns[f.key] || []).flat());
        return d ? { ...f, domain: d } : f;
    }

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

    /**
     * Layer filter hiding the given categories of a category field, or null
     * when nothing is hidden (or the field isn't categorical).
     */
    function filterExpr(f, hidden) {
        if (!f || f.type !== 'category' || !hidden || !hidden.length) return null;
        return ['!', ['in', ['to-string', ['get', f.key]], ['literal', hidden.map(String)]]];
    }

    function _fmtValue(f, v) {
        if (f.type === 'number' && !isNaN(v)) v = Math.round(Number(v) * 100) / 100;
        const unit = f.unit && f.type === 'number' && !/^[\d.]+\s*[-–]\s*[\d.]+$/.test(f.unit) ? ' ' + f.unit : '';
        return String(v) + unit;
    }

    /** Inspector rows for one cell: [{ label, value, primary }], empty values skipped. */
    function inspectorRows(spec, props, activeField) {
        const p = props || {};
        return (spec.fields || [])
            .filter(f => p[f.key] != null && p[f.key] !== 'null' && p[f.key] !== '')
            .map(f => ({ label: f.label || f.key, value: _fmtValue(f, p[f.key]), primary: f.key === activeField }));
    }

    /** Plain-text copy of one cell: title, DIGIPIN, then one "label: value" line per field. */
    function inspectorText(spec, props) {
        const p = props || {};
        const head = `${spec.title} \u00b7 ${p.digipin || ''} \u00b7 L${p.level || spec.level}`
            + (p.cells ? ` (${p.cells} \u00d7 L${spec.level} cells)` : '');
        const lines = inspectorRows(spec, p).map(r => `${r.label}: ${r.value}`);
        if (spec.source) lines.push(`Source: ${spec.source}${spec.license ? ' (' + spec.license + ')' : ''}`);
        return [head, ...lines].join('\n');
    }

    function _esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ── map layers ──────────────────────────────────────────────────────────

    /** Id of the first 3D-building layer in the style (flat layers go under it), or undefined. */
    function _belowBuildings() {
        const layers = (_map.getStyle && _map.getStyle() && _map.getStyle().layers) || [];
        const l = layers.find(x => x.type === 'fill-extrusion' && !x.id.startsWith(LYR));
        return l ? l.id : undefined;
    }

    function _paint(spec, table, state) {
        const base = fieldAtLevel(CellStore.field(spec, state.field) || spec.fields[0], table);
        const f = _temporal(spec) ? fieldAt(base, state.t) : base;
        const src = SRC + spec.id, lyr = LYR + spec.id;
        const data = CellStore.toGeoJSON(spec, table, base.key);
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
            // A flat fill isn't depth-tested: drawn after the 3D buildings it
            // would paint straight over them, so it goes beneath the first one.
            _map.addLayer({
                id: lyr, type: 'fill', source: src,
                paint: {
                    'fill-color': colorExpr(f),
                    'fill-opacity': 0.6,
                    'fill-outline-color': 'rgba(255,255,255,0.25)',
                },
            }, _belowBuildings());
        }
        state.effField = f;
        const filter = filterExpr(f, state.hidden);
        if (filter) _map.setFilter(lyr, filter);
        _map.off('click', lyr, _onClick);
        _map.on('click', lyr, _onClick);
    }

    /** Every active dataset's cell under the click, top layer first: [{ spec, props }]. */
    function _cellsAt(e) {
        const layers = active().map(id => LYR + id).filter(l => _map.getLayer(l));
        const hits = layers.length && _map.queryRenderedFeatures ? _map.queryRenderedFeatures(e.point, { layers }) : [];
        const seen = new Set();
        const out = [];
        for (const feat of (hits.length ? hits : (e.features || []))) {
            const id = String(feat.layer && feat.layer.id || '').slice(LYR.length);
            const spec = CellStore.get(id);
            if (!spec || seen.has(id)) continue;
            seen.add(id);
            out.push({ spec, props: feat.properties || {} });
        }
        return out;
    }

    function _onClick(e) {
        // Each active layer has its own click listener; handle one click once.
        if (e.originalEvent && e.originalEvent === _lastClick) return;
        _lastClick = e.originalEvent || null;
        const pages = _cellsAt(e);
        if (!pages.length || typeof document === 'undefined') return;
        let i = 0;
        const box = document.createElement('div');
        box.className = 'cell-inspector';
        const render = () => {
            const { spec, props: raw } = pages[i];
            const st = _active.get(spec.id) || {};
            const temporal = _temporal(spec);
            const t = st.t ?? defaultStep(spec);
            const props = temporal ? propsAt(spec, raw, t) : raw;
            box.textContent = '';
            const head = document.createElement('div');
            head.className = 'cell-inspector-head';
            const title = document.createElement('strong');
            title.textContent = spec.title;
            head.appendChild(title);
            if (pages.length > 1) {
                const nav = document.createElement('span');
                nav.className = 'cell-inspector-nav';
                const prev = document.createElement('button');
                prev.type = 'button';
                prev.textContent = '\u2039';
                prev.setAttribute('aria-label', 'Previous layer');
                prev.onclick = () => { i = (i + pages.length - 1) % pages.length; render(); };
                const count = document.createElement('span');
                count.textContent = `${i + 1} of ${pages.length}`;
                const next = document.createElement('button');
                next.type = 'button';
                next.textContent = '\u203a';
                next.setAttribute('aria-label', 'Next layer');
                next.onclick = () => { i = (i + 1) % pages.length; render(); };
                nav.append(prev, count, next);
                head.appendChild(nav);
            }
            box.appendChild(head);
            const sub = document.createElement('div');
            sub.className = 'cell-inspector-sub';
            sub.textContent = `${props.digipin || ''} \u00b7 L${props.level || spec.level}`
                + (props.cells ? ` \u00b7 rolled up from ${props.cells} L${spec.level} cells` : '')
                + (temporal ? ` \u00b7 ${spec.time.steps[t]}` : '');
            box.appendChild(sub);
            const dl = document.createElement('dl');
            inspectorRows(spec, props, st.field).forEach(r => {
                const dt = document.createElement('dt');
                dt.textContent = r.label;
                const dd = document.createElement('dd');
                dd.textContent = r.value;
                if (r.primary) { dt.classList.add('primary'); dd.classList.add('primary'); }
                dl.append(dt, dd);
            });
            box.appendChild(dl);
            if (temporal) box.appendChild(_chart(spec, raw, st.field || (spec.default || {}).field || spec.fields[0].key, t));
            const foot = document.createElement('div');
            foot.className = 'cell-inspector-foot';
            if (spec.source) {
                const src = document.createElement('span');
                src.textContent = 'Source: ' + spec.source;
                foot.appendChild(src);
            }
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.textContent = 'Copy';
            copy.onclick = () => {
                const text = inspectorText(spec, props)
                    + (temporal ? '\n' + seriesText(spec, raw) : '');
                const done = () => { copy.textContent = 'Copied'; };
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => {});
            };
            foot.appendChild(copy);
            box.appendChild(foot);
        };
        render();
        if (_popup) _popup.remove();
        _rerenderInspector = render;
        if (typeof maplibregl !== 'undefined') {
            _popup = new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(e.lngLat).setDOMContent(box).addTo(_map);
            const popup = _popup;
            popup.on && popup.on('close', () => { if (_popup === popup) _rerenderInspector = null; });
        }
    }

    /** CSV-ish copy of a temporal cell: "step,field1,field2" rows. */
    function seriesText(spec, props) {
        const keys = spec.fields.map(f => f.key);
        const cols = keys.map(k => seriesOf(spec, props, k));
        return [['step', ...keys].join(','),
            ...spec.time.steps.map((s, t) => [s, ...cols.map(c => (c[t] == null ? '' : c[t]))].join(','))].join('\n');
    }

    /** Inline SVG history chart of one field for the inspector; marks step t. */
    function _chart(spec, props, key, t) {
        const f = CellStore.field(spec, key) || spec.fields[0];
        const W = 240, H = 64, PAD = 4;
        const vals = seriesOf(spec, props, f.key);
        // The cell's own range, so its seasonal swing is legible; the map
        // colours keep the dataset-wide domain for cross-cell comparison.
        const sp = sparkline(vals, W - 2 * PAD, H - 2 * PAD);
        const pal = _palette();
        const steps = spec.time.steps;
        const cur = sp.points[t];
        const fmt = v => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
        const wrap = document.createElement('div');
        wrap.className = 'cell-inspector-chart';
        const dots = sp.points.map((p, i) => (p ? `<circle cx="${p[0]}" cy="${p[1]}" r="${i === t ? 3.5 : 1.6}" fill="${i === t ? pal.primary : 'currentColor'}"/>` : '')).join('');
        const xt = PAD + (steps.length > 1 ? (t * (W - 2 * PAD)) / (steps.length - 1) : (W - 2 * PAD) / 2);
        wrap.innerHTML =
            `<div class="cell-inspector-chart-head"><span>${_esc(f.label || f.key)} history</span><span>${cur ? _esc(_fmtValue(f, vals[t])) : 'no data'}</span></div>`
            + `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${_esc(f.label || f.key)} by ${_esc(spec.time.unit)}, ${_esc(steps[0])} to ${_esc(steps[steps.length - 1])}">`
            + `<line x1="${xt}" x2="${xt}" y1="0" y2="${H}" stroke="${pal.primary}" stroke-opacity="0.45" stroke-dasharray="2 2"/>`
            + `<g transform="translate(${PAD},${PAD})"><path d="${sp.path}" fill="none" stroke="currentColor" stroke-opacity="0.75" stroke-width="1.5"/>${dots}</g></svg>`
            + `<div class="cell-inspector-chart-axis"><span>${_esc(steps[0])}</span><span>${_esc(fmt(sp.lo))} – ${_esc(fmt(sp.hi))}</span><span>${_esc(steps[steps.length - 1])}</span></div>`;
        return wrap;
    }

    /** Render a registry dataset. opts: { field, extrude }. Resolves true when painted. */
    async function show(id, opts = {}) {
        _map = _map_();
        if (!_map || typeof CellStore === 'undefined') return false;
        const spec = CellStore.get(id);
        if (!spec) return false;
        const prev = _active.get(id) || {};
        const def = spec.default || {};
        const field = opts.field || prev.field || def.field || spec.fields[0].key;
        const state = {
            field,
            pinned: opts.pinned !== undefined ? opts.pinned : (prev.pinned || null),
            level: prev.level || spec.level,
            extrude: opts.extrude ?? prev.extrude ?? !!def.extrude,
            // Hidden categories belong to one field; switching field shows all again.
            hidden: field === prev.field ? (opts.hidden || prev.hidden || []) : (opts.hidden || []),
            cells: prev.cells || 0,
            t: Math.min(opts.t ?? prev.t ?? defaultStep(spec), Math.max(0, ((spec.time && spec.time.steps) || [0]).length - 1)),
        };
        _active.set(id, state);
        _watchZoom();
        state.level = targetLevel(spec, _map.getZoom ? _map.getZoom() : null, state.pinned);
        // Only the regions / shards in view (plus a margin) are fetched.
        const view = _viewBbox();
        state.viewKey = _viewKey(spec, view);
        _loading.add(id);
        _syncPanel();
        let table = null;
        try { table = await CellStore.loadAt(id, state.level, view); }
        finally { _loading.delete(id); }
        const miss = (CellStore.lastLoad && CellStore.lastLoad(id)) || null;
        // A view whose every part failed is an empty table, not null: treat it
        // as the failure it is rather than painting nothing and reporting success.
        if (table && !(table.cells && table.cells.length) && miss && miss.unreachable) table = null;
        if (!table) {
            _active.delete(id);
            if (miss && miss.unreachable) _reportGaps(id, spec, miss);
            else if (typeof App !== 'undefined') App.showToast(spec.title, 'No data published for this layer yet.', 'info');
            _syncPanel();
            return false;
        }
        if (_active.get(id) !== state) return false;   // hidden or re-shown while loading
        if (miss && miss.unreachable) _reportGaps(id, spec, miss);
        else if (typeof DataStatus !== 'undefined') DataStatus.clear(GAPS + id);
        state.level = table.level;
        state.cells = (table.cells && table.cells.length) || 0;
        _paint(spec, table, state);
        _legendFor = id;
        _renderLegend();
        _syncPanel();
        _emit();
        return true;
    }

    /**
     * Point a temporal dataset at step t: two setPaintProperty calls, no
     * setData, so it's cheap enough to run per animation frame.
     */
    function setTime(id, t) {
        const st = _active.get(id);
        const spec = CellStore.get(id);
        if (!st || !_temporal(spec)) return false;
        const n = spec.time.steps.length;
        t = Math.max(0, Math.min(n - 1, Math.round(Number(t) || 0)));
        if (t === st.t) return true;
        st.t = t;
        const map = _map_();
        const lyr = LYR + id;
        if (map && map.getLayer(lyr)) {
            const f = fieldAt(CellStore.field(spec, st.field) || spec.fields[0], t);
            if (st.extrude) {
                map.setPaintProperty(lyr, 'fill-extrusion-color', colorExpr(f));
                map.setPaintProperty(lyr, 'fill-extrusion-height', heightExpr(f, spec.default && spec.default.heightM));
            } else {
                map.setPaintProperty(lyr, 'fill-color', colorExpr(f));
            }
        }
        if (_legendFor === id) _renderLegend();
        if (_rerenderInspector) _rerenderInspector();
        return true;
    }

    /**
     * Part of a layer's data did not arrive (timeout, dropped connection,
     * 5xx): say which layer and how much, persistently, with a Retry that
     * refetches just the failed parts (the store forgets them).
     */
    function _reportGaps(id, spec, miss) {
        if (typeof DataStatus === 'undefined') return;
        const all = miss.unreachable >= miss.of;
        const text = all
            ? `${spec.title}: the cell data did not load — check the connection.`
            : `${spec.title}: ${miss.unreachable} of ${miss.of} data parts did not load — the map has gaps.`;
        DataStatus.set(GAPS + id, { kind: 'warning', text, action: { label: 'Retry', busy: 'Loading…', run: () => show(id) } });
    }

    function hide(id) {
        _active.delete(id);
        if (typeof DataStatus !== 'undefined') DataStatus.clear(GAPS + id);
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
        _emit();
    }

    async function toggle(id, opts) {
        if (_active.has(id)) { hide(id); return false; }
        return show(id, opts);
    }

    function isVisible(id) { return _active.has(id); }
    function active() { return [..._active.keys()]; }
    function state(id) { return _active.has(id) ? { ..._active.get(id) } : null; }

    /** Show/hide one category of the dataset's current field (legend row click). */
    function toggleCategory(id, label) {
        const st = _active.get(id);
        const spec = CellStore.get(id);
        if (!st || !spec) return false;
        const f = CellStore.field(spec, st.field) || spec.fields[0];
        const hidden = new Set(st.hidden || []);
        if (hidden.has(label)) hidden.delete(label); else hidden.add(label);
        st.hidden = [...hidden];
        const map = _map_();
        if (map && map.getLayer(LYR + id)) map.setFilter(LYR + id, filterExpr(f, st.hidden));
        if (_legendFor === id) _renderLegend();
        return !hidden.has(label);
    }

    /** Pin a dataset to a DIGIPIN level (null/0 = follow the zoom). */
    function setLevel(id, level) { return _active.has(id) ? show(id, { pinned: level ? Number(level) : null }) : Promise.resolve(false); }

    /** The map view widened by half a screen each way, or null without a map. */
    function _viewBbox() {
        if (!_map || !_map.getBounds) return null;
        const b = _map.getBounds();
        const dy = (b.getNorth() - b.getSouth()) / 2, dx = (b.getEast() - b.getWest()) / 2;
        return { south: b.getSouth() - dy, north: b.getNorth() + dy, west: b.getWest() - dx, east: b.getEast() + dx };
    }

    function _viewKey(spec, view) {
        return CellStore.viewParts ? CellStore.viewParts(spec, view).map(p => p.url).join(',') : '';
    }

    // Re-render datasets whose target level, or whose set of regions / shards
    // in view, changed after the map moved.
    let _zoomMap = null;
    function _watchZoom() {
        if (!_map || _zoomMap === _map || !_map.on) return;
        _zoomMap = _map;
        _map.on('moveend', _onMove);
    }

    function _onMove() {
        const map = _map_();
        if (!map) return;
        const z = map.getZoom();
        const view = _viewBbox();
        for (const [id, st] of _active) {
            const spec = CellStore.get(id);
            if (!spec) continue;
            if (targetLevel(spec, z, st.pinned) !== st.level || (!CellStore.isLocal(id) && _viewKey(spec, view) !== st.viewKey)) show(id);
        }
    }

    function setField(id, key) { return _active.has(id) ? show(id, { field: key }) : Promise.resolve(false); }
    function setExtrude(id, on) { return _active.has(id) ? show(id, { extrude: !!on }) : Promise.resolve(false); }

    function hideAll() { active().forEach(hide); }

    // ── legend (field picker + 2D/3D switch) ────────────────────────────────

    function _size(L) {
        return (typeof DigiPin !== 'undefined' && DigiPin.sizeLabel) ? DigiPin.sizeLabel(L) : `L${L}`;
    }

    /** Detail-picker options: Auto, then the native level and up to 4 coarser ones. */
    function levelOptions(spec, st) {
        const s = st || {};
        const opts = [{ value: 0, label: `Auto (L${s.level || spec.level})`, selected: !s.pinned }];
        for (let L = spec.level; L >= Math.max(1, spec.level - 4); L--) {
            opts.push({ value: L, label: `L${L} · ${_size(L)}${L === spec.level ? ' (native)' : ''}`, selected: s.pinned === L });
        }
        return opts;
    }

    /** Footer line, e.g. "DIGIPIN L6 · ~978 m cells · rolled up from L7". */
    function levelNote(spec, st) {
        const L = (st && st.level) || spec.level;
        return `DIGIPIN L${L} · ${_size(L)} cells` + (L < spec.level ? ` · rolled up from L${spec.level}` : '');
    }

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
        const base = CellStore.field(spec, st.field) || spec.fields[0];
        const f = st.effField && st.effField.key === base.key ? st.effField : base;
        // "0-100"-style units restate the domain; only real units get a suffix.
        const unit = f.unit && !/^[\d.]+\s*[-–]\s*[\d.]+$/.test(f.unit) ? ' ' + _esc(f.unit) : '';
        const options = spec.fields.map(x =>
            `<option value="${_esc(x.key)}"${x.key === f.key ? ' selected' : ''}>${_esc(x.label)}</option>`).join('');
        const stops = legendStops(f);
        const swatches = f.type === 'number'
            ? `<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:6px;">${stops.map(s => `<span style="flex:1;background:${s.color}"></span>`).join('')}</div>`
              + `<div style="display:flex;justify-content:space-between;color:${pal.sub};font-size:11px;"><span>${_esc(stops[0].label)}</span><span>${_esc(stops[stops.length - 1].label)}${unit}</span></div>`
            : f.type === 'category'
                ? stops.map(s => {
                    const off = (st.hidden || []).includes(s.label);
                    return `<button type="button" data-act="cat" data-cat="${_esc(s.label)}" aria-pressed="${!off}" title="${off ? 'Show' : 'Hide'} ${_esc(s.label)}" style="display:flex;align-items:center;gap:6px;margin:2px 0;width:100%;padding:0;background:none;border:none;cursor:pointer;font:inherit;text-align:left;opacity:${off ? 0.4 : 1};"><span style="width:12px;height:12px;border-radius:2px;background:${s.color};flex:none;"></span><span style="color:${pal.sub};flex:1;${off ? 'text-decoration:line-through;' : ''}">${_esc(s.label)}</span><span style="color:${pal.sub};font-size:10px;">${off ? 'hidden' : ''}</span></button>`;
                }).join('')
                : stops.map(s => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;"><span style="width:12px;height:12px;border-radius:2px;background:${s.color};flex:none;"></span><span style="color:${pal.sub};">${_esc(s.label)}</span></div>`).join('');
        const others = active().filter(id => id !== spec.id);
        const rebinnable = typeof CellIngest !== 'undefined' && CellIngest.isRebinnable(spec.id);
        el.innerHTML =
            `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">`
            + `<strong style="color:${pal.primary};font-size:13px;flex:1;">${_esc(spec.title)}</strong>`
            + (st.cells ? `<span style="color:${pal.sub};font-size:11px;">${st.cells.toLocaleString()} cells</span>` : '')
            + `<button type="button" data-act="close" aria-label="Hide ${_esc(spec.title)}" style="background:none;border:none;color:${pal.sub};cursor:pointer;font-size:14px;">✕</button></div>`
            + (_temporal(spec) ? `<div style="color:${pal.sub};font-size:11px;margin-bottom:4px;">Showing <strong style="color:${pal.ink};">${_esc(spec.time.steps[st.t ?? defaultStep(spec)])}</strong> · colours fixed across all ${spec.time.steps.length} ${_esc(spec.time.unit)}s</div>` : '')
            + `<select data-act="field" aria-label="Field to colour by" style="width:100%;margin-bottom:4px;">${options}</select>`
            + `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-act="extrude"${st.extrude ? ' checked' : ''}> 3D extruded cells</label>`
            + (rebinnable
                ? `<label style="display:flex;align-items:center;gap:6px;margin-top:2px;">Cell size <select data-act="level" aria-label="DIGIPIN level">${
                    [[5, '~3.9 km'], [6, '~1 km'], [7, '~244 m'], [8, '~61 m'], [9, '~15 m']].map(([L, m]) =>
                        `<option value="${L}"${L === spec.level ? ' selected' : ''}>L${L} · ${m}</option>`).join('')}</select></label>`
                : '')
            + `<label style="display:flex;align-items:center;gap:6px;margin-top:2px;">Detail <select data-act="lod" aria-label="DIGIPIN level shown">${
                levelOptions(spec, st).map(o => `<option value="${o.value}"${o.selected ? ' selected' : ''}>${_esc(o.label)}</option>`).join('')}</select></label>`
            + swatches
            + `<div style="margin-top:6px;color:${pal.sub};font-size:11px;">${_esc(levelNote(spec, st))}${spec.source ? ' · ' + _esc(spec.source) : ''}</div>`
            + (others.length ? `<div style="margin-top:4px;font-size:11px;color:${pal.sub};">Also on: ${others.map(id => `<a href="#" data-act="focus" data-id="${_esc(id)}" style="color:${pal.primary};">${_esc((CellStore.get(id) || {}).title || id)}</a>`).join(', ')}</div>` : '');
        const id = spec.id;
        el.querySelector('[data-act="close"]').onclick = () => hide(id);
        el.querySelector('[data-act="field"]').onchange = (e) => setField(id, e.target.value);
        el.querySelector('[data-act="extrude"]').onchange = (e) => setExtrude(id, e.target.checked);
        el.querySelectorAll('[data-act="cat"]').forEach(b => {
            b.onclick = () => toggleCategory(id, b.dataset.cat);
        });
        el.querySelector('[data-act="lod"]').onchange = (e) => setLevel(id, Number(e.target.value) || null);
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

    /** The selected city ({ region, lat, lng, name }), or null without a city picker. */
    function _city() {
        return typeof CitySelector !== 'undefined' && CitySelector.currentArea ? CitySelector.currentArea() : null;
    }

    /**
     * Rows for the registry, grouped by spec.group: [{ group, rows:[{id,title}] }].
     * Only datasets with data for `city` (default: the selected city) are listed.
     */
    function panelGroups(city = _city()) {
        const groups = new Map();
        for (const d of CellStore.datasetsFor(city)) {
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
        const city = _city();
        const groups = panelGroups(city);
        // Keep a group whose layers all lack data here, so its note still shows.
        for (const d of CellStore.datasets()) {
            const g = d.group || 'Cell Data';
            if (!groups.some(x => x.group === g)) groups.push({ group: g, rows: [] });
        }
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
            const missing = group === 'Ingested data' ? [] : CellStore.datasets()
                .filter(d => (d.group || 'Cell Data') === group && !CellStore.coversCity(d, city));
            if (missing.length && city) {
                const note = document.createElement('div');
                note.className = 'dt-layer-note';
                note.style.cssText = 'font-size:10px;color:var(--text-secondary);padding:2px 10px 4px;';
                note.textContent = `No ${city.name} data yet: ${missing.map(d => d.title).join(', ')}`;
                content.appendChild(note);
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
            const busy = _loading.has(id);
            item.classList.toggle('dt-loading', busy);
            if (busy) item.setAttribute('aria-busy', 'true'); else item.removeAttribute('aria-busy');
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
        if (typeof CitySelector !== 'undefined' && CitySelector.onChange) CitySelector.onChange(_onCity);
        _renderPanel();
    }

    /** City changed: drop layers with nothing to show there, then relist. */
    function _onCity() {
        const city = _city();
        for (const id of [..._active.keys()]) {
            if (!CellStore.coversCity(CellStore.get(id), city)) hide(id);
        }
        _renderPanel();
    }

    return {
        show, hide, toggle, hideAll, isVisible, active, state, setField, setExtrude, setLevel, toggleCategory,
        setTime, onChange, defaultStep,
        targetLevel, fieldAtLevel, levelOptions, levelNote,
        mountPanel, panelGroups, colorExpr, heightExpr, legendStops, categoryColors, RAMPS,
        filterExpr, inspectorRows, inspectorText, propsAt, seriesOf, sparkline, seriesText,
    };
})();

if (typeof window !== 'undefined') {
    window.CellLayers = CellLayers;
}
