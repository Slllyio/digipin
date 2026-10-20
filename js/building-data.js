/**
 * BuildingData — joins DIGIPIN cell-store attributes onto individual 3D
 * buildings, so any registry field (scores, traffic, mobility, flood, a
 * dropped CSV…) can colour or extrude the actual Overture footprints.
 *
 * The join is the DIGIPIN prefix rule (docs/CELL_STORE.md): a building's
 * centroid encodes to a 10-char code, and its first `level` characters are the
 * dataset cell it sits in. No spatial index, no server — a Map lookup per
 * building. Alongside the cell datasets it offers true per-building fields
 * (height, footprint area, floors) computed from the footprint itself.
 *
 *   OvertureBuildings (twin renderer) ── records {polygon,height,…}
 *        └─ BuildingData.annotate(records) → + {v, hv, pin, cx, cy}
 *   colour  = CellLayers-style ramp over `v` (the chosen field)
 *   height  = real/baked height, or the chosen field scaled to 4…maxM metres
 *
 * Selection is "<dataset>:<field>" ("bldg:<field>" for per-building fields),
 * persisted in localStorage and mirrored in a small floating panel shown
 * while buildings are on. A hover tooltip and click popup report the
 * building's DIGIPIN, height and every dataset row covering it.
 *
 * Pure helpers (parseKey/options/centroid/areaM2/annotate/heightFromValue/
 * colorExpr/legend/summary) are unit-tested.
 */
