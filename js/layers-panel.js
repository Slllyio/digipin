/**
 * LayersPanel — registry that folds the analytics-overlay toolbar buttons into
 * the unified Layers dropdown (btn-dt-layers), Aino-style: one panel, every
 * overlay a row with a visibility toggle, instead of 16 separate buttons.
 *
 * Architecture: each analytics overlay's toggle logic lives in its toolbar
 * button's click handler (bespoke closures — buildings' off→3D→2D cycle,
 * roads' colour→minimal cycle, the uniform mod.toggle() wiring in index.html).
 * Rather than duplicating that logic, the panel row *drives the button*
 * (btn.click()) and mirrors its `.active` class — the buttons stay in the DOM
 * but are hidden by CSS. Same pattern the panel already used for LCZ/LULC.
 */
const LayersPanel = (() => {
    const GROUP = 'Analytics Overlays';

    // name/icon shown in the panel row; btnId = the hidden toolbar button that
    // owns the toggle logic; stateful = multi-state cycle (label shows mode).
    const ANALYTICS = [
        { btnId: 'btn-choropleth', name: 'Score Grid (instant)', icon: '\u{1F9EE}' },
        { btnId: 'btn-growth', name: 'Growth Forecast', icon: '\u{1F4C8}' },
        { btnId: 'btn-ca-growth', name: 'Growth Prediction (CA-ML)', icon: '\u{1F52E}' },
        { btnId: 'btn-scenario', name: 'Growth Scenario', icon: '\u{1F39B}️' },
        { btnId: 'btn-traffic', name: 'Traffic Congestion', icon: '\u{1F6A6}' },
        { btnId: 'btn-mobility', name: 'Law & Order Mobility', icon: '\u{1F693}' },
        { btnId: 'btn-heat', name: 'Urban Heat Island', icon: '\u{1F321}️' },
        { btnId: 'btn-ndvi', name: 'NDVI Vegetation', icon: '\u{1F33F}' },
        { btnId: 'btn-bivariate', name: 'Bivariate Map', icon: '\u{1F3A8}' },
        { btnId: 'btn-kde', name: 'Hotspot Density', icon: '\u{1F525}' },
        { btnId: 'btn-viewshed', name: 'Viewshed', icon: '\u{1F441}' },
        { btnId: 'btn-access', name: 'Accessibility Gaps', icon: '♿' },
        { btnId: 'btn-area', name: 'Area Summary (drag)', icon: '\u{2B1A}' },
        { btnId: 'btn-roads', name: 'Road Network', icon: '\u{1F6E3}️', stateful: true },
        { btnId: 'btn-buildings', name: 'Google Buildings', icon: '\u{1F3E2}', stateful: true },
        { btnId: 'btn-3d', name: '3D Mode', icon: '\u{1F5FA}️' },
        { btnId: 'btn-sun', name: 'Sun & Shadow Study', icon: '\u{2600}️' },
        { btnId: 'btn-measure', name: 'Measure (distance / area)', icon: '\u{1F4CF}' },
    ];

    /** Entries in the shape the unified Layers dropdown renders. */
    function entries() {
        return ANALYTICS.map(a => ({
            key: '_btn_' + a.btnId,
            name: a.name,
            icon: a.icon,
            group: GROUP,
            _btnId: a.btnId,
            _stateful: !!a.stateful,
        }));
    }

    /** Whether the overlay behind a button is currently on (.active class). */
    function isActive(btnId) {
        if (typeof document === 'undefined') return false;
        const btn = document.getElementById(btnId);
        return !!(btn && btn.classList.contains('active'));
    }

    /** The button's current mode label (e.g. roads "Color"/"Minimal"), or null. */
    function stateLabel(btnId) {
        if (typeof document === 'undefined') return null;
        const lbl = document.getElementById(btnId)?.querySelector('.tb-label');
        return lbl ? lbl.textContent : null;
    }

    /**
     * Filter predicate for the Layers-panel search box: case-insensitive,
     * whitespace-tokenised AND-match (every typed word must appear somewhere
     * in the layer name). An empty query matches everything.
     */
    function filterMatch(name, query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) return true;
        const hay = String(name || '').toLowerCase();
        return q.split(/\s+/).every(tok => hay.includes(tok));
    }

    /** Fire the (hidden) button's own handler; returns the resulting state.
     *  The synthetic click is NON-bubbling: the button's listeners still fire
     *  (target phase), but the event can't reach the document-level
     *  outside-click handler that would close the Layers panel mid-toggle. */
    function drive(btnId) {
        if (typeof document === 'undefined') return false;
        const btn = document.getElementById(btnId);
        if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: false }));
        return isActive(btnId);
    }

    return { entries, isActive, stateLabel, drive, filterMatch, ANALYTICS, GROUP };
})();

if (typeof window !== 'undefined') {
    window.LayersPanel = LayersPanel;
}
