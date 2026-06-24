import { describe, it, expect } from 'vitest';

// Compare.compareBriefModel reuses SiteBrief.build (both loaded by setup.js).
const PINS = [
    { cell: { code: 'A' }, data: { scores: {
        livability: { value: 80, label: 'Livability' },
        flood_risk: { value: 20, label: 'Flood Risk' },
    } } },
    { cell: { code: 'B' }, data: { scores: {
        livability: { value: 50, label: 'Livability' },
        growth: { value: 60, label: 'Growth' },
    } } },
];

describe('Compare.compareBriefModel', () => {
    it('builds a row-aligned model across pinned cells', () => {
        const m = Compare.compareBriefModel(PINS);
        expect(m.cells).toHaveLength(2);
        expect(m.cells[0].code).toBe('A');
        // Union of metric keys across both cells, first-seen order.
        expect(m.metricKeys).toEqual(expect.arrayContaining(['livability', 'flood_risk', 'growth']));
        expect(m.cells[0].metrics.livability.value).toBe(80);
        expect(m.cells[1].metrics.growth.value).toBe(60);
        // B has no flood_risk metric → absent for that cell (renders as —).
        expect(m.cells[1].metrics.flood_risk).toBeUndefined();
    });

    it('is safe on empty input', () => {
        expect(Compare.compareBriefModel([])).toEqual({ cells: [], metricKeys: [] });
        expect(Compare.compareBriefModel(null)).toEqual({ cells: [], metricKeys: [] });
    });
});