const BuildingData = (() => {
    const BLDG = 'bldg';
    const NO_DATA = '#9ca3af';
    const PANEL_ID = 'building-data-panel';
    const STORE_KEY = 'digipin.buildingData';
    const MAX_VALUE_HEIGHT_M = 120;

    // Per-building fields, computed from the footprint (not from a cell).
    const BUILDING_SPEC = {
        id: BLDG,
        title: 'Building (footprint)',
        level: 10,
        fields: [
            { key: 'height_m', label: 'Height', type: 'number', unit: 'm', domain: [0, 40], ramp: 'viridis' },
            { key: 'area_m2', label: 'Footprint area', type: 'number', unit: 'm²', domain: [0, 2000], ramp: 'blues' },
            { key: 'floors', label: 'Est. floors', type: 'number', unit: 'floors', domain: [1, 12], ramp: 'viridis' },
        ],
    };

    let _color = null;        // "<dataset>:<field>" or null (theme massing colours)
    let _height = null;       // "<dataset>:<field>" or null (real height)
    const _tables = new Map();    // dataset id -> loaded table
    const _listeners = new Set();
    let _visible = false;     // panel shown (buildings on)
    let _lastStats = null;

    // ── pure helpers ────────────────────────────────────────────────────────

    /** "scores:walkability" → { dataset, field }, or null. Pure. */
    function parseKey(key) {
        if (!key || typeof key !== 'string') return null;
        const i = key.indexOf(':');
        if (i <= 0 || i === key.length - 1) return null;
        return { dataset: key.slice(0, i), field: key.slice(i + 1) };
    }

    /** Selectable groups [{ id, title, level, items:[{ key, label }] }]. Pure. */
    function options(datasets) {
        const out = [{ id: BLDG, title: BUILDING_SPEC.title, level: 10,
            items: BUILDING_SPEC.fields.map(f => ({ key: `${BLDG}:${f.key}`, label: f.label })) }];
        for (const d of (datasets || [])) {
            if (!d || !Array.isArray(d.fields)) continue;
            const items = d.fields
                .filter(f => f.type === 'number' || f.type === 'category' || f.type === 'boolean')
                .map(f => ({ key: `${d.id}:${f.key}`, label: f.label || f.key }));
            if (items.length) out.push({ id: d.id, title: d.title || d.id, level: d.level, items });
        }
        return out;
    }

    /** Mean of a ring's vertices (closing vertex excluded) → { lng, lat }. Pure. */
    function centroid(ring) {
        if (!Array.isArray(ring) || !ring.length) return null;
        const pts = (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0]
            && ring[0][1] === ring[ring.length - 1][1]) ? ring.slice(0, -1) : ring;
        let lng = 0, lat = 0;
        for (const p of pts) { lng += p[0]; lat += p[1]; }
        return { lng: lng / pts.length, lat: lat / pts.length };
    }

    /** Planar footprint area (m²) of a lng/lat ring. Pure. */
    function areaM2(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return 0;
        const c = centroid(ring);
        const mLng = 111320 * Math.cos(c.lat * Math.PI / 180), mLat = 110574;
        let a = 0;
        for (let i = 0, n = ring.length; i < n; i++) {
            const p = ring[i], q = ring[(i + 1) % n];
            a += (p[0] * mLng) * (q[1] * mLat) - (q[0] * mLng) * (p[1] * mLat);
        }
        return Math.abs(a / 2);
    }

    /** Field spec for a selection key, given a dataset lookup. Pure. */
    function fieldFor(key, getSpec) {
        const k = parseKey(key);
        if (!k) return null;
        const spec = k.dataset === BLDG ? BUILDING_SPEC : (getSpec ? getSpec(k.dataset) : null);
        if (!spec) return null;
        const f = (spec.fields || []).find(x => x.key === k.field);
        return f ? { spec, field: f } : null;
    }

    /** Value of a per-building field for one record. Pure. */
    function buildingValue(field, rec, area) {
        if (field === 'height_m') return Math.round(rec.height * 10) / 10;
        if (field === 'area_m2') return Math.round(area);
        if (field === 'floors') return Math.max(1, Math.round(rec.height / 3.2));
        return null;
    }

    /** A dataset's value for the cell containing (lat,lng), or null. Pure given `cellCode`. */
    function cellValue(table, fieldKey, lat, lng, cellCode) {
        if (!table || !table.index || !table.columns || !table.columns[fieldKey]) return null;
        const code = cellCode(table.level, lat, lng);
        if (!code) return null;
        const i = table.index.get(code);
        if (i === undefined) return null;
        const v = table.columns[fieldKey][i];
        return v == null ? null : v;
    }

    /** Scale a value onto 4…maxM metres over the field's domain. Pure. */
    function heightFromValue(f, v, maxM = MAX_VALUE_HEIGHT_M) {
        if (v == null) return null;
        if (f.type === 'boolean') return v === true || v === 'true' ? maxM : 4;
        if (f.type === 'category') {
            const cats = Array.isArray(f.domain) ? f.domain.map(String) : [];
            const i = cats.indexOf(String(v));
            return i < 0 ? 4 : 4 + (maxM - 4) * (cats.length > 1 ? i / (cats.length - 1) : 1);
        }
        const x = Number(v);
        if (!Number.isFinite(x)) return null;
        const d = Array.isArray(f.domain) && f.domain.length === 2 ? f.domain : [0, 1];
        const span = d[1] - d[0] || 1;
        const t = Math.max(0, Math.min(1, (x - d[0]) / span));
        return 4 + (maxM - 4) * t;
    }

    /**
     * Annotate twin records with the joined data. ctx:
     *   { color: {spec, field, table?}, height: {spec, field, table?}, cellCode, encode }
     * Adds per record: v (colour value), hv (value-driven height, m), pin
     * (formatted L10 DIGIPIN of the centroid), cx/cy, area. Pure.
     */
    function annotate(records, ctx) {
        const c = ctx || {};
        const val = (sel, rec, cen, area) => {
            if (!sel) return null;
            if (sel.spec.id === BLDG) return buildingValue(sel.field.key, rec, area);
            return cellValue(sel.table, sel.field.key, cen.lat, cen.lng, c.cellCode);
        };
        return (records || []).map(rec => {
            const cen = centroid(rec.polygon);
            if (!cen) return rec;
            const area = areaM2(rec.polygon);
            const out = { ...rec, cx: cen.lng, cy: cen.lat, area };
            if (c.encode) { try { out.pin = c.encode(cen.lat, cen.lng); } catch { out.pin = null; } }
            if (c.color) out.v = val(c.color, rec, cen, area);
            if (c.height) {
                const hvRaw = val(c.height, rec, cen, area);
                out.hv = c.height.spec.id === BLDG && c.height.field.key === 'height_m'
                    ? null : heightFromValue(c.height.field, hvRaw);
                out.hval = hvRaw;
            }
            return out;
        });
    }

    /** MapLibre colour expression over the `v` property for a field. Pure. */
    function colorExpr(f) {
        if (typeof CellLayers !== 'undefined' && CellLayers.colorExpr) {
            const e = CellLayers.colorExpr({ ...f, key: 'v' });
            // CellLayers paints false booleans transparent (cells); buildings must stay solid.
            return f.type === 'boolean' ? ['case', ['==', ['get', 'v'], true], '#d7301f', '#cfd6dd'] : e;
        }
        return NO_DATA;
    }

    /** Legend rows for a field (CellLayers stops), or []. Pure. */
    function legend(f) {
        if (typeof CellLayers !== 'undefined' && CellLayers.legendStops) return CellLayers.legendStops(f);
        return [];
    }

    /** { buildings, withData, mean, min, max, top } over annotated records' `v`. Pure. */
    function summary(records, f) {
        const recs = records || [];
        const vals = recs.map(r => r.v).filter(v => v != null);
        const out = { buildings: recs.length, withData: vals.length, mean: null, min: null, max: null, top: null };
        if (!vals.length || !f) return out;
        if (f.type === 'number') {
            const xs = vals.map(Number).filter(Number.isFinite);
            if (xs.length) {
                out.mean = xs.reduce((a, b) => a + b, 0) / xs.length;
                out.min = Math.min(...xs);
                out.max = Math.max(...xs);
            }
        } else {
            const counts = new Map();
            for (const v of vals) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
            let best = null, n = -1;
            for (const [k, c] of counts) if (c > n) { best = k; n = c; }
            out.top = best;
        }
        return out;
    }

    // ── state ───────────────────────────────────────────────────────────────

    function _getSpec(id) {
        return (typeof CellStore !== 'undefined' && CellStore.get) ? CellStore.get(id) : null;
    }

    function _restore() {
        try {
            const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (s && typeof s === 'object') { _color = s.color || null; _height = s.height || null; }
        } catch { /* storage blocked */ }
    }
    function _persist() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ color: _color, height: _height })); }
        catch { /* storage blocked */ }
    }

    function onChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
    function _emit() {
        _listeners.forEach(fn => { try { fn(); } catch { /* listener errors are theirs */ } });
        if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent !== 'undefined') {
            window.dispatchEvent(new CustomEvent('buildingdata:change'));
        }
    }

    async function _ensureTable(key) {
        const k = parseKey(key);
        if (!k || k.dataset === BLDG || _tables.has(k.dataset)) return;
        if (typeof CellStore === 'undefined') return;
        const t = await CellStore.load(k.dataset);
        if (t) _tables.set(k.dataset, t);
    }

    /** Set the colour and/or height driver ("<dataset>:<field>" or null). */
    async function set(opts) {
        const o = opts || {};
        if ('color' in o) _color = o.color || null;
        if ('height' in o) _height = o.height || null;
        _persist();
        await Promise.all([_ensureTable(_color), _ensureTable(_height)]);
        _emit();
        _renderPanel();
    }

    function get() { return { color: _color, height: _height }; }

    /** True when any data driver is set (buildings then use the MapLibre twin renderer). */
    function isActive() { return !!(_color || _height); }

    function _sel(key) {
        const r = fieldFor(key, _getSpec);
        if (!r) return null;
        return { ...r, table: _tables.get(r.spec.id) || null };
    }

    function _encode(lat, lng) {
        return (typeof DigiPin !== 'undefined') ? DigiPin.encode(lat, lng) : null;
    }
    function _cellCode(level, lat, lng) {
        return (typeof CellStore !== 'undefined') ? CellStore.cellCode(level, lat, lng) : null;
    }

    /** Annotate harvested twin records with the current selection. */
    function annotateCurrent(records) {
        const out = annotate(records, { color: _sel(_color), height: _sel(_height), cellCode: _cellCode, encode: _encode });
        const c = _sel(_color);
        _lastStats = c ? summary(out, c.field) : null;
        _renderStats();
        return out;
    }

    /** Colour expression for the current colour driver, or null (theme colours). */
    function currentColorExpr() {
        const c = _sel(_color);
        return c ? colorExpr(c.field) : null;
    }

    // ── inspection ──────────────────────────────────────────────────────────

    function _esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function _fmt(f, v) {
        if (v == null) return '—';
        if (f && f.type === 'number' && Number.isFinite(Number(v))) {
            const x = Number(v);
            const s = Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : (Math.round(x * 10) / 10).toString();
            const unit = f.unit && !/^[\d.]+\s*[-–]\s*[\d.]+$/.test(f.unit) ? ' ' + f.unit : '';
            return s + unit;
        }
        return String(v);
    }

    /** Short hover text for a twin feature's properties. */
    function tooltipHTML(props) {
        const p = props || {};
        const c = _sel(_color);
        let html = `<div style="font:600 12px system-ui,sans-serif;">${_esc(p.pin || 'Building')}</div>`;
        html += `<div style="font:11px system-ui,sans-serif;opacity:.8;">${_fmt({ type: 'number', unit: 'm' }, p.rh)} tall`;
        if (c && c.spec.id !== BLDG) html += ` · ${_esc(c.field.label || c.field.key)}: <b>${_esc(_fmt(c.field, p.v))}</b>`;
        else if (c) html += ` · ${_esc(c.field.label)}: <b>${_esc(_fmt(c.field, p.v))}</b>`;
        return html + '</div>';
    }

    /**
     * Every dataset's row for a building centroid: [{ spec, row }], loading
     * datasets that aren't in memory yet.
     */
    async function describe(lat, lng) {
        if (typeof CellStore === 'undefined') return [];
        const out = [];
        for (const spec of CellStore.datasets()) {
            try {
                const row = await CellStore.rowAt(spec.id, lat, lng);
                if (row) out.push({ spec, row });
            } catch { /* dataset unavailable */ }
        }
        return out;
    }

    /** Popup HTML for a building: identity block + one section per dataset. */
    function popupHTML(props, rows) {
        const p = props || {};
        const c = _sel(_color), h = _sel(_height);
        const srcLabel = { overture: 'Overture', baked: 'Open Buildings 2.5D (cell)', estimate: 'estimated' }[p.hsrc] || '';
        let html = '<div class="building-data-popup" style="font:12px/1.45 system-ui,sans-serif;min-width:220px;max-width:300px;max-height:360px;overflow:auto;">';
        html += `<div style="font-weight:700;font-size:13px;">${_esc(p.pin || 'Building')}</div>`;
        html += '<div style="opacity:.75;margin-bottom:4px;">DIGIPIN of the footprint centre</div>';
        const kv = (k, v) => `<div style="display:flex;justify-content:space-between;gap:8px;"><span>${_esc(k)}</span><b>${_esc(v)}</b></div>`;
        html += kv('Height', `${_fmt({ type: 'number', unit: 'm' }, p.rh)}${srcLabel ? ' · ' + srcLabel : ''}`);
        if (p.area) html += kv('Footprint', _fmt({ type: 'number', unit: 'm²' }, p.area));
        if (p.cls) html += kv('Class', p.cls);
        if (c) html += kv(`Colour: ${c.field.label || c.field.key}`, _fmt(c.field, p.v));
        if (h) html += kv(`Height: ${h.field.label || h.field.key}`, _fmt(h.field, p.hval));
        for (const { spec, row } of (rows || [])) {
            const fields = (spec.fields || []).filter(f => row[f.key] != null && row[f.key] !== '');
            if (!fields.length) continue;
            const open = (c && c.spec.id === spec.id) || (h && h.spec.id === spec.id);
            html += `<details${open ? ' open' : ''} style="margin-top:6px;"><summary style="cursor:pointer;font-weight:600;">${_esc(spec.title || spec.id)} <span style="opacity:.6;font-weight:400;">L${_esc(spec.level)} · ${_esc(row.digipin)}</span></summary>`;
            html += fields.map(f => kv(f.label || f.key, _fmt(f, row[f.key]))).join('');
            html += '</details>';
        }
        if (!rows || !rows.length) html += '<div style="opacity:.7;margin-top:6px;">No cell-store data covers this building.</div>';
        return html + '</div>';
    }

    // ── panel ───────────────────────────────────────────────────────────────

    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }

    function _selectHTML(act, current, groups, noneLabel) {
        const opts = groups.map(g => `<optgroup label="${_esc(g.title)}${g.level && g.id !== BLDG ? ` (L${g.level})` : ''}">`
            + g.items.map(i => `<option value="${_esc(i.key)}"${i.key === current ? ' selected' : ''}>${_esc(i.label)}</option>`).join('')
            + '</optgroup>').join('');
        return `<select data-act="${act}" aria-label="${act === 'color' ? 'Colour buildings by' : 'Building height from'}" style="width:100%;margin:2px 0 6px;">`
            + `<option value=""${current ? '' : ' selected'}>${_esc(noneLabel)}</option>${opts}</select>`;
    }

    function _renderStats() {
        if (typeof document === 'undefined') return;
        const el = document.querySelector(`#${PANEL_ID} [data-role="stats"]`);
        if (!el) return;
        const c = _sel(_color);
        const s = _lastStats;
        if (!c || !s) { el.textContent = ''; return; }
        const agg = c.field.type === 'number'
            ? (s.mean != null ? `mean ${_fmt(c.field, s.mean)} (${_fmt(c.field, s.min)}–${_fmt(c.field, s.max)})` : 'no data in view')
            : (s.top != null ? `most common: ${s.top}` : 'no data in view');
        el.textContent = `${s.buildings.toLocaleString()} buildings in view · ${s.withData.toLocaleString()} with data · ${agg}`;
    }

    function _renderPanel() {
        if (typeof document === 'undefined') return;
        let el = document.getElementById(PANEL_ID);
        if (!_visible) { if (el) el.remove(); return; }
        if (!el) {
            el = document.createElement('div');
            el.id = PANEL_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Building data');
            document.body.appendChild(el);
        }
        const pal = _palette();
        // Top-left, just right of the Urban Queries sidebar; the bottom corners
        // belong to the attribution/scale and the cell-layer legend.
        el.style.cssText = `position:absolute;top:84px;left:340px;z-index:3;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:10px 12px;color:${pal.ink};width:250px;`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const groups = options(typeof CellStore !== 'undefined' ? CellStore.datasets() : []);
        const c = _sel(_color);
        let legendHTML = '';
        if (c) {
            const stops = legend(c.field);
            if (c.field.type === 'number' && stops.length) {
                legendHTML = `<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;">${stops.map(s => `<span style="flex:1;background:${s.color}"></span>`).join('')}</div>`
                    + `<div style="display:flex;justify-content:space-between;color:${pal.sub};font-size:11px;"><span>${_esc(stops[0].label)}</span><span>${_esc(stops[stops.length - 1].label)}${c.field.unit && !/^[\d.]+\s*[-–]\s*[\d.]+$/.test(c.field.unit) ? ' ' + _esc(c.field.unit) : ''}</span></div>`;
            } else {
                legendHTML = stops.map(s => `<div style="display:flex;align-items:center;gap:6px;"><span style="width:10px;height:10px;border-radius:2px;background:${s.color};"></span><span style="color:${pal.sub};">${_esc(s.label)}</span></div>`).join('');
            }
            const lvl = c.spec.level;
            legendHTML += `<div style="color:${pal.sub};font-size:11px;margin-top:4px;">${c.spec.id === BLDG ? 'Per building, from its footprint' : `Joined by DIGIPIN L${lvl}${c.spec.approxCellM ? ` (~${c.spec.approxCellM} m cells)` : ''}: every building in a cell shares its value; grey = no data`}</div>`;
        }
        el.innerHTML = `<div style="display:flex;align-items:center;margin-bottom:6px;"><strong style="color:${pal.primary};font-size:13px;flex:1;">Building data</strong>`
            + `<button type="button" data-act="reset" title="Back to plain massing" style="background:none;border:none;color:${pal.sub};cursor:pointer;font-size:11px;">reset</button></div>`
            + `<label style="color:${pal.sub};font-size:11px;">Colour by</label>${_selectHTML('color', _color, groups, 'Theme massing (no data)')}`
            + `<label style="color:${pal.sub};font-size:11px;">Height from</label>${_selectHTML('height', _height, groups, 'Real building height')}`
            + legendHTML
            + `<div data-role="stats" style="color:${pal.sub};font-size:11px;margin-top:4px;"></div>`
            + `<div style="color:${pal.sub};font-size:10px;margin-top:4px;opacity:.8;">Hover a building for its DIGIPIN; click for every dataset covering it.</div>`;
        el.querySelector('[data-act="color"]').onchange = (e) => set({ color: e.target.value });
        el.querySelector('[data-act="height"]').onchange = (e) => set({ height: e.target.value });
        el.querySelector('[data-act="reset"]').onclick = () => set({ color: null, height: null });
        _renderStats();
    }

    /** Show/hide the panel (called by OvertureBuildings when buildings toggle). */
    function setPanelVisible(on) {
        _visible = !!on;
        _renderPanel();
    }

    /** Load the persisted selection's tables (call once the cell store is ready). */
    async function init() {
        _restore();
        if (typeof CellStore !== 'undefined' && CellStore.onChange) CellStore.onChange(() => _renderPanel());
        await Promise.all([_ensureTable(_color), _ensureTable(_height)]);
        if (isActive()) _emit();
        _renderPanel();
    }

    return {
        init, set, get, isActive, onChange, annotateCurrent, currentColorExpr,
        setPanelVisible, describe, popupHTML, tooltipHTML,
        parseKey, options, centroid, areaM2, fieldFor, cellValue, heightFromValue,
        annotate, colorExpr, legend, summary, BUILDING_SPEC,
    };
})();

if (typeof window !== 'undefined') window.BuildingData = BuildingData;
