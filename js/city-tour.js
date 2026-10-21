/**
 * CityTour — a 3D fly-through of a city's key findings, and 3D time-lapses of
 * its monthly data.
 *
 *   Tour       Overview (urban index and rank) → most and least livable zones →
 *              hottest zone → flood hotspot → the biggest recent change. Each
 *              stop extrudes the layer it talks about (zones by livability,
 *              surface heat, flood risk, or the changed series at its latest
 *              month), outlines the place, and tilts the camera onto it with a
 *              caption card. Auto-advances; ◀ ▶ ❚❚ and Esc. ● Record saves the
 *              tour as a video through CameraPresets.record (same recorder as
 *              the fly-through button).
 *   Time-lapse a monthly field extruded in 3D while the time slider plays and
 *              the camera slowly orbits; can be recorded the same way.
 *
 * buildStops() is pure given the store (unit-tested); play()/timelapse() drive
 * the map. Stops use UrbanInsights (dashboard, zoneRanking, changes).
 */
const CityTour = (() => {
    const LAYER_ID = 'tour';
    const STEP_MS = 9000;
    const BEARINGS = [-17, -32, 28, -40, 35, -24, 18];
    let _stops = [];
    let _i = -1;
    let _timer = null;
    let _city = null;
    let _reopen = false;

    // ── stops (pure given the store) ────────────────────────────────────────

    function _boundsOf(codes) {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const c of codes || []) {
            let b;
            try { b = DigiPin.decodePartial(String(c).replace(/-/g, '')).bounds; } catch { continue; }
            w = Math.min(w, b.west); s = Math.min(s, b.south); e = Math.max(e, b.east); n = Math.max(n, b.north);
        }
        return Number.isFinite(w) ? { west: w, south: s, east: e, north: n } : null;
    }

    async function _rank(store, city, dataset, field) {
        if (!store.get(dataset)) return null;
        try { return await UrbanInsights.zoneRanking(store, { city, dataset, field }); } catch { return null; }
    }

    /** The tour for a city region: [{ id, label, caption, bounds, layer, outline, pitch }]. */
    async function buildStops(city, store) {
        const U = UrbanInsights;
        const label = U.cityLabel(city);
        const stops = [];
        const dash = await U.cityDashboard(store);
        const row = dash.cities.find(c => c.region === city);
        const liv = await _rank(store, city, 'scores', 'livability');
        const zonesLayer = (r) => ({ kind: 'zones', ranking: r });
        if (liv && liv.zones.length) {
            stops.push({ id: 'overview', label, pitch: 45,
                caption: row ? `#${row.rank} of ${dash.cities.length} cities · urban index ${row.index}. Best at ${row.strengths.map(s => s.label.toLowerCase()).join(' and ')}; weakest at ${row.weaknesses.map(s => s.label.toLowerCase()).join(' and ')}.`
                    : `${liv.zones.length} zones of ~4 km, height and colour by livability.`,
                bounds: _boundsOf(liv.zones.map(z => z.code)), layer: zonesLayer(liv), outline: [] });
            const best = liv.zones[0], worst = liv.zones[liv.zones.length - 1];
            stops.push({ id: 'best', label: `Most livable zone · ${best.digipin}`,
                caption: `Livability ${U.fmt(best.mean)} against a ${label} mean of ${U.fmt(liv.cityMean)}, over ${best.cells} cells.`,
                bounds: _boundsOf([best.code]), layer: zonesLayer(liv), outline: [{ code: best.code, kind: 'strength' }] });
            stops.push({ id: 'worst', label: `Least livable zone · ${worst.digipin}`,
                caption: `Livability ${U.fmt(worst.mean)}, rank ${worst.rank} of ${liv.zones.length} zones.`,
                bounds: _boundsOf([worst.code]), layer: zonesLayer(liv), outline: [{ code: worst.code, kind: 'concern' }] });
        }
        const heat = await _rank(store, city, 'surface_heat', 'lst_day_c');
        if (heat && heat.zones.length) {
            const h = heat.zones[heat.zones.length - 1];
            stops.push({ id: 'heat', label: `Hottest zone · ${h.digipin}`,
                caption: `Daytime surfaces average ${U.fmt(h.mean, heat.unit)}, ${U.fmt(h.mean - heat.cityMean, heat.unit)} above the ${label} mean.`,
                bounds: _boundsOf([h.code]), layer: zonesLayer(heat), outline: [{ code: h.code, kind: 'concern' }] });
        }
        const flood = await _rank(store, city, 'scores', 'flood_risk');
        if (flood && flood.zones.length) {
            const f = flood.zones[flood.zones.length - 1];
            stops.push({ id: 'flood', label: `Flood hotspot · ${f.digipin}`,
                caption: `Flood risk ${U.fmt(f.mean)} /100, the highest of ${flood.zones.length} zones (city mean ${U.fmt(flood.cityMean)}).`,
                bounds: _boundsOf([f.code]), layer: zonesLayer(flood), outline: [{ code: f.code, kind: 'concern' }] });
        }
        let ch = null;
        try { ch = await U.changes(store, { city, limit: 6 }); } catch { ch = null; }
        const x = ch && ch.items.find(it => it.anomalies && it.anomalies.length && /^\d{4}-\d{2}/.test(it.step));
        if (x) {
            stops.push({ id: 'change', label: `What changed · ${x.label}, ${x.step}`,
                caption: `${x.title}. ${x.anomalyCount} cell${x.anomalyCount === 1 ? '' : 's'} moved unusually; the most unusual are outlined.`,
                bounds: _boundsOf(x.anomalies.map(a => a.code)), layer: { kind: 'cells', dataset: x.dataset, field: x.key, step: x.step },
                outline: x.anomalies.map(a => ({ code: a.code, kind: 'anomaly' })) });
        }
        if (stops.length > 1) stops.push({ ...stops[0], id: 'end', label: `${label}, from above`, caption: 'Open the Intel window for the full dashboard, what-ifs and briefs.', orbit: true });
        return stops;
    }

    // ── map plumbing ────────────────────────────────────────────────────────

    function _map() { return typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null; }
    function _toast(t, m, k) { if (typeof App !== 'undefined' && App.showToast) App.showToast(t, m, k || 'info'); }

    function _ensure3D() {
        const btn = document.getElementById('btn-3d');
        if (btn && !btn.classList.contains('active')) btn.click();
    }

    function _camera(st, k) {
        const map = _map();
        if (!map || !st.bounds) return null;
        let b = st.bounds;
        // A single zone fills the screen; widen to its neighbours so the contrast reads.
        if (st.layer && st.layer.kind === 'zones' && st.id !== 'overview') {
            const dx = (b.east - b.west) * 0.9, dy = (b.north - b.south) * 0.9;
            b = { west: b.west - dx, east: b.east + dx, south: b.south - dy, north: b.north + dy };
        }
        const card = document.getElementById('city-tour');
        const bottom = card ? Math.min(window.innerHeight * 0.45, card.getBoundingClientRect().height + 50) : 160;
        try {
            const cam = map.cameraForBounds([[b.west, b.south], [b.east, b.north]], { padding: { top: 90, right: 70, bottom, left: 70 }, maxZoom: st.id === 'overview' || st.id === 'end' ? 12.8 : st.layer && st.layer.kind === 'zones' ? 13 : 15 });
            const maxP = (typeof UIPolish !== 'undefined' && UIPolish.MAX_PITCH) || 70;
            return cam ? { center: cam.center, zoom: cam.zoom, pitch: Math.min(maxP, st.pitch || 58), bearing: BEARINGS[k % BEARINGS.length] } : null;
        } catch { return null; }
    }

    async function _paint(st) {
        if (typeof CellStore === 'undefined' || typeof CellLayers === 'undefined') return;
        const L = st.layer;
        if (L.kind === 'zones') {
            const r = L.ranking;
            const zs = r.zones.slice().sort((a, b) => (a.code < b.code ? -1 : 1));
            if (CellStore.get(LAYER_ID) && CellStore.get(LAYER_ID).title === `Tour: ${r.label}` && CellLayers.isVisible(LAYER_ID)) return;
            if (CellLayers.isVisible(LAYER_ID)) CellLayers.hide(LAYER_ID);
            CellStore.register({ id: LAYER_ID, title: `Tour: ${r.label}`, description: r.method, source: 'js/city-tour.js', license: 'Derived from the cell store',
                group: 'Urban intelligence', level: r.level,
                fields: [{ key: 'zone_mean', label: r.label, type: 'number', agg: 'mean', unit: r.unit, ramp: r.higherIs === 'worse' ? 'reds' : r.higherIs === 'better' ? 'greens' : 'viridis', higherIs: r.higherIs || undefined }],
                default: { field: 'zone_mean', extrude: true, heightM: 450 } },
            { level: r.level, cells: zs.map(z => z.code), columns: { zone_mean: zs.map(z => z.mean) } });
            await CellLayers.show(LAYER_ID, { field: 'zone_mean', extrude: true });
        } else {
            if (CellLayers.isVisible(LAYER_ID)) CellLayers.hide(LAYER_ID);
            if (L.step && typeof TimeSlider !== 'undefined' && TimeSlider.want) TimeSlider.want(L.step);
            await CellLayers.show(L.dataset, { field: L.field, extrude: true });
        }
    }

    async function _enter(k) {
        const st = _stops[k];
        if (!st) return null;
        await _paint(st);
        if (typeof InsightsPanel !== 'undefined' && InsightsPanel.highlight) InsightsPanel.highlight(st.outline || []);
        _render();
        return _camera(st, k);
    }

    async function go(k) {
        if (!_stops.length) return;
        _i = (k + _stops.length) % _stops.length;
        const cam = await _enter(_i);
        const map = _map();
        if (!map || !cam) return;
        const reduce = typeof UIPolish !== 'undefined' && UIPolish.prefersReducedMotion && UIPolish.prefersReducedMotion();
        if (reduce) map.jumpTo(cam);
        else map.flyTo({ ...cam, duration: 2800, curve: 1.4, essential: true });
        if (_stops[_i].orbit && !reduce) {
            setTimeout(() => { if (_stops.length) map.easeTo({ bearing: map.getBearing() + 70, duration: 6000, easing: t => t, essential: true }); }, 3000);
        }
    }

    function _schedule() {
        clearInterval(_timer);
        _timer = setInterval(() => {
            if (_i >= _stops.length - 1) { pause(); return; }
            go(_i + 1);
        }, STEP_MS);
        _render();
    }

    function pause() { clearInterval(_timer); _timer = null; _render(); }
    function isPlaying() { return !!_timer; }
    function isActive() { return _stops.length > 0; }

    // ── caption card ────────────────────────────────────────────────────────

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function _btn(label, title, fn, cls) {
        const b = _el('button', cls || 'ct-btn', label);
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', fn);
        return b;
    }

    function _render() {
        let card = document.getElementById('city-tour');
        if (!_stops.length) { if (card) card.remove(); return; }
        if (!card) {
            card = _el('div', 'ct-card');
            card.id = 'city-tour';
            card.setAttribute('role', 'region');
            card.setAttribute('aria-label', 'City tour');
            card.setAttribute('aria-live', 'polite');
            document.body.appendChild(card);
        }
        const st = _stops[_i] || _stops[0];
        card.replaceChildren();
        const top = _el('div', 'ct-top');
        top.appendChild(_el('span', 'ct-kicker', `◎ ${UrbanInsights.cityLabel(_city)} · ${_i + 1} / ${_stops.length}`));
        const dots = _el('span', 'ct-dots');
        _stops.forEach((_, k) => {
            const d = _btn('', `Stop ${k + 1}: ${_stops[k].label}`, () => { pause(); go(k); }, `ct-dot${k === _i ? ' is-on' : ''}`);
            dots.appendChild(d);
        });
        top.appendChild(dots);
        card.appendChild(top);
        card.appendChild(_el('div', 'ct-title', st.label));
        card.appendChild(_el('div', 'ct-caption', st.caption));
        const ctl = _el('div', 'ct-ctl');
        ctl.appendChild(_btn('◀', 'Previous stop', () => { pause(); go(_i - 1); }));
        ctl.appendChild(_btn(_timer ? '❚❚' : '▶', _timer ? 'Pause the tour' : 'Play the tour', () => { if (_timer) pause(); else { _schedule(); if (_i >= _stops.length - 1) go(0); } }));
        ctl.appendChild(_btn('▶|', 'Next stop', () => { pause(); go(_i + 1); }));
        const recording = typeof CameraPresets !== 'undefined' && CameraPresets.isRecording && CameraPresets.isRecording();
        ctl.appendChild(_btn(recording ? '■ Stop' : '● Record', recording ? 'Stop recording' : 'Record the whole tour as a video', () => (recording ? CameraPresets.stopRecording() : record()), 'ct-btn ct-rec'));
        ctl.appendChild(_btn('✕', 'End the tour', stop, 'ct-btn ct-x'));
        card.appendChild(ctl);
    }

    function _onKey(e) {
        if (!_stops.length) return;
        if (e.key === 'Escape') { e.stopPropagation(); stop(); } else if (e.key === 'ArrowRight') { pause(); go(_i + 1); } else if (e.key === 'ArrowLeft') { pause(); go(_i - 1); }
    }

    // ── public ──────────────────────────────────────────────────────────────

    /** Start the tour for a city region (default: the Intel window's city). */
    async function play(city, store) {
        store = store || (typeof CellStore !== 'undefined' ? CellStore : null);
        if (!store || !city) return false;
        _toast('City tour', `Preparing the 3D tour of ${UrbanInsights.cityLabel(city)}…`);
        let stops;
        try { stops = await buildStops(city, store); } catch (e) { _toast('City tour', e && e.message ? e.message : String(e), 'warning'); return false; }
        if (!stops.length) { _toast('City tour', 'Not enough data for a tour of this city.', 'warning'); return false; }
        stop(true);
        _stops = stops;
        _city = city;
        if (typeof InsightsPanel !== 'undefined' && InsightsPanel.isOpen && InsightsPanel.isOpen()) { _reopen = true; InsightsPanel.close(); }
        _ensure3D();
        document.addEventListener('keydown', _onKey, true);
        await go(0);
        _schedule();
        return true;
    }

    function stop(silent) {
        clearInterval(_timer); _timer = null;
        const had = _stops.length > 0;
        _stops = []; _i = -1;
        document.removeEventListener('keydown', _onKey, true);
        _render();
        if (typeof CellLayers !== 'undefined' && CellLayers.isVisible(LAYER_ID)) CellLayers.hide(LAYER_ID);
        if (had && !silent && typeof InsightsPanel !== 'undefined') {
            if (InsightsPanel.clear) InsightsPanel.clear();
            if (_reopen && InsightsPanel.open) InsightsPanel.open('city');
        }
        if (!silent) _reopen = false;
    }

    /** Record the current tour (or a fresh one) as a video through CameraPresets. */
    async function record() {
        if (typeof CameraPresets === 'undefined' || !CameraPresets.record) { _toast('Record', 'The recorder is not available.', 'warning'); return null; }
        if (!_stops.length) return null;
        pause();
        const shots = _stops.map((st, k) => ({
            caption: `${st.label} · ${st.caption}`.slice(0, 140),
            enter: async () => { _i = k; return _enter(k); },
            holdMs: 2600,
        }));
        const slug = String(_city || 'city').replace(/_pilot$/, '');
        const p = CameraPresets.record({ shots, orbit: true, fileName: `digipin-${slug}-intel-tour` });
        _render();
        const res = await p;
        _render();
        return res;
    }

    /**
     * A monthly field in 3D while the slider plays the last `months` steps and
     * the camera orbits. opts: { dataset, field, city, months = 24, record }.
     */
    async function timelapse(opts) {
        const store = typeof CellStore !== 'undefined' ? CellStore : null;
        const spec = store && store.get(opts.dataset);
        if (!spec || !spec.time || !spec.time.steps || typeof CellLayers === 'undefined' || typeof TimeSlider === 'undefined') {
            _toast('Time-lapse', 'This series cannot be played here.', 'warning');
            return false;
        }
        stop(true);
        _ensure3D();
        const steps = spec.time.steps;
        const n = Math.min(steps.length, opts.months || 24);
        const first = steps[steps.length - n];
        TimeSlider.want(first);
        await CellLayers.show(opts.dataset, { field: opts.field, extrude: true });
        TimeSlider.set(first);
        const city = (UrbanInsights.cities(store).find(c => c.name === opts.city) || {});
        const liv = await _rank(store, opts.city, 'scores', 'livability');
        const bounds = liv && liv.zones.length ? _boundsOf(liv.zones.map(z => z.code)) : city.bbox || null;
        const cam = bounds ? _camera({ id: 'overview', bounds, pitch: 50 }, 0) : null;
        const map = _map();
        const span = n * 900;
        const run = async () => {
            if (map && cam) { map.flyTo({ ...cam, duration: 2200, essential: true }); await new Promise(r => setTimeout(r, 2400)); }
            TimeSlider.set(first);
            TimeSlider.play();
            if (map) map.easeTo({ bearing: map.getBearing() + 80, duration: span, easing: t => t, essential: true });
            setTimeout(() => TimeSlider.pause(), span);
        };
        const f = spec.fields.find(x => x.key === opts.field) || {};
        if (opts.record && typeof CameraPresets !== 'undefined') {
            await CameraPresets.record({
                shots: [{ caption: `${f.label || opts.field} · ${first} to ${steps[steps.length - 1]}`, enter: async () => { await run(); }, holdMs: span }],
                orbit: false, fileName: `digipin-${String(opts.city || '').replace(/_pilot$/, '')}-${opts.dataset}-timelapse`,
            });
        } else await run();
        return true;
    }

    return { buildStops, play, stop, pause, go, record, timelapse, isActive, isPlaying, LAYER_ID };
})();

if (typeof window !== 'undefined') {
    window.CityTour = CityTour;
}
