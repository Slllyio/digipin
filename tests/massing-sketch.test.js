import { describe, it, expect } from 'vitest';

const M = globalThis.MassingSketch;
const U = globalThis.URLState;

// ~40 m × ~30 m block near Rajwada, Indore
const lng0 = 75.8553, lat0 = 22.7186;
const dx = 40 / (111320 * Math.cos(lat0 * Math.PI / 180)), dy = 30 / 110540;
const ring = [[lng0, lat0], [lng0 + dx, lat0], [lng0 + dx, lat0 + dy], [lng0, lat0 + dy], [lng0, lat0]];

describe('MassingSketch geometry', () => {
    it('measures a footprint in m² and its gross floor area', () => {
        expect(M.ringAreaM2(ring)).toBeCloseTo(1200, -1);
        expect(M.gfa(1200, 8)).toBe(9600);
        expect(M.gfa(1200, 0)).toBe(1200);
        expect(M.ringAreaM2([[0, 0], [1, 1]])).toBe(0);
    });
    it('closes rings and refuses fewer than three corners', () => {
        expect(M.closeRing(ring.slice(0, 4)).length).toBe(5);
        expect(M.closeRing(ring).length).toBe(5);
        expect(M.closeRing([[0, 0], [1, 1]])).toBe(null);
    });
    it('feature carries height, footprint and GFA', () => {
        const f = M.toFeature({ id: 'm1', name: 'Tower', floors: 10, use: 'commercial', ring });
        expect(f.properties).toMatchObject({ height_m: 32, footprint_m2: 1200, gfa_m2: 12000, use: 'commercial', proposed: true });
    });
});

describe('MassingSketch share payload', () => {
    it('round-trips through toParam/parseParam and drops junk', () => {
        const raw = M.toParam([{ name: 'A', floors: 12, use: 'residential', ring }]);
        const back = M.parseParam(raw);
        expect(back.length).toBe(1);
        expect(back[0]).toMatchObject({ name: 'A', floors: 12, use: 'residential' });
        expect(back[0].ring.length).toBe(5);
        expect(M.parseParam('not json')).toEqual([]);
        expect(M.parseParam(JSON.stringify([{ f: 0, r: ring }, { f: 5, r: [[1, 2]] }]))).toEqual([]);
        expect(M.parseParam(JSON.stringify([{ f: 5, u: 'casino', r: ring.slice(0, 4) }]))[0].use).toBe('mixed');
    });
    it('rides in the share link as ms=', () => {
        const qs = U.stringify({ massing: [{ name: 'A', floors: 6, use: 'mixed', ring }] });
        expect(qs).toMatch(/(^|&)ms=/);
        const st = U.parse('?' + qs);
        expect(st.massing.length).toBe(1);
        expect(st.massing[0].floors).toBe(6);
    });
});

describe('Clearing the site under a proposal', () => {
    it('keeps the clear switch through the share link (on by default)', () => {
        expect(M.parseParam(M.toParam([{ name: 'A', floors: 4, use: 'mixed', ring }]))[0].clear).toBe(true);
        expect(M.parseParam(M.toParam([{ name: 'A', floors: 4, use: 'mixed', clear: false, ring }]))[0].clear).toBe(false);
    });
    it('drops buildings whose centre is inside a ring', () => {
        const sq = (x, y, d) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
        const site = sq(0, 0, 10);
        const recs = [{ id: 'in', polygon: sq(2, 2, 2) }, { id: 'out', polygon: sq(20, 20, 2) }, { id: 'edge', polygon: sq(9, 9, 4) }];
        const kept = globalThis.OvertureBuildings.dropInside(recs, [site]).map(r => r.id);
        expect(kept).toEqual(['out', 'edge']);
        expect(globalThis.OvertureBuildings.dropInside(recs, [])).toBe(recs);
    });
});
