import { describe, it, expect } from 'vitest';

const SH = globalThis.SunHours;
const lat0 = 22.7196, lng0 = 75.8577;
const mLat = 111320;
const mLng = 111320 * Math.cos(lat0 * Math.PI / 180);

/** Axis-aligned box in metres east/north of the point, as a lng/lat ring. */
function box(x0, y0, x1, y1) {
    const p = (x, y) => [lng0 + x / mLng, lat0 + y / mLat];
    return [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)];
}

describe('SunHours.rayEntry()', () => {
    const sq = [[10, -5], [20, -5], [20, 5], [10, 5], [10, -5]];
    it('hits the near edge along the ray', () => {
        expect(SH.rayEntry(sq, 1, 0)).toBeCloseTo(10, 6);
    });
    it('misses a footprint behind or beside the ray', () => {
        expect(SH.rayEntry(sq, -1, 0)).toBeNull();
        expect(SH.rayEntry(sq, 0, 1)).toBeNull();
    });
    it('returns 0 when the origin is inside the footprint', () => {
        expect(SH.rayEntry([[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]], 1, 0)).toBe(0);
    });
});

describe('SunHours.shadowed()', () => {
    // A building 30 m due south of the point (x −10…10, y −35…−30).
    const south = (h) => [{ ring: SH.toLocal(box(-10, -35, 10, -30), lat0, lng0), height: h }];
    it('a tall building south blocks a southern 45° sun, a low one does not', () => {
        expect(SH.shadowed(south(40), 45, 180)).toBe(true);
        expect(SH.shadowed(south(20), 45, 180)).toBe(false);
    });
    it('does not block a sun from another direction or a night sky', () => {
        expect(SH.shadowed(south(80), 45, 90)).toBe(false);
        expect(SH.shadowed(south(80), -5, 180)).toBe(true);
    });
    it('a higher sun clears the same building', () => {
        expect(SH.shadowed(south(40), 70, 180)).toBe(false);
    });
});

describe('SunHours.analyse()', () => {
    // Toy sun: rises 06:00, sets 18:00 solar time, due south at noon, 60° peak.
    const dayStart = new Date(Date.UTC(2026, 5, 21, 0, 0) - (lng0 / 15) * 3600000);
    const solar = (lat, lng, when) => {
        const h = ((when.getTime() - dayStart.getTime()) / 3600000);
        const altitude = 60 * Math.sin(Math.PI * (h - 6) / 12);
        return { altitude: h < 6 || h > 18 ? -10 : altitude, azimuth: 180 };
    };
    it('open ground gets the whole of its daylight', () => {
        const r = SH.analyse(lat0, lng0, [], solar, dayStart);
        expect(r.daylightHours).toBeGreaterThan(10);
        expect(r.sunHours).toBe(r.daylightHours);
        expect(r.windows).toHaveLength(1);
    });
    it('a 40 m building to the south costs the low-sun hours', () => {
        const b = [{ polygon: box(-30, -45, 30, -30), height: 40 }];
        const open = SH.analyse(lat0, lng0, [], solar, dayStart);
        const r = SH.analyse(lat0, lng0, b, solar, dayStart);
        expect(r.sunHours).toBeLessThan(open.sunHours);
        expect(r.sunHours).toBeGreaterThan(0);        // midday sun clears it
        expect(r.windows.length).toBeGreaterThanOrEqual(1);
        expect(r.shadedHours).toBeCloseTo(r.daylightHours - r.sunHours, 1);
    });
    it('ignores buildings without height or far away', () => {
        const far = [{ polygon: box(5000, 5000, 5100, 5100), height: 200 }, { polygon: box(-5, -40, 5, -30), height: 0 }];
        expect(SH.analyse(lat0, lng0, far, solar, dayStart).sunHours).toBe(SH.analyse(lat0, lng0, [], solar, dayStart).sunHours);
    });
});

describe('SunHours.summary() / band()', () => {
    it('describes sun windows', () => {
        const s = SH.summary({ sunHours: 5.5, daylightHours: 11, windows: [[7, 12.5]] });
        expect(s).toBe('5.5 h direct sun of 11.0 h daylight · sun 07:00–12:30');
        expect(SH.summary({ sunHours: 0, daylightHours: 11, windows: [] })).toContain('fully shaded');
        expect(SH.summary({ sunHours: 0, daylightHours: 0, windows: [] })).toContain('No daylight');
    });
    it('bands by hours of sun', () => {
        expect(SH.band(7)).toBe('sunny');
        expect(SH.band(3)).toBe('partial');
        expect(SH.band(0.5)).toBe('shaded');
    });
});
