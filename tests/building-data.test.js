import { describe, it, expect } from 'vitest';

// BuildingData is exposed by tests/setup.js (with DigiPin, CellStore and
// CellLayers). These lock the pure join: building centroid → DIGIPIN prefix →
// cell-store row, plus the value → colour/height mappings the twin layer uses.
const BD = globalThis.BuildingData;
const DP = globalThis.DigiPin;
const CS = globalThis.CellStore;

// A ~20 m square footprint in central Indore.
const ring = [[75.8570, 22.7190], [75.8572, 22.7190], [75.8572, 22.7192], [75.8570, 22.7192], [75.8570, 22.7190]];

function tableFor(level, rows) {
    const cells = Object.keys(rows);
    const fields = Object.keys(rows[cells[0]]);
    const columns = Object.fromEntries(fields.map(k => [k, cells.map(c => rows[c][k])]));
    return { level, cells, columns, index: new Map(cells.map((c, i) => [c, i])) };
}

describe('BuildingData.parseKey / options', () => {
    it('splits "<dataset>:<field>" and rejects junk', () => {
        expect(BD.parseKey('scores:walkability')).toEqual({ dataset: 'scores', field: 'walkability' });
        expect(BD.parseKey('bldg:height_m')).toEqual({ dataset: 'bldg', field: 'height_m' });
        expect(BD.parseKey('nope')).toBeNull();
        expect(BD.parseKey(':x')).toBeNull();
        expect(BD.parseKey('')).toBeNull();
    });

    it('lists per-building fields first, then each dataset\'s plottable fields', () => {
        const groups = BD.options([{ id: 'traffic', title: 'Traffic', level: 7, fields: [
            { key: 'congestion_risk', label: 'Congestion', type: 'number' },
            { key: 'note', label: 'Note', type: 'text' },
        ] }]);
        expect(groups[0].id).toBe('bldg');
        expect(groups[0].items.map(i => i.key)).toContain('bldg:height_m');
        expect(groups[1]).toEqual({ id: 'traffic', title: 'Traffic', level: 7,
            items: [{ key: 'traffic:congestion_risk', label: 'Congestion' }] });
    });
});

describe('BuildingData geometry', () => {
    it('centroid ignores the closing vertex', () => {
        const c = BD.centroid(ring);
        expect(c.lng).toBeCloseTo(75.8571, 6);
        expect(c.lat).toBeCloseTo(22.7191, 6);
    });

    it('areaM2 is about 20 m × 22 m for the test square', () => {
        const a = BD.areaM2(ring);
        expect(a).toBeGreaterThan(400);
        expect(a).toBeLessThan(500);
        expect(BD.areaM2([[0, 0], [1, 1]])).toBe(0);
    });
});

describe('BuildingData.heightFromValue', () => {
    it('maps numbers linearly onto 4…max metres, clamped to the domain', () => {
        const f = { type: 'number', domain: [0, 100] };
        expect(BD.heightFromValue(f, 0, 104)).toBe(4);
        expect(BD.heightFromValue(f, 50, 104)).toBe(54);
        expect(BD.heightFromValue(f, 500, 104)).toBe(104);
        expect(BD.heightFromValue(f, null)).toBeNull();
    });
    it('ranks categories by domain order and lifts true booleans', () => {
        const los = { type: 'category', domain: ['A', 'B', 'C'] };
        expect(BD.heightFromValue(los, 'A', 104)).toBe(4);
        expect(BD.heightFromValue(los, 'C', 104)).toBe(104);
        expect(BD.heightFromValue({ type: 'boolean' }, true, 50)).toBe(50);
        expect(BD.heightFromValue({ type: 'boolean' }, false, 50)).toBe(4);
    });
});

describe('BuildingData.annotate (the cell join)', () => {
    const c = BD.centroid(ring);
    const code7 = DP.encode(c.lat, c.lng).replace(/-/g, '').slice(0, 7);
    const spec = { id: 'traffic', title: 'Traffic', level: 7, fields: [
        { key: 'congestion_risk', type: 'number', domain: [0, 100] },
        { key: 'worst_los', type: 'category', domain: ['A', 'F'] },
    ] };
    const table = tableFor(7, { [code7]: { congestion_risk: 80, worst_los: 'F' } });
    const sel = (field) => ({ spec, field: spec.fields.find(f => f.key === field), table });
    const ctx = (color, height) => ({ color, height, cellCode: CS.cellCode, encode: DP.encode });

    it('joins the dataset value of the building\'s DIGIPIN cell and its L10 code', () => {
        const [r] = BD.annotate([{ polygon: ring, height: 9 }], ctx(sel('congestion_risk'), null));
        expect(r.v).toBe(80);
        expect(r.pin).toBe(DP.encode(c.lat, c.lng));
        expect(r.pin.replace(/-/g, '').startsWith(code7)).toBe(true);
        expect(r.hv).toBeUndefined();
    });

    it('gives null (no-data grey) for buildings outside every cell', () => {
        const far = ring.map(([x, y]) => [x + 0.05, y + 0.05]);
        const [r] = BD.annotate([{ polygon: far, height: 9 }], ctx(sel('congestion_risk'), null));
        expect(r.v).toBeNull();
    });

    it('drives height from a field, but keeps real height for bldg:height_m', () => {
        const [r] = BD.annotate([{ polygon: ring, height: 9 }], ctx(null, sel('congestion_risk')));
        expect(r.hval).toBe(80);
        expect(r.hv).toBeCloseTo(4 + 116 * 0.8, 5);
        const hsel = { spec: BD.BUILDING_SPEC, field: BD.BUILDING_SPEC.fields[0] };
        const [r2] = BD.annotate([{ polygon: ring, height: 9 }], ctx(hsel, hsel));
        expect(r2.v).toBe(9);
        expect(r2.hv).toBeNull();
    });

    it('computes per-building fields from the footprint', () => {
        const area = { spec: BD.BUILDING_SPEC, field: BD.BUILDING_SPEC.fields[1] };
        const floors = { spec: BD.BUILDING_SPEC, field: BD.BUILDING_SPEC.fields[2] };
        const [a] = BD.annotate([{ polygon: ring, height: 16 }], ctx(area, null));
        expect(a.v).toBeGreaterThan(400);
        const [f] = BD.annotate([{ polygon: ring, height: 16 }], ctx(floors, null));
        expect(f.v).toBe(5);
    });
});

