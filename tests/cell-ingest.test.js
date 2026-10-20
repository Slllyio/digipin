import { describe, it, expect, afterEach } from 'vitest';

// CellIngest + CellStore + DigiPin are exposed by tests/setup.js.
const CI = globalThis.CellIngest;
const CS = globalThis.CellStore;

afterEach(() => {
    delete window.DIGIPIN_CONFIG;
    CS.datasets().filter(d => CS.isLocal(d.id)).forEach(d => CS.unregister(d.id));
});

describe('CellIngest.parseCSV()', () => {
    it('handles quotes, escaped quotes, embedded commas/newlines, CRLF and a BOM', () => {
        const rows = CI.parseCSV('﻿name,lat,lng,note\r\n"A, Ltd",22.7,75.8,"say ""hi""\nthere"\r\nB,22.8,75.9,\r\n\r\n');
        expect(rows).toEqual([
            { name: 'A, Ltd', lat: '22.7', lng: '75.8', note: 'say "hi"\nthere' },
            { name: 'B', lat: '22.8', lng: '75.9', note: '' },
        ]);
    });
    it('returns [] for empty input', () => { expect(CI.parseCSV('\n\n')).toEqual([]); });
});

describe('CellIngest.readRows()', () => {
    it('flattens GeoJSON features to rows with a lat/lng centre', () => {
        const rows = CI.readRows(JSON.stringify({ type: 'FeatureCollection', features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [75.8, 22.7] }, properties: { v: 1 } },
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[75.0, 22.0], [76.0, 23.0]] }, properties: { v: 2 } },
        ] }), 'x.geojson');
        expect(rows).toEqual([{ v: 1, lat: 22.7, lng: 75.8 }, { v: 2, lat: 22.5, lng: 75.5 }]);
    });
});

describe('CellIngest.inferFields()', () => {
    it('finds location columns, numeric → mean, low-cardinality text → mode', () => {
        const rows = CI.parseCSV('Latitude,Longitude,Beds (ICU),type,id\n22.7,75.8,"1,000",govt,a1\n22.71,75.81,20,private,a2');
        expect(CI.locationColumns(rows)).toEqual({ lat: 'Latitude', lng: 'Longitude', pin: null });
        const { fields, source } = CI.inferFields(rows);
        expect(fields.map(f => [f.key, f.type, f.agg])).toEqual([
            ['count', 'number', 'count'], ['beds_icu', 'number', 'mean'],
            ['type', 'category', 'mode'], ['id', 'category', 'mode'],
        ]);
        expect(source.beds_icu).toBe('Beds (ICU)');
        const recs = CI.toRecords(rows, fields, source);
        expect(recs[0]).toEqual({ lat: 22.7, lng: 75.8, beds_icu: 1000, type: 'govt', id: 'a1' });
    });
});

describe('CellIngest.autoLevel()', () => {
    it('city extent → L7, neighbourhood → L8, config override wins', () => {
        expect(CI.autoLevel([{ lat: 22.5, lng: 75.6 }, { lat: 22.9, lng: 76.0 }])).toBe(7);
        expect(CI.autoLevel([{ lat: 22.70, lng: 75.80 }, { lat: 22.71, lng: 75.81 }])).toBe(8);
        expect(CI.autoLevel([{ lat: 10, lng: 70 }, { lat: 30, lng: 90 }])).toBe(4);
        window.DIGIPIN_CONFIG = { ingestLevel: 9 };
        expect(CI.autoLevel([{ lat: 22.7, lng: 75.8 }])).toBe(9);
    });
});

describe('CellIngest.ingestRows()', () => {
    it('bins rows and registers a runtime dataset that renders in 3D by default', async () => {
        const rows = CI.parseCSV('lat,lng,aqi\n22.7196,75.8577,80\n22.7197,75.8578,100\n22.75,75.90,60');
        const spec = CI.ingestRows(rows, 'Air Quality.csv', 7);
        expect(spec.id).toBe('user_air_quality');
        expect(spec.level).toBe(7);
        expect(spec.default).toMatchObject({ field: 'aqi', extrude: true });
        const t = await CS.load(spec.id);
        expect(t.cells).toHaveLength(2);
        const i = t.columns.count.indexOf(2);
        expect(t.columns.aqi[i]).toBe(90);
        expect(CI.isRebinnable(spec.id)).toBe(true);
        expect(await CI.rebin(spec.id, 6)).toBe(true);
        expect(CS.get(spec.id).level).toBe(6);
    });

    it('rejects files with no usable location', () => {
        expect(() => CI.ingestRows(CI.parseCSV('a,b\n1,2'), 'x.csv')).toThrow(/No location/);
        expect(() => CI.ingestRows([], 'x.csv')).toThrow(/no rows/);
        expect(() => CI.ingestRows(CI.parseCSV('lat,lng\n1,1'), 'x.csv', 7)).toThrow(/India/);
    });
});
