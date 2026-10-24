import { describe, it, expect } from 'vitest';

const PC = globalThis.PointCloud;

describe('PointCloud.isPointCloudName()', () => {
    it('accepts LAS / LAZ / COPC file names only', () => {
        expect(PC.isPointCloudName('survey.las')).toBe(true);
        expect(PC.isPointCloudName('Ward12.COPC.LAZ')).toBe(true);
        expect(PC.isPointCloudName('roads.geojson')).toBe(false);
        expect(PC.isPointCloudName('')).toBe(false);
    });
});

describe('PointCloud.normaliseUrl()', () => {
    it('keeps https COPC/LAS/LAZ files and EPT roots', () => {
        expect(PC.normaliseUrl(' https://x.org/a/b.copc.laz ')).toBe('https://x.org/a/b.copc.laz');
        expect(PC.normaliseUrl('https://x.org/ept/ept.json')).toBe('https://x.org/ept/ept.json');
        expect(PC.normaliseUrl(PC.SAMPLE_URL)).toBe(PC.SAMPLE_URL);
    });
    it('rejects other schemes, other files and junk', () => {
        expect(PC.normaliseUrl('http://x.org/a.laz')).toBeNull();
        expect(PC.normaliseUrl('javascript:alert(1)')).toBeNull();
        expect(PC.normaliseUrl('https://x.org/a.tif')).toBeNull();
        expect(PC.normaliseUrl('not a url')).toBeNull();
    });
});
