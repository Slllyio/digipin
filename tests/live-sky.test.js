import { describe, it, expect } from 'vitest';

const LS = globalThis.LiveSky;

const sample = {
    now: 1792685124000,
    ac: [
        { hex: '8018a8', flight: 'IGO6673 ', r: 'VT-NHX', t: 'A21N', alt_baro: 24075, alt_geom: 25150, gs: 386.1, track: 204.97, baro_rate: -1024, lat: 28.7, lon: 77.1, seen_pos: 1.2 },
        { hex: '800abc', r: 'VT-ABC', alt_baro: 'ground', gs: 3, lat: 28.56, lon: 77.1, seen: 2 },
        { hex: 'stale', flight: 'OLD', alt_baro: 3000, lat: 28, lon: 77, seen_pos: 120 },
        { hex: 'nopos', flight: 'X', alt_baro: 3000 },
    ],
};

describe('LiveSky feed', () => {
    it('builds adsb.lol point URLs and proxied ones', () => {
        expect(LS.feedUrl(28.6, 77.2, 40)).toBe('https://api.adsb.lol/v2/point/28.6000/77.2000/40');
        expect(LS.proxied('https://a/b?c=1', 'https://p.workers.dev/')).toBe('https://p.workers.dev/?url=https%3A%2F%2Fa%2Fb%3Fc%3D1');
        expect(LS.proxied('https://a', '')).toBe('https://a');
    });

    it('parses aircraft to metric records and drops stale or position-less ones', () => {
        const a = LS.parseAircraft(sample);
        expect(a.map(x => x.hex)).toEqual(['8018a8', '800abc']);
        expect(a[0].flight).toBe('IGO6673');
        expect(a[0].altM).toBeCloseTo(25150 * 0.3048, 1);
        expect(a[0].speedKmh).toBeCloseTo(715, 0);
        expect(a[1]).toMatchObject({ onGround: true, altM: 0, flight: 'VT-ABC' });
        expect(LS.summary(a)).toEqual({ total: 2, airborne: 1, low: 0, ground: 1 });
    });
});

describe('LiveSky geometry', () => {
    it('dead-reckons along the track and ignores aircraft on the ground', () => {
        const a = { lat: 28, lng: 77, altM: 1000, speedKmh: 360, track: 90, vrateFpm: 0, t0: 100, onGround: false };
        const p = LS.predict(a, 110);           // 10 s at 100 m/s east → ~1 km
        expect(p.lat).toBeCloseTo(28, 6);
        expect((p.lng - 77) * 111320 * Math.cos(28 * Math.PI / 180)).toBeCloseTo(1000, 0);
        expect(LS.predict({ ...a, onGround: true }, 200).lng).toBe(77);
    });

    it('draws a closed plane ring pointing along the track', () => {
        const ring = LS.planeRing(20, 75, 0, 1000);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        const nose = ring[0];
        expect(nose[1]).toBeGreaterThan(20);              // north-pointing nose is north of centre
        expect(nose[0]).toBeCloseTo(75, 9);
    });

    it('scales plane size with zoom and colours by altitude', () => {
        expect(LS.planeLength(18)).toBe(60);
        expect(LS.planeLength(10)).toBeGreaterThan(LS.planeLength(12));
        expect(LS.altColor(0)).toBe('#9aa4ad');
        expect(LS.altColor(800)).toBe('#f28c28');
        expect(LS.altColor(11000)).toBe('#3fb6e8');
    });

    it('builds plane, stem and shadow features with compressed altitude', () => {
        const a = LS.parseAircraft(sample);
        const f = LS.frameFeatures(a, sample.now / 1000, 11, 0.25);
        const plane = f.planes.features.find(x => x.properties.part === 'plane' && x.properties.hex === '8018a8');
        expect(plane.properties.base).toBeGreaterThan(1800);
        expect(plane.properties.base).toBeLessThan(2000);
        expect(f.planes.features.filter(x => x.properties.part === 'stem')).toHaveLength(1);
        expect(f.shadows.features).toHaveLength(2);
        expect(f.shadows.features[1].properties.label).toBe('VT-ABC\nground');
    });
});
