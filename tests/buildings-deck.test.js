import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// DeckBuildings is exposed on globalThis by tests/setup.js. deck.gl itself is
// absent under jsdom, so available() is false and the GL paths are inert — we
// test the pure data helpers that prep Overture geometry for the deck layer.
const DB = globalThis.DeckBuildings;

describe('DeckBuildings.featureHeight', () => {
    it('prefers explicit height, then floors, then class fallbacks', () => {
        expect(DB.featureHeight({ height: 80 })).toBe(80);
        expect(DB.featureHeight({ height: 1 })).toBe(3);        // floored at 3m
        expect(DB.featureHeight({ num_floors: 10 })).toBeCloseTo(36);
        expect(DB.featureHeight({ class: 'commercial' })).toBe(35);
        expect(DB.featureHeight({})).toBe(12);                  // default
    });
});

describe('DeckBuildings.estimateHeight', () => {
    it('uses real height/floors when present', () => {
        expect(DB.estimateHeight({ height: 90 }, 5000, 'a')).toBe(90);
        expect(DB.estimateHeight({ num_floors: 20 }, 5000, 'a')).toBeCloseTo(72);
    });
    it('estimates from footprint area when no height data (bigger plot → taller)', () => {
        const small = DB.estimateHeight({}, 120, 'k1');
        const big = DB.estimateHeight({}, 8000, 'k1');   // same seed isolates the area effect
        expect(big).toBeGreaterThan(small);
        expect(small).toBeGreaterThanOrEqual(6);          // floored
        expect(big).toBeLessThanOrEqual(150);             // capped
    });
    it('is deterministic per seed but varies between buildings', () => {
        expect(DB.estimateHeight({}, 1000, 'x')).toBe(DB.estimateHeight({}, 1000, 'x'));
        expect(DB.estimateHeight({}, 1000, 'x')).not.toBe(DB.estimateHeight({}, 1000, 'y'));
    });
});

describe('DeckBuildings.featuresToPolygons', () => {
    const at = (lng, lat) => ({
        type: 'Feature',
        properties: { height: 50 },
        geometry: { type: 'Polygon', coordinates: [[
            [lng, lat], [lng + 0.0001, lat], [lng + 0.0001, lat + 0.0001], [lng, lat + 0.0001], [lng, lat]
        ]] }
    });
    const focus = { lat: 22.7196, lng: 75.8577 };

    it('extracts outer ring + height and de-dupes by centroid', () => {
        const near = at(75.8577, 22.7196);
        const recs = DB.featuresToPolygons([near, near], focus, 220);
        expect(recs).toHaveLength(1);                           // duplicate collapsed
        expect(recs[0].height).toBe(50);
        expect(Array.isArray(recs[0].polygon)).toBe(true);
        expect(recs[0].sel).toBe(true);                        // within focus radius
    });

    it('tags only buildings within the focus radius as selected', () => {
        const far = at(75.95, 22.80);
        const recs = DB.featuresToPolygons([far], focus, 220);
        expect(recs[0].sel).toBe(false);
        // no focus → nothing selected
        expect(DB.featuresToPolygons([far], null)[0].sel).toBe(false);
    });

    it('uses the baked DIGIPIN-cell height (jittered ±15%) over the area estimate', () => {
        const f = {
            type: 'Feature',
            properties: { id: 'bldg-123' },   // no height/floors → would normally be estimated
            geometry: { type: 'Polygon', coordinates: [[
                [75.8577, 22.7196], [75.8578, 22.7196], [75.8578, 22.7197], [75.8577, 22.7197], [75.8577, 22.7196]
            ]] }
        };
        const code = DigiPin.encode(22.71965, 75.85775).replace(/-/g, '').slice(0, 8);
        const grid = DB.mergeHeightGrid(null, { level: 8, cells: { [code]: 80 } });
        const h = DB.featuresToPolygons([f], null, 220, grid)[0].height;
        expect(h).toBeGreaterThanOrEqual(80 * 0.85);
        expect(h).toBeLessThanOrEqual(80 * 1.15);
        // cell not in the grid → falls back to the estimate
        const est = DB.featuresToPolygons([f], null, 220, DB.mergeHeightGrid(null, { level: 8, cells: {} }))[0].height;
        expect(est).toBeGreaterThan(0);
        expect(est).toBeLessThan(80 * 0.85);
    });

    it("keeps Overture's own height over the baked cell height", () => {
        const f = at(75.8577, 22.7196);   // properties.height = 50
        const code = DigiPin.encode(22.71965, 75.85775).replace(/-/g, '').slice(0, 8);
        const grid = DB.mergeHeightGrid(null, { level: 8, cells: { [code]: 80 } });
        expect(DB.featuresToPolygons([f], null, 220, grid)[0].height).toBe(50);
    });

    it('handles MultiPolygon and skips degenerate rings', () => {
        const multi = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [
            [[[75.8, 22.7], [75.8001, 22.7], [75.8001, 22.7001], [75.8, 22.7001], [75.8, 22.7]]],
            [[[75.81, 22.71], [75.81, 22.71]]]   // degenerate (<4 pts) → dropped
        ] } };
        expect(DB.featuresToPolygons([multi], null)).toHaveLength(1);
        expect(DB.featuresToPolygons([], null)).toEqual([]);
    });
});

