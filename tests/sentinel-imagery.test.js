import { describe, it, expect } from 'vitest';

const SI = globalThis.SentinelImagery;

describe('SentinelImagery.searchBody()', () => {
    it('asks for clear Sentinel-2 L2A scenes covering the point, newest first', () => {
        const b = SI.searchBody(75.86, 22.72, new Date('2026-10-21T00:00:00Z'), 120, 20);
        expect(b.collections).toEqual(['sentinel-2-l2a']);
        expect(b.intersects).toEqual({ type: 'Point', coordinates: [75.86, 22.72] });
        expect(b.datetime).toBe('2026-06-23T00:00:00Z/2026-10-21T00:00:00Z');
        expect(b.query['eo:cloud_cover'].lt).toBe(20);
        expect(b.sortby[0]).toEqual({ field: 'datetime', direction: 'desc' });
    });
});

describe('SentinelImagery.pickScenes()', () => {
    it('sorts newest first and keeps one scene per day', () => {
        const f = (id, dt, cc) => ({ id, bbox: [1, 2, 3, 4], properties: { datetime: dt, 'eo:cloud_cover': cc } });
        const s = SI.pickScenes([
            f('a', '2026-10-10T05:27:31Z', 0.4), f('b', '2026-10-20T05:28:41Z', 0.06),
            f('c', '2026-10-20T05:28:44Z', 3), null, { id: 'x' },
        ]);
        expect(s.map(x => x.id)).toEqual(['b', 'a']);
        expect(s[0].date).toBe('2026-10-20');
        expect(SI.sceneLabel(s[0])).toBe('2026-10-20 · <1% cloud');
    });
});

describe('SentinelImagery.tileUrl()', () => {
    it('builds Planetary Computer tile URLs for each preset', () => {
        const u = SI.tileUrl('S2C_MSIL2A_X', 'true');
        expect(u).toContain('/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?collection=sentinel-2-l2a&item=S2C_MSIL2A_X&assets=visual');
        expect(SI.tileUrl('S', 'ndvi')).toContain('colormap_name=rdylgn');
        expect(SI.tileUrl('S', 'nir')).toContain('assets=B08&assets=B04&assets=B03');
        expect(SI.tileUrl('S', 'nope')).toContain('assets=visual');
    });
});
