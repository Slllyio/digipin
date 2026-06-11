/**
 * URLState — shareable deep-links for the map view.
 *
 * DIGIPIN cells are a permanent address primitive, so any view can be captured
 * as a URL and reopened exactly — the share/permalink moat a non-DIGIPIN tool
 * can't match. State lives in the query string and is written with
 * history.replaceState (no Back-button spam):
 *
 *   ?cell=<digipin>   selected cell (fly + open panel + fetch)
 *   &ll=<lat,lng>     map centre
 *   &z=<zoom>         map zoom
 *   &score=<id>       active score-choropleth field
 *   &q=<question>     a Text2Map question to prefill in DISHA
 *
 * parse()/stringify() are pure (unit-tested). capture()/apply()/init() touch the
 * running app and degrade quietly when a module or the map isn't ready.
 */
const URLState = (() => {
    const round = (n, d) => {
        const f = Math.pow(10, d);
        return Math.round(n * f) / f;
    };

    /** Query string (defaults to the live location) → plain state object. */
    function parse(search) {
        const raw = search != null ? search
            : (typeof window !== 'undefined' ? window.location.search : '');
        const p = new URLSearchParams(raw);
        const state = {};
        if (p.get('cell')) state.cell = p.get('cell');
        if (p.get('q')) state.q = p.get('q');
        if (p.get('score')) state.score = p.get('score');
        const z = parseFloat(p.get('z'));
        if (Number.isFinite(z)) state.z = z;
        const ll = p.get('ll');
        if (ll) {
            const [lat, lng] = ll.split(',').map(Number);
            if (Number.isFinite(lat) && Number.isFinite(lng)) state.ll = { lat, lng };
        }
        return state;
    }

    /** State object → query string (stable key order, empties omitted). */
    function stringify(state) {
        const p = new URLSearchParams();
        if (state.cell) p.set('cell', state.cell);
        if (state.q) p.set('q', state.q);
        if (state.score) p.set('score', state.score);
        if (Number.isFinite(state.z)) p.set('z', String(round(state.z, 2)));
        if (state.ll && Number.isFinite(state.ll.lat) && Number.isFinite(state.ll.lng)) {
            p.set('ll', `${round(state.ll.lat, 5)},${round(state.ll.lng, 5)}`);
        }
        return p.toString();
    }

    /** Full shareable URL for a state, rooted at the current origin+path. */
    function buildUrl(state) {
        const qs = stringify(state);
        if (typeof window === 'undefined') return qs ? `?${qs}` : '';
        const { origin, pathname } = window.location;
        return qs ? `${origin}${pathname}?${qs}` : `${origin}${pathname}`;
    }

    /** Snapshot the running app's view into a state object. */
    function capture() {
        const state = {};
        if (typeof MapModule !== 'undefined' && MapModule.getMap) {
            const map = MapModule.getMap();
            if (map && map.getCenter) {
                const c = map.getCenter();
                state.ll = { lat: c.lat, lng: c.lng };
                state.z = map.getZoom();
            }
            if (MapModule.getSelectedCode && MapModule.getSelectedCode()) {
                state.cell = MapModule.getSelectedCode();
            }
        }
        if (typeof ScoreChoropleth !== 'undefined' && ScoreChoropleth.isActive && ScoreChoropleth.isActive()) {
            state.score = ScoreChoropleth.getScoreKey();
        }
        if (typeof document !== 'undefined') {
            const input = document.getElementById('disha-input');
            if (input && input.value.trim()) state.q = input.value.trim();
        }
        return state;
    }

    /** Push the current view into the address bar without a history entry. */
    function sync() {
        if (typeof window === 'undefined' || !window.history) return;
        const qs = stringify(capture());
        const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
        window.history.replaceState(null, '', url);
    }

    /** Apply a parsed state to the running app (best-effort, order matters). */
    function apply(state) {
        if (!state) return;
        // Score choropleth first so the cell/fly paints over the right colouring.
        if (state.score && typeof ScoreChoropleth !== 'undefined') {
            ScoreChoropleth.setScore(state.score);
            const gridReady = typeof PrecomputedScores !== 'undefined'
                && PrecomputedScores.isEnabled && PrecomputedScores.isEnabled();
            if (gridReady && !ScoreChoropleth.isActive()) ScoreChoropleth.show(state.score);
        }
        if (typeof MapModule !== 'undefined') {
            if (state.cell && MapModule.selectByCode) {
                MapModule.selectByCode(state.cell);          // flies + selects + fetches
            } else if (state.ll && MapModule.flyTo) {
                MapModule.flyTo(state.ll.lat, state.ll.lng, state.z || 15);
            }
        }
        // A Text2Map question is prefilled (running it needs a selected cell/context).
        if (state.q && typeof document !== 'undefined') {
            const input = document.getElementById('disha-input');
            if (input) input.value = state.q;
        }
    }

    function _copyShareLink() {
        const url = buildUrl(capture());
        const done = () => {
            if (typeof App !== 'undefined' && App.showToast) {
                App.showToast('Link copied', 'Shareable view URL is on your clipboard.', 'success');
            }
        };
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done).catch(() => {
                if (typeof window !== 'undefined') window.prompt('Copy this link:', url);
            });
        } else if (typeof window !== 'undefined') {
            window.prompt('Copy this link:', url);
        }
    }

    function init() {
        if (typeof document !== 'undefined') {
            const btn = document.getElementById('share-btn');
            if (btn) btn.addEventListener('click', _copyShareLink);
        }
        const state = parse();
        if (Object.keys(state).length === 0) return;
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        const run = () => apply(state);
        if (map && map.loaded && map.loaded()) run();
        else if (map && map.once) map.once('load', run);
        else run();
    }

    return { parse, stringify, buildUrl, capture, apply, sync, init };
})();

if (typeof window !== 'undefined') {
    window.URLState = URLState;
}
