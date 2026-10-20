import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const OD = globalThis.OpenDataFinder;
const cloud = JSON.parse(fs.readFileSync('data/open-data/cloud_catalogs.json', 'utf8'));

describe('cloud catalogs (Earth Engine + Planetary Computer)', () => {
    it('every row has the fields a result card needs', () => {
        const ids = new Set();
        expect(cloud.datasets.length).toBeGreaterThan(100);
        cloud.datasets.forEach(d => {
            expect(ids.has(d.id), d.id).toBe(false);
            ids.add(d.id);
            expect(d.id).toMatch(/^(ee|pc):/);
            ['title', 'publisher', 'url', 'license', 'coverage', 'platform', 'access'].forEach(k => expect(d[k], d.id + '.' + k).toBeTruthy());
            expect(d.url.startsWith('https://')).toBe(true);
            expect(d.tags.length).toBeGreaterThan(0);
        });
    });

    it('finds Earth Engine land cover and night lights for India', () => {
        const lc = OD.search('land cover', cloud, 20).map(r => r.entry.id);
        expect(lc).toEqual(expect.arrayContaining(['ee:ESA/WorldCover/v200']));
        expect(OD.search('night lights', cloud, 20).some(r => /VIIRS|DMSP/i.test(r.entry.id))).toBe(true);
    });
});

describe('OpenDataFinder.merge()', () => {
    it('concatenates catalogs, first id wins, and skips missing ones', () => {
        const a = { datasets: [{ id: 'x', title: 'A' }] };
        const b = { datasets: [{ id: 'x', title: 'B' }, { id: 'ee:y', title: 'C' }] };
        expect(OD.merge(a, null, b).datasets.map(d => d.title)).toEqual(['A', 'C']);
    });

    it('ranks a curated entry above a cloud row with the same match', () => {
        const cat = OD.merge({ datasets: [{ id: 'ee:wc', title: 'Land cover', tags: ['landcover'] }, { id: 'wc', title: 'Land cover', tags: ['landcover'] }] });
        expect(OD.search('landcover', cat)[0].entry.id).toBe('wc');
    });
});
