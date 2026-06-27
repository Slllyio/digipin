import { describe, it, expect, afterEach, beforeEach } from 'vitest';

// OvertureBuildings + Theme are exposed on globalThis by tests/setup.js.
// The Overture footprints overlay renders the white architectural massing
// model under the light theme and a grounded Esri-style translucent cyan-glass
// "digital twin" (with glowing footprint edges) under dark. We drive toggle()
// with a stub MapLibre map and capture the paint chosen for the building layer
// + whether the directional "sun" light / glowing edges are used.
const OB = globalThis.OvertureBuildings;

const LAYER_ID = 'overture-buildings-layer';
const EDGE_LAYER_ID = 'overture-edges-layer';

// Minimal MapLibre stub: records addLayer paints, layer visibility and any
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

describe('OvertureBuildings paper-theme rendering', () => {
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
        // Glowing edges stay hidden — the light model is a clean white solid
        expect(map._visibility[EDGE_LAYER_ID]).toBe('none');
    });

    it('under dark theme grounds a translucent cyan-glass twin with glowing edges', () => {
        Theme.set('dark');
        const map = makeStubMap();
        OB.toggle(map);

        const paint = map._layers[LAYER_ID].paint;
        // Grounded: base is min_height (no +100 float offset), height un-offset
        expect(JSON.stringify(paint['fill-extrusion-base'])).not.toContain('100');
        expect(JSON.stringify(paint['fill-extrusion-height'])).not.toContain('100');
        // Translucent cyan glass: a height colour ramp + vertical gradient glow
        expect(JSON.stringify(paint['fill-extrusion-color'])).toContain('#5cf0ff');
        expect(paint['fill-extrusion-vertical-gradient']).toBe(true);
        expect(paint['fill-extrusion-opacity']).toBeLessThan(1);
        // No directional light override (gradient supplies the shading);
        // the glowing footprint-edge layer is shown
        expect(map._calls.setLight).toBeNull();
        expect(map._layers[EDGE_LAYER_ID].type).toBe('line');
        expect(map._visibility[EDGE_LAYER_ID]).toBe('visible');
    });
});

describe('OvertureBuildings focus (range rings + amber highlight)', () => {
    const CENTER = { lat: 22.7196, lng: 75.8577 };

    it('ringsGeoJSON builds one closed circle per radius at the right distance', () => {
        const fc = OB.ringsGeoJSON(CENTER, [150, 300]);
        expect(fc.features).toHaveLength(2);
        for (const f of fc.features) {
            const ring = f.geometry.coordinates;
            expect(ring[0]).toEqual(ring[ring.length - 1]);   // closed
            // a point on the ring sits ~`radius` metres from the centre
            const [lng, lat] = ring[0];
            const dLat = (lat - CENTER.lat) * 111320;
            const dLng = (lng - CENTER.lng) * 111320 * Math.cos(CENTER.lat * Math.PI / 180);
            const dist = Math.hypot(dLat, dLng);
            expect(Math.abs(dist - f.properties.radius)).toBeLessThan(f.properties.radius * 0.05);
        }
        expect(OB.ringsGeoJSON(null).features).toEqual([]);
    });

    it('nearbyHighlight keeps only buildings whose centroid is within the radius', () => {
        const near = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[
            [75.8578, 22.7197], [75.8579, 22.7197], [75.8579, 22.7198], [75.8578, 22.7198], [75.8578, 22.7197]
        ]] }, properties: { class: 'commercial' } };
        const far = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[
            [75.95, 22.80], [75.951, 22.80], [75.951, 22.801], [75.95, 22.801], [75.95, 22.80]
        ]] }, properties: {} };
        const fc = OB.nearbyHighlight([near, far, near], CENTER, 220);
        expect(fc.features).toHaveLength(1);                  // far dropped, dup de-duped
        expect(fc.features[0].properties.class).toBe('commercial');
        expect(OB.nearbyHighlight([near], null).features).toEqual([]);
    });

    it('focusCell draws rings + highlight only while the dark overlay is active', () => {
        Theme.set('dark');
        const map = makeStubMap();
        OB.toggle(map);                       // overlay on (dark)
        OB.focusCell(CENTER);
        expect(map._visibility['overture-rings-layer']).toBe('visible');
        OB.toggle(map);                       // overlay off → focus cleared
        expect(map._visibility['overture-rings-layer']).toBe('none');
        expect(map._visibility['overture-highlight-layer']).toBe('none');
    });
});
