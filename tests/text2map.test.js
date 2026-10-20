import { describe, it, expect, afterEach, vi } from 'vitest';

// Text2Map, DataFetcher, QueryEngine, DISHA, DISHAProviders, PrecomputedScores
// are all exposed on globalThis by tests/setup.js.
const T = globalThis.Text2Map;

// Snapshot the swappable provider/grid methods so each test can stub freely.
const realStream = DISHAProviders.stream;
const realIsConnected = DISHAProviders.isConnected;
const realEnabled = PrecomputedScores.isEnabled;
const realLookup = PrecomputedScores.lookupViewport;

afterEach(() => {
    DISHAProviders.stream = realStream;
    DISHAProviders.isConnected = realIsConnected;
    PrecomputedScores.isEnabled = realEnabled;
    PrecomputedScores.lookupViewport = realLookup;
});

describe('Text2Map.validScoreIds()', () => {
    it('returns the live score vocabulary as the allow-list', () => {
        const ids = T.validScoreIds();
        expect(ids).toContain('livability');
        expect(ids).toContain('flood_risk');
        expect(ids).toContain('safety');
        // every id is a real key of the live model
        const real = Object.keys(DataFetcher.computeScores({}));
        expect(ids.sort()).toEqual(real.sort());
    });
});

describe('Text2Map.parseModelJSON()', () => {
    it('extracts JSON wrapped in prose and code fences', () => {
        const raw = 'Sure! Here you go:\n```json\n{"weights":{"safety":1},"label":"x"}\n```\nDone.';
        expect(T.parseModelJSON(raw)).toEqual({ weights: { safety: 1 }, label: 'x' });
    });
    it('returns null on non-JSON', () => {
        expect(T.parseModelJSON('no json here')).toBeNull();
        expect(T.parseModelJSON('{broken')).toBeNull();
        expect(T.parseModelJSON(null)).toBeNull();
    });
});

describe('Text2Map.validateWeights() — anti-hallucination', () => {
    const allow = ['safety', 'green', 'flood_risk'];

    it('drops ids not in the allow-list', () => {
        const out = T.validateWeights(
            { weights: { safety: 0.8, made_up_score: 0.9 }, primaryScore: 'safety' }, allow);
        expect(out.weights).toEqual({ safety: 0.8 });
        expect(out.weights.made_up_score).toBeUndefined();
    });

    it('clamps magnitudes to [-1,1] and drops zero / non-finite', () => {
        const out = T.validateWeights(
            { weights: { safety: 5, green: -9, flood_risk: 0 } }, allow);
        expect(out.weights.safety).toBe(1);
        expect(out.weights.green).toBe(-1);
        expect(out.weights.flood_risk).toBeUndefined(); // zero dropped
    });

    it('returns null when nothing survives', () => {
        expect(T.validateWeights({ weights: { bogus: 1 } }, allow)).toBeNull();
        expect(T.validateWeights({}, allow)).toBeNull();
        expect(T.validateWeights(null, allow)).toBeNull();
    });

    it('keeps a valid primaryScore, else picks the largest magnitude', () => {
        const keep = T.validateWeights(
            { weights: { safety: 0.3, green: 0.9 }, primaryScore: 'safety' }, allow);
        expect(keep.primaryScore).toBe('safety');

        const derive = T.validateWeights(
            { weights: { safety: 0.3, green: -0.9 }, primaryScore: 'not_real' }, allow);
        expect(derive.primaryScore).toBe('green'); // |−0.9| wins
    });
});

describe('Text2Map.parseWithLLM()', () => {
    it('streams JSON from the provider and validates it', async () => {
        DISHAProviders.stream = vi.fn(async ({ onToken }) => {
            const reply = '{"weights":{"safety":0.9,"green":0.5},"primaryScore":"safety","label":"Safe & green"}';
            if (onToken) onToken(reply);
            return reply;
        });
        const out = await T.parseWithLLM('somewhere safe and green');
        expect(out.source).toBe('llm');
        expect(out.weights.safety).toBe(0.9);
        expect(out.label).toBe('Safe & green');
        // provider-agnostic: both prompt and messages were supplied
        const call = DISHAProviders.stream.mock.calls[0][0];
        expect(call.prompt).toBeTruthy();
        expect(call.messages[0].content).toBeTruthy();
    });

    it('returns null on garbled output', async () => {
        DISHAProviders.stream = vi.fn(async () => 'I cannot help with that.');
        expect(await T.parseWithLLM('q')).toBeNull();
    });

    it('returns null when the provider throws', async () => {
        DISHAProviders.stream = vi.fn(async () => { throw new Error('offline'); });
        expect(await T.parseWithLLM('q')).toBeNull();
    });
});

describe('Text2Map.parseWithKeywords() — graceful fallback', () => {
    it('maps a family question to the canned family weights', () => {
        const out = T.parseWithKeywords('good family neighbourhood for kids');
        expect(out.source).toBe('keyword');
        expect(out.weights.education_score).toBeGreaterThan(0);
        expect(out.weights.safety).toBeGreaterThan(0);
    });
});

