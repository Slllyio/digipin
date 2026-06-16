import { describe, it, expect, afterEach } from 'vitest';

// DigitalTwinLayers + Theme are exposed on globalThis by tests/setup.js.
// paintFor() picks the Aino paper-theme paint variant when the light theme is
// active; the building/green layers carry that variant.
const DTL = globalThis.DigitalTwinLayers;

afterEach(() => { Theme.set('dark'); });

describe('DigitalTwinLayers paper-theme paints', () => {
    it('the 3D + 2D buildings, greens and POIs ship a light variant', () => {
        for (const key of ['google_buildings', 'google_buildings_flat', 'osm_green_spaces', 'overture_landuse', 'overture_places']) {
            expect(DTL.LAYER_DEFS[key].paintLight, `${key} needs paintLight`).toBeTruthy();
        }
    });

    it('places get a warm-ink stroke on paper (white stroke vanishes on Positron)', () => {
        const places = DTL.LAYER_DEFS.overture_places;
        expect(places.paint['circle-stroke-color']).toBe('#ffffff');
        expect(places.paintLight['circle-stroke-color']).toContain('40,44,48');
    });

    it('paintFor() returns the neon default under dark', () => {
        Theme.set('dark');
        const b = DTL.LAYER_DEFS.google_buildings;
        expect(DTL.paintFor(b)).toBe(b.paint);
    });

    it('paintFor() returns the paper variant under light', () => {
        Theme.set('light');
        const b = DTL.LAYER_DEFS.google_buildings;
        expect(DTL.paintFor(b)).toBe(b.paintLight);
        // pale warm extrusion, not the neon confidence ramp
        expect(JSON.stringify(b.paintLight)).toContain('vertical-gradient');
        expect(JSON.stringify(b.paint)).not.toContain('#efeae2');
    });

    it('falls back to default paint when a layer has no light variant', () => {
        Theme.set('light');
        const roads = DTL.LAYER_DEFS.overture_roads;
        expect(roads.paintLight).toBeUndefined();
        expect(DTL.paintFor(roads)).toBe(roads.paint);
    });

    it('green light variants are muted sage, not saturated green', () => {
        const green = DTL.LAYER_DEFS.osm_green_spaces;
        expect(green.paint['fill-color']).toBe('#22c55e');     // dark = vivid
        expect(green.paintLight['fill-color']).toBe('#bcd3a6'); // light = sage
    });
});
