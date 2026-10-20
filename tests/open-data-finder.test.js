import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const OD = globalThis.OpenDataFinder;
const catalog = JSON.parse(fs.readFileSync('data/open-data/catalog.json', 'utf8'));

describe('OpenDataFinder.isQuery()', () => {
    it('recognises find-data phrasings and returns the topic', () => {
        expect(OD.isQuery('find open data for flooding').query).toBe('flooding');
        expect(OD.isQuery('Find datasets on population?').query).toBe('population');
        expect(OD.isQuery('where can I get data about air quality').query).toBe('air quality');
        expect(OD.isQuery('is there any public data for elevation').query).toBe('elevation');
        expect(OD.isQuery('find data').query).toBe('');
    });
    it('leaves ordinary questions alone', () => {
        expect(OD.isQuery('is this area safe for a school?')).toBeNull();
        expect(OD.isQuery('find the best ward for a clinic')).toBeNull();
        expect(OD.isQuery('how much data do you have')).toBeNull();
    });
});

describe('OpenDataFinder.tokens()', () => {
    it('drops filler words, stems plurals and expands aliases', () => {
        const t = OD.tokens('open data for trees in Indore');
        expect(t).toContain('tree');
        expect(t).toContain('ndvi');
        expect(t).not.toContain('indore');
    });
});

describe('OpenDataFinder.search()', () => {
    it('ranks the dataset that is about the topic first', () => {
        expect(OD.search('population', catalog)[0].entry.id).toMatch(/worldpop|ghsl|census|shrug/);
        expect(OD.search('elevation', catalog).map(r => r.entry.id)).toContain('aws-terrain');
        expect(OD.search('air quality', catalog).map(r => r.entry.id)).toEqual(expect.arrayContaining(['openaq', 'cpcb']));
    });
    it('returns nothing for an empty or unknown topic', () => {
        expect(OD.search('', catalog)).toEqual([]);
        expect(OD.search('zzzz', catalog)).toEqual([]);
    });
    it('caps the result list', () => {
        expect(OD.search('water', catalog, 3).length).toBeLessThanOrEqual(3);
    });
});

describe('catalog integrity', () => {
    it('every entry has the fields a result card needs and an https link', () => {
        const ids = new Set();
        catalog.datasets.forEach(d => {
            expect(ids.has(d.id)).toBe(false);
            ids.add(d.id);
            ['title', 'publisher', 'url', 'license', 'coverage'].forEach(k => expect(d[k], d.id + '.' + k).toBeTruthy());
            expect(d.url.startsWith('https://')).toBe(true);
            expect(d.tags.length).toBeGreaterThan(0);
        });
    });
});

describe('OpenDataFinder.layersFor()', () => {
    it('keeps only layers the app actually has', () => {
        const entry = { layers: ['ndvi', 'missing'] };
        const cands = [{ id: 'ndvi', name: 'NDVI' }, { id: 'heat', name: 'Heat' }];
        expect(OD.layersFor(entry, cands)).toEqual([{ id: 'ndvi', name: 'NDVI' }]);
    });
});