describe('DeckBuildings height grid', () => {
    it('merges grid files and looks up the finest level first', () => {
        const pin = DigiPin.encode(22.7196, 75.8577).replace(/-/g, '');
        let g = DB.mergeHeightGrid(null, { level: 8, cells: { [pin.slice(0, 8)]: 6 } });
        expect(DB.cellHeight(g, 22.7196, 75.8577)).toBe(6);
        g = DB.mergeHeightGrid(g, { level: 9, cells: { [pin.slice(0, 9)]: 21 } });
        expect(g.levels).toEqual([9, 8]);
        expect(DB.cellHeight(g, 22.7196, 75.8577)).toBe(21);
    });
    it('returns null outside the grid, outside India, or with no grid', () => {
        const g = DB.mergeHeightGrid(null, { level: 8, cells: { XXXXXXXX: 6 } });
        expect(DB.cellHeight(g, 22.7196, 75.8577)).toBeNull();
        expect(DB.cellHeight(g, 51.5, -0.12)).toBeNull();
        expect(DB.cellHeight(null, 22.7196, 75.8577)).toBeNull();
        expect(DB.mergeHeightGrid(null, { cells: {} })).toBeNull();   // malformed file ignored
    });
    it('ships an Indore grid that covers central Indore with plausible heights', async () => {
        const { readFileSync } = await import('fs');
        const doc = JSON.parse(readFileSync('data/heights/indore_pilot_heights_digipin.json', 'utf-8'));
        const g = DB.mergeHeightGrid(null, doc);
        expect(g.cells.size).toBeGreaterThan(10000);
        const h = DB.cellHeight(g, 22.72, 75.86);   // a built block near the default view
        expect(h).toBeGreaterThan(0);
        expect(h).toBeLessThan(200);
    });
});

describe('DeckBuildings.gridsFor', () => {
    const index = [
        { region: 'a', bbox: [75.6, 22.5, 76.0, 22.9], file: 'a.json' },
        { region: 'b', bbox: [77.3, 23.18, 77.52, 23.32], file: 'b.json' },
    ];
    it('picks only the grid whose bbox holds the point', () => {
        expect(DB.gridsFor(index, { lat: 22.72, lng: 75.86 })).toEqual(['a.json']);
        expect(DB.gridsFor(index, { lat: 23.25, lng: 77.4 })).toEqual(['b.json']);
        expect(DB.gridsFor(index, { lat: 19.0, lng: 72.8 })).toEqual([]);
        expect(DB.gridsFor(null, { lat: 22.72, lng: 75.86 })).toEqual([]);
        expect(DB.gridsFor(index, null)).toEqual([]);
    });
    it('ships an index whose every entry points at a real grid file', async () => {
        const { readFileSync, existsSync } = await import('fs');
        const idx = JSON.parse(readFileSync('data/heights/index.json', 'utf-8'));
        expect(idx.length).toBeGreaterThan(0);
        for (const g of idx) {
            expect(existsSync(g.file)).toBe(true);
            expect(g.bbox).toHaveLength(4);
        }
    });
});

