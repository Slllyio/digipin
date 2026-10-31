import { describe, it, expect } from 'vitest';

const W = globalThis.RoadWhatIf;

// Two zones joined by one road; 1000 daily trips each way.
const model = {
    nodes: [77.0, 28.0, 77.02, 28.0],
    zones: { node: [0, 1] },
    od: { origins: [0, 1], counts: [1, 1], d: [1, 0], v: [1000, 1000] },
    pieces: { a: [0], b: [1], len: [2000], ffs: [40], cap: [100], f: [0] },
    params: { period_share: { am: 0.1, pm: 0.1 }, bpr: [0.15, 4], increments: [0.4, 0.3, 0.2, 0.1], access_min: 1,
        max_slowdown: 4, los_bands: [0.35, 0.55, 0.75, 0.9, 1.0], new_road: { ffs: 40, cap: 1000 } },
    pop_cells: [77.01, 28.0, 500],
};

describe('RoadWhatIf mode shift', () => {
    it('removes the shifted share of trips and lightens the road', () => {
        const C = W.core;
        const r0 = C.rows(model, 'am'), r1 = C.rows(model, 'am', { frac: 0.2, zones: null });
        expect(r0.shifted).toBe(0);
        expect(r1.shifted).toBe(400);
        expect(r1[0].v[0]).toBe(800);
        const out = C.run(model, 'am', { shift: { frac: 0.2, zones: null } });
        expect(out.result.shiftedPcu).toBe(40);
        const road = out.result.roads.find(x => x.f === 0);
        expect(road.scen).toBeLessThan(road.base);
        // Only zone 0 near a station: no pair has both ends served, so nothing shifts.
        expect(C.rows(model, 'am', { frac: 0.5, zones: [1, 0] }).shifted).toBe(0);
        expect(C.rows(model, 'am', { frac: 0.5, zones: [1, 1] }).shifted).toBe(1000);
    });

    it('flags zones within 1 km of a station and labels the scenario', () => {
        const z = W.stationZones(model, [[77.001, 28.0]]);
        expect([...z]).toEqual([1, 0]);
        expect(W.shiftLabel({ pct: 10, scope: 'all' })).toMatch(/10% of every car trip/);
        expect(W.editsFrom({ closed: [], widened: [], added: [], slowed: {}, shift: { pct: 15, zones: null } }).shift).toEqual({ frac: 0.15, zones: null });
    });
});

describe('RoadWhatIf bus lane', () => {
    it('corridorPoints samples every feature line and keeps the ends', () => {
        const R = globalThis.RoadWhatIf || window.RoadWhatIf;
        const feats = [{ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] } },
            { geometry: { type: 'MultiLineString', coordinates: [[[9, 9], [9, 10]]] } }];
        const pts = R.corridorPoints(feats, [0, 1], 3);
        expect(pts).toEqual([[0, 0], [3, 0], [4, 0], [9, 9], [9, 10]]);
        expect(R.BUS_LANE_CAP).toBeCloseTo(2 / 3, 6);
    });
    it('shiftLabel names the corridor', () => {
        const R = globalThis.RoadWhatIf || window.RoadWhatIf;
        expect(R.shiftLabel({ pct: 15, scope: 'corridor', road: 'Outer Ring Road' })).toMatch(/^15% of car trips .* Outer Ring Road move to the bus$/);
    });
});

describe('RoadWhatIf bus riders', () => {
    it('busRiderGain is zero on a free road and grows with V/C', () => {
        const R = globalThis.RoadWhatIf;
        const feats = [{ properties: { ffs: 50, vc_am: 0 } }, { properties: { ffs: 50, vc_am: 1.2 } }];
        expect(R.busRiderGain(feats, [0], 'am')).toBe(0);
        // 5 km at 30 km/h = 10 min; BPR 1 + 0.15·1.2⁴ ≈ 1.311 → 3.11 min saved.
        expect(R.busRiderGain(feats, [1], 'am')).toBeCloseTo(10 * 0.15 * 1.2 ** 4, 3);
    });
});
