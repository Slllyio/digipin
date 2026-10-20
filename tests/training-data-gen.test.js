import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// TrainingDataGen is exposed on globalThis by tests/setup.js. Its TEMPLATES
// answer() functions are pure (data -> training string) and exercise the
// internal helpers (getTopScores / suggest* / formatAddr / getFeatureCount).
// One template calls DISHA.getAQICategory (a sibling module loaded before it in
// the app) — stub it so the templates can be tested in isolation.
const TDG = globalThis.TrainingDataGen;

beforeAll(() => {
    globalThis.DISHA = { getAQICategory: () => 'Moderate' };
});
afterAll(() => { delete globalThis.DISHA; });

const richData = {
    scores: {
        walkability: { label: 'Walkability', value: 80 },
        safety: { label: 'Safety', value: 30 },
        green: { label: 'Green', value: 55 },
        livability: { label: 'Livability', value: 65 },
        connectivity: { label: 'Connectivity', value: 70 },
        healthcare_access: { label: 'Healthcare', value: 20 },
        noise_estimate: { label: 'Quietness', value: 60 },
        commercial: { label: 'Commercial', value: 45 },
    },
    categories: {
        infrastructure: { features: { street_lamps: { count: 40 } } },
        government: { features: { police: { count: 2 } } },
    },
    address: { area: 'Vijay Nagar', city: 'Indore', state: 'MP' },
    environment: { temperature: 30, aqi: 120, solar: { solarPotential: 'High' } },
};

describe('TrainingDataGen.TEMPLATES', () => {
    it('exposes a non-empty array of well-formed templates', () => {
        expect(Array.isArray(TDG.TEMPLATES)).toBe(true);
        expect(TDG.TEMPLATES.length).toBeGreaterThan(0);
        for (const t of TDG.TEMPLATES) {
            expect(typeof t.id).toBe('string');
            expect(typeof t.question).toBe('function');
            expect(typeof t.answer).toBe('function');
        }
    });

    it('has unique template ids', () => {
        const ids = TDG.TEMPLATES.map(t => t.id);
        expect(ids.length).toBe(new Set(ids).size);
    });

    it('every answer() produces a non-empty string for rich data', () => {
        for (const t of TDG.TEMPLATES) {
            const out = t.answer(richData, {});
            expect(typeof out, t.id).toBe('string');
            expect(out.length, t.id).toBeGreaterThan(0);
        }
    });

    it('every answer() handles empty/sparse data without throwing', () => {
        // A cell with no scores/categories/address must not crash generation.
        for (const t of TDG.TEMPLATES) {
            expect(() => t.answer({}, {}), t.id).not.toThrow();
            expect(() => t.answer({ scores: {} }, {}), t.id).not.toThrow();
        }
    });

    it('every question() returns a non-empty string', () => {
        for (const t of TDG.TEMPLATES) {
            const q = t.question(richData, {});
            expect(typeof q, t.id).toBe('string');
            expect(q.length, t.id).toBeGreaterThan(0);
        }
    });
});
