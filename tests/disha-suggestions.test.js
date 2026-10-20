import { describe, it, expect } from 'vitest';

// DISHA is exposed on globalThis by tests/setup.js. getSuggestions() is pure.
const D = globalThis.DISHA;

describe('DISHA.getSuggestions — context (no reply)', () => {
    it('returns up to 5 cell-context suggestions when no reply is given', () => {
        const out = D.getSuggestions({ scores: { livability: { value: 80 } } });
        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThanOrEqual(5);
        expect(out).toContain('Give me a full urban intelligence briefing');
    });
});

describe('DISHA.getSuggestions — conversation-aware follow-ups', () => {
    it('derives flood + transit follow-ups from the reply text', () => {
        const out = D.getSuggestions({}, 'This cell has high flood risk and poor transit access.');
        expect(out.some(s => /flood mitigation/i.test(s))).toBe(true);
        expect(out.some(s => /transit/i.test(s))).toBe(true);
    });

    it('derives growth + investment follow-ups', () => {
        const out = D.getSuggestions({}, 'Strong construction-led growth makes this a good investment.');
        expect(out.some(s => /driving growth/i.test(s))).toBe(true);
        expect(out.some(s => /investment/i.test(s))).toBe(true);
    });

    it('always offers generic deepeners and caps at 4', () => {
        const out = D.getSuggestions({}, 'A neutral reply with no special topics.');
        expect(out).toContain('Summarise the top 3 takeaways');
        expect(out.length).toBeLessThanOrEqual(4);
    });

    it('dedupes and returns distinct questions', () => {
        const out = D.getSuggestions({}, 'flood flood flood waterlogging inundation');
        expect(new Set(out).size).toBe(out.length);
    });
});
