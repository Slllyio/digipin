import { describe, it, expect } from 'vitest';

const G = globalThis.GltfExport;
const lat0 = 22.72, lng0 = 75.86;
const mLat = 111320, mLng = 111320 * Math.cos(lat0 * Math.PI / 180);
const box = (x0, y0, x1, y1) => {
    const p = (x, y) => [lng0 + x / mLng, lat0 + y / mLat];
    return [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)];
};
const origin = { lat: lat0, lng: lng0 };

function triArea(pts, t) {
    const [a, b, c] = t.map(i => pts[i]);
    return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

describe('GltfExport.triangulate()', () => {
    it('splits a square into two triangles covering its area', () => {
        const sq = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
        const t = G.triangulate(sq);
        expect(t).toHaveLength(2);
        expect(t.reduce((s, x) => s + triArea(sq.slice(0, 4), x), 0)).toBeCloseTo(100, 6);
    });
    it('handles a concave L-shape (area preserved, all triangles CCW)', () => {
        const L = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
        const t = G.triangulate(L);
        expect(t).toHaveLength(4);
        expect(t.every(x => triArea(L, x) > 0)).toBe(true);
        expect(t.reduce((s, x) => s + triArea(L, x), 0)).toBeCloseTo(300, 6);
    });
    it('accepts clockwise input and rejects degenerate rings', () => {
        expect(G.triangulate([[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]])).toHaveLength(2);
        expect(G.triangulate([[0, 0], [5, 5], [10, 10], [0, 0]])).toEqual([]);
    });
});

describe('GltfExport.buildMesh()', () => {
    it('extrudes a box: 4 walls + roof, flat normals, correct height', () => {
        const m = G.buildMesh([{ polygon: box(0, 0, 10, 20), height: 12 }], origin);
        expect(m.count).toBe(1);
        expect(m.positions.length / 3).toBe(4 * 4 + 4);          // 16 wall verts + 4 roof verts
        expect(m.indices.length).toBe(4 * 6 + 2 * 3);            // 24 wall + 6 roof
        const ys = [];
        for (let i = 1; i < m.positions.length; i += 3) ys.push(m.positions[i]);
        expect(Math.max(...ys)).toBeCloseTo(12, 4);
        expect(Math.min(...ys)).toBeCloseTo(0, 6);
        // roof normals point up
        const roofN = [];
        for (let i = 16; i < 20; i++) roofN.push(m.normals[i * 3 + 1]);
        expect(roofN.every(n => n === 1)).toBe(true);
        // wall normals are horizontal unit vectors
        for (let i = 0; i < 16; i++) {
            const [x, y, z] = [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]];
            expect(y).toBe(0);
            expect(Math.hypot(x, z)).toBeCloseTo(1, 5);
        }
    });
    it('every triangle winds counter-clockwise around its stored normal', () => {
        const m = G.buildMesh([{ polygon: box(0, 0, 10, 20), height: 12 }, { polygon: [[lng0, lat0], [lng0 + 20 / mLng, lat0], [lng0 + 20 / mLng, lat0 + 10 / mLat], [lng0 + 10 / mLng, lat0 + 10 / mLat], [lng0 + 10 / mLng, lat0 + 20 / mLat], [lng0, lat0 + 20 / mLat], [lng0, lat0]], height: 9 }], origin);
        const P = (i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
        for (let t = 0; t < m.indices.length; t += 3) {
            const [a, b, c] = [P(m.indices[t]), P(m.indices[t + 1]), P(m.indices[t + 2])];
            const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            const s = m.normals.slice(m.indices[t] * 3, m.indices[t] * 3 + 3);
            expect(n[0] * s[0] + n[1] * s[1] + n[2] * s[2]).toBeGreaterThan(0);
        }
    });
    it('wall normals face away from the building', () => {
        const m = G.buildMesh([{ polygon: box(-5, -5, 5, 5), height: 3 }], origin);
        for (let i = 0; i < 16; i++) {
            const dot = m.positions[i * 3] * m.normals[i * 3] + m.positions[i * 3 + 2] * m.normals[i * 3 + 2];
            expect(dot).toBeGreaterThan(0);                      // vertex lies on the outward side of the centre
        }
    });
    it('puts north at −Z', () => {
        const m = G.buildMesh([{ polygon: box(0, 100, 10, 110), height: 5 }], origin);
        const zs = []; for (let i = 2; i < m.positions.length; i += 3) zs.push(m.positions[i]);
        expect(Math.max(...zs)).toBeLessThan(-99);
    });
    it('skips buildings with no height or no area', () => {
        const m = G.buildMesh([{ polygon: box(0, 0, 10, 10), height: 0 }, { polygon: [[0, 0], [1, 1]], height: 5 }], origin);
        expect(m.count).toBe(0);
        expect(m.positions.length).toBe(0);
    });
});

describe('GltfExport.buildGLB()', () => {
    const mesh = G.buildMesh([{ polygon: box(0, 0, 10, 20), height: 12 }], origin);
    const glb = G.buildGLB(mesh, { name: 'T', code: 'ABC' });
    const dv = new DataView(glb);

    it('writes a valid GLB header and chunk layout', () => {
        expect(dv.getUint32(0, true)).toBe(0x46546C67);
        expect(dv.getUint32(4, true)).toBe(2);
        expect(dv.getUint32(8, true)).toBe(glb.byteLength);
        expect(glb.byteLength % 4).toBe(0);
        const jsonLen = dv.getUint32(12, true);
        expect(dv.getUint32(16, true)).toBe(0x4E4F534A);
        expect(jsonLen % 4).toBe(0);
        const binHead = 20 + jsonLen;
        expect(dv.getUint32(binHead + 4, true)).toBe(0x004E4942);
        expect(12 + 8 + jsonLen + 8 + dv.getUint32(binHead, true)).toBe(glb.byteLength);
    });
    it('JSON describes accessors that match the buffers', () => {
        const jsonLen = dv.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen)));
        expect(json.asset.version).toBe('2.0');
        expect(json.asset.extras.code).toBe('ABC');
        expect(json.accessors[0].count).toBe(mesh.positions.length / 3);
        expect(json.accessors[0].max[1]).toBeCloseTo(12, 4);
        expect(json.accessors[2].count).toBe(mesh.indices.length);
        const bv = json.bufferViews;
        expect(bv[0].byteLength + bv[1].byteLength + bv[2].byteLength).toBe(json.buffers[0].byteLength);
        // binary payload round-trips the first position
        const binStart = 20 + jsonLen + 8;
        expect(new DataView(glb).getFloat32(binStart, true)).toBeCloseTo(mesh.positions[0], 6);
    });
    it('is valid for an empty scene too', () => {
        const empty = G.buildGLB(G.buildMesh([], origin));
        expect(new DataView(empty).getUint32(0, true)).toBe(0x46546C67);
    });
});

describe('GltfExport.filename()', () => {
    it('strips dashes from the code', () => {
        expect(G.filename('4P3-JK8-39LM')).toBe('digipin_buildings_4P3JK839LM.glb');
    });
});
