/**
 * Quality3D — 3D detail levels, so the city stays smooth on low-end phones.
 *
 *   high      full pixel density (≤2×), 6,000 park + 4,000 street trees,
 *             shadows for 9,000 buildings, terrain
 *   balanced  ≤1.5× pixels, 2,000 + 1,200 trees, 3,000 shadows, terrain
 *   lite      1× pixels, no trees, sky-only sun study, flat ground
 *
 * "Auto" (the default) picks a level from the device (memory, cores, a
 * small touch screen) and then watches the frame rate while the 3D camera
 * moves: when a move renders below ~22 fps it steps down one level, once per
 * move, and says so. The choice lives on the 3D shot bar; a manual pick is
 * remembered, an automatic step-down only for the session. Pixel density
 * changes apply only while 3D is on, so the 2D map is untouched.
 *
 * detectTier()/medianFps()/nextDown()/limitsFor() are pure (unit-tested).
 */
const Quality3D = (() => {
    const ORDER = ['high', 'balanced', 'lite'];
    const LABEL = { auto: 'Auto', high: 'High', balanced: 'Balanced', lite: 'Lite' };
    const LIMITS = {
        high: { maxDpr: 2, parkTrees: 6000, streetTrees: 4000, shadows: 9000, terrain: true },
        balanced: { maxDpr: 1.5, parkTrees: 2000, streetTrees: 1200, shadows: 3000, terrain: true },
        lite: { maxDpr: 1, parkTrees: 0, streetTrees: 0, shadows: 0, terrain: false },
    };
    const KEY = 'digipin_3d_quality';        // 'auto' | tier (manual pick)
    const SKEY = 'digipin_3d_quality_auto';  // tier reached by auto step-down this session
    const MIN_FPS = 22;
    const MIN_SAMPLES = 20;

    /** Starting tier for a device: { deviceMemory, cores, coarse, width }. Pure. */
    function detectTier(d) {
        const mem = d && Number(d.deviceMemory), cores = d && Number(d.cores);
        if ((mem && mem <= 2) || (cores && cores <= 2)) return 'lite';
        if ((mem && mem <= 4) || (cores && cores <= 4) || (d && d.coarse && d.width <= 768)) return 'balanced';
        return 'high';
    }

    /** Median frames per second of frame intervals in ms, or null with too few. Pure. */
    function medianFps(intervals, min = MIN_SAMPLES) {
        const xs = (intervals || []).filter(x => x > 0 && x < 2000).sort((a, b) => a - b);
        if (xs.length < min) return null;
        const m = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
        return 1000 / m;
    }

    /** One level lighter, or null at the bottom. Pure. */
    function nextDown(tier) {
        const i = ORDER.indexOf(tier);
        return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
    }

    /** Budgets for a tier (unknown → high). Pure. */
    function limitsFor(tier) {
        return { tier: LIMITS[tier] ? tier : 'high', ...(LIMITS[tier] || LIMITS.high) };
    }

    // ── runtime ──────────────────────────────────────────────────────────────
    let _mode = 'auto';       // 'auto' or a fixed tier
    let _tier = 'high';       // effective tier
    let _is3d = false;
    const _listeners = new Set();

    function _store(k, v, session) {
        try { (session ? sessionStorage : localStorage)[v == null ? 'removeItem' : 'setItem'](k, v); } catch { /* private mode */ }
    }
    function _read(k, session) {
        try { return (session ? sessionStorage : localStorage).getItem(k); } catch { return null; }
    }

    function _device() {
        if (typeof navigator === 'undefined' || typeof window === 'undefined') return {};
        const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        return { deviceMemory: navigator.deviceMemory, cores: navigator.hardwareConcurrency, coarse, width: window.innerWidth };
    }

    function _map() {
        return typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
    }

    function get() { return { mode: _mode, tier: _tier, ...limitsFor(_tier) }; }
    function limits() { return limitsFor(_tier); }
    function onChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

    function _applyMap() {
        const map = _map();
        if (!map || !map.setPixelRatio || typeof window === 'undefined') return;
        const dpr = window.devicePixelRatio || 1;
        try { map.setPixelRatio(_is3d ? Math.min(dpr, limitsFor(_tier).maxDpr) : dpr); } catch { /* older MapLibre */ }
    }

    function _setTier(tier, why) {
        if (!LIMITS[tier] || tier === _tier) { _render(); return; }
        _tier = tier;
        _applyMap();
        if (_is3d && !limitsFor(tier).terrain) _flatten();
        _render();
        _listeners.forEach(fn => { try { fn(get(), why); } catch { /* listener's own */ } });
    }

    /** Lite: drop the terrain DEM while 3D is on (it costs most on weak GPUs). */
    function _flatten() {
        const map = _map();
        if (map && typeof Terrain !== 'undefined' && Terrain.isEnabled && Terrain.isEnabled()) {
            try { Terrain.setEnabled(map, false); } catch { /* terrain optional */ }
        }
    }

    /** User pick: 'auto' or a tier. */
    function set(mode) {
        if (mode !== 'auto' && !LIMITS[mode]) return;
        _mode = mode;
        _store(KEY, mode);
        _store(SKEY, null, true);
        _setTier(mode === 'auto' ? detectTier(_device()) : mode, 'manual');
    }

    // Frame-rate watch: intervals between renders while the camera moves in 3D.
    let _moving = false, _last = 0, _samples = [];
    function _onRender() {
        if (!_moving || !_is3d) return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (_last) _samples.push(now - _last);
        _last = now;
    }
    function _onMoveEnd() {
        _moving = false;
        const fps = medianFps(_samples);
        _samples = [];
        _last = 0;
        if (_mode !== 'auto' || fps == null || fps >= MIN_FPS) return;
        const down = nextDown(_tier);
        if (!down) return;
        _store(SKEY, down, true);
        _setTier(down, 'fps');
        if (typeof App !== 'undefined' && App.showToast) {
            App.showToast('Smoother 3D', `Moving at ${Math.round(fps)} fps, so 3D detail is now ${LABEL[down]}. Change it on the 3D bar.`, 'info');
        }
    }

    let _el = null;
    function _render() {
        if (!_el) return;
        const sel = _el.querySelector('select');
        if (sel) sel.value = _mode;
        const opt = _el.querySelector('option[value="auto"]');
        if (opt) opt.textContent = `Auto (${LABEL[_tier]})`;
    }

    /** Mount the detail picker into the 3D shot bar (CameraPresets calls this). */
    function mount(bar) {
        if (!bar || typeof document === 'undefined') return;
        _el = document.createElement('label');
        _el.className = 'cp-quality';
        _el.title = '3D detail: lighter levels drop trees, shadows, terrain and pixel density for smoother motion';
        _el.innerHTML = '<span class="cp-label">Detail</span><select aria-label="3D detail level">'
            + ['auto', ...ORDER].map(k => `<option value="${k}">${LABEL[k]}</option>`).join('') + '</select>';
        _el.querySelector('select').addEventListener('change', (e) => set(e.target.value));
        bar.appendChild(_el);
        _render();
    }

    function init() {
        const saved = _read(KEY);
        _mode = saved && (saved === 'auto' || LIMITS[saved]) ? saved : 'auto';
        const stepped = _read(SKEY, true);
        _tier = _mode !== 'auto' ? _mode : (LIMITS[stepped] ? stepped : detectTier(_device()));
        const map = _map();
        if (map) {
            map.on('movestart', () => { _moving = true; _samples = []; _last = 0; });
            map.on('render', _onRender);
            map.on('moveend', _onMoveEnd);
        }
        const btn = typeof document !== 'undefined' && document.getElementById('btn-3d');
        if (btn && typeof MutationObserver !== 'undefined') {
            _is3d = btn.classList.contains('active');
            new MutationObserver(() => {
                const on = btn.classList.contains('active');
                if (on === _is3d) return;
                _is3d = on;
                _applyMap();
                // The toolbar turns terrain on with 3D; Lite takes it back off.
                if (on && !limitsFor(_tier).terrain) setTimeout(_flatten, 0);
            }).observe(btn, { attributes: true, attributeFilter: ['class'] });
        }
        _render();
    }

    return { init, mount, get, set, limits, onChange, detectTier, medianFps, nextDown, limitsFor, ORDER };
})();

if (typeof window !== 'undefined') {
    window.Quality3D = Quality3D;
}
