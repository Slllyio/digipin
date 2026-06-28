/**
 * CellExposure — per-cell real-time exposure tests.
 *
 * Fuses a hazard (from a live alert) with Feature Store cells into ranked,
 * prioritised exposure. Pure core is deterministic. Loaded via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const CE = () => globalThis.CellExposure;

describe('CellExposure.hazardProfile()', () => {
    it('classifies kind from category/headline text', () => {
        expect(CE().hazardProfile({ category: 'Flood', severity: 'Severe' }).kind).toBe('flood');
        expect(CE().hazardProfile({ headline: 'Heatwave warning' }).kind).toBe('heat');
        expect(CE().hazardProfile({ category: 'Earthquake' }).kind).toBe('quake');
        expect(CE().hazardProfile({ headline: 'Cyclone approaching' }).kind).toBe('storm');
        expect(CE().hazardProfile({ headline: 'Festival notice' }).kind).toBe('generic');
    });

    it('maps severity strings to a 0..1 weight', () => {
        expect(CE().hazardProfile({ severity: 'Extreme' }).weight).toBe(1.0);
        expect(CE().hazardProfile({ severity: 'Minor' }).weight).toBe(0.3);
        expect(CE().hazardProfile({}).weight).toBe(0.6);  // default
    });

    it('derives weight from earthquake magnitude when no severity', () => {
        expect(CE().hazardProfile({ category: 'Earthquake', magnitude: 7 }).weight).toBe(1);
        expect(CE().hazardProfile({ category: 'Earthquake', magnitude: 3 }).weight).toBe(0.3);
    });
});

describe('CellExposure.cellExposure() — hazard-specific vulnerability', () => {
    it('flood exposure rises with flood_risk and population', () => {
        const h = { kind: 'flood', weight: 1 };
        const low = CE().cellExposure({ flood_risk: 10, population_proxy: 80 }, h);
        const high = CE().cellExposure({ flood_risk: 90, population_proxy: 80 }, h);
        expect(high).toBeGreaterThan(low);
    });

    it('heat exposure rises where green cover is low', () => {
        const h = { kind: 'heat', weight: 1 };
        const leafy = CE().cellExposure({ green: 90, population_proxy: 70 }, h);
        const barren = CE().cellExposure({ green: 5, population_proxy: 70 }, h);
        expect(barren).toBeGreaterThan(leafy);
    });

    it('quake/storm exposure rises where infrastructure is weak', () => {
        const h = { kind: 'quake', weight: 1 };
        const strong = CE().cellExposure({ infra_maturity: 90, population_proxy: 60 }, h);
        const weak = CE().cellExposure({ infra_maturity: 10, population_proxy: 60 }, h);
        expect(weak).toBeGreaterThan(strong);
    });
});

describe('CellExposure.priority() / rank() / summary()', () => {
    it('bands exposure into operational priorities', () => {
        expect(CE().priority(80)).toBe('Critical');
        expect(CE().priority(50)).toBe('High');
        expect(CE().priority(30)).toBe('Moderate');
        expect(CE().priority(10)).toBe('Low');
    });

    it('ranks cells by exposure descending and summarises by priority', () => {
        const cells = [
            { code: 'A', features: { flood_risk: 95, population_proxy: 90 } },
            { code: 'B', features: { flood_risk: 20, population_proxy: 30 } },
        ];
        const ranked = CE().rank(cells, { kind: 'flood', weight: 1 });
        expect(ranked[0].code).toBe('A');
        expect(ranked[0].exposure).toBeGreaterThan(ranked[1].exposure);
        const s = CE().summary(ranked);
        expect(s.cells).toBe(2);
        expect(s.byPriority).toHaveProperty('Critical');
        expect(s.exposedPopulationProxy).toBeGreaterThan(0);
    });
});
