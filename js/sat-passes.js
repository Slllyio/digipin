/**
 * SatPasses — when the Earth-observation satellites next image the view, and
 * whether it will be cloudy then: Sentinel-2, Landsat 8/9, Sentinel-1 (radar,
 * sees through cloud), Resourcesat-2/2A, Sentinel-3, Sentinel-5P and
 * Cartosat-3, plus the ISS. Live positions and ground tracks on the map; a
 * card listing the next pass of each with its swath on click.
 *
 * Idea from the Offentligdata dashboard's "Satellites" layer, turned towards
 * what a city team needs: when fresh imagery of their ward arrives.
 * Data: CelesTrak GP elements (OMM JSON, CORS-open, keyless) and the
 * Open-Meteo hourly cloud forecast. Orbits use a compact propagator (two-body
 * Kepler + J2 secular drift + the element set's mean-motion decay), within
 * ~15 km of SGP4 over a week (a couple of seconds along track): plenty for
 * "which pass, when".
 *
 * Everything above the "map / DOM" line is pure and unit-tested.
 */
const SatPasses = (() => {
    const MU = 398600.4418;     // km^3/s^2
    const RE = 6378.137;        // km
    const J2 = 1.08262668e-3;
    const F = 1 / 298.257223563;
    const DAY_MS = 86400000;
    const TWO_PI = Math.PI * 2;
    const D2R = Math.PI / 180;

    const GP_URLS = [
        'https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=json',
        'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
    ];

    /**
     * The satellites shown. Swath is the instrument's full width; `kind` sets
     * the rules (optical needs daylight and is spoilt by cloud, radar is not).
     */
    const CATALOG = [
        { re: /^SENTINEL-2[A-C]$/, kind: 'optical', res: '10 m', swathKm: 290, use: 'Colour + vegetation (NDVI), every 5 days with the pair' },
        { re: /^LANDSAT [89]$/, kind: 'optical', res: '30 m + thermal', swathKm: 185, use: 'Surface heat (thermal band) and land change' },
        { re: /^SENTINEL-1[A-D]$/, kind: 'sar', res: '10 m radar', swathKm: 250, use: 'Flood water and ground movement, day or night, through cloud' },
        { re: /^RESOURCESAT-2A?$/, kind: 'optical', res: '24 m (LISS-III)', swathKm: 141, use: 'ISRO land use and crops' },
        { re: /^CARTOSAT-3$/, kind: 'optical', res: '0.25 m', swathKm: 16, use: 'Very high resolution, tasked by ISRO (passes are chances, not certain shots)', tasked: true },
        { re: /^SENTINEL-3[AB]$/, kind: 'optical', res: '300 m', swathKm: 1270, use: 'Land and water surface temperature, daily' },
        { re: /^SENTINEL-5P$/, kind: 'air', res: '5.5 km', swathKm: 2600, use: 'NO₂, ozone and aerosol columns, daily', daylight: true },
        { re: /^ISS \(ZARYA\)$/, kind: 'station', res: '', swathKm: 0, use: 'International Space Station', label: 'ISS' },
    ];

    // ---------- pure: orbits ----------

    /** CelesTrak OMM JSON record → mean elements, or null if unusable. */
    function elements(gp) {
        if (!gp || !gp.EPOCH || !Number.isFinite(gp.MEAN_MOTION)) return null;
        const epochMs = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(gp.EPOCH) ? gp.EPOCH : `${gp.EPOCH}Z`);
        if (!Number.isFinite(epochMs)) return null;
        const n = gp.MEAN_MOTION * TWO_PI / 86400;            // rad/s (Kozai mean)
        const e = gp.ECCENTRICITY || 0;
        const i = (gp.INCLINATION || 0) * D2R;
        // Un-Kozai the mean motion (as SGP4 does) so the semi-major axis and drift rates are right.
        const k2 = 0.5 * J2 * RE * RE;
        const a1 = Math.cbrt(MU / (n * n));
        const cosi = Math.cos(i), b0 = Math.sqrt(1 - e * e);
        const d1 = 1.5 * k2 * (3 * cosi * cosi - 1) / (b0 * b0 * b0);
        const del1 = d1 / (a1 * a1);
        const a0 = a1 * (1 - del1 / 3 - del1 * del1 - 134 / 81 * del1 * del1 * del1);
        const del0 = d1 / (a0 * a0);
        const np = n / (1 + del0);
        const a = a0 / (1 - del0);
        const p = a * (1 - e * e);
        const fac = 1.5 * J2 * (RE / p) * (RE / p) * np;
        return {
            name: gp.OBJECT_NAME, id: gp.NORAD_CAT_ID, epochMs,
            n: np, a, e, i,
            raan: (gp.RA_OF_ASC_NODE || 0) * D2R, argp: (gp.ARG_OF_PERICENTER || 0) * D2R, M0: (gp.MEAN_ANOMALY || 0) * D2R,
            raanDot: -fac * cosi,
            argpDot: 0.5 * fac * (5 * cosi * cosi - 1),
            mDot: np + 0.5 * fac * b0 * (3 * cosi * cosi - 1),
            ndot2: gp.MEAN_MOTION_DOT || 0,                   // rev/day^2 (already halved, TLE convention)
        };
    }

    /** Greenwich mean sidereal angle (rad) at a UTC time (IAU 1982). */
    function gmst(tMs) {
        const tut = (tMs / DAY_MS + 2440587.5 - 2451545.0) / 36525;
        let g = 67310.54841 + (876600 * 3600 + 8640184.812866) * tut + 0.093104 * tut * tut - 6.2e-6 * tut * tut * tut;
        g = ((g % 86400) / 240) * D2R;
        return ((g % TWO_PI) + TWO_PI) % TWO_PI;
    }

    /** Position at a UTC time: {lat, lng, altKm} (geodetic, WGS84). */
    function propagate(el, tMs) {
        const dt = (tMs - el.epochMs) / 1000;                 // s
        const dd = dt / 86400;                                // days
        const M = el.M0 + el.mDot * dt + TWO_PI * el.ndot2 * dd * dd;
        const raan = el.raan + el.raanDot * dt;
        const argp = el.argp + el.argpDot * dt;
        let E = M;
        for (let k = 0; k < 8; k++) E -= (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
        const nuX = Math.cos(E) - el.e, nuY = Math.sqrt(1 - el.e * el.e) * Math.sin(E);
        const r = el.a * (1 - el.e * Math.cos(E));
        const u = argp + Math.atan2(nuY, nuX);
        const cu = Math.cos(u), su = Math.sin(u), cO = Math.cos(raan), sO = Math.sin(raan), ci = Math.cos(el.i), si = Math.sin(el.i);
        const x = r * (cO * cu - sO * su * ci), y = r * (sO * cu + cO * su * ci), z = r * su * si;
        // ECI → Earth-fixed, then geodetic (Bowring, one step is ample at LEO).
        const g = gmst(tMs), cg = Math.cos(g), sg = Math.sin(g);
        const xe = x * cg + y * sg, ye = -x * sg + y * cg;
        const lng = Math.atan2(ye, xe);
        const pr = Math.hypot(xe, ye), e2 = F * (2 - F);
        let lat = Math.atan2(z, pr * (1 - e2));
        for (let k = 0; k < 3; k++) {
            const N = RE / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
            lat = Math.atan2(z + e2 * N * Math.sin(lat), pr);
        }
        const N = RE / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
        return { lat: lat / D2R, lng: ((lng / D2R + 540) % 360) - 180, altKm: pr / Math.cos(lat) - N };
    }

    function distanceKm(a, b) {
        const dLat = (b.lat - a.lat) * D2R, dLng = (b.lng - a.lng) * D2R;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /** Sun elevation (degrees) at a place and UTC time (NOAA low-precision formulas). */
    function sunElevation(lat, lng, tMs) {
        const d = tMs / DAY_MS + 2440587.5 - 2451545.0;
        const g = (357.529 + 0.98560028 * d) * D2R;
        const q = 280.459 + 0.98564736 * d;
        const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
        const eps = (23.439 - 0.00000036 * d) * D2R;
        const ra = Math.atan2(Math.cos(eps) * Math.sin(L), Math.cos(L));
        const dec = Math.asin(Math.sin(eps) * Math.sin(L));
        const ha = gmst(tMs) + lng * D2R - ra;
        const s = Math.sin(lat * D2R) * Math.sin(dec) + Math.cos(lat * D2R) * Math.cos(dec) * Math.cos(ha);
        return Math.asin(s) / D2R;
    }

    /**
     * Overpasses of a point: moments of closest approach of the ground track
     * with the point within `maxKm`. While the satellite is far away the scan
     * jumps ahead (a ground track closes on a point at under 8 km/s, so it
     * cannot skip a pass); near the point it steps 20 s, then a ternary search
     * refines the minimum. → [{t, offsetKm, ascending}]
     */
    function closeApproaches(el, lat, lng, fromMs, toMs, maxKm) {
        const pt = { lat, lng }, step = 20000, near = maxKm + 400, out = [];
        const d = (t) => distanceKm(propagate(el, t), pt);
        let t0 = null, d0 = Infinity, t1 = null, d1 = Infinity;
        for (let t2 = fromMs; t2 <= toMs;) {
            const d2 = d(t2);
            if (t1 != null && d1 <= d0 && d1 < d2) out.push(...refine(t0 ?? t1 - step, t2, d, maxKm, el));
            if (d2 > near) {
                t0 = t1 = null; d0 = d1 = Infinity;
                t2 += Math.max(step, ((d2 - near) / 8) * 1000);
                continue;
            }
            t0 = t1; d0 = d1; t1 = t2; d1 = d2;
            t2 += step;
        }
        return out;
    }

    function refine(lo, hi, d, maxKm, el) {
        for (let k = 0; k < 30 && hi - lo > 200; k++) {
            const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
            if (d(m1) < d(m2)) hi = m2; else lo = m1;
        }
        const t = Math.round((lo + hi) / 2), off = d(t);
        return off <= maxKm ? [{ t, offsetKm: off, ascending: propagate(el, t + 30000).lat > propagate(el, t).lat }] : [];
    }

    /** Catalogue entry for a satellite name, or null. */
    function metaFor(name) {
        return CATALOG.find(c => c.re.test(name)) || null;
    }

    /** Usable passes for one satellite over a view of radius `viewKm`: optical needs sun ≥ 10°. */
    function passesFor(el, meta, lat, lng, fromMs, days, viewKm = 15) {
        if (!meta || !meta.swathKm) return [];
        const half = meta.swathKm / 2;
        return closeApproaches(el, lat, lng, fromMs, fromMs + days * DAY_MS, half + viewKm)
            .filter(p => p.t >= fromMs)
            .map(p => ({ ...p, sunEl: sunElevation(lat, lng, p.t), covers: p.offsetKm + viewKm <= half ? 'all' : 'part' }))
            .filter(p => (meta.kind === 'optical' || meta.daylight) ? p.sunEl >= 10 : true);
    }

    /** Hourly cloud cover (%) at a time from an Open-Meteo hourly response, or null. */
    function cloudAt(hourly, tMs) {
        if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.cloud_cover)) return null;
        let best = null, bestDt = 5400000;
        hourly.time.forEach((s, k) => {
            const dt = Math.abs(Date.parse(/Z$/.test(s) ? s : `${s}Z`) - tMs);
            if (dt < bestDt && Number.isFinite(hourly.cloud_cover[k])) { bestDt = dt; best = hourly.cloud_cover[k]; }
        });
        return best;
    }

    /** One-line outlook for a pass. */
    function outlook(meta, cloud) {
        if (!meta) return '';
        if (meta.kind === 'sar') return 'Radar: cloud does not matter';
        if (meta.kind === 'station') return '';
        if (cloud == null) return 'No cloud forecast this far ahead';
        if (cloud >= 70) return `Likely cloudy (${Math.round(cloud)}% cloud forecast)`;
        if (cloud <= 30) return `Likely clear (${Math.round(cloud)}% cloud forecast)`;
        return `Partly cloudy (${Math.round(cloud)}% cloud forecast)`;
    }

    /** Ground track [lng, lat] lines from t0 to t1, split where it wraps the antimeridian. */
    function groundTrack(el, t0, t1, stepMs = 30000) {
        const lines = [[]];
        let prev = null;
        for (let t = t0; t <= t1; t += stepMs) {
            const p = propagate(el, t);
            if (prev && Math.abs(p.lng - prev.lng) > 180) lines.push([]);
            lines[lines.length - 1].push([p.lng, p.lat]);
            prev = p;
        }
        return lines.filter(l => l.length > 1);
    }

    /** Swath footprint (polygon ring) for ±`halfMin` minutes around a pass. */
    function swathPolygon(el, t, halfKm, halfMin = 2) {
        const left = [], right = [];
        for (let s = -halfMin * 60000; s <= halfMin * 60000; s += 15000) {
            const a = propagate(el, t + s), b = propagate(el, t + s + 5000);
            const brg = Math.atan2((b.lng - a.lng) * Math.cos(a.lat * D2R), b.lat - a.lat);
            const off = (ang) => {
                const dLat = (halfKm / 111.32) * Math.cos(ang), dLng = (halfKm / (111.32 * Math.cos(a.lat * D2R))) * Math.sin(ang);
                return [a.lng + dLng, a.lat + dLat];
            };
            left.push(off(brg - Math.PI / 2));
            right.push(off(brg + Math.PI / 2));
        }
        const ring = left.concat(right.reverse());
        ring.push(ring[0]);
        return ring;
    }

    /** "Fri 24 Oct, 10:51 IST" */
    function fmtIst(tMs) {
        const d = new Date(tMs + 330 * 60000);
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
        const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
        return `${day} ${d.getUTCDate()} ${mon}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`;
    }

    /** "in 3 h", "in 2 days" */
    function fmtIn(ms) {
        const h = ms / 3600000;
        if (h < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
        if (h < 36) return `in ${Math.round(h)} h`;
        return `in ${Math.round(h / 24)} days`;
    }

    /**
     * Satellites from GP records → [{el, meta, label}], one per catalogue match,
     * skipping element sets older than 30 days (decayed or stale).
     */
    function fleet(records, nowMs) {
        const out = [], seen = new Set();
        for (const gp of records || []) {
            const meta = metaFor(gp.OBJECT_NAME || '');
            const el = meta && elements(gp);
            if (!el || seen.has(el.id) || Math.abs(nowMs - el.epochMs) > 30 * DAY_MS) continue;
            seen.add(el.id);
            out.push({ el, meta, label: meta.label || el.name.replace(/^SENTINEL/, 'Sentinel').replace(/^LANDSAT/, 'Landsat').replace(/^RESOURCESAT/, 'Resourcesat').replace(/^CARTOSAT/, 'Cartosat') });
        }
        return out;
    }

    /** Next pass per imaging satellite over (lat, lng), soonest first. */
    function schedule(sats, lat, lng, nowMs, days = 7, hourly = null) {
        const rows = [];
        for (const s of sats) {
            if (!s.meta.swathKm) continue;
            const p = passesFor(s.el, s.meta, lat, lng, nowMs, days)[0];
            if (!p) continue;
            const cloud = (s.meta.kind === 'optical' || s.meta.kind === 'air') ? cloudAt(hourly, p.t) : null;
            rows.push({ id: s.el.id, label: s.label, meta: s.meta, ...p, cloud, outlook: outlook(s.meta, cloud) });
        }
        return rows.sort((a, b) => a.t - b.t);
    }

    /** Plain-text list of schedule rows (for DISHA observations). */
    function toText(rows, nowMs = Date.now()) {
        if (!rows || !rows.length) return 'No imaging pass in the next 7 days.';
        return rows.map(r => `- ${r.label} (${r.meta.res}, ${r.meta.swathKm} km swath): ${fmtIst(r.t)}, ${fmtIn(r.t - nowMs)}; `
            + `${Math.round(r.offsetKm)} km off the ground track, ${r.covers === 'all' ? 'whole view covered' : 'at the swath edge'}`
            + `${r.outlook ? `; ${r.outlook}` : ''}${r.meta.tasked ? '; tasked satellite, a chance not a certainty' : ''}`).join('\n');
    }

    // ---------- map / DOM ----------

    const SRC_POS = 'sat-passes-pos', SRC_TRACK = 'sat-passes-track', SRC_SWATH = 'sat-passes-swath';
    const L_SWATH = 'sat-passes-swath-fill', L_SWATH_LINE = 'sat-passes-swath-line', L_TRACK = 'sat-passes-tracks', L_POS = 'sat-passes-dots', L_LABEL = 'sat-passes-labels';
    const ATTRIBUTION = 'Orbits: CelesTrak · Clouds: Open-Meteo';
    const COLORS = { optical: '#1f78d1', sar: '#8a3ffc', air: '#e08a1e', station: '#d7372f' };

    let _map = null, _active = false, _sats = [], _rows = [], _hourly = null, _selected = null;
    let _panel = null, _timer = null, _centre = null, _reqId = 0, _last = null;
    const _cache = new Map();   // url -> {t, data}

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind);
    }

    async function _json(url, ttlMs) {
        const hit = _cache.get(url);
        if (hit && Date.now() - hit.t < ttlMs) return hit.data;
        let lastErr;
        for (let k = 0; k < 2; k++) {
            try {
                const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json();
                _cache.set(url, { t: Date.now(), data });
                return data;
            } catch (e) { lastErr = e; }
        }
        throw lastErr;
    }

    function _cloudUrl(lat, lng) {
        return `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&hourly=cloud_cover&forecast_days=7&timezone=GMT`;
    }

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function _font() {
        const l = (_map.getStyle().layers || []).find(x => x.layout && x.layout['text-font']);
        return l ? l.layout['text-font'] : ['Noto Sans Regular'];
    }

    function _ensureLayers() {
        const empty = { type: 'FeatureCollection', features: [] };
        if (!_map.getSource(SRC_SWATH)) _map.addSource(SRC_SWATH, { type: 'geojson', data: empty, attribution: ATTRIBUTION });
        if (!_map.getSource(SRC_TRACK)) _map.addSource(SRC_TRACK, { type: 'geojson', data: empty });
        if (!_map.getSource(SRC_POS)) _map.addSource(SRC_POS, { type: 'geojson', data: empty });
        if (!_map.getLayer(L_SWATH)) _map.addLayer({ id: L_SWATH, type: 'fill', source: SRC_SWATH, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 } });
        if (!_map.getLayer(L_SWATH_LINE)) _map.addLayer({ id: L_SWATH_LINE, type: 'line', source: SRC_SWATH, paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [3, 2] } });
        if (!_map.getLayer(L_TRACK)) _map.addLayer({ id: L_TRACK, type: 'line', source: SRC_TRACK, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'sel'], 2.5, 1.2], 'line-opacity': ['case', ['get', 'sel'], 0.95, 0.5] } });
        if (!_map.getLayer(L_POS)) _map.addLayer({ id: L_POS, type: 'circle', source: SRC_POS, paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
        if (!_map.getLayer(L_LABEL)) {
            _map.addLayer({
                id: L_LABEL, type: 'symbol', source: SRC_POS,
                layout: { 'text-field': ['get', 'label'], 'text-font': _font(), 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-allow-overlap': true },
                paint: { 'text-color': '#1b1b1b', 'text-halo-color': '#fff', 'text-halo-width': 1.3 },
            });
        }
    }

    /** Positions now + tracks (10 min behind, 20 ahead) + the selected pass's swath. */
    function _frame(nowMs) {
        const pos = [], tracks = [];
        for (const s of _sats) {
            const p = propagate(s.el, nowMs);
            const color = COLORS[s.meta.kind];
            pos.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { id: s.el.id, label: s.label, color } });
            for (const line of groundTrack(s.el, nowMs - 600000, nowMs + 1200000, 30000)) {
                tracks.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { color, sel: false } });
            }
        }
        const swath = [];
        const row = _selected && _rows.find(r => r.id === _selected);
        const sat = row && _sats.find(s => s.el.id === row.id);
        if (row && sat) {
            const color = COLORS[sat.meta.kind];
            swath.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [swathPolygon(sat.el, row.t, sat.meta.swathKm / 2)] }, properties: { color } });
            for (const line of groundTrack(sat.el, row.t - 240000, row.t + 240000, 15000)) {
                tracks.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { color, sel: true } });
            }
        }
        return { pos, tracks, swath };
    }

    function _draw() {
        if (!_map || !_active) return;
        try { _ensureLayers(); } catch { return; }   // style still loading: style.load redraws
        const f = _frame(Date.now());
        _last = { pos: f.pos.length, tracks: f.tracks.length, swath: f.swath.length };
        _map.getSource(SRC_POS).setData({ type: 'FeatureCollection', features: f.pos });
        _map.getSource(SRC_TRACK).setData({ type: 'FeatureCollection', features: f.tracks });
        _map.getSource(SRC_SWATH).setData({ type: 'FeatureCollection', features: f.swath });
    }

    function _render() {
        if (!_panel) {
            _panel = _el('section', 'live-now-panel sat-panel');
            _panel.id = 'sat-passes-panel';
            _panel.setAttribute('aria-label', 'Satellite passes over this view');
            const col = document.getElementById('aino-right');
            if (col && getComputedStyle(col).display !== 'none') {
                _panel.classList.add('is-docked');
                col.classList.add('has-sat-passes');
                col.appendChild(_panel);
            } else {
                document.body.appendChild(_panel);
            }
        }
        _panel.replaceChildren();
        const head = _el('header', 'ln-head');
        const title = _el('div', 'ln-title');
        title.append(_el('span', 'ln-kicker sat-kicker', 'NEXT IMAGERY'), _el('strong', 'ln-place', 'Satellite passes over this view'));
        const close = _el('button', 'ln-btn', '×');
        close.type = 'button'; close.title = 'Close'; close.setAttribute('aria-label', 'Close satellite passes');
        close.addEventListener('click', () => { detach(); const b = document.getElementById('btn-satpasses'); if (b) b.classList.remove('active'); });
        head.append(title, close);
        _panel.appendChild(head);
        if (!_rows.length) {
            _panel.appendChild(_el('div', 'ln-loading', _sats.length ? 'No imaging pass in the next 7 days.' : 'Loading orbits…'));
            return;
        }
        const list = _el('ul', 'ln-corr sat-list');
        const now = Date.now();
        for (const r of _rows) {
            const li = _el('li', `sat-${r.meta.kind}${r.id === _selected ? ' is-selected' : ''}`);
            const b = _el('button', 'ln-c-btn');
            b.type = 'button';
            b.dataset.satId = r.id;
            const txt = _el('span', 'ln-c-txt');
            txt.append(
                _el('strong', null, `${r.label} · ${fmtIn(r.t - now)}`),
                _el('span', null, `${fmtIst(r.t)} · ${r.meta.res}${r.covers === 'all' ? ', whole view' : ', edge of the swath'}`),
                _el('span', 'ln-dim', [r.outlook, r.meta.use].filter(Boolean).join(' · ')),
            );
            b.append(_el('span', 'ln-c-icon', r.meta.kind === 'sar' ? '\u{1F4E1}' : r.meta.kind === 'air' ? '\u{1F32B}' : '\u{1F6F0}'), txt);
            b.addEventListener('click', () => select(r.id));
            li.appendChild(b);
            list.appendChild(li);
        }
        _panel.appendChild(list);
        const foot = _el('div', 'ln-dim sat-foot', `Orbits from CelesTrak, accurate to a few km. Clouds: Open-Meteo hourly forecast. Sentinel-1 and Cartosat follow acquisition plans, so a pass is a chance, not a promise.`);
        _panel.appendChild(foot);
    }

    /** Show one pass: swath on the map, framed. */
    function select(id) {
        const row = _rows.find(r => r.id === id);
        if (!row || !_map) return false;
        _selected = id;
        _draw();
        _render();
        const sat = _sats.find(s => s.el.id === id);
        if (sat) {
            const ring = swathPolygon(sat.el, row.t, sat.meta.swathKm / 2, 1);
            const lngs = ring.map(c => c[0]).concat(_centre.lng), lats = ring.map(c => c[1]).concat(_centre.lat);
            const right = _panel && _panel.classList.contains('is-docked') ? 60 : 380;
            try {
                _map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: { top: 90, bottom: 60, left: 60, right }, maxZoom: 10, duration: 900 });
            } catch { /* ignore */ }
        }
        return true;
    }

    async function _loadFleet() {
        if (_sats.length) return _sats;
        const lists = await Promise.all(GP_URLS.map(u => _json(u, 6 * 3600000)));
        _sats = fleet(lists.flat(), Date.now());
        return _sats;
    }

    /**
     * Next pass over a point by the satellites whose name matches `re`, with
     * its cloud outlook, for other cards (e.g. Sentinel-2 imagery). Null when
     * there is none in 7 days; throws if the orbits cannot be fetched.
     */
    async function nextPass(lat, lng, re = /^Sentinel-2/) {
        return (await passes(lat, lng, re))[0] || null;
    }

    /** Next pass of each satellite (optionally those whose label matches `re`) over a point, soonest first. */
    async function passes(lat, lng, re = null) {
        const sats = (await _loadFleet()).filter(s => !re || re.test(s.label));
        const hourly = await _json(_cloudUrl(lat, lng), 3600000).then(j => j.hourly).catch(() => null);
        return schedule(sats, lat, lng, Date.now(), 7, hourly);
    }

    async function refresh() {
        if (!_active || !_map) return;
        const id = ++_reqId;
        const c = _map.getCenter();
        _centre = { lat: c.lat, lng: c.lng };
        _render();
        try {
            await _loadFleet();
            if (id !== _reqId || !_active) return;
            _hourly = await _json(_cloudUrl(_centre.lat, _centre.lng), 3600000).then(j => j.hourly).catch(() => null);
            if (id !== _reqId || !_active) return;
            _rows = schedule(_sats, _centre.lat, _centre.lng, Date.now(), 7, _hourly);
            if (_selected && !_rows.some(r => r.id === _selected)) _selected = null;
            _render();
            _draw();
        } catch (e) {
            if (id !== _reqId || !_active) return;
            console.warn('SatPasses:', e);
            _toast('Satellite passes unavailable', 'CelesTrak did not answer; try again in a moment.', 'warning');
        }
    }

    function _onMoveEnd() {
        if (!_centre) return;
        const c = _map.getCenter();
        if (distanceKm(_centre, { lat: c.lat, lng: c.lng }) > 25) refresh();
    }
    function _onStyle() { if (_active) _draw(); }

    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        _map.on('moveend', _onMoveEnd);
        _map.on('style.load', _onStyle);
        _timer = setInterval(_draw, 2000);
        refresh();
    }

    function detach() {
        _active = false;
        _reqId++;
        if (_timer) { clearInterval(_timer); _timer = null; }
        if (_map) {
            _map.off('moveend', _onMoveEnd);
            _map.off('style.load', _onStyle);
            for (const id of [L_LABEL, L_POS, L_TRACK, L_SWATH_LINE, L_SWATH]) if (_map.getLayer(id)) _map.removeLayer(id);
            for (const id of [SRC_POS, SRC_TRACK, SRC_SWATH]) if (_map.getSource(id)) _map.removeSource(id);
        }
        if (_panel) { _panel.remove(); _panel = null; }
        const col = document.getElementById('aino-right');
        if (col) col.classList.remove('has-sat-passes');
        _rows = []; _selected = null; _centre = null; _last = null;
    }

    function toggle() { if (_active) detach(); else attach(); }
    function isActive() { return _active; }
    function rows() { return _rows.slice(); }
    /** Feature counts of the last drawn frame (for tests). */
    function lastFrame() { return _last; }
    function satellites() { return _sats.map(s => ({ id: s.el.id, label: s.label, kind: s.meta.kind })); }

    return {
        attach, detach, toggle, isActive, refresh, select, rows, satellites, lastFrame, nextPass, passes, toText,
        CATALOG, elements, gmst, propagate, distanceKm, sunElevation, closeApproaches, metaFor, passesFor,
        cloudAt, outlook, groundTrack, swathPolygon, fmtIst, fmtIn, fleet, schedule,
    };
})();

if (typeof window !== 'undefined') window.SatPasses = SatPasses;
