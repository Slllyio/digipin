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

describe('LensSearch dataset fields', () => {
    const fs = require('fs');
    const DS = JSON.parse(fs.readFileSync('data/cells/catalog.json', 'utf8')).datasets;
    const top = q => LS.searchFields(q, DS, { limit: 3 }).map(x => `${x.ds}.${x.key}`);

    it('finds the field for amenity and people questions no lens covers', () => {
        expect(top('which areas have the most pharmacies')).toContain('places.pharmacies');
        expect(top('where is a good gym near me')[0]).toBe('places.leisure');
        expect(top('petrol pumps nearby')).toEqual(['places.fuel']);
        expect(top('what share of residents are women')[0]).toBe('demographics.women_pct');
        expect(top('old age homes in the city')[0]).toBe('places.elder_homes');
        expect(top('literacy rate here')).toEqual(['census_homes.c11_literacy_pct']);
    });

    it('generic words alone pick no field', () => {
        expect(top('what is this')).toEqual([]);
        expect(top('good areas nearby')).toEqual([]);
    });

    it('fieldText summarises counts and levels with area, top blocks and caveat', () => {
        const codes = ['39J49K1', '39J49K2', '39J4C33'], pop = [1000, 3000, 6000];
        const t = LS.fieldText({ id: 'places', title: 'Places', level: 7, source: 'S', license: 'L' },
            { key: 'fuel', label: 'Fuel', agg: 'sum', unit: 'places' }, [1, 0, 2], pop, codes,
            { area: '39J49K', names: new Map([['39J4C33', 'Foo']]) });
        expect(t).toContain('City total 3 places (30 per lakh residents); 70% of residents');
        expect(t).toContain('Selected area 39J49K: 1 places over 2 blocks (25 per lakh residents vs city 30)');
        expect(t).toContain('Highest blocks: 39J4C33 · Foo 2; 39J49K1 1');
        expect(t).toContain('Caveat: Overture');
        const m = LS.fieldText({ id: 'x', title: 'X', level: 5, approxCellM: 4000 }, { key: 'v', label: 'V', agg: 'mean', unit: '%' },
            [10, 20, 30], pop, codes, { area: '39J4C3' });
        expect(m).toContain('Resident-weighted median 30 % (10th–90th percentile 10 to 30)');
        expect(m).toContain('Selected area 39J4C3: 30 % (higher than where 40% of the city\'s residents live)');
        expect(m).toContain('level 5 (~4 km cells)');
    });
});

describe('LensSearch question sense', () => {
    it('reads polluted water as water, clean air as air, IT as tech', () => {
        expect(ids('is the river near me polluted')).not.toContain('air');
        expect(ids('which area has the cleanest air')[0]).toBe('air');
        expect(LS.expand('where do IT workers live').has('tech')).toBe(true);
        expect(LS.expand('where do it workers live').has('tech')).toBe(false);
    });
});
