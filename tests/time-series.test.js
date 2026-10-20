import { describe, it, expect, afterEach, vi } from 'vitest';

// Temporal cell-store datasets (spec.time): loading, per-step GeoJSON
// properties, the inspector's series helpers and the time slider's timeline.
const CS = globalThis.CellStore;
const CL = globalThis.CellLayers;
const TS = globalThis.TimeSlider;

const STEPS = ['2025-01', '2025-02', '2025-03'];
const SPEC = {
    id: 'lst_monthly', title: 'LST', level: 6, group: 'Time series',
    fields: [
        { key: 'lst_day_c', label: 'Daytime LST', type: 'number', agg: 'mean', unit: '°C', domain: [20, 45], ramp: 'heat' },
        { key: 'lst_night_c', label: 'Night LST', type: 'number', agg: 'mean', unit: '°C', domain: [10, 30], ramp: 'heat' },
    ],
    default: { field: 'lst_day_c', extrude: false, heightM: 600 },
    time: { unit: 'month', steps: STEPS, default: '2025-03' },
    regions: [
        { name: 'a', json: 'lst_monthly/a.json' },
        { name: 'b', json: 'lst_monthly/b.json' },
    ],
};
const A = CS.cellCode(6, 22.7196, 75.8577);
const B = CS.cellCode(6, 23.2599, 77.4126);

