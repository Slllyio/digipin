import { describe, it, expect } from 'vitest';

const SP = globalThis.SatPasses;

// CelesTrak GP records (2026-10-21) and SGP4 reference points from satellite.js.
const ISS = {"OBJECT_NAME": "ISS (ZARYA)", "OBJECT_ID": "1998-067A", "EPOCH": "2026-10-21T01:08:59.469792", "MEAN_MOTION": 15.48967427, "ECCENTRICITY": 0.00067597, "INCLINATION": 51.6327, "RA_OF_ASC_NODE": 37.2623, "ARG_OF_PERICENTER": 289.5321, "MEAN_ANOMALY": 70.4938, "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U", "NORAD_CAT_ID": 25544, "ELEMENT_SET_NO": 999, "REV_AT_EPOCH": 59126, "BSTAR": 0.00018187691, "MEAN_MOTION_DOT": 9.575e-05, "MEAN_MOTION_DDOT": 0};
const S2A = {"OBJECT_NAME": "SENTINEL-2A", "OBJECT_ID": "2015-028A", "EPOCH": "2026-10-21T07:09:52.681824", "MEAN_MOTION": 14.30823826, "ECCENTRICITY": 0.00010869, "INCLINATION": 98.5632, "RA_OF_ASC_NODE": 7.3064, "ARG_OF_PERICENTER": 96.3569, "MEAN_ANOMALY": 263.7738, "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U", "NORAD_CAT_ID": 40697, "ELEMENT_SET_NO": 999, "REV_AT_EPOCH": 59176, "BSTAR": 8.356586e-06, "MEAN_MOTION_DOT": -2.2e-07, "MEAN_MOTION_DDOT": 0};
const REF = { iss: [{"h": 0, "lat": 0, "lng": -9.488, "alt": 419}, {"h": 30, "lat": 33.772, "lng": 41.326, "alt": 426.1}, {"h": 72, "lat": -0.226, "lng": 152.884, "alt": 422.7}], s2a: [{"h": 0, "lat": 0, "lng": -129.913, "alt": 792}, {"h": 30, "lat": -44.477, "lng": 148.543, "alt": 806.7}, {"h": 72, "lat": -35.616, "lng": -123.756, "alt": 802.9}] };
const DELHI = { lat: 28.6139, lng: 77.209 };

describe('SatPasses orbits', () => {
    it('parses OMM elements', () => {
        const el = SP.elements(ISS);
        expect(el.id).toBe(25544);
        expect(el.epochMs).toBe(Date.parse('2026-10-21T01:08:59.469Z'));
        expect(el.a).toBeGreaterThan(6700);
        expect(el.a).toBeLessThan(6820);
        expect(el.raanDot).toBeLessThan(0);              // prograde orbit: node regresses
        expect(SP.elements({})).toBeNull();
    });

    it('stays within 20 km of SGP4 over three days', () => {
        for (const [gp, pts] of [[ISS, REF.iss], [S2A, REF.s2a]]) {
            const el = SP.elements(gp);
            for (const p of pts) {
                const mine = SP.propagate(el, el.epochMs + p.h * 3600e3);
                expect(SP.distanceKm(mine, p)).toBeLessThan(20);
                expect(Math.abs(mine.altKm - p.alt)).toBeLessThan(15);
            }
        }
    });

    it('Sentinel-2A sun-synchronous orbit gives a mid-morning pass over Delhi, matching SGP4', () => {
        const el = SP.elements(S2A), meta = SP.metaFor('SENTINEL-2A');
        const passes = SP.passesFor(el, meta, DELHI.lat, DELHI.lng, el.epochMs, 7);
        expect(passes.length).toBe(1);                   // the 22:32 IST night pass is dropped
        const p = passes[0];
        expect(Math.abs(p.t - Date.parse('2026-10-22T05:41:12Z'))).toBeLessThan(20000);
        expect(Math.abs(p.offsetKm - 30.1)).toBeLessThan(15);
        expect(p.ascending).toBe(false);                 // descending node ~10:30 local
        expect(p.sunEl).toBeGreaterThan(30);
        expect(p.covers).toBe('all');
        expect(SP.fmtIst(p.t)).toBe('Thu 22 Oct, 11:11 IST');
    });

    it('radar passes keep night passes', () => {
        const el = SP.elements(S2A);
        const sar = { kind: 'sar', swathKm: 290 };
        expect(SP.passesFor(el, sar, DELHI.lat, DELHI.lng, el.epochMs, 7).length).toBe(2);
    });

    it('sun elevation: high at Delhi noon, below horizon at midnight', () => {
        expect(SP.sunElevation(28.61, 77.21, Date.parse('2026-06-21T06:50:00Z'))).toBeGreaterThan(80);
        expect(SP.sunElevation(28.61, 77.21, Date.parse('2026-06-21T18:30:00Z'))).toBeLessThan(-30);
    });

    it('ground track and swath geometry', () => {
        const el = SP.elements(ISS);
        const lines = SP.groundTrack(el, el.epochMs, el.epochMs + 95 * 60000, 60000);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lines.flat().length).toBe(96);
        const ring = SP.swathPolygon(el, el.epochMs, 100, 1);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        // Swath edges are ~200 km apart across the track.
        expect(SP.distanceKm({ lng: ring[0][0], lat: ring[0][1] }, { lng: ring[ring.length - 2][0], lat: ring[ring.length - 2][1] })).toBeGreaterThan(180);
    });
});

