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

    // ===== AGENT TOOLS =====
    // The Urban Analyst Agent (js/disha-agent.js) needs read tools that return
    // data (not just fire-and-forget map actions), and async handlers. These
    // live in a separate async registry so the sync single-shot path above is
    // untouched. Handlers may return a string (state change, label only) or
    // {label, observation} — read tools feed `observation` back to the model.

    // Per-run index of code → {lat,lng}, populated by rankCells so later tools
    // can resolve codes the model saw in an [OBSERVATION] even when they are
    // display prefixes DigiPin.decode() would reject. Cleared between runs.
    const _cellIndex = new Map();
    /** Normalize a DIGIPIN code for indexing (drop dashes, uppercase). */
    function _norm(code) { return String(code || '').replace(/-/g, '').toUpperCase(); }

    /** Current map viewport as {south,west,north,east}, or {} when the map isn't ready. */
    function _bounds() {
        const MM = _g('MapModule');
        if (!MM || !MM.getMap) return {};
        const map = MM.getMap();
        if (!map || !map.getBounds) return {};
        const b = map.getBounds();
        return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    }

    /** Resolve {lat,lng} from explicit coords, the rankCells index, or DigiPin.decode. Throws if none work. */
    function _coords(params) {
        if (Number.isFinite(params.lat) && Number.isFinite(params.lng)) return { lat: params.lat, lng: params.lng };
        const key = _norm(params.code);
        if (key && _cellIndex.has(key)) return _cellIndex.get(key);
        const DP = _g('DigiPin');
        if (params.code && DP && DP.decode) {
            const d = DP.decode(String(params.code));   // throws on bad/partial codes
            return { lat: d.lat, lng: d.lng };
        }
        throw new Error('could not resolve a location');
    }

    /** Cell data via IndexedDB cache, falling back to a live fetch (cached for reuse). */
    async function _fetchData(lat, lng) {
        const Cache = _g('DISHACache');
        if (Cache && Cache.getCellData) {
            const cached = await Cache.getCellData(lat, lng);
            if (cached) return cached;
        }
        const DF = _g('DataFetcher');
        if (!DF || !DF.fetchAllFeatures) throw new Error('data fetcher unavailable');
        const data = await DF.fetchAllFeatures(lat, lng, 400);
        if (data && Cache && Cache.putCellData) { try { Cache.putCellData(lat, lng, data); } catch { /* cache is best-effort */ } }
        return data;
    }

    /** Non-zero score fields as "key=value", strongest first. */
    function _scoreLine(data) {
        const scores = (data && data.scores) || {};
        return Object.entries(scores)
            .filter(([, s]) => s && s.value > 0)
            .sort((a, b) => b[1].value - a[1].value)
            .map(([k, s]) => `${k}=${s.value}`);
    }

    const AGENT_REGISTRY = {
        async rankcells(p) {
            const Text2Map = _g('Text2Map');
            if (!Text2Map || !Text2Map.run) throw new Error('ranking engine unavailable');
            const out = await Text2Map.run(p.brief, _bounds());
            const results = (out && out.results) || [];
            results.forEach(r => {
                if (r && r.code && Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
                    _cellIndex.set(_norm(r.code), { lat: r.lat, lng: r.lng });
                }
            });
            const RL = _g('Text2MapResultsLayer');
            if (RL && RL.show && results.length) { try { RL.show(results); } catch { /* map paint is best-effort */ } }
            const top = results.slice(0, 5).map((r, i) => `#${i + 1} ${r.code} (${Math.round(r.score || 0)}${r.area ? ', ' + r.area : ''})`);
            return {
                label: `Ranked ${results.length} cells`,
                observation: `rankCells "${String(p.brief).slice(0, 60)}": ${top.join('; ') || 'no matches in view'}`,
            };
        },

        async getcelldata(p) {
            const { lat, lng } = _coords(p);
            _cellIndex.set(_norm(p.code), { lat, lng });
            const data = await _fetchData(lat, lng);
            const parts = _scoreLine(data);
            return {
                label: `Read ${p.code}`,
                observation: `getCellData ${p.code}: ${parts.join(', ') || 'no scored data'}`,
            };
        },

        async comparecells(p) {
            const Compare = _g('Compare');
            if (!Compare || !Compare.compareBriefModel) throw new Error('compare unavailable');
            const codes = String(p.codes).split(',').filter(Boolean).slice(0, 3);
            const pinned = [];
            for (const code of codes) {
                try {
                    const { lat, lng } = _coords({ code });
                    const data = await _fetchData(lat, lng);
                    if (data) pinned.push({ cell: { code, center: { lat, lng } }, data });
                } catch { /* skip a code we can't resolve */ }
            }
            if (pinned.length < 2) throw new Error('need at least 2 resolvable cells to compare');
            const model = Compare.compareBriefModel(pinned);
            const lines = model.metricKeys.slice(0, 10).map(k => {
                const label = model.cells.map(c => c.metrics[k]).find(Boolean)?.label || k;
                return `${label}: ` + model.cells.map(c => {
                    const m = c.metrics[k];
                    return `${c.code}=${m ? m.value : '—'}`;
                }).join(', ');
            });
            return {
                label: `Compared ${pinned.map(x => x.cell.code).join(' vs ')}`,
                observation: `compareCells:\n${lines.join('\n')}`,
            };
        },

        async generatesitebrief(p) {
            const SiteBrief = _g('SiteBrief');
            if (!SiteBrief || !SiteBrief.build) throw new Error('site brief unavailable');
            const { lat, lng } = _coords(p);
            const data = await _fetchData(lat, lng);
            const model = SiteBrief.build(data, { code: p.code, center: { lat, lng } });
            const narr = SiteBrief.narrative(model);
            return { label: `Site brief for ${p.code}`, observation: `siteBrief ${p.code}: ${narr}` };
        },

        runisochrone(p) {
            const Iso = _g('Isochrone');
            if (!Iso || !Iso.show) throw new Error('isochrone unavailable');
            const { lat, lng } = _coords(p);
            Iso.show(lat, lng);
            return 'Showing 5/10/15-min walking zones';
        },

        finish() { return { label: 'done', observation: '' }; },
    };

    /**
     * Execute agent tool directives (async). Validates args via DISHATools,
     * caps state-changing tools per run, and returns [{type, ok, label,
     * observation?, error?}]. `counters` is mutated so the map-mutation cap
     * spans the whole run when the caller passes the same object each step.
     */
    async function executeAgentActions(actions, opts = {}) {
        const max = Number.isFinite(opts.max) ? opts.max : 3;
        const mapMutationCap = Number.isFinite(opts.mapMutationCap) ? opts.mapMutationCap : Infinity;
        const counters = opts.counters || { mutations: 0 };
        const results = [];

        for (const a of (actions || []).slice(0, Math.max(0, max))) {
            const type = String(a.type || '').toLowerCase();
            const tool = (typeof DISHATools !== 'undefined') ? DISHATools.getTool(type) : null;

            let params = a.params || {};
            if (tool && typeof DISHATools !== 'undefined') {
                const v = DISHATools.validateArgs(type, params);
                if (!v.ok) { results.push({ type, ok: false, error: v.error }); continue; }
                params = v.args;
            }

            const isState = tool ? tool.kind === 'state' : true;
            if (isState && counters.mutations >= mapMutationCap) {
                results.push({ type, ok: false, error: 'map-change limit reached this run' });
                continue;
            }

            const fn = AGENT_REGISTRY[type] || REGISTRY[type];
            if (!fn) { results.push({ type, ok: false, error: 'unknown action' }); continue; }

            try {
                const out = await fn(params);
                if (isState) counters.mutations++;
                if (out && typeof out === 'object') {
                    results.push({ type, ok: true, label: out.label || 'done', observation: out.observation });
                } else {
                    results.push({ type, ok: true, label: String(out) });
                }
            } catch (e) {
                results.push({ type, ok: false, error: (e && e.message) ? e.message : 'failed' });
            }
        }
        return results;
    }

    /** Clear the per-run cell-coordinate index (between agent runs and in tests). */
    function _resetAgentState() { _cellIndex.clear(); }

    return { parseActions, stripActions, executeActions, executeAgentActions, _parseParams, OVERLAYS, _resetAgentState };
})();

if (typeof window !== 'undefined') window.DISHAActions = DISHAActions;
