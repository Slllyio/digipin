import { describe, it, expect, afterEach } from 'vitest';

// Terrain + OvertureBuildings are exposed on globalThis by tests/setup.js.
const T = globalThis.Terrain;
const OB = globalThis.OvertureBuildings;

function stubMap() {
    const sources = {}, layers = {}, calls = { terrain: [], before: {} };
    return {
        _sources: sources, _layers: layers, _calls: calls,
        getSource: id => sources[id],
        addSource: (id, def) => { sources[id] = def; },
        getLayer: id => layers[id],
        addLayer: (def, before) => { layers[def.id] = def; calls.before[def.id] = before; },
        removeLayer: id => { delete layers[id]; },
        getStyle: () => ({ layers: [{ id: 'bg', type: 'background' }, { id: 'labels', type: 'symbol' }] }),
        setTerrain: t => { calls.terrain.push(t); },
    };
}

afterEach(() => { T.setEnabled(stubMap(), false); });

describe('Terrain', () => {
    it('drapes an AWS Terrarium DEM with a hillshade under the labels', () => {
        const map = stubMap();
        const events = [];
        const on = e => events.push(e.detail.enabled);
        window.addEventListener('terrain:change', on);
        expect(T.toggle(map)).toBe(true);
        window.removeEventListener('terrain:change', on);

        const dem = map._sources[T.SOURCE_ID];
        expect(dem.type).toBe('raster-dem');
        expect(dem.encoding).toBe('terrarium');
        expect(dem.tiles[0]).toContain('elevation-tiles-prod/terrarium');
        expect(map._layers[T.HILLSHADE_ID].type).toBe('hillshade');
        expect(map._layers[T.HILLSHADE_ID].source).not.toBe(T.SOURCE_ID);   // own DEM source
        expect(map._calls.before[T.HILLSHADE_ID]).toBe('labels');
        expect(map._calls.terrain.at(-1)).toEqual({ source: T.SOURCE_ID, exaggeration: T.DEFAULT_EXAGGERATION });
        expect(events).toEqual([true]);
    });

    it('turns off cleanly and is idempotent', () => {
        const map = stubMap();
        T.setEnabled(map, true);
        T.setEnabled(map, true);                       // no second attach
        expect(map._calls.terrain).toHaveLength(1);
        expect(T.setEnabled(map, false)).toBe(false);
        expect(map._calls.terrain.at(-1)).toBeNull();
        expect(map._layers[T.HILLSHADE_ID]).toBeUndefined();
        expect(T.isEnabled()).toBe(false);
    });

    it('waits for the camera to stop before draping (MapLibre 4.1 mid-ease bug)', () => {
        const map = stubMap();
        let moving = true, onMoveEnd = null;
        map.isMoving = () => moving;
        map.once = (ev, fn) => { if (ev === 'moveend') onMoveEnd = fn; };
        expect(T.setEnabled(map, true)).toBe(true);
        expect(map._calls.terrain).toHaveLength(0);        // not yet
        moving = false;
        onMoveEnd();
        expect(map._calls.terrain).toHaveLength(1);
        expect(map._layers[T.HILLSHADE_ID]).toBeTruthy();
    });

    it('updates exaggeration live and rejects bad values', () => {
        const map = stubMap();
        T.setEnabled(map, true);
        expect(T.setExaggeration(map, 3)).toBe(3);
        expect(map._calls.terrain.at(-1).exaggeration).toBe(3);
        expect(T.setExaggeration(map, -1)).toBe(3);
        T.setExaggeration(map, T.DEFAULT_EXAGGERATION);
    });
});

describe('OvertureBuildings renderer choice', () => {
    it('uses the MapLibre twin whenever terrain is on (deck.gl cannot follow the ground)', () => {
        expect(OB.chooseRenderer({ light: false, terrain: true, deckAvailable: true })).toBe('twin');
        expect(OB.chooseRenderer({ light: true, terrain: false, deckAvailable: true })).toBe('twin');
        expect(OB.chooseRenderer({ light: false, terrain: false, deckAvailable: true })).toBe('deck');
        expect(OB.chooseRenderer({ light: false, terrain: false, deckAvailable: false })).toBe('native');
    });

    it('turns deck polygon records into exaggerated GeoJSON extrusions', () => {
        const ring = [[75.85, 22.71], [75.851, 22.71], [75.851, 22.711], [75.85, 22.71]];
        const fc = OB.twinGeoJSON([{ polygon: ring, height: 10, sel: true }], 3);
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].properties).toEqual({ h: 30, sel: true, rh: 10 });
        expect(fc.features[0].geometry).toEqual({ type: 'Polygon', coordinates: [ring] });
        expect(OB.twinGeoJSON(null).features).toEqual([]);
    });

    it('colours the twin per theme with an amber selection', () => {
        expect(JSON.stringify(OB.twinPaint(true)['fill-extrusion-color'])).toContain('#fbfaf8');
        expect(JSON.stringify(OB.twinPaint(false)['fill-extrusion-color'])).toContain('#5cf0ff');
        expect(OB.twinPaint(false)['fill-extrusion-height']).toEqual(['get', 'h']);
    });
});
