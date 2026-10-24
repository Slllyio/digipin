import { describe, it, expect } from 'vitest';

// LensesPanel and DigiPin are exposed by tests/setup.js.
const P = globalThis.LensesPanel;

describe('LensesPanel lens export', () => {
    const code = globalThis.DigiPin.encode(28.6, 77.2).replace(/-/g, '').slice(0, 7);
    const code2 = globalThis.DigiPin.encode(28.61, 77.21).replace(/-/g, '').slice(0, 7);
    const r = {
        city: 'delhi',
        lenses: [{ id: 'x', fields: [{ key: 'a', label: 'A' }, { key: 'k', label: 'Kind', type: 'category', domain: ['low', 'high, very'] }] }],
        layer: { level: 7, cells: [code, code2, 'ZZZ'], columns: { a: [1.5, null, null], k: [1, 0, null] } },
    };

    it('writes one CSV row per cell with a value, quoting text with commas', () => {
        const csv = P.toCSV(r, 'x').trim().split('\n');
        expect(csv[0]).toBe('digipin,lat,lng,a,k');
        expect(csv).toHaveLength(3);
        expect(csv[1]).toMatch(new RegExp(`^${code},28\\.\\d+,77\\.\\d+,1\\.5,"high, very"$`));
        expect(csv[2]).toMatch(/,,low$/);
        expect(P.toCSV(r, 'nope')).toBe('');
    });

    it('writes GeoJSON squares with the digipin and values', () => {
        const gj = P.toGeoJSON(r, 'x');
        expect(gj.features).toHaveLength(2);
        const f = gj.features[0];
        expect(f.properties).toEqual({ digipin: code, a: 1.5, k: 'high, very' });
        const ring = f.geometry.coordinates[0];
        expect(ring).toHaveLength(5);
        expect(ring[0]).toEqual(ring[4]);
        expect(ring[1][0]).toBeGreaterThan(ring[0][0]);
    });
});
