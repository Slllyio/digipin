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
 * `confirm` marks the slow or heavy ones (a few seconds of compute, a repainted
 * 3D city): the agent asks the user before running them (GeoAgent's pattern),
 * see needsConfirm / describeCall.
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
            name: 'trafficHour', type: 'traffichour', kind: 'state', agentOnly: false,
            args: { hour: { type: 'string', required: true }, buildings: { type: 'enum', values: ['on', 'off'] } },
            desc: 'Show modelled road traffic at an hour of day (0–23), "peak" for the worse of the two peaks, or "play" to animate the day. buildings:on also colours the 3D buildings by the clock.',
            example: '[ACTION] trafficHour hour:18',
        },
        {
            name: 'query', type: 'query', kind: 'state', agentOnly: false,
            args: { id: { type: 'string', required: true } },
            desc: 'Run a saved planning query (e.g. best_residential, hospital, flood) and rank cells.',
            example: '[ACTION] query id:best_residential',
        },
        {
            name: 'colorBuildings', type: 'colorbuildings', kind: 'state', agentOnly: false, confirm: true,
            args: { color: { type: 'string' }, height: { type: 'string' } },
            desc: 'Colour (and optionally extrude) the 3D buildings by a dataset field, as "<dataset>:<field>" '
                + '(e.g. scores:flood_risk, scores:walkability, traffic:congestion_risk, mobility:mobility_risk, '
                + 'bldg:height_m). color:none resets.',
            example: '[ACTION] colorBuildings color:scores:flood_risk height:bldg:height_m',
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
            name: 'areaInsights', type: 'areainsights', kind: 'read', agentOnly: true,
            args: { code: { type: 'digipin', required: true } },
            desc: 'What stands out in a DIGIPIN area (4-6 characters) vs its city: ranked strengths, concerns, trends, anomalies and hotspots, each with its source dataset.',
            example: '[ACTION] areaInsights code:34M-P6',
        },
        {
            name: 'whatIf', type: 'whatif', kind: 'read', agentOnly: true,
            args: {
                scenario: { type: 'enum', values: ['park', 'density', 'flood', 'cool', 'closure'], required: true },
                code: { type: 'digipin' }, factor: { type: 'number' }, trees: { type: 'number' },
                level: { type: 'enum', values: ['moderate', 'severe', 'extreme'] },
            },
            desc: 'Simulate a new park, more density (factor), more tree cover for heat (cool, trees = points added) or a road closure at a cell (code), or a flood event (level) over the map view: affected cells, buildings, roads and services.',
            example: '[ACTION] whatIf scenario:park code:34M-P6L',
        },
        {
            name: 'roadWhatIf', type: 'roadwhatif', kind: 'state', agentOnly: true, confirm: true,
            args: {
                road: { type: 'string', required: true },
                action: { type: 'enum', values: ['close', 'widen'] },
                period: { type: 'enum', values: ['am', 'pm'] },
            },
            desc: 'Close or widen a named arterial road in the selected city and re-route the modelled commute (am = 09:00, pm = 18:00): roads that get busier/quieter, residents beside worse roads, trips cut off.',
            example: '[ACTION] roadWhatIf road:MG Road action:close period:pm',
        },
        {
            name: 'compareCities', type: 'comparecities', kind: 'read', agentOnly: true,
            args: { a: { type: 'string', required: true }, b: { type: 'string', required: true } },
            desc: 'Compare two cities (e.g. indore, pune) or DIGIPIN areas indicator by indicator from the cell store.',
            example: '[ACTION] compareCities a:indore b:pune',
        },
        {
            name: 'runAgent', type: 'runagent', kind: 'state', agentOnly: true, confirm: true,
            args: {
                agent: { type: 'enum', values: ['brief', 'site', 'flood', 'heat', 'access', 'growth', 'construction', 'changes', 'air', 'green', 'solar', 'risk', 'programme', 'compare', 'health'], required: true },
                use: { type: 'enum', values: ['housing', 'clinic', 'school', 'retail', 'park'] },
                preset: { type: 'enum', values: ['cool_roofs', 'ev_charging'] },
                vs: { type: 'string' },
            },
            desc: 'Run a saved analysis agent on the selected neighbourhood (or the map view) and paint its result layer: '
                + 'brief, site (with use:housing|clinic|school|retail|park), flood, heat, access (15-minute), growth, construction (new building alerts), changes, '
                + 'air (PM2.5 exposure), green (3-30-300), solar (rooftop potential), risk (compound hazards), programme (with preset:cool_roofs|ev_charging), compare (with vs:own or a city id such as pune), '
                + 'health (live data feeds; no area needed). '
                + 'Returns the report summary and top findings.',
            example: '[ACTION] runAgent agent:site use:clinic',
        },
        {
            name: 'runIsochrone', type: 'runisochrone', kind: 'state', agentOnly: true, confirm: true,
            args: { code: { type: 'digipin' }, lat: { type: 'number' }, lng: { type: 'number' } },
            desc: 'Show 5/10/15-minute walking zones around a cell or point.',
            example: '[ACTION] runIsochrone code:39J-49L-L8T4',
        },
        {
            name: 'liveNow', type: 'livenow', kind: 'read', agentOnly: true,
            args: { code: { type: 'digipin' } },
            desc: 'Live conditions at a cell or the map centre: weather and heavy-rain forecast, air quality (National AQI), river flow, nearby earthquakes and natural events, GPS accuracy, and live correlations with the people, flood and heat cells in view.',
            example: '[ACTION] liveNow code:39J-49L-L8T4',
        },
        {
            name: 'satellitePasses', type: 'satellitepasses', kind: 'read', agentOnly: true,
            args: { code: { type: 'digipin' }, kind: { type: 'enum', values: ['all', 'optical', 'radar'] } },
            desc: 'When Earth-observation satellites (Sentinel-2, Landsat, Sentinel-1 radar, Resourcesat, Cartosat-3, Sentinel-3/5P) next pass over a cell or the map centre in the next 7 days, with the cloud forecast for each pass.',
            example: '[ACTION] satellitePasses code:39J-49L-L8T4 kind:optical',
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

    /** True when the agent must ask the user before running this tool. */
    function needsConfirm(nameOrType) {
        const t = getTool(nameOrType);
        return !!(t && t.confirm);
    }

    /** One plain sentence for the confirmation prompt: what the step will do. Pure. */
    function describeCall(nameOrType, params = {}) {
        const t = getTool(nameOrType);
        if (!t) return `Run ${nameOrType}`;
        const p = params || {};
        const where = p.code ? ` around ${p.code}` : '';
        switch (t.type) {
        case 'runagent': {
            const extra = p.use || p.preset || (p.vs ? `vs ${p.vs}` : '');
            return `Run the ${p.agent || 'analysis'}${extra ? ` (${extra})` : ''} agent and paint its result layer`;
        }
        case 'runisochrone': return `Compute 5/10/15-minute walking zones${where}`;
        case 'roadwhatif': return `${p.action === 'widen' ? 'Widen' : 'Close'} ${p.road || 'the road'} and re-route the ${p.period === 'pm' ? '18:00' : '09:00'} commute (about 2–15 s)`;
        case 'colorbuildings': return `Recolour the 3D buildings by ${p.color || 'a dataset'}${p.height ? `, heights from ${p.height}` : ''}`;
        default: return t.desc.replace(/\.$/, '');
        }
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

    return { TOOLS, getTool, needsConfirm, describeCall, validateArgs, renderSystemPrompt, toOpenAI };
})();

if (typeof window !== 'undefined') window.DISHATools = DISHATools;
