/**
 * LayerCounts — a live count beside each layer that is on, in the Layers
 * menu and the Aino Layers card ("Live sky 12", "Population 3.2k"), the way
 * the Offentligdata dashboard shows how many things each layer is drawing.
 *
 * Counters are small functions keyed by layer-menu key; anything that
 * returns null (or a layer that is off) shows no count. Built-in counters
 * cover the live layers, 3D buildings and every cell layer; other modules
 * can add their own with LayerCounts.register(key, fn).
 *
 * compact() is pure (unit-tested); the rest touches the DOM on a 2 s tick.
 */
const LayerCounts = (() => {
    const TICK_MS = 2000;
    const _counters = new Map();   // key -> () => number|null
    let _timer = null;

    /** 7 / 950 / 1.2k / 34k / 1.2M — short enough for a menu row. */
    function compact(n) {
        if (n == null || !Number.isFinite(n)) return '';
        const a = Math.abs(n);
        if (a < 1000) return String(Math.round(n));
        if (a < 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
        if (a < 1e6) return `${Math.round(n / 1e3)}k`;
        return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    }

    function register(key, fn) { _counters.set(key, fn); }

    /** The count for a layer key, or null. Cell layers ("_cell_<id>") are generic. */
    function countFor(key) {
        try {
            if (_counters.has(key)) return _counters.get(key)();
            if (key.startsWith('_cell_') && typeof CellLayers !== 'undefined') {
                const st = CellLayers.state(key.slice('_cell_'.length));
                return st && st.cells ? st.cells : null;
            }
        } catch { /* a counter must never break the menu */ }
        return null;
    }

    function _badge(host) {
        let b = host.querySelector(':scope > .layer-count');
        if (!b) {
            b = document.createElement('span');
            b.className = 'layer-count';
            b.setAttribute('aria-hidden', 'true');
            const anchor = host.querySelector(':scope > .dt-toggle-switch, :scope > .ar-eye');
            host.insertBefore(b, anchor || null);
        }
        return b;
    }

    function _paint(host, key, on) {
        const n = on ? countFor(key) : null;
        const text = n == null ? '' : compact(n);
        const existing = host.querySelector(':scope > .layer-count');
        if (!text) { if (existing) existing.remove(); return; }
        const b = existing || _badge(host);
        if (b.textContent !== text) b.textContent = text;
        b.title = `${n.toLocaleString('en-IN')} drawn now`;
    }

    function update() {
        if (typeof document === 'undefined') return;
        document.querySelectorAll('.dt-layer-item[aria-checked="true"]').forEach(it => _paint(it, it.dataset.layerKey || '', true));
        document.querySelectorAll('.dt-layer-item[aria-checked="false"] > .layer-count').forEach(b => b.remove());
        document.querySelectorAll('#aino-right .ar-row[data-ar-key]').forEach(r => _paint(r, r.dataset.arKey, true));
    }

    function start() {
        if (_timer || typeof window === 'undefined') return;
        _timer = setInterval(() => { if (!document.hidden) update(); }, TICK_MS);
        update();
    }

    // Built-in counters.
    register('_btn_btn-livesky', () => (typeof LiveSky !== 'undefined' && LiveSky.isActive()
        ? LiveSky.aircraft().filter(a => !a.onGround).length : null));
    register('_btn_btn-livenow', () => {
        const s = typeof LiveNow !== 'undefined' && LiveNow.isActive() && LiveNow.snapshot();
        return s ? s.correlations.length : null;
    });
    register('_btn_btn-places', () => (typeof PlacesNearby !== 'undefined' && PlacesNearby.isActive()
        ? PlacesNearby.places().length : null));
    register('_btn_btn-satpasses', () => (typeof SatPasses !== 'undefined' && SatPasses.isActive()
        ? SatPasses.satellites().length : null));
    register('_btn_btn-buildings', () => {
        if (typeof DeckBuildings === 'undefined' || !DeckBuildings.isEnabled || !DeckBuildings.isEnabled()) return null;
        const s = DeckBuildings.renderStats && DeckBuildings.renderStats();
        return s && s.polygons ? s.polygons : null;
    });

    // Deferred scripts run before DOMContentLoaded, so this starts the tick in
    // the app; under the unit tests the event has already fired and it doesn't.
    if (typeof document !== 'undefined' && document.readyState !== 'complete') {
        document.addEventListener('DOMContentLoaded', start);
    }

    return { compact, register, countFor, update, start };
})();

if (typeof window !== 'undefined') window.LayerCounts = LayerCounts;
