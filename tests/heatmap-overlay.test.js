/**
 * Regression: HeatmapOverlay.show() must survive clear() being called while a
 * live sampling batch is in flight (btn-3d toggled off mid-load). Before the
 * fix, clear() nulled the shared AbortController and the next
 * `_abortController.signal` read threw "Cannot read properties of null".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function fakeMap() {
    const sources = {};
    return {
        isStyleLoaded: () => true,
        once: () => {},
        getBounds: () => ({ getNorth: () => 22.8, getSouth: () => 22.7, getEast: () => 75.9, getWest: () => 75.8 }),
        getSource: id => sources[id],
        addSource: (id) => { sources[id] = { setData: vi.fn() }; },
        addLayer: () => {},
        getLayer: () => undefined,
        removeLayer: () => {},
        removeSource: (id) => { delete sources[id]; },
        getContainer: () => document.body,
    };
}

describe('HeatmapOverlay abort handling', () => {
    beforeAll(() => {
        globalThis.MapModule = { getMap: () => fakeMap() };
        globalThis.App = { showToast: vi.fn() };
        // DataFetcher / PrecomputedScores are real lexical globals from setup.js
        // (a globalThis assignment would be shadowed), so spy on them.
        vi.spyOn(PrecomputedScores, 'isEnabled').mockReturnValue(false);
        const src = fs.readFileSync(path.resolve('js/heatmap-overlay.js'), 'utf8');
        vm.runInThisContext(src + '\n;globalThis.HeatmapOverlay = HeatmapOverlay;', { filename: 'heatmap-overlay.js' });
    });

    afterAll(() => vi.restoreAllMocks());

    it('show() resolves cleanly when clear() runs mid-flight', async () => {
        const releases = [];
        vi.spyOn(DataFetcher, 'fetchAllFeatures').mockImplementation(() =>
            new Promise(res => { releases.push(() => res({ scores: { walk: { value: 50 } } })); }));
        const p = globalThis.HeatmapOverlay.show('walk');
        await new Promise(r => setTimeout(r, 0));   // let the first batch start
        globalThis.HeatmapOverlay.clear();          // user toggles the overlay off
        expect(releases.length).toBe(6);                // first batch was in flight
        releases.forEach(r => r());
        await expect(p).resolves.toBeUndefined();
        expect(globalThis.HeatmapOverlay.getActive()).toBeNull();
    });
});
