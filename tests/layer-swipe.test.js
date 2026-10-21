import { describe, it, expect } from 'vitest';

const LS = globalThis.LayerSwipe;

const layers = [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill', source: 'carto' },
    { id: 'cell-layer-growth', type: 'fill', source: 'cell-src-growth' },
    { id: 'cell-layer-growth-line', type: 'line', source: 'cell-src-growth' },
    { id: 'heat-layer', type: 'raster', source: 'heat-src' },
    { id: 'ndvi-layer', type: 'raster', source: 'ndvi-src' },
];

describe('LayerSwipe.overlayGroups()', () => {
    it('groups visible overlays by source and leaves the basemap out', () => {
        const g = LS.overlayGroups(layers, id => (id === 'ndvi-layer' ? 'none' : 'visible'));
        expect(g.map(x => x.key)).toEqual(['cell-src-growth', 'heat-src']);
        expect(g[0].layerIds).toEqual(['cell-layer-growth', 'cell-layer-growth-line']);
        expect(g[1].label).toBe('Heat');
    });
});

describe('LayerSwipe.visibilityPlan()', () => {
    const g = LS.overlayGroups(layers);
    it('hides the right-only set on the left and the left-only set on the right', () => {
        const p = LS.visibilityPlan(g, 'heat-src', 'cell-src-growth');
        expect(p.hideLeft).toEqual(['cell-layer-growth', 'cell-layer-growth-line']);
        expect(p.hideRight).toEqual(['heat-layer']);
    });
    it('hides nothing when both sides pick the same or nothing', () => {
        expect(LS.visibilityPlan(g, 'heat-src', 'heat-src')).toEqual({ hideLeft: [], hideRight: [] });
        expect(LS.visibilityPlan(g, '', '')).toEqual({ hideLeft: [], hideRight: [] });
    });
});

describe('LayerSwipe divider maths', () => {
    it('clips the right map to the right of the divider and keeps it on screen', () => {
        expect(LS.clipInset(0.5)).toBe('inset(0 0 0 50.000%)');
        expect(LS.clampPosition(-1)).toBe(0.02);
        expect(LS.clampPosition(2)).toBe(0.98);
        expect(LS.clampPosition(NaN)).toBe(0.5);
    });
});
