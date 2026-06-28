/**
 * IntelReport — per-cell brief + IaaS payload tests (pure).
 * Loaded via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const IR = () => globalThis.IntelReport;

const RECORD = {
    digipin: { code: '34M-TML-MTML', levels: { 6: '34M-TML', 8: '34M-TML-MT', 10: '34M-TML-MTML' } },
    geometry: { center: { lat: 22.72, lng: 75.86 } },
    region: 'indore_pilot',
    available: true,
    features: {
        walkability: 70, green: 75, safety: 60, healthcare_access: 65, education_score: 60,
        public_service: 55, connectivity: 65, noise_estimate: 40, flood_risk: 85,
        commercial: 80, investment: 75, real_estate_growth: 70, infra_maturity: 50,
        digital_readiness: 60, entertainment_score: 55, tourism: 40, food_diversity: 60,
        religious_diversity: 50, population_proxy: 80, livability: 62,
    },
};

describe('IntelReport.flags()', () => {
    it('raises flood + density flags from raw fields, and risk-band flags from indices', () => {
        const fl = IR().flags(RECORD).map(f => f.text);
        expect(fl).toContain('Flood-prone cell');
        expect(fl).toContain('Densely populated');
        expect(fl.some(t => /disaster|flood risk/i.test(t))).toBe(true);
    });
});

describe('IntelReport.build()', () => {
    it('assembles a payload with headline strength/risk and all indices', () => {
        const r = IR().build(RECORD);
        expect(r.available).toBe(true);
        expect(r.digipin.code).toBe('34M-TML-MTML');
        expect(r.location.region).toBe('indore_pilot');
        expect(r.indices.length).toBeGreaterThanOrEqual(7);
        expect(r.headline.topRisk).toBeTruthy();        // flood-heavy cell -> a risk index leads
        expect(r.headline.topStrength).toBeTruthy();
        expect(r.schemaVersion).toBe(1);
    });

    it('degrades to an address-only report when no features are present', () => {
        const r = IR().build({ digipin: { code: '34M-TML-MTML' }, available: false, features: {} });
        expect(r.available).toBe(false);
        expect(IR().toText(r)).toMatch(/no fused intelligence/i);
    });

    it('carries an attached live exposure block', () => {
        const r = IR().build(RECORD, { exposure: { priority: 'Critical', exposure: 88, hazard: 'flood' } });
        expect(r.exposure.priority).toBe('Critical');
        expect(IR().toText(r)).toMatch(/Live exposure: Critical/);
    });
});

describe('IntelReport.toText() / toJSON()', () => {
    it('renders a copyable brief with the code and indices line', () => {
        const t = IR().toText(IR().build(RECORD));
        expect(t).toMatch(/^DigiPin 34M-TML-MTML/);
        expect(t).toMatch(/Indices:/);
    });
    it('serialises a valid JSON payload', () => {
        const json = IR().toJSON(IR().build(RECORD));
        const parsed = JSON.parse(json);
        expect(parsed.generatedBy).toBe('DigiPin Urban Intelligence');
        expect(parsed.digipin.code).toBe('34M-TML-MTML');
    });
});
