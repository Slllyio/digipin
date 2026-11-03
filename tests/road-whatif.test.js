import { describe, it, expect } from 'vitest';

// RoadWhatIf is exposed on globalThis by tests/setup.js. The core routing
// engine is pure; these run it on a toy network.
const RW = globalThis.RoadWhatIf;
const C = RW.core;

// Nodes: 0 W (75.80,22.70), 1 E (75.82,22.70), 2 N-mid (75.81,22.71).
// Road 0: W–E direct (2 km). Roads 1, 2: W–N, N–E detour.
function model() {
    return {
        nodes: [75.80, 22.70, 75.82, 22.70, 75.81, 22.71],
        pieces: { a: [0, 0, 2], b: [1, 2, 1], len: [2000, 1500, 1500], ffs: [45, 35, 35], cap: [1800, 1500, 1500], f: [0, 1, 2] },
        zones: { node: [0, 1], pop: [10000, 0] },
        od: { origins: [0], counts: [1], d: [1], v: [20000] },
        pop_cells: [75.805, 22.7055, 500, 75.80, 22.69, 300],
        params: { period_share: { am: 0.09, pm: 0.088 }, increments: [0.4, 0.3, 0.2, 0.1], bpr: [0.15, 4],
            max_slowdown: 4, los_bands: [0.35, 0.55, 0.75, 0.9, 1.0], access_min: 2,
            new_road: { highway: 'primary', ffs: 45, cap: 1800 } },
    };
}

describe('RoadWhatIf core', () => {
    it('loads the commute on the quickest road, then spills onto the detour as it fills', () => {
        const m = model(), g = C.build(m);
        const r = C.assign(g, m, 'am');
        const vc = C.featureVC(g, r);
        expect(r.served).toBeCloseTo(20000 * 0.09, 6);
        expect(vc.get(0)).toBeGreaterThan(0.5);                // direct road carries most
        expect(r.unserved).toBe(0);
    });
    it('reverses the matrix in the evening', () => {
        const m = model(), g = C.build(m);
        const am = C.assign(g, m, 'am'), pm = C.assign(g, m, 'pm');
        expect(am.flow[0]).toBeGreaterThan(0);                  // link 0: W→E
        expect(am.flow[1]).toBe(0);
        expect(pm.flow[1]).toBeGreaterThan(0);                  // link 1: E→W
        expect(pm.flow[0]).toBe(0);
    });
    it('closing the direct road pushes traffic onto the detour and names who is affected', () => {
        const m = model();
        const out = C.run(m, 'am', { closed: [0] });
        const res = out.result;
        const d1 = res.roads.find(r => r.f === 1);
        expect(d1.delta).toBeGreaterThan(0.1);
        expect(res.roads.find(r => r.f === 0).closed).toBe(true);
        expect(res.worse).toBeGreaterThanOrEqual(1);
        expect(res.residentsNearWorse).toBe(500);               // only the cell beside the detour
        expect(res.vehHours.delta).toBeGreaterThan(0);
        expect(res.tripMin.scen).toBeGreaterThan(res.tripMin.base);
        expect(RW.headline(res, 'am')).toMatch(/more time spent driving in the morning peak/);
    });
    it('reports trips cut off when a closure disconnects homes', () => {
        const m = model();
        const res = C.run(m, 'am', { closed: [0, 1] }).result;
        expect(res.unservedPcu).toBeCloseTo(20000 * 0.09, 6);
        expect(RW.headline(res, 'am')).toMatch(/cuts off about 1,800 vehicle trips/);
    });
    it('widening and new links add capacity and relieve the corridor', () => {
        const m = model();
        const base = C.run(m, 'am', {});
        const wid = C.run(m, 'am', { widened: { 0: 1.5 } }, base.base).result;
        expect(wid.roads.find(r => r.f === 0).delta).toBeLessThan(0);
        expect(C.newLink(m, 0, 1).len).toBeGreaterThan(2000);    // straight line × 1.1
        const link = C.newLink(m, 0, 1, 0.9);                    // a shorter flyover
        const add = C.run(m, 'am', { added: [link] }, base.base).result;
        expect(add.roads.find(r => r.f === -1).scen).toBeGreaterThan(0);
        expect(add.vehHours.delta).toBeLessThan(0);
    });
    it('baseline cache gives the same answer as a fresh run', () => {
        const m = model();
        const fresh = C.run(m, 'am', { closed: [0] }).result;
        const base = C.run(m, 'am', {});
        const cached = C.run(m, 'am', { closed: [0] }, base.base).result;
        expect(cached.vehHours.delta).toBeCloseTo(fresh.vehHours.delta, 9);
    });
    it('snaps to the nearest node and colours changes', () => {
        expect(C.nearestNode(model(), 75.8101, 22.7099).node).toBe(2);
        expect(RW.diffColor(0.35)).toBe('#b30000');
        expect(RW.diffColor(-0.15)).toBe('#6baed6');
        expect(RW.diffColor(0.05)).toBeNull();
        expect(RW.editsFrom({ closed: [3], widened: [4], added: [{ link: { a: 0, b: 1 } }] }))
            .toEqual({ closed: [3], widened: { 4: 1.5 }, added: [{ a: 0, b: 1 }] });
    });
});

