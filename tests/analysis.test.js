import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

// Analysis, AnalysesPanel and DigiPin are exposed by tests/setup.js.
const A = globalThis.Analysis;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CELLS = path.join(__dirname, '../data/cells');
const CATALOG = JSON.parse(readFileSync(path.join(CELLS, 'catalog.json'), 'utf-8'));

// A store over the committed data/cells files, so the built-ins run on real data.
const realStore = {
    get: (id) => CATALOG.datasets.find(d => d.id === id) || null,
    load: async (id) => {
        const spec = CATALOG.datasets.find(d => d.id === id);
        if (!spec) return null;
        // Regions are catalogued alphabetically, so pick the Indore region by
        // name (bbox match as fallback) rather than trusting the first entry.
        const regions = spec.regions || [];
        const region = regions.find(r => r.name === 'indore_pilot')
            || regions.find(r => r.bbox && r.bbox.south <= 22.7196 && 22.7196 <= r.bbox.north
                && r.bbox.west <= 75.8577 && 75.8577 <= r.bbox.east)
            || regions[0];
        if (!region) return null;
        const read = (rel) => {
            const buf = readFileSync(path.join(CELLS, rel));
            return JSON.parse((rel.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf-8'));
        };
        const keys = region.shards && region.shards.keys;
        if (!keys) return read(region.json);
        // Sharded region: concatenate the per-prefix tables into one.
        const parts = keys.map(k => read(region.json.replace('{prefix}', k)));
        const merged = { ...parts[0], cells: [], columns: {} };
        for (const pt of parts) {
            merged.cells.push(...(pt.cells || []));
            for (const [f, col] of Object.entries(pt.columns || {})) {
                (merged.columns[f] = merged.columns[f] || []).push(...col);
            }
        }
        return merged;
    },
};

// A tiny hand-made store: 4 L7 cells under one L6 parent + 1 outside.
const L6 = '34PLL5';
const SPEC_S = { id: 's', title: 'S', level: 6, fields: [
    { key: 'good', label: 'Good', type: 'number', domain: [0, 100], higherIs: 'better' },
    { key: 'bad', label: 'Bad', type: 'number', domain: [0, 100], higherIs: 'worse' },
] };
const SPEC_T = { id: 't', title: 'T', level: 7, fields: [
    { key: 'risk', label: 'Risk', type: 'number', domain: [0, 100], higherIs: 'worse' },
    { key: 'los', label: 'LOS', type: 'category' },
    { key: 'flag', label: 'Flag', type: 'boolean' },
] };
const TABLES = {
    s: { level: 6, cells: [L6, '34PLL6'], columns: { good: [80, 20], bad: [10, 90] } },
    t: { level: 7, cells: [`${L6}2`, `${L6}3`, `${L6}8`, '34PLL6F'],
        columns: { risk: [20, 40, 60, 100], los: ['A', 'C', 'C', 'F'], flag: [true, false, true, true] } },
};
const fakeStore = { get: (id) => ({ s: SPEC_S, t: SPEC_T }[id] || null), load: async (id) => TABLES[id] || null };
const NOW = () => new Date('2026-10-20T12:00:00Z');

describe('Analysis.validate()', () => {
    it('accepts every built-in against the committed catalog', () => {
        for (const t of A.BUILTINS) {
            const v = A.validate(t, realStore);
            expect(v.errors).toEqual([]);
            expect(v.template.schema).toBe(A.TEMPLATE_SCHEMA);
        }
    });
    it('names unknown datasets, fields, types and ops', () => {
        const v = A.validate({ title: 'x', sections: [
            { type: 'summary', dataset: 'nope', fields: ['a'] },
            { type: 'rank', dataset: 's', field: 'missing' },
            { type: 'filter', dataset: 's', where: [{ field: 'good', op: '~', value: 1 }] },
            { type: 'pie' },
        ] }, fakeStore);
        expect(v.ok).toBe(false);
        expect(v.errors.join(' ')).toMatch(/no dataset "nope"/);
        expect(v.errors.join(' ')).toMatch(/has no field "missing"/);
        expect(v.errors.join(' ')).toMatch(/op must be/);
        expect(v.errors.join(' ')).toMatch(/"type" must be/);
    });
    it('requires a title and sections, and slugs the id', () => {
        expect(A.validate({ sections: [] }).ok).toBe(false);
        expect(A.validate({ title: 'My Flood Check!', sections: [{ type: 'rank', dataset: 's', field: 'good' }] }).template.id).toBe('my-flood-check');
    });
});

describe('Analysis areas', () => {
    it('parses prefixes with or without dashes, and share-link forms', () => {
        const a = A.parseArea('34P-LL5');
        expect(a.kind).toBe('prefix');
        expect(a.code).toBe('34PLL5');
        expect(A.parseArea('p:34PLL5')).toEqual(a);
        const b = A.parseArea('b:75.8,22.7,75.9,22.8');
        expect(b.kind).toBe('bbox');
        expect(A.parseArea(A.areaParam(b)).bbox).toEqual(b.bbox);
        expect(A.parseArea({ code: 'XYZ' })).toBeNull();
        expect(A.parseArea({ bbox: { west: 1, south: 1, east: 0, north: 2 } })).toBeNull();
    });
    it('selects finer cells under a prefix and the containing cell when coarser', () => {
        const area = A.parseArea({ code: L6 });
        expect(A.cellsInArea(TABLES.t, area)).toEqual([0, 1, 2]);
        expect(A.cellsInArea(TABLES.s, A.parseArea({ code: `${L6}3` }))).toEqual([0]);
    });
    it('selects by cell centre for a bbox', () => {
        const area = A.parseArea({ bbox: DigiPin.decodePartial(L6).bounds });
        expect(A.cellsInArea(TABLES.t, area)).toEqual([0, 1, 2]);
    });
});

describe('Analysis.run()', () => {
    const tpl = { title: 'Test', sections: [
        { type: 'summary', dataset: 't', fields: ['risk'] },
        { type: 'index', terms: [{ dataset: 's', field: 'good', weight: 1 }, { dataset: 't', field: 'risk', weight: 1 }] },
        { type: 'rank', dataset: 't', field: 'risk', order: 'asc', limit: 2 },
        { type: 'filter', dataset: 't', where: [{ field: 'flag', op: '==', value: true }, { field: 'risk', op: '>=', value: 50 }] },
        { type: 'distribution', dataset: 't', field: 'los' },
        { type: 'summary', dataset: 'ghost', fields: ['x'] },
    ] };

    let report;
    beforeEach(async () => {
        report = await A.run(tpl, { code: L6 }, fakeStore, { now: NOW, link: () => 'https://x/app.html?analysis=t' });
    });

    it('produces the report contract', () => {
        expect(report.schema).toBe(A.REPORT_SCHEMA);
        expect(report.ranAt).toBe('2026-10-20T12:00:00.000Z');
        expect(report.area.code).toBe(L6);
        expect(report.sections.map(s => s.type)).toEqual(['summary', 'index', 'rank', 'filter', 'distribution', 'summary']);
        expect(report.sources.map(s => s.id).sort()).toEqual(['s', 't']);
        expect(report.sources.find(s => s.id === 't').cellsInArea).toBe(3);
        expect(report.warnings.join(' ')).toMatch(/"ghost" is not in the cell store/);
        expect(report.sections[5].empty).toBe(true);
    });
    it('summarises only cells in the area', () => {
        expect(report.sections[0].rows[0]).toMatchObject({ key: 'risk', n: 3, mean: 40, min: 20, max: 60 });
    });
    it('joins L7 into its L6 parent and inverts "worse" fields in an index', () => {
        const s = report.sections[1];
        expect(s.level).toBe(6);
        expect(s.rows).toHaveLength(1);
        // good 80 → 80; risk mean 40 → inverted 60; equal weights → 70.
        expect(s.rows[0]).toMatchObject({ digipin: DigiPin.format(L6), score: 70 });
        expect(report.map.layer.values).toEqual([[L6, 70]]);
    });
    it('ranks, filters and counts categories', () => {
        expect(report.sections[2].rows.map(r => r.value)).toEqual([20, 40]);
        expect(report.sections[3]).toMatchObject({ cells: 3, matched: 1, share: 33.3 });
        expect(report.sections[4].buckets).toEqual([{ label: 'A', count: 1 }, { label: 'C', count: 2 }]);
        expect(report.highlights.some(h => /1 of 3 cells/.test(h))).toBe(true);
    });
    it('renders standalone HTML with sources, escaping and no scripts', async () => {
        const evil = await A.run({ title: '<img onerror=x>', sections: [{ type: 'rank', dataset: 't', field: 'risk' }] }, { code: L6 }, fakeStore, { now: NOW });
        const html = A.toHTML(evil);
        expect(html).not.toMatch(/<img onerror/);
        expect(html).not.toMatch(/<script/i);
        expect(A.toHTML(report)).toMatch(/id="src-t"/);
        expect(A.toHTML(report)).toMatch(/<svg/);
    });
    it('throws on a bad area', async () => {
        await expect(A.run(tpl, { code: '' }, fakeStore)).rejects.toThrow(/area/);
    });
});

describe('Analysis built-ins on the committed Indore data', () => {
    it('every built-in runs over central Indore and finds cells', async () => {
        const area = A.parseArea({ code: DigiPin.encode(22.7196, 75.8577).replace(/-/g, '').slice(0, 5) });
        for (const t of A.BUILTINS) {
            const r = await A.run(t, area, realStore, { now: NOW });
            expect(r.sources.length).toBeGreaterThan(0);
            expect(r.sections.filter(s => !s.empty).length).toBeGreaterThan(0);
            expect(r.highlights.length).toBeGreaterThan(0);
        }
    });
});

describe('Analysis share links', () => {
    it('references built-ins by id and inlines custom templates', () => {
        const area = A.parseArea({ code: L6 });
        const q1 = A.shareQuery(A.BUILTINS[0], area);
        expect(q1).toContain(`analysis=${A.BUILTINS[0].id}`);
        expect(A.parseShare(`?${q1}`).template.id).toBe(A.BUILTINS[0].id);
        const custom = { title: 'Mine ✓ हिंदी', sections: [{ type: 'rank', dataset: 's', field: 'good' }] };
        const q2 = A.shareQuery(custom, area);
        expect(q2).toContain('analysis_def=');
        const back = A.parseShare(`?${q2}`);
        expect(back.template.title).toBe('Mine ✓ हिंदी');
        expect(back.area.code).toBe(L6);
        expect(A.parseShare('?analysis=nope&area=p:34P')).toBeNull();
    });
});

describe('AnalysesPanel storage', () => {
    beforeEach(() => localStorage.clear());
    it('saves, overwrites by id, never shadows a built-in, and drops bad entries', () => {
        const P = globalThis.AnalysesPanel;
        expect(P.saveTemplate({ title: 'One', sections: [{ type: 'rank', dataset: 's', field: 'good' }] }).ok).toBe(true);
        P.saveTemplate({ title: 'One', description: 'v2', sections: [{ type: 'rank', dataset: 's', field: 'good' }] });
        expect(P.loadMine()).toHaveLength(1);
        expect(P.loadMine()[0].description).toBe('v2');
        P.saveTemplate({ ...A.BUILTINS[0] });
        expect(P.loadMine().map(t => t.id)).toContain(`${A.BUILTINS[0].id}-mine`);
        localStorage.setItem('digipin_analyses', JSON.stringify([{ nope: 1 }, ...JSON.parse(localStorage.getItem('digipin_analyses'))]));
        expect(P.loadMine()).toHaveLength(2);
        P.removeTemplate('one');
        expect(P.loadMine()).toHaveLength(1);
    });
});
