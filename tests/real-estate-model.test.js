/**
 * RealEstateModel — research-grounded growth/appreciation model over live data.
 * Validates factor extraction, weighting, driver attribution, the appreciation
 * band, and graceful behaviour with sparse data. All functions are pure.
 */
import { describe, it, expect } from 'vitest';

const REM = globalThis.RealEstateModel;

function cell(scores = {}, extra = {}) {
    const wrap = {};
    for (const [k, v] of Object.entries(scores)) wrap[k] = { value: v, label: k };
    return { scores: wrap, ...extra };
}

describe('RealEstateModel.factors()', () => {
    it('extracts only factors that have data, oriented 0..100', () => {
        const fs = REM.factors(cell({ connectivity: 80, walkability: 60 }));
        const keys = fs.map(f => f.key);
        expect(keys).toContain('accessibility');
        expect(keys).toContain('walkability');
        expect(fs.every(f => f.value >= 0 && f.value <= 100)).toBe(true);
        // factors with no backing score are dropped
        expect(keys).not.toContain('schools');
    });

    it('orients flood as SAFETY (higher = safer) from the live peak ratio', () => {
        const safe = REM.factors(cell({}, { realtime: { flood: { peak_ratio: 1.0 } } }))
            .find(f => f.key === 'floodSafety');
        const risky = REM.factors(cell({}, { realtime: { flood: { peak_ratio: 4.0 } } }))
            .find(f => f.key === 'floodSafety');
        expect(safe.value).toBeGreaterThan(90);    // 1× baseline → safe
        expect(risky.value).toBeLessThan(10);       // 4× baseline → severe
    });

    it('falls back to the flood_risk score and inverts it to safety', () => {
        const f = REM.factors(cell({ flood_risk: 80 })).find(x => x.key === 'floodSafety');
        expect(f.value).toBe(20);                    // high risk → low safety
    });
});

describe('RealEstateModel.growthPotential()', () => {
    it('scores a strong location high and a weak one low', () => {
        const strong = REM.growthPotential(cell({
            connectivity: 90, commercial: 85, walkability: 80, green: 75,
            development_potential: 80, real_estate_growth: 70,
        }));
        const weak = REM.growthPotential(cell({
            connectivity: 20, commercial: 15, walkability: 25, green: 30,
            development_potential: 20, real_estate_growth: 10,
        }));
        expect(strong.score).toBeGreaterThan(70);
        expect(weak.score).toBeLessThan(35);
    });

    it('ranks drivers by signed contribution (helps vs drags)', () => {
        const gp = REM.growthPotential(cell({
            connectivity: 95, commercial: 90, flood_risk: 90 /* risky → flood drag */,
        }));
        // strongest positive is an access/jobs driver; flood safety is a negative
        expect(gp.drivers[0].contribution).toBeGreaterThan(0);
        const flood = gp.drivers.find(d => d.key === 'floodSafety');
        expect(flood.contribution).toBeLessThan(0);
    });

    it('reports confidence from the breadth of available factors', () => {
        const few = REM.growthPotential(cell({ connectivity: 50 }));
        expect(few.confidence).toBe('low');
        const many = REM.growthPotential(cell({
            connectivity: 60, commercial: 60, walkability: 60, green: 60, education_score: 60,
            healthcare_access: 60, development_potential: 60, real_estate_growth: 60, noise_estimate: 60,
        }));
        expect(many.confidence).toBe('high');
    });

    it('returns no_data when nothing is available', () => {
        const gp = REM.growthPotential({});
        expect(gp.score).toBeNull();
        expect(gp.confidence).toBe('no_data');
    });
});

describe('RealEstateModel.projectAppreciation()', () => {
    it('maps a neutral score to the baseline rate', () => {
        const a = REM.projectAppreciation(50, { baselinePct: 6, spreadPct: 6, confidence: 'high' });
        expect(a.midPct).toBeCloseTo(6, 5);
        expect(a.lowPct).toBeLessThan(a.midPct);
        expect(a.highPct).toBeGreaterThan(a.midPct);
    });

    it('lifts the band above baseline for a strong score', () => {
        const a = REM.projectAppreciation(80, { baselinePct: 6, spreadPct: 6 });
        expect(a.midPct).toBeCloseTo(9.6, 1);
    });

    it('widens the band when confidence is low', () => {
        const hi = REM.projectAppreciation(60, { confidence: 'high' });
        const lo = REM.projectAppreciation(60, { confidence: 'low' });
        expect((lo.highPct - lo.lowPct)).toBeGreaterThan(hi.highPct - hi.lowPct);
    });

    it('returns null for a null score', () => {
        expect(REM.projectAppreciation(null)).toBeNull();
    });
});

