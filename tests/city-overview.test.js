import { describe, it, expect } from 'vitest';

const C = globalThis.CityOverview;
const FIELDS = ['walkability', 'green', 'livability', 'flood_risk'];

describe('CityOverview.summarise()', () => {
    const shards = [
        { A: [0, 0, 12, 40], B: [50, 40, 61, 30] },
        { C: [30, 20, 45, 50], D: 'junk' },
    ];
    const s = C.summarise(shards, FIELDS);

    it('counts every scored cell but averages only core (walkable) cells', () => {
        expect(s.cells).toBe(3);
        expect(s.core).toBe(2);
        expect(s.means.livability).toBe(53);
        expect(s.means.flood_risk).toBe(40);
    });
    it('bins core-cell livability into ten 10-point buckets', () => {
        expect(s.hist).toHaveLength(10);
        expect(s.hist[6]).toBe(1);
        expect(s.hist[4]).toBe(1);
        expect(s.hist.reduce((a, b) => a + b, 0)).toBe(2);
    });
    it('copes with no shards', () => {
        const e = C.summarise([], FIELDS);
        expect(e).toMatchObject({ cells: 0, core: 0 });
        expect(e.means).toEqual({});
    });
    it('puts a perfect 100 in the top bucket', () => {
        expect(C.summarise([{ X: [10, 0, 100, 0] }], FIELDS).hist[9]).toBe(1);
    });
});

describe('CityOverview.bboxAreaKm2()', () => {
    it('accepts array and object bboxes', () => {
        const a = C.bboxAreaKm2([75.6, 22.5, 76.0, 22.9]);
        const o = C.bboxAreaKm2({ west: 75.6, south: 22.5, east: 76.0, north: 22.9 });
        expect(a).toBeCloseTo(o, 6);
        expect(a).toBeGreaterThan(1700);
        expect(a).toBeLessThan(1900);
    });
    it('is zero for missing or inverted boxes', () => {
        expect(C.bboxAreaKm2(null)).toBe(0);
        expect(C.bboxAreaKm2([1, 1, 0, 0])).toBe(0);
    });
});

describe('CityOverview.fmtCount()', () => {
    it('compacts large counts', () => {
        expect(C.fmtCount(184)).toBe('184');
        expect(C.fmtCount(2209)).toBe('2.2k');
        expect(C.fmtCount(109000)).toBe('109k');
        expect(C.fmtCount(2.5e6)).toBe('2.5M');
        expect(C.fmtCount(NaN)).toBe('—');
    });
});

describe('CityOverview.histogramSvg()', () => {
    it('draws one bar per bin with an accessible label', () => {
        const svg = C.histogramSvg([1, 2, 3, 0], 80, 20);
        expect((svg.match(/<rect /g) || []).length).toBe(4);
        expect(svg).toContain('role="img"');
        expect(svg).toContain('aria-label=');
    });
});