describe('RoadWhatIf chat helpers', () => {
    const feats = [
        { properties: { name: 'M.G. Road' } }, { properties: { name: 'MG Road' } },
        { properties: { name: 'AB Road' } }, { properties: { name: 'Ring Road' } }, { properties: {} },
    ];
    it('matches road names loosely but prefers exact keys', () => {
        expect(RW.normRoad('M.G. Rd')).toBe('mgroad');
        expect(RW.matchRoads(feats, 'mg road')).toEqual([0, 1]);
        expect(RW.matchRoads(feats, 'AB Rd')).toEqual([2]);
        expect(RW.matchRoads(feats, 'ring')).toEqual([3]);
        expect(RW.matchRoads(feats, 'xy')).toEqual([]);
    });
    it('summarises busier and quieter roads once per name', () => {
        const res = { roads: [
            { f: 0, base: 0.5, scen: 1.2, delta: 0.7 }, { f: 1, base: 0.4, scen: 0.9, delta: 0.5 },
            { f: 2, base: 1.1, scen: 0.6, delta: -0.5 }, { f: 3, base: 0.5, scen: 0.55, delta: 0.05 },
            { f: -1, base: 0, scen: 0.8, delta: 0.8 }, { f: 4, base: 0.9, scen: null, delta: null, closed: true },
        ] };
        const t = RW.topRoads(res, f => (f === 1 ? 'M.G. Road' : feats[f].properties.name));
        expect(t.worse.map(x => x.name)).toEqual(['M.G. Road']);
        expect(t.better.map(x => x.name)).toEqual(['AB Road']);
        const txt = RW.askText({ ok: true, action: 'close', road: 'AB Road', matched: 2, period: 'pm', headline: 'H.', result: { newlyJammed: 3 }, ...t });
        expect(txt).toMatch(/^Closing AB Road \(2 segments\), 18:00 peak: H\. 3 roads tip into LOS E\/F\./);
        expect(txt).toMatch(/Busier: M\.G\. Road \(V\/C 0\.50 → 1\.20\)/);
        expect(RW.askText({ ok: false, error: 'nope' })).toBe('nope');
    });
    it('monsoon levels slow or close waterlogging-prone roads', () => {
        const fs = [
            { properties: { wlog: 80, fl100: 0 } },     // very high somewhere
            { properties: { wlog: 62, fl100: 0 } },
            { properties: { wlog: 30, fl100: 1 } },     // river floodplain only
            { properties: { wlog: 57 } },
            { properties: { wlog: 20 } },
        ];
        expect(RW.monsoonEdits(fs, 'heavy')).toEqual({ closed: [], slowed: { 0: 0.5, 1: 0.75 } });
        expect(RW.monsoonEdits(fs, 'severe')).toEqual({ closed: [0], slowed: { 1: 0.5, 3: 0.75 } });
        expect(RW.monsoonEdits(fs, 'extreme')).toEqual({ closed: [0], slowed: { 1: 0.5, 2: 0.25, 3: 0.75 } });
        expect(RW.fmtVC(26.7)).toBe('3+');
        expect(RW.fmtVC(0.5)).toBe('0.50');
        // A slowed road (capacity × 0.3) gets busier relative to capacity and pushes traffic to the detour.
        const m = model();
        const base = C.run(m, 'am', {});
        const slow = C.run(m, 'am', { widened: { 0: 0.3 } }, base.base).result;
        expect(slow.roads.find(r => r.f === 1).delta).toBeGreaterThan(0);
        expect(slow.vehHours.delta).toBeGreaterThan(0);
        const txt = RW.askText({ ok: true, monsoon: 'severe', label: 'Severe waterlogging', closedN: 3, slowedN: 7, period: 'am', headline: 'H.', worse: [], better: [], result: {} });
        expect(txt).toMatch(/^Severe waterlogging: 3 waterlogging-prone road segments closed and 7 slowed, 09:00 peak: H\./);
    });
});
