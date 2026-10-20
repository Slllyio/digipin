import { describe, it, expect } from 'vitest';

// MobilityGrid is exposed on globalThis by tests/setup.js. indexFor/sample are
// pure; these lock the per-cell sampling + null-gating contract.
const G = globalThis.MobilityGrid;

const grid = {
    res_m: 200,
    bounds: { west: 75.6, south: 22.5, east: 76.0, north: 22.9 },
    nx: 2, ny: 2,                       // [NW, NE, SW, SE]
    mobility_risk: [10, 80, null, 50],  // SW is an unscored (no-road) cell
    access_class: ['Smooth', 'Restricted', null, 'Constrained'],
    sealable: [0, 1, 0, 0],
    on_chokepoint: [0, 1, 0, 0],
    nearest_police_km: [0.3, 2.1, null, 1.0],
};

describe('MobilityGrid.indexFor', () => {
    it('maps points to row-major cells (row 0 = north)', () => {
        expect(G.indexFor(grid, 22.89, 75.61)).toBe(0);   // NW
        expect(G.indexFor(grid, 22.89, 75.99)).toBe(1);   // NE
    });
    it('returns -1 outside bounds', () => {
        expect(G.indexFor(grid, 10, 10)).toBe(-1);
    });
});

describe('MobilityGrid.sample', () => {
    it('returns the access record for a scored cell', () => {
        const s = G.sample(grid, 22.89, 75.99);           // NE = restricted
        expect(s.mobility_risk).toBe(80);
        expect(s.access_class).toBe('Restricted');
        expect(s.sealable).toBe(true);
        expect(s.on_chokepoint).toBe(true);
        expect(s.nearest_police_km).toBe(2.1);
    });
    it('returns null for an unscored (no-road) cell', () => {
        expect(G.sample(grid, 22.51, 75.61)).toBeNull();   // SW, risk null + class null
    });
    it('returns null outside the grid', () => {
        expect(G.sample(grid, 10, 10)).toBeNull();
    });
});