describe('DeckBuildings.ringPaths', () => {
    const center = { lat: 22.7196, lng: 75.8577 };
    it('builds one closed ring per radius at the right distance', () => {
        const rings = DB.ringPaths(center, [150, 300]);
        expect(rings).toHaveLength(2);
        for (const r of rings) {
            expect(r.path[0]).toEqual(r.path[r.path.length - 1]);   // closed
            const [lng, lat] = r.path[0];
            const dLat = (lat - center.lat) * 111320;
            const dLng = (lng - center.lng) * 111320 * Math.cos(center.lat * Math.PI / 180);
            expect(Math.abs(Math.hypot(dLat, dLng) - r.radius)).toBeLessThan(r.radius * 0.05);
        }
        expect(DB.ringPaths(null)).toEqual([]);
        // default radii (no second arg) match the 150/300/450 focus-ring contract
        expect(DB.ringPaths(center).map(r => r.radius)).toEqual([150, 300, 450]);
    });
});

describe('DeckBuildings.available', () => {
    it('is false without deck.gl loaded (jsdom) and the GL methods stay inert', () => {
        expect(DB.available()).toBe(false);
        expect(DB.enable({}, () => null)).toBe(false);
        expect(DB.isEnabled()).toBe(false);
    });
});

describe('DeckBuildings baked heights on a failing link', () => {
    const DS = globalThis.DataStatus;
    const okRes = (body) => ({ ok: true, status: 200, json: async () => body });
    const errRes = (status) => ({ ok: false, status, json: async () => { throw new Error('no body'); } });
    const grid = { level: 7, cells: { ABCDEFG: 12 } };
    let realFetch;
    beforeEach(() => { realFetch = globalThis.fetch; DS.reset(); DB.resetHeights(); });
    afterEach(() => { globalThis.fetch = realFetch; DS.reset(); });

    it('a stalled grid fetch times out, is reported as such, and Retry asks again', async () => {
        const signals = [];
        let stalled = true;
        globalThis.fetch = (url, opts) => {
            signals.push(opts && opts.signal);
            if (!stalled) return Promise.resolve(okRes(grid));
            // Simulate the link hanging until the per-fetch timeout aborts it.
            return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
        };
        expect(await DB.loadHeights('data/heights/stall.json')).toBe(false);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(DB.heightsCacheStats().failedReasons).toEqual({ 'data/heights/stall.json': 'timeout' });
        expect(DS.has('heights')).toBe(true);
        stalled = false;
        expect(await DB.retryHeights()).toBe(true);
        expect(DB.heightsCacheStats().failed).toBe(0);
        expect(DS.has('heights')).toBe(false);
    });

    it('a 5xx grid is reported with Retry and refetched; success clears the row', async () => {
        const calls = [];
        globalThis.fetch = async (url) => { calls.push(url); return calls.length === 1 ? errRes(503) : okRes(grid); };
        expect(await DB.loadHeights('data/heights/x.json')).toBe(false);
        expect(DB.heightsCacheStats().failed).toBe(1);
        expect(DS.has('heights')).toBe(true);
        expect(await DB.loadHeights('data/heights/x.json')).toBe(true);
        expect(DB.heightsCacheStats().failed).toBe(0);
        expect(DS.has('heights')).toBe(false);
        expect(calls.length).toBe(2);
    });

    it('a dropped connection is reported the same way', async () => {
        globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
        expect(await DB.loadHeights('data/heights/y.json')).toBe(false);
        expect(DB.heightsCacheStats().failed).toBe(1);
        expect(DS.has('heights')).toBe(true);
        globalThis.fetch = async () => okRes(grid);
        expect(await DB.loadHeights('data/heights/y.json')).toBe(true);
        expect(DS.has('heights')).toBe(false);
    });

    it('a 404 grid is "not baked", not a failure: no row, nothing to retry', async () => {
        globalThis.fetch = async () => errRes(404);
        expect(await DB.loadHeights('data/heights/z.json')).toBe(false);
        expect(DB.heightsCacheStats().failed).toBe(0);
        expect(DS.has('heights')).toBe(false);
    });

    it('retryHeights refetches every failed grid, not only the ones under the current view', async () => {
        // Two grids failed (the camera passed over both); the view now covers
        // only the second. Retry must clear both or the row would stay up.
        const index = [
            { region: 'a', bbox: [75, 22, 76, 23], file: 'data/heights/a.json' },
            { region: 'b', bbox: [77, 12, 78, 13], file: 'data/heights/b.json' },
        ];
        let failing = true;
        globalThis.fetch = async (url) => {
            if (String(url).endsWith('index.json')) return okRes(index);
            return failing ? errRes(503) : okRes(grid);
        };
        expect(await DB.ensureHeights({ lat: 22.5, lng: 75.5 })).toEqual([false]);
        expect(await DB.ensureHeights({ lat: 12.5, lng: 77.5 })).toEqual([false]);
        expect(DB.heightsCacheStats().failed).toBe(2);
        failing = false;
        expect(await DB.retryHeights()).toBe(true);
        expect(DB.heightsCacheStats().failed).toBe(0);
        expect(DS.has('heights')).toBe(false);
    });

    it('ensureHeights asks again for a grid that failed, not for one that loaded', async () => {
        const index = [{ region: 'r', bbox: [75, 22, 76, 23], file: 'data/heights/r.json' }];
        const calls = [];
        globalThis.fetch = async (url) => {
            calls.push(url);
            if (String(url).endsWith('index.json')) return okRes(index);
            return calls.filter(u => u === url).length === 1 ? errRes(502) : okRes(grid);
        };
        const pt = { lat: 22.7, lng: 75.8 };
        expect(await DB.ensureHeights(pt)).toEqual([false]);
        expect(DS.has('heights')).toBe(true);
        expect(await DB.ensureHeights(pt)).toEqual([true]);      // retried
        expect(DS.has('heights')).toBe(false);
        expect(await DB.ensureHeights(pt)).toEqual([true]);      // cached, no third fetch
        expect(calls.filter(u => u === 'data/heights/r.json').length).toBe(2);
    });
});

