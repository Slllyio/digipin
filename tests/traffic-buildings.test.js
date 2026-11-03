import { describe, it, expect } from 'vitest';

const TB = globalThis.TrafficBuildings;
const T = globalThis.TrafficOverlay;

describe('TrafficBuildings', () => {
    it('neighbours: each source reaches itself and the 8 cells around it', () => {
        const codeAt = (lat, lng) => `${Math.round(lat * 10)},${Math.round(lng * 10)}`;
        const t = TB.neighbours([[0, 0], [0, 0.1]], 0.1, codeAt);
        const m = new Map(t);
        expect(m.size).toBe(12);                  // 3×3 and 3×3 overlapping in a 3×2 strip
        expect(m.get('0,0')).toEqual([[0, 1], [1, 0.75]]);
        expect(m.get('0,-1')).toEqual([[0, 0.75]]);
        expect(m.get('0,2')).toEqual([[1, 0.75]]);
    });

    it('tableFor: the worst nearby V/C at the hour; peak uses peak_vc', () => {
        const base = { am: [1.2, 0.2], pm: [0.3, 1.1], mid: [0.5, 0.5], peak: [1.2, 1.1],
            targets: [['A', [[0, 1]]], ['B', [[1, 1]]], ['C', [[0, 1], [1, 1]]], ['D', [[0, 0.75]]]] };
        const am = TB.tableFor(base, 9, T.vcAt);
        const pm = TB.tableFor(base, 18, T.vcAt);
        const i = (t, c) => t.columns.vc_now[t.cells.indexOf(c)];
        expect(i(am, 'A')).toBeGreaterThan(i(am, 'B'));       // morning: road 0 is the busy one
        expect(i(pm, 'B')).toBeGreaterThan(i(pm, 'A'));       // evening: road 1
        expect(i(am, 'C')).toBe(Math.max(i(am, 'A'), i(am, 'B')));
        const pk = TB.tableFor(base, null, T.vcAt);
        expect(i(pk, 'A')).toBe(1.2);
        expect(i(pk, 'D')).toBe(0.9);                         // next door: 3/4
        expect(TB.spec(18, '18:00').fields[0].label).toMatch(/18:00/);
        expect(am.level).toBe(7);
    });

    it('TrafficOverlay.onHour notifies on clock moves and unsubscribes', () => {
        const seen = [];
        const off = T.onHour(h => seen.push(h));
        T.setHour(18);
        T.setHour(null);
        off();
        T.setHour(9);
        expect(seen).toEqual([18, null]);
        expect(T.config().share_pct.length).toBe(24);
    });
});
