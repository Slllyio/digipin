/**
 * DIGIPIN as a multi-resolution index: levels 1–10, exact sizes, integer
 * addressing, parent/children/neighbours, bbox cover and zoom → level LOD.
 */
import { describe, it, expect } from 'vitest';

const D = globalThis.DigiPin;

describe('official vectors', () => {
    it('Dak Bhawan, New Delhi encodes to the India Post reference code', () => {
        expect(D.encode(28.622788, 77.213033)).toBe('39J-49L-L8T4');
    });
});

describe('cell sizes', () => {
    it('edge is exactly 36° / 4^L', () => {
        for (let L = 1; L <= 10; L++) expect(D.cellDegrees(L)).toBe(36 / 4 ** L);
    });

    it('L6 is ~978 m and L7 ~245 m (not 244 m at L6)', () => {
        expect(D.cellSize(6).approxM).toBe(978);
        expect(D.cellSize(7).approxM).toBe(245);
        expect(D.cellSize(8).approxM).toBe(61);
        expect(D.cellSize(10).mNS).toBeCloseTo(3.82, 1);
        expect(D.sizeLabel(4)).toBe('~15.7 km');
    });

    it('east-west edge shrinks with latitude', () => {
        expect(D.cellSize(7, 30).mEW).toBeLessThan(D.cellSize(7, 10).mEW);
    });
});

describe('validation', () => {
    it('accepts 1–10 symbols with or without dashes', () => {
        expect(D.isValid('3')).toBe(true);
        expect(D.isValid('39J-49L-L8T4')).toBe(true);
        expect(D.isValid('39j49l')).toBe(true);
        expect(D.normalize('39j-49l')).toBe('39J49L');
    });

    it('rejects bad symbols, empty and over-long codes', () => {
        expect(D.isValid('')).toBe(false);
        expect(D.isValid('ABC')).toBe(false);       // A, B not in the alphabet
        expect(D.isValid('39J49LL8T42')).toBe(false); // 11 symbols
        expect(D.isValid(null)).toBe(false);
        expect(() => D.normalize('0')).toThrow();
    });
});

describe('integer addressing', () => {
    it('toIndex / fromIndex round-trip at every level', () => {
        const full = D.encodeLevel(22.7196, 75.8577, 10);
        for (let L = 1; L <= 10; L++) {
            const c = full.slice(0, L);
            const { level, row, col } = D.toIndex(c);
            expect(level).toBe(L);
            expect(D.fromIndex(L, row, col)).toBe(c);
        }
    });

    it('cellBounds matches decodePartial and contains the point', () => {
        const pts = [[22.7196, 75.8577], [28.6139, 77.209], [8.5, 76.9], [34.1, 74.8]];
        for (const [lat, lng] of pts) {
            for (let L = 1; L <= 10; L++) {
                const c = D.encodeLevel(lat, lng, L);
                const a = D.cellBounds(c).bounds, b = D.decodePartial(c).bounds;
                expect(a.south).toBeCloseTo(b.south, 9);
                expect(a.west).toBeCloseTo(b.west, 9);
                expect(lat).toBeGreaterThanOrEqual(a.south);
                expect(lat).toBeLessThanOrEqual(a.north);
                expect(lng).toBeGreaterThanOrEqual(a.west);
                expect(lng).toBeLessThanOrEqual(a.east);
            }
        }
    });

    it('fromIndex returns null outside the grid', () => {
        expect(D.fromIndex(2, -1, 0)).toBeNull();
        expect(D.fromIndex(2, 0, 16)).toBeNull();
    });
});

describe('hierarchy', () => {
    const c7 = D.encodeLevel(22.7196, 75.8577, 7);

    it('parent is the prefix; ancestors list every level', () => {
        expect(D.parent(c7)).toBe(c7.slice(0, 6));
        expect(D.parent(c7, 4)).toBe(c7.slice(0, 4));
        expect(D.parent('3')).toBeNull();
        expect(D.ancestors(c7)).toHaveLength(7);
        expect(D.ancestors(c7)[0]).toBe(c7[0]);
    });

    it('16 children tile the parent exactly', () => {
        const kids = D.children(c7);
        expect(kids).toHaveLength(16);
        expect(new Set(kids).size).toBe(16);
        const pb = D.cellBounds(c7).bounds;
        let area = 0;
        for (const k of kids) {
            expect(D.parent(k)).toBe(c7);
            const b = D.cellBounds(k).bounds;
            expect(b.south).toBeGreaterThanOrEqual(pb.south - 1e-12);
            expect(b.north).toBeLessThanOrEqual(pb.north + 1e-12);
            area += (b.north - b.south) * (b.east - b.west);
        }
        expect(area).toBeCloseTo((pb.north - pb.south) * (pb.east - pb.west), 12);
        expect(D.children(D.encodeLevel(22.7, 75.8, 10))).toEqual([]);
    });

    it('descendants at a deeper level number 4^(ΔL)', () => {
        expect(D.descendants(c7.slice(0, 5), 7)).toHaveLength(256);
    });
});

