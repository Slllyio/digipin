import { describe, it, expect, afterEach } from 'vitest';

// ExportDialog is exposed on globalThis by tests/setup.js. summarize/filename/
// FORMATS are pure; open() is exercised once against jsdom for DOM shape.
const ED = globalThis.ExportDialog;

const DATA = {
    categories: {
        food: { features: { restaurants: { count: 12 }, cafes: { count: 0 } } },
        transport: { features: { bus_stop: { count: 5 } } },
    },
    scores: {
        safety: { label: 'Safety', value: 70 },
        green: { label: 'Green', value: 0 },
        broken: null,
    },
    sourceStatus: { osm: 'loaded', waqi: 'unavailable', weather: 'loaded' },
};

afterEach(() => { ED.close(); });

describe('ExportDialog.summarize()', () => {
    it('counts only feature types with data, all numeric scores, loaded sources', () => {
        const s = ED.summarize(DATA);
        expect(s.featureTypes).toBe(2);     // cafes count=0 excluded
        expect(s.featureTotal).toBe(17);    // 12 + 5
        expect(s.scores).toBe(2);           // null score excluded
        expect(s.sources).toBe(2);          // 'unavailable' excluded
    });

    it('is zero-safe on empty/missing data', () => {
        expect(ED.summarize({})).toEqual({ featureTypes: 0, featureTotal: 0, scores: 0, sources: 0 });
        expect(ED.summarize(null).featureTypes).toBe(0);
    });
});

describe('ExportDialog.filename()', () => {
    it('builds per-format names from the dashless code', () => {
        expect(ED.filename('geojson', '4P3-JK8-39LM')).toBe('digipin_4P3JK839LM.geojson');
        expect(ED.filename('csv', '4P3JK8')).toBe('digipin_4P3JK8.csv');
        expect(ED.filename('json', '4P3JK8')).toBe('digipin_4P3JK8.json');
    });
});

describe('ExportDialog.FORMATS', () => {
    it('offers the three formats with count-bearing content lines', () => {
        expect(ED.FORMATS.map(f => f.id)).toEqual(['geojson', 'json', 'csv']);
        const s = ED.summarize(DATA);
        const cell = { code: '4P3-JK8-39LM' };
        for (const f of ED.FORMATS) {
            const lines = f.items(s, cell);
            expect(lines.length).toBeGreaterThan(0);
            expect(lines.join(' ')).toMatch(/\d/); // every format states real counts
        }
        // the GeoJSON tab names the cell explicitly
        const geo = ED.FORMATS[0].items(s, cell).join(' ');
        expect(geo).toContain('4P3-JK8-39LM');
    });
});

describe('ExportDialog.open() — DOM shape', () => {
    it('renders tabs, count rows, filename, and a primary export button', () => {
        ED.open({ code: '4P3-JK8-39LM' }, DATA);
        const dlg = document.querySelector('.export-dialog');
        expect(dlg).toBeTruthy();
        expect(dlg.querySelectorAll('.ed-tab')).toHaveLength(3);
        expect(dlg.querySelector('.ed-tab.active').dataset.fmt).toBe('geojson');
        expect(dlg.querySelectorAll('.ed-item').length).toBeGreaterThan(0);
        expect(dlg.querySelector('.ed-filename').textContent).toBe('digipin_4P3JK839LM.geojson');
        expect(dlg.querySelector('.ed-export-btn').textContent).toContain('GeoJSON');
    });

    it('switches tab content and is idempotent on reopen', () => {
        ED.open({ code: '4P3JK8' }, DATA);
        ED.open({ code: '4P3JK8' }, DATA);   // reopen replaces, not stacks
        expect(document.querySelectorAll('#export-dialog-backdrop')).toHaveLength(1);
        document.querySelector('.ed-tab[data-fmt="csv"]').click();
        expect(document.querySelector('.ed-filename').textContent).toBe('digipin_4P3JK8.csv');
        expect(document.querySelector('.ed-export-btn').textContent).toContain('CSV');
    });

    it('close() removes the dialog', () => {
        ED.open({ code: '4P3JK8' }, DATA);
        ED.close();
        expect(document.querySelector('#export-dialog-backdrop')).toBeNull();
    });
});
