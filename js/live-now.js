/**
 * LiveNow — "right now, here": live weather, air and river flow for the
 * selected DIGIPIN cell (or the map centre), and *correlations*: live feeds
 * checked against the cell data we already hold, so a forecast turns into
 * "heavy rain on Thursday · 1.2 lakh people live in 100-year flood cells".
 *
 * Idea from the Offentligdata OSINT dashboard (current-place weather card and
 * its Correlations layer), rebuilt on keyless, CORS-open sources:
 *  - Open-Meteo forecast, air quality (CAMS) and flood (GloFAS v4) APIs
 *  - USGS earthquake feed (M2.5+, past 7 days)
 *  - NASA EONET open natural events (fires, storms, floods, volcanoes)
 *  - NDMA SACHET alerts when the scraped snapshot is fresh (RealtimeAlerts)
 * Exposure comes from CellStore: population, water (JRC/GloFAS flood depth)
 * and surface_heat (MODIS/Landsat heat island) for the cells in view.
 *
 * Everything above the "map / DOM" line is pure and unit-tested.
 */
const LiveNow = (() => {
    const METEO = 'https://api.open-meteo.com/v1/forecast';
    const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
    const FLOOD = 'https://flood-api.open-meteo.com/v1/flood';
    const USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';
    const EONET = 'https://eonet.gsfc.nasa.gov/api/v3/events';
    const KP = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
    const REFRESH_MS = 10 * 60 * 1000;
    const NEAR_KM = 300;
    const PANEL_ID = 'live-now-panel';
    const CELLS_SRC = 'live-now-cells';
    const POINTS_SRC = 'live-now-points';

    // IMD 24-hour rainfall classes (mm).
    const RAIN = { moderate: 15.6, heavy: 64.5, veryHeavy: 115.6, extreme: 204.5 };
    // CPCB National AQI breakpoints: [conc lo, conc hi, index lo, index hi].
    const NAQI_BP = {
        pm25: [[0, 30, 0, 50], [31, 60, 51, 100], [61, 90, 101, 200], [91, 120, 201, 300], [121, 250, 301, 400], [251, 500, 401, 500]],
        pm10: [[0, 50, 0, 50], [51, 100, 51, 100], [101, 250, 101, 200], [251, 350, 201, 300], [351, 430, 301, 400], [431, 600, 401, 500]],
    };
    const NAQI_BANDS = [
        [50, 'Good', '#3a9d4a'], [100, 'Satisfactory', '#8cc63f'], [200, 'Moderate', '#e6c229'],
        [300, 'Poor', '#f28c28'], [400, 'Very Poor', '#d7372f'], [Infinity, 'Severe', '#8b1a1a'],
    ];
    const WMO = {
        0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
        45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌦️'],
        61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'],
        82: ['Violent showers', '⛈️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
    };
    const SEV_RANK = { high: 3, medium: 2, low: 1 };

    // ---------- pure ----------

    function forecastUrl(lat, lng) {
        return `${METEO}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
            + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day'
            + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code'
            + '&timezone=Asia%2FKolkata&forecast_days=3';
    }

    function airUrl(lat, lng) {
        return `${AIR}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
            + '&current=pm2_5,pm10,nitrogen_dioxide,ozone,us_aqi&timezone=Asia%2FKolkata';
    }

    /** GloFAS is a 0.05° grid: sample a 7×7 block (~35 km) and keep the biggest river. */
    function floodUrl(lat, lng, half = 3, step = 0.05) {
        const la = [], lo = [];
        for (let i = -half; i <= half; i++) {
            for (let j = -half; j <= half; j++) {
                la.push((lat + i * step).toFixed(3));
                lo.push((lng + j * step).toFixed(3));
            }
        }
        return `${FLOOD}?latitude=${la.join(',')}&longitude=${lo.join(',')}&daily=river_discharge&past_days=30&forecast_days=7`;
    }

    function eonetUrl(lat, lng, deg = 3) {
        // EONET bbox order: min lon, max lat, max lon, min lat.
        const b = [lng - deg, lat + deg, lng + deg, lat - deg].map(v => v.toFixed(2)).join(',');
        return `${EONET}?status=open&days=30&bbox=${b}`;
    }

    function distanceKm(lat1, lng1, lat2, lng2) {
        const r = Math.PI / 180;
        const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(s)));
    }

    function weatherLabel(code) {
        const w = WMO[code] || WMO[Math.floor(code / 10) * 10] || ['—', '🌡️'];
        return { text: w[0], icon: w[1] };
    }

    function parseWeather(j) {
        if (!j || !j.current || !j.daily) return null;
        const c = j.current, d = j.daily;
        return {
            time: c.time,
            temp: c.temperature_2m, feels: c.apparent_temperature, rh: c.relative_humidity_2m,
            rain: c.precipitation, wind: c.wind_speed_10m, code: c.weather_code, isDay: c.is_day === 1,
            days: (d.time || []).map((t, i) => ({
                date: t,
                tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i],
                rain: d.precipitation_sum[i], rainProb: d.precipitation_probability_max[i],
                code: d.weather_code[i],
            })),
        };
    }

    /** CPCB sub-index for one pollutant, or null. */
    function subIndex(pollutant, conc) {
        const bps = NAQI_BP[pollutant];
        if (!bps || conc == null || !isFinite(conc)) return null;
        const c = Math.max(0, conc);
        const bp = bps.find(b => c <= b[1] + 0.999) || bps[bps.length - 1];
        const [clo, chi, ilo, ihi] = bp;
        return Math.round(Math.min(500, ilo + (Math.min(c, chi) - clo) * (ihi - ilo) / (chi - clo)));
    }

    function naqiBand(index) {
        const b = NAQI_BANDS.find(x => index <= x[0]);
        return { label: b[1], color: b[2] };
    }

    function parseAir(j) {
        const c = j && j.current;
        if (!c) return null;
        const subs = { pm25: subIndex('pm25', c.pm2_5), pm10: subIndex('pm10', c.pm10) };
        const valid = Object.entries(subs).filter(([, v]) => v != null);
        if (!valid.length) return null;
        const [dominant, naqi] = valid.sort((a, b) => b[1] - a[1])[0];
        return {
            time: c.time, pm25: c.pm2_5, pm10: c.pm10, no2: c.nitrogen_dioxide, o3: c.ozone,
            naqi, dominant: dominant === 'pm25' ? 'PM2.5' : 'PM10', band: naqiBand(naqi),
        };
    }

    /** The largest river in the sampled block: today, 7-day peak and 30-day mean. */
    function parseFlood(j, now = new Date()) {
        const arr = Array.isArray(j) ? j : (j ? [j] : []);
        const today = now.toISOString().slice(0, 10);
        let best = null;
        for (const p of arr) {
            const d = p && p.daily;
            if (!d || !Array.isArray(d.river_discharge)) continue;
            const max = Math.max(...d.river_discharge.map(v => v ?? 0));
            if (!best || max > best.max) best = { max, lat: p.latitude, lng: p.longitude, d };
        }
        if (!best || !(best.max > 0)) return null;
        const { time, river_discharge: q } = best.d;
        let ti = time.indexOf(today);
        if (ti < 0) ti = time.findIndex(t => t > today) - 1;
        if (ti < 0) ti = Math.max(0, time.length - 8);
        const past = q.slice(0, ti).filter(v => v != null);
        const ahead = q.slice(ti).map((v, k) => ({ v: v ?? 0, date: time[ti + k] }));
        const peak = ahead.reduce((a, b) => (b.v > a.v ? b : a), ahead[0] || { v: 0, date: today });
        const mean30 = past.length ? past.reduce((a, b) => a + b, 0) / past.length : null;
        const nowQ = q[ti] ?? null;
        const last = ahead.length ? ahead[ahead.length - 1].v : nowQ;
        const trend = nowQ == null ? 'steady' : last > nowQ * 1.1 ? 'rising' : last < nowQ * 0.9 ? 'falling' : 'steady';
        return { lat: best.lat, lng: best.lng, now: nowQ, peak: peak.v, peakDate: peak.date, mean30, trend, series: q.slice(ti) };
    }

    function parseQuakes(j, lat, lng, maxKm = NEAR_KM) {
        return ((j && j.features) || []).map(f => {
            const [qlng, qlat, depth] = f.geometry.coordinates;
            return {
                id: f.id, mag: f.properties.mag, place: f.properties.place, time: f.properties.time,
                url: f.properties.url, lat: qlat, lng: qlng, depth, km: distanceKm(lat, lng, qlat, qlng),
            };
        }).filter(q => q.km <= maxKm).sort((a, b) => a.km - b.km);
    }

    function parseEvents(j, lat, lng, maxKm = NEAR_KM) {
        const out = [];
        for (const e of (j && j.events) || []) {
            const g = (e.geometry || []).filter(x => x.type === 'Point').pop();
            if (!g) continue;
            const [elng, elat] = g.coordinates;
            const km = distanceKm(lat, lng, elat, elng);
            if (km > maxKm) continue;
            out.push({ id: e.id, title: e.title, category: (e.categories && e.categories[0] && e.categories[0].title) || 'Event', date: g.date, lat: elat, lng: elng, km, url: e.link });
        }
        return out.sort((a, b) => a.km - b.km);
    }

    /** NOAA Kp product → { now, max24, maxAt }: latest observed/estimated Kp and the 24 h peak ahead. */
    function parseKp(rows, now = new Date()) {
        if (!Array.isArray(rows)) return null;
        const t = now.getTime();
        let cur = null, max24 = null, maxAt = null;
        for (const r of rows) {
            if (!r || typeof r !== 'object' || !Number.isFinite(+r.kp)) continue;
            const at = Date.parse(`${r.time_tag}Z`);
            if (!Number.isFinite(at)) continue;
            if (at <= t && r.observed !== 'predicted') cur = +r.kp;
            if (at > t - 3 * 3600e3 && at <= t + 24 * 3600e3 && (max24 == null || +r.kp > max24)) { max24 = +r.kp; maxAt = r.time_tag; }
        }
        if (cur == null && max24 == null) return null;
        return { now: cur ?? max24, max24: max24 ?? cur, maxAt };
    }

    /**
     * Whether now is a good time for accurate phone / field GNSS geotagging.
     * Geomagnetic storms (Kp ≥ 5) degrade fixes everywhere; India also sits
     * under the equatorial ionisation anomaly, where post-sunset scintillation
     * (≈ 19:00–01:00 IST, worst around the equinox months) causes jumps and
     * dropouts south of ~26° N.
     */
    function gnssCondition(kp, lat, now = new Date()) {
        const reasons = [];
        let level = 'good';
        const k = kp ? Math.max(kp.now ?? 0, kp.max24 ?? 0) : null;
        if (k != null && k >= 7) { level = 'poor'; reasons.push(`severe geomagnetic storm (Kp ${k.toFixed(0)})`); }
        else if (k != null && k >= 5) { level = 'caution'; reasons.push(`geomagnetic storm (Kp ${k.toFixed(0)})`); }
        const ist = (now.getUTCHours() + now.getUTCMinutes() / 60 + 5.5) % 24;
        const month = new Date(now.getTime() + 5.5 * 3600e3).getUTCMonth() + 1;
        const equinox = [2, 3, 4, 8, 9, 10].includes(month);
        if (lat < 26 && (ist >= 19 || ist < 1) && equinox) {
            if (level === 'good') level = 'caution';
            reasons.push('post-sunset ionospheric scintillation season');
        }
        return { level, kp: k, reasons, label: { good: 'Good', caution: 'Caution', poor: 'Poor' }[level] };
    }

    /**
     * People exposed in the loaded cells. Tables are CellStore tables
     * ({ cells, columns }); any of them may be null.
     */
    function exposure(pop, water, heat, opts = {}) {
        const floodPct = opts.floodPct ?? 5, uhi = opts.uhiC ?? 2;
        const out = { cells: 0, pop: 0, floodPop: 0, floodCells: [], heatPop: 0, heatCells: [] };
        if (!pop || !pop.cells) return out;
        const idx = (t) => {
            if (!t || !t.cells) return null;
            if (t.index) return t.index;
            const m = new Map(); t.cells.forEach((c, i) => m.set(c, i)); return m;
        };
        const wi = idx(water), hi = idx(heat);
        pop.cells.forEach((code, i) => {
            const p = pop.columns.population[i];
            if (!(p > 0)) return;
            out.cells++;
            out.pop += p;
            const w = wi && wi.get(code);
            if (w != null && (water.columns.flood_rp100_pct[w] ?? 0) >= floodPct) { out.floodPop += p; out.floodCells.push(code); }
            const h = hi && hi.get(code);
            if (h != null && (heat.columns.uhi_anomaly_c[h] ?? -Infinity) >= uhi) { out.heatPop += p; out.heatCells.push(code); }
        });
        out.pop = Math.round(out.pop); out.floodPop = Math.round(out.floodPop); out.heatPop = Math.round(out.heatPop);
        return out;
    }

    /** Indian-style people count: 12,400 / 3.4 lakh / 1.2 crore. */
    function fmtPeople(n) {
        if (!(n > 0)) return '0';
        if (n >= 1e7) return `${(n / 1e7).toFixed(n >= 1e8 ? 0 : 1)} crore`;
        if (n >= 1e5) return `${(n / 1e5).toFixed(n >= 1e6 ? 0 : 1)} lakh`;
        return Math.round(n).toLocaleString('en-IN');
    }

    /** Today's date in India (the forecast is requested in Asia/Kolkata). */
    function istDate(now = new Date()) {
        return new Date(now.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
    }

    function _day(date, today) {
        if (!date) return '';
        if (date === today) return 'today';
        const d = new Date(`${date}T00:00:00Z`);
        return d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
    }

    /**
     * Live feeds × exposure → a ranked list of correlations.
     * Each: { id, kind, severity, icon, title, detail, lat?, lng?, cells? }.
     */
    function correlate({ weather, air, river, quakes, events, alerts, exp, gnss, today } = {}) {
        const out = [];
        exp = exp || exposure(null);
        today = today || istDate();
        const riverUp = river && river.mean30 > 0 && river.peak >= 50 && river.peak >= 1.5 * river.mean30;

        const wet = weather && weather.days && weather.days.reduce((a, b) => ((b.rain ?? 0) > (a.rain ?? 0) ? b : a), weather.days[0]);
        if (wet && wet.rain >= RAIN.moderate) {
            const cls = wet.rain >= RAIN.extreme ? 'Extremely heavy' : wet.rain >= RAIN.veryHeavy ? 'Very heavy'
                : wet.rain >= RAIN.heavy ? 'Heavy' : 'Moderate';
            const severity = wet.rain >= RAIN.veryHeavy || (wet.rain >= RAIN.heavy && riverUp) ? 'high'
                : wet.rain >= RAIN.heavy ? 'medium' : 'low';
            if (severity !== 'low' || exp.floodPop > 0) {
                out.push({
                    id: 'rain-flood', kind: 'flood', severity, icon: '🌧️',
                    title: `${cls} rain ${_day(wet.date, today)}: ${Math.round(wet.rain)} mm`,
                    detail: exp.floodPop > 0
                        ? `${fmtPeople(exp.floodPop)} people in view live in cells with 100-year flood depth${riverUp ? ', and the river is rising' : ''}.`
                        : 'No 100-year flood cells loaded in view.',
                    cells: exp.floodCells,
                });
            }
        }

        if (riverUp) {
            out.push({
                id: 'river', kind: 'flood', severity: river.peak >= 3 * river.mean30 ? 'high' : 'medium', icon: '🌊',
                title: `River flow rising to ${Math.round(river.peak)} m³/s ${_day(river.peakDate, today)}`,
                detail: `${(river.peak / river.mean30).toFixed(1)}× its 30-day average (GloFAS).`
                    + (exp.floodPop > 0 ? ` ${fmtPeople(exp.floodPop)} people in flood cells in view.` : ''),
                lat: river.lat, lng: river.lng, cells: exp.floodCells,
            });
        }

        const hot = weather && weather.days && weather.days.reduce((a, b) => ((b.tmax ?? -99) > (a.tmax ?? -99) ? b : a), weather.days[0]);
        if (hot && hot.tmax >= 37 && (hot.tmax >= 40 || exp.heatPop > 0)) {
            out.push({
                id: 'heat', kind: 'heat', icon: '🌡️',
                severity: hot.tmax >= 45 ? 'high' : hot.tmax >= 40 ? 'medium' : 'low',
                title: `${hot.tmax >= 40 ? 'Heatwave-level' : 'Hot'} ${Math.round(hot.tmax)} °C ${_day(hot.date, today)}`,
                detail: exp.heatPop > 0
                    ? `${fmtPeople(exp.heatPop)} people live in cells at least 2 °C hotter than the city (heat island).`
                    : 'No heat-island cells loaded in view.',
                cells: exp.heatCells,
            });
        }

        if (air && air.naqi > 200) {
            out.push({
                id: 'air', kind: 'air', icon: '😷', severity: air.naqi > 300 ? 'high' : 'medium',
                title: `Air is ${air.band.label} (AQI ${air.naqi}, ${air.dominant})`,
                detail: exp.pop > 0 ? `${fmtPeople(exp.pop)} people live in the cells in view.` : 'Indicative: from the hourly CAMS model, not a CPCB station.',
            });
        }

        for (const q of quakes || []) {
            if (!(q.mag >= 4 || (q.mag >= 3 && q.km <= 100))) continue;
            out.push({
                id: `quake-${q.id}`, kind: 'quake', icon: '〰️', severity: q.mag >= 5.5 && q.km <= 200 ? 'high' : q.mag >= 4.5 ? 'medium' : 'low',
                title: `M${q.mag.toFixed(1)} earthquake ${Math.round(q.km)} km away`,
                detail: `${q.place || ''} · ${new Date(q.time).toLocaleDateString('en-IN')}`.trim(),
                lat: q.lat, lng: q.lng, url: q.url,
            });
        }

        for (const e of (events || []).slice(0, 6)) {
            const fire = /fire/i.test(e.category);
            out.push({
                id: `eonet-${e.id}`, kind: 'event', icon: fire ? '🔥' : /storm|cyclone/i.test(e.category) ? '🌀' : /flood/i.test(e.category) ? '🌊' : '⚠️',
                severity: e.km <= 50 ? 'medium' : 'low',
                title: `${e.category}: ${Math.round(e.km)} km away`,
                detail: e.title, lat: e.lat, lng: e.lng, url: e.url,
            });
        }

        if (gnss && gnss.level !== 'good' && gnss.kp != null && gnss.kp >= 5) {
            out.push({
                id: 'gnss', kind: 'gnss', icon: '📡', severity: gnss.level === 'poor' ? 'high' : 'medium',
                title: `GPS accuracy degraded: ${gnss.reasons[0]}`,
                detail: 'Phone and field GNSS fixes may drift by tens of metres, several DIGIPIN 4 m cells. Re-check geotags taken now.',
            });
        }

        for (const a of (alerts || []).slice(0, 3)) {
            out.push({
                id: `sachet-${a.identifier || a.headline}`, kind: 'alert', icon: '📣',
                severity: a.severity === 'Extreme' ? 'high' : 'medium',
                title: a.headline || 'NDMA alert', detail: a.area || a.description || '',
            });
        }

        return out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
    }

    /** [[west, south], [east, north]] around DIGIPIN cells, or null. */
    function cellsBounds(codes) {
        let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
        for (const code of codes || []) {
            const b = DigiPin.cellBounds(code).bounds;
            if (b.west < w) w = b.west; if (b.south < so) so = b.south;
            if (b.east > e) e = b.east; if (b.north > n) n = b.north;
        }
        return Number.isFinite(w) ? [[w, so], [e, n]] : null;
    }

    // ---------- map / DOM ----------

    let _map = null;
    let _active = false;
    let _panel = null;
    let _timer = null;
    let _moveTimer = null;
    let _reqId = 0;
    let _last = null;   // { target, weather, air, river, quakes, events, exp, correlations, checks }
    let _onMove = null;
    let _shown = 0;     // cells painted by the last focus()

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind);
    }

    function _target() {
        const code = typeof MapModule !== 'undefined' && MapModule.getSelectedCode ? MapModule.getSelectedCode() : null;
        if (code && typeof DigiPin !== 'undefined' && DigiPin.cellBounds) {
            try {
                const c = DigiPin.cellBounds(String(code).replace(/-/g, ''));
                if (Number.isFinite(c.lat)) return { lat: c.lat, lng: c.lng, code };
            } catch { /* fall back to centre */ }
        }
        const m = _map.getCenter();
        return { lat: m.lat, lng: m.lng, code: null };
    }

    function _place(target) {
        const city = typeof CitySelector !== 'undefined' && CitySelector.getCurrent ? CitySelector.getCurrent() : null;
        if (target.code) return `Cell ${target.code}`;
        return city && city.name ? `${city.name} · map centre` : 'Map centre';
    }

    // Responses are reused for 10 minutes (pans back and forth, refresh
    // clicks) and a failed call is retried once: Open-Meteo answers 429 when
    // a shared IP is busy.
    const _cache = new Map();   // url -> { at, json }
    async function _json(url, ms = 12000) {
        const hit = _cache.get(url);
        if (hit && Date.now() - hit.at < REFRESH_MS) return hit.json;
        let err;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt) await new Promise(res => setTimeout(res, 1500));
            try {
                const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const json = await r.json();
                _cache.set(url, { at: Date.now(), json });
                if (_cache.size > 40) _cache.delete(_cache.keys().next().value);
                return json;
            } catch (e) { err = e; }
        }
        throw err;
    }

    async function _exposure() {
        if (typeof CellStore === 'undefined' || !CellStore.loadView) return null;
        const b = _map.getBounds();
        const bbox = { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
        const [pop, water, heat] = await Promise.all(['population', 'water', 'surface_heat']
            .map(id => (CellStore.get(id) ? CellStore.loadView(id, bbox).catch(() => null) : null)));
        if (!pop) return null;
        // loadView returns the overlapping shards; keep the cells actually in view.
        const inView = (t) => {
            if (!t) return t;
            const keep = [];
            t.cells.forEach((c, i) => {
                const cb = DigiPin.cellBounds(c);
                if (cb.lat >= bbox.south && cb.lat <= bbox.north && cb.lng >= bbox.west && cb.lng <= bbox.east) keep.push(i);
            });
            const cols = {};
            for (const k of Object.keys(t.columns)) cols[k] = keep.map(i => t.columns[k][i]);
            return { cells: keep.map(i => t.cells[i]), columns: cols };
        };
        return exposure(inView(pop), inView(water), inView(heat));
    }

    async function refresh() {
        if (!_active || !_map) return;
        const reqId = ++_reqId;
        const target = _target();
        _render({ loading: true, target });
        const settle = (p) => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
        const alertsP = typeof RealtimeAlerts !== 'undefined' && RealtimeAlerts.getForLocation
            ? (async () => {
                const city = typeof CitySelector !== 'undefined' && CitySelector.currentArea ? CitySelector.currentArea() : null;
                const all = await RealtimeAlerts.getForLocation(city && city.region, city && city.name);
                // Only a fresh SACHET snapshot counts as "live".
                const age = RealtimeAlerts.staleness && RealtimeAlerts.staleness(RealtimeAlerts.getGeneratedAt());
                if (!age || age.stale) return [];
                return RealtimeAlerts.filterBySeverity(all, 'Severe');
            })() : Promise.resolve([]);
        const [w, a, f, q, e, al, x, k] = await Promise.all([
            settle(_json(forecastUrl(target.lat, target.lng))),
            settle(_json(airUrl(target.lat, target.lng))),
            settle(_json(floodUrl(target.lat, target.lng), 15000)),
            settle(_json(USGS)),
            settle(_json(eonetUrl(target.lat, target.lng))),
            settle(alertsP),
            settle(_exposure()),
            settle(_json(KP)),
        ]);
        if (reqId !== _reqId || !_active) return;
        const weather = w.ok ? parseWeather(w.v) : null;
        const air = a.ok ? parseAir(a.v) : null;
        const river = f.ok ? parseFlood(f.v) : null;
        const quakes = q.ok ? parseQuakes(q.v, target.lat, target.lng) : [];
        const events = e.ok ? parseEvents(e.v, target.lat, target.lng) : [];
        const exp = x.ok && x.v ? x.v : null;
        const kp = k.ok ? parseKp(k.v) : null;
        const gnss = kp ? gnssCondition(kp, target.lat) : null;
        const correlations = correlate({ weather, air, river, quakes, events, alerts: al.ok ? al.v : [], exp, gnss });
        const checks = [
            ['Weather forecast (Open-Meteo)', !!weather],
            ['Air quality (CAMS via Open-Meteo)', !!air],
            ['River flow (GloFAS via Open-Meteo)', f.ok],
            [`Earthquakes within ${NEAR_KM} km (USGS)`, q.ok],
            [`Natural events within ${NEAR_KM} km (NASA EONET)`, e.ok],
            ['People, flood and heat cells in view (DigiPin cells)', !!exp],
            ['Space weather for GNSS (NOAA SWPC Kp)', !!kp],
        ];
        _last = { target, weather, air, river, quakes, events, exp, gnss, correlations, checks, at: new Date() };
        _render(_last);
        _drawPoints();
        _setBadge(correlations.length);
    }

    function _setBadge(n) {
        const btn = document.getElementById('btn-livenow');
        if (!btn) return;
        let b = btn.querySelector('.tb-badge');
        if (!n) { if (b) b.remove(); return; }
        if (!b) { b = document.createElement('span'); b.className = 'tb-badge'; btn.appendChild(b); }
        b.textContent = String(n);
    }

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function _render(s) {
        if (!_panel) {
            _panel = _el('section', 'live-now-panel');
            _panel.id = PANEL_ID;
            _panel.setAttribute('aria-label', 'Live now: weather, air, river and correlations');
            _panel.setAttribute('aria-live', 'polite');
            // Light theme on wide screens: dock into the Aino right-hand column
            // (in place of the city overview card) instead of floating over it.
            const col = document.getElementById('aino-right');
            if (col && getComputedStyle(col).display !== 'none') {
                _panel.classList.add('is-docked');
                col.classList.add('has-live-now');
                col.appendChild(_panel);
            } else {
                document.body.appendChild(_panel);
            }
        }
        _panel.replaceChildren();
        const head = _el('header', 'ln-head');
        const ttl = _el('div', 'ln-title');
        ttl.append(_el('span', 'ln-kicker', 'LIVE NOW'), _el('strong', 'ln-place', _place(s.target)));
        const btns = _el('div', 'ln-btns');
        const re = _el('button', 'ln-btn', '↻'); re.type = 'button'; re.title = 'Refresh'; re.setAttribute('aria-label', 'Refresh live data');
        re.addEventListener('click', () => { _cache.clear(); refresh(); });
        const x = _el('button', 'ln-btn', '×'); x.type = 'button'; x.title = 'Close'; x.setAttribute('aria-label', 'Close live panel');
        x.addEventListener('click', () => { detach(); _syncButton(false); });
        btns.append(re, x);
        head.append(ttl, btns);
        _panel.appendChild(head);
        if (s.loading) { _panel.appendChild(_el('div', 'ln-loading', 'Checking live feeds…')); return; }

        const w = s.weather;
        if (w) {
            const now = _el('div', 'ln-weather');
            const lbl = weatherLabel(w.code);
            now.append(_el('span', 'ln-wx-icon', w.isDay || w.code > 3 ? lbl.icon : '🌙'),
                _el('span', 'ln-temp', `${Math.round(w.temp)}°`));
            const meta = _el('div', 'ln-wx-meta');
            meta.append(_el('div', null, lbl.text),
                _el('div', 'ln-dim', `Feels ${Math.round(w.feels)}° · RH ${w.rh}% · wind ${Math.round(w.wind)} km/h`));
            now.appendChild(meta);
            _panel.appendChild(now);
            const strip = _el('div', 'ln-days');
            const today = istDate();
            w.days.forEach(d => {
                const c = _el('div', 'ln-day');
                c.append(_el('span', 'ln-dim', _day(d.date, today)), _el('span', null, weatherLabel(d.code).icon),
                    _el('span', null, `${Math.round(d.tmax)}° / ${Math.round(d.tmin)}°`),
                    _el('span', 'ln-dim', d.rain > 0.2 ? `${d.rain.toFixed(d.rain < 10 ? 1 : 0)} mm` : 'dry'));
                strip.appendChild(c);
            });
            _panel.appendChild(strip);
        }

        const facts = _el('div', 'ln-facts');
        if (s.air) {
            const a = _el('div', 'ln-fact');
            const chip = _el('span', 'ln-aqi', String(s.air.naqi));
            chip.style.background = s.air.band.color;
            a.append(chip, _el('span', null, `AQI · ${s.air.band.label}`),
                _el('span', 'ln-dim', `PM2.5 ${Math.round(s.air.pm25)} · PM10 ${Math.round(s.air.pm10)} µg/m³`));
            a.title = 'Indicative CPCB National AQI from the hourly CAMS forecast (not a station reading).';
            facts.appendChild(a);
        }
        if (s.river) {
            const r = _el('div', 'ln-fact');
            const arrow = s.river.trend === 'rising' ? '↗' : s.river.trend === 'falling' ? '↘' : '→';
            r.append(_el('span', 'ln-aqi ln-river', arrow), _el('span', null, `River ${Math.round(s.river.now ?? 0)} m³/s`),
                _el('span', 'ln-dim', `7-day peak ${Math.round(s.river.peak)} · 30-day avg ${Math.round(s.river.mean30 ?? 0)}`));
            r.title = 'Largest river within ~17 km, GloFAS v4 discharge.';
            facts.appendChild(r);
        }
        if (s.gnss) {
            const g = _el('div', 'ln-fact');
            const chip = _el('span', `ln-aqi ln-gnss ln-gnss-${s.gnss.level}`, '📡');
            g.append(chip, _el('span', null, `GPS field accuracy · ${s.gnss.label}`),
                _el('span', 'ln-dim', [s.gnss.kp != null ? `Kp ${s.gnss.kp.toFixed(1)}` : null, ...s.gnss.reasons].filter(Boolean).join(' · ') || 'quiet ionosphere'));
            g.title = 'For geotagging DIGIPINs in the field: NOAA planetary Kp (now and next 24 h) plus the post-sunset scintillation window over India.';
            facts.appendChild(g);
        }
        if (s.exp && s.exp.pop > 0) {
            const p = _el('div', 'ln-fact');
            p.append(_el('span', 'ln-aqi ln-pop', '👥'), _el('span', null, `${fmtPeople(s.exp.pop)} people in view`),
                _el('span', 'ln-dim', `${fmtPeople(s.exp.floodPop)} in flood cells · ${fmtPeople(s.exp.heatPop)} in heat-island cells`));
            facts.appendChild(p);
        }
        _panel.appendChild(facts);

        const corrHead = _el('div', 'ln-section');
        corrHead.append(_el('span', null, 'CORRELATIONS'), _el('span', 'ln-count', String(s.correlations.length)));
        _panel.appendChild(corrHead);
        if (!s.correlations.length) {
            _panel.appendChild(_el('div', 'ln-clear', 'Nothing live lines up with this area right now.'));
        }
        const list = _el('ul', 'ln-corr');
        s.correlations.forEach(c => {
            const li = _el('li', `ln-c ln-${c.severity}`);
            const b = _el('button', 'ln-c-btn'); b.type = 'button';
            b.append(_el('span', 'ln-c-icon', c.icon));
            const txt = _el('span', 'ln-c-txt');
            txt.append(_el('strong', null, c.title), _el('span', 'ln-dim', c.detail));
            b.appendChild(txt);
            b.addEventListener('click', () => focus(c));
            li.appendChild(b);
            list.appendChild(li);
        });
        _panel.appendChild(list);

        const chk = _el('details', 'ln-checks');
        chk.appendChild(_el('summary', null, `Checked ${s.checks.filter(c => c[1]).length} of ${s.checks.length} feeds · ${s.at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`));
        const ul = _el('ul');
        s.checks.forEach(([name, ok]) => ul.appendChild(_el('li', ok ? 'ok' : 'fail', `${ok ? '✓' : '✗'} ${name}`)));
        chk.appendChild(ul);
        _panel.appendChild(chk);
    }

    function _cellsGeoJSON(codes) {
        return {
            type: 'FeatureCollection',
            features: (codes || []).slice(0, 5000).map(code => {
                const b = DigiPin.cellBounds(code).bounds;
                return { type: 'Feature', properties: { code }, geometry: { type: 'Polygon', coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]] } };
            }),
        };
    }

    function _drawPoints() {
        if (!_map || !_last || !_active) return;
        const fc = {
            type: 'FeatureCollection',
            features: [...(_last.quakes || []).filter(q => q.mag >= 3), ...(_last.events || [])].map(p => ({
                type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: { kind: p.mag != null ? 'quake' : 'event', label: p.mag != null ? `M${p.mag.toFixed(1)}` : p.category },
            })),
        };
        if (_map.getSource(POINTS_SRC)) _map.getSource(POINTS_SRC).setData(fc);
        else if (!_styleReady()) return;
        else {
            _map.addSource(POINTS_SRC, { type: 'geojson', data: fc });
            _map.addLayer({
                id: POINTS_SRC, type: 'circle', source: POINTS_SRC,
                paint: {
                    'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
                    'circle-color': ['match', ['get', 'kind'], 'quake', '#d7372f', '#f28c28'],
                },
            });
        }
    }

    /** Whether sources can be added now (the style may be mid-load or mid-swap). */
    function _styleReady() {
        return !!(_map && _map.style && _map.style._loaded !== false);
    }

    function _showCells(codes, kind) {
        if (!_styleReady()) return;
        const data = _cellsGeoJSON(codes);
        _shown = data.features.length;
        const color = kind === 'heat' ? '#f05a28' : '#1f78d1';
        if (_map.getSource(CELLS_SRC)) {
            _map.getSource(CELLS_SRC).setData(data);
            _map.setPaintProperty(CELLS_SRC, 'fill-color', color);
            _map.setPaintProperty(`${CELLS_SRC}-line`, 'line-color', color);
        } else {
            _map.addSource(CELLS_SRC, { type: 'geojson', data });
            _map.addLayer({ id: CELLS_SRC, type: 'fill', source: CELLS_SRC, paint: { 'fill-color': color, 'fill-opacity': 0.35 } });
            _map.addLayer({ id: `${CELLS_SRC}-line`, type: 'line', source: CELLS_SRC, paint: { 'line-color': color, 'line-width': 1 } });
        }
    }

    /** Show a correlation on the map: its cells, or fly to its point. */
    function focus(c) {
        if (!_map || !c) return;
        if (c.cells && c.cells.length) {
            _showCells(c.cells, c.kind);
            // Frame the cells, clear of the panel on the right.
            const b = cellsBounds(c.cells);
            const right = _panel ? Math.min(420, _panel.getBoundingClientRect().width + 40) : 60;
            if (b) _map.fitBounds(b, { padding: { top: 90, bottom: 60, left: 80, right }, maxZoom: Math.max(_map.getZoom(), 12), duration: 900 });
            return;
        }
        if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
            _map.flyTo({ center: [c.lng, c.lat], zoom: Math.min(_map.getZoom(), c.kind === 'quake' || c.kind === 'event' ? 7 : 11), essential: true });
        }
    }

    function _syncButton(on) {
        const btn = document.getElementById('btn-livenow');
        if (!btn) return;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }

    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        refresh();
        clearInterval(_timer);
        _timer = setInterval(refresh, REFRESH_MS);
        _onMove = () => {
            clearTimeout(_moveTimer);
            _moveTimer = setTimeout(() => {
                if (!_active || !_last) return;
                const t = _target();
                if (t.code !== _last.target.code || distanceKm(t.lat, t.lng, _last.target.lat, _last.target.lng) > 8) refresh();
            }, 1500);
        };
        _map.on('moveend', _onMove);
        _map.on('style.load', _onStyle);
    }

    // A theme switch replaces the style: put the event points back.
    function _onStyle() { if (_active) _drawPoints(); }

    function detach() {
        _active = false;
        _reqId++;
        clearInterval(_timer); _timer = null;
        clearTimeout(_moveTimer);
        if (_map) {
            if (_onMove) _map.off('moveend', _onMove);
            _map.off('style.load', _onStyle);
            for (const id of [POINTS_SRC, `${CELLS_SRC}-line`, CELLS_SRC]) if (_map.getLayer(id)) _map.removeLayer(id);
            for (const id of [POINTS_SRC, CELLS_SRC]) if (_map.getSource(id)) _map.removeSource(id);
        }
        _shown = 0;
        if (_panel) { _panel.remove(); _panel = null; }
        const col = document.getElementById('aino-right');
        if (col) col.classList.remove('has-live-now');
        _setBadge(0);
    }

    function toggle() { if (_active) detach(); else attach(); }
    function isActive() { return _active; }
    function snapshot() { return _last; }
    function shownCells() { return _shown; }

    return {
        attach, detach, toggle, isActive, refresh, focus, snapshot, shownCells,
        forecastUrl, airUrl, floodUrl, eonetUrl, distanceKm, weatherLabel, parseWeather, subIndex, naqiBand, parseAir,
        parseFlood, parseQuakes, parseEvents, parseKp, gnssCondition, istDate, exposure, fmtPeople, correlate, cellsBounds, RAIN,
    };
})();

if (typeof window !== 'undefined') window.LiveNow = LiveNow;
