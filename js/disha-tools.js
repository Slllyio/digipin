/**
 * DISHATools — the single declarative source of truth for DISHA's tool set.
 *
 * One `TOOLS` array describes every directive the model may emit. Everything
 * else is derived from it so the prompt, the validator, and (later) native
 * function-calling can never drift apart:
 *   - renderSystemPrompt({agent}) → the `[ACTION]` instruction block
 *   - validateArgs(name, params)  → an allowlist/coercion gate (mirrors
 *                                    Text2Map.validateWeights) run before dispatch
 *   - toOpenAI({agent})           → an OpenAI `tools` array (Phase-2 native path)
 *
 * `agentOnly` tools are the multi-step analysis tools the Urban Analyst Agent
 * uses (js/disha-agent.js); the four map actions are also offered in normal
 * single-shot chat. `kind` is 'read' (no side effects the user sees) or
 * 'state' (moves the map / paints a layer) — the agent caps state tools per run.
 */
const DISHATools = (() => {
    // Same alphabet the DIGIPIN encoder and disha-panel's code linkifier use.
    const DIGIPIN_ALPHABET = new Set('23456789CFJKLMPT'.split(''));

    const OVERLAY_NAMES = ['growth', 'prediction', 'scenario', 'traffic', 'mobility',
        'heat', 'ndvi', 'bivariate', 'kde', 'access', 'grid', 'wards', 'buildings'];

    const TOOLS = [
        // ---- map actions (offered in normal chat AND to the agent) ----
        {
            name: 'flyTo', type: 'flyto', kind: 'state', agentOnly: false,
            args: { lat: { type: 'number', required: true }, lng: { type: 'number', required: true }, zoom: { type: 'number' } },
            desc: 'Move the map camera to a coordinate.',
            example: '[ACTION] flyTo lat:22.7196 lng:75.8577 zoom:15',
        },
        {
            name: 'selectCell', type: 'selectcell', kind: 'state', agentOnly: false,
            args: { code: { type: 'digipin', required: true } },
            desc: 'Open the detail panel for a DIGIPIN cell.',
            example: '[ACTION] selectCell code:39J-49L-L8T4',
        },
        {
            name: 'overlay', type: 'overlay', kind: 'state', agentOnly: false,
            args: { name: { type: 'enum', values: OVERLAY_NAMES, required: true } },
            desc: `Toggle a map overlay (${OVERLAY_NAMES.join(', ')}).`,
            example: '[ACTION] overlay name:heat',
        },
        {
            name: 'query', type: 'query', kind: 'state', agentOnly: false,
            args: { id: { type: 'string', required: true } },
            desc: 'Run a saved planning query (e.g. best_residential, hospital, flood) and rank cells.',
            example: '[ACTION] query id:best_residential',
        },
        // ---- agent analysis tools (gather evidence, feed results back) ----
        {
            name: 'rankCells', type: 'rankcells', kind: 'state', agentOnly: true,
            args: { brief: { type: 'string', required: true } },
            desc: 'Rank DIGIPIN cells in the current map view for a plain-English brief; returns the top matches with their codes.',
            example: '[ACTION] rankCells brief:"health-centre gap: high population, low healthcare access"',
        },
        {
            name: 'getCellData', type: 'getcelldata', kind: 'read', agentOnly: true,
            args: { code: { type: 'digipin', required: true } },
            desc: 'Read the intelligence scores for one DIGIPIN cell.',
            example: '[ACTION] getCellData code:39J-49L-L8T4',
        },
        {
            name: 'compareCells', type: 'comparecells', kind: 'read', agentOnly: true,
            args: { codes: { type: 'digipinList', required: true } },
            desc: 'Compare 2-3 DIGIPIN cells across their metrics (comma-separated codes).',
            example: '[ACTION] compareCells codes:"39J-49L-L8T4, 39J-49L-M2R5"',
        },
        {
            name: 'generateSiteBrief', type: 'generatesitebrief', kind: 'read', agentOnly: true,
            args: { code: { type: 'digipin', required: true } },
            desc: 'Produce a plain-language site brief (strengths, constraints) for a cell.',
            example: '[ACTION] generateSiteBrief code:39J-49L-L8T4',
        },
        {
            name: 'runIsochrone', type: 'runisochrone', kind: 'state', agentOnly: true,
            args: { code: { type: 'digipin' }, lat: { type: 'number' }, lng: { type: 'number' } },
            desc: 'Show 5/10/15-minute walking zones around a cell or point.',
            example: '[ACTION] runIsochrone code:39J-49L-L8T4',
        },
        {
            name: 'finish', type: 'finish', kind: 'read', agentOnly: true,
            args: {},
            desc: 'Call when you have enough evidence to give the final answer.',
            example: '[ACTION] finish',
        },
    ];

    /** Look up a tool by its emitted name or its lowercase dispatch type. */
    function getTool(nameOrType) {
        const k = String(nameOrType || '').toLowerCase();
        return TOOLS.find(t => t.type === k || t.name.toLowerCase() === k) || null;
    }

    /** True for a DIGIPIN-shaped token (dashes ignored, alphabet-checked). */
    function _validDigipin(v) {
        const s = String(v || '').replace(/-/g, '').toUpperCase();
        return s.length >= 1 && s.length <= 12 && [...s].every(c => DIGIPIN_ALPHABET.has(c));
    }

    /**
     * Allowlist + coercion gate. Copies only declared args (unknown keys are
     * dropped), coerces types, and rejects malformed values — the same defence
     * Text2Map.validateWeights gives the ranking path. Returns {ok, args|error}.
     */
    function validateArgs(nameOrType, params) {
        const tool = getTool(nameOrType);
        if (!tool) return { ok: false, error: `unknown tool "${nameOrType}"` };
        const spec = tool.args || {};
        const out = {};
        for (const [key, def] of Object.entries(spec)) {
            let v = params ? params[key] : undefined;
            if (v === undefined || v === '') {
                if (def.required) return { ok: false, error: `${tool.name} requires "${key}"` };
                continue;
            }
            if (def.type === 'number') {
                const n = Number(v);
                if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number` };
                out[key] = n;
            } else if (def.type === 'enum') {
                const s = String(v).toLowerCase();
                if (!def.values.includes(s)) return { ok: false, error: `${key} must be one of: ${def.values.join(', ')}` };
                out[key] = s;
            } else if (def.type === 'digipin') {
                if (!_validDigipin(v)) return { ok: false, error: `invalid DIGIPIN code "${v}"` };
                out[key] = String(v).trim();
            } else if (def.type === 'digipinList') {
                const codes = String(v).split(/[,\s]+/).filter(Boolean);
                if (!codes.length) return { ok: false, error: `${key} needs at least one code` };
                for (const c of codes) {
                    if (!_validDigipin(c)) return { ok: false, error: `invalid DIGIPIN code "${c}"` };
                }
                out[key] = codes.join(',');
            } else {
                out[key] = String(v);
            }
        }
        return { ok: true, args: out };
    }

    /** The `[ACTION]` instruction block, derived from TOOLS. Pure. */
    function renderSystemPrompt(opts = {}) {
        const agent = !!opts.agent;
        const tools = TOOLS.filter(t => agent || !t.agentOnly);
        const lines = [];
        lines.push(agent
            ? 'TOOLS — emit directives (one per line) to gather evidence or drive the map. Each result returns to you as an [OBSERVATION] block; keep going until you can answer:'
            : 'MAP ACTIONS — in addition to your normal answer, you MAY emit up to 3 machine-readable directives (each on its own line) that the app executes live. Only use them when clearly helpful:');
        for (const t of tools) lines.push(`  ${t.example}   — ${t.desc}`);
        lines.push('Keep each directive on its own line; the rest of your reply should read normally without them.');
        return lines.join('\n');
    }

    /** OpenAI `tools` array for the optional native function-calling path (Phase 2). Pure. */
    function toOpenAI(opts = {}) {
        const agent = !!opts.agent;
        return TOOLS.filter(t => (agent || !t.agentOnly) && t.type !== 'finish').map(t => {
            const properties = {};
            const required = [];
            for (const [k, d] of Object.entries(t.args || {})) {
                properties[k] = { type: d.type === 'number' ? 'number' : 'string' };
                if (d.type === 'enum') properties[k].enum = d.values;
                if (d.required) required.push(k);
            }
            return { type: 'function', function: { name: t.name, description: t.desc, parameters: { type: 'object', properties, required } } };
        });
    }

    return { TOOLS, getTool, validateArgs, renderSystemPrompt, toOpenAI };
})();

if (typeof window !== 'undefined') window.DISHATools = DISHATools;
