import { describe, it, expect } from 'vitest';

const V = globalThis.ViewHandoff;
const C = globalThis.CameraPresets;
const B = globalThis.BuildingData;
const O = globalThis.OvertureBuildings;

describe('ViewHandoff.autoColorKey', () => {
    const st = { lst_monthly: { field: 'lst_day_c' }, ndvi: { field: 'ndvi' } };
    const of = id => st[id] || null;
    it('takes the top (last) active cell layer when buildings are uncoloured', () => {
        expect(V.autoColorKey(['ndvi', 'lst_monthly'], of, null, null)).toBe('lst_monthly:lst_day_c');
    });
    it('leaves a colour the user chose alone, but follows its own earlier pick', () => {
        expect(V.autoColorKey(['ndvi'], of, 'bldg:height_m', null)).toBe(null);
        expect(V.autoColorKey(['ndvi'], of, 'lst_monthly:lst_day_c', 'lst_monthly:lst_day_c')).toBe('ndvi:ndvi');
    });
    it('is null with no cell layers', () => {
        expect(V.autoColorKey([], of, null, null)).toBe(null);
    });
});

describe('ViewHandoff.pivotFor', () => {
    const view = { south: 22.70, north: 22.73, west: 75.84, east: 75.87 };
    it('pivots on an on-screen cell centre and ignores an off-screen one', () => {
        const c = V.pivotFor({ south: 22.71, north: 22.72, west: 75.85, east: 75.86 }, view);
        expect(c[0]).toBeCloseTo(75.855, 9);
        expect(c[1]).toBeCloseTo(22.715, 9);
        expect(V.pivotFor({ south: 23.0, north: 23.01, west: 75.85, east: 75.86 }, view)).toBe(null);
        expect(V.pivotFor(null, view)).toBe(null);
    });
});

describe('OvertureBuildings.markSelected', () => {
    it('flags buildings whose DIGIPIN sits inside the selected cell', () => {
        const recs = [{ pin: '3MC-88M-642P' }, { pin: '3MC-88T-1111' }, {}];
        O.markSelected(recs, '3MC-88M-6');
        expect(recs.map(r => r.sel)).toEqual([true, false, false]);
        O.markSelected(recs, null);
        expect(recs.some(r => r.sel)).toBe(false);
    });
});

describe('CameraPresets helpers', () => {
    it('placeIn keeps a centred bar that fits and shifts one that hits the right obstacles', () => {
        expect(C.placeIn(1440, 70, [], 460)).toBe(null);
        const p = C.placeIn(1440, 70, [768, 1005], 460);
        expect(p.left).toBeGreaterThanOrEqual(78);
        expect(p.left + 460).toBeLessThanOrEqual(768);
        expect(C.placeIn(1440, 70, [760], 700).compact).toBe(true);
    });
    it('pickMime prefers MP4, then WebM, else null', () => {
        expect(C.pickMime(m => m.startsWith('video/webm'))).toBe('video/webm;codecs=vp9');
        expect(C.pickMime(m => m === 'video/mp4')).toBe('video/mp4');
        expect(C.pickMime(() => false)).toBe(null);
    });
    it('fileName names the city and container', () => {
        expect(C.fileName({ id: 'delhi' }, 'video/mp4')).toBe('digipin-delhi-flythrough.mp4');
        expect(C.fileName({ name: 'New Delhi' }, 'video/webm')).toBe('digipin-new-delhi-flythrough.webm');
    });
});

describe('BuildingData.legendModel', () => {
    const lst = { spec: { id: 'lst_monthly', level: 6 }, field: { key: 'lst_day_c', label: 'Daytime LST', type: 'number', unit: '°C', domain: [19, 42.4], ramp: 'heat' } };
    it('gives a ramp with title, unit and low/mid/high ticks', () => {
        const m = B.legendModel(lst, null, false);
        expect(m.color.kind).toBe('ramp');
        expect(m.color.title).toBe('Daytime LST');
        expect(m.color.unit).toBe('°C');
        expect(m.color.ticks).toEqual(['19', '30.7', '42.4']);
        expect(m.color.aria).toContain('19 to 42.4 °C');
        expect(m.height).toBe(null);
    });
    it('notes a fitted ramp and describes a value-driven height', () => {
        const m = B.legendModel(lst, lst, true);
        expect(m.color.note).toMatch(/fitted/i);
        expect(m.height.range).toBe('19 → 4 m · 42.4 → 120 m');
    });
    it('uses swatches for categories', () => {
        const m = B.legendModel({ spec: {}, field: { key: 'c', label: 'Zone', type: 'category', domain: ['a', 'b'] } }, null, false);
        expect(m.color.kind).toBe('swatches');
        expect(m.color.stops.length).toBe(2);
    });
});
