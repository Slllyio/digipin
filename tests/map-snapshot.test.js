import { describe, it, expect } from 'vitest';

const MS = globalThis.MapSnapshot;

describe('MapSnapshot.keyForToken()', () => {
    it('maps URLState tokens onto Provenance registry keys', () => {
        expect(MS.keyForToken('heat')).toBe('_btn_btn-heat');
        expect(MS.keyForToken('dt:osm_roads')).toBe('osm_roads');
        expect(MS.keyForToken('cell:scores')).toBe('_cell_scores');
        expect(MS.keyForToken('')).toBeNull();
    });
});

describe('MapSnapshot.attributions()', () => {
    const metas = {
        osm_roads: { source: 'OpenStreetMap extract', license: 'ODbL' },
        osm_water: { source: 'OpenStreetMap extract', license: 'ODbL' },
        '_btn_btn-sun': { source: 'Computed solar position' },
    };
    const lookup = (k) => metas[k] || null;
    const nameOf = (t) => ({ 'dt:osm_roads': 'Roads', 'dt:osm_water': 'Water', sun: 'Sun' }[t]);

    it('merges layers that share a source and keeps the licence', () => {
        const out = MS.attributions(['dt:osm_roads', 'dt:osm_water', 'sun'], lookup, nameOf);
        expect(out).toEqual([
            { name: 'Roads, Water', text: 'OpenStreetMap extract · ODbL' },
            { name: 'Sun', text: 'Computed solar position' },
        ]);
    });
    it('skips layers with no provenance', () => {
        expect(MS.attributions(['dt:unknown'], lookup, nameOf)).toEqual([]);
    });
});

describe('MapSnapshot.wrapLines() / layout()', () => {
    const measure = (s) => s.length * 10;
    it('wraps on word boundaries within the width', () => {
        expect(MS.wrapLines('aaa bbb ccc', 70, measure)).toEqual(['aaa bbb', 'ccc']);
        expect(MS.wrapLines('', 70, measure)).toEqual(['']);
    });
    it('footer grows with the number of credit lines', () => {
        const a = MS.layout(500, []);
        const b = MS.layout(500, [{ lines: ['x', 'y', 'z'] }]);
        expect(b.footer - a.footer).toBe(2 * a.lineHeight);
        expect(b.total).toBe(b.head + 500 + b.footer);
    });
});

describe('MapSnapshot.filename()', () => {
    it('slugs the place and stamps the date', () => {
        expect(MS.filename('Indore Central!', new Date('2026-10-20T10:00:00Z'))).toBe('digipin_map_indore-central_2026-10-20.png');
        expect(MS.filename('', new Date('2026-10-20T10:00:00Z'))).toBe('digipin_map_map_2026-10-20.png');
    });
});
