/**
 * Tests for FloodSCS — SCS Curve Number rainfall→runoff model.
 *
 * Formula reference (USDA SCS, Indian civil-engineering textbook standard):
 *   S  = 25400/CN - 254    (mm)
 *   Iₐ = 0.2 × S           (mm)
 *   Q  = (P - Iₐ)² / (P - Iₐ + S)   when P > Iₐ, else 0
 *
 * Numerical checks against textbook reference: CN=80 ⇒ S=63.5, Iₐ=12.7
 *   P=100 mm ⇒ Q≈50.5 mm   (confirmed in plan §11 verification step)
 *   P=200 mm ⇒ Q≈140 mm
 */

import { describe, it, expect } from 'vitest';

describe('FloodSCS.runoffMm()', () => {
    it('returns 0 when rainfall is below initial abstraction (CN=80, Iₐ≈12.7mm)', () => {
        // P=10 mm < 12.7 mm Iₐ ⇒ no runoff
        expect(globalThis.FloodSCS.runoffMm(10, 80)).toBe(0);
    });

    it('returns 0 for zero or negative rainfall', () => {
        expect(globalThis.FloodSCS.runoffMm(0, 80)).toBe(0);
        expect(globalThis.FloodSCS.runoffMm(-5, 80)).toBe(0);
    });

    it('returns 0 for invalid (zero or negative) CN', () => {
        expect(globalThis.FloodSCS.runoffMm(100, 0)).toBe(0);
        expect(globalThis.FloodSCS.runoffMm(100, -10)).toBe(0);
    });

    it('matches the textbook P=100, CN=80 ⇒ Q≈50.5 mm reference', () => {
        const q = globalThis.FloodSCS.runoffMm(100, 80);
        expect(q).toBeGreaterThan(50);
        expect(q).toBeLessThan(51);
    });

    it('matches the textbook P=200, CN=80 ⇒ Q≈140 mm reference', () => {
        const q = globalThis.FloodSCS.runoffMm(200, 80);
        expect(q).toBeGreaterThan(139);
        expect(q).toBeLessThan(141);
    });

    it('produces near-zero runoff for low CN (forest, CN=30)', () => {
        // CN=30: S = 25400/30 - 254 ≈ 592 mm, Iₐ ≈ 118 mm. A 50 mm storm is far below Iₐ.
        expect(globalThis.FloodSCS.runoffMm(50, 30)).toBe(0);
    });

    it('produces near-impervious runoff for high CN (CN=98, asphalt)', () => {
        // CN=98: S ≈ 5.2 mm, Iₐ ≈ 1 mm. 100 mm of rainfall ⇒ runoff close to (P - Iₐ).
        const q = globalThis.FloodSCS.runoffMm(100, 98);
        expect(q).toBeGreaterThan(90);
        expect(q).toBeLessThan(100);
    });

    it('uses default CN=80 when omitted', () => {
        const explicit = globalThis.FloodSCS.runoffMm(100, 80);
        const defaulted = globalThis.FloodSCS.runoffMm(100);
        expect(defaulted).toBe(explicit);
    });

    it('runoff is monotonically increasing in rainfall (for same CN)', () => {
        const q50 = globalThis.FloodSCS.runoffMm(50);
        const q100 = globalThis.FloodSCS.runoffMm(100);
        const q200 = globalThis.FloodSCS.runoffMm(200);
        expect(q100).toBeGreaterThan(q50);
        expect(q200).toBeGreaterThan(q100);
    });

    it('runoff is monotonically increasing in CN (for same rainfall)', () => {
        const q_pervious = globalThis.FloodSCS.runoffMm(100, 50);
        const q_default = globalThis.FloodSCS.runoffMm(100, 80);
        const q_paved = globalThis.FloodSCS.runoffMm(100, 95);
        expect(q_default).toBeGreaterThan(q_pervious);
        expect(q_paved).toBeGreaterThan(q_default);
    });
});

describe('FloodSCS.depthFromRunoff()', () => {
    it('returns 0 for zero or negative runoff', () => {
        expect(globalThis.FloodSCS.depthFromRunoff(0)).toBe(0);
        expect(globalThis.FloodSCS.depthFromRunoff(-5)).toBe(0);
    });

    it('applies the default 0.02 m per mm linear scale', () => {
        expect(globalThis.FloodSCS.depthFromRunoff(50)).toBeCloseTo(1.0, 5);
        expect(globalThis.FloodSCS.depthFromRunoff(100)).toBeCloseTo(2.0, 5);
    });

    it('accepts an override scale', () => {
        expect(globalThis.FloodSCS.depthFromRunoff(50, 0.04)).toBeCloseTo(2.0, 5);
    });
});

describe('FloodSCS.rainfallToExtraDepth()', () => {
    it('returns intermediate runoff value alongside extra depth', () => {
        const r = globalThis.FloodSCS.rainfallToExtraDepth(100, 80);
        expect(r.rainfall_mm).toBe(100);
        expect(r.cn).toBe(80);
        expect(r.runoff_mm).toBeGreaterThan(50);
        expect(r.runoff_mm).toBeLessThan(51);
        expect(r.extra_depth_m).toBeCloseTo(r.runoff_mm * 0.02, 5);
    });

    it('returns runoff=0 and depth=0 below initial abstraction', () => {
        const r = globalThis.FloodSCS.rainfallToExtraDepth(10, 80);
        expect(r.runoff_mm).toBe(0);
        expect(r.extra_depth_m).toBe(0);
    });
});