describe('RealEstateModel intent profiles', () => {
    // A cell that's great to LIVE in (quiet, green, schools, flood-safe) but a
    // weak development play (no pipeline / dev potential), and vice-versa.
    const liveable = cell({
        green: 90, walkability: 85, schools: 88, healthcare: 80, noise_estimate: 90,
        flood_risk: 10, development_potential: 20, real_estate_growth: 15, connectivity: 50,
    });
    const developable = cell({
        development_potential: 92, redevelopment_index: 88, real_estate_growth: 85,
        connectivity: 80, green: 25, noise_estimate: 30, schools: 20, walkability: 40,
    });

    it('balanced default leaves base behaviour unchanged', () => {
        const a = REM.growthPotential(liveable);
        const b = REM.growthPotential(liveable, { intent: 'balanced' });
        expect(a.score).toBe(b.score);
    });

    it('re-weights: "live" rates a liveable cell higher than "build" does', () => {
        const live = REM.outlook(liveable, { intent: 'live' }).score;
        const build = REM.outlook(liveable, { intent: 'build' }).score;
        expect(live).toBeGreaterThan(build);
    });

    it('re-weights: "build" rates a developable cell higher than "live" does', () => {
        const build = REM.outlook(developable, { intent: 'build' }).score;
        const live = REM.outlook(developable, { intent: 'live' }).score;
        expect(build).toBeGreaterThan(live);
    });

    it('records the active intent in the outlook', () => {
        expect(REM.outlook(liveable, { intent: 'invest' }).intent).toBe('invest');
        expect(REM.outlook(liveable, { intent: 'nonsense' }).intent).toBe('balanced');
    });
});

describe('RealEstateModel.verdictSentence() & builtForm()', () => {
    it('summarises built form from building intelligence', () => {
        const data = cell({ redevelopment_index: 70 }, { buildingIntel: {
            buildings: { totalCount: 88, avgLevels: 2.4 }, metrics: { fsi: 1.3, urbanForm: 'Open Midrise' },
        } });
        const bf = REM.builtForm(data);
        expect(bf.text).toContain('88 buildings');
        expect(bf.text).toContain('FSI 1.3');
        expect(bf.redevelopment).toBe(70);
    });

    it('produces a plain-English verdict that names drivers', () => {
        const o = REM.outlook(cell({ connectivity: 90, commercial: 85, flood_risk: 80 }));
        const s = REM.verdictSentence(o, {});
        expect(s).toMatch(/\/100/);
        expect(s.toLowerCase()).toContain('lifted by');
    });

    it('degrades gracefully with no data', () => {
        expect(REM.verdictSentence(REM.outlook({}), {})).toMatch(/Not enough/);
    });
});

describe('RealEstateModel.outlook()', () => {
    it('bundles score, label, appreciation and top drivers', () => {
        const o = REM.outlook(cell({
            connectivity: 88, commercial: 82, walkability: 78, green: 70,
            development_potential: 75, real_estate_growth: 65, flood_risk: 70,
        }));
        expect(o.score).toBeGreaterThan(55);
        expect(o.label).toMatch(/upside|Stable/);
        expect(o.appreciation.midPct).toBeGreaterThan(6);
        expect(o.topPositives.length).toBeGreaterThan(0);
        expect(o.topNegatives.some(d => d.key === 'floodSafety')).toBe(true);
    });

    it('labels bands across the range', () => {
        expect(REM.outlookLabel(75).band).toBe('strong');
        expect(REM.outlookLabel(60).band).toBe('above');
        expect(REM.outlookLabel(50).band).toBe('stable');
        expect(REM.outlookLabel(35).band).toBe('soft');
        expect(REM.outlookLabel(10).band).toBe('weak');
        expect(REM.outlookLabel(null).band).toBe('unknown');
    });
});
