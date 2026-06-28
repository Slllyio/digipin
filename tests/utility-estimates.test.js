/**
 * UtilityEstimates — per-cell electricity/water/waste/solar estimate tests.
 *
 * Transparent downscaling from population/activity proxies via Indian per-capita
 * norms. Pure + deterministic. Loaded via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const UE = () => globalThis.UtilityEstimates;

describe('UtilityEstimates.population()', () => {
    it('scales the density proxy by area × max density', () => {
        // proxy 100, 0.06 km², 25000/km² → ~1500 residents
        const pop = UE().population({ population_proxy: 100 }, { areaKm2: 0.06, maxDensity: 25000 });
        expect(pop).toBe(1500);
        expect(UE().population({ population_proxy: 0 }, {})).toBe(0);
    });
});

describe('UtilityEstimates.all()', () => {
    const F = { population_proxy: 80, commercial: 60, infra_maturity: 40 };

    it('estimates electricity, water, waste and carbon from norms', () => {
        const u = UE().all(F, { areaKm2: 0.06, maxDensity: 25000 });
        expect(u.populationEst).toBe(1200);                 // 0.8*25000*0.06
        expect(u.electricity.kwhPerDay).toBeGreaterThan(0);
        expect(u.water.litresPerDay).toBe(Math.round(1200 * 135 * (1 + 0.4 * 0.6)));
        expect(u.waste.kgPerDay).toBe(Math.round(1200 * 0.45 * (1 + 0.35 * 0.6)));
        expect(u.electricity.carbonKgPerDay).toBe(Math.round(u.electricity.kwhPerDay * UE().NORMS.gridCO2PerKwh));
    });

    it('scales monotonically with population proxy', () => {
        const lo = UE().all({ population_proxy: 20, commercial: 20 });
        const hi = UE().all({ population_proxy: 90, commercial: 20 });
        expect(hi.electricity.kwhPerDay).toBeGreaterThan(lo.electricity.kwhPerDay);
        expect(hi.water.litresPerDay).toBeGreaterThan(lo.water.litresPerDay);
    });

    it('commercial activity raises electricity load', () => {
        const res = UE().all({ population_proxy: 60, commercial: 0 });
        const mixed = UE().all({ population_proxy: 60, commercial: 90 });
        expect(mixed.electricity.kwhPerDay).toBeGreaterThan(res.electricity.kwhPerDay);
    });

    it('night_lights grounding nudges electricity and flags grounded', () => {
        const dark = UE().all({ population_proxy: 60, commercial: 30, night_lights: 10 });
        const bright = UE().all({ population_proxy: 60, commercial: 30, night_lights: 95 });
        expect(bright.electricity.kwhPerDay).toBeGreaterThan(dark.electricity.kwhPerDay);
        expect(bright.electricity.grounded).toBe(true);
        expect(UE().all({ population_proxy: 60 }).electricity.grounded).toBe(false);
    });

    it('computes rooftop-solar potential and a supply-stress band', () => {
        const u = UE().all({ population_proxy: 70, commercial: 40, infra_maturity: 20 });
        expect(u.solarRooftop.kwhPerDayPotential).toBeGreaterThan(0);
        expect(u.solarRooftop.offsetPct).not.toBeNull();
        expect(['Low', 'Moderate', 'High']).toContain(u.supplyStress.band);
        // low infra + high demand → elevated stress
        expect(u.supplyStress.value).toBeGreaterThan(40);
    });

    it('exposes a transparent basis (calibration + norms + caveat)', () => {
        const u = UE().all(F);
        expect(u.basis.norms.waterLpcd).toBe(135);
        expect(u.basis.note).toMatch(/not metered/i);
    });
});
