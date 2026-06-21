import { describe, it, expect } from 'vitest';

describe('SunStudy.solarPosition (NOAA algorithm)', () => {
    it('returns altitude in [-90,90] and azimuth in [0,360)', () => {
        for (const h of [0, 6, 12, 18]) {
            const { altitude, azimuth } = SunStudy.solarPosition(22.7, 75.8, new Date(Date.UTC(2024, 5, 21, h)));
            expect(altitude).toBeGreaterThanOrEqual(-90);
            expect(altitude).toBeLessThanOrEqual(90);
            expect(azimuth).toBeGreaterThanOrEqual(0);
            expect(azimuth).toBeLessThan(360);
        }
    });

    it('puts the sun nearly overhead at the subsolar point (solstice noon at Tropic of Cancer)', () => {
        // 2024 June solstice: declination ≈ +23.44°. Equation of time ≈ -1.6 min,
        // so solar noon at lng 0 is ~12:01:40 UTC; the sun is then ~overhead at
        // lat ≈ 23.44. Altitude should be within ~1° of 90.
        const { altitude } = SunStudy.solarPosition(23.44, 0, new Date(Date.UTC(2024, 5, 21, 12, 1, 40)));
        expect(altitude).toBeGreaterThan(88.5);
    });

    it('reports the sun below the horizon at local midnight', () => {
        // Indore (~75.8°E ≈ UTC+5) local midnight ≈ 18:30 UTC.
        const { altitude } = SunStudy.solarPosition(22.7, 75.8, new Date(Date.UTC(2024, 5, 20, 18, 30)));
        expect(altitude).toBeLessThan(0);
    });

    it('is higher at noon than in early morning', () => {
        const noon = SunStudy.solarPosition(22.7, 75.8, new Date(Date.UTC(2024, 2, 21, 6, 30))); // ~local noon
        const dawn = SunStudy.solarPosition(22.7, 75.8, new Date(Date.UTC(2024, 2, 21, 1, 30))); // ~local 07:00
        expect(noon.altitude).toBeGreaterThan(dawn.altitude);
    });
});

describe('SunStudy.lightFor', () => {
    it('maps a high sun to a near-overhead, brighter light', () => {
        const l = SunStudy.lightFor(80, 180);
        expect(l.anchor).toBe('map');
        expect(l.position[0]).toBeGreaterThan(0);
        expect(l.position[1]).toBe(180);        // azimuth passed through
        expect(l.position[2]).toBeCloseTo(10, 5); // polar = 90 - altitude
        expect(l.intensity).toBeGreaterThan(0.3);
    });

    it('dims to a low dusk light below the horizon', () => {
        const l = SunStudy.lightFor(-10, 270);
        expect(l.intensity).toBeLessThan(0.2);
        expect(l.position[2]).toBeGreaterThan(80); // near the horizon
    });
});

describe('SunStudy.sunTimes', () => {
    it('gives ~12 h of daylight at the equator on the equinox', () => {
        const st = SunStudy.sunTimes(0, 0, new Date(Date.UTC(2024, 2, 20)));
        expect(st.polar).toBeNull();
        expect(st.daylightHours).toBeGreaterThan(11.9);
        expect(st.daylightHours).toBeLessThan(12.3);
        expect(st.sunriseH).toBeCloseTo(12 - st.daylightHours / 2, 5);
        expect(st.sunsetH).toBeCloseTo(12 + st.daylightHours / 2, 5);
    });

    it('gives a long summer day at high northern latitude', () => {
        const st = SunStudy.sunTimes(51.5, -0.1, new Date(Date.UTC(2024, 5, 20)));
        expect(st.daylightHours).toBeGreaterThan(16);
        expect(st.daylightHours).toBeLessThan(17);
    });

    it('reports polar day/night beyond the circle', () => {
        expect(SunStudy.sunTimes(80, 0, new Date(Date.UTC(2024, 5, 21))).polar).toBe('day');
        expect(SunStudy.sunTimes(80, 0, new Date(Date.UTC(2024, 11, 21))).polar).toBe('night');
    });
});

describe('SunStudy.formatHM', () => {
    it('formats decimal hours as HH:MM (24h, wrapping)', () => {
        expect(SunStudy.formatHM(6.5)).toBe('06:30');
        expect(SunStudy.formatHM(13.25)).toBe('13:15');
        expect(SunStudy.formatHM(0)).toBe('00:00');
        expect(SunStudy.formatHM(null)).toBe('—');
    });
});
