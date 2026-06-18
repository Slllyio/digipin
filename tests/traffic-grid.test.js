import { describe, it, expect } from 'vitest';

// TrafficGrid is exposed on globalThis by tests/setup.js. indexFor/sample are
// pure (no fetch); these lock the per-cell sampling contract.
const G = globalThis.TrafficGrid;

const grid = {
    res_m: 200,
    bounds: { west: 75.6, south: 22.5, east: 76.0, north: 22.9 },
    nx: 2, ny: 2,
    // row-major, row 0 = north. cells: [NW, NE, SW, SE]
    congestion_risk: [10, 90, 40, 60],
    worst_los: ['A', 'F', 'C', 'D'],
    dominant_class: ['residential', 'primary', 'secondary', 'tertiary'],
    road_density_m: [100, 800, 300, 500],
    has_critical_link: [0, 1, 0, 0],
    betweenness_max: [0.001, 0.05, 0.01, 0.02],
    transit_stops: [0, 3, 1, 0],
    transit_routes: [0, 4, 1, 0],
    transit_headway_min: [null, 8, 20, null],
    transit_access: [0, 88, 40, 0],
};

describe('TrafficGrid.indexFor', () => {
    it('maps a northern point to row 0 and a southern to the bottom row', () => {
        expect(G.indexFor(grid, 22.89, 75.61)).toBe(0);   // NW
        expect(G.indexFor(grid, 22.89, 75.99)).toBe(1);   // NE
        expect(G.indexFor(grid, 22.51, 75.61)).toBe(2);   // SW
    });
    it('returns -1 outside the grid bounds', () => {
        expect(G.indexFor(grid, 10, 10)).toBe(-1);
        expect(G.indexFor(null, 22.7, 75.8)).toBe(-1);
    });
});

describe('TrafficGrid.sample', () => {
    it('returns the per-cell congestion + transit record', () => {
        const s = G.sample(grid, 22.89, 75.99);           // NE = high-congestion cell
        expect(s.congestion_risk).toBe(90);
        expect(s.los_grade).toBe('F');
        expect(s.dominant_class).toBe('primary');
        expect(s.has_critical_link).toBe(true);
        expect(s.transit_stops).toBe(3);
        expect(s.transit_access).toBe(88);
    });
    it('returns null outside the grid', () => {
        expect(G.sample(grid, 10, 10)).toBeNull();
    });
    it('handles a grid without transit arrays (road-only)', () => {
        const roadOnly = { ...grid };
        delete roadOnly.transit_stops; delete roadOnly.transit_access;
        delete roadOnly.transit_routes; delete roadOnly.transit_headway_min;
        const s = G.sample(roadOnly, 22.89, 75.99);
        expect(s.congestion_risk).toBe(90);
        expect(s.transit_stops).toBeNull();
        expect(s.transit_access).toBeNull();
    });
});
