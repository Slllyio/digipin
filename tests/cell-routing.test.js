/**
 * CellRouting — evacuation/safe-routing tests (pure core).
 *
 * Routes exposure-ranked cells to their nearest safe cell with great-circle
 * distance + a road-circuity detour. Loaded via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const CR = () => globalThis.CellRouting;

describe('CellRouting.haversineKm()', () => {
    it('measures a known short distance', () => {
        // ~0.0009° lat ≈ 0.1 km
        const km = CR().haversineKm({ lat: 22.72, lng: 75.86 }, { lat: 22.7209, lng: 75.86 });
        expect(km).toBeGreaterThan(0.08);
        expect(km).toBeLessThan(0.12);
    });
    it('is zero for identical points', () => {
        expect(CR().haversineKm({ lat: 22.72, lng: 75.86 }, { lat: 22.72, lng: 75.86 })).toBeCloseTo(0, 5);
    });
});

describe('CellRouting.bearing()', () => {
    it('points north when destination is due north', () => {
        const b = CR().bearing({ lat: 22.72, lng: 75.86 }, { lat: 22.80, lng: 75.86 });
        expect(b.compass).toBe('N');
    });
    it('points east when destination is due east', () => {
        const b = CR().bearing({ lat: 22.72, lng: 75.86 }, { lat: 22.72, lng: 75.95 });
        expect(b.compass).toBe('E');
    });
});

describe('CellRouting.nearestSafe()', () => {
    it('finds the closest candidate and adds a road-detour distance', () => {
        const origin = { lat: 22.72, lng: 75.86 };
        const safe = [
            { code: 'FAR', center: { lat: 22.80, lng: 75.86 } },
            { code: 'NEAR', center: { lat: 22.725, lng: 75.86 } },
        ];
        const ns = CR().nearestSafe(origin, safe, {});
        expect(ns.to.code).toBe('NEAR');
        expect(ns.roadKm).toBeGreaterThan(ns.km);   // detour-adjusted
    });
    it('respects maxKm (returns null when nothing in range)', () => {
        const ns = CR().nearestSafe({ lat: 22.72, lng: 75.86 }, [{ code: 'X', center: { lat: 23.5, lng: 75.86 } }], { maxKm: 5 });
        expect(ns).toBeNull();
    });
});

describe('CellRouting.planEvacuation()', () => {
    const ranked = [
        { code: 'R1', exposure: 90, center: { lat: 22.720, lng: 75.860 } },
        { code: 'R2', exposure: 80, center: { lat: 22.722, lng: 75.862 } },
        { code: 'S1', exposure: 10, center: { lat: 22.726, lng: 75.860 } },
        { code: 'S2', exposure: 15, center: { lat: 22.715, lng: 75.864 } },
    ];

    it('routes at-risk cells to nearest safe cells', () => {
        const plan = CR().planEvacuation(ranked, { safeBelow: 25, riskAbove: 45 });
        expect(plan.summary.atRisk).toBe(2);
        expect(plan.summary.safeCells).toBe(2);
        expect(plan.summary.routed).toBe(2);
        expect(plan.routes[0].from.code).toBe('R1');
        expect(plan.routes[0].to).not.toBeNull();
        expect(plan.routes[0].direction.compass).toBeTruthy();
    });

    it('marks at-risk cells unreachable when no safe cell is in range', () => {
        const plan = CR().planEvacuation(ranked, { safeBelow: 25, riskAbove: 45, maxKm: 0.05 });
        expect(plan.summary.unreachable).toBeGreaterThan(0);
    });

    it('emits GeoJSON LineStrings for routed pairs', () => {
        const plan = CR().planEvacuation(ranked, { safeBelow: 25, riskAbove: 45 });
        const gj = CR().routesGeoJSON(plan);
        expect(gj.type).toBe('FeatureCollection');
        expect(gj.features[0].geometry.type).toBe('LineString');
        expect(gj.features[0].geometry.coordinates.length).toBe(2);
    });
});
