/**
 * PriorityAnalysis — multi-criteria "where to act" tests (pure).
 * Loaded via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const PA = () => globalThis.PriorityAnalysis;

describe('PriorityAnalysis.list() / playbooks', () => {
    it('publishes the intervention playbooks', () => {
        const goals = PA().list().map(p => p.goal);
        expect(goals).toEqual(expect.arrayContaining(['drainage', 'clinics', 'schools', 'parks', 'transit', 'sanitation', 'policing']));
    });
});

describe('PriorityAnalysis.compute()', () => {
    it('drainage priority rises with flood + population, falls with infra', () => {
        const lo = PA().compute({ flood_risk: 10, population_proxy: 80, infra_maturity: 80 }, 'drainage');
        const hi = PA().compute({ flood_risk: 95, population_proxy: 90, infra_maturity: 10 }, 'drainage');
        expect(hi.value).toBeGreaterThan(lo.value);
        expect(hi.band).toBe('High');
        expect(hi.highMeans).toBe('risk');
    });

    it('clinics priority is high where healthcare is poor but population is high', () => {
        const served = PA().compute({ healthcare_access: 90, population_proxy: 80 }, 'clinics');
        const need = PA().compute({ healthcare_access: 5, population_proxy: 90 }, 'clinics');
        expect(need.value).toBeGreaterThan(served.value);
    });

    it('parks priority is high where green is low and people are dense', () => {
        const leafy = PA().compute({ green: 90, population_proxy: 80, noise_estimate: 30 }, 'parks');
        const barren = PA().compute({ green: 5, population_proxy: 90, noise_estimate: 80 }, 'parks');
        expect(barren.value).toBeGreaterThan(leafy.value);
    });

    it('returns drivers and null for unknown goal', () => {
        const r = PA().compute({ flood_risk: 80, population_proxy: 70 }, 'drainage');
        expect(r.drivers.length).toBeGreaterThan(0);
        expect(PA().compute({}, 'nonsense')).toBeNull();
    });
});

describe('PriorityAnalysis.rank()', () => {
    it('orders cells by priority for a goal, descending', () => {
        const cells = [
            { code: 'A', features: { flood_risk: 90, population_proxy: 85, infra_maturity: 20 } },
            { code: 'B', features: { flood_risk: 15, population_proxy: 30, infra_maturity: 80 } },
        ];
        const ranked = PA().rank(cells, 'drainage');
        expect(ranked[0].code).toBe('A');
        expect(ranked[0].priorityValue).toBeGreaterThan(ranked[1].priorityValue);
    });
});

describe('DishaAgent priority skill + intent', () => {
    it('routes "where should we build clinics" to priority(clinics)', () => {
        const p = globalThis.DishaAgent.intent('where should we build new clinics?');
        expect(p.skill).toBe('priority');
        expect(p.params.goal).toBe('clinics');
        expect(p.mode).toBe('map');
    });

    it('paints a priority choropleth from viewport cells', async () => {
        const cells = [
            { digipin: { code: 'A' }, geometry: { center: { lat: 22.70, lng: 75.80 }, bounds: { west: 75.80, south: 22.70, east: 75.81, north: 22.71 } }, features: { green: 5, population_proxy: 90, noise_estimate: 70 } },
            { digipin: { code: 'B' }, geometry: { center: { lat: 22.71, lng: 75.81 }, bounds: { west: 75.81, south: 22.71, east: 75.82, north: 22.72 } }, features: { green: 90, population_proxy: 20, noise_estimate: 20 } },
        ];
        const res = await globalThis.DishaAgent.run('priority', { goal: 'parks' }, { cells });
        expect(res.mode).toBe('map');
        expect(res.data.render.kind).toBe('choropleth');
        expect(res.data.render.highMeans).toBe('risk');
        expect(res.data.top[0].code).toBe('A');   // barren+dense → act first
    });
});
