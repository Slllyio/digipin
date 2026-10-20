import { describe, it, expect, vi } from 'vitest';

// CellLayers is exposed by tests/setup.js. Map rendering needs a live
// MapLibre map, so these lock the pure paint/legend builders that make the
// renderer generic over any registry field spec.
const CL = globalThis.CellLayers;

describe('CellLayers.colorExpr()', () => {
    it('numbers → null-guarded linear ramp across the domain', () => {
        const e = CL.colorExpr({ key: 'risk', type: 'number', domain: [0, 100], ramp: 'reds' });
        expect(e[0]).toBe('case');
        const interp = e[3];
        expect(interp[0]).toBe('interpolate');
        const stops = interp.slice(3);
        expect(stops.filter((_, i) => i % 2 === 0)).toEqual([0, 25, 50, 75, 100]);
        expect(stops.filter((_, i) => i % 2 === 1)).toEqual(CL.RAMPS.reds);
    });

    it('survives a degenerate or missing domain', () => {
        const flat = CL.colorExpr({ key: 'v', type: 'number', domain: [5, 5] })[3].slice(3);
        expect(flat[0]).toBe(5);
        expect(flat[flat.length - 2]).toBe(6);
        expect(CL.colorExpr({ key: 'v', type: 'number' })[3][3]).toBe(0);
    });

    it('categories → match with spec colours, palette for the rest, grey fallback', () => {
        const e = CL.colorExpr({ key: 'los', type: 'category', domain: ['A', 'B'], colors: { A: '#31a354' } });
        expect(e[0]).toBe('match');
        expect(e.slice(2, 4)).toEqual(['A', '#31a354']);
        expect(e[4]).toBe('B');
        expect(e[5]).toMatch(/^#/);
        expect(e[e.length - 1]).toBe('#9ca3af');
    });

    it('booleans → only true cells are coloured', () => {
        const e = CL.colorExpr({ key: 'flag', type: 'boolean' });
        expect(e).toEqual(['case', ['==', ['get', 'flag'], true], '#d7301f', 'rgba(0,0,0,0)']);
    });
});

describe('CellLayers.heightExpr()', () => {
    it('scales a number linearly to heightM with a small floor', () => {
        const e = CL.heightExpr({ key: 'v', type: 'number', domain: [0, 50] }, 300);
        expect(e[0]).toBe('*');
        expect(e[1]).toBe(300);
        expect(JSON.stringify(e)).toContain('0.02');
        expect(JSON.stringify(e)).toContain('50');
    });
    it('booleans extrude only when true; categories get a fixed block', () => {
        expect(CL.heightExpr({ key: 'f', type: 'boolean' }, 200)).toEqual(['case', ['==', ['get', 'f'], true], 200, 0]);
        expect(CL.heightExpr({ key: 'c', type: 'category' }, 200)).toBe(70);
    });
});

describe('CellLayers.legendStops()', () => {
    it('labels the ramp ends of a number field', () => {
        const s = CL.legendStops({ key: 'v', type: 'number', domain: [0, 100], ramp: 'greens' });
        expect(s).toHaveLength(5);
        expect(s[0]).toEqual({ color: CL.RAMPS.greens[0], label: '0' });
        expect(s[4].label).toBe('100');
        expect(CL.legendStops({ key: 'v', type: 'number', domain: [0, 0.5] })[2].label).toBe('0.25');
    });
    it('lists categories', () => {
        expect(CL.legendStops({ key: 'c', type: 'category', domain: ['x', 'y'] }).map(s => s.label)).toEqual(['x', 'y']);
    });
});

describe('CellLayers lifecycle (no map)', () => {
    it('show() is a no-op without a map', async () => {
        expect(await CL.show('scores')).toBe(false);
        expect(CL.isVisible('scores')).toBe(false);
        expect(CL.active()).toEqual([]);
    });
});

describe('CellLayers.panelGroups()', () => {
    it('groups registry datasets by spec.group', () => {
        globalThis.CellStore.register({ id: 'user_g', title: 'G', level: 8,
            fields: [{ key: 'count', label: 'Count', type: 'number', agg: 'count' }] },
        { level: 8, cells: ['34PLLMPK'], columns: { count: [1] } });
        const g = CL.panelGroups().find(x => x.group === 'Ingested data');
        expect(g.rows).toContainEqual({ id: 'user_g', title: 'G', level: 8 });
        globalThis.CellStore.unregister('user_g');
    });

    it('lists only datasets that cover the given city', () => {
        const spy = vi.spyOn(globalThis.CellStore, 'datasetsFor').mockImplementation(city =>
            [{ id: 'a', title: 'A', level: 7, regions: [{ name: 'pune' }] }]
                .filter(d => !city || d.regions.some(r => r.name === city.region)));
        expect(CL.panelGroups({ region: 'pune' })[0].rows.map(r => r.id)).toEqual(['a']);
        expect(CL.panelGroups({ region: 'guna' })).toEqual([]);
        spy.mockRestore();
    });
});

describe('CellLayers.filterExpr()', () => {
    const cat = { key: 'los', type: 'category', domain: ['A', 'B'] };
    it('nothing hidden, or a numeric field → no filter', () => {
        expect(CL.filterExpr(cat, [])).toBeNull();
        expect(CL.filterExpr(cat, undefined)).toBeNull();
        expect(CL.filterExpr({ key: 'v', type: 'number' }, ['A'])).toBeNull();
    });
    it('hidden categories are excluded by string value', () => {
        expect(CL.filterExpr(cat, ['A', 'B'])).toEqual(
            ['!', ['in', ['to-string', ['get', 'los']], ['literal', ['A', 'B']]]]);
    });
});

describe('CellLayers inspector helpers', () => {
    const spec = {
        title: 'Walkability', level: 8, source: 'OSM', license: 'ODbL',
        fields: [
            { key: 'score', label: 'Score', type: 'number', unit: 'pts' },
            { key: 'band', label: 'Band', type: 'category' },
            { key: 'note', label: 'Note', type: 'category' },
        ],
    };
    const props = { digipin: 'ABC-123', score: 61.2345, band: 'High', note: '' };

    it('rows skip empty values, round numbers, add units and flag the active field', () => {
        const rows = CL.inspectorRows(spec, props, 'score');
        expect(rows).toEqual([
            { label: 'Score', value: '61.23 pts', primary: true },
            { label: 'Band', value: 'High', primary: false },
        ]);
    });
    it('copy text has a header, one line per field and the source', () => {
        expect(CL.inspectorText(spec, props)).toBe(
            'Walkability · ABC-123 · L8\nScore: 61.23 pts\nBand: High\nSource: OSM (ODbL)');
    });
});
