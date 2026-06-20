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

    // Toggleable overlays (all expose .toggle() — same set the toolbar drives).
    const OVERLAYS = {
        heatmap: 'HeatmapOverlay', wards: 'WardOverlay', buildings: 'OvertureBuildings',
        growth: 'GrowthOverlay', prediction: 'CAGrowthOverlay', scenario: 'ScenarioPanel',
        traffic: 'TrafficOverlay', mobility: 'MobilityOverlay', heat: 'HeatOverlay',
        ndvi: 'NDVIOverlay', bivariate: 'BivariateOverlay', kde: 'KDEOverlay',
        access: 'AccessibilityOverlay', grid: 'ScoreChoropleth',
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
            const globalName = OVERLAYS[name];
            if (!globalName) throw new Error(`unknown overlay "${p.name}"`);
            const mod = (typeof window !== 'undefined' ? window[globalName] : undefined)
                || (typeof globalThis !== 'undefined' ? globalThis[globalName] : undefined);
            if (!mod || typeof mod.toggle !== 'function') throw new Error(`overlay "${name}" unavailable`);
            mod.toggle();
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

    return { parseActions, stripActions, executeActions, _parseParams, OVERLAYS };
})();

if (typeof window !== 'undefined') window.DISHAActions = DISHAActions;
