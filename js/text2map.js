/**
 * Text2Map — natural-language → ranked DIGIPIN cells (the "Text2Map" interaction).
 *
 * Ask a question in plain English ("family-friendly area near good schools, low
 * flood risk"); an LLM converts it into a weighting over the app's real score
 * vocabulary; we rank every DIGIPIN cell in the current viewport from the
 * precomputed grid in one shard read and return the top matches.
 *
 * Design (per plan M1):
 *   - PARSE is LLM-required (primary). The model is constrained to the exact
 *     score-id list from DataFetcher.computeScores({}) and must return strict
 *     JSON {weights, primaryScore, label}. validateWeights() drops any
 *     hallucinated id and clamps magnitudes, so a confused model can never
 *     poison the ranking.
 *   - KEYWORD match (DISHA.matchQueryId → a canned SECTORS query) is only a
 *     graceful fallback for the no-provider / LLM-error path — never primary.
 *   - RANK reuses QueryEngine.computeQueryScore over PrecomputedScores
 *     .lookupViewport (instant, true cell rectangles, city-wide). Off-grid it
 *     falls back to the existing live DISHA.cityScan sampling.
 *
 * Provider-agnostic: the stream() call passes BOTH `prompt` (Ollama) and
 * `messages` (OpenAI-compatible) so either provider type parses identically.
 */
