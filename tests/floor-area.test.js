import { describe, it, expect } from 'vitest';

const FA = globalThis.FloorArea;
const lat0 = 22.72, lng0 = 75.86;
const mLat = 111320;
const mLng = 111320 * Math.cos(lat0 * Math.PI / 180);
const box = (x0, y0, x1, y1) => {
    const p = (x, y) => [lng0 + x / mLng, lat0 + y / mLat];
    return [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)];
};
// A 100 m × 100 m plot.
const plot = { south: lat0, north: lat0 + 100 / mLat, west: lng0, east: lng0 + 100 / mLng };

describe('FloorArea.areaM2()', () => {
    it('measures a 20 m × 10 m footprint', () => {
        expect(FA.areaM2(box(0, 0, 20, 10))).toBeCloseTo(200, 0);
    });
    it('is zero for a degenerate ring', () => {
        expect(FA.areaM2([[0, 0], [1, 1]])).toBe(0);
    });
});

describe('FloorArea.storeys()', () => {
    it('prefers explicit floors, then height ÷ 3.2 m, else one unknown storey', () => {
        expect(FA.storeys({ floors: 5, height: 100 })).toEqual({ n: 5, known: true });
        expect(FA.storeys({ height: 16 })).toEqual({ n: 5, known: true });
        expect(FA.storeys({ height: 2 })).toEqual({ n: 1, known: true });
        expect(FA.storeys({})).toEqual({ n: 1, known: false });
    });
});

describe('FloorArea.analyse()', () => {
    it('FAR = gross floor area ÷ plot area', () => {
        // 50 × 20 m footprint (1000 m²) of 4 storeys on a 10 000 m² plot → FAR 0.4, 10 % cover.
        const r = FA.analyse([{ polygon: box(10, 10, 60, 30), height: 12.8 }], plot);
        expect(r.plotAreaM2).toBeGreaterThan(9990);
        expect(r.plotAreaM2).toBeLessThan(10010);
        expect(r.far).toBeCloseTo(0.4, 1);
        expect(r.coverage).toBeCloseTo(10, 0);
        expect(r.avgStoreys).toBe(4);
        expect(r.maxStoreys).toBe(4);
    });
    it('counts a straddling building only in the plot holding its centroid', () => {
        const straddle = [{ polygon: box(80, 10, 140, 30), height: 6.4 }];   // centroid x=110 → outside
        expect(FA.analyse(straddle, plot).buildings).toBe(0);
        expect(FA.analyse([{ polygon: box(70, 10, 120, 30), height: 6.4 }], plot).buildings).toBe(1);  // centroid x=95 → inside
    });
    it('reports buildings with no height as one storey', () => {
        const r = FA.analyse([{ polygon: box(10, 10, 30, 30) }], plot);
        expect(r.unknownHeight).toBe(1);
        expect(r.avgStoreys).toBe(1);
    });
    it('handles an empty plot', () => {
        const r = FA.analyse([], plot);
        expect(r.far).toBe(0);
        expect(FA.summary(r)).toContain('No buildings');
    });
});

describe('FloorArea.band() / summary()', () => {
    it('bands density', () => {
        expect([0.2, 1, 2, 4].map(FA.band)).toEqual(['low', 'medium', 'high', 'very high']);
    });
    it('summary names FAR, cover and the unknown-height caveat', () => {
        const s = FA.summary({ buildings: 3, unknownHeight: 1, far: 1.2, coverage: 35, gfaM2: 12000, plotAreaM2: 10000, avgStoreys: 3.4 });
        expect(s).toContain('FAR 1.20 (medium density)');
        expect(s).toContain('35% built over');
        expect(s).toContain('1 without height counted as 1 storey');
    });
});
