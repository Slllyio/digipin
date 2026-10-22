/**
 * PlacesNearby — notable places around the view from Wikipedia, each pinned
 * to its DIGIPIN: a labelled pin per article, and a card with the photo, the
 * one-line description, the place's DIGIPIN and a button that selects that
 * cell (so every dataset for it is one click away).
 *
 * Idea from the Offentligdata dashboard's "Places & POI" / "Wikipedia" layers.
 * Data: Wikipedia GeoSearch through the public MediaWiki API (CORS via
 * origin=*, keyless), English or Hindi Wikipedia following the UI language.
 * Text is CC BY-SA 4.0; each card links to its article.
 *
 * Everything above the "map / DOM" line is pure and unit-tested.
 */
const PlacesNearby = (() => {
    const RADIUS_M = 10000;     // the API's maximum
    const LIMIT = 100;
    const SRC = 'places-nearby-src';
    const L_DOT = 'places-nearby-dots', L_LABEL = 'places-nearby-labels';
    const ATTRIBUTION = 'Places: Wikipedia (CC BY-SA 4.0)';

    // ---------- pure ----------

    function apiUrl(lat, lng, lang = 'en', radius = RADIUS_M, limit = LIMIT) {
        const host = lang === 'hi' ? 'hi.wikipedia.org' : 'en.wikipedia.org';
        const p = new URLSearchParams({
            action: 'query', generator: 'geosearch', ggscoord: `${lat.toFixed(5)}|${lng.toFixed(5)}`,
            ggsradius: String(radius), ggslimit: String(limit),
            prop: 'coordinates|description|pageimages|info', inprop: 'url', piprop: 'thumbnail', pithumbsize: '240',
            format: 'json', formatversion: '2', origin: '*',
        });
        return `https://${host}/w/api.php?${p}`;
    }

    /** Coarse kind from the short description, for the pin colour. */
    function kindOf(desc, title = '') {
        const t = `${desc || ''} ${title}`.toLowerCase();
        if (/temple|mosque|church|gurdwara|mandir|masjid|dargah|cathedral|shrine|monastery/.test(t)) return 'worship';
        if (/fort|palace|tomb|monument|memorial|museum|heritage|archaeolog|historic|stepwell|gate/.test(t)) return 'heritage';
        if (/park|garden|lake|forest|sanctuary|zoo|river|hill/.test(t)) return 'nature';
        if (/station|metro|airport|railway|bus terminal|bridge|flyover|highway|road/.test(t)) return 'transport';
        if (/university|college|school|institute|hospital|library/.test(t)) return 'institution';
        if (/market|mall|bazaar|hotel|stadium|cinema|theatre/.test(t)) return 'public';
        if (/neighbourhood|neighborhood|locality|suburb|village|area|colony|town|ward/.test(t)) return 'locality';
        return 'other';
    }

    const KIND_COLORS = {
        worship: '#b5651d', heritage: '#a23b72', nature: '#3a9d4a', transport: '#1f78d1',
        institution: '#6a4fb3', public: '#e08a1e', locality: '#7a7a74', other: '#4a5568',
    };

    /** MediaWiki formatversion=2 response → places, nearest first, each with a DIGIPIN. */
    function parse(json, encode) {
        const pages = (json && json.query && json.query.pages) || [];
        const out = [];
        for (const p of pages) {
            const c = p.coordinates && p.coordinates[0];
            if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
            let digipin = null;
            try { digipin = encode ? encode(c.lat, c.lon) : null; } catch { /* outside India */ }
            out.push({
                id: p.pageid, title: p.title, description: p.description || '',
                lat: c.lat, lng: c.lon, dist: c.dist ?? null,
                thumb: (p.thumbnail && p.thumbnail.source) || null,
                url: p.fullurl || null,
                kind: kindOf(p.description, p.title),
                digipin, rank: p.index ?? out.length,
            });
        }
        return out.sort((a, b) => (a.dist ?? a.rank) - (b.dist ?? b.rank));
    }

    function toGeoJSON(places) {
        return {
            type: 'FeatureCollection',
            features: places.map(p => ({
                type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: { id: p.id, title: p.title, color: KIND_COLORS[p.kind] || KIND_COLORS.other, hasPhoto: p.thumb ? 1 : 0 },
            })),
        };
    }

    // ---------- map / DOM ----------

    let _map = null;
    let _active = false;
    let _places = [];
    let _reqId = 0;
    let _popup = null;
    let _lastCentre = null;
    const _cache = new Map();   // url -> places

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind);
    }

    function _lang() {
        try { return typeof I18n !== 'undefined' && I18n.get ? I18n.get() : 'en'; } catch { return 'en'; }
    }

    function _font() {
        const l = (_map.getStyle().layers || []).find(x => x.layout && x.layout['text-font']);
        return l ? l.layout['text-font'] : ['Noto Sans Regular'];
    }

    function _ensureLayers() {
        if (!_map.getSource(SRC)) _map.addSource(SRC, { type: 'geojson', data: toGeoJSON(_places), attribution: ATTRIBUTION });
        if (!_map.getLayer(L_DOT)) {
            _map.addLayer({
                id: L_DOT, type: 'circle', source: SRC,
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 7],
                    'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
                },
            });
        }
        if (!_map.getLayer(L_LABEL)) {
            _map.addLayer({
                id: L_LABEL, type: 'symbol', source: SRC, minzoom: 12,
                layout: {
                    'text-field': ['get', 'title'], 'text-font': _font(), 'text-size': 11,
                    'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-max-width': 9,
                    'symbol-sort-key': ['-', 0, ['get', 'hasPhoto']],
                },
                paint: { 'text-color': '#2b2b2b', 'text-halo-color': '#fff', 'text-halo-width': 1.3 },
            });
        }
    }

    function _setData() {
        if (!_map) return;
        try { _ensureLayers(); } catch { return; }   // style still loading: style.load redraws
        _map.getSource(SRC).setData(toGeoJSON(_places));
    }

    async function load() {
        if (!_active || !_map) return;
        const c = _map.getCenter();
        _lastCentre = { lat: c.lat, lng: c.lng };
        const url = apiUrl(c.lat, c.lng, _lang());
        const id = ++_reqId;
        try {
            let places = _cache.get(url);
            if (!places) {
                const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                places = parse(await r.json(), typeof DigiPin !== 'undefined' ? DigiPin.encode : null);
                _cache.set(url, places);
                if (_cache.size > 20) _cache.delete(_cache.keys().next().value);
            }
            if (id !== _reqId || !_active) return;
            _places = places;
            _setData();
        } catch (e) {
            if (id !== _reqId || !_active) return;
            console.warn('PlacesNearby:', e);
            _toast('Places unavailable', 'Wikipedia did not answer; try again in a moment.', 'warning');
        }
    }

    function _card(p) {
        const div = document.createElement('div');
        div.className = 'places-card';
        if (p.thumb) {
            const img = document.createElement('img');
            img.src = p.thumb; img.alt = ''; img.loading = 'lazy';
            div.appendChild(img);
        }
        const h = document.createElement('strong'); h.textContent = p.title; div.appendChild(h);
        if (p.description) { const d = document.createElement('div'); d.className = 'places-desc'; d.textContent = p.description; div.appendChild(d); }
        if (p.digipin) {
            const pin = document.createElement('div'); pin.className = 'places-pin';
            pin.textContent = `DIGIPIN ${p.digipin}`;
            div.appendChild(pin);
        }
        const row = document.createElement('div'); row.className = 'places-actions';
        if (p.digipin && typeof MapModule !== 'undefined' && MapModule.selectByCode) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Open this cell';
            b.addEventListener('click', () => { if (_popup) _popup.remove(); MapModule.selectByCode(p.digipin); });
            row.appendChild(b);
        }
        if (p.url) {
            const a = document.createElement('a'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.textContent = 'Wikipedia ↗';
            row.appendChild(a);
        }
        div.appendChild(row);
        return div;
    }

    function _onClick(e) {
        const f = e.features && e.features[0];
        const p = f && _places.find(x => x.id === f.properties.id);
        if (!p || typeof maplibregl === 'undefined') return;
        if (_popup) _popup.remove();
        _popup = new maplibregl.Popup({ offset: 10, maxWidth: '260px' }).setLngLat([p.lng, p.lat]).setDOMContent(_card(p)).addTo(_map);
    }

    function _onMoveEnd() {
        if (!_lastCentre) return;
        const c = _map.getCenter();
        const km = Math.hypot((c.lat - _lastCentre.lat) * 111, (c.lng - _lastCentre.lng) * 111 * Math.cos(c.lat * Math.PI / 180));
        if (km > 5) load();
    }
    function _onEnter() { _map.getCanvas().style.cursor = 'pointer'; }
    function _onLeave() { _map.getCanvas().style.cursor = ''; }
    function _onStyle() { if (_active) _setData(); }

    function attach() {
        if (typeof MapModule === 'undefined') return;
        _map = MapModule.getMap();
        if (!_map) return;
        _active = true;
        _map.on('click', L_DOT, _onClick);
        _map.on('mouseenter', L_DOT, _onEnter);
        _map.on('mouseleave', L_DOT, _onLeave);
        _map.on('moveend', _onMoveEnd);
        _map.on('style.load', _onStyle);
        load();
    }

    function detach() {
        _active = false;
        _reqId++;
        if (_map) {
            _map.off('click', L_DOT, _onClick);
            _map.off('mouseenter', L_DOT, _onEnter);
            _map.off('mouseleave', L_DOT, _onLeave);
            _map.off('moveend', _onMoveEnd);
            _map.off('style.load', _onStyle);
            for (const id of [L_LABEL, L_DOT]) if (_map.getLayer(id)) _map.removeLayer(id);
            if (_map.getSource(SRC)) _map.removeSource(SRC);
        }
        if (_popup) { _popup.remove(); _popup = null; }
        _places = [];
        _lastCentre = null;
    }

    function toggle() { if (_active) detach(); else attach(); }
    function isActive() { return _active; }
    function places() { return _places.slice(); }

    return { attach, detach, toggle, isActive, places, load, apiUrl, kindOf, parse, toGeoJSON, KIND_COLORS };
})();

if (typeof window !== 'undefined') window.PlacesNearby = PlacesNearby;
