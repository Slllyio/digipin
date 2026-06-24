import { describe, it, expect } from 'vitest';

const CELL_DATA = {
    code: '39J-49L-L8T4',
    scores: {
        livability: { value: 82, label: 'Livability' },
        flood_risk: { value: 25, label: 'Flood Risk' },
        growth: { value: 55.4, label: 'Growth' },
        nodata: { value: undefined, label: 'Skip me' },
    },
    population: { total: 4210.7 },
};

describe('SiteBrief.build', () => {
    it('selects only numeric scores and bands them', () => {
        const m = SiteBrief.build(CELL_DATA, { code: '39J-49L-L8T4' });
        expect(m.code).toBe('39J-49L-L8T4');
        expect(m.metrics).toHaveLength(3); // nodata dropped
        const byKey = Object.fromEntries(m.metrics.map(x => [x.key, x]));
        expect(byKey.livability.band).toBe('Strong'); // ≥70
        expect(byKey.growth.band).toBe('Moderate');   // ≥40
        expect(byKey.flood_risk.band).toBe('Weak');   // <40
        expect(byKey.growth.value).toBe(55);          // rounded
    });

    it('sorts metrics by value descending', () => {
        const m = SiteBrief.build(CELL_DATA, {});
        const values = m.metrics.map(x => x.value);
        expect(values).toEqual([...values].sort((a, b) => b - a));
    });

    it('rolls up population context when present', () => {
        const m = SiteBrief.build(CELL_DATA, {});
        expect(m.population).toBe(4211);
    });

    it('is robust to missing data', () => {
        const m = SiteBrief.build(null, null);
        expect(m.metrics).toEqual([]);
        expect(m.population).toBeNull();
    });

    it('attaches a non-empty note to every metric', () => {
        const m = SiteBrief.build(CELL_DATA, {});
        for (const x of m.metrics) expect(x.note.length).toBeGreaterThan(0);
    });
});

describe('SiteBrief.narrative', () => {
    it('summarises strengths and constraints from the model', () => {
        const m = SiteBrief.build(CELL_DATA, { code: '39J-49L-L8T4' });
        const n = SiteBrief.narrative(m);
        expect(n).toContain('DIGIPIN 39J-49L-L8T4');
        expect(n).toContain('Livability');   // the Strong metric
        expect(n).toContain('Flood Risk');    // the Weak (constraint) metric
        expect(n).toMatch(/4[,.\s]?211/);     // population rolled in (locale-agnostic separator)
    });
    it('handles a model with no metrics', () => {
        const n = SiteBrief.narrative(SiteBrief.build(null, null));
        expect(n.toLowerCase()).toContain('no intelligence scores');
    });
});

describe('SiteBrief.text', () => {
    it('renders a plain-text brief with each metric line', () => {
        const m = SiteBrief.build(CELL_DATA, { code: '39J-49L-L8T4' });
        const txt = SiteBrief.text(m);
        expect(txt).toContain('DigiPin Site Brief');
        expect(txt).toContain('DIGIPIN: 39J-49L-L8T4');
        expect(txt).toContain('Livability: 82/100 (Strong)');
        expect(txt).toContain('Flood Risk: 25/100 (Weak)');
    });

    it('returns an empty string for a null model', () => {
        expect(SiteBrief.text(null)).toBe('');
    });
});
