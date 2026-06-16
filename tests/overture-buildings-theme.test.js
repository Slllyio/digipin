import { describe, it, expect, afterEach, beforeEach } from 'vitest';

// OvertureBuildings + Theme are exposed on globalThis by tests/setup.js.
// The Overture footprints overlay renders the Aino white architectural massing
// model under the light theme and the neon floating-hologram look under dark.
// We drive toggle() with a stub MapLibre map and capture the paint chosen for
// the building layer + whether the directional "sun" light / tethers are used.
const OB = globalThis.OvertureBuildings;

const LAYER_ID = 'overture-buildings-layer';
const TETHER_LAYER_ID = 'overture-tethers-layer';

// Minimal MapLibre stub: records addLayer paints, tether visibility and any
// setLight call so the per-theme styling can be asserted without a real GL map.
function makeStubMap() {
    const layers = {};      // id -> layer def passed to addLayer
    const visibility = {};  // id -> last visibility set
    const calls = { setLight: null };
    return {
        _layers: layers,
        _visibility: visibility,
        _calls: calls,
        getSource: () => undefined,
        addSource: () => {},
        addLayer: (def) => { layers[def.id] = def; },
        getLayer: (id) => layers[id],
        setLayoutProperty: (id, _prop, value) => { visibility[id] = value; },
        setLight: (opts) => { calls.setLight = opts; },
        on: () => {},
        getCanvas: () => ({ style: {} }),
    };
}

beforeEach(() => {
    // jsdom provides no maplibregl; toggle()'s Popup use is only hit on click.
    globalThis.maplibregl = { Popup: class { setLngLat() { return this; } setHTML() { return this; } addTo() { return this; } remove() {} } };
});

// toggle() flips internal _active state; reset to off after each test so the
// next toggle() turns the overlay on again from a known baseline.
afterEach(() => {
    if (OB.isActive()) {
        // best-effort: toggling again turns it off (needs a stub map)
        try { OB.toggle(makeStubMap()); } catch { /* ignore */ }
    }
    Theme.set('dark');
});

describe('OvertureBuildings Aino-theme rendering', () => {
    it('under light theme grounds the white massing model (no float, vertical gradient)', () => {
        Theme.set('light');
        const map = makeStubMap();
        OB.toggle(map);

        const paint = map._layers[LAYER_ID].paint;
        // Grounded: base is min_height (no +100 float offset)
        expect(JSON.stringify(paint['fill-extrusion-base'])).not.toContain('100');
        // Cool near-white volume + MapLibre vertical gradient shading
        expect(JSON.stringify(paint['fill-extrusion-color'])).toContain('#f3f5f7');
        expect(paint['fill-extrusion-vertical-gradient']).toBe(true);
        // A directional "sun" is set so the volumes read as a lit model
        expect(map._calls.setLight).toBeTruthy();
        expect(map._calls.setLight.anchor).toBe('map');
        // Holographic tethers stay hidden — nothing floats to tether
        expect(map._visibility[TETHER_LAYER_ID]).toBe('none');
    });

    it('under dark theme keeps the neon floating holograms + tethers', () => {
        Theme.set('dark');
        const map = makeStubMap();
        OB.toggle(map);

        const paint = map._layers[LAYER_ID].paint;
        // Floated 100m above ground for the hologram look
        expect(JSON.stringify(paint['fill-extrusion-base'])).toContain('100');
        // Vibrant neon class colours, no architectural vertical gradient
        expect(JSON.stringify(paint['fill-extrusion-color'])).toContain('#0085CA');
        expect(paint['fill-extrusion-vertical-gradient']).toBeUndefined();
        // No directional light override; tethers visible
        expect(map._calls.setLight).toBeNull();
        expect(map._visibility[TETHER_LAYER_ID]).toBe('visible');
    });
});
