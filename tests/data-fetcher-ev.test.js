import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// DataFetcher is exposed on globalThis by tests/setup.js.
const { parseOCMStation, fetchEVCharging } = globalThis.DataFetcher;

describe('DataFetcher.parseOCMStation()', () => {
    const full = {
        AddressInfo: { Title: 'Mall Charger', Town: 'Indore', Distance: 3.456 },
        OperatorInfo: { Title: 'Tata Power' },
        NumberOfPoints: 4,
        StatusType: { IsOperational: true },
        Connections: [
            { ConnectionType: { Title: 'CCS' }, PowerKW: 60, Quantity: 2 },
            { ConnectionType: { Title: 'Type2' }, PowerKW: 22, Quantity: 2 },
        ],
    };

    it('flattens a complete POI, taking the max connection power', () => {
        const s = parseOCMStation(full);
        expect(s.name).toBe('Mall Charger');
        expect(s.town).toBe('Indore');
        expect(s.distanceKm).toBe(3.5);          // rounded to 1dp
        expect(s.operator).toBe('Tata Power');
        expect(s.points).toBe(4);
        expect(s.maxPowerKW).toBe(60);
        expect(s.connectionTypes).toEqual(['CCS', 'Type2']);
        expect(s.isOperational).toBe(true);
    });

    it('returns null for non-objects', () => {
        expect(parseOCMStation(null)).toBeNull();
        expect(parseOCMStation(42)).toBeNull();
    });

    it('survives an empty POI with safe defaults', () => {
        const s = parseOCMStation({});
        expect(s.name).toBe('Charging station');
        expect(s.town).toBeNull();
        expect(s.distanceKm).toBeNull();
        expect(s.maxPowerKW).toBeNull();
        expect(s.connectionTypes).toEqual([]);
        expect(s.points).toBeNull();
        expect(s.isOperational).toBeNull();
    });

    it('falls back to summed connection quantity when NumberOfPoints is absent', () => {
        const s = parseOCMStation({ Connections: [{ Quantity: 1 }, { Quantity: 2 }] });
        expect(s.points).toBe(3);
        expect(s.maxPowerKW).toBeNull(); // no PowerKW present
    });

    it('reports non-operational and dedupes connection types', () => {
        const s = parseOCMStation({
            StatusType: { IsOperational: false },
            Connections: [{ ConnectionType: { Title: 'Type2' } }, { ConnectionType: { Title: 'Type2' } }],
        });
        expect(s.isOperational).toBe(false);
        expect(s.connectionTypes).toEqual(['Type2']);
    });
});

describe('DataFetcher.fetchEVCharging()', () => {
    const POIS = [
        { AddressInfo: { Title: 'Mall', Distance: 3.4 }, OperatorInfo: { Title: 'Tata Power' }, NumberOfPoints: 4, Connections: [{ PowerKW: 60, Quantity: 2 }] },
        { AddressInfo: { Title: 'Hotel', Distance: 1.2 }, OperatorInfo: { Title: 'Statiq' }, Connections: [{ PowerKW: 7.4, Quantity: 1 }] },
        { AddressInfo: { Title: 'Far' }, Connections: [] },
    ];
    const mockFetch = (body) => vi.fn(async () => new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
    }));

    beforeEach(() => { delete window.DIGIPIN_CONFIG; });
    afterEach(() => vi.restoreAllMocks());

    it('aggregates nearby stations (sorted, fast count, points, operators)', async () => {
        globalThis.fetch = mockFetch(POIS);
        const out = await fetchEVCharging(22.7, 75.8);
        expect(out.count).toBe(3);
        expect(out.nearestKm).toBe(1.2);          // Hotel sorts first
        expect(out.fastCount).toBe(1);            // only the 60kW Mall is >=50
        expect(out.totalPoints).toBe(5);          // 4 + 1 + 0
        expect(out.operators).toEqual(['Statiq', 'Tata Power']);
        expect(out.stations[0].name).toBe('Hotel');
    });

    it('returns null when the API yields no stations', async () => {
        globalThis.fetch = mockFetch([]);
        expect(await fetchEVCharging(22.7, 75.8)).toBeNull();
    });

    it('returns null (not throw) on a non-array payload', async () => {
        globalThis.fetch = mockFetch({ error: 'nope' });
        expect(await fetchEVCharging(22.7, 75.8)).toBeNull();
    });
});
