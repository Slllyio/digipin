import { describe, it, expect } from 'vitest';

const LN = globalThis.LiveNow;

describe('LiveNow URLs', () => {
    it('asks Open-Meteo for current weather and a 3-day IST forecast', () => {
        const u = LN.forecastUrl(28.6, 77.2);
        expect(u).toContain('latitude=28.6000&longitude=77.2000');
        expect(u).toContain('precipitation_sum');
        expect(u).toContain('timezone=Asia%2FKolkata&forecast_days=3');
    });
    it('samples a 7x7 GloFAS block for the nearest big river', () => {
        const u = new URL(LN.floodUrl(28.6, 77.2));
        expect(u.searchParams.get('latitude').split(',')).toHaveLength(49);
        expect(u.searchParams.get('longitude').split(',')[0]).toBe('77.050');
    });
    it('orders the EONET bbox min lon, max lat, max lon, min lat', () => {
        expect(new URL(LN.eonetUrl(20, 75, 2)).searchParams.get('bbox')).toBe('73.00,22.00,77.00,18.00');
    });
});

describe('LiveNow air quality (CPCB National AQI)', () => {
    it('computes PM sub-indices on the CPCB breakpoints', () => {
        expect(LN.subIndex('pm25', 30)).toBe(50);
        expect(LN.subIndex('pm25', 60)).toBe(100);
        expect(LN.subIndex('pm25', 104.5)).toBe(247);
        expect(LN.subIndex('pm10', 323.2)).toBe(273);
        expect(LN.subIndex('pm10', 900)).toBe(500);
        expect(LN.subIndex('pm25', null)).toBeNull();
    });
    it('takes the dominant pollutant and its band', () => {
        const a = LN.parseAir({ current: { time: 't', pm2_5: 104.5, pm10: 323.2, nitrogen_dioxide: 57 } });
        expect(a.naqi).toBe(273);
        expect(a.dominant).toBe('PM10');
        expect(a.band.label).toBe('Poor');
        expect(LN.naqiBand(45).label).toBe('Good');
        expect(LN.naqiBand(450).label).toBe('Severe');
    });
});

describe('LiveNow.parseFlood()', () => {
    it('keeps the largest river and reads its trend against the 30-day mean', () => {
        const time = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];
        const j = [
            { latitude: 1, longitude: 2, daily: { time, river_discharge: [1, 1, 1, 1, 1] } },
            { latitude: 3, longitude: 4, daily: { time, river_discharge: [100, 100, 120, 260, 300] } },
        ];
        const r = LN.parseFlood(j, new Date('2026-10-22T06:00:00Z'));
        expect(r.lat).toBe(3);
        expect(r.now).toBe(120);
        expect(r.peak).toBe(300);
        expect(r.peakDate).toBe('2026-10-24');
        expect(r.mean30).toBe(100);
        expect(r.trend).toBe('rising');
    });
    it('returns null without discharge', () => {
        expect(LN.parseFlood(null)).toBeNull();
        expect(LN.parseFlood({ daily: { time: [], river_discharge: [] } })).toBeNull();
    });
});

describe('LiveNow feeds near a point', () => {
    it('keeps USGS quakes within range, nearest first', () => {
        const f = (id, lng, lat, mag) => ({ id, geometry: { coordinates: [lng, lat, 10] }, properties: { mag, place: id, time: 0 } });
        const q = LN.parseQuakes({ features: [f('far', 90, 10, 6), f('b', 78, 29, 4), f('a', 77.3, 28.7, 3)] }, 28.6, 77.2);
        expect(q.map(x => x.id)).toEqual(['a', 'b']);
        expect(q[0].km).toBeLessThan(20);
    });
    it('keeps EONET events with a point within range', () => {
        const e = LN.parseEvents({ events: [
            { id: 'x', title: 'Fire', categories: [{ title: 'Wildfires' }], geometry: [{ type: 'Point', date: 'd', coordinates: [77.5, 28.8] }] },
            { id: 'y', title: 'Far', categories: [{ title: 'Volcanoes' }], geometry: [{ type: 'Point', coordinates: [100, 0] }] },
            { id: 'z', title: 'Area', categories: [], geometry: [{ type: 'Polygon', coordinates: [] }] },
        ] }, 28.6, 77.2);
        expect(e).toHaveLength(1);
        expect(e[0].category).toBe('Wildfires');
    });
});

