import { describe, it, expect } from 'vitest';

// Utilities is exposed on globalThis by tests/setup.js. assess()/helpers are
// pure; these lock the OSM-derivation + regional-reference + noise contract.
const U = globalThis.Utilities;

const REF = {
    region: 'indore_pilot',
    bounds: { west: 75.6, south: 22.5, east: 76.0, north: 22.9 },
    groundwater_level: { depth_m_bgl: 15, category: 'Over-exploited', trend: 'declining', source: 'CGWB' },
    groundwater_quality: { status: 'potable_with_caveats', label: 'Generally potable; moderate hardness', source: 'CGWB' },
    gas_png: { available: true, operator: 'Avantika Gas Ltd (CGD)', source: 'PNGRB CGD' },
    electricity: { operator: 'MPPKVVCL (West Discom)', typical: 'Overhead LV', source: 'MPPKVVCL' },
};

const ELEMENTS = [
    { type: 'way', tags: { power: 'line' }, center: { lat: 22.701, lon: 75.801 } },
    { type: 'way', tags: { power: 'cable' }, center: { lat: 22.7005, lon: 75.8005 } },
    { type: 'node', tags: { power: 'substation' }, lat: 22.702, lon: 75.802 },
    { type: 'way', tags: { man_made: 'pipeline', substance: 'water' }, center: { lat: 22.700, lon: 75.800 } },
    { type: 'way', tags: { man_made: 'pipeline', substance: 'sewage' }, center: { lat: 22.703, lon: 75.803 } },
    { type: 'node', tags: { man_made: 'manhole' }, lat: 22.7001, lon: 75.8001 },
    { type: 'way', tags: { man_made: 'pipeline', substance: 'gas' }, center: { lat: 22.704, lon: 75.804 } },
    { type: 'node', tags: { amenity: 'restaurant' }, lat: 22.70, lon: 75.80 },  // ignored
];

describe('Utilities.regionHas', () => {
    it('is true inside the pilot bounds and false outside', () => {
        expect(U.regionHas(REF, 22.7, 75.8)).toBe(true);
        expect(U.regionHas(REF, 10, 10)).toBe(false);
        expect(U.regionHas(null, 22.7, 75.8)).toBe(false);
    });
});

describe('Utilities.noiseFromQuietness', () => {
    it('inverts quietness into a noise band', () => {
        expect(U.noiseFromQuietness(90)).toMatchObject({ value: 10, status: 'good' });
        const noisy = U.noiseFromQuietness(30);
        expect(noisy.value).toBe(70);
        expect(noisy.status).toBe('elevated');
    });
    it('returns null when quietness is unknown', () => {
        expect(U.noiseFromQuietness(null)).toBeNull();
        expect(U.noiseFromQuietness(undefined)).toBeNull();
    });
});

describe('Utilities.assess (in-region)', () => {
    const u = U.assess(ELEMENTS, REF, { lat: 22.7, lng: 75.8, quietnessScore: 30 });

    it('derives electricity type from OSM power features', () => {
        expect(u.electricity.type).toBe('mixed');          // line + cable
        expect(u.electricity.overhead).toBe(1);
        expect(u.electricity.underground).toBe(1);
        expect(u.electricity.substations).toBe(1);
        expect(u.electricity.nearest_substation_m).toBeGreaterThan(0);
        expect(u.electricity.operator).toBe('MPPKVVCL (West Discom)');
    });

    it('counts sewer (pipeline + manhole) and water/gas pipelines', () => {
        expect(u.sewer.count).toBe(2);
        expect(u.water.count).toBe(1);
        expect(u.sewer.nearest_m).toBeGreaterThanOrEqual(0);
    });

    it('uses the regional reference for ground water + PNG gas', () => {
        expect(u.groundwater_level.depth_m_bgl).toBe(15);
        expect(u.groundwater_quality.label).toMatch(/potable/i);
        expect(u.gas_png.available).toBe(true);
        expect(u.gas_png.operator).toMatch(/Avantika/);
        expect(u.gas_png.mapped_pipelines).toBe(1);
    });

    it('surfaces the modeled noise reading from quietness', () => {
        expect(u.noise.value).toBe(70);
    });
});

describe('Utilities.assess (out-of-region)', () => {
    const u = U.assess(ELEMENTS, REF, { lat: 10, lng: 10, quietnessScore: 90 });

    it('drops regional readings outside the pilot bounds', () => {
        expect(u.groundwater_level).toBeNull();
        expect(u.groundwater_quality).toBeNull();
        expect(u.region).toBeNull();
    });

    it('still reports OSM gas pipelines when no regional CGD applies', () => {
        expect(u.gas_png.available).toBe(true);
        expect(u.gas_png.source).toBe('OSM');
    });
});

describe('Utilities.assess (empty / no data)', () => {
    it('handles no elements and no reference gracefully', () => {
        const u = U.assess([], null, { lat: 22.7, lng: 75.8 });
        expect(u.sewer.count).toBe(0);
        expect(u.electricity.type).toBe('unknown');
        expect(u.groundwater_level).toBeNull();
        expect(u.gas_png).toBeNull();
        expect(u.noise).toBeNull();
    });
});