function mockFetch(routes) {
    return vi.fn(async (url) => {
        for (const [frag, body] of routes) {
            if (String(url).includes(frag)) return new Response(JSON.stringify(body), { status: 200 });
        }
        return new Response('nf', { status: 404 });
    });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('CellStore temporal datasets', () => {
    it('isTemporal / stepKey', () => {
        expect(CS.isTemporal(SPEC)).toBe(true);
        expect(CS.isTemporal({ ...SPEC, time: undefined })).toBe(false);
        expect(CS.isTemporal({ ...SPEC, time: { unit: 'month', steps: [] } })).toBe(false);
        expect(CS.stepKey('ndvi', 4)).toBe('ndvi@4');
    });

    it('loads series and realigns a region that has fewer steps', async () => {
        globalThis.fetch = mockFetch([
            ['catalog.json', { version: 1, datasets: [SPEC] }],
            ['lst_monthly/a.json', { level: 6, times: STEPS, cells: [A],
                columns: { lst_day_c: [[30, null, 41]], lst_night_c: [[15, 16, 22]] } }],
            // Region b was built before March existed and starts in February.
            ['lst_monthly/b.json', { level: 6, times: ['2025-02'], cells: [B],
                columns: { lst_day_c: [[33]], lst_night_c: [[18]] } }],
        ]);
        await CS.init();
        const t = await CS.load('lst_monthly');
        expect(t.times).toEqual(STEPS);
        expect(t.columns.lst_day_c).toEqual([[30, null, 41], [null, 33, null]]);
        const row = await CS.rowAt('lst_monthly', 22.7196, 75.8577);
        expect(row.lst_night_c).toEqual([15, 16, 22]);
    });

    it('toGeoJSON writes one property per step and skips all-null series', () => {
        const table = { level: 6, times: STEPS, cells: [A, B],
            columns: { lst_day_c: [[30, null, 41], [null, null, null]], lst_night_c: [[1, 2, 3], [4, 5, 6]] } };
        const fc = CS.toGeoJSON(SPEC, table, 'lst_day_c');
        expect(fc.features).toHaveLength(1);
        const p = fc.features[0].properties;
        expect(p['lst_day_c@0']).toBe(30);
        expect(p['lst_day_c@1']).toBe(null);
        expect(p['lst_day_c@2']).toBe(41);
        expect(p['lst_night_c@2']).toBe(3);
        expect(p.lst_day_c).toBeUndefined();
        // No field filter → every cell.
        expect(CS.toGeoJSON(SPEC, table, null).features).toHaveLength(2);
    });

    it('dataDomain spans every step of a series column', () => {
        expect(CS.dataDomain({ type: 'number' }, [[3, null, 9], [1, 4]])).toEqual([1, 9]);
    });
});

describe('CellLayers temporal helpers', () => {
    const props = { digipin: '34P-LLM', 'lst_day_c@0': 30, 'lst_day_c@1': 'null', 'lst_day_c@2': 41,
        'lst_night_c@0': 15, 'lst_night_c@1': 16, 'lst_night_c@2': 22 };

    it('defaultStep follows time.default, else the latest step', () => {
        expect(CL.defaultStep(SPEC)).toBe(2);
        expect(CL.defaultStep({ ...SPEC, time: { unit: 'month', steps: STEPS, default: '2025-01' } })).toBe(0);
        expect(CL.defaultStep({ ...SPEC, time: { unit: 'month', steps: STEPS } })).toBe(2);
        expect(CL.defaultStep({ id: 'x' })).toBe(0);
    });

    it('propsAt reduces a cell to one step (feeds the inspector rows)', () => {
        expect(CL.propsAt(SPEC, props, 0)).toEqual({ digipin: '34P-LLM', lst_day_c: 30, lst_night_c: 15 });
        const rows = CL.inspectorRows(SPEC, CL.propsAt(SPEC, props, 1), 'lst_day_c');
        expect(rows.map(r => r.label)).toEqual(['Night LST']);   // null day value skipped
    });

    it('seriesOf / seriesText read the whole history back', () => {
        expect(CL.seriesOf(SPEC, props, 'lst_day_c')).toEqual([30, null, 41]);
        expect(CL.seriesText(SPEC, props).split('\n')).toEqual([
            'step,lst_day_c,lst_night_c', '2025-01,30,15', '2025-02,,16', '2025-03,41,22',
        ]);
    });

    it('sparkline breaks the path at gaps and maps the domain to the box', () => {
        const s = CL.sparkline([0, 10, null, 5], 30, 10, [0, 10]);
        expect(s.points).toEqual([[0, 10], [10, 0], null, [30, 5]]);
        expect(s.path).toBe('M0 10L10 0M30 5');
        expect([s.lo, s.hi]).toEqual([0, 10]);
        // Values outside the declared domain widen it rather than overflow.
        expect(CL.sparkline([-5, 20], 10, 10, [0, 10])).toMatchObject({ lo: -5, hi: 20 });
        expect(CL.sparkline([null, null], 10, 10).path).toBe('');
        expect(CL.sparkline([7, 7], 10, 10).points).toEqual([[0, 10], [10, 10]]);
    });

    it('colour/height expressions point at a step property', () => {
        const f = { ...SPEC.fields[0], key: 'lst_day_c@2' };
        expect(JSON.stringify(CL.colorExpr(f))).toContain('"lst_day_c@2"');
        expect(JSON.stringify(CL.heightExpr(f, 600))).toContain('"lst_day_c@2"');
    });
});

describe('TimeSlider timeline', () => {
    it('mergeSteps unions and sorts', () => {
        expect(TS.mergeSteps([['2025-02', '2025-03'], ['2025-01', '2025-03'], null]))
            .toEqual(['2025-01', '2025-02', '2025-03']);
    });

    it('indexFor holds the latest earlier step', () => {
        const s = ['2025-01', '2025-03', '2025-05'];
        expect(TS.indexFor(s, '2025-03')).toBe(1);
        expect(TS.indexFor(s, '2025-04')).toBe(1);
        expect(TS.indexFor(s, '2024-12')).toBe(0);
        expect(TS.indexFor(s, '2026-01')).toBe(2);
    });

    it('formatStep is human-readable', () => {
        expect(TS.formatStep('2025-04')).toBe('Apr 2025');
        expect(TS.formatStep('2025-04-09')).toBe('9 Apr 2025');
        expect(TS.formatStep('2025')).toBe('2025');
        expect(TS.formatStep('week 3')).toBe('week 3');
    });

    it('gapFor fits the bar between the side panels', () => {
        // 1400 px viewport, sidebar ends at 325, detail panel starts at 965.
        expect(TS.gapFor(1400, 325, 965)).toEqual({ left: 365, width: 560 });
        expect(TS.gapFor(1400, 0, 1400)).toEqual({ left: 420, width: 560 });
        // Too narrow a gap → centred over the viewport instead.
        expect(TS.gapFor(800, 325, 500)).toEqual({ left: 120, width: 560 });
        expect(TS.gapFor(400, 0, 400).width).toBe(376);
    });

    it('stays hidden with no temporal layer active', () => {
        TS.sync();
        expect(TS.steps()).toEqual([]);
        expect(document.getElementById('cell-time-slider')).toBeNull();
    });
});
