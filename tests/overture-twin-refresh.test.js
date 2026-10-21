import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// The light-theme "twin" renderer harvests the footprints MapLibre has
// rendered and redraws them as its own extrusion source. Footprint tiles keep
// streaming in after a fly-to lands, so the twin polls while tiles arrive.
// On a slow tile link (CI's software renderer: 4 of 6 cities drew nothing
// within 30 s of the fly-to) the old poll gave up after three harvests and
// the city stayed empty until the next pan. These tests drive the stub map's
// 'sourcedata' / 'render' events by hand.
const OB = globalThis.OvertureBuildings;
const SOURCE_ID = 'overture-buildings-source';
const TWIN_SRC = 'overture-twin-source';

function square(i) {
    const x = 77 + i * 0.001, y = 28;
    return { geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.0005, y], [x + 0.0005, y + 0.0005], [x, y + 0.0005], [x, y]]] }, properties: { height: 10 } };
}

function makeStubMap() {
    const handlers = {};
    const twin = { setData: vi.fn() };
    const map = {
        rendered: [],
        loaded: false,
        twin,
        on: (ev, a, b) => { const h = typeof a === 'function' ? a : b; (handlers[ev] = handlers[ev] || []).push(h); },
        once: () => {},
        fire: (ev, e) => (handlers[ev] || []).forEach((h) => h(e)),
        getSource: (id) => (id === TWIN_SRC ? twin : undefined),
        addSource: () => {},
        addLayer: () => {},
        getLayer: () => undefined,
        setLayoutProperty: () => {},
        setPaintProperty: () => {},
        setLight: () => {},
        getCanvas: () => ({ style: {} }),
        queryRenderedFeatures: vi.fn(() => map.rendered),
        isSourceLoaded: () => map.loaded,
        getCenter: () => ({ lng: 77.2, lat: 28.6 }),
        getZoom: () => 13,
        getBearing: () => 0,
        getPitch: () => 60,
    };
    return map;
}

// One twin poll step: a tile lands, `ms` pass, a frame renders, the deferred harvest runs.
function tileThenFrame(map, ms = 6001) {
    map.fire('sourcedata', { sourceId: SOURCE_ID, tile: {} });
    vi.advanceTimersByTime(ms);
    map.fire('render');
    vi.advanceTimersByTime(400);
}

// The twin binds its map listeners once per page, so every test drives the
// same stub map (toggled off between tests, on again at the start of each).
const map = makeStubMap();
let clock = Date.now();
beforeEach(() => {
    vi.useFakeTimers();
    clock += 600_000;                  // each test starts well after the previous test's last harvest (the 6 s spacing is wall-clock)
    vi.setSystemTime(clock);
    globalThis.maplibregl = { Popup: class { setLngLat() { return this; } setHTML() { return this; } addTo() { return this; } remove() {} } };
    Theme.set('light');   // light → twin renderer
    map.rendered = [];
    map.loaded = false;
    map.twin.setData.mockClear();
    map.queryRenderedFeatures.mockClear();
});
afterEach(() => {
    if (OB.isActive()) { try { OB.toggle(map); } catch { /* ignore */ } }
    Theme.set('dark');
    vi.useRealTimers();
});

describe('twin re-harvest while footprint tiles stream in', () => {
    it('keeps harvesting past three tile batches and redraws each time the footprints change', async () => {
        OB.toggle(map);
        await vi.runOnlyPendingTimersAsync();   // ensureHeights().then(refresh)
        const base = map.twin.setData.mock.calls.length;
        for (let i = 1; i <= 6; i++) {
            map.rendered = Array.from({ length: i }, (_, k) => square(k));
            tileThenFrame(map);
        }
        // Six batches, six draws: the old cap of three left batches 4-6 undrawn.
        expect(map.twin.setData.mock.calls.length - base).toBe(6);
        const last = map.twin.setData.mock.calls.at(-1)[0];
        expect(last.features.length).toBe(6);
    });

    it('skips the redraw when a poll finds the same footprints, and spaces polls 6 s apart', async () => {
        OB.toggle(map);
        await vi.runOnlyPendingTimersAsync();
        map.rendered = [square(0), square(1)];
        tileThenFrame(map);
        const after = map.twin.setData.mock.calls.length;
        const queries = map.queryRenderedFeatures.mock.calls.length;
        // Same footprints, next batch: queried, not redrawn (a setData restarts the GeoJSON tiling).
        tileThenFrame(map);
        expect(map.queryRenderedFeatures.mock.calls.length).toBe(queries + 1);
        expect(map.twin.setData.mock.calls.length).toBe(after);
        // A tile 2 s after the last harvest waits for the 6 s spacing.
        tileThenFrame(map, 2000);
        expect(map.queryRenderedFeatures.mock.calls.length).toBe(queries + 1);
    });

    it('draws once more, unconditionally, when the source reports fully loaded', async () => {
        OB.toggle(map);
        await vi.runOnlyPendingTimersAsync();
        map.rendered = [square(0)];
        tileThenFrame(map);
        const after = map.twin.setData.mock.calls.length;
        map.loaded = true;
        tileThenFrame(map, 100);   // loaded: no spacing, and the draw is not skipped as unchanged
        expect(map.twin.setData.mock.calls.length).toBe(after + 1);
    });
});
