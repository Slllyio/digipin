/**
 * DISHAActions — let DISHA drive the map. Native LLM tool-calling isn't viable
 * here (the providers stream text only), so the model emits machine-readable
 * directives in its reply, one per line:
 *
 *   [ACTION] flyTo lat:22.72 lng:75.86 zoom:15
 *   [ACTION] selectCell code:39J-49L-L8T4
 *   [ACTION] overlay name:flood
 *   [ACTION] query id:best_residential
 *
 * After the stream completes, disha-panel parses these, strips them from the
 * shown text, executes them against the app, and renders ✓/✗ confirmation chips.
 *
 * `parseActions`, `stripActions`, `_parseParams` are pure + unit-tested.
 * `executeActions` dispatches via a registry (each handler validates its params
 * and is wrapped so one bad action can't break the others). See docs.
 */
const DISHAActions = (() => {
    const ACTION_RE = /^\s*\[ACTION\]\s+([a-zA-Z_]+)\s*(.*)$/;

    /** Parse "k:v k2:'two words'" → {k:v}; numeric-looking values coerced. Pure. */
    function _parseParams(s) {
        const out = {};
        const re = /([a-zA-Z_]+)\s*:\s*("[^"]*"|'[^']*'|\S+)/g;
        let m;
        while ((m = re.exec(s || ''))) {
            const v = m[2].replace(/^['"]|['"]$/g, '');
            const n = Number(v);
            out[m[1]] = (v !== '' && !Number.isNaN(n)) ? n : v;
        }
        return out;
    }

    /** Extract [ACTION] directives from reply text → [{type, params}]. Pure. */
    function parseActions(text) {
        const actions = [];
        for (const line of String(text || '').split('\n')) {
            const m = line.match(ACTION_RE);
            if (m) actions.push({ type: m[1].toLowerCase(), params: _parseParams(m[2]) });
        }
        return actions;
    }

    /** Remove [ACTION] lines from the text shown to the user. Pure. */
    function stripActions(text) {
        return String(text || '')
            .split('\n')
            .filter(l => !ACTION_RE.test(l))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // Resolve a module global at call time (window in the browser, globalThis in
    // tests) — the same `window.X` lookup the toolbar wiring uses in app.html.
    function _g(name) {
        return (typeof window !== 'undefined' && window[name])
            || (typeof globalThis !== 'undefined' && globalThis[name])
            || undefined;
    }

    // Overlay name → a toggle thunk. Most overlays expose a no-arg toggle()
    // (the same set the toolbar drives); a few are adapted: OvertureBuildings
    // needs the map instance, and WardOverlay is a show()/clear() pair. The
    // HeatmapOverlay is intentionally absent — its show() requires a score key,
    // so it can't be driven by a bare toggle directive. A missing/undefined
    // module surfaces as a failed chip via executeActions' try/catch.
    const OVERLAYS = {
        growth:     () => _g('GrowthOverlay').toggle(),
        prediction: () => _g('CAGrowthOverlay').toggle(),
        scenario:   () => _g('ScenarioPanel').toggle(),
        traffic:    () => _g('TrafficOverlay').toggle(),
        mobility:   () => _g('MobilityOverlay').toggle(),
        heat:       () => _g('HeatOverlay').toggle(),
        ndvi:       () => _g('NDVIOverlay').toggle(),
        bivariate:  () => _g('BivariateOverlay').toggle(),
        kde:        () => _g('KDEOverlay').toggle(),
        access:     () => _g('AccessibilityOverlay').toggle(),
        grid:       () => _g('ScoreChoropleth').toggle(),
        wards:      () => { const w = _g('WardOverlay'); return w.isVisible() ? w.clear() : w.show(); },
        buildings:  () => _g('OvertureBuildings').toggle(_g('MapModule').getMap()),
    };

    /** Dispatch table: type → handler returning a label, or throwing on bad input. */
    const REGISTRY = {
        flyto(p) {
            if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) throw new Error('flyTo needs numeric lat,lng');
            MapModule.flyTo(p.lat, p.lng, Number.isFinite(p.zoom) ? p.zoom : 16);
            return `Flew to ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
        },
        selectcell(p) {
            if (!p.code) throw new Error('selectCell needs a code');
            MapModule.selectByCode(String(p.code));
            return `Opened cell ${p.code}`;
        },
        overlay(p) {
            const name = String(p.name || '').toLowerCase();
            const fn = OVERLAYS[name];
            if (!fn) throw new Error(`unknown overlay "${name}"`);
            fn();
            return `Toggled ${name} overlay`;
        },
        query(p) {
            if (!p.id) throw new Error('query needs an id');
            if (typeof QueryEngine === 'undefined' || !QueryEngine.runQuery) throw new Error('query engine unavailable');
            QueryEngine.runQuery(String(p.id));
            return `Ran query "${p.id}"`;
        },
        // Agentic skills (DishaAgent): run a municipal skill over the feature store /
        // indices / exposure, then execute whatever map actions it returns. Async —
        // kicks off and resolves later, so the chip reports dispatch, not the result.
        agent(p) {
            const A = _g('DishaAgent');
            if (!A || !A.run) throw new Error('agent unavailable');
            const skill = String(p.skill || '');
            if (!skill) throw new Error('agent needs a skill');
            Promise.resolve(A.run(skill, p, {})).then(res => {
                if (res && Array.isArray(res.actions) && res.actions.length) {
                    executeActions(parseActions(res.actions.join('\n')), 8);
                }
            }).catch(() => { /* skill failures are surfaced in its own summary */ });
            return `Ran agent skill "${skill}"`;
        },
    };

    /** Execute parsed actions (capped). Returns [{type, ok, label|error}]. */
    function executeActions(actions, max = 3) {
        const results = [];
        for (const a of (actions || []).slice(0, max)) {
            const fn = REGISTRY[a.type];
            if (!fn) { results.push({ type: a.type, ok: false, error: 'unknown action' }); continue; }
            try {
                results.push({ type: a.type, ok: true, label: fn(a.params || {}) });
            } catch (e) {
                results.push({ type: a.type, ok: false, error: e && e.message ? e.message : 'failed' });
            }
        }
        return results;
    }

    return { parseActions, stripActions, executeActions, _parseParams, OVERLAYS };
})();

if (typeof window !== 'undefined') window.DISHAActions = DISHAActions;
