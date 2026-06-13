import { describe, it, expect } from 'vitest';

// RealtimeAlerts is exposed on globalThis by tests/setup.js. staleness() drives
// the panel's "X min ago / may be stale" freshness chip on the hazard banner.
const { staleness } = globalThis.RealtimeAlerts;

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe('RealtimeAlerts.staleness()', () => {
    it('returns null for missing or unparseable timestamps', () => {
        expect(staleness(null)).toBeNull();
        expect(staleness('')).toBeNull();
        expect(staleness('not-a-date')).toBeNull();
    });

    it('labels recent snapshots in minutes and marks them fresh', () => {
        const f = staleness(isoAgo(12 * MIN));
        expect(f.label).toBe('12 min ago');
        expect(f.stale).toBe(false);
    });

    it('marks snapshots older than the threshold (default 2h) stale', () => {
        const f = staleness(isoAgo(3 * HOUR));
        expect(f.label).toBe('3 h ago');
        expect(f.stale).toBe(true);
    });

    it('uses a day label past 24h', () => {
        expect(staleness(isoAgo(2 * DAY)).label).toBe('2 d ago');
    });

    it('honours a custom max-age threshold', () => {
        const iso = isoAgo(30 * MIN);
        expect(staleness(iso, 60 * MIN).stale).toBe(false);
        expect(staleness(iso, 10 * MIN).stale).toBe(true);
    });

    it('clamps a future timestamp to age 0', () => {
        const f = staleness(isoAgo(-5 * MIN));  // 5 min in the future
        expect(f.ageMs).toBe(0);
        expect(f.stale).toBe(false);
    });
});