describe('DeckBuildings.polygonStats / renderStats', () => {
    it('counts polygons, vertices, selection and height sources for the draw-cost log', () => {
        const sq = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
        const data = [
            { polygon: sq, height: 10, sel: true, hsrc: 'overture' },
            { polygon: sq.concat([[0, 0]]), height: 12, sel: false, hsrc: 'baked' },
            { polygon: sq, height: 9, sel: false, hsrc: 'estimate' },
            { polygon: null, height: 9, sel: false, hsrc: 'weird' },
        ];
        expect(DB.polygonStats(data)).toEqual({ polygons: 4, vertices: 16, selected: 1, bySource: { overture: 1, baked: 1, estimate: 1 } });
        expect(DB.polygonStats([])).toEqual({ polygons: 0, vertices: 0, selected: 0, bySource: { overture: 0, baked: 0, estimate: 0 } });
    });
    it('reports zero cost while nothing has drawn (no deck.gl under jsdom)', () => {
        DB.resetRenderStats();
        const r = DB.renderStats();
        expect(r.mode).toBe('off');
        expect(r.enabled).toBe(false);
        expect(r.polygons).toBe(0);
        expect(r.refreshes).toBe(0);
        expect(r.maxRefreshMs).toBe(0);
    });
    it('records draws from the twin (MapLibre) path too, keeping the longest time', () => {
        DB.resetRenderStats();
        const sq = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
        DB.noteDraw('twin', [{ polygon: sq, height: 10, sel: false, hsrc: 'baked' }], 120.4);
        DB.noteDraw('twin', [{ polygon: sq, height: 10, sel: false, hsrc: 'baked' }, { polygon: sq, height: 8, sel: false, hsrc: 'estimate' }], 40);
        const r = DB.renderStats();
        expect(r.mode).toBe('twin');
        expect(r.refreshes).toBe(2);
        expect(r.polygons).toBe(2);
        expect(r.vertices).toBe(10);
        expect(r.lastRefreshMs).toBe(40);
        expect(r.maxRefreshMs).toBe(120);
        DB.resetRenderStats();
        expect(DB.renderStats().refreshes).toBe(0);
    });
});
