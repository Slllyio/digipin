/**
 * PointCloud — view LiDAR / drone point clouds (LAS, LAZ, COPC, EPT) on the
 * 3D city, through opengeos/maplibre-gl-lidar (MIT) loaded on first use.
 *
 * No openly licensed LiDAR covers Indian cities yet, so this is a viewer for
 * your own data: drop a .las / .laz / .copc.laz file, or paste a COPC or EPT
 * URL (a drone survey, a SVAMITVA-style capture). COPC URLs stream by viewport.
 * The library reprojects projected CRSs to WGS84 and draws with deck.gl; the
 * cloud's centre is reported as a DIGIPIN code so it ties back to the grid.
 *
 * isPointCloudName / normaliseUrl are pure (unit-tested); open/close are
 * idempotent and remove the control and its layers.
 */
const PointCloud = (() => {
    const VERSION = '0.21.0';
    const MODULE_URL = `https://cdn.jsdelivr.net/npm/maplibre-gl-lidar@${VERSION}/+esm`;
    const CSS_URL = `https://unpkg.com/maplibre-gl-lidar@${VERSION}/dist/maplibre-gl-lidar.css`;
    const PANEL_ID = 'point-cloud-panel';
    // Public sample (Autzen stadium, Oregon; Hobu, Inc.), for trying the viewer.
    const SAMPLE_URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

    let _map = null;
    let _control = null;
    let _lib = null;
    let _panel = null;

    // ---------- pure ----------

    function isPointCloudName(name) {
        return /\.(las|laz)$/i.test(String(name || '').trim());
    }

    /** Accept https COPC/LAS/LAZ files and EPT roots (ept.json); reject anything else. */
    function normaliseUrl(text) {
        const s = String(text || '').trim();
        let u;
        try { u = new URL(s); } catch { return null; }
        if (u.protocol !== 'https:') return null;
        return /\.(las|laz)$/i.test(u.pathname) || /\/ept\.json$/i.test(u.pathname) ? u.href : null;
    }

    // ---------- loading ----------

    function _loadCss() {
        if (document.getElementById('point-cloud-css')) return;
        const link = document.createElement('link');
        link.id = 'point-cloud-css';
        link.rel = 'stylesheet';
        link.href = CSS_URL;
        document.head.appendChild(link);
    }

    async function _ensureControl() {
        if (_control) return _control;
        _loadCss();
        if (!_lib) {
            // The library ships its own deck.gl 9.4 / luma.gl, and both refuse to start
            // when another version (the app's deck.gl 9.3 UMD) owns globalThis.deck /
            // globalThis.luma. Hide those while the module initialises, then put them back.
            const saved = { deck: globalThis.deck, luma: globalThis.luma };
            try {
                delete globalThis.deck; delete globalThis.luma;
                _lib = await import(MODULE_URL);
            } finally {
                Object.entries(saved).forEach(([k, v]) => { if (v) globalThis[k] = v; });
            }
        }
        const dark = !(typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light');
        _control = new _lib.LidarControl({
            title: 'Point cloud', collapsed: false, pointSize: 2,
            colorScheme: 'elevation', pickable: true, theme: dark ? 'dark' : 'light',
        });
        _map.addControl(_control, 'top-right');
        _control.on('load', (e) => {
            _control.flyToPointCloud();
            const pc = e && e.pointCloud;
            const b = pc && pc.bounds;
            let where = '';
            if (b && typeof DigiPin !== 'undefined' && DigiPin.encode) {
                try { where = ` around ${DigiPin.encode((b.minY + b.maxY) / 2, (b.minX + b.maxX) / 2)}`; } catch { /* outside India */ }
            }
            const n = pc && pc.pointCount;
            _toast('Point cloud', `${n ? n.toLocaleString() + ' points' : 'Loaded'}${where}.`, 'success');
        });
        _control.on('loaderror', (e) => _toast('Point cloud', `Could not load it: ${(e && e.error && e.error.message) || 'unknown error'}.`, 'error'));
        return _control;
    }

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind);
    }

    async function load(source) {
        try {
            const c = await _ensureControl();
            if (_map.getPitch() < 45) _map.easeTo({ pitch: 60 });
            await c.loadPointCloud(source);
            return true;
        } catch (e) {
            console.warn('PointCloud:', e);
            _toast('Point cloud', e.message || 'The viewer could not start.', 'error');
            return false;
        }
    }

    // ---------- panel ----------

    function _syncButton(on) {
        const btn = document.getElementById('btn-pointcloud');
        if (!btn) return;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }

    function _buildPanel() {
        _panel = document.createElement('div');
        _panel.id = PANEL_ID;
        _panel.className = 'point-cloud-panel';
        _panel.setAttribute('role', 'group');
        _panel.setAttribute('aria-label', 'Point cloud');
        const title = document.createElement('div');
        title.className = 'point-cloud-title';
        title.textContent = 'Point cloud (LiDAR / drone)';
        const hint = document.createElement('div');
        hint.className = 'point-cloud-hint';
        hint.textContent = 'Open a .las / .laz / .copc.laz file, or paste a COPC or EPT link. Your file stays in this browser.';
        const file = document.createElement('input');
        file.type = 'file';
        file.id = 'point-cloud-file';
        file.accept = '.las,.laz';
        file.setAttribute('aria-label', 'Point cloud file');
        file.addEventListener('change', () => {
            const f = file.files && file.files[0];
            if (!f) return;
            if (!isPointCloudName(f.name)) { _toast('Point cloud', 'Pick a .las or .laz file.', 'warning'); return; }
            load(f);
        });
        const row = document.createElement('div');
        row.className = 'point-cloud-row';
        const url = document.createElement('input');
        url.type = 'url';
        url.id = 'point-cloud-url';
        url.placeholder = 'https://…/survey.copc.laz';
        url.setAttribute('aria-label', 'Point cloud link');
        const go = document.createElement('button');
        go.type = 'button';
        go.textContent = 'Load';
        go.addEventListener('click', () => {
            const u = normaliseUrl(url.value);
            if (!u) { _toast('Point cloud', 'Use an https link to a .las, .laz, .copc.laz or ept.json.', 'warning'); return; }
            load(u);
        });
        row.append(url, go);
        const sample = document.createElement('button');
        sample.type = 'button';
        sample.className = 'point-cloud-sample';
        sample.textContent = 'Try a public sample (Autzen, Oregon)';
        sample.addEventListener('click', () => load(SAMPLE_URL));
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'point-cloud-close';
        close.textContent = 'Close';
        close.addEventListener('click', () => { closeViewer(); _syncButton(false); });
        _panel.append(title, hint, file, row, sample, close);
        document.body.appendChild(_panel);
    }

    function open() {
        if (typeof MapModule === 'undefined') return false;
        _map = MapModule.getMap();
        if (!_map || _panel) return !!_panel;
        _buildPanel();
        return true;
    }

    function closeViewer() {
        if (_control && _map) {
            try { _control.unloadPointCloud(); } catch { /* nothing loaded */ }
            try { _map.removeControl(_control); } catch { /* already removed */ }
        }
        _control = null;
        if (_panel) { _panel.remove(); _panel = null; }
    }

    function isActive() { return !!_panel; }
    function toggle() { if (_panel) closeViewer(); else open(); }

    return { open, close: closeViewer, toggle, isActive, load, isPointCloudName, normaliseUrl, SAMPLE_URL };
})();

if (typeof window !== 'undefined') window.PointCloud = PointCloud;
