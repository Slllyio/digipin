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
 *   &layers=<list>    overlays that were on: `heat` (toolbar overlay btn-heat),
 *                     `dt:<key>` (Digital-Twin layer), `cell:<id>` (cell store)
 *   &bc=<ds:field>    field colouring the 3D buildings (BuildingData)
 *   &bh=<ds:field>    field driving the 3D buildings' height
 *   &t=<step>         time-slider step for temporal cell layers ("2025-04")
 *   &p=<pitch>&b=<bearing>   the 3D camera; p ≥ 10 turns 3D on and lands
 *                     on exactly this centre/zoom/pitch/bearing
 *   &sun=<YYYY-MM-DDTHH:MM>  the sun study's date and hour (solar time)
 *   &intel=<tab>&ic&ia&ib&wi   the open Urban Intelligence view (js/intel-brief.js)
 *   &ag=<agent>&aa=<area>&ap=  an agent run to re-run on open (js/agents-panel.js)
 *
 * parse()/stringify() are pure (unit-tested). capture()/apply()/init() touch the
 * running app and degrade quietly when a module or the map isn't ready.
 */
const URLState = (() => {
    const round = (n, d) => {
        const f = Math.pow(10, d);
        return Math.round(n * f) / f;
    };

    // Toolbar overlays that are interactive tools or already carried by another
    // param — never restored from a link (they'd start a drag/draw mode, or the
    // score grid is `score=`).
    const NOT_SHARED = new Set(['btn-choropleth', 'btn-area', 'btn-measure', 'btn-annotate']);
    const MAX_LAYERS = 20;

    /** `layers` param → validated, de-duplicated token list (bad tokens dropped). */
    function parseLayers(raw) {
        if (!raw) return [];
        const out = [];
        for (const tok of String(raw).split(',')) {
            const t = tok.trim();
            if (!/^(?:(?:dt|cell):)?[A-Za-z0-9_-]{1,64}$/.test(t) || out.includes(t)) continue;
            out.push(t);
            if (out.length >= MAX_LAYERS) break;
        }
        return out;
    }

    /** A BuildingData "<dataset>:<field>" key, or null when malformed. */
    function _bkey(raw) {
        return raw && /^[a-z][a-z0-9_]{0,63}:[A-Za-z0-9_]{1,64}$/.test(raw) ? raw : null;
    }

    /** An ISO time-slider step ("2025", "2025-04", "2025-04-09"), or null. */
    function _step(raw) {
        return raw && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(raw) ? raw : null;
    }

    /** "2026-10-21T08:30" → { date, min }, or null when malformed. */
    function _sun(raw) {
        const m = raw && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(raw);
        if (!m) return null;
        const min = Number(m[2]) * 60 + Number(m[3]);
        return Number(m[2]) < 24 && Number(m[3]) < 60 ? { date: m[1], min } : null;
    }

    /** Query string (defaults to the live location) → plain state object. */
    function parse(search) {
        const raw = search != null ? search
            : (typeof window !== 'undefined' ? window.location.search : '');
        const p = new URLSearchParams(raw);
        const state = {};
        if (p.get('cell')) state.cell = p.get('cell');
        if (p.get('q')) state.q = p.get('q');
        if (p.get('score')) state.score = p.get('score');
        if (p.get('present') === '1') state.present = true;
        const layers = parseLayers(p.get('layers'));
        if (layers.length) state.layers = layers;
        if (_bkey(p.get('bc'))) state.bcolor = p.get('bc');
        if (_bkey(p.get('bh'))) state.bheight = p.get('bh');
        if (_step(p.get('t'))) state.t = p.get('t');
        const intel = typeof IntelBrief !== 'undefined' ? IntelBrief.parseParams(p) : null;
        if (intel) state.intel = intel;
        const agent = typeof AgentsPanel !== 'undefined' ? AgentsPanel.parseParams(p) : null;
        if (agent) state.agent = agent;
        const an = p.get('an');
        if (an) {
            try {
                const arr = JSON.parse(an);
                // Require at least one real coordinate pair, so a malformed
                // payload (e.g. an=[{}]) can't sanitise to [] and wipe stored notes.
                if (Array.isArray(arr) && arr.some(n => n && Number.isFinite(n.lat) && Number.isFinite(n.lng))) {
                    state.annotations = arr;
                }
            } catch { /* malformed annotations param — ignore */ }
        }
        const z = parseFloat(p.get('z'));
        if (Number.isFinite(z)) state.z = z;
        const pitch = parseFloat(p.get('p'));
        if (Number.isFinite(pitch) && pitch >= 0 && pitch <= 85) state.pitch = pitch;
        const bearing = parseFloat(p.get('b'));
        if (Number.isFinite(bearing)) state.bearing = ((bearing % 360) + 540) % 360 - 180;
        const sun = _sun(p.get('sun'));
        if (sun) state.sun = sun;
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
        if (state.present) p.set('present', '1');
        const layers = parseLayers(Array.isArray(state.layers) ? state.layers.join(',') : '');
        if (layers.length) p.set('layers', layers.join(','));
        if (_bkey(state.bcolor)) p.set('bc', state.bcolor);
        if (_bkey(state.bheight)) p.set('bh', state.bheight);
        if (_step(state.t)) p.set('t', state.t);
        if (state.intel && typeof IntelBrief !== 'undefined') IntelBrief.toParams(state.intel).forEach(([k, v]) => p.set(k, v));
        if (state.agent && typeof AgentsPanel !== 'undefined') AgentsPanel.toParams(state.agent).forEach(([k, v]) => p.set(k, v));
        if (Array.isArray(state.annotations) && state.annotations.length) {
            p.set('an', JSON.stringify(state.annotations.map(n =>
                ({ lat: n.lat, lng: n.lng, text: n.text, color: n.color }))));
        }
        if (Number.isFinite(state.z)) p.set('z', String(round(state.z, 2)));
        if (Number.isFinite(state.pitch) && state.pitch >= 10) {
            p.set('p', String(round(state.pitch, 1)));
            if (Number.isFinite(state.bearing) && Math.abs(state.bearing) >= 0.05) p.set('b', String(round(state.bearing, 1)));
        }
        if (state.sun && _sun(`${state.sun.date}T${String(Math.floor(state.sun.min / 60)).padStart(2, '0')}:${String(state.sun.min % 60).padStart(2, '0')}`)) {
            p.set('sun', `${state.sun.date}T${String(Math.floor(state.sun.min / 60)).padStart(2, '0')}:${String(state.sun.min % 60).padStart(2, '0')}`);
        }
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
                const btn3d = typeof document !== 'undefined' && document.getElementById('btn-3d');
                if (btn3d && btn3d.classList.contains('active') && map.getPitch) {
                    state.pitch = map.getPitch();
                    state.bearing = map.getBearing ? map.getBearing() : 0;
                }
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
        // Presentation mode travels with the share link (PresentMode owns entering
        // it on load; apply() leaves it alone).
        if (typeof PresentMode !== 'undefined' && PresentMode.isActive && PresentMode.isActive()) {
            state.present = true;
        }
        if (typeof Annotations !== 'undefined' && Annotations.getAll) {
            const a = Annotations.getAll();
            if (a.length) state.annotations = a;
        }
        const layers = activeLayers();
        if (layers.length) state.layers = layers;
        if (typeof TimeSlider !== 'undefined' && TimeSlider.current && TimeSlider.current()) {
            state.t = TimeSlider.current();
        }
        if (typeof BuildingData !== 'undefined' && BuildingData.get) {
            const b = BuildingData.get();
            if (b.color) state.bcolor = b.color;
            if (b.height) state.bheight = b.height;
        }
        if (typeof SunStudy !== 'undefined' && SunStudy.getState) {
            const sun = SunStudy.getState();
            if (sun) state.sun = sun;
        }
        if (typeof InsightsPanel !== 'undefined' && InsightsPanel.linkState) {
            const intel = InsightsPanel.linkState();
            if (intel) state.intel = intel;
        }
        if (typeof AgentsPanel !== 'undefined' && AgentsPanel.linkState) {
            const agent = AgentsPanel.linkState();
            if (agent) state.agent = agent;
        }
        return state;
    }

    /** Tokens for every overlay currently on (see the `layers` param above). */
    function activeLayers() {
        const out = [];
        if (typeof LayersPanel !== 'undefined' && LayersPanel.ANALYTICS) {
            LayersPanel.ANALYTICS.forEach(a => {
                if (!NOT_SHARED.has(a.btnId) && LayersPanel.isActive(a.btnId)) {
                    out.push(a.btnId.replace(/^btn-/, ''));
                }
            });
        }
        if (typeof DigitalTwinLayers !== 'undefined' && DigitalTwinLayers.getLayerDefs) {
            DigitalTwinLayers.getLayerDefs().forEach(d => { if (d.visible) out.push('dt:' + d.key); });
        }
        if (typeof CellLayers !== 'undefined' && CellLayers.active) {
            CellLayers.active().forEach(id => {
                // Dropped files live only in this browser — a link can't carry them.
                const local = typeof CellStore !== 'undefined' && CellStore.isLocal && CellStore.isLocal(id);
                if (!local) out.push('cell:' + id);
            });
        }
        return parseLayers(out.join(','));
    }

    /** Tick the Layers-panel row for `key` so it matches a restored layer. */
    function _syncRow(key, on) {
        if (typeof document === 'undefined') return;
        const item = document.querySelector('.dt-layer-item[data-layer-key="' + key + '"]');
        const cb = item && item.querySelector('input[type=checkbox]');
        if (cb) cb.checked = !!on;
        if (item && item.getAttribute('role') === 'switch') item.setAttribute('aria-checked', String(!!on));
    }

    /** Turn on each overlay named in a `layers` list (best-effort, skips unknowns). */
    function applyLayers(tokens) {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        (tokens || []).forEach(tok => {
            if (tok.startsWith('dt:')) {
                const key = tok.slice(3);
                if (typeof DigitalTwinLayers === 'undefined' || !DigitalTwinLayers.toggle) return;
                if (!(DigitalTwinLayers.LAYER_DEFS || {})[key] || DigitalTwinLayers.isVisible(key)) return;
                Promise.resolve(DigitalTwinLayers.toggle(key, map))
                    .then(on => _syncRow(key, on)).catch(() => { /* layer not deployed */ });
            } else if (tok.startsWith('cell:')) {
                const id = tok.slice(5);
                if (typeof CellLayers === 'undefined' || typeof CellStore === 'undefined') return;
                const show = () => { if (!CellLayers.isVisible(id)) CellLayers.show(id); };
                // The catalog loads asynchronously; wait for it if it isn't in yet.
                if (CellStore.get(id)) show();
                else if (CellStore.onChange) {
                    const off = CellStore.onChange(() => { if (CellStore.get(id)) { off(); show(); } });
                }
            } else if (typeof LayersPanel !== 'undefined') {
                const btnId = 'btn-' + tok;
                const known = LayersPanel.ANALYTICS.some(a => a.btnId === btnId);
                if (!known || NOT_SHARED.has(btnId) || LayersPanel.isActive(btnId)) return;
                LayersPanel.drive(btnId);
                // Some overlay handlers settle async (same 100 ms the panel row waits).
                setTimeout(() => _syncRow('_btn_' + btnId, LayersPanel.isActive(btnId)), 150);
            }
        });
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
        // Presentation mode (carried in share links / saved views) — enter when set.
        if (state.present && typeof PresentMode !== 'undefined' && PresentMode.enter) {
            PresentMode.enter();
        }
        if (Array.isArray(state.annotations) && typeof Annotations !== 'undefined' && Annotations.setAll) {
            Annotations.setAll(state.annotations);
        }
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
        // Building colour/height drivers before the buildings layer comes on.
        if ((state.bcolor || state.bheight) && typeof BuildingData !== 'undefined' && BuildingData.set) {
            BuildingData.set({ color: state.bcolor || null, height: state.bheight || null });
        }
        // The step first: temporal layers load async and open on it when they arrive.
        if (state.t && typeof TimeSlider !== 'undefined' && TimeSlider.want) TimeSlider.want(state.t);
        // The 3D camera and sun study are restored exactly below; their toolbar
        // tokens in `layers` would toggle the same buttons a second time.
        const skip = new Set([...(state.pitch >= 10 ? ['3d'] : []), ...(state.sun ? ['sun'] : [])]);
        const layers = Array.isArray(state.layers) ? state.layers.filter(t => !skip.has(t)) : [];
        if (layers.length) applyLayers(layers);
        if (Number.isFinite(state.pitch) && state.pitch >= 10) apply3D(state);
        else if (state.sun && typeof SunStudy !== 'undefined' && SunStudy.setState) SunStudy.setState(state.sun);
        // A Text2Map question is prefilled (running it needs a selected cell/context).
        if (state.q && typeof document !== 'undefined') {
            const input = document.getElementById('disha-input');
            if (input) input.value = state.q;
        }
        // The Intel dialog last, once the cell/view it reads is in place.
        if (state.intel && typeof InsightsPanel !== 'undefined' && InsightsPanel.applyLink) {
            Promise.resolve(InsightsPanel.applyLink(state.intel)).catch(() => { /* best-effort */ });
        }
        if (state.agent && typeof AgentsPanel !== 'undefined' && AgentsPanel.applyLink) {
            Promise.resolve(AgentsPanel.applyLink(state.agent)).catch(() => { /* best-effort */ });
        }
    }

    /**
     * Turn 3D on and land on the link's exact camera. The selection fly and
     * the 3D tilt both animate first, so the final jump waits for them (and
     * for the terrain DEM, or the camera can end up under raised ground).
     */
    function apply3D(state) {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (!map || typeof document === 'undefined') return;
        const btn3d = document.getElementById('btn-3d');
        if (btn3d && !btn3d.classList.contains('active')) btn3d.click();
        const cam = { pitch: state.pitch, bearing: Number.isFinite(state.bearing) ? state.bearing : 0 };
        if (state.ll) cam.center = [state.ll.lng, state.ll.lat];
        if (Number.isFinite(state.z)) cam.zoom = state.z;
        let done = false;
        const land = () => {
            if (done) return;
            done = true;
            map.jumpTo(cam);
            if (state.sun && typeof SunStudy !== 'undefined' && SunStudy.setState) SunStudy.setState(state.sun);
        };
        setTimeout(() => { if (map.once) map.once('idle', land); setTimeout(land, 2500); }, state.cell ? 2200 : 1200);
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

    return { parse, parseLayers, stringify, buildUrl, capture, activeLayers, apply, apply3D, applyLayers, sync, init };
})();

if (typeof window !== 'undefined') {
    window.URLState = URLState;
}