describe('neighbours', () => {
    const c6 = D.encodeLevel(22.7196, 75.8577, 6);
    const here = D.cellBounds(c6);

    it('8 neighbours are same-level and touch the cell', () => {
        const n = D.neighbors(c6);
        expect(Object.keys(n)).toEqual(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
        const d = D.cellDegrees(6);
        for (const code of Object.values(n)) {
            expect(code).toHaveLength(6);
            const b = D.cellBounds(code);
            expect(Math.abs(b.lat - here.lat)).toBeLessThan(d * 1.01);
            expect(Math.abs(b.lng - here.lng)).toBeLessThan(d * 1.01);
        }
        expect(D.cellBounds(n.n).bounds.south).toBeCloseTo(here.bounds.north, 12);
        expect(D.cellBounds(n.e).bounds.west).toBeCloseTo(here.bounds.east, 12);
    });

    it('neighbours cross parent boundaries (not just siblings)', () => {
        // Walk east 20 cells: the parent prefix must change at least once.
        let c = c6;
        const parents = new Set();
        for (let i = 0; i < 20; i++) { c = D.neighbor(c, 'e'); parents.add(D.parent(c)); }
        expect(parents.size).toBeGreaterThan(1);
    });

    it('is null at the edge of the India grid', () => {
        const sw = D.fromIndex(3, 0, 0);
        expect(D.neighbor(sw, 's')).toBeNull();
        expect(D.neighbor(sw, 'w')).toBeNull();
        expect(D.neighbor(sw, 'n')).not.toBeNull();
    });

    it('disk(k) covers (2k+1)^2 cells', () => {
        expect(D.disk(c6, 1)).toHaveLength(9);
        expect(D.disk(c6, 2)).toHaveLength(25);
        expect(D.disk(c6, 1)).toContain(c6);
    });
});

describe('cover', () => {
    const bbox = { south: 22.65, north: 22.8, west: 75.78, east: 75.95 };

    it('returns every intersecting cell once, matching point encoding', () => {
        const cells = D.cover(bbox, 6);
        expect(new Set(cells).size).toBe(cells.length);
        // Every cell at the box corners is included.
        for (const [lat, lng] of [[22.651, 75.781], [22.799, 75.949], [22.7, 75.86]]) {
            expect(cells).toContain(D.encodeLevel(lat, lng, 6));
        }
        // And every cell intersects the box.
        for (const c of cells) {
            const b = D.cellBounds(c).bounds;
            expect(b.north).toBeGreaterThan(bbox.south);
            expect(b.south).toBeLessThan(bbox.north);
        }
    });

    it('null when over maxCells, [] outside India', () => {
        expect(D.cover(bbox, 8, 100)).toBeNull();
        expect(D.cover({ south: 40, north: 41, west: 70, east: 71 }, 4)).toEqual([]);
    });
});

describe('level of detail', () => {
    it('steps one level per two zoom levels', () => {
        expect(D.levelForZoom(13)).toBe(6);
        expect(D.levelForZoom(14)).toBe(6);
        expect(D.levelForZoom(15)).toBe(7);
        expect(D.levelForZoom(17)).toBe(8);
        expect(D.levelForZoom(2)).toBe(1);
        expect(D.levelForZoom(30)).toBe(10);
    });

    it('zoomForLevel is its inverse', () => {
        for (let L = 1; L <= 10; L++) expect(D.levelForZoom(D.zoomForLevel(L))).toBe(L);
    });

    it('getGridCells uses the zoom level, coarsening past maxCells', () => {
        const view = { south: 22.68, north: 22.76, west: 75.8, east: 75.92 };
        const cells = D.getGridCells(view, 13);
        expect(cells.length).toBeGreaterThan(0);
        expect(cells.every(c => c.level === 6)).toBe(true);
        expect(cells[0].code).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
        const capped = D.getGridCells(view, 17, { maxCells: 200 });
        expect(capped[0].level).toBeLessThan(8);
        expect(capped.length).toBeLessThanOrEqual(200);
    });
});
