import { describe, it, expect } from 'vitest';

// DishaMentions is exposed on globalThis by tests/setup.js. Everything tested
// here is pure: candidates are passed in rather than read from the app.
const M = globalThis.DishaMentions;

const LAYERS = [
    { id: 'heat', name: 'Urban Heat Island', kind: 'btn', ref: 'btn-heat' },
    { id: 'ndvi', name: 'NDVI Vegetation', kind: 'btn', ref: 'btn-ndvi' },
    { id: 'overture_roads', name: 'Roads (Overture)', kind: 'dt', ref: 'overture_roads' },
    { id: 'osm_roads', name: 'Road Network (OSM)', kind: 'dt', ref: 'osm_roads' },
];
const SCORES = [
    { id: 'safety', name: 'Safety' },
    { id: 'flood_risk', name: 'Flood Risk' },
    { id: 'education_score', name: 'Education' },
];

describe('DishaMentions.extract()', () => {
    it('finds / and @ tokens at word starts only', () => {
        expect(M.extract('/heat near @safety and @flood_risk')).toEqual({
            layers: ['heat'], scores: ['safety', 'flood_risk'],
        });
        expect(M.extract('see https://x.org/a and mail a@b.com')).toEqual({ layers: [], scores: [] });
    });
});

describe('DishaMentions.match() / resolve()', () => {
    it('prefers exact id or name, then a unique prefix or substring', () => {
        expect(M.match('heat', LAYERS).ref).toBe('btn-heat');
        expect(M.match('nd', LAYERS).id).toBe('ndvi');
        expect(M.match('vegetation', LAYERS).id).toBe('ndvi');
        expect(M.match('Flood-Risk', SCORES).id).toBe('flood_risk');
    });

    it('refuses to guess between ambiguous matches', () => {
        expect(M.match('road', LAYERS)).toBeNull();
        expect(M.match('', LAYERS)).toBeNull();
    });

    it('splits matched from unknown tokens, with suggestions', () => {
        const r = M.resolve(['heat', 'road', 'heat'], LAYERS);
        expect(r.matched.map(m => m.id)).toEqual(['heat']);
        expect(r.unknown).toEqual([{ token: 'road', suggestions: ['Roads (Overture)', 'Road Network (OSM)'] }]);
    });
});

describe('DishaMentions.rewrite()', () => {
    it('drops /layer and swaps @score for its label', () => {
        const q = M.rewrite('/heat best area for @safety', [{ token: 'safety', name: 'Safety' }]);
        expect(q).toBe('best area for Safety');
        expect(M.rewrite('/heat', [])).toBe('');
    });
});

describe('DishaMentions.applyPins()', () => {
    it('adds missing pins and lifts weak ones, keeping their sign', () => {
        const out = M.applyPins({ weights: { safety: 0.3, flood_risk: -0.2 }, source: 'llm' },
            ['safety', 'flood_risk', 'education_score']);
        expect(out.weights).toEqual({ safety: 0.8, flood_risk: -0.8, education_score: 0.8 });
        expect(out.pinned).toEqual(['safety', 'flood_risk', 'education_score']);
    });

    it('is a no-op without pins', () => {
        const p = { weights: { safety: 1 } };
        expect(M.applyPins(p, [])).toBe(p);
    });
});

describe('DishaMentions.tokenAtCaret()', () => {
    it('finds the token being typed', () => {
        expect(M.tokenAtCaret('show /he', 8)).toEqual({ sigil: '/', partial: 'he', start: 5 });
        expect(M.tokenAtCaret('@', 1)).toEqual({ sigil: '@', partial: '', start: 0 });
        expect(M.tokenAtCaret('a/b', 3)).toBeNull();
        expect(M.tokenAtCaret('done /heat ', 11)).toBeNull();
    });
});