describe('LiveNow.exposure()', () => {
    it('sums people overall, in flood cells and in heat-island cells', () => {
        const pop = { cells: ['A', 'B', 'C', 'D'], columns: { population: [1000, 2000, 0, 500] } };
        const water = { cells: ['A', 'B'], columns: { flood_rp100_pct: [10, 2] } };
        const heat = { cells: ['B', 'D'], columns: { uhi_anomaly_c: [2.5, 1] } };
        const x = LN.exposure(pop, water, heat);
        expect(x).toMatchObject({ cells: 3, pop: 3500, floodPop: 1000, heatPop: 2000, floodCells: ['A'], heatCells: ['B'] });
        expect(LN.exposure(null).pop).toBe(0);
    });
    it('formats people the Indian way', () => {
        expect(LN.fmtPeople(12400)).toBe('12,400');
        expect(LN.fmtPeople(340000)).toBe('3.4 lakh');
        expect(LN.fmtPeople(12000000)).toBe('1.2 crore');
        expect(LN.fmtPeople(0)).toBe('0');
    });
});

describe('LiveNow.correlate()', () => {
    const exp = { pop: 500000, floodPop: 120000, floodCells: ['A'], heatPop: 80000, heatCells: ['B'] };
    const day = (date, tmax, rain) => ({ date, tmax, tmin: 20, rain, rainProb: 80, code: 63 });

    it('links heavy rain and a rising river to the flood-cell population', () => {
        const c = LN.correlate({
            weather: { days: [day('2026-10-22', 30, 5), day('2026-10-23', 30, 80)] },
            river: { peak: 400, mean30: 150, peakDate: '2026-10-24', lat: 1, lng: 2 },
            exp, today: '2026-10-22',
        });
        expect(c[0].id).toBe('rain-flood');
        expect(c[0].severity).toBe('high');
        expect(c[0].title).toMatch(/^Heavy rain .*80 mm$/);
        expect(c[0].detail).toContain('1.2 lakh people');
        expect(c[0].detail).toContain('river is rising');
        expect(c.find(x => x.id === 'river').detail).toContain('2.7×');
    });

    it('links a heatwave forecast to heat-island cells and poor air to people', () => {
        const c = LN.correlate({
            weather: { days: [day('2026-05-20', 44, 0)] },
            air: { naqi: 320, band: { label: 'Very Poor' }, dominant: 'PM2.5' },
            exp, today: '2026-05-20',
        });
        const heat = c.find(x => x.id === 'heat');
        expect(heat.title).toBe('Heatwave-level 44 °C today');
        expect(heat.cells).toEqual(['B']);
        expect(c.find(x => x.id === 'air')).toMatchObject({ severity: 'high' });
    });

    it('stays quiet on an ordinary day and ranks by severity', () => {
        expect(LN.correlate({ weather: { days: [day('2026-10-22', 31, 0)] }, air: { naqi: 90 }, exp })).toEqual([]);
        const c = LN.correlate({
            quakes: [{ id: 'q', mag: 5.8, km: 150, lat: 1, lng: 2, time: 0, place: 'Nepal' }, { id: 'small', mag: 3.1, km: 250 }],
            events: [{ id: 'e', category: 'Wildfires', title: 'Fire', km: 30, lat: 1, lng: 2 }],
        });
        expect(c.map(x => x.id)).toEqual(['quake-q', 'eonet-e']);
        expect(c[1].icon).toBe('🔥');
    });
});

describe('LN.cellsBounds()', () => {
    it('spans every cell and is null for none', () => {
        const a = globalThis.DigiPin.encode(28.6, 77.2).replace(/-/g, '').slice(0, 7);
        const b = globalThis.DigiPin.encode(28.7, 77.3).replace(/-/g, '').slice(0, 7);
        const [[w, s], [e, n]] = LN.cellsBounds([a, b]);
        expect(w).toBeLessThan(77.2); expect(e).toBeGreaterThan(77.3);
        expect(s).toBeLessThan(28.6); expect(n).toBeGreaterThan(28.7);
        expect(LN.cellsBounds([])).toBeNull();
    });
});
