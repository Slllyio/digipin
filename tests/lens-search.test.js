import { describe, it, expect } from 'vitest';

const LS = globalThis.LensSearch;
const UL = globalThis.UrbanLenses;
const DI = globalThis.DishaIntel;
const CAT = () => UL.catalog().filter(l => l.id !== 'siting');
const ids = (q, n = 5) => LS.search(q, CAT(), { limit: n, routed: DI.lensHits(q) }).map(x => x.id);

describe('LensSearch', () => {
    it('tokens drop stop words and expand everyday synonyms', () => {
        expect(LS.tokens('Is the air in my area polluted?')).toEqual(['air', 'polluted']);
        const t = LS.expand('cheap flat');
        expect(t.get('cheap')).toBe(1);
        expect(t.get('hous')).toBeCloseTo(0.6);   // 'housing', stemmed
    });

    it('finds lenses for questions the regex router does not take', () => {
        expect(ids('Which areas flood every monsoon?')).toContain('floodspots');
        expect(ids('where can I find cheap land that will grow in value')).toContain('landvalue');
        expect(ids('where do the poor live')).toContain('deprivation');
        expect(ids('how bad is the air in winter')).toContain('badairdays');
    });

    it('puts the routed lenses first', () => {
        expect(DI.lensHits('which parts have power cuts')[0]).toBe('powercuts');
        expect(ids('which parts have power cuts')[0]).toBe('powercuts');
        expect(ids('carbon emissions of the city')[0]).toBe('fossilco2');
    });

    it('returns nothing for empty or content-free questions', () => {
        expect(LS.search('', CAT())).toEqual([]);
        expect(LS.search('what is this', CAT())).toEqual([]);
    });

    it('lensText renders headline, stats, area, rank and source', () => {
        const t = LS.lensText({ id: 'x', title: 'X', headline: 'H.', stats: [{ label: 'a', value: '1' }], refs: 'R' }, {
            area: { label: 'Heat', area: 3, city: 2, unit: '°C', betterThan: 40 }, areaCode: '39J49L',
            rank: { rank: 2, of: 13, label: 'Heat', value: 3, unit: '°C', best: { city: 'A', value: 1 }, worst: { city: 'B', value: 9 } },
        });
        expect(t).toBe('[x] X: H.\n  · a: 1\n  · Selected area 39J49L: Heat 3 °C vs city 2 °C (better than 40% of the city\'s residents)\n'
            + '  · Among 13 cities: rank 2 of 13 on Heat (3 °C; best A 1, worst B 9)\n  · Source: R');
    });

    it('agent tools validate', () => {
        expect(globalThis.DISHATools.validateArgs('findLenses', { query: 'flood' })).toEqual({ ok: true, args: { query: 'flood' } });
        expect(globalThis.DISHATools.validateArgs('runLens', {}).ok).toBe(false);
    });
});
