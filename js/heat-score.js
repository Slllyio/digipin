/**
 * HeatScore — pure functions for the Urban Heat Island score model.
 *
 * Inputs originate from MODIS/061/MOD11A1 LST composites (see
 * pipeline/heat/extract_modis_lst.py). Raw bands are stored as
 * uint16 = Kelvin × 50 with 0 as the no-data sentinel; the browser
 * converts to °C at read time before calling any of these scorers.
 *
 * All functions are deterministic, side-effect-free, and DOM-free —
 * fully testable in Vitest without mocks. The browser orchestrator
 * (js/realtime-heat.js) supplies the inputs; this module just does math.
 */

const HeatScore = (() => {
    /** Convert MODIS LST raw uint16 (Kelvin × 50) to Celsius.
     *  0 is the MODIS no-data sentinel; nulls pass through. */
    function lstRawToCelsius(raw) {
        if (raw == null || raw === 0) return null;
        return (raw / 50) - 273.15;
    }

    /** Urban Heat Island score 0-100 based on night-LST anomaly vs surroundings.
     *  - input: cell_night_lst_c (this cell's most recent year night LST in °C)
     *           surrounding_night_lst_c (mean of surrounding cells, °C)
     *  - higher score = more intense heat island
     *  - linear: anomaly -2°C maps to 0, 0°C → 24, +2°C → 48, +4°C → 72, +6°C → 96 */
    function uhiScore({ cell_night_lst_c, surrounding_night_lst_c }) {
        if (cell_night_lst_c == null || surrounding_night_lst_c == null) return null;
        const anomaly = cell_night_lst_c - surrounding_night_lst_c;
        return Math.max(0, Math.min(100, Math.round((anomaly + 2) * 12)));
    }

    /** Diurnal range — day LST minus night LST in °C. Larger = sparse vegetation. */
    function diurnalRangeC({ day_lst_c, night_lst_c }) {
        if (day_lst_c == null || night_lst_c == null) return null;
        return day_lst_c - night_lst_c;
    }

    /** Yearly trend in night LST over the 9 years 2016-2024.
     *  Returns { slope_c_per_yr, r_squared } or null if too few valid years. */
    function nightTrend(night_lst_c_per_year) {
        const valid = (night_lst_c_per_year || []).filter(v => v != null);
        if (valid.length < 3) return null;
        const n = valid.length;
        const meanX = (n - 1) / 2;
        const meanY = valid.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0, totSS = 0;
        for (let i = 0; i < n; i++) {
            num += (i - meanX) * (valid[i] - meanY);
            den += (i - meanX) ** 2;
            totSS += (valid[i] - meanY) ** 2;
        }
        const slope = den === 0 ? 0 : num / den;
        const intercept = meanY - slope * meanX;
        let resSS = 0;
        for (let i = 0; i < n; i++) {
            resSS += (valid[i] - (slope * i + intercept)) ** 2;
        }
        const r_squared = totSS === 0 ? 1 : Math.max(0, Math.min(1, 1 - resSS / totSS));
        return { slope_c_per_yr: slope, r_squared };
    }

    return { lstRawToCelsius, uhiScore, diurnalRangeC, nightTrend };
})();

if (typeof window !== 'undefined') window.HeatScore = HeatScore;
