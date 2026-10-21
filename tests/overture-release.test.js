import { describe, it, expect, vi } from 'vitest';

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

describe('OvertureRelease.guardRangeReads', () => {
    // A stand-in for pmtiles.FetchSource: `hang` reads never settle until
    // their signal aborts, like a connection whose body never arrives.
    function fakeLib() {
        const calls = [];
        class FetchSource {
            constructor() { this.mustReload = false; this.hang = 0; }
            getBytes(offset, length, signal, etag) {
                calls.push({ offset, length, reload: this.mustReload, etag });
                return new Promise((resolve, reject) => {
                    if (this.hang > 0) {
                        this.hang--;
                        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                        return;
                    }
                    resolve({ data: new ArrayBuffer(length), etag: etag || 'e1' });
                });
            }
        }
        return { lib: { FetchSource }, calls };
    }
    const stats = () => OR.rangeStats();

    it('installs once and leaves a prompt read untouched', async () => {
        const { lib, calls } = fakeLib();
        expect(OR.guardRangeReads(lib, { timeoutMs: 50 })).toBe(true);
        expect(OR.guardRangeReads(lib, { timeoutMs: 50 })).toBe(true);
        expect(OR.guardRangeReads({})).toBe(false);
        const src = new lib.FetchSource();
        const before = stats();
        const r = await src.getBytes(0, 16384, undefined, undefined);
        expect(r.data.byteLength).toBe(16384);
        expect(calls).toHaveLength(1);
        expect(stats().timeouts).toBe(before.timeouts);
    });

    it('retries a read that never finishes, past the HTTP cache, and recovers', async () => {
        vi.useFakeTimers();
        try {
            const { lib, calls } = fakeLib();
            OR.guardRangeReads(lib, { timeoutMs: 50 });
            const src = new lib.FetchSource();
            src.hang = 1;
            const before = stats();
            const p = src.getBytes(100, 200, undefined, '"abc"');
            await vi.advanceTimersByTimeAsync(60);
            const r = await p;
            expect(r.data.byteLength).toBe(200);
            expect(calls).toHaveLength(2);
            expect(calls[1].reload).toBe(true);
            const after = stats();
            expect(after.timeouts - before.timeouts).toBe(1);
            expect(after.retried - before.retried).toBe(1);
            expect(after.recovered - before.recovered).toBe(1);
        } finally { vi.useRealTimers(); }
    });

    it('fails with a clear error when the retry stalls too', async () => {
        vi.useFakeTimers();
        try {
            const { lib } = fakeLib();
            OR.guardRangeReads(lib, { timeoutMs: 50 });
            const src = new lib.FetchSource();
            src.hang = 2;
            const before = stats();
            const p = src.getBytes(0, 10, undefined, undefined);
            const settled = p.then(() => 'ok', (e) => e);
            await vi.advanceTimersByTimeAsync(120);
            const e = await settled;
            expect(e).toBeInstanceOf(Error);
            expect(e.message).toMatch(/timed out after 50 ms/);
            expect(stats().failed - before.failed).toBe(1);
        } finally { vi.useRealTimers(); }
    });

    it("passes the caller's own abort through without a retry", async () => {
        const { lib, calls } = fakeLib();
        OR.guardRangeReads(lib, { timeoutMs: 50 });
        const src = new lib.FetchSource();
        src.hang = 1;
        const ctrl = new AbortController();
        const before = stats();
        const p = src.getBytes(0, 10, ctrl.signal, undefined);
        const settled = p.then(() => 'ok', (e) => e);
        ctrl.abort();
        const e = await settled;
        expect(e && e.name).toBe('AbortError');
        expect(calls).toHaveLength(1);
        expect(stats().retried).toBe(before.retried);
    });
});

describe('OvertureRelease.wrapProtocol', () => {
    it('counts calls, settlements, empties and the longest call; passes results and errors through', async () => {
        const before = OR.protocolStats();
        const ok = OR.wrapProtocol(async () => ({ data: new Uint8Array(3) }));
        const empty = OR.wrapProtocol(async () => ({ data: new Uint8Array(0) }));
        const bad = OR.wrapProtocol(() => { throw new Error('boom'); });
        expect((await ok({ url: 'pmtiles://x/1/2/3' }, new AbortController())).data.byteLength).toBe(3);
        expect((await empty({ url: 'pmtiles://x/1/2/3' }, new AbortController())).data.byteLength).toBe(0);
        await expect(bad({ url: 'pmtiles://x' }, new AbortController())).rejects.toThrow('boom');
        const after = OR.protocolStats();
        expect(after.calls - before.calls).toBe(3);
        expect(after.resolved - before.resolved).toBe(2);
        expect(after.rejected - before.rejected).toBe(1);
        expect(after.empty - before.empty).toBe(1);
        expect(after.pending).toBe(before.pending);
        expect(OR.wrapProtocol(null)).toBeNull();
    });
});
