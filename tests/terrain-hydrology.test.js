import { describe, it, expect } from 'vitest';

const TH = globalThis.TerrainHydrology;

describe('TerrainHydrology.tileRange()', () => {
    it('covers a small view with the tiles under it', () => {
        const r = TH.tileRange({ west: 75.85, south: 22.70, east: 75.87, north: 22.72 }, 13, 3);
        expect(r.nx).toBeGreaterThanOrEqual(1);
        expect(r.ny).toBeGreaterThanOrEqual(1);
        expect(r.z).toBe(13);
    });
    it('caps a wide view at max tiles per side around its centre', () => {
        const r = TH.tileRange({ west: 75.0, south: 22.0, east: 77.0, north: 23.5 }, 13, 3);
        expect(r.nx).toBe(3);
        expect(r.ny).toBe(3);
    });
});

describe('TerrainHydrology.decodeTerrarium()', () => {
    it('decodes R*256 + G + B/256 - 32768', () => {
        const rgba = new Uint8Array([130, 34, 128, 255, 128, 0, 0, 255]);
        const e = TH.decodeTerrarium(rgba);
        expect(e[0]).toBeCloseTo(130 * 256 + 34 + 0.5 - 32768, 5);
        expect(e[1]).toBe(0);
    });
});

describe('TerrainHydrology.mosaic()', () => {
    it('stitches tiles row-major and fills missing tiles with nodata', () => {
        const a = new Float32Array([1, 2, 3, 4]);
        const m = TH.mosaic([[a, null]], 2, 1, 2);
        expect(m.width).toBe(4);
        expect(m.height).toBe(2);
        expect([...m.data]).toEqual([1, 2, -32768, -32768, 3, 4, -32768, -32768]);
    });
});

describe('TerrainHydrology.writeGeoTiff()', () => {
    const data = new Float32Array([10, 20, 30, 40, 50, 60]);
    const bytes = TH.writeGeoTiff(data, 3, 2, { x0: 100, y0: 200, px: 5, epsg: 3857 });
    const dv = new DataView(bytes.buffer);
    const tags = {};
    for (let i = 0, n = dv.getUint16(8, true); i < n; i++) {
        const e = 10 + i * 12;
        tags[dv.getUint16(e, true)] = { type: dv.getUint16(e + 2, true), count: dv.getUint32(e + 4, true), v: dv.getUint32(e + 8, true) };
    }
    it('writes a little-endian classic TIFF header', () => {
        expect(String.fromCharCode(bytes[0], bytes[1])).toBe('II');
        expect(dv.getUint16(2, true)).toBe(42);
    });
    it('stores size, float32 samples and the pixel data at the strip offset', () => {
        expect(tags[256].v).toBe(3);
        expect(tags[257].v).toBe(2);
        expect(tags[339].v & 0xffff).toBe(3);
        expect(dv.getFloat32(tags[273].v + 4 * 4, true)).toBe(50);
        expect(tags[273].v % 4).toBe(0);
    });
    it('georeferences with pixel scale, tiepoint and the EPSG key', () => {
        expect(dv.getFloat64(tags[33550].v, true)).toBe(5);
        expect(dv.getFloat64(tags[33922].v + 3 * 8, true)).toBe(100);
        expect(dv.getFloat64(tags[33922].v + 4 * 8, true)).toBe(200);
        const keys = [];
        for (let i = 0; i < tags[34735].count; i++) keys.push(dv.getUint16(tags[34735].v + i * 2, true));
        expect(keys.slice(-4)).toEqual([3072, 0, 1, 3857]);
    });
});

describe('TerrainHydrology.toRecords()', () => {
    it('emits one located record per valid pixel and skips nodata', () => {
        const range = { x0: 5821, y0: 3606, z: 13 };
        const recs = TH.toRecords({ a: new Float32Array([1, -32768, NaN, 4]) }, 2, 2, range);
        expect(recs.length).toBe(2);
        expect(recs[0].a).toBe(1);
        expect(recs[1].a).toBe(4);
        expect(recs[0].lat).toBeGreaterThan(recs[1].lat);
        expect(recs[0].lng).toBeGreaterThan(75);
    });
    it('declares fields CellStore can bin', () => {
        TH.FIELDS.forEach(f => expect(['mean', 'max']).toContain(f.agg));
        expect(TH.WORKER_SRC).toContain('geolibre-wasm@1.7.1');
    });
});
