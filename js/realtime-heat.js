/**
 * RealtimeHeat — Urban Heat Island data layer.
 *
 * Two responsibilities (matches the RealtimeGrowth shape — async fetch + pure score):
 *   1. fetchCell(lat, lng)  — async; reads the multi-band MODIS LST COG at the cell
 *                             location AND at a ring of surrounding sample points to
 *                             establish the "rural" baseline for the UHI anomaly.
 *   2. scoreCell(signals)   — pure; collapses signals to the result.realtime.heat schema.
 *
 * The orchestrator in data-fetcher.js calls fetchCell(...).then(scoreCell) and stashes
 * the result on result.realtime.heat.
 *
 * COG band order (see pipeline/heat/extract_modis_lst.py):
 *   band 0  = lst_day_2016,   band 1  = lst_night_2016,
 *   band 2  = lst_day_2017,   band 3  = lst_night_2017, ...
 *   band 16 = lst_day_2024,   band 17 = lst_night_2024.
 * Each band is uint16 = Kelvin × 50, with 0 as the no-data sentinel.
 */

const RealtimeHeat = (() => {
    const COG_LST = 'data/heat/modis_lst_2016-2024.tif';
    const YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
    // 8-point ring at ~10 km radius around the target cell, in degrees-ish.
    // 0.09° ≈ 10 km in latitude; longitude correction applied at sample time.
    const RING_RADIUS_DEG = 0.09;
    const RING_DIRS = [
        [ 1,  0], [ 1,  1], [ 0,  1], [-1,  1],
        [-1,  0], [-1, -1], [ 0, -1], [ 1, -1],
    ];

    // Reuse a parsed georaster across calls — the COG fetch is the slow bit.
    let _grPromise = null;

    async function _loadCog() {
        if (_grPromise) return _grPromise;
        _grPromise = (async () => {
            try {
                if (typeof parseGeoraster !== 'function') return null;
                const resp = await fetch(COG_LST, { cache: 'force-cache' });
                if (!resp.ok) return null;
                const buf = await resp.arrayBuffer();
                return await parseGeoraster(buf);
            } catch (e) {
                console.warn('[RealtimeHeat] COG load failed', e);
                return null;
            }
        })();
        return _grPromise;
    }

    function _readBandsAt(gr, lat, lng) {
        if (!gr) return null;
        try {
            const [px, py] = gr.toCanvasCoords([lng, lat]);
            const x = Math.floor(px), y = Math.floor(py);
            if (x < 0 || y < 0 || x >= gr.width || y >= gr.height) return null;
            const out = new Array(gr.values.length);
            for (let b = 0; b < gr.values.length; b++) {
                out[b] = gr.values[b][y][x];
            }
            return out;
        } catch (e) {
            console.warn('[RealtimeHeat] band-read failed', e);
            return null;
        }
    }

    /** Async — reads cell + 8 ring points, returns raw signal bundle. */
    async function fetchCell(lat, lng) {
        const gr = await _loadCog();
        if (!gr) {
            return { cell_bands: null, ring_bands: [], years: YEARS };
        }
        const cell_bands = _readBandsAt(gr, lat, lng);
        const cosLat = Math.cos(lat * Math.PI / 180) || 1;
        const ring_bands = [];
        for (const [dy, dx] of RING_DIRS) {
            const sLat = lat + dy * RING_RADIUS_DEG;
            const sLng = lng + (dx * RING_RADIUS_DEG) / cosLat;
            const b = _readBandsAt(gr, sLat, sLng);
            if (b) ring_bands.push(b);
        }
        return { cell_bands, ring_bands, years: YEARS };
    }

    function _mean(values) {
        const valid = values.filter(v => v != null);
        if (valid.length === 0) return null;
        return valid.reduce((a, b) => a + b, 0) / valid.length;
    }

    /** Pure — collapses raw band data to the result.realtime.heat schema. */
    function scoreCell(signals) {
        if (typeof HeatScore === 'undefined') return null;
        if (!signals || !signals.cell_bands) return null;

        const years = signals.years || YEARS;
        const nYears = years.length;
        // Band layout: [day_y0, night_y0, day_y1, night_y1, ...]
        const cellNightC = [];
        const cellDayC = [];
        for (let i = 0; i < nYears; i++) {
            cellDayC.push(HeatScore.lstRawToCelsius(signals.cell_bands[i * 2]));
            cellNightC.push(HeatScore.lstRawToCelsius(signals.cell_bands[i * 2 + 1]));
        }

        // Most-recent valid night/day reading for this cell
        const lastValid = (arr) => {
            for (let i = arr.length - 1; i >= 0; i--) {
                if (arr[i] != null) return arr[i];
            }
            return null;
        };
        const night_lst_c = lastValid(cellNightC);
        const day_lst_c = lastValid(cellDayC);

        // Surrounding night mean = mean over ring points of their most-recent-year night value
        const ringRecentNight = [];
        for (const bands of (signals.ring_bands || [])) {
            const idx = (nYears - 1) * 2 + 1;
            const c = HeatScore.lstRawToCelsius(bands[idx]);
            if (c != null) ringRecentNight.push(c);
        }
        const surrounding_night_lst_c = _mean(ringRecentNight);

        const uhi_score = HeatScore.uhiScore({
            cell_night_lst_c: night_lst_c,
            surrounding_night_lst_c,
        });
        const diurnal_range_c = HeatScore.diurnalRangeC({ day_lst_c, night_lst_c });
        const trend = HeatScore.nightTrend(cellNightC);
        const anomaly_c = (night_lst_c != null && surrounding_night_lst_c != null)
            ? night_lst_c - surrounding_night_lst_c
            : null;

        if (uhi_score == null && night_lst_c == null && day_lst_c == null) return null;

        return {
            uhi_score,
            anomaly_c,
            night_lst_c,
            day_lst_c,
            diurnal_range_c,
            trend,
            sources: {
                modis_lst: signals.cell_bands ? 'ok' : 'missing',
                surroundings: ringRecentNight.length > 0 ? 'ok' : 'missing',
            },
            generated_at_iso: new Date().toISOString(),
        };
    }

    return { fetchCell, scoreCell };
})();

if (typeof window !== 'undefined') {
    window.RealtimeHeat = RealtimeHeat;
}