describe('BuildingData paint + summary', () => {
    it('colours numbers with the CellLayers ramp over `v`', () => {
        const e = BD.colorExpr({ key: 'risk', type: 'number', domain: [0, 100], ramp: 'reds' });
        expect(JSON.stringify(e)).toContain('["get","v"]');
        expect(JSON.stringify(e)).not.toContain('"risk"');
    });
    it('keeps false booleans solid (not transparent like cells)', () => {
        const e = BD.colorExpr({ key: 'flag', type: 'boolean' });
        expect(JSON.stringify(e)).not.toContain('rgba(0,0,0,0)');
    });
    it('summarises numbers (mean/min/max) and categories (mode)', () => {
        const s = BD.summary([{ v: 10 }, { v: 30 }, { v: null }], { type: 'number' });
        expect(s).toMatchObject({ buildings: 3, withData: 2, mean: 20, min: 10, max: 30 });
        const t = BD.summary([{ v: 'F' }, { v: 'F' }, { v: 'A' }], { type: 'category' });
        expect(t.top).toBe('F');
    });
});

describe('OvertureBuildings twin integration', () => {
    const OB = globalThis.OvertureBuildings;
    it('a data driver forces the MapLibre twin renderer', () => {
        expect(OB.chooseRenderer({ light: false, terrain: false, deckAvailable: true, dataDriven: true })).toBe('twin');
    });
    it('value heights are used as-is and joined props ride along', () => {
        const fc = OB.twinGeoJSON([{ polygon: ring, height: 10, hv: 50, v: 80, pin: '34P-LL5-6T5K', cx: 1, cy: 2, area: 440.4 }], 3);
        expect(fc.features[0].properties).toMatchObject({ h: 50, rh: 10, v: 80, pin: '34P-LL5-6T5K', area: 440 });
    });
    it('twinPaint swaps in the data colour and keeps the hover highlight', () => {
        const p = OB.twinPaint(false, ['get', 'v']);
        const s = JSON.stringify(p['fill-extrusion-color']);
        expect(s).toContain('feature-state');
        expect(s).toContain('["get","v"]');
        expect(s).not.toContain('#5cf0ff');
    });
});

describe('BuildingData.exportGeoJSON', () => {
    it('joins every dataset\'s fields onto each building, prefixed by dataset id', () => {
        const c = BD.centroid(ring);
        const code6 = DP.encode(c.lat, c.lng).replace(/-/g, '').slice(0, 6);
        const spec = { id: 'scores', level: 6, fields: [{ key: 'walkability' }, { key: 'flood_risk' }] };
        const table = tableFor(6, { [code6]: { walkability: 71, flood_risk: 12 } });
        const fc = BD.exportGeoJSON([{ polygon: ring, height: 9.04, pin: 'X', hsrc: 'baked', cls: null }],
            [{ spec, table }], CS.cellCode);
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].properties).toMatchObject({
            digipin: 'X', height_m: 9, height_source: 'baked', scores_walkability: 71, scores_flood_risk: 12 });
        expect(fc.features[0].properties.area_m2).toBeGreaterThan(400);
        expect(BD.exportGeoJSON(null, [], CS.cellCode).features).toEqual([]);
    });
});

describe('URLState building drivers', () => {
    const US = globalThis.URLState;
    it('round-trips bc/bh and drops malformed keys', () => {
        const qs = US.stringify({ bcolor: 'scores:flood_risk', bheight: 'bldg:height_m' });
        expect(qs).toContain('bc=scores%3Aflood_risk');
        expect(US.parse('?' + qs)).toMatchObject({ bcolor: 'scores:flood_risk', bheight: 'bldg:height_m' });
        expect(US.parse('?bc=<script>&bh=x')).not.toHaveProperty('bcolor');
    });
});

describe('DISHA colorBuildings action', () => {
    const DA = globalThis.DISHAActions;
    const DT = globalThis.DISHATools;
    it('is parsed with a colon-bearing value and validated', () => {
        const [a] = DA.parseActions('[ACTION] colorBuildings color:scores:flood_risk');
        expect(a).toEqual({ type: 'colorbuildings', params: { color: 'scores:flood_risk' } });
        expect(DT.validateArgs('colorBuildings', a.params).ok).toBe(true);
    });
    it('rejects keys that are not <dataset>:<field>', () => {
        const [r] = DA.executeActions([{ type: 'colorbuildings', params: { color: 'flood' } }]);
        expect(r.ok).toBe(false);
    });
});

describe('BuildingData.stretchField', () => {
    it('fits a number field\'s domain to the view, leaves others alone', () => {
        const f = { key: 'k', type: 'number', domain: [0, 100] };
        expect(BD.stretchField(f, { min: 28, max: 55 }).domain).toEqual([28, 55]);
        expect(BD.stretchField(f, { min: 40, max: 40 })).toBe(f);
        expect(BD.stretchField(f, null)).toBe(f);
        const cat = { key: 'c', type: 'category', domain: ['A'] };
        expect(BD.stretchField(cat, { min: 1, max: 2 })).toBe(cat);
    });
});
