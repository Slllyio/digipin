/**
 * Annotations — user map markup for presentations (Aino-style stakeholder maps).
 *
 * Drop labelled pins anywhere on the map, persisted in localStorage so they
 * survive reloads and show in Presentation mode. Click a pin to delete it; the
 * whole set can be cleared or exported as GeoJSON (geo-referenced, opens in QGIS/
 * Rhino like the footprint export).
 *
 * The list operations (addNote / removeNote / serialize / parse / toGeoJSON) are
 * pure and unit-tested; rendering uses MapLibre DOM markers (like Compare pins).
 */
const Annotations = (() => {
    const STORAGE_KEY = 'digipin_annotations';

    // ---------- pure list operations ----------
    let _seq = 0;
    function _id() { return `a${Date.now().toString(36)}${(_seq++).toString(36)}`; }

    /** Append a note ({lat,lng,text,color?}) → new list (immutable). */
    function addNote(list, note) {
        const base = Array.isArray(list) ? list : [];
        if (!note || !Number.isFinite(note.lat) || !Number.isFinite(note.lng)) return base.slice();
        return base.concat([{
            id: note.id || _id(),
            lat: note.lat,
            lng: note.lng,
            text: String(note.text || '').slice(0, 140),
            color: note.color || '#ff673d',
        }]);
    }
    /** Remove a note by id → new list. */
    function removeNote(list, id) {
        return (Array.isArray(list) ? list : []).filter(n => n.id !== id);
    }
    /** Serialise to a compact JSON string for storage. */
    function serialize(list) {
        return JSON.stringify(Array.isArray(list) ? list : []);
    }
    /** Parse a stored string back to a clean list (bad input → []). */
    function parse(str) {
        try {
            const arr = JSON.parse(str);
            if (!Array.isArray(arr)) return [];
            return arr.filter(n => n && Number.isFinite(n.lat) && Number.isFinite(n.lng))
                .map(n => ({ id: n.id || _id(), lat: n.lat, lng: n.lng,
                    text: String(n.text || '').slice(0, 140), color: n.color || '#ff673d' }));
        } catch { return []; }
    }
    /** GeoJSON FeatureCollection of the notes (Point geometry, text property). */
    function toGeoJSON(list) {
        return {
            type: 'FeatureCollection',
            features: (Array.isArray(list) ? list : []).map(n => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [n.lng, n.lat] },
                properties: { layer: 'annotation', text: n.text || '', color: n.color || '#ff673d' },
            })),
        };
    }

    // ---------- stateful map layer ----------
    let _active = false, _map = null, _list = [], _markers = [];

    function _load() {
        try { _list = parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
        catch { _list = []; }
    }
    function _save() {
        try { localStorage.setItem(STORAGE_KEY, serialize(_list)); } catch { /* storage blocked */ }
    }

    function _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function _renderMarker(note) {
        if (typeof maplibregl === 'undefined') return null;
        const el = document.createElement('div');
        el.className = 'map-annotation';
        el.innerHTML = `<span class="ma-dot" style="background:${_esc(note.color)}"></span>`
            + (note.text ? `<span class="ma-label">${_esc(note.text)}</span>` : '');
        el.title = 'Click to remove this note';
        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            _list = removeNote(_list, note.id);
            _save();
            _renderAll();
        });
        const m = new maplibregl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([note.lng, note.lat]).addTo(_map);
        return m;
    }
    function _clearMarkers() { _markers.forEach(m => m && m.remove()); _markers = []; }
    function _renderAll() {
        _clearMarkers();
        if (_map) _markers = _list.map(_renderMarker).filter(Boolean);
        _renderBox();
    }

    function _onClick(e) {
        if (!_active) return;
        const text = (typeof window !== 'undefined' && window.prompt)
            ? window.prompt('Note label (leave blank for a plain pin):', '') : '';
        if (text === null) return;                 // cancelled
        _list = addNote(_list, { lat: e.lngLat.lat, lng: e.lngLat.lng, text });
        _save();
        _renderAll();
    }

    /** Load saved notes and render them (called at app init, regardless of mode). */
    function init() {
        _map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        _load();
        if (_map) {
            const run = () => _renderAll();
            if (_map.loaded && _map.loaded()) run();
            else if (_map.once) _map.once('load', run);
        }
    }

    const BOX_ID = 'annotate-box';
    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#0099ff', ink: '#292929', sub: '#636363',
            surface: 'rgba(255,255,255,0.96)', border: 'rgba(0,0,0,0.08)' };
    }
    function _renderBox() {
        let el = document.getElementById(BOX_ID);
        if (!_active) { if (el) el.remove(); return; }
        if (!el) {
            el = document.createElement('div');
            el.id = BOX_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Annotations');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = 'position:absolute;top:84px;right:16px;z-index:950;min-width:180px;'
            + `background:${pal.surface};border:1px solid ${pal.border};border-radius:10px;`
            + `padding:12px 14px;color:${pal.ink};font:12px/1.6 system-ui,sans-serif;`
            + 'box-shadow:0 4px 18px rgba(0,0,0,0.22);';
        el.innerHTML = `<div style="font-weight:600;font-size:14px;margin-bottom:8px;color:${pal.primary};">📌 Annotate</div>`
            + `<div style="color:${pal.sub};margin-bottom:8px;">${_list.length} note${_list.length === 1 ? '' : 's'} · click map to add</div>`
            + `<div style="display:flex;gap:8px;">`
            + `<button id="annotate-export" style="flex:1;padding:6px 0;border:1px solid ${pal.border};border-radius:8px;background:none;color:${pal.ink};cursor:pointer;font:inherit;">Export</button>`
            + `<button id="annotate-clear" style="flex:1;padding:6px 0;border:1px solid ${pal.border};border-radius:8px;background:none;color:${pal.ink};cursor:pointer;font:inherit;">Clear all</button>`
            + `</div>`;
        const ex = document.getElementById('annotate-export');
        const cl = document.getElementById('annotate-clear');
        if (ex) ex.onclick = exportGeoJSON;
        if (cl) cl.onclick = clearAll;
    }

    /** Toggle add-mode (map clicks drop pins). Returns the new state. */
    function toggle() {
        _map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : _map;
        if (!_map) return false;
        _active = !_active;
        if (_active) {
            _map.on('click', _onClick);
            if (_map.getCanvas) _map.getCanvas().style.cursor = 'crosshair';
            if (typeof App !== 'undefined') App.showToast('Annotate', 'Click the map to drop a labelled note. Click a note to remove it.', 'info');
        } else {
            _map.off('click', _onClick);
            if (_map.getCanvas) _map.getCanvas().style.cursor = '';
        }
        _renderBox();
        return _active;
    }

    function clearAll() {
        _list = [];
        _save();
        _renderAll();
        if (typeof App !== 'undefined') App.showToast('Annotate', 'All notes cleared.', 'info');
    }

    function exportGeoJSON() {
        if (!_list.length) {
            if (typeof App !== 'undefined') App.showToast('Annotate', 'No notes to export yet.', 'warning');
            return;
        }
        const blob = new Blob([JSON.stringify(toGeoJSON(_list), null, 2)], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'digipin_annotations.geojson';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function isActive() { return _active; }
    function count() { return _list.length; }

    return { init, toggle, clearAll, exportGeoJSON, isActive, count,
        addNote, removeNote, serialize, parse, toGeoJSON };
})();

if (typeof window !== 'undefined') window.Annotations = Annotations;