describe('SatPasses schedule', () => {
    it('matches catalogue names and skips stale element sets', () => {
        expect(SP.metaFor('SENTINEL-2C').kind).toBe('optical');
        expect(SP.metaFor('SENTINEL-1A').kind).toBe('sar');
        expect(SP.metaFor('LANDSAT 9').swathKm).toBe(185);
        expect(SP.metaFor('STARLINK-1007')).toBeNull();
        const now = Date.parse('2026-10-22T00:00:00Z');
        const f = SP.fleet([S2A, ISS, S2A, { OBJECT_NAME: 'STARLINK-1' }], now);
        expect(f.map(s => s.label)).toEqual(['Sentinel-2A', 'ISS']);
        expect(SP.fleet([S2A], Date.parse('2027-01-01T00:00:00Z'))).toEqual([]);
    });

    it('joins the cloud forecast and words the outlook', () => {
        const hourly = { time: ['2026-10-22T05:00', '2026-10-22T06:00'], cloud_cover: [10, 90] };
        expect(SP.cloudAt(hourly, Date.parse('2026-10-22T05:20:00Z'))).toBe(10);
        expect(SP.cloudAt(hourly, Date.parse('2026-10-22T05:50:00Z'))).toBe(90);
        expect(SP.cloudAt(hourly, Date.parse('2026-10-25T05:00:00Z'))).toBeNull();
        const opt = SP.metaFor('SENTINEL-2A');
        expect(SP.outlook(opt, 10)).toMatch(/Likely clear/);
        expect(SP.outlook(opt, 85)).toMatch(/Likely cloudy/);
        expect(SP.outlook(opt, 50)).toMatch(/Partly/);
        expect(SP.outlook(opt, null)).toMatch(/No cloud forecast/);
        expect(SP.outlook(SP.metaFor('SENTINEL-1A'), 99)).toMatch(/Radar/);
        const el = SP.elements(S2A);
        const rows = SP.schedule(SP.fleet([S2A, ISS], el.epochMs), DELHI.lat, DELHI.lng, el.epochMs, 7, { time: ['2026-10-22T06:00'], cloud_cover: [20] });
        expect(rows.map(r => r.label)).toEqual(['Sentinel-2A']);   // the ISS has no swath
        expect(rows[0].cloud).toBe(20);
        expect(rows[0].outlook).toMatch(/Likely clear/);
    });

    it('formats times', () => {
        expect(SP.fmtIn(20 * 60000)).toBe('in 20 min');
        expect(SP.fmtIn(5 * 3600000)).toBe('in 5 h');
        expect(SP.fmtIn(3 * 86400000)).toBe('in 3 days');
    });
});
