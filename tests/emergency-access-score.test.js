import { describe, it, expect } from 'vitest';

// EmergencyAccessScore + EmergencyAccess are exposed on globalThis by
// tests/setup.js. Pure helpers — the EAI math and the grid→signals bridge.
const S = globalThis.EmergencyAccessScore;
const EA = globalThis.EmergencyAccess;

describe('EmergencyAccessScore.bandFor', () => {
    it('bands a 0..100 index into Isolated / Constrained / Reachable', () => {
        expect(S.bandFor(10)).toBe('Isolated');
        expect(S.bandFor(50)).toBe('Constrained');
        expect(S.bandFor(80)).toBe('Reachable');
    });
    it('uses the inclusive 40 / 66 boundaries', () => {
        expect(S.bandFor(39)).toBe('Isolated');
        expect(S.bandFor(40)).toBe('Constrained');
        expect(S.bandFor(65)).toBe('Constrained');
        expect(S.bandFor(66)).toBe('Reachable');
    });
    it('returns null for a non-finite index', () => {
        expect(S.bandFor(null)).toBeNull();
        expect(S.bandFor(NaN)).toBeNull();
    });
});

describe('EmergencyAccessScore.computeIndex', () => {
    it('returns null when the cell has no road', () => {
        expect(S.computeIndex(null)).toBeNull();
        expect(S.computeIndex({ hasRoad: false })).toBeNull();
    });

    it('scores a best-case cell near 100 (Reachable)', () => {
        const r = S.computeIndex({
            hasRoad: true, nearest_police_km: 0, betweenness_max: 0.05, road_density_m: 400,
            congestion_risk: 0, on_chokepoint: false, sealable: false, has_critical_link: false, res_m: 200,
        });
        expect(r.index).toBe(100);
        expect(r.band).toBe('Reachable');
    });

    it('scores a worst-case cell near 0 (Isolated)', () => {
        const r = S.computeIndex({
            hasRoad: true, nearest_police_km: 10, betweenness_max: 0, road_density_m: 0,
            congestion_risk: 100, on_chokepoint: true, sealable: true, has_critical_link: true, res_m: 200,
        });
        expect(r.index).toBe(0);
        expect(r.band).toBe('Isolated');
    });

    it('weights sum to 1.00 so a clamped all-ones cell hits 100', () => {
        const total = Object.values(S.WEIGHTS).reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(1, 6);
    });

    it('treats unknown police/flow as neutral 0.5, unknown network as 0', () => {
        // Only the chokepoint/sealable/critical-link "free" signals are full (1).
        const r = S.computeIndex({
            hasRoad: true, nearest_police_km: null, betweenness_max: null, road_density_m: null,
            congestion_risk: null, on_chokepoint: false, sealable: false, has_critical_link: false, res_m: 200,
        });
        // policeReach .30*.5 + networkReach .28*0 + flow .17*.5 + free signals (.13+.07+.05)
        const expected = Math.round((0.30 * 0.5 + 0.28 * 0 + 0.17 * 0.5 + 0.13 + 0.07 + 0.05) * 100);
        expect(r.index).toBe(expected);
    });

    it('penalises a chokepoint/sealable pocket relative to a clear cell', () => {
        const base = {
            hasRoad: true, nearest_police_km: 1, betweenness_max: 0.02, road_density_m: 200,
            congestion_risk: 20, has_critical_link: false, res_m: 200,
        };
        const clear = S.computeIndex({ ...base, on_chokepoint: false, sealable: false });
        const choked = S.computeIndex({ ...base, on_chokepoint: true, sealable: true });
        expect(choked.index).toBeLessThan(clear.index);
    });

    it('scores an unknown (null) flag neutrally — between flagged and clear', () => {
        const base = {
            hasRoad: true, nearest_police_km: 1, betweenness_max: 0.02, road_density_m: 200,
            congestion_risk: 20, sealable: false, has_critical_link: false, res_m: 200,
        };
        const clear = S.computeIndex({ ...base, on_chokepoint: false });   // free → 1
        const unknown = S.computeIndex({ ...base, on_chokepoint: null });  // neutral → 0.5
        const flagged = S.computeIndex({ ...base, on_chokepoint: true });  // penalised → 0
        expect(unknown.index).toBeLessThan(clear.index);
        expect(unknown.index).toBeGreaterThan(flagged.index);
    });
});

describe('EmergencyAccess.combine', () => {
    it('flags hasRoad from the mobility sample alone', () => {
        const s = EA.combine({ mobility_risk: 30, nearest_police_km: 1.2, on_chokepoint: true, sealable: false }, null);
        expect(s.hasRoad).toBe(true);
        expect(s.nearest_police_km).toBe(1.2);
        expect(s.on_chokepoint).toBe(true);
    });
    it('flags hasRoad from the traffic sample when mobility is missing', () => {
        const s = EA.combine(null, { road_density_m: 120, betweenness_max: 0.01, congestion_risk: 40, res_m: 200 });
        expect(s.hasRoad).toBe(true);
        expect(s.road_density_m).toBe(120);
        expect(s.congestion_risk).toBe(40);
    });
    it('reports no road when both samples are empty/null', () => {
        expect(EA.combine(null, null).hasRoad).toBe(false);
        expect(EA.combine(null, { road_density_m: 0, betweenness_max: 0, congestion_risk: 0 }).hasRoad).toBe(false);
    });
    it('leaves mobility flags unknown (null) when there is no mobility record', () => {
        const s = EA.combine(null, { road_density_m: 120, betweenness_max: 0.01, congestion_risk: 40, res_m: 200 });
        expect(s.on_chokepoint).toBeNull();
        expect(s.sealable).toBeNull();
    });
    it('round-trips through computeIndex to a real score', () => {
        const s = EA.combine(
            { mobility_risk: 20, nearest_police_km: 0.5, on_chokepoint: false, sealable: false },
            { road_density_m: 300, betweenness_max: 0.04, congestion_risk: 10, has_critical_link: false, res_m: 200 },
        );
        const r = S.computeIndex(s);
        expect(r).not.toBeNull();
        expect(r.index).toBeGreaterThan(66);
        expect(r.band).toBe('Reachable');
    });
});
