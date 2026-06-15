import { describe, it, expect } from 'vitest';

// Text2MapEmbeddings is exposed on globalThis by tests/setup.js. The neural
// model is loaded lazily from a CDN at runtime (unavailable + irrelevant in
// jsdom), so these lock the PURE pieces: cosine similarity, the sims→weights
// reduction, the embedded catalogue text, and the never-block contract.
const E = globalThis.Text2MapEmbeddings;

describe('Text2MapEmbeddings.cosine', () => {
    it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
        expect(E.cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
        expect(E.cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
        expect(E.cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
    });

    it('is scale-invariant (direction only) and 0 against a zero vector', () => {
        expect(E.cosine([2, 0], [9, 0])).toBeCloseTo(1, 6);
        expect(E.cosine([0, 0], [1, 1])).toBe(0);
    });
});

describe('Text2MapEmbeddings.weightsFromSims', () => {
    it('keeps the top-K above threshold and scales the best to 1', () => {
        const out = E.weightsFromSims([
            { id: 'green', sim: 0.8 },
            { id: 'safety', sim: 0.4 },
            { id: 'noise_estimate', sim: 0.05 }, // below MIN_SIM → dropped
        ]);
        expect(out.primaryScore).toBe('green');
        expect(out.weights.green).toBe(1);                 // best scaled to 1
        expect(out.weights.safety).toBeCloseTo(0.5, 2);    // 0.4/0.8
        expect(out.weights.noise_estimate).toBeUndefined();
    });

    it('returns null when nothing clears the similarity floor', () => {
        expect(E.weightsFromSims([{ id: 'green', sim: 0.05 }])).toBeNull();
        expect(E.weightsFromSims([])).toBeNull();
    });

    it('caps the number of weights at K', () => {
        const sims = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, sim: 0.9 - i * 0.05 }));
        const out = E.weightsFromSims(sims);
        expect(Object.keys(out.weights).length).toBeLessThanOrEqual(5);
    });
});

describe('Text2MapEmbeddings.catalogText', () => {
    it('enriches a score with its gloss when available', () => {
        const t = E.catalogText('flood_risk', 'Flood Risk');
        expect(t).toContain('Flood Risk');
        expect(t).toContain(E.GLOSS.flood_risk);
    });

    it('falls back to label + spaced id when there is no gloss', () => {
        const t = E.catalogText('made_up_score', 'My Label');
        expect(t).toBe('My Label made up score');
    });
});

describe('Text2MapEmbeddings.rank — never blocks or throws', () => {
    it('returns null synchronously while the model is cold (lexicon takes over)', async () => {
        // No model in jsdom → rank kicks off a background load and returns null.
        const out = await E.rank('a quiet green area', ['noise_estimate', 'green'], (id) => id);
        expect(out).toBeNull();
    });

    it('returns null for empty/invalid input', async () => {
        expect(await E.rank('', ['green'], (id) => id)).toBeNull();
        expect(await E.rank('hello', [], (id) => id)).toBeNull();
    });
});
