/**
 * IntelIndices — composite urban-intelligence index tests.
 *
 * Indices are transparent signed-weight blends of feature fields; positive weight
 * uses the field as-is, negative inverts it (100 - v). Pure + deterministic.
 * Loaded as a globalThis property by tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const II = () => globalThis.IntelIndices;

describe('IntelIndices.list()', () => {
    it('exposes the diversified index catalogue with highMeans flags', () => {
        const list = II().list();
        const ids = list.map(i => i.id);
        expect(ids).toEqual(expect.arrayContaining([
            'livability', 'climateResilience', 'disasterRisk',
            'serviceGap', 'investmentPotential', 'economicVitality', 'sustainability',
        ]));
        expect(list.find(i => i.id === 'disasterRisk').highMeans).toBe('risk');
        expect(list.find(i => i.id === 'livability').highMeans).toBe('good');
    });
});

describe('IntelIndices.compute() — orientation', () => {
    it('disasterRisk rises with flood hazard + exposure', () => {
        const low = II().compute({ flood_risk: 10, population_proxy: 80, infra_maturity: 70 }, 'disasterRisk');
        const high = II().compute({ flood_risk: 90, population_proxy: 80, infra_maturity: 70 }, 'disasterRisk');
        expect(high.value).toBeGreaterThan(low.value);
        expect(high.band).toBe('High');
    });

    it('serviceGap is high where services are thin (negative-weighted)', () => {
        const served = II().compute({ healthcare_access: 90, education_score: 90, public_service: 90, connectivity: 90, population_proxy: 50 }, 'serviceGap');
        const gap = II().compute({ healthcare_access: 5, education_score: 5, public_service: 5, connectivity: 5, population_proxy: 50 }, 'serviceGap');
        expect(gap.value).toBeGreaterThan(served.value);
    });

    it('livability rewards access/green/safety and penalises noise & flood', () => {
        const good = II().compute({ walkability: 90, green: 90, safety: 90, healthcare_access: 80, education_score: 80, public_service: 80, connectivity: 80, noise_estimate: 10, flood_risk: 10 }, 'livability');
        const bad = II().compute({ walkability: 20, green: 10, safety: 20, healthcare_access: 20, education_score: 20, public_service: 20, connectivity: 20, noise_estimate: 90, flood_risk: 90 }, 'livability');
        expect(good.value).toBeGreaterThan(70);
        expect(bad.value).toBeLessThan(40);
        expect(good.band).toBe('Strong');
    });
});

describe('IntelIndices — drivers (explainability)', () => {
    it('returns the top contributing fields', () => {
        const r = II().compute({ flood_risk: 90, population_proxy: 80, infra_maturity: 50 }, 'disasterRisk');
        expect(Array.isArray(r.drivers)).toBe(true);
        expect(r.drivers.length).toBeGreaterThan(0);
        expect(r.drivers[0]).toHaveProperty('id');
        expect(r.drivers[0]).toHaveProperty('value');
    });
});

describe('IntelIndices.all() / forRecord()', () => {
    it('computes every index and accepts a Feature Store record', () => {
        const features = { walkability: 60, green: 50, safety: 55, flood_risk: 30, population_proxy: 40, commercial: 45 };
        const all = II().all(features);
        expect(Object.keys(all)).toEqual(expect.arrayContaining(II().IDS));
        const viaRecord = II().forRecord({ features }, 'livability');
        expect(viaRecord.value).toBe(all.livability.value);
    });

    it('returns null value when no weighted fields are present', () => {
        const r = II().compute({}, 'livability');
        expect(r.value).toBeNull();
        expect(r.band).toBe('no data');
    });
});
