import { describe, it, expect } from 'vitest';

// TrafficOverlay is exposed on globalThis by tests/setup.js. The render path
// needs a live map; these lock the pure pieces: LOS colour mapping, the
// grade-derivation fallback, and the legend band definition.
const O = globalThis.TrafficOverlay;

describe('TrafficOverlay.colorFor — LOS ramp', () => {
    it('maps each LOS grade to a distinct colour', () => {
        const colors = O.BANDS.map(b => O.colorFor(b.grade));
        expect(new Set(colors).size).toBe(O.BANDS.length);   // all distinct
        expect(O.colorFor('A')).toBe('#31a354');             // free-flow green
        expect(O.colorFor('F')).toBe('#7f0000');             // breakdown deep red
    });
    it('is transparent for an unknown grade', () => {
        expect(O.colorFor(null)).toBe('rgba(0,0,0,0)');
        expect(O.colorFor('Z')).toBe('rgba(0,0,0,0)');
    });
});

describe('TrafficOverlay.gradeForRoad', () => {
    it('uses the precomputed los_grade when present', () => {
        expect(O.gradeForRoad({ los_grade: 'D', highway: 'residential' })).toBe('D');
    });
    it('falls back to a class-capacity grade when no los_grade (Overpass path)', () => {
        const g = O.gradeForRoad({ highway: 'trunk' });
        expect(O.BANDS.map(b => b.grade)).toContain(g);
    });
});

describe('TrafficOverlay.BANDS — legend', () => {
    it('covers all six LOS grades with labels', () => {
        const grades = O.BANDS.map(b => b.grade).sort();
        expect(grades).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
        for (const b of O.BANDS) expect(b.label).toBeTruthy();
    });
});

describe('TrafficOverlay demand-model fields', () => {
    const O = globalThis.TrafficOverlay;
    it('prefers the modelled peak LOS over the structural grade', () => {
        expect(O.gradeForRoad({ los_peak: 'F', los_grade: 'A' })).toBe('F');
    });
    it('widens roads with more peak traffic, capped', () => {
        expect(O.widthFor(undefined)).toBe(1);
        expect(O.widthFor(2000)).toBeGreaterThan(O.widthFor(500));
        expect(O.widthFor(60000)).toBe(O.widthFor(6000));
    });
    it('loads the road file of the given region', () => {
        expect(O.geojsonUrl('delhi')).toBe('./data/traffic/delhi/road_los.geojson');
    });
});

describe('TrafficOverlay time of day', () => {
    const p = { vc_am: 1.0, vc_pm: 0.8, vc_mid: 0.4, vc_peak: 1.0, pcu_peak: 1800, ffs: 45 };
    it('reproduces each pattern at its own peak hour', () => {
        expect(O.vcAt(p, 9)).toBeCloseTo(1.0, 9);
        expect(O.vcAt(p, 18)).toBeCloseTo(0.8, 9);
        expect(O.vcAt(p, 13)).toBeCloseTo(0.4, 9);
        expect(O.vcAt(p, 3)).toBeLessThan(0.1);
        expect(O.vcAt({ los_peak: 'C' }, 9)).toBeNull();
    });
    it('matches the pipeline profile (sums to 100, mixes sum to 1)', () => {
        expect(O.HOURLY.share_pct.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
        for (const m of O.HOURLY.mix) expect(m.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
        expect(O.HOURLY.share_pct[9] / 100).toBeCloseTo(O.HOURLY.period_share.am, 9);
    });
    it('grades and slows roads like the model', () => {
        expect(O.losFor(0.3)).toBe('A');
        expect(O.losFor(0.95)).toBe('E');
        expect(O.losFor(1.3)).toBe('F');
        expect(O.speedAt(45, 0)).toBe(45);
        expect(O.speedAt(45, 1)).toBeCloseTo(45 / 1.15, 6);
        expect(O.speedAt(45, 5)).toBeCloseTo(45 / 4, 6);   // floored at a quarter of free flow
    });
    it('labels hours and builds hour paint expressions', () => {
        expect(O.hourLabel(9)).toBe('09:00 · morning peak');
        expect(O.hourLabel(18)).toBe('18:00 · evening peak');
        expect(O.paintFor(null).color).toEqual(['get', 'color']);
        const e = O.paintFor(18);
        expect(e.color[0]).toBe('case');
        expect(JSON.stringify(e.color)).toContain('vc_pm');
        expect(O.hourCoef(18).am).toBe(0);
        expect(O.hourCoef(18).pm).toBeCloseTo(1, 9);
    });
    it('setHour wraps and clears without a map', () => {
        expect(O.setHour(25)).toBe(1);
        expect(O.setHour(null)).toBeNull();
    });
});
