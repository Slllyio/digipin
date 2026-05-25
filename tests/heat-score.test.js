/**
 * HeatScore — Urban Heat Island score-model tests.
 *
 * MODIS LST raw uint16 storage = Kelvin × 50 (no-data sentinel = 0).
 * UHI score = night-LST anomaly of cell vs surroundings, on a 0..100 scale.
 *
 * HeatScore is loaded as a globalThis property by tests/setup.js
 * (which uses the IIFE-global-expose pattern).
 */

import { describe, it, expect } from 'vitest';

describe('HeatScore.lstRawToCelsius()', () => {
    it('converts MODIS raw 14400 to ~15°C', () => {
        const c = globalThis.HeatScore.lstRawToCelsius(14400);
        // 14400/50 = 288 K; 288 - 273.15 = 14.85 °C
        expect(c).toBeCloseTo(14.85, 2);
    });

    it('returns null for the MODIS no-data sentinel (0)', () => {
        expect(globalThis.HeatScore.lstRawToCelsius(0)).toBeNull();
    });

    it('returns null for null input', () => {
        expect(globalThis.HeatScore.lstRawToCelsius(null)).toBeNull();
    });

    it('round-trips a known Kelvin temperature', () => {
        // 30°C = 303.15 K → raw = 303.15 * 50 = 15157.5
        const c = globalThis.HeatScore.lstRawToCelsius(15157.5);
        expect(c).toBeCloseTo(30, 5);
    });
});

describe('HeatScore.uhiScore()', () => {
    it('returns 24 for zero anomaly (cell same temp as surroundings)', () => {
        const s = globalThis.HeatScore.uhiScore({
            cell_night_lst_c: 25,
            surrounding_night_lst_c: 25,
        });
        expect(s).toBe(24);
    });

    it('returns ~60 for a +3°C night anomaly', () => {
        const s = globalThis.HeatScore.uhiScore({
            cell_night_lst_c: 28,
            surrounding_night_lst_c: 25,
        });
        expect(s).toBe(60);
    });

    it('clamps to 0 for a -2°C anomaly (cooler than surroundings)', () => {
        const s = globalThis.HeatScore.uhiScore({
            cell_night_lst_c: 23,
            surrounding_night_lst_c: 25,
        });
        expect(s).toBe(0);
    });

    it('clamps to 100 for an extreme +10°C anomaly', () => {
        const s = globalThis.HeatScore.uhiScore({
            cell_night_lst_c: 35,
            surrounding_night_lst_c: 25,
        });
        expect(s).toBe(100);
    });

    it('returns null when cell_night_lst_c is missing', () => {
        const s = globalThis.HeatScore.uhiScore({
            cell_night_lst_c: null,
            surrounding_night_lst_c: 25,
        });
        expect(s).toBeNull();
    });

    it('returns null when surrounding_night_lst_c is missing', () => {
        const s = globalThis.HeatScore.uhiScore({
            cell_night_lst_c: 28,
            surrounding_night_lst_c: null,
        });
        expect(s).toBeNull();
    });
});

describe('HeatScore.diurnalRangeC()', () => {
    it('returns day-minus-night when both present', () => {
        const r = globalThis.HeatScore.diurnalRangeC({ day_lst_c: 40, night_lst_c: 25 });
        expect(r).toBe(15);
    });

    it('returns null when day_lst_c is missing', () => {
        const r = globalThis.HeatScore.diurnalRangeC({ day_lst_c: null, night_lst_c: 25 });
        expect(r).toBeNull();
    });

    it('returns null when night_lst_c is missing', () => {
        const r = globalThis.HeatScore.diurnalRangeC({ day_lst_c: 40, night_lst_c: null });
        expect(r).toBeNull();
    });
});

describe('HeatScore.nightTrend()', () => {
    it('returns positive slope and r²≈1 for a perfectly rising series', () => {
        const t = globalThis.HeatScore.nightTrend([24, 25, 26, 27, 28, 29, 30, 31, 32]);
        expect(t.slope_c_per_yr).toBeCloseTo(1, 5);
        expect(t.r_squared).toBeCloseTo(1, 5);
    });

    it('returns slope=0 for a flat series', () => {
        const t = globalThis.HeatScore.nightTrend([25, 25, 25, 25, 25, 25, 25, 25, 25]);
        expect(t.slope_c_per_yr).toBeCloseTo(0, 5);
    });

    it('skips null entries and still computes when enough valid points', () => {
        const t = globalThis.HeatScore.nightTrend([25, null, 26, null, 27, 28, 29]);
        expect(t).not.toBeNull();
        expect(t.slope_c_per_yr).toBeGreaterThan(0);
    });

    it('returns null when fewer than 3 valid points', () => {
        expect(globalThis.HeatScore.nightTrend([25, 26])).toBeNull();
        expect(globalThis.HeatScore.nightTrend([null, null, 26])).toBeNull();
    });

    it('returns null when input is missing or empty', () => {
        expect(globalThis.HeatScore.nightTrend(null)).toBeNull();
        expect(globalThis.HeatScore.nightTrend([])).toBeNull();
    });
});
