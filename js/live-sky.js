/**
 * LiveSky — live aircraft over the city, drawn in 3D at their reported
 * altitude: a plane silhouette pointing along its track, a faint stem to the
 * ground and a ground shadow with the callsign. Positions are dead-reckoned
 * between 10-second polls so the traffic moves smoothly.
 *
 * Idea from the Offentligdata OSINT dashboard (its AVIATION layer). Data:
 * adsb.lol community ADS-B feed (ODbL, keyless). adsb.lol sends no CORS
 * headers, so in the browser it goes through the DigiPin data proxy
 * (window.DIGIPIN_CONFIG.proxyBase, see proxy/README.md); a direct request is
 * tried first in case the deployment can reach it. Override the feed with
 * window.DIGIPIN_CONFIG.adsbUrl (same /v2/point response shape).
 *
 * Rendered with plain MapLibre fill-extrusions (base = altitude), so no deck.gl.
 * Everything above the "map / DOM" line is pure and unit-tested.
 */
const LiveSky = (() => {
    const FEED = 'https://api.adsb.lol/v2/point';
    const RADIUS_NM = 40;          // ~75 km around the view centre
    const POLL_MS = 10000;
    const FRAME_MS = 250;
    const STALE_S = 60;
    const FT = 0.3048, KT = 1.852;
    const SRC = 'live-sky-src', SHADOW_SRC = 'live-sky-shadow-src';
    const L_STEM = 'live-sky-stems', L_PLANE = 'live-sky-planes', L_SHADOW = 'live-sky-shadows', L_LABEL = 'live-sky-labels';
    const ATTRIBUTION = 'Aircraft: adsb.lol community ADS-B (ODbL)';

    // ---------- pure ----------

    function feedUrl(lat, lng, radiusNm = RADIUS_NM, base = FEED) {
        return `${base}/${lat.toFixed(4)}/${lng.toFixed(4)}/${Math.round(radiusNm)}`;
    }

    function proxied(url, proxyBase) {
        return proxyBase ? `${proxyBase.replace(/\/$/, '')}/?url=${encodeURIComponent(url)}` : url;
    }

    /** adsb.lol / readsb aircraft → flat records with metric units. */
    function parseAircraft(json) {
        const list = (json && (json.ac || json.aircraft)) || [];
        const now = json && (json.now > 1e12 ? json.now / 1000 : json.now);
        return list.filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon) && (a.seen_pos ?? a.seen ?? 0) < STALE_S)
            .map(a => {
                const ground = a.alt_baro === 'ground';
                const altFt = ground ? 0 : (Number.isFinite(a.alt_geom) ? a.alt_geom : Number.isFinite(a.alt_baro) ? a.alt_baro : 0);
                return {
                    hex: a.hex,
                    flight: (a.flight || '').trim() || (a.r || a.hex || '').toUpperCase(),
                    reg: a.r || '', type: a.t || '', desc: a.desc || '',
                    lat: a.lat, lng: a.lon,
                    altM: Math.max(0, altFt * FT), altFt: Math.round(altFt), onGround: ground,
                    speedKmh: Number.isFinite(a.gs) ? a.gs * KT : 0,
                    track: Number.isFinite(a.track) ? a.track : Number.isFinite(a.true_heading) ? a.true_heading : 0,
                    vrateFpm: Number.isFinite(a.baro_rate) ? a.baro_rate : (Number.isFinite(a.geom_rate) ? a.geom_rate : 0),
                    squawk: a.squawk || '', emergency: a.emergency && a.emergency !== 'none' ? a.emergency : '',
                    military: !!(a.dbFlags & 1),
                    t0: (now || Date.now() / 1000) - (a.seen_pos ?? a.seen ?? 0),
                };
            });
    }

    /** Move a point `m` metres along bearing `deg`. Flat-earth, fine under ~50 km. */
    function offset(lat, lng, deg, m) {
        const r = deg * Math.PI / 180;
        const dLat = (m * Math.cos(r)) / 111320;
        const dLng = (m * Math.sin(r)) / (111320 * Math.cos(lat * Math.PI / 180));
        return [lng + dLng, lat + dLat];
    }

    /** Dead-reckoned position `nowS` seconds (epoch) along its track. */
    function predict(a, nowS) {
        const dt = Math.max(0, Math.min(STALE_S, nowS - a.t0));
        if (a.onGround || !a.speedKmh) return { lat: a.lat, lng: a.lng, altM: a.altM };
        const [lng, lat] = offset(a.lat, a.lng, a.track, (a.speedKmh / 3.6) * dt);
        const altM = Math.max(0, a.altM + (a.vrateFpm * FT / 60) * dt);
        return { lat, lng, altM };
    }

    /** Plane silhouette (nose, wings, tail) of length `len` metres, closed ring. */
    function planeRing(lat, lng, track, len) {
        const pts = [
            [0, 0.5], [0.07, 0.22], [0.5, -0.02], [0.5, -0.1], [0.07, -0.02],
            [0.05, -0.36], [0.2, -0.47], [0.2, -0.52], [0, -0.46],
        ];
        const local = [...pts, ...pts.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
        const ring = local.map(([x, y]) => {
            const along = offset(lat, lng, track, y * len);
            return offset(along[1], along[0], track + 90, x * len);
        });
        ring.push(ring[0]);
        return ring;
    }

    function squareRing(lat, lng, half) {
        const n = offset(lat, lng, 0, half)[1], s = offset(lat, lng, 180, half)[1];
        const e = offset(lat, lng, 90, half)[0], w = offset(lat, lng, 270, half)[0];
        return [[w, s], [e, s], [e, n], [w, n], [w, s]];
    }

    /** Plane length (m) that stays readable at a zoom: ~22 px on screen, 60 m minimum. */
    function planeLength(zoom, lat = 22) {
        const mPerPx = 156543.03 * Math.cos(lat * Math.PI / 180) / 2 ** zoom;
        return Math.max(60, Math.min(4000, 22 * mPerPx));
    }

    /** Altitude colour band: ground/approach orange → cruise cyan. */
    function altColor(altM) {
        if (altM < 50) return '#9aa4ad';
        if (altM < 1500) return '#f28c28';
        if (altM < 4500) return '#e6c229';
        if (altM < 8000) return '#5cc8a0';
        return '#3fb6e8';
    }

    /** Features for one frame. `scale` compresses altitude (1 = true height). */
    function frameFeatures(aircraft, nowS, zoom, scale = 1) {
        const planes = [], shadows = [];
        for (const a of aircraft) {
            const p = predict(a, nowS);
            const len = planeLength(zoom, p.lat);
            const z = p.altM * scale;
            const props = {
                hex: a.hex, flight: a.flight, alt: a.onGround ? 'ground' : `${a.altFt.toLocaleString('en-IN')} ft`,
                color: a.emergency ? '#d7372f' : altColor(p.altM), base: z, top: z + len * 0.12,
            };
            planes.push({ type: 'Feature', properties: { ...props, part: 'plane' }, geometry: { type: 'Polygon', coordinates: [planeRing(p.lat, p.lng, a.track, len)] } });
            if (z > 30) {
                planes.push({ type: 'Feature', properties: { ...props, part: 'stem', base: 0, top: z }, geometry: { type: 'Polygon', coordinates: [squareRing(p.lat, p.lng, len * 0.025)] } });
            }
            shadows.push({ type: 'Feature', properties: { ...props, label: `${a.flight}\n${props.alt}` }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
        }
        return {
            planes: { type: 'FeatureCollection', features: planes },
            shadows: { type: 'FeatureCollection', features: shadows },
        };
    }

    function summary(aircraft) {
        const air = aircraft.filter(a => !a.onGround);
        const low = air.filter(a => a.altM < 1500).length;
        return { total: aircraft.length, airborne: air.length, low, ground: aircraft.length - air.length };
    }

    // ---------- map / DOM ----------

    let _map = null;
    let _active = false;
    let _aircraft = [];
    let _poll = null, _frame = null, _reqId = 0;
    let _scale = 1;
    let _status = null;
    let _popup = null;
    let _fails = 0;
    let _lastAt = null;
    let _lastFrame = null;

    function _cfg() { return (typeof window !== 'undefined' && window.DIGIPIN_CONFIG) || {}; }

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind);
    }

    async function _fetch(lat, lng) {
        const url = feedUrl(lat, lng, RADIUS_NM, _cfg().adsbUrl || FEED);
        const tries = [url];
        if (_cfg().proxyBase) tries.unshift(proxied(url, _cfg().proxyBase));
        let err = null;
        for (const u of tries) {
            try {
                const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return await r.json();
            } catch (e) { err = e; }
        }
        throw err || new Error('unreachable');
    }

    async function poll() {
        if (!_active || !_map) return;
        const id = ++_reqId;
        const c = _map.getCenter();
        try {
            const json = await _fetch(c.lat, c.lng);
            if (id !== _reqId || !_active) return;
            _aircraft = parseAircraft(json);
            _fails = 0;
            _lastAt = new Date();
            _renderStatus();
        } catch (e) {
            if (id !== _reqId || !_active) return;
            _fails++;
            if (_fails === 1) {
                console.warn('LiveSky:', e);
                _toast('Live aircraft unavailable',
                    _cfg().proxyBase ? 'The ADS-B feed did not answer; retrying.'
                        : 'The ADS-B feed blocks direct browser requests. Set up the DigiPin data proxy (proxy/README.md) to turn this on.',
                    'warning');
            }
            _renderStatus(e);
        }
    }

    function _draw() {
        if (!_map || !_active) return;
        // (Re)add the layers here: the style may still be loading when the
        // layer is switched on, and a theme switch replaces the style.
        try { _addLayers(); } catch { return; }
        const f = frameFeatures(_aircraft, Date.now() / 1000, _map.getZoom(), _scale);
        _lastFrame = f;
        const s = _map.getSource(SRC), sh = _map.getSource(SHADOW_SRC);
        if (s) s.setData(f.planes);
        if (sh) sh.setData(f.shadows);
    }

    function _addLayers() {
        const empty = { type: 'FeatureCollection', features: [] };
        if (!_map.getSource(SRC)) _map.addSource(SRC, { type: 'geojson', data: empty, attribution: ATTRIBUTION });
        if (!_map.getSource(SHADOW_SRC)) _map.addSource(SHADOW_SRC, { type: 'geojson', data: empty });
        if (!_map.getLayer(L_SHADOW)) {
            _map.addLayer({
                id: L_SHADOW, type: 'circle', source: SHADOW_SRC,
                paint: { 'circle-radius': 3, 'circle-color': '#000', 'circle-opacity': 0.25, 'circle-pitch-alignment': 'map' },
            });
        }
        if (!_map.getLayer(L_STEM)) {
            _map.addLayer({
                id: L_STEM, type: 'fill-extrusion', source: SRC, filter: ['==', ['get', 'part'], 'stem'],
                paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': 0.35 },
            });
        }
        if (!_map.getLayer(L_PLANE)) {
            _map.addLayer({
                id: L_PLANE, type: 'fill-extrusion', source: SRC, filter: ['==', ['get', 'part'], 'plane'],
                paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': 0.95 },
            });
        }
        if (!_map.getLayer(L_LABEL)) {
            _map.addLayer({
                id: L_LABEL, type: 'symbol', source: SHADOW_SRC, minzoom: 9,
                layout: {
                    'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.1], 'text-anchor': 'top',
                    'text-font': (_map.getStyle().layers.find(l => l.layout && l.layout['text-font']) || { layout: { 'text-font': ['Noto Sans Regular'] } }).layout['text-font'],
                    'text-allow-overlap': false,
                },
                paint: { 'text-color': '#334', 'text-halo-color': '#fff', 'text-halo-width': 1.2 },
            });
        }
    }

    function _onClick(e) {
        const f = e.features && e.features[0];
        if (!f) return;
        const a = _aircraft.find(x => x.hex === f.properties.hex);
        if (a) _showPopup(a, e.lngLat);
    }

    /** Fly to an aircraft (by hex) and open its card. False when it isn't in the feed. */
    function focus(hex) {
        const a = _aircraft.find(x => x.hex === hex);
        if (!a || !_map) return false;
        const p = predict(a, Date.now() / 1000);
        _map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(_map.getZoom(), 11), essential: true });
        _showPopup(a, [p.lng, p.lat]);
        return true;
    }

    function _showPopup(a, lngLat) {
        if (typeof maplibregl === 'undefined') return;
        if (_popup) _popup.remove();
        const div = document.createElement('div');
        div.className = 'live-sky-pop';
        const line = (t) => { const d = document.createElement('div'); d.textContent = t; div.appendChild(d); };
        const h = document.createElement('strong'); h.textContent = a.flight; div.appendChild(h);
        if (a.type || a.reg) line([a.type, a.reg].filter(Boolean).join(' · '));
        line(a.onGround ? 'On the ground' : `${a.altFt.toLocaleString('en-IN')} ft (${Math.round(a.altM).toLocaleString('en-IN')} m)`);
        line(`${Math.round(a.speedKmh)} km/h · heading ${Math.round(a.track)}°${a.vrateFpm > 300 ? ' · climbing' : a.vrateFpm < -300 ? ' · descending' : ''}`);
        if (a.emergency) line(`Emergency: ${a.emergency}`);
        _popup = new maplibregl.Popup({ closeButton: true, offset: 8, focusAfterOpen: false }).setLngLat(lngLat).setDOMContent(div).addTo(_map);
    }

    function _renderStatus(err) {
        if (!_status) {
            _status = document.createElement('div');
            _status.className = 'live-sky-status';
            _status.setAttribute('role', 'status');
            document.body.appendChild(_status);
        }
        _status.replaceChildren();
        const t = document.createElement('span');
        if (err && !_aircraft.length) {
            t.textContent = '✈ Live aircraft: feed unreachable';
        } else {
            const s = summary(_aircraft);
            t.textContent = `✈ ${s.airborne} aircraft in the air within 75 km · ${s.low} below 1,500 m${_lastAt ? ` · ${_lastAt.toLocaleTimeString('en-IN')}` : ''}`;
        }
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', 'Aircraft altitude scale');
        [[1, 'True altitude'], [0.25, 'Altitude ×¼'], [0.1, 'Altitude ×⅒']].forEach(([v, l]) => {
            const o = document.createElement('option'); o.value = String(v); o.textContent = l; sel.appendChild(o);
        });
        sel.value = String(_scale);
        sel.addEventListener('change', () => { _scale = +sel.value; _draw(); });
        const credit = document.createElement('span');
        credit.className = 'live-sky-credit';
        credit.textContent = 'adsb.lol (ODbL)';
        _status.append(t, sel, credit);
    }

    function _syncButton(on) {
        const btn = document.getElementById('btn-livesky');
        if (!btn) return;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }

    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        _fails = 0;
        _map.on('click', L_PLANE, _onClick);
        _map.on('moveend', _onMoveEnd);
        _renderStatus();
        poll();
        _poll = setInterval(poll, POLL_MS);
        _frame = setInterval(_draw, FRAME_MS);
    }

    let _lastPollCentre = null;
    function _onMoveEnd() {
        const c = _map.getCenter();
        if (_lastPollCentre && Math.hypot(c.lat - _lastPollCentre.lat, c.lng - _lastPollCentre.lng) < 0.2) return;
        _lastPollCentre = { lat: c.lat, lng: c.lng };
        poll();
    }

    function detach() {
        _active = false;
        _reqId++;
        clearInterval(_poll); clearInterval(_frame); _poll = _frame = null;
        if (_map) {
            _map.off('click', L_PLANE, _onClick);
            _map.off('moveend', _onMoveEnd);
            for (const id of [L_LABEL, L_PLANE, L_STEM, L_SHADOW]) if (_map.getLayer(id)) _map.removeLayer(id);
            for (const id of [SRC, SHADOW_SRC]) if (_map.getSource(id)) _map.removeSource(id);
        }
        if (_popup) { _popup.remove(); _popup = null; }
        if (_status) { _status.remove(); _status = null; }
        _aircraft = [];
        _lastFrame = null;
    }

    function toggle() { if (_active) detach(); else attach(); }
    function isActive() { return _active; }
    function aircraft() { return _aircraft.slice(); }
    /** The features last handed to the map ({ planes, shadows }), or null. */
    function lastFrame() { return _lastFrame; }

    return {
        attach, detach, toggle, isActive, aircraft, lastFrame, poll, focus,
        feedUrl, proxied, parseAircraft, offset, predict, planeRing, planeLength, altColor, frameFeatures, summary,
    };
})();

if (typeof window !== 'undefined') window.LiveSky = LiveSky;
