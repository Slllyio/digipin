/**
 * DishaAgent — the agentic layer that turns DISHA from a chatbot into a GIS
 * operator. It exposes municipal "skills" that compose the Feature Store
 * (DigiPinIntel), the composite indices (IntelIndices) and real-time exposure
 * (CellExposure), and returns structured results plus [ACTION] directives the
 * map executes. DISHA invokes a skill via `[ACTION] agent skill:... param:...`.
 *
 * Skills (diversified municipal use cases):
 *   findCells     — rank covered cells in view by an index (planning/targeting)
 *   exposure      — rank cells by live-hazard exposure (disaster ops)
 *   serviceGaps   — most underserved cells (equity / works prioritisation)
 *   assessCell    — full intelligence brief for one cell (any department)
 *   compareCells  — compare cells across all indices (site selection)
 *   scenario      — what-if: change a field, see the index impact (simulation)
 *
 * Pure planner core (intent, applyScenario, rankByIndex, param parsers) is
 * unit-tested; skill executors are async (read viewport cells + live alerts) and
 * degrade gracefully when data/deps are absent.
 */
const DishaAgent = (() => {
    // natural-language → index id (first match wins; order matters)
    const INDEX_LEXICON = [
        [/under[- ]?served|service\s*gap|lacking|deprived|amenit/i, 'serviceGap'],
        [/flood|inundat|waterlog|deluge/i, 'disasterRisk'],
        [/disaster|hazard|vulnerab|\brisk\b/i, 'disasterRisk'],
        [/invest|return|appreciat|growth potential|real[- ]?estate|revenue/i, 'investmentPotential'],
        [/livab|liveab|quality of life|best place to live/i, 'livability'],
        [/climate|resilien|heat|green cover/i, 'climateResilience'],
        [/econom|business|commerc|vital|jobs|market/i, 'economicVitality'],
        [/sustainab|low[- ]?carbon|walkab|car[- ]?free/i, 'sustainability'],
    ];
    const HAZARD_LEXICON = [
        [/flood|rain|inundat|waterlog/i, 'flood'], [/heat|heatwave|temperature/i, 'heat'],
        [/air|aqi|pollut|smog/i, 'air'], [/quake|earthquake|seismic/i, 'quake'],
        [/cyclone|storm|wind|thunder/i, 'storm'],
    ];
    const CODE_RE = /[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{4}/g;

    function _codes(text) { return String(text || '').toUpperCase().match(CODE_RE) || []; }
    function _topN(text) {
        const m = String(text || '').match(/\b(?:top|first|highest|worst)\s+(\d{1,3})\b/i)
            // a count followed (within a few words) by a place noun: "15 most underserved areas"
            || String(text || '').match(/\b(\d{1,3})\s+(?:\w+\s+){0,3}(?:cells|areas|wards|places|sites|zones|locations|pockets)\b/i);
        return m ? Math.max(1, Math.min(100, +m[1])) : 10;
    }
    function _idx(text) {
        for (const [re, id] of INDEX_LEXICON) if (re.test(text)) return id;
        return 'livability';
    }
    function _hazard(text) {
        for (const [re, h] of HAZARD_LEXICON) if (re.test(text)) return h;
        return 'generic';
    }

    /** Map a natural-language municipal question to {skill, params}. Pure. */
    function intent(text) {
        const t = String(text || '');
        if (/\bcompare\b|\bversus\b|\bvs\b/i.test(t)) return { skill: 'compareCells', params: { codes: _codes(t) } };
        if (/\bwhat if\b|\bscenario\b|\bif we\b|\bsuppose\b|\bsimulate\b/i.test(t)) {
            const code = _codes(t)[0] || null;
            const m = t.match(/([+-]?\d{1,3})\s*(?:%|pts|points)?\s*(?:more\s+|less\s+|of\s+)?([a-z_ ]+?)(?:\b|$)/i);
            let field = null, delta = null;
            if (m) {
                delta = +m[1];
                const word = m[2].trim().toLowerCase();
                field = _fieldFromWord(word);
                if (/\bless\b|reduce|cut|remove/i.test(t) && delta > 0) delta = -delta;
            }
            return { skill: 'scenario', params: { code, field, delta } };
        }
        if (/\bexposure\b|\baffected\b|\bat risk (?:now|today)\b|\balert|\bemergenc|\bevacuat|\brespond/i.test(t)) {
            return { skill: 'exposure', params: { hazard: _hazard(t), top: _topN(t) } };
        }
        if (/under[- ]?served|service\s*gap|lacking services|equity/i.test(t)) {
            return { skill: 'serviceGaps', params: { top: _topN(t) } };
        }
        const codes = _codes(t);
        if (codes.length && /\b(brief|assess|about|tell me|profile|summary|details?)\b/i.test(t)) {
            return { skill: 'assessCell', params: { code: codes[0] } };
        }
        return { skill: 'findCells', params: { index: _idx(t), top: _topN(t) } };
    }

    function _fieldFromWord(word) {
        if (typeof DigiPinIntel === 'undefined') return null;
        const fields = DigiPinIntel.FIELDS || [];
        const w = word.replace(/\s+/g, '_');
        const exact = fields.find(f => f.id === w || f.id.startsWith(w));
        if (exact) return exact.id;
        const byLabel = fields.find(f => f.label.toLowerCase().includes(word) || word.includes(f.label.toLowerCase().split(' ')[0]));
        return byLabel ? byLabel.id : null;
    }

    /** What-if: apply field deltas, recompute all indices, return before/after + deltas. Pure. */
    function applyScenario(features, changes) {
        const before = { ...(features || {}) };
        const after = { ...before };
        for (const [field, delta] of Object.entries(changes || {})) {
            if (after[field] == null || delta == null || !Number.isFinite(+delta)) continue;
            after[field] = Math.max(0, Math.min(100, +after[field] + (+delta)));
        }
        const II = (typeof IntelIndices !== 'undefined') ? IntelIndices : null;
        const indicesBefore = II ? II.all(before) : {};
        const indicesAfter = II ? II.all(after) : {};
        const deltas = {};
        for (const id of Object.keys(indicesAfter)) {
            const b = indicesBefore[id] && indicesBefore[id].value;
            const a = indicesAfter[id] && indicesAfter[id].value;
            if (b != null && a != null) deltas[id] = a - b;
        }
        return { before, after, indicesBefore, indicesAfter, deltas };
    }

    /** Rank cell records by an index value (descending = most notable end). Pure. */
    function rankByIndex(cells, indexId) {
        if (typeof IntelIndices === 'undefined') return [];
        return (cells || [])
            .map(c => {
                const r = IntelIndices.compute(c.features || c, indexId);
                return { ...c, indexValue: r ? r.value : null, band: r ? r.band : null };
            })
            .filter(c => c.indexValue != null)
            .sort((a, b) => b.indexValue - a.indexValue);
    }

    function skills() {
        return [
            { id: 'findCells',    params: 'index, top',   desc: 'Rank covered cells in view by an index' },
            { id: 'exposure',     params: 'hazard, top',  desc: 'Rank cells by live-hazard exposure' },
            { id: 'serviceGaps',  params: 'top',          desc: 'Most underserved cells (equity)' },
            { id: 'assessCell',   params: 'code',         desc: 'Full intelligence brief for a cell' },
            { id: 'compareCells', params: 'codes',        desc: 'Compare cells across indices' },
            { id: 'scenario',     params: 'code, field, delta', desc: 'What-if a field change and see index impact' },
        ];
    }
    function indexIds() { return (typeof IntelIndices !== 'undefined') ? IntelIndices.IDS : []; }

    // ── async execution context helpers ──
    function _bounds(ctx) {
        if (ctx && ctx.bounds) return ctx.bounds;
        try {
            const m = (typeof window !== 'undefined' && window.MapModule && window.MapModule.getMap && window.MapModule.getMap());
            if (m && m.getBounds) {
                const b = m.getBounds();
                return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
            }
        } catch { /* ignore */ }
        if (typeof PrecomputedScores !== 'undefined' && PrecomputedScores.getRegions) {
            const r = (PrecomputedScores.getRegions() || [])[0];
            if (r && r.bbox) return { south: r.bbox.south, west: r.bbox.west, north: r.bbox.north, east: r.bbox.east };
        }
        return null;
    }
    async function _cells(ctx) {
        if (ctx && Array.isArray(ctx.cells)) return ctx.cells;
        const b = _bounds(ctx);
        if (!b || typeof DigiPinIntel === 'undefined') return [];
        return DigiPinIntel.viewport(b);
    }
    function _code(c) { return (c.digipin && c.digipin.code) || c.code; }
    function _slim(c) { return { code: _code(c), value: c.indexValue, band: c.band, center: c.geometry && c.geometry.center }; }

    const EXEC = {
        async findCells(p, ctx) {
            const index = p.index || 'livability';
            const cells = await _cells(ctx);
            const ranked = rankByIndex(cells, index).slice(0, +p.top || 10);
            const def = (typeof IntelIndices !== 'undefined') && IntelIndices.DEFS[index];
            const actions = ranked[0] ? [`[ACTION] selectCell code:${_code(ranked[0])}`] : [];
            const summary = ranked.length
                ? `Top ${ranked.length} cells by ${def ? def.label : index} (${def && def.highMeans === 'risk' ? 'most at risk' : 'best'}). #1 ${_code(ranked[0])} = ${ranked[0].indexValue}.`
                : 'No covered cells in the current view.';
            return { summary, data: { index, cells: ranked.map(_slim) }, actions };
        },
        async serviceGaps(p, ctx) { return EXEC.findCells({ index: 'serviceGap', top: p.top }, ctx); },
        async exposure(p, ctx) {
            if (typeof CellExposure === 'undefined') return { summary: 'Exposure layer unavailable.', data: null, actions: [] };
            const cells = await _cells(ctx);
            const hazard = CellExposure.hazardProfile({ category: p.hazard || '', severity: p.severity });
            const all = CellExposure.rank(cells, hazard);
            const ranked = all.slice(0, +p.top || 15);
            const sum = CellExposure.summary(all);
            const actions = ranked[0] ? [`[ACTION] selectCell code:${_code(ranked[0])}`] : [];
            return {
                summary: `Exposure to ${hazard.kind}: ${sum.byPriority.Critical} critical, ${sum.byPriority.High} high-priority cells of ${sum.cells}.`,
                data: { hazard, summary: sum, ranked: ranked.map(c => ({ code: _code(c), exposure: c.exposure, priority: c.priority })) },
                actions,
            };
        },
        async assessCell(p) {
            if (typeof DigiPinIntel === 'undefined' || !p.code) return { summary: 'Need a cell code.', data: null, actions: [] };
            const rec = await DigiPinIntel.cellByCode(p.code);
            if (!rec) return { summary: 'Cell not found.', data: null, actions: [] };
            const indices = (typeof IntelIndices !== 'undefined') ? IntelIndices.all(rec.features) : {};
            return { summary: `Intelligence brief for ${rec.digipin.code}.`, data: { record: rec, indices }, actions: [`[ACTION] selectCell code:${rec.digipin.code}`] };
        },
        async compareCells(p) {
            let codes = p.codes || (p.code ? [p.code] : []);
            if (typeof codes === 'string') codes = codes.split(/[\s,]+/).filter(Boolean);
            const rows = [];
            for (const c of codes) {
                const rec = (typeof DigiPinIntel !== 'undefined') && await DigiPinIntel.cellByCode(c);
                if (rec) rows.push({ code: rec.digipin.code, indices: (typeof IntelIndices !== 'undefined') ? IntelIndices.all(rec.features) : {} });
            }
            const actions = rows[0] ? [`[ACTION] selectCell code:${rows[0].code}`] : [];
            return { summary: `Compared ${rows.length} cell(s).`, data: { rows }, actions };
        },
        async scenario(p) {
            if (typeof DigiPinIntel === 'undefined' || !p.code) return { summary: 'Need a cell code for the scenario.', data: null, actions: [] };
            const rec = await DigiPinIntel.cellByCode(p.code);
            if (!rec) return { summary: 'Cell not found for scenario.', data: null, actions: [] };
            const changes = p.changes || (p.field ? { [p.field]: +p.delta } : {});
            const sim = applyScenario(rec.features, changes);
            const movers = Object.entries(sim.deltas).filter(([, d]) => Math.abs(d) >= 1)
                .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
            const lbl = id => (typeof IntelIndices !== 'undefined' && IntelIndices.DEFS[id]) ? IntelIndices.DEFS[id].label : id;
            const summary = `Scenario on ${rec.digipin.code}: ` +
                (movers.length ? movers.map(([id, d]) => `${lbl(id)} ${d > 0 ? '+' : ''}${d}`).join(', ') : 'no material index change') + '.';
            return { summary, data: { code: rec.digipin.code, changes, ...sim }, actions: [`[ACTION] selectCell code:${rec.digipin.code}`] };
        },
    };

    /** Run a skill by id with params + context {bounds?, cells?, city?}. Async. */
    async function run(skill, params, ctx) {
        const fn = EXEC[skill];
        if (!fn) return { summary: `Unknown skill "${skill}".`, data: null, actions: [] };
        try { return await fn(params || {}, ctx || {}); }
        catch (e) { return { summary: `Skill "${skill}" failed: ${e && e.message ? e.message : 'error'}`, data: null, actions: [] }; }
    }

    /** Plan from natural language, then run. Convenience. Async. */
    async function ask(text, ctx) {
        const plan = intent(text);
        const result = await run(plan.skill, plan.params, ctx);
        return { plan, ...result };
    }

    return { intent, applyScenario, rankByIndex, skills, indexIds, run, ask,
             _codes, _topN, _idx, _hazard };
})();

if (typeof window !== 'undefined') window.DishaAgent = DishaAgent;
