/**
 * Intent-aware render/analyze routing tests (P10).
 *
 * intent() tags each plan with mode: 'map' (paint results) or 'analyze' (text).
 * Ranking skills emit a render payload; run() reports the mode. The actual map
 * painting is browser-only (IntelMapLayer absent in jsdom → no-op), so we assert
 * the mode + render payload, not the canvas. Loaded via tests/setup.js.
 */
import { describe, it, expect } from 'vitest';

const AG = () => globalThis.DishaAgent;

describe('DishaAgent.intent() — map vs analyze mode', () => {
    it('chooses map mode on display cues', () => {
        expect(AG().intent('show flood risk on the map').mode).toBe('map');
        expect(AG().intent('highlight the underserved areas').mode).toBe('map');
        expect(AG().intent('visualize investment potential').mode).toBe('map');
    });

    it('chooses analyze mode on reasoning cues', () => {
        expect(AG().intent('why is this area at risk?').mode).toBe('analyze');
        expect(AG().intent('explain the service gap here').mode).toBe('analyze');
    });

    it('defaults ranking skills to map and single-cell skills to analyze', () => {
        expect(AG().intent('rank the most underserved areas').mode).toBe('map');   // serviceGaps
        expect(AG().intent('top flood risk cells').mode).toBe('map');              // findCells
        expect(AG().intent('assess 34M-TML-MTML').mode).toBe('analyze');           // assessCell
        expect(AG().intent('compare 34M-TML-MTML and 34M-TML-MTMM').mode).toBe('analyze');
    });
});

describe('DishaAgent.run() — render payload + mode', () => {
    const cells = [
        { digipin: { code: 'A' }, geometry: { center: { lat: 22.70, lng: 75.80 } }, features: { flood_risk: 90, population_proxy: 80, infra_maturity: 40 } },
        { digipin: { code: 'B' }, geometry: { center: { lat: 22.71, lng: 75.81 } }, features: { flood_risk: 20, population_proxy: 80, infra_maturity: 40 } },
    ];

    it('findCells returns a cells render payload and map mode', async () => {
        const res = await AG().run('findCells', { index: 'disasterRisk' }, { cells });
        expect(res.mode).toBe('map');
        expect(res.data.render.kind).toBe('cells');
        expect(res.data.render.cells.length).toBe(2);
        expect(res.data.render.cells[0]).toHaveProperty('lat');
        expect(res.data.render.cells[0]).toHaveProperty('score');
        expect(res.rendered).toBe(false);    // no map in jsdom
    });

    it('exposure returns a cells render payload', async () => {
        const res = await AG().run('exposure', { hazard: 'flood' }, { cells });
        expect(res.mode).toBe('map');
        expect(res.data.render.kind).toBe('cells');
        expect(res.data.render.cells.length).toBeGreaterThan(0);
    });

    it('evacuate returns a routes render payload', async () => {
        const res = await AG().run('evacuate', { hazard: 'flood' }, {
            cells: [
                { digipin: { code: 'R' }, geometry: { center: { lat: 22.700, lng: 75.800 } }, features: { flood_risk: 95, population_proxy: 90, infra_maturity: 30 } },
                { digipin: { code: 'S' }, geometry: { center: { lat: 22.704, lng: 75.800 } }, features: { flood_risk: 5, population_proxy: 20, infra_maturity: 80 } },
            ],
        });
        expect(res.mode).toBe('map');
        expect(res.data.render.kind).toBe('routes');
        expect(res.data.render.geojson.type).toBe('FeatureCollection');
    });

    it('single-cell skills run in analyze mode (no paint)', async () => {
        const res = await AG().run('compareCells', { codes: [] }, {});
        expect(res.mode).toBe('analyze');
        expect(res.rendered).toBe(false);
    });
});
