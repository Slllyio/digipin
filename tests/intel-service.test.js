/**
 * IntelService — IaaS client tests (pure helpers + graceful degradation).
 * Fetches are absent in jsdom, so cell() resolves to null; the pure region/expand
 * helpers carry the logic. Loaded via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const IS = () => globalThis.IntelService;

describe('IntelService._inBbox / _regionFor', () => {
    const man = { regions: [
        { name: 'indore_pilot', bbox: { west: 75.6, south: 22.5, east: 76.0, north: 22.9 } },
        { name: 'other', bbox: { west: 77.2, south: 24.5, east: 77.4, north: 24.7 } },
    ] };

    it('matches a point to the covering region', () => {
        expect(IS()._regionFor(man, 22.72, 75.86).name).toBe('indore_pilot');
        expect(IS()._regionFor(man, 24.63, 77.31).name).toBe('other');
    });
    it('returns null outside all regions', () => {
        expect(IS()._regionFor(man, 28.6, 77.2)).toBeNull();
        expect(IS()._inBbox(man.regions[0].bbox, 22.72, 75.86)).toBe(true);
        expect(IS()._inBbox(man.regions[0].bbox, 0, 0)).toBe(false);
    });
});

describe('IntelService._expand', () => {
    it('expands a compact cell record into the public shape', () => {
        const raw = { c: [75.86, 22.72], ix: { livability: 59, disasterRisk: 65 },
                      ut: { e: 29934, w: 3231, g: 10658, s: 65000, st: 55 }, pr: { clinics: 80 } };
        const out = IS()._expand(raw, { indices: ['livability', 'disasterRisk'] }, '34MTMLMTML');
        expect(out.center).toEqual({ lng: 75.86, lat: 22.72 });
        expect(out.indices.livability.value).toBe(59);
        expect(out.utilities.electricityKwhPerDay).toBe(29934);
        expect(out.utilities.supplyStress).toBe(55);
        expect(out.priorities.clinics).toBe(80);
        expect(out.code).toMatch(/-/);          // formatted DigiPin code
    });
    it('returns null for an absent cell', () => {
        expect(IS()._expand(null, {}, 'X')).toBeNull();
    });
});

describe('IntelService.cell() — graceful degradation', () => {
    it('resolves to null when the artifact is not served (jsdom)', async () => {
        expect(await IS().cell(22.72, 75.86)).toBeNull();
    });
});
