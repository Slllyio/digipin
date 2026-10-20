/**
 * Text2MapEmbeddings — optional neural-semantic tier for Text2Map.
 *
 * Lazily loads a quantized MiniLM sentence-embedding model (transformers.js,
 * from a CDN) the first time a natural-language question is parsed, embeds the
 * score catalogue once, then cosine-ranks the question against it to produce a
 * weighting. This catches long-tail paraphrases the curated lexicon doesn't.
 *
 * Designed to NEVER block or break the app:
 *   - Loading happens in the background — until the model is ready, rank()
 *     returns null and Text2Map falls back to the (instant) lexicon. So the
 *     ~25 MB first-query download never stalls a result.
 *   - Any failure (offline, CSP, firewalled CDN/model) sets a hard `_failed`
 *     flag and we fall back to the lexicon for good — no retry storm.
 *
 * Precedence in text2map.js: LLM → embeddings (when warm) → lexicon → keyword.
 * Requires `'wasm-unsafe-eval'` + the CDN in the app CSP (ONNX runs on WASM).
 */
const Text2MapEmbeddings = (() => {
    const MODEL = 'Xenova/all-MiniLM-L6-v2';
    const CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
    const TOP_K = 5;        // most-similar scores kept as weights
    const MIN_SIM = 0.2;    // ignore weak matches (cosine on normalized MiniLM)

    // Short glosses enrich the text we embed per score id so the model has more
    // than a terse label to work with. Ids absent here fall back to label+id.
    const GLOSS = {
        livability: 'quality of life, comfortable, pleasant place to live',
        safety: 'safe, low crime, secure neighbourhood',
        green: 'parks, trees, greenery, nature, open space',
        connectivity: 'public transport, metro, bus, well connected, commute',
        commercial: 'shops, markets, retail, business activity',
        healthcare_access: 'hospitals, clinics, pharmacies, medical care',
        walkability: 'walkable, pedestrian friendly, on foot',
        food_diversity: 'restaurants, cafes, dining, cuisine variety',
        noise_estimate: 'quiet, peaceful, calm, low noise',
        population_proxy: 'dense, crowded, busy, population',
        flood_risk: 'flooding, waterlogging, drainage, inundation risk',
        education_score: 'schools, colleges, universities, education',
        entertainment_score: 'nightlife, fun, entertainment, lively, vibrant',
        digital_readiness: 'IT hubs, coworking, tech, startups, digital',
        investment: 'real estate investment, property returns, appreciation',
        real_estate_growth: 'rising property prices, development, growth',
        development_potential: 'upcoming area, new construction, potential',
        tourism: 'tourist attractions, heritage, sightseeing',
        material_quality: 'premium, luxury, high quality buildings',
        urban_compactness: 'central, compact, dense urban core',
    };

    let _extractor = null;  // the feature-extraction pipeline once loaded
    let _loading = null;    // in-flight load promise (dedupe)
    let _catalog = null;    // [{ id, vec }]
    let _failed = false;    // hard failure → stop trying, lexicon takes over

    /** The text embedded for a score: gloss if available, else label + spaced id. */
    function catalogText(id, label) {
        const base = `${label || ''} ${String(id).replace(/_/g, ' ')}`.trim();
        return GLOSS[id] ? `${base}. ${GLOSS[id]}` : base;
    }

    /** Cosine similarity of two equal-length numeric vectors. */
    function cosine(a, b) {
        let dot = 0, na = 0, nb = 0;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        return denom === 0 ? 0 : dot / denom;
    }

    /** [{id,sim}] → {weights, primaryScore}: top-K above MIN_SIM, scaled to [0,1]. */
    function weightsFromSims(sims) {
        const pos = sims.filter(s => s.sim >= MIN_SIM).sort((a, b) => b.sim - a.sim).slice(0, TOP_K);
        if (!pos.length) return null;
        const max = pos[0].sim || 1;
        const weights = {};
        for (const s of pos) weights[s.id] = Math.round((s.sim / max) * 100) / 100;
        return { weights, primaryScore: pos[0].id };
    }

    async function _embed(text) {
        const out = await _extractor(text, { pooling: 'mean', normalize: true });
        return Array.from(out.data);
    }

    async function _load(validIds, labelFor) {
        const mod = await import(CDN);
        if (mod.env) mod.env.allowLocalModels = false;   // fetch weights from the hub
        _extractor = await mod.pipeline('feature-extraction', MODEL, { quantized: true });
        const cat = [];
        for (const id of validIds) {
            cat.push({ id, vec: await _embed(catalogText(id, labelFor ? labelFor(id) : id)) });
        }
        _catalog = cat;
    }

    /**
     * Rank `question` into a weighting via embeddings. Returns null (→ lexicon)
     * when the model isn't loaded yet (warming up in the background) or any
     * failure occurs. Resolves quickly once warm.
     */
    async function rank(question, validIds, labelFor) {
        if (_failed || typeof question !== 'string' || !question.trim()) return null;
        if (typeof Array.isArray !== 'function' || !Array.isArray(validIds) || !validIds.length) return null;

        if (!_extractor) {
            // Kick off a one-time background load; this query uses the lexicon.
            if (!_loading) {
                _loading = _load(validIds, labelFor).catch((e) => {
                    _failed = true; _loading = null;
                    if (typeof console !== 'undefined') {
                        console.warn('[Text2Map] embeddings unavailable; using lexicon:', e && e.message);
                    }
                });
            }
            return null;
        }

        try {
            const qvec = await _embed(question);
            const sims = _catalog.map(c => ({ id: c.id, sim: cosine(qvec, c.vec) }));
            const w = weightsFromSims(sims);
            if (!w) return null;
            return { weights: w.weights, primaryScore: w.primaryScore, label: 'Semantic match', source: 'embeddings' };
        } catch (e) {
            _failed = true;
            if (typeof console !== 'undefined') console.warn('[Text2Map] embedding rank failed:', e && e.message);
            return null;
        }
    }

    return {
        rank, cosine, weightsFromSims, catalogText, GLOSS,
        _state: () => ({ failed: _failed, loaded: !!_extractor }),
    };
})();

if (typeof window !== 'undefined') window.Text2MapEmbeddings = Text2MapEmbeddings;
