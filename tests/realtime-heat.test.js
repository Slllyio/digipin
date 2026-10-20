import { describe, it, expect } from 'vitest';

// RealtimeHeat + HeatScore are exposed on globalThis by tests/setup.js.
const RealtimeHeat = globalThis.RealtimeHeat;

// MODIS LST raw = Kelvin x 50; 0 = no-data. Helper: Celsius -> raw.
const raw = (celsius) => Math.round((celsius + 273.15) * 50);

// 3 years of day/night for a cell at a steady day=38C / night=28C.
const YEARS = [2018, 2019, 2020];
const hotCellBands = [
    raw(38), raw(28), raw(38), raw(28), raw(38), raw(28),
];
// ring point whose most-recent-year night (index 5) is 24C
const coolRing = [0, 0, 0, 0, raw(38), raw(24)];

describe('RealtimeHeat.scoreCell()', () => {
    it('returns null for missing/empty signals', () => {
        expect(RealtimeHeat.scoreCell(null)).toBeNull();
        expect(RealtimeHeat.scoreCell({})).toBeNull();
        expect(RealtimeHeat.scoreCell({ cell_bands: null })).toBeNull();
    });

    it('returns null when every band is the no-data sentinel (0)', () => {
        const signals = { years: YEARS, cell_bands: [0, 0, 0, 0, 0, 0], ring_bands: [[0, 0, 0, 0, 0, 0]] };
        expect(RealtimeHeat.scoreCell(signals)).toBeNull();
    });

    it('collapses bands into the heat schema with a UHI anomaly', () => {
        const signals = { years: YEARS, cell_bands: hotCellBands, ring_bands: [coolRing, coolRing] };
        const out = RealtimeHeat.scoreCell(signals);

        expect(out).not.toBeNull();
        expect(out.night_lst_c).toBeCloseTo(28, 1);
        expect(out.day_lst_c).toBeCloseTo(38, 1);
        // diurnal range = day - night = 10
        expect(out.diurnal_range_c).toBeCloseTo(10, 1);
        // anomaly = cell night (28) - surrounding night (24) = +4
        expect(out.anomaly_c).toBeCloseTo(4, 1);
        // uhiScore = round((anomaly + 2) * 12) = round(72)
        expect(out.uhi_score).toBe(72);
        expect(typeof out.generated_at_iso).toBe('string');
        expect(out.sources.modis_lst).toBe('ok');
        expect(out.sources.surroundings).toBe('ok');
    });

    it('flags missing surroundings when no ring data is usable', () => {
        const signals = { years: YEARS, cell_bands: hotCellBands, ring_bands: [] };
        const out = RealtimeHeat.scoreCell(signals);
        expect(out).not.toBeNull();
        expect(out.sources.surroundings).toBe('missing');
        // no surrounding mean -> uhi cannot be computed
        expect(out.uhi_score).toBeNull();
        expect(out.anomaly_c).toBeNull();
    });

    it('uses the most-recent valid year when the latest is no-data', () => {
        // last year's readings are sentinels; should fall back to year 2 (28C)
        const bands = [raw(38), raw(28), raw(39), raw(29), 0, 0];
        const out = RealtimeHeat.scoreCell({ years: YEARS, cell_bands: bands, ring_bands: [coolRing] });
        expect(out.night_lst_c).toBeCloseTo(29, 1); // 2019 night, since 2020 is no-data
    });
});
