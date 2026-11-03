import { describe, it, expect } from 'vitest';

const N = globalThis.NightCity;

describe('NightCity', () => {
    it('ramps night strength below the horizon', () => {
        expect(N.strength(10)).toBe(0);
        expect(N.strength(0)).toBe(0);
        expect(N.strength(-4)).toBeCloseTo(0.5);
        expect(N.strength(-30)).toBe(1);
    });
    it('builds three different 32 px window tiles', () => {
        const tiles = [0, 1, 2].map(k => N.windowImage(k));
        for (const t of tiles) {
            expect(t.width).toBe(32);
            expect(t.data.length).toBe(32 * 32 * 4);
        }
        const lit = t => { let n = 0; for (let i = 0; i < t.data.length; i += 4) if (t.data[i] > 180) n++; return n; };
        expect(lit(tiles[0])).toBeLessThan(lit(tiles[2]));
        expect(Buffer.from(tiles[0].data).equals(Buffer.from(tiles[1].data))).toBe(false);
    });
    it('picks a pattern per building from a stable property', () => {
        const e = N.patternExpr();
        expect(e[0]).toBe('match');
        expect(JSON.stringify(e)).toMatch(/night-win-2/);
    });
});
