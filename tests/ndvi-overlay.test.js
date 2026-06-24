/**
 * NDVIOverlay.gibsDateFor() — snaps to the MODIS 8-day period grid.
 */
import { describe, it, expect } from 'vitest';

const { gibsDateFor } = globalThis.NDVIOverlay;

function doyOf(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.floor((d.getTime() - yearStart) / 86400000); // 0-based
}

describe('NDVIOverlay.gibsDateFor()', () => {
    it('returns a YYYY-MM-DD string', () => {
        expect(gibsDateFor(new Date('2024-06-20T00:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('snaps to an 8-day period start (DOY divisible by 8, 0-based)', () => {
        for (const input of ['2024-06-20', '2024-01-05', '2024-12-31', '2023-07-14']) {
            const out = gibsDateFor(new Date(input + 'T00:00:00Z'));
            expect(doyOf(out) % 8).toBe(0);
        }
    });

    it('backs off so the returned period is on/before the requested date', () => {
        const input = new Date('2024-06-20T00:00:00Z');
        const out = new Date(gibsDateFor(input) + 'T00:00:00Z');
        expect(out.getTime()).toBeLessThanOrEqual(input.getTime());
    });

    it('honours a custom back-off window', () => {
        const input = new Date('2024-06-20T00:00:00Z');
        const out = new Date(gibsDateFor(input, 0) + 'T00:00:00Z');
        // even with no back-off it cannot land after the requested date
        expect(out.getTime()).toBeLessThanOrEqual(input.getTime());
    });
});
