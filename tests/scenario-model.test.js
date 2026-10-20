import { describe, it, expect } from 'vitest';

// ScenarioModel is exposed on globalThis by tests/setup.js. adjust()/summarize()
// are pure; these lock the what-if lens contract.
const S = globalThis.ScenarioModel;

describe('ScenarioModel.adjust', () => {
    it('baseline leaves the probability unchanged', () => {
        expect(S.adjust('baseline', { prob: 50 })).toEqual({ prob: 50, delta: 0 });
    });

    it('returns null prob when there is no base signal', () => {
        expect(S.adjust('transit_hub', { prob: null, anchorKm: 0 }).prob).toBeNull();
    });

    it('transit hub boosts nearby cells and fades with distance', () => {
        const atHub = S.adjust('transit_hub', { prob: 40, anchorKm: 0 });
        const near = S.adjust('transit_hub', { prob: 40, anchorKm: 1.5 });
        const far = S.adjust('transit_hub', { prob: 40, anchorKm: 5 });
        expect(atHub.prob).toBe(65);        // +25 at the hub
        expect(near.delta).toBeGreaterThan(0);
        expect(near.delta).toBeLessThan(atHub.delta);
        expect(far.delta).toBe(0);          // beyond 3 km → no effect
    });

    it('protect-flood suppresses growth on flood-prone land', () => {
        expect(S.adjust('protect_flood', { prob: 80, floodRisk: 70 }).prob).toBe(32); // ×0.4
        expect(S.adjust('protect_flood', { prob: 80, floodRisk: 50 }).prob).toBe(56); // ×0.7
        expect(S.adjust('protect_flood', { prob: 80, floodRisk: 10 }).prob).toBe(80); // unaffected
    });

    it('curb-sprawl dampens growth where little road exists', () => {
        expect(S.adjust('curb_sprawl', { prob: 60, roadDensity: 10 }).prob).toBe(30);  // ×0.5
        expect(S.adjust('curb_sprawl', { prob: 60, roadDensity: 100 }).prob).toBe(48); // ×0.8
        expect(S.adjust('curb_sprawl', { prob: 60, roadDensity: 400 }).prob).toBe(60); // unaffected
    });

    it('clamps to 0..100', () => {
        expect(S.adjust('transit_hub', { prob: 95, anchorKm: 0 }).prob).toBe(100);
    });
});

describe('ScenarioModel.summarize', () => {
    it('counts cells crossing the LIKELY threshold and the mean delta', () => {
        const cells = [
            { base: 40, scen: 60 },   // gained (crosses 45)
            { base: 80, scen: 30 },   // lost
            { base: 50, scen: 55 },   // stays likely
            { base: 10, scen: 12 },   // stays unlikely
            { base: null, scen: 20 }, // ignored
        ];
        const s = S.summarize(cells);
        expect(s.gained).toBe(1);
        expect(s.lost).toBe(1);
        expect(s.n).toBe(4);
        expect(typeof s.meanDelta).toBe('number');
    });

    it('handles empty input', () => {
        expect(S.summarize([])).toEqual({ gained: 0, lost: 0, meanDelta: 0, n: 0 });
    });
});
