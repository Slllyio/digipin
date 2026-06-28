/**
 * DigiPinIntel (Feature Store) — unified per-cell record + ranking tests.
 *
 * Pure helpers (schema, levels, flatten, group, score, rank) are deterministic.
 * cell() is exercised for the addressing guarantee (a DigiPin code resolves
 * anywhere even when no covered region / scores exist in the jsdom test env).
 *
 * Loaded as a globalThis property by tests/setup.js (IIFE-global-expose pattern).
 */
import { describe, it, expect } from 'vitest';

const FS = () => globalThis.DigiPinIntel;

describe('DigiPinIntel.schema()', () => {
    it('exposes 20 fields across the domain catalogue, each with polarity', () => {
        const s = FS().schema();
        expect(s.fields.length).toBe(20);
        expect(s.levels).toEqual([6, 8, 10]);
        for (const f of s.fields) {
            expect(typeof f.id).toBe('string');
            expect([1, -1]).toContain(f.polarity);
            expect(s.domains).toContain(f.domain);
        }
    });

    it('marks flood_risk and noise_estimate as negative-polarity (higher = worse)', () => {
        expect(FS().field('flood_risk').polarity).toBe(-1);
        expect(FS().field('noise_estimate').polarity).toBe(-1);
        expect(FS().field('walkability').polarity).toBe(+1);
    });
});

describe('DigiPinIntel.levels()', () => {
    it('truncates a code to L6/L8/L10 (dashless prefix relationship)', () => {
        const lv = FS().levels('34M-TML-MTML');
        const raw = s => s.replace(/-/g, '');
        expect(raw(lv[6]).length).toBe(6);
        expect(raw(lv[8]).length).toBe(8);
        expect(raw(lv[10]).length).toBe(10);
        // coarser level is a prefix of the finer
        expect(raw(lv[10]).startsWith(raw(lv[6]))).toBe(true);
    });
});

describe('DigiPinIntel.flatten() / group()', () => {
    it('flattens {id:{label,value}} to {id:value}', () => {
        const flat = FS().flatten({ green: { label: 'Green', value: 70 }, safety: { label: 'Safety', value: 40 } });
        expect(flat).toEqual({ green: 70, safety: 40 });
    });

    it('groups features into their domains', () => {
        const g = FS().group({ green: 70, flood_risk: 80, walkability: 55 });
        expect(g.environment.green).toBe(70);
        expect(g.risk.flood_risk).toBe(80);
        expect(g.mobility.walkability).toBe(55);
    });
});

describe('DigiPinIntel.score() — polarity-aware weighted composite', () => {
    it('averages positive-polarity fields directly', () => {
        const v = FS().score({ walkability: 80, green: 60 }, { walkability: 1, green: 1 });
        expect(v).toBe(70);
    });

    it('inverts negative-polarity (risk) fields so a positive weight rewards low risk', () => {
        // flood_risk 80 (bad) -> oriented 20; with weight 1 the composite is 20.
        expect(FS().score({ flood_risk: 80 }, { flood_risk: 1 })).toBe(20);
        expect(FS().score({ flood_risk: 10 }, { flood_risk: 1 })).toBe(90);
    });

    it('renormalises over present fields (missing skipped) and clamps 0..100', () => {
        const v = FS().score({ walkability: 90 }, { walkability: 1, green: 1 });
        expect(v).toBe(90);                       // green missing -> ignored
        expect(FS().score({}, { walkability: 1 })).toBeNull();
    });
});

describe('DigiPinIntel.rank()', () => {
    it('orders cells by weighted composite, descending', () => {
        const cells = [
            { code: 'A', features: { flood_risk: 90, population_proxy: 80 } },
            { code: 'B', features: { flood_risk: 10, population_proxy: 80 } },
        ];
        // weight flood_risk only -> B (low risk) should win
        const ranked = FS().rank(cells, { flood_risk: 1 });
        expect(ranked[0].code).toBe('B');
        expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });
});

describe('DigiPinIntel.cell() — addressing guarantee', () => {
    it('always returns a record with a DigiPin code, even with no coverage', async () => {
        const rec = await FS().cell(22.72, 75.86);
        expect(rec.digipin.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{4}$/);
        expect(rec.digipin.levels[6]).toBeTruthy();
        expect(rec).toHaveProperty('available');
        expect(rec.geometry.center).toEqual({ lat: 22.72, lng: 75.86 });
    });
});
