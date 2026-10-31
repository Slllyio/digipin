/**
 * SentinelImagery — the latest cloud-free Sentinel-2 scene over the selected
 * DIGIPIN cell (or the map centre), live, with no API key.
 *
 * Searches Microsoft Planetary Computer's public STAC API for Sentinel-2 L2A
 * scenes whose footprint covers the point (last 120 days, < 20 % cloud,
 * newest first) and draws the chosen one through its public tiler as a raster
 * under the DIGIPIN grid. Presets: true colour, false colour (NIR) and NDVI.
 * The idea follows opengeos/maplibre-gl-planetary-computer (MIT).
 *
 * searchBody, tileUrl, pickScenes and sceneLabel are pure (unit-tested);
 * attach/detach follow the overlay contract and are idempotent.
 */
const SentinelImagery = (() => {
    const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
    const TILES = 'https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x';
    const COLLECTION = 'sentinel-2-l2a';
    const DAYS = 120;
    const MAX_CLOUD = 20;
    const SOURCE_ID = 'sentinel-imagery-src';
    const LAYER_ID = 'sentinel-imagery-layer';
    const PANEL_ID = 'sentinel-imagery-panel';
    const ATTRIBUTION = 'Contains modified Copernicus Sentinel data (ESA); tiles via Microsoft Planetary Computer';

    const PRESETS = {
        true: { label: 'True colour', params: 'assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0' },
        nir: { label: 'False colour (vegetation red)', params: 'assets=B08&assets=B04&assets=B03&rescale=0%2C4500&nodata=0' },
        ndvi: { label: 'NDVI', params: 'expression=(B08_b1-B04_b1)%2F(B08_b1%2BB04_b1)&rescale=-0.2%2C0.8&colormap_name=rdylgn&nodata=0' },
    };

    let _map = null;
    let _active = false;
    let _reqId = 0;
    let _scenes = [];
    let _scene = null;
    let _preset = 'true';
    let _panel = null;

    // ---------- pure ----------

    /** STAC search body for scenes covering (lng,lat) in the last `days`. */
    function searchBody(lng, lat, now = new Date(), days = DAYS, maxCloud = MAX_CLOUD) {
        const from = new Date(now.getTime() - days * 864e5);
        return {
            collections: [COLLECTION],
            intersects: { type: 'Point', coordinates: [lng, lat] },
            datetime: `${from.toISOString().slice(0, 19)}Z/${now.toISOString().slice(0, 19)}Z`,
            query: { 'eo:cloud_cover': { lt: maxCloud } },
            sortby: [{ field: 'datetime', direction: 'desc' }],
            limit: 12,
        };
    }

    /** Newest day first, one scene per day (the clearest of adjacent tiles). */
    function pickScenes(features) {
        const seen = new Set();
        return (features || [])
            .filter(f => f && f.id && f.properties && f.properties.datetime)
            .sort((a, b) => b.properties.datetime.slice(0, 10).localeCompare(a.properties.datetime.slice(0, 10))
                || (a.properties['eo:cloud_cover'] ?? 100) - (b.properties['eo:cloud_cover'] ?? 100))
            .filter(f => {
                const day = f.properties.datetime.slice(0, 10);
                if (seen.has(day)) return false;
                seen.add(day);
                return true;
            })
            .map(f => ({ id: f.id, date: f.properties.datetime.slice(0, 10), cloud: f.properties['eo:cloud_cover'], bbox: f.bbox }));
    }

    function tileUrl(sceneId, preset = 'true') {
        const p = PRESETS[preset] || PRESETS.true;
        return `${TILES}?collection=${COLLECTION}&item=${encodeURIComponent(sceneId)}&${p.params}&format=png`;
    }

    function sceneLabel(s) {
        const cloud = Number.isFinite(s.cloud) ? `${s.cloud < 1 ? '<1' : Math.round(s.cloud)}% cloud` : '';
        return [s.date, cloud].filter(Boolean).join(' · ');
    }

    // ---------- map / DOM ----------

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind);
    }

    /** Selected cell centre if there is one, else the map centre. */
    function _target() {
        const code = typeof MapModule !== 'undefined' && MapModule.getSelectedCode ? MapModule.getSelectedCode() : null;
        if (code && typeof DigiPin !== 'undefined' && DigiPin.decode) {
            try {
                const plain = String(code).replace(/-/g, '');
                const c = plain.length < 10 && DigiPin.decodePartial ? DigiPin.decodePartial(plain) : DigiPin.decode(code);
                if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) return { lat: c.lat, lng: c.lng, code };
            } catch { /* fall back to centre */ }
        }
        const m = _map.getCenter();
        return { lat: m.lat, lng: m.lng, code: null };
    }

    function _beforeId() {
        const layers = _map.getStyle().layers || [];
        const grid = layers.find(l => /^digipin-grid|^cell-layer-/.test(l.id));
        return grid ? grid.id : undefined;
    }

    function _draw() {
        if (!_map || !_scene) return;
        if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
        if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        const src = { type: 'raster', tiles: [tileUrl(_scene.id, _preset)], tileSize: 256, minzoom: 8, maxzoom: 18, attribution: ATTRIBUTION };
        if (_scene.bbox && _scene.bbox.length === 4) src.bounds = _scene.bbox;
        _map.addSource(SOURCE_ID, src);
        _map.addLayer({ id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { 'raster-opacity': 0.95 } }, _beforeId());
    }

    function _syncButton(on) {
        const btn = document.getElementById('btn-sentinel');
        if (!btn) return;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }

    function _renderPanel(target) {
        if (_panel) _panel.remove();
        _panel = document.createElement('div');
        _panel.id = PANEL_ID;
        _panel.className = 'sentinel-panel';
        _panel.setAttribute('role', 'group');
        _panel.setAttribute('aria-label', 'Sentinel-2 imagery');
        const title = document.createElement('div');
        title.className = 'sentinel-title';
        title.textContent = target.code ? `Sentinel-2 over ${target.code}` : 'Sentinel-2 at map centre';
        const mkSel = (id, label, options, value, onChange) => {
            const wrap = document.createElement('label');
            wrap.className = 'sentinel-field';
            wrap.textContent = label;
            const sel = document.createElement('select');
            sel.id = id;
            options.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
            sel.value = value;
            sel.addEventListener('change', () => onChange(sel.value));
            wrap.appendChild(sel);
            return wrap;
        };
        const date = mkSel('sentinel-date', 'Date', _scenes.map(s => [s.id, sceneLabel(s)]), _scene.id,
            v => { _scene = _scenes.find(s => s.id === v) || _scene; _draw(); });
        const view = mkSel('sentinel-preset', 'View', Object.entries(PRESETS).map(([k, p]) => [k, p.label]), _preset,
            v => { _preset = v; _draw(); });
        const credit = document.createElement('div');
        credit.className = 'sentinel-credit';
        credit.textContent = `10 m · ${ATTRIBUTION}`;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'sentinel-close';
        close.textContent = 'Close';
        close.addEventListener('click', () => { detach(); _syncButton(false); });
        const next = document.createElement('div');
        next.className = 'sentinel-next';
        next.hidden = true;
        _panel.append(title, date, view, next, credit, close);
        document.body.appendChild(_panel);
        _showNextPass(next, target);
    }

    /** "Next pass: Sentinel-2B, Fri 24 Oct, 11:11 IST · Likely clear" from the satellite-pass model. */
    async function _showNextPass(el, target) {
        if (typeof SatPasses === 'undefined' || !SatPasses.nextPass) return;
        const reqId = _reqId;
        try {
            const p = await SatPasses.nextPass(target.lat, target.lng);
            if (reqId !== _reqId || !p) return;
            el.textContent = `Next pass: ${p.label}, ${SatPasses.fmtIst(p.t)}${p.outlook ? ` \u00b7 ${p.outlook}` : ''}`;
            el.hidden = false;
        } catch { /* orbits unavailable: the card works without it */ }
    }

    async function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        detach();
        _active = true;
        const reqId = ++_reqId;
        const target = _target();
        _toast('Sentinel-2', 'Finding the latest clear scene…', 'info');
        try {
            const res = await fetch(STAC, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(searchBody(target.lng, target.lat)),
            });
            if (!res.ok) throw new Error(`STAC search returned ${res.status}`);
            const scenes = pickScenes((await res.json()).features);
            if (reqId !== _reqId) return;
            if (!scenes.length) throw new Error(`No scene under ${MAX_CLOUD}% cloud in the last ${DAYS} days here.`);
            _scenes = scenes;
            _scene = scenes[0];
            _draw();
            _renderPanel(target);
            _toast('Sentinel-2', `Showing ${sceneLabel(_scene)}.`, 'success');
        } catch (e) {
            if (reqId !== _reqId) return;
            console.warn('SentinelImagery:', e);
            _toast('Sentinel-2 unavailable', e.message || 'The imagery search failed.', 'error');
            _active = false;
            _syncButton(false);
        }
    }

    function detach() {
        _active = false;
        _reqId++;
        if (_map) {
            if (_map.getLayer(LAYER_ID)) _map.removeLayer(LAYER_ID);
            if (_map.getSource(SOURCE_ID)) _map.removeSource(SOURCE_ID);
        }
        if (_panel) { _panel.remove(); _panel = null; }
        _scenes = []; _scene = null;
    }

    function toggle() { if (_active) detach(); else attach(); }
    function isActive() { return _active; }

    return { attach, detach, toggle, isActive, searchBody, pickScenes, tileUrl, sceneLabel, PRESETS };
})();

if (typeof window !== 'undefined') window.SentinelImagery = SentinelImagery;
