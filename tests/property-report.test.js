import { describe, it, expect } from 'vitest';

const PR = globalThis.PropertyReport;

describe('PropertyReport', () => {
    it('assemble(): sections, strengths and watch-outs from block values', () => {
        const m = PR.assemble({ value: 180, valuePct: 92, rate: 159840, jobsPct: 85, metro: 6, prem_jobs: 30, prem_metro: 10, prem_noise: -4,
            lossPct: 0.8, loss: 12, flood: 60, wlog: 70, upside: 5, accel: 1.8, gap: 300 });
        expect(m.sections.map(s => s.title)).toEqual(['Land value', 'Access', 'Supply and momentum', 'Risk', 'Outlook']);
        const lv = m.sections[0].rows;
        expect(lv[0].value).toBe('180 (92nd percentile)');
        expect(lv[1].value).toMatch(/₹1\.6 lakh per m²/);
        expect(lv[2].value).toBe('Job reach +30%, Metro walk +10%, Road noise -4%');
        expect(m.strengths).toEqual(['top-fifth land value', 'strong job reach', 'metro within a 10-minute walk', 'building speeding up']);
        expect(m.risks).toEqual(['flood damage ≈ 0.8% of building value a year', 'very high waterlogging']);
        expect(m.verdict).toMatch(/^Strengths: .* Watch: /);
        expect(m.sections[2].rows.find(r => r.label.startsWith('Housing need')).value).toBe('300 homes short');
    });

    it('assemble(): development feasibility rows', () => {
        const m = PR.assemble({ price: 95800, rlv: 120.5, redevGain: 40, far: 0.8, tod: 90, baseFar: 2 });
        const fe = m.sections.find(s => s.title === 'Development feasibility').rows;
        expect(fe[0].value).toBe('₹8,900 per sq ft');
        expect(fe[1].label).toBe('Residual land value at the base FAR of 2');
        expect(fe[1].value).toBe('₹1.2 lakh per m² of plot');
        expect(fe[2].value).toBe('pays, +₹40,000 per m² of plot');
        expect(m.strengths).toContain('rebuilding to the base FAR pays');
        expect(PR.assemble({ rlv: -16.8 }).sections[0].rows[0].value).toBe('−₹16,800 per m² of plot');
    });

    it('assemble(): an empty block still reads sensibly', () => {
        const m = PR.assemble({});
        expect(m.verdict).toBe('No standout strengths. No major risk flags.');
        expect(m.sections.map(s => s.title)).toEqual(['Risk']);                    // "none modelled"
    });

    it('text() and html(): plain text and a self-contained document', () => {
        const base = PR.assemble({ value: 120, valuePct: 60 });
        const m = { ...base, code: '39J4M98', cityLabel: 'Delhi', generatedAt: '2026-10-22', comparables: [{ code: '39J4K54', similarity: 94, differs: [] }], sources: ['Land value'] };
        expect(PR.text(m)).toMatch(/Property report · 39J-4M9-8 · Delhi/);
        expect(PR.text(m)).toMatch(/Comparable blocks: 39J4K54 \(94% similar\)/);
        const h = PR.html(m);
        expect(h).toMatch(/^<!doctype html>/);
        expect(h).not.toMatch(/<script/);
        expect(h).toMatch(/120 \(60th percentile\)/);
    });

    it('pct(): share of blocks below', () => {
        expect(PR.pct([1, 2, 3, 4, NaN], [0, 1, 2, 3, 4], 2)).toBe(50);
        expect(PR.pct([1, 2], [0, 1], 5)).toBeNull();
    });
});