describe('Text2Map.parse() — LLM-required primary, keyword fallback', () => {
    it('uses the LLM when a provider is connected', async () => {
        DISHAProviders.isConnected = () => true;
        DISHAProviders.stream = vi.fn(async () =>
            '{"weights":{"green":1},"primaryScore":"green","label":"Green"}');
        const out = await T.parse('leafy area');
        expect(out.source).toBe('llm');
    });

    it('falls back to the lexicon when no provider is connected', async () => {
        DISHAProviders.isConnected = () => false;
        DISHAProviders.stream = vi.fn();
        const out = await T.parse('family area with schools');
        expect(out.source).toBe('lexicon');
        expect(DISHAProviders.stream).not.toHaveBeenCalled();
    });

    it('falls back to the lexicon when the LLM reply is unusable', async () => {
        DISHAProviders.isConnected = () => true;
        DISHAProviders.stream = vi.fn(async () => 'sorry');
        const out = await T.parse('family area with schools');
        expect(out.source).toBe('lexicon');
    });

    it('falls back to the canned keyword query when the lexicon matches nothing', async () => {
        DISHAProviders.isConnected = () => false;
        // No lexicon concept matches → single-match keyword default still answers.
        const out = await T.parse('zzz qqq');
        expect(out.source).toBe('keyword');
    });
});

describe('Text2Map.parseWithLexicon() — offline concept matching', () => {
    it('combines weights from every matched concept (compound intent)', () => {
        const out = T.parseWithLexicon('family-friendly area near good schools with low flood risk');
        expect(out.source).toBe('lexicon');
        expect(out.weights.education_score).toBeGreaterThan(0);   // schools + family
        expect(out.weights.flood_risk).toBeLessThan(0);          // "low flood risk" → avoid risk
        expect(out.label).toMatch(/Family|schools|Flood/i);
    });

    it('resolves paraphrases the old single-regex missed', () => {
        // "young professionals / nightlife" never matched the legacy regex.
        const out = T.parseWithLexicon('lively area for young professionals with good nightlife');
        expect(out).not.toBeNull();
        expect(out.weights.entertainment_score).toBeGreaterThan(0);
        expect(out.weights.commercial).toBeGreaterThan(0);
    });

    it('points quietness and flood weights in the correct direction', () => {
        const quiet = T.parseWithLexicon('a quiet peaceful neighbourhood');
        expect(quiet.weights.noise_estimate).toBeGreaterThan(0);  // higher = quieter
        const flood = T.parseWithLexicon('flood-safe location');
        expect(flood.weights.flood_risk).toBeLessThan(0);         // higher = riskier
    });

    it('only emits ids in the live score vocabulary, clamped to [-1,1]', () => {
        const allow = new Set(T.validScoreIds());
        const out = T.parseWithLexicon('investment property with great schools, parks, transit and food');
        for (const [id, w] of Object.entries(out.weights)) {
            expect(allow.has(id), `unknown score id ${id}`).toBe(true);
            expect(w).toBeGreaterThanOrEqual(-1);
            expect(w).toBeLessThanOrEqual(1);
        }
        expect(out.weights[out.primaryScore]).toBeDefined();
    });

    it('returns null on an empty or concept-free question', () => {
        expect(T.parseWithLexicon('')).toBeNull();
        expect(T.parseWithLexicon('zzz qqq')).toBeNull();
    });
});

describe('Text2Map.rankPrecomputed()', () => {
    const cells = [
        { code: 'A', center: { lat: 1, lng: 1 }, bounds: {}, scores: { safety: { label: 'Safety', value: 80 }, green: { label: 'Green', value: 20 } } },
        { code: 'B', center: { lat: 2, lng: 2 }, bounds: {}, scores: { safety: { label: 'Safety', value: 30 }, green: { label: 'Green', value: 90 } } },
    ];

    it('returns null when the grid is disabled', async () => {
        PrecomputedScores.isEnabled = () => false;
        expect(await T.rankPrecomputed({ safety: 1 }, {})).toBeNull();
    });

    it('ranks covered cells by the weighting, highest first', async () => {
        PrecomputedScores.isEnabled = () => true;
        PrecomputedScores.lookupViewport = async () => cells;
        const ranked = await T.rankPrecomputed({ safety: 1 }, {});
        expect(ranked[0].code).toBe('A');       // safety 80 > 30
        expect(ranked[1].code).toBe('B');
        // weighting flips the order
        const greenRanked = await T.rankPrecomputed({ green: 1 }, {});
        expect(greenRanked[0].code).toBe('B');
    });
});

describe('Text2Map.run() — end to end', () => {
    it('parses then ranks the precomputed grid', async () => {
        DISHAProviders.isConnected = () => true;
        DISHAProviders.stream = vi.fn(async () =>
            '{"weights":{"safety":1},"primaryScore":"safety","label":"Safe"}');
        PrecomputedScores.isEnabled = () => true;
        PrecomputedScores.lookupViewport = async () => [
            { code: 'A', center: { lat: 1, lng: 1 }, bounds: {}, scores: { safety: { value: 70 } } },
            { code: 'B', center: { lat: 2, lng: 2 }, bounds: {}, scores: { safety: { value: 40 } } },
        ];
        const out = await T.run('safe place', {});
        expect(out.mode).toBe('precomputed');
        expect(out.parsed.label).toBe('Safe');
        expect(out.results[0].code).toBe('A');
    });

    it('returns null when the question cannot be parsed at all', async () => {
        DISHAProviders.isConnected = () => false;
        // Force the keyword fallback to miss by stubbing DISHA.matchQueryId away.
        const realMatch = DISHA.matchQueryId;
        DISHA.matchQueryId = () => 'no_such_query_id';
        try {
            expect(await T.run('xyzzy', {})).toBeNull();
        } finally {
            DISHA.matchQueryId = realMatch;
        }
    });
});
