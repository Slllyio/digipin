import { describe, it, expect } from 'vitest';

// OvertureRelease is exposed on globalThis by tests/setup.js.
const OR = globalThis.OvertureRelease;

const listing = (ids) => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>overturemaps-extras-us-west-2</Name><Prefix>tiles/</Prefix>${
    ids.map(id => `<CommonPrefixes><Prefix>tiles/${id}/</Prefix></CommonPrefixes>`).join('')
}</ListBucketResult>`;

describe('OvertureRelease.latestFromListing', () => {
    it('picks the newest date, then the highest patch', () => {
        expect(OR.latestFromListing(listing(['2026-09-23.0', '2026-09-23.1']))).toBe('2026-09-23.1');
        expect(OR.latestFromListing(listing(['2026-10-21.0', '2026-09-23.1']))).toBe('2026-10-21.0');
        expect(OR.latestFromListing(listing(['2026-09-23.10', '2026-09-23.9']))).toBe('2026-09-23.10');
    });
    it('returns null for an empty, error or garbage body', () => {
        expect(OR.latestFromListing(listing([]))).toBeNull();
        expect(OR.latestFromListing('<Error><Code>AccessDenied</Code></Error>')).toBeNull();
        expect(OR.latestFromListing(null)).toBeNull();
    });
});

describe('OvertureRelease.url', () => {
    it('builds a theme URL in the current release folder', () => {
        expect(OR.url('buildings')).toMatch(
            /^https:\/\/overturemaps-extras-us-west-2\.s3\.us-west-2\.amazonaws\.com\/tiles\/\d{4}-\d{2}-\d{2}(\.\d+)?\/buildings\.pmtiles$/);
        expect(OR.url('buildings')).not.toContain('2024-08-20');
    });
    it('falls back to the pinned release when discovery fails', async () => {
        const orig = globalThis.fetch;
        globalThis.fetch = () => Promise.reject(new Error('offline'));
        try {
            const id = await OR.resolve();
            expect(id).toBe(OR.current());
            expect(OR.current()).toMatch(/^\d{4}-\d{2}-\d{2}/);
        } finally {
            globalThis.fetch = orig;
        }
    });
});
