/**
 * DishaAgent — agentic planner tests (the pure core).
 *
 * intent() maps municipal natural-language questions to {skill, params};
 * applyScenario() recomputes indices under a what-if; rankByIndex() orders cells.
 * Executors are async/IO and smoke-tested in-browser. Loaded via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const AG = () => globalThis.DishaAgent;

describe('DishaAgent.intent() — natural-language planning', () => {
    it('routes flood/risk questions to findCells on disasterRisk', () => {
        const p = AG().intent('where is flood risk highest?');
        expect(p.skill).toBe('findCells');
        expect(p.params.index).toBe('disasterRisk');
    });

    it('routes underserved questions to serviceGaps', () => {
        const p = AG().intent('show the 15 most underserved areas');
        expect(p.skill).toBe('serviceGaps');
        expect(p.params.top).toBe(15);
    });

    it('routes live-emergency questions to exposure with the right hazard', () => {
        const p = AG().intent('which cells are affected by the flood right now?');
        expect(p.skill).toBe('exposure');
        expect(p.params.hazard).toBe('flood');
    });

    it('routes compare questions and extracts cell codes', () => {
        const p = AG().intent('compare 34M-TML-MTML and 34M-TML-MTMM');
        expect(p.skill).toBe('compareCells');
        expect(p.params.codes).toContain('34M-TML-MTML');
        expect(p.params.codes.length).toBe(2);
    });

    it('routes what-if questions to scenario', () => {
        const p = AG().intent('what if we add 30 green to 34M-TML-MTML');
        expect(p.skill).toBe('scenario');
        expect(p.params.code).toBe('34M-TML-MTML');
        expect(p.params.delta).toBe(30);
        expect(p.params.field).toBe('green');
    });

    it('routes assess/brief questions to assessCell', () => {
        const p = AG().intent('give me a brief on 34M-TML-MTML');
        expect(p.skill).toBe('assessCell');
        expect(p.params.code).toBe('34M-TML-MTML');
    });

    it('defaults investment phrasing to investmentPotential', () => {
        const p = AG().intent('best areas to invest');
        expect(p.skill).toBe('findCells');
        expect(p.params.index).toBe('investmentPotential');
    });
});

describe('DishaAgent.applyScenario() — what-if simulation', () => {
    it('lifts resilience/sustainability when green is added, with deltas', () => {
        const features = { green: 30, walkability: 50, flood_risk: 40, infra_maturity: 50, noise_estimate: 40, digital_readiness: 50 };
        const sim = AG().applyScenario(features, { green: 40 });
        expect(sim.after.green).toBe(70);
        expect(sim.indicesAfter.climateResilience.value).toBeGreaterThan(sim.indicesBefore.climateResilience.value);
        expect(sim.deltas.sustainability).toBeGreaterThan(0);
    });

    it('clamps fields to 0..100 and ignores unknown/missing fields', () => {
        const sim = AG().applyScenario({ green: 90 }, { green: 50, nonsense: 10 });
        expect(sim.after.green).toBe(100);
        expect(sim.after).not.toHaveProperty('nonsense');
    });
});

describe('DishaAgent.rankByIndex()', () => {
    it('orders cells by an index value descending', () => {
        const cells = [
            { code: 'A', features: { flood_risk: 90, population_proxy: 80, infra_maturity: 50 } },
            { code: 'B', features: { flood_risk: 10, population_proxy: 80, infra_maturity: 50 } },
        ];
        const ranked = AG().rankByIndex(cells, 'disasterRisk');
        expect(ranked[0].code).toBe('A');     // higher disaster risk first
        expect(ranked[0].indexValue).toBeGreaterThan(ranked[1].indexValue);
    });
});

describe('DishaAgent.skills()', () => {
    it('publishes the skill catalogue', () => {
        const ids = AG().skills().map(s => s.id);
        expect(ids).toEqual(expect.arrayContaining(['findCells', 'exposure', 'serviceGaps', 'assessCell', 'compareCells', 'scenario']));
    });
});
