import { describe, it, expect } from 'vitest';

// MobilityScore is exposed on globalThis by tests/setup.js. Pure helpers — kept
// in sync with pipeline/safety/mobility.py access_class().
const M = globalThis.MobilityScore;

describe('MobilityScore.accessClass', () => {
    it('bands a 0..100 risk into Smooth / Constrained / Restricted', () => {
        expect(M.accessClass(10)).toBe('Smooth');
        expect(M.accessClass(50)).toBe('Constrained');
        expect(M.accessClass(80)).toBe('Restricted');
    });
    it('never labels a sealable pocket Smooth', () => {
        expect(M.accessClass(10, true)).toBe('Restricted');
        expect(M.accessClass(null, true)).toBe('Restricted');
    });
    it('returns null for an unknown risk', () => {
        expect(M.accessClass(null)).toBeNull();
        expect(M.accessClass(NaN)).toBeNull();
    });
});

describe('MobilityScore.classColor', () => {
    it('gives each class a distinct colour and transparent for unknown', () => {
        const colors = M.CLASSES.map(c => M.classColor(c.key));
        expect(new Set(colors).size).toBe(M.CLASSES.length);
        expect(M.classColor('Restricted')).toBe('#b30000');
        expect(M.classColor('bogus')).toBe('rgba(0,0,0,0)');
    });
});