const Text2Map = (() => {
    const TOP_N = 8;        // how many ranked cells to surface

    /** The allow-list of weightable score ids — the live model is the single
     *  source of truth, so the LLM can only ever choose real scores. */
    function validScoreIds() {
        if (typeof DataFetcher === 'undefined' || !DataFetcher.computeScores) return [];
        return Object.keys(DataFetcher.computeScores({}));
    }

    /** JSON-only instruction, with the legal id list injected inline. */
    function buildSystemPrompt(ids) {
        return [
            'You convert an Indian urban location question into a numeric weighting',
            'over a fixed set of location-quality scores. Higher weight = more desirable;',
            'negative weight = the question wants LESS of that score.',
            '',
            'You MUST only use these exact score ids:',
            ids.join(', '),
            '',
            'Return ONLY a single JSON object, no prose, no code fences, of the form:',
            '{"weights": {"<id>": <number -1..1>, ...}, "primaryScore": "<id>", "label": "<short title>"}',
            'Use 2-6 weights. primaryScore is the single most important id.',
        ].join('\n');
    }

    /** Pull the first balanced {...} block out of a model reply and parse it.
     *  Tolerates markdown fences and surrounding prose. Returns null on failure. */
    function parseModelJSON(raw) {
        if (typeof raw !== 'string') return null;
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try {
            return JSON.parse(raw.slice(start, end + 1));
        } catch {
            return null;
        }
    }

    /**
     * Anti-hallucination gate. Keeps only weights whose id is in `allow`, drops
     * non-finite/zero values, clamps magnitude to [-1,1]. Returns a clean
     * {weights, primaryScore, label} or null if nothing survives.
     */
    function validateWeights(obj, allow) {
        if (!obj || typeof obj !== 'object') return null;
        const allowSet = new Set(allow && allow.length ? allow : validScoreIds());
        const src = obj.weights && typeof obj.weights === 'object' ? obj.weights : {};

        const weights = {};
        for (const [id, raw] of Object.entries(src)) {
            if (!allowSet.has(id)) continue;            // hallucinated id → drop
            const v = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(v) || v === 0) continue;
            weights[id] = Math.max(-1, Math.min(1, v)); // clamp magnitude
        }

        const keys = Object.keys(weights);
        if (keys.length === 0) return null;             // require ≥1 real weight

        // primaryScore must be a surviving id; else the largest-magnitude weight.
        let primaryScore = typeof obj.primaryScore === 'string' && weights[obj.primaryScore] != null
            ? obj.primaryScore
            : keys.reduce((a, b) => (Math.abs(weights[b]) > Math.abs(weights[a]) ? b : a));

        const label = typeof obj.label === 'string' && obj.label.trim()
            ? obj.label.trim().slice(0, 60)
            : 'Custom ranking';

        return { weights, primaryScore, label, source: 'llm' };
    }

    /** Primary parser: ask the connected provider for a strict-JSON weighting. */
    async function parseWithLLM(question) {
        if (typeof DISHAProviders === 'undefined') return null;
        const ids = validScoreIds();
        if (!ids.length) return null;

        const system = buildSystemPrompt(ids);
        const prompt = `Question: ${question}\nReturn ONLY the JSON object.`;

        let raw = '';
        try {
            // stream() resolves to the full response; onToken is required by the
            // Ollama path, so accumulate there too as a belt-and-braces fallback.
            const full = await DISHAProviders.stream({
                system,
                prompt,
                messages: [{ role: 'user', content: prompt }],
                onToken: (t) => { raw += t; },
            });
            if (typeof full === 'string' && full.length >= raw.length) raw = full;
        } catch {
            return null;
        }

        return validateWeights(parseModelJSON(raw), ids);
    }

    /** Fallback parser: map the question to a canned SECTORS query's weights. */
    function parseWithKeywords(question) {
        if (typeof DISHA === 'undefined' || typeof QueryEngine === 'undefined') return null;
        const id = DISHA.matchQueryId(question);
        const def = QueryEngine.getSectors()
            .flatMap(s => s.queries)
            .find(q => q.id === id);
        if (!def || !def.weights) return null;

        const keys = Object.keys(def.weights);
        const primaryScore = keys.reduce(
            (a, b) => (Math.abs(def.weights[b]) > Math.abs(def.weights[a]) ? b : a), keys[0]);
        return { weights: def.weights, primaryScore, label: def.name, source: 'keyword' };
    }

    /**
     * Parse a question into a weighting. LLM-required primary path (gated on a
     * connected provider); keyword match is the graceful-degradation fallback.
     */
    async function parse(question) {
        if (typeof DISHAProviders !== 'undefined' && DISHAProviders.isConnected()) {
            const llm = await parseWithLLM(question);
            if (llm) return llm;
        }
        return parseWithKeywords(question);
    }

    /** True when natural-language parsing is available (a provider is connected). */
    function canParseNaturally() {
        return typeof DISHAProviders !== 'undefined' && DISHAProviders.isConnected();
    }

    /**
     * Rank every covered DIGIPIN cell in `bounds` by `weights`, instantly, from
     * the precomputed grid. Returns ranked rows ({lat,lng,code,score,area,scores})
     * or null when the viewport isn't covered (caller should fall back to live).
     */
    async function rankPrecomputed(weights, bounds) {
        if (typeof PrecomputedScores === 'undefined' || !PrecomputedScores.isEnabled()) return null;
        const cells = await PrecomputedScores.lookupViewport(bounds);
        if (!cells || !cells.length) return null;
        return cells
            .map(c => ({
                lat: c.center.lat, lng: c.center.lng, code: c.code,
                score: QueryEngine.computeQueryScore(c.scores, weights),
                area: '', scores: c.scores,
            }))
            .sort((a, b) => b.score - a.score);
    }

    /**
     * End-to-end Text2Map: question → parsed weighting → ranked cells.
     * Returns { parsed, results, mode } where mode is 'precomputed' | 'live' and
     * parsed is the {weights, primaryScore, label, source} used. Null if the
     * question could not be parsed at all (no provider AND no keyword match).
     */
    async function run(question, bounds, onStatus) {
        const parsed = await parse(question);
        if (!parsed) return null;

        const ranked = await rankPrecomputed(parsed.weights, bounds);
        if (ranked) {
            return { parsed, results: ranked.slice(0, TOP_N), mode: 'precomputed' };
        }

        // Off-grid: keep the city working via the existing live sampler.
        if (typeof DISHA !== 'undefined' && DISHA.cityScan) {
            const live = await DISHA.cityScan(question, onStatus);
            return { parsed, results: live || [], mode: 'live' };
        }
        return { parsed, results: [], mode: 'live' };
    }

    return {
        run,
        parse,
        parseWithLLM,
        parseWithKeywords,
        parseModelJSON,
        validateWeights,
        validScoreIds,
        canParseNaturally,
        rankPrecomputed,
        buildSystemPrompt,
        TOP_N,
    };
})();

if (typeof window !== 'undefined') {
    window.Text2Map = Text2Map;
}
