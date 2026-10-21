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
