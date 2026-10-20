import { describe, it, expect } from 'vitest';

// DishaIntel is exposed by tests/setup.js.
const D = globalThis.DishaIntel;
const CITIES = [
    { name: 'indore_pilot', label: 'Indore' }, { name: 'pune', label: 'Pune' },
    { name: 'delhi', label: 'Delhi' }, { name: 'bengaluru', label: 'Bengaluru' },
];

describe('DishaIntel.match()', () => {
    it('routes notable-here questions to insights', () => {
        expect(D.match("What's notable here?", CITIES)).toEqual({ type: 'insights' });
        expect(D.match('Any hotspots or anomalies in this area?', CITIES)).toEqual({ type: 'insights' });
    });
    it('routes what-if questions with their parameters', () => {
        expect(D.match('What if we add a park here?', CITIES)).toEqual({ type: 'whatif', scenario: 'park' });
        expect(D.match('What happens if we double the density?', CITIES)).toEqual({ type: 'whatif', scenario: 'density', factor: 2 });
        expect(D.match('simulate 3x population here', CITIES)).toEqual({ type: 'whatif', scenario: 'density', factor: 3 });
        expect(D.match('what if an extreme flood hits', CITIES)).toEqual({ type: 'whatif', scenario: 'flood', level: 'extreme' });
    });
    it('routes city comparisons and rankings', () => {
        expect(D.match('Compare Pune with Indore', CITIES)).toEqual({ type: 'compare', a: { city: 'pune' }, b: { city: 'indore_pilot' } });
        expect(D.match('Bangalore vs Delhi for families', CITIES)).toEqual({ type: 'compare', a: { city: 'bengaluru' }, b: { city: 'delhi' } });
        expect(D.match('Which city is best to live in?', CITIES)).toEqual({ type: 'dashboard' });
    });
    it('leaves ordinary questions to the model', () => {
        expect(D.match('Is this safe to live?', CITIES)).toBeNull();
        expect(D.match('Where should I open a restaurant?', CITIES)).toBeNull();
    });
});

describe('DishaIntel citations', () => {
    it('lists distinct tags in order', () => {
        expect(D.citeTags('flood [C2] and heat [C1], again [C2]')).toEqual(['C2', 'C1']);
    });
    it('turns tags into chips and lists what was cited', () => {
        const el = document.createElement('div');
        el.innerHTML = '<div>Flood risk is high [C1] and NO2 is rising [C9].</div>';
        const used = D.decorate(el, [{ tag: 'C1', id: 'scores', title: 'Intelligence scores', source: 'pipeline' }]);
        expect(used.map(c => c.tag)).toEqual(['C1']);
        expect(el.querySelectorAll('.disha-cite')).toHaveLength(1);
        expect(el.textContent).toContain('[C9]');   // unknown tags stay as text
        expect(el.querySelector('.disha-cite-sources').textContent).toMatch(/Intelligence scores/);
    });
});
