/**
 * TimeSlider — one timeline for every temporal cell-store layer on the map
 * (datasets with spec.time, docs/CELL_STORE.md "Time series").
 *
 * Appears at the bottom of the map while at least one temporal dataset is
 * active and disappears when the last one is hidden. The timeline is the
 * union of the active datasets' steps, so a monthly LST layer and a monthly
 * NDVI layer move together; a dataset without the current step holds its
 * latest earlier step (indexFor). Play/pause loops through the steps;
 * ← / → step, Space plays, Home / End jump, when the bar has focus.
 *
 * Moving the slider calls CellLayers.setTime() — a paint-expression swap, so
 * 2D fills and 3D extrusions animate without re-uploading GeoJSON.
 *
 * mergeSteps/indexFor/formatStep/gapFor are pure and unit-tested.
 */
const TimeSlider = (() => {
    const ID = 'cell-time-slider';
    const FRAME_MS = 900;

    let _steps = [];          // merged timeline (ISO labels, ascending)
    let _i = 0;               // index into _steps
    let _timer = null;
    let _el = null;
    let _ids = [];            // temporal datasets currently driven
    let _layoutTimer = null;  // keeps the bar in the gap between side panels

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /** Sorted union of several step lists. */
    function mergeSteps(lists) {
        const all = new Set();
        (lists || []).forEach(l => (l || []).forEach(s => all.add(String(s))));
        return [...all].sort();
    }

    /** Index in `steps` of the latest step <= label (0 when label precedes them all). */
    function indexFor(steps, label) {
        let best = 0;
        for (let i = 0; i < steps.length; i++) {
            if (steps[i] <= label) best = i; else break;
        }
        return best;
    }

    /** "2025-04" → "Apr 2025", "2025-04-09" → "9 Apr 2025", "2025" → "2025". */
    function formatStep(label) {
        const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(String(label || ''));
        if (!m) return String(label || '');
        const [, y, mo, d] = m;
        if (!mo) return y;
        const name = MONTHS[Number(mo) - 1] || mo;
        return d ? `${Number(d)} ${name} ${y}` : `${name} ${y}`;
    }

    function _temporalActive() {
        if (typeof CellLayers === 'undefined' || typeof CellStore === 'undefined') return [];
        return CellLayers.active().map(id => CellStore.get(id)).filter(s => CellStore.isTemporal(s));
    }

    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }

    /** Push the current step to every driven dataset. */
    function _apply() {
        const label = _steps[_i];
        for (const id of _ids) {
            const spec = CellStore.get(id);
            if (spec) CellLayers.setTime(id, indexFor(spec.time.steps, label));
        }
        _render();
    }

    /** Jump to step index i (clamped) or, given a string, to that label. */
    function set(i) {
        if (!_steps.length) return;
        _i = typeof i === 'string' ? indexFor(_steps, i) : Math.max(0, Math.min(_steps.length - 1, Math.round(Number(i) || 0)));
        _apply();
    }

    function step(d) { if (_steps.length) set((_i + d + _steps.length) % _steps.length); }

    function play() {
        if (_timer || _steps.length < 2) return;
        _timer = setInterval(() => step(1), FRAME_MS);
        _render();
    }

    function pause() {
        if (_timer) { clearInterval(_timer); _timer = null; }
        _render();
    }

    function toggle() { if (_timer) pause(); else play(); }
    function isPlaying() { return !!_timer; }
    function current() { return _steps[_i] || null; }
    function steps() { return _steps.slice(); }

    /** Rebuild the timeline from the active layers; show/hide the bar. */
    function sync() {
        const specs = _temporalActive();
        const prevLabel = _steps[_i];
        _ids = specs.map(s => s.id);
        _steps = mergeSteps(specs.map(s => s.time.steps));
        if (!_steps.length) {
            pause();
            if (_el) { _el.remove(); _el = null; }
            if (_layoutTimer) { clearInterval(_layoutTimer); _layoutTimer = null; }
            return;
        }
        if (prevLabel) {
            _i = indexFor(_steps, prevLabel);
        } else {
            // First temporal layer: open on its default step.
            const s = specs[0];
            _i = indexFor(_steps, s.time.steps[CellLayers.defaultStep(s)]);
        }
        _apply();
    }

    /**
     * Horizontal span {left, width} for the bar: the free gap between the
     * left sidebar and the right detail panel (when open), capped at 560 px.
     * Falls back to centred in the viewport when the gap is too narrow.
     */
    function gapFor(viewW, leftEdge, rightEdge, maxW = 560) {
        const l = Math.max(12, leftEdge + 12);
        const r = Math.min(viewW - 12, rightEdge - 12);
        const w = Math.min(maxW, r - l);
        if (w < 260) {
            const full = Math.min(maxW, viewW - 24);
            return { left: (viewW - full) / 2, width: full };
        }
        return { left: l + (r - l - w) / 2, width: w };
    }

    function _layout() {
        if (!_el || typeof window === 'undefined') return;
        const vw = window.innerWidth || 1024;
        const visible = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' ? r : null;
        };
        const left = visible('#sidebar');
        const right = visible('#detail-panel.open');
        const g = gapFor(vw, left && left.left < vw / 2 ? left.right : 0, right && right.left > vw / 2 ? right.left : vw);
        _el.style.left = `${Math.round(g.left)}px`;
        _el.style.width = `${Math.round(g.width)}px`;
    }

    function _render() {
        if (typeof document === 'undefined' || !_steps.length) return;
        const pal = _palette();
        if (!_el) {
            _el = document.createElement('div');
            _el.id = ID;
            _el.setAttribute('role', 'group');
            _el.setAttribute('aria-label', 'Time slider');
            _el.tabIndex = 0;
            _el.innerHTML =
                '<button type="button" data-act="play"></button>'
                + '<button type="button" data-act="prev" aria-label="Previous step">‹</button>'
                + '<input type="range" data-act="range" min="0" step="1" aria-label="Time step">'
                + '<button type="button" data-act="next" aria-label="Next step">›</button>'
                + '<div class="ts-label"><strong data-act="label"></strong><span data-act="sub"></span></div>';
            _el.querySelector('[data-act="play"]').onclick = toggle;
            _el.querySelector('[data-act="prev"]').onclick = () => { pause(); step(-1); };
            _el.querySelector('[data-act="next"]').onclick = () => { pause(); step(1); };
            _el.querySelector('[data-act="range"]').oninput = (e) => { pause(); set(Number(e.target.value)); };
            _el.addEventListener('keydown', (e) => {
                if (e.target && e.target.tagName === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
                if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); step(-1); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); step(1); }
                else if (e.key === 'Home') { e.preventDefault(); pause(); set(0); }
                else if (e.key === 'End') { e.preventDefault(); pause(); set(_steps.length - 1); }
                else if (e.key === ' ' && e.target === _el) { e.preventDefault(); toggle(); }
            });
            document.body.appendChild(_el);
        }
        _el.style.cssText = `position:absolute;bottom:36px;z-index:6;box-sizing:border-box;`
            + `display:flex;align-items:center;gap:8px;`
            + `background:${pal.surface};border:1px solid ${pal.border};border-radius:10px;padding:8px 12px;`
            + `color:${pal.ink};font:12px/1.3 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);`;
        const btn = `background:none;border:1px solid ${pal.border};border-radius:6px;color:${pal.ink};cursor:pointer;font:inherit;min-width:28px;height:28px;`;
        const play = _el.querySelector('[data-act="play"]');
        play.textContent = _timer ? '⏸' : '▶';
        play.setAttribute('aria-label', _timer ? 'Pause' : 'Play');
        play.setAttribute('aria-pressed', String(!!_timer));
        play.style.cssText = btn + `color:${pal.primary};border-color:${pal.primary};`;
        _el.querySelectorAll('[data-act="prev"],[data-act="next"]').forEach(b => { b.style.cssText = btn; });
        const range = _el.querySelector('[data-act="range"]');
        range.max = String(_steps.length - 1);
        range.value = String(_i);
        range.style.cssText = `flex:1;accent-color:${pal.primary};min-width:80px;`;
        range.setAttribute('aria-valuetext', formatStep(_steps[_i]));
        const lbl = _el.querySelector('.ts-label');
        lbl.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;min-width:76px;white-space:nowrap;';
        _el.querySelector('[data-act="label"]').textContent = formatStep(_steps[_i]);
        const sub = _el.querySelector('[data-act="sub"]');
        sub.style.cssText = `color:${pal.sub};font-size:10px;`;
        sub.textContent = `${_i + 1} / ${_steps.length} · ${_ids.length} layer${_ids.length === 1 ? '' : 's'}`;
        _layout();
        if (!_layoutTimer && typeof setInterval !== 'undefined') _layoutTimer = setInterval(_layout, 800);
    }

    function init() {
        if (typeof CellLayers === 'undefined' || !CellLayers.onChange) return;
        CellLayers.onChange(sync);
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

    return { mergeSteps, indexFor, formatStep, gapFor, sync, set, step, play, pause, toggle, isPlaying, current, steps };
})();

if (typeof window !== 'undefined') {
    window.TimeSlider = TimeSlider;
}
