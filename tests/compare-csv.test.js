import { describe, it, expect } from 'vitest';

// Compare is exposed on globalThis by tests/setup.js. buildCSV is pure (takes the
// pinned array), so it's testable without map/DOM state.
const C = globalThis.Compare;

const PINNED = [
    {
        cell: { code: '4FK-K8M-9P2', center: { lat: 22.71, lng: 75.85 } },
        data: {
            address: { area: 'Rajwada', city: 'Indore' },
            scores: { walkability: { value: 82, label: 'Walkability' },
                safety: { value: 64, label: 'Safety' } },
        },
    },
    {
        cell: { code: '4FK-K90-1Q3', center: { lat: 22.73, lng: 75.88 } },
        data: {
            address: { area: 'Vijay Nagar', city: 'Indore' },
            scores: { walkability: { value: 70, label: 'Walkability' } }, // no safety
        },
    },
];

describe('Compare.buildCSV', () => {
    const csv = C.buildCSV(PINNED);
    const lines = csv.split('\n');

    it('has a Metric header row with each cell code', () => {
        expect(lines[0]).toBe('Metric,4FK-K8M-9P2,4FK-K90-1Q3');
    });

    it('includes address + coordinate rows', () => {
        expect(csv).toContain('Address,"Rajwada, Indore","Vijay Nagar, Indore"');
        expect(csv).toContain('Latitude,22.71,22.73');
    });

    it('emits one row per score (union of keys) with blanks for missing values', () => {
        const walk = lines.find(l => l.startsWith('Walkability,'));
        const safe = lines.find(l => l.startsWith('Safety,'));
        expect(walk).toBe('Walkability,82,70');
        expect(safe).toBe('Safety,64,');   // second cell has no safety → blank
    });

    it('escapes fields containing commas with quotes', () => {
        expect(csv).toContain('"Rajwada, Indore"');
    });
});
