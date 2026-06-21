import { describe, it, expect } from 'vitest';

describe('MeasureTool.pathLengthM', () => {
    it('measures a one-degree-of-latitude segment as ~111 km', () => {
        const m = MeasureTool.pathLengthM([{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }]);
        expect(m).toBeGreaterThan(110000);
        expect(m).toBeLessThan(112000);
    });

    it('sums multiple segments', () => {
        const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 0, lng: 2 }];
        const total = MeasureTool.pathLengthM(pts);
        const oneLeg = MeasureTool.pathLengthM([{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }]);
        expect(total).toBeCloseTo(oneLeg * 2, 0);
    });

    it('is zero for <2 points', () => {
        expect(MeasureTool.pathLengthM([])).toBe(0);
        expect(MeasureTool.pathLengthM([{ lat: 1, lng: 1 }])).toBe(0);
    });

    it('measures the short arc across the anti-meridian (179° → -179° ≈ 2°)', () => {
        const m = MeasureTool.pathLengthM([{ lat: 0, lng: 179 }, { lat: 0, lng: -179 }]);
        // 2° of longitude at the equator ≈ 222 km, NOT ~39,800 km the long way.
        expect(m).toBeGreaterThan(220000);
        expect(m).toBeLessThan(224000);
    });
});

describe('MeasureTool.polygonAreaM2', () => {
    it('measures a ~1 km square as ~1,000,000 m²', () => {
        const d = 0.0089932; // ≈ 1 km in degrees near the equator
        const ring = [{ lat: 0, lng: 0 }, { lat: 0, lng: d }, { lat: d, lng: d }, { lat: d, lng: 0 }];
        const a = MeasureTool.polygonAreaM2(ring);
        expect(a).toBeGreaterThan(0.97e6);
        expect(a).toBeLessThan(1.03e6);
    });

    it('is sign-independent (winding order does not matter)', () => {
        const d = 0.01;
        const cw = [{ lat: 0, lng: 0 }, { lat: 0, lng: d }, { lat: d, lng: d }, { lat: d, lng: 0 }];
        const ccw = [...cw].reverse();
        expect(MeasureTool.polygonAreaM2(cw)).toBeCloseTo(MeasureTool.polygonAreaM2(ccw), 3);
    });

    it('is zero for <3 points', () => {
        expect(MeasureTool.polygonAreaM2([{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }])).toBe(0);
    });

    it('computes a sane area for a polygon straddling the date line', () => {
        // ~2° × ~0.02° box centred on 180° → roughly the same as the same box at 0°.
        const ref = MeasureTool.polygonAreaM2([
            { lat: 0, lng: -1 }, { lat: 0, lng: 1 }, { lat: 0.02, lng: 1 }, { lat: 0.02, lng: -1 }]);
        const dateline = MeasureTool.polygonAreaM2([
            { lat: 0, lng: 179 }, { lat: 0, lng: -179 }, { lat: 0.02, lng: -179 }, { lat: 0.02, lng: 179 }]);
        expect(dateline).toBeCloseTo(ref, -2);   // within ~100 m² scale
    });
});

describe('MeasureTool formatters', () => {
    it('formatLength switches m → km', () => {
        expect(MeasureTool.formatLength(450)).toBe('450 m');
        expect(MeasureTool.formatLength(1500)).toBe('1.50 km');
        expect(MeasureTool.formatLength(0)).toBe('0 m');
    });
    it('formatArea steps m² → ha → km²', () => {
        expect(MeasureTool.formatArea(500)).toBe('500 m²');
        expect(MeasureTool.formatArea(50000)).toBe('5.00 ha');
        expect(MeasureTool.formatArea(2e6)).toBe('2.00 km²');
    });
});
