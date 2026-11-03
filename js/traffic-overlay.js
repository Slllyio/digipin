/**
 * TrafficOverlay — paints the road network by Level-of-Service (structural
 * congestion). Two data paths:
 *
 *   1. Precomputed (preferred): loads data/traffic/<region>/road_los.geojson
 *      (from pipeline/traffic/road_network.py) — each road carries a betweenness-
 *      derived LOS grade A–F + criticality. Critical/bottleneck "bridge" links
 *      are drawn thicker.
 *   2. Fallback (no precomputed file): fetches the viewport's roads live from
 *      Overpass (like ward-overlay.js) and colours them by OSM-class capacity
 *      only (no betweenness) — labelled honestly so it's not mistaken for the
 *      full model. Gives an immediate, useful layer everywhere.
 *
 * Standard overlay contract: idempotent attach/detach/toggle/isVisible, single
 * source+layers cleaned up on detach, theme-aware legend. colorFor/gradeForRoad
 * are pure and unit-tested.
 *
 * Where pipeline/traffic/demand_model.py has run, each road also carries a
 * modelled morning-peak load (pcu_peak, vc_peak, los_peak, speed_peak): trips
 * from homes to jobs routed on the arterials. Roads are then coloured by that
 * peak LOS, drawn wider with more traffic, and animated dashes show the
 * direction-free movement on the busiest links.
 *
 * Time of day: the model also assigns the 18:00 trip home and midday errands
 * (vc_am / vc_pm / vc_mid per road). The legend's clock slider (and ▶ play)
 * re-colours every road for any hour 00–23 with paint expressions only, so
 * scrubbing never reloads data; the same view shows when the map is pitched.
 *
 * Honest framing: modelled / structural congestion, NOT real-time delays.
 * docs/TRAFFIC_MODEL.md
 */
const TrafficOverlay = (() => {
    const SOURCE_ID = 'traffic-overlay-src';
    const LINE_ID   = 'traffic-overlay-line';
    const FLOW_ID   = 'traffic-overlay-flow';
    const CRIT_ID   = 'traffic-overlay-critical';
    const LEGEND_ID = 'traffic-legend';
    const DEFAULT_REGION = 'indore_pilot';
    const FLOW_MIN_PCU = 1200;      // animate movement on roads busier than this in the peak hour
    // Dash pattern frames for the movement animation (MapLibre "ant path").
    const DASHES = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
        [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];

    /** Region whose road file to load: the selected city's cell-store region. */
    function region() {
        try {
            if (typeof CitySelector !== 'undefined' && CitySelector.currentArea) {
                const a = CitySelector.currentArea();
                if (a && a.region) return a.region;
            }
        } catch { /* selector not ready */ }
        return DEFAULT_REGION;
    }
    function geojsonUrl(r) { return `./data/traffic/${r || region()}/road_los.geojson`; }
    const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

    // LOS A (free-flow, green) → F (breakdown, deep red). Sequential ramp.
    const BANDS = [
        { grade: 'F', color: '#7f0000', label: 'F — breakdown' },
        { grade: 'E', color: '#d7301f', label: 'E — at capacity' },
        { grade: 'D', color: '#ef6548', label: 'D — congested' },
        { grade: 'C', color: '#fc8d59', label: 'C — busy' },
        { grade: 'B', color: '#fdbb84', label: 'B — stable' },
        { grade: 'A', color: '#31a354', label: 'A — free-flow' },
    ];
    const _COLOR = BANDS.reduce((m, b) => (m[b.grade] = b.color, m), {});

    let _active = false;
    let _map = null;
    let _abort = null;
    let _mode = 'precomputed';   // or 'class_based' (Overpass fallback)
    let _popup = null;
    let _modelled = false;      // roads carry demand-model peak fields
    let _timed = false;         // …and the time-of-day fields (vc_am / vc_pm / vc_mid)
    let _anim = null;
    let _unsub = null;
    let _hour = null;           // null = worse of the two peaks; 0–23 = that hour
    let _play = null;
    let _cfg = null;            // summary.json demand_model.hourly

    // Fallback hourly profile, identical to pipeline/traffic/demand_model.py.
    const HOURLY = {
        share_pct: [0.6, 0.4, 0.3, 0.3, 0.5, 1.1, 2.4, 4.4, 7.0, 9.0, 7.6, 5.6,
            5.0, 4.8, 4.6, 4.8, 5.4, 7.0, 8.8, 7.8, 5.6, 3.6, 2.2, 1.2],
        mix: Array.from({ length: 24 }, (_, h) => (
            [8, 9, 10].includes(h) ? [1, 0, 0] : h === 7 ? [0.8, 0, 0.2] : [6, 11].includes(h) ? [0.5, 0, 0.5]
                : [18, 19, 20].includes(h) ? [0, 1, 0] : h === 17 ? [0, 0.8, 0.2] : [16, 21].includes(h) ? [0, 0.5, 0.5]
                    : [0, 0, 1])),
        periods: ['am', 'pm', 'mid'],
        period_share: { am: 0.09, pm: 0.088, mid: 0.048 },
        bpr: [0.15, 4], max_slowdown: 4,
        los_bands: [0.35, 0.55, 0.75, 0.90, 1.00],
    };

    /** Weights turning a road's period V/C (vc_am, vc_pm, vc_mid) into its V/C at ``hour``. */
    function hourCoef(hour, cfg = HOURLY) {
        const h = ((Math.round(hour) % 24) + 24) % 24;
        const out = {};
        cfg.periods.forEach((k, i) => {
            out[k] = (cfg.mix[h][i] || 0) * cfg.share_pct[h] / (100 * cfg.period_share[k]);
        });
        return out;
    }
    /** A road's modelled V/C at ``hour`` (null when the road has no time-of-day fields). */
    function vcAt(props, hour, cfg = HOURLY) {
        if (!props || props.vc_am == null) return null;
        const c = hourCoef(hour, cfg);
        return Object.keys(c).reduce((t, k) => t + c[k] * (Number(props[`vc_${k}`]) || 0), 0);
    }
    /** LOS letter for a V/C ratio (HCM bands as in the pipeline). */
    function losFor(vc, cfg = HOURLY) {
        const g = 'ABCDE';
        for (let i = 0; i < cfg.los_bands.length; i++) if (vc <= cfg.los_bands[i]) return g[i];
        return 'F';
    }
    /** BPR speed (km/h) at a V/C, floored at free-flow ÷ max_slowdown. */
    function speedAt(ffs, vc, cfg = HOURLY) {
        if (!(ffs > 0)) return null;
        const [a, b] = cfg.bpr;
        return ffs / Math.min(1 + a * Math.pow(vc, b), cfg.max_slowdown);
    }
    /** "18:00 · evening peak"-style label for an hour. */
    function hourLabel(h) {
        const t = `${String(h).padStart(2, '0')}:00`;
        const what = h >= 8 && h <= 10 ? 'morning peak' : h >= 17 && h <= 20 ? 'evening peak'
            : h >= 11 && h <= 16 ? 'midday' : h >= 6 && h < 8 ? 'morning build-up' : h >= 21 || h < 6 ? 'night' : '';
        return what ? `${t} · ${what}` : t;
    }
    /** MapLibre expression for a road's V/C at the coefficients of one hour. */
    function vcExpression(coef) {
        return ['+', ...Object.keys(coef).map(k => ['*', coef[k], ['coalesce', ['get', `vc_${k}`], 0]])];
    }
    /** Paint values (colour, width multiplier, flow filter) for ``hour`` (null = peak view). */
    function paintFor(hour, cfg = HOURLY) {
        if (hour == null) {
            return {
                color: ['get', 'color'], w: ['get', 'w'],
                flow: ['>=', ['coalesce', ['get', 'pcu_peak'], 0], FLOW_MIN_PCU],
            };
        }
        const vc = vcExpression(hourCoef(hour, cfg));
        const bands = cfg.los_bands;
        const step = ['step', vc, colorFor('A')];
        'BCDEF'.split('').forEach((g, i) => step.push(bands[i] + 1e-9, colorFor(g)));
        const pcu = ['*', ['coalesce', ['get', 'pcu_peak'], 0], ['/', vc, ['max', ['coalesce', ['get', 'vc_peak'], 0], 0.01]]];
        return {
            color: ['case', ['has', 'vc_am'], step, ['get', 'color']],
            w: ['case', ['has', 'vc_am'], ['+', 0.7, ['/', ['min', pcu, 6000], 2000]], ['get', 'w']],
            flow: ['all', ['has', 'vc_am'], ['>=', pcu, FLOW_MIN_PCU]],
        };
    }

    /** Colour for a LOS grade ('A'..'F'), transparent when unknown. */
    function colorFor(grade) {
        return _COLOR[grade] || 'rgba(0,0,0,0)';
    }

    /** Derive a LOS grade for a road feature from its props. Uses the precomputed
     *  los_grade if present, else a class-capacity-only grade (fallback path). */
    function gradeForRoad(props) {
        if (props && props.los_peak) return props.los_peak;
        if (props && props.los_grade) return props.los_grade;
        if (typeof TrafficScore === 'undefined') return null;
        const cap = TrafficScore.capacityForClass(props && props.highway);
        // Fallback proxy: high-capacity arterials carry more load → worse LOS.
        const los = TrafficScore.losFromVC(cap);
        return los ? los.grade : null;
    }

    /** Current MapLibre map instance, or null if MapModule isn't ready. */
    function _map_() { return (typeof MapModule !== 'undefined') ? MapModule.getMap() : null; }

    /** Add the source + LOS line / critical-link layers on first paint, or update data thereafter. */
    function _paint(geojson) {
        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, { type: 'geojson', data: geojson });
            _map.addLayer({
                id: LINE_ID, type: 'line', source: SOURCE_ID,
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': _widthExpr(['get', 'w']),
                    'line-opacity': 0.85,
                },
            });
            // Moving dashes on the busiest roads: where the modelled peak traffic flows.
            _map.addLayer({
                id: FLOW_ID, type: 'line', source: SOURCE_ID,
                filter: ['>=', ['coalesce', ['get', 'pcu_peak'], 0], FLOW_MIN_PCU],
                layout: { 'line-cap': 'butt' },
                paint: {
                    'line-color': '#ffffff',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 2.2],
                    'line-opacity': 0.75,
                    'line-dasharray': DASHES[0],
                },
            });
            // Critical / bottleneck links emphasised on top.
            _map.addLayer({
                id: CRIT_ID, type: 'line', source: SOURCE_ID,
                filter: ['==', ['get', 'is_critical'], true],
                paint: {
                    'line-color': '#000000',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 7],
                    'line-opacity': 0.45,
                },
            });
            _map.on('click', LINE_ID, _onClick);
            _map.on('mouseenter', LINE_ID, _onEnter);
            _map.on('mouseleave', LINE_ID, _onLeave);
        } else {
            _map.getSource(SOURCE_ID).setData(geojson);
        }
    }

    /** Zoom-scaled line width around a per-road multiplier expression. */
    function _widthExpr(w) {
        return ['interpolate', ['linear'], ['zoom'], 10, ['*', 1.2, w], 16, ['*', 4, w]];
    }

    /** Re-colour the roads for ``hour`` (null = peak view) without touching the data. */
    function setHour(hour) {
        _hour = hour == null || !Number.isFinite(Number(hour)) ? null : ((Math.round(hour) % 24) + 24) % 24;
        if (_map && _map.getLayer && _map.getLayer(LINE_ID)) {
            const p = paintFor(_hour, _cfg || HOURLY);
            _map.setPaintProperty(LINE_ID, 'line-color', p.color);
            _map.setPaintProperty(LINE_ID, 'line-width', _widthExpr(p.w));
            if (_map.getLayer(FLOW_ID)) _map.setFilter(FLOW_ID, p.flow);
        }
        _syncClock();
        for (const fn of _hourFns) { try { fn(_hour); } catch (e) { console.warn('traffic hour listener', e); } }
        return _hour;
    }
    const _hourFns = new Set();
    /** Call fn(hour) whenever the clock moves; returns an unsubscribe. */
    function onHour(fn) { _hourFns.add(fn); return () => _hourFns.delete(fn); }
    /** The city's hourly profile (summary.json) or the default. */
    function config() { return _cfg || HOURLY; }
    /** Current hour shown (null = worse peak). */
    function getHour() { return _hour; }

    /** Play the day: advance one hour every ``ms`` until stopped. */
    function play(ms = 700) {
        stop();
        if (_hour == null) setHour(5);
        _play = setInterval(() => {
            if (!_active) { stop(); return; }
            setHour((_hour + 1) % 24);
        }, ms);
        _syncClock();
    }
    /** Stop the day animation. */
    function stop() {
        if (_play) { clearInterval(_play); _play = null; }
        _syncClock();
    }

    /** Show a pointer cursor over road lines. */
    function _onEnter() { if (_map) _map.getCanvas().style.cursor = 'pointer'; }
    /** Reset the cursor when leaving road lines. */
    function _onLeave() { if (_map) _map.getCanvas().style.cursor = ''; }

    /** Open a popup describing the clicked road (name, LOS grade, risk, criticality). */
    function _onClick(e) {
        if (typeof RoadWhatIf !== 'undefined' && RoadWhatIf.isPicking && RoadWhatIf.isPicking()) return;
        const p = (e.features && e.features[0] && e.features[0].properties) || {};
        /** HTML-escape a value for safe insertion into the popup markup. */
        const esc = (v) => String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const grade = gradeForRoad(p);
        let html = `<div style="font-family:Inter,sans-serif;font-size:12px;">`
            + `<strong>${esc(p.name) || esc(p.highway) || 'Road'}</strong>`
            + `<br>${p.los_peak ? 'Morning peak LOS' : 'LOS'} <strong>${esc(grade || '—')}</strong>`;
        const vh = _hour != null ? vcAt(p, _hour, _cfg || HOURLY) : null;
        if (vh != null) {
            const sp = speedAt(Number(p.ffs), vh, _cfg || HOURLY);
            html = html.replace(/(Morning peak LOS|LOS) <strong>[^<]*<\/strong>/,
                `LOS at ${esc(hourLabel(_hour))} <strong>${esc(losFor(vh, _cfg || HOURLY))}</strong>`);
            html += `<br>V/C ${esc(vh.toFixed(2))}` + (sp != null ? ` · ~${esc(Math.round(sp))} km/h` : '')
                + `<br>peaks: 09:00 V/C ${esc(p.vc_am)} · 18:00 V/C ${esc(p.vc_pm)} · 13:00 V/C ${esc(p.vc_mid)}`
                + (p.pcu_daily != null ? `<br>~${esc(Number(p.pcu_daily).toLocaleString('en-IN'))} PCU/day` : '')
                + `<br><span style="opacity:.7">modelled, not counts</span>`;
        } else if (p.pcu_peak != null) {
            const when = p.peak_period === 'pm' ? 'evening peak (18:00)' : p.peak_period === 'am' ? 'morning peak (09:00)' : 'peak hour';
            html = html.replace('Morning peak LOS', p.peak_period === 'pm' ? 'Evening peak LOS' : 'Morning peak LOS');
            html += `<br>~${esc(Number(p.pcu_peak).toLocaleString('en-IN'))} PCU/h in the busier direction, ${esc(when)}`
                + ` · V/C ${esc(p.vc_peak)}`
                + (p.speed_peak != null ? `<br>peak speed ~${esc(p.speed_peak)} km/h` : '')
                + (p.pcu_daily != null ? ` · ~${esc(Number(p.pcu_daily).toLocaleString('en-IN'))} PCU/day` : '')
                + `<br><span style="opacity:.7">modelled (homes ↔ jobs), not counts</span>`;
            if (p.los_grade) html += `<br>structural LOS ${esc(p.los_grade)}`;
        } else {
            if (p.congestion_risk != null) html += ` · risk ${esc(p.congestion_risk)}/100`;
            if (p.betweenness != null) html += `<br>betweenness ${esc(p.betweenness)}`;
        }
        if (p.is_bridge) html += `<br>⚠ critical link (single point of failure)`;
        html += '</div>';
        if (_popup) _popup.remove();
        if (typeof maplibregl !== 'undefined') {
            _popup = new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(_map);
        }
    }

    /** Tag features with a `color` (from LOS) + `is_critical` flag for the paint. */
    function _decorate(features) {
        features.forEach((f, i) => {
            const p = f.properties || (f.properties = {});
            p.fi = i;                       // feature index (road what-if picks roads by it)
            p.color = colorFor(gradeForRoad(p));
            p.w = widthFor(p.pcu_peak);
            // Emphasise only genuinely critical links (high-betweenness bridges),
            // not every graph bridge — an arterial-only network has many of those.
            p.is_critical = (p.criticality === 'critical');
        });
        return features;
    }

    /** Line-width multiplier for a road's peak flow (1 when unknown). */
    function widthFor(pcu) {
        const v = Number(pcu);
        if (!Number.isFinite(v) || v <= 0) return 1;
        return 0.7 + Math.min(v, 6000) / 2000;
    }

    /** Fetch the precomputed LOS GeoJSON artifact, or null when absent/unreachable. */
    async function _loadPrecomputed(signal) {
        try {
            const r = await fetch(geojsonUrl(), { cache: 'force-cache', signal });
            if (!r.ok) return null;
            const gj = await r.json();
            _decorate(gj.features || []);
            _modelled = (gj.features || []).some(f => f.properties && f.properties.pcu_peak != null);
            _timed = (gj.features || []).some(f => f.properties && f.properties.vc_am != null);
            _cfg = null;
            if (_timed) {
                try {
                    const sr = await fetch(geojsonUrl().replace('road_los.geojson', 'summary.json'), { cache: 'force-cache', signal });
                    const h = sr.ok ? ((await sr.json()).demand_model || {}).hourly : null;
                    if (h && Array.isArray(h.share_pct) && h.share_pct.length === 24) _cfg = { ...HOURLY, ...h };
                } catch { /* fall back to the built-in profile */ }
            }
            return gj;
        } catch { return null; }
    }

    /** Fallback: fetch the viewport's roads live from Overpass and build a class-based FeatureCollection. */
    async function _loadOverpass(signal) {
        const b = _map.getBounds();
        const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
        const q = `[out:json][timeout:25];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"](${bbox}););out geom;`;
        const resp = await fetch(OVERPASS_URL, {
            method: 'POST', signal,
            body: `data=${encodeURIComponent(q)}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
        const data = await resp.json();
        const features = [];
        (data.elements || []).forEach(el => {
            if (!el.geometry) return;
            const coords = el.geometry.map(pt => [pt.lon, pt.lat]);
            if (coords.length < 2) return;
            features.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coords },
                properties: { highway: el.tags?.highway, name: el.tags?.name },
            });
        });
        _decorate(features);
        return { type: 'FeatureCollection', features };
    }

    /** Load roads (precomputed LOS, else Overpass fallback) and (re)paint the layer + legend. */
    async function refresh() {
        _map = _map_();
        if (!_map) return;
        if (_abort) _abort.abort();
        _abort = new AbortController();
        const signal = _abort.signal;

        if (typeof App !== 'undefined') App.showToast('Traffic', 'Loading road network…', 'info');
        let gj = await _loadPrecomputed(signal);
        _mode = 'precomputed';
        if (!gj || !(gj.features || []).length) {
            // No precomputed artifact → live class-based fallback for the viewport.
            _mode = 'class_based';
            try { gj = await _loadOverpass(signal); }
            catch (e) {
                if (typeof App !== 'undefined') App.showToast('Traffic', `Road fetch failed: ${e.message}`, 'error');
                return;
            }
        }
        if (signal.aborted || !_active) return;
        _paint(gj);
        _renderLegend();
        if (_hour != null) setHour(_timed ? _hour : null);
        _animate();
        if (typeof App !== 'undefined') {
            App.showToast('Traffic',
                `${(gj.features || []).length} roads (${_mode !== 'precomputed' ? 'class-based, no centrality' : _modelled ? 'modelled morning peak' : 'LOS · betweenness'}).`,
                'success');
        }
    }

    /** Step the dash pattern so traffic visibly moves; stops when hidden or reduced motion. */
    function _animate() {
        if (_anim || !_modelled || !_map || !_map.getLayer(FLOW_ID)) return;
        const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduce) return;
        let i = 0;
        _anim = setInterval(() => {
            if (!_active || !_map || !_map.getLayer(FLOW_ID)) { clearInterval(_anim); _anim = null; return; }
            i = (i + 1) % DASHES.length;
            _map.setPaintProperty(FLOW_ID, 'line-dasharray', DASHES[i]);
        }, 90);
    }

    // ---- legend ----
    /** Theme palette, with a dark-mode fallback when Theme is unavailable. */
    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }
    /** Create or refresh the bottom-left legend listing LOS bands and mode note. */
    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Traffic Level-of-Service legend');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = `position:absolute;bottom:24px;left:96px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:12px 14px;color:${pal.ink};`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        // With the clock the legend is taller, so LOS bands collapse into one strip.
        const rows = _timed && _mode === 'precomputed'
            ? `<div style="display:flex;gap:2px;margin:2px 0;" aria-label="Level of Service A free-flow to F breakdown">`
                + BANDS.slice().reverse().map(b => `<div title="${b.label}" style="flex:1;text-align:center;">`
                    + `<div style="height:5px;border-radius:2px;background:${b.color};"></div>`
                    + `<div style="color:${pal.sub};font-size:11px;">${b.grade}</div></div>`).join('')
                + `</div><div style="display:flex;justify-content:space-between;color:${pal.sub};font-size:11px;"><span>free-flow</span><span>breakdown</span></div>`
            : BANDS.map(b => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
                + `<span style="width:16px;height:4px;border-radius:2px;background:${b.color};flex:none;"></span>`
                + `<span style="color:${pal.sub};">${b.label}</span></div>`).join('');
        const note = _mode !== 'precomputed'
            ? 'Class-based estimate (no centrality) · run the pipeline for full LOS'
            : _modelled
                ? (_timed
                    ? 'Modelled from homes, jobs and errands routed on the arterials (volume ÷ capacity → LOS). Wider = more traffic; moving dashes = busiest roads. Not live counts.'
                    : 'Modelled morning peak hour: trips from homes to jobs routed on the arterials (volume ÷ capacity → LOS). Wider = more traffic; moving dashes = busiest roads. Not live counts.')
                : 'Structural congestion · betweenness ÷ road capacity → LOS';
        el.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:8px;color:${pal.primary};">Traffic — ${_timed ? 'through the day' : _modelled ? 'peak-hour load' : 'Level of Service'}</div>`
            + rows
            + `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;"><span style="width:16px;height:4px;background:#000;opacity:.55;flex:none;"></span><span style="color:${pal.sub};">critical link</span></div>`
            + (_timed && _mode === 'precomputed' ? _clockHtml(pal) : '')
            + `<div style="margin-top:6px;color:${pal.sub};font-size:11px;max-width:240px;">${note}</div>`;
        if (_timed && _mode === 'precomputed') _wireClock(el);
        _syncClock();
    }

    /** Time-of-day control: play button, hour slider, "worse peak" reset. */
    function _clockHtml(pal) {
        const btn = `background:transparent;border:1px solid ${pal.border};color:${pal.ink};border-radius:6px;`
            + 'padding:2px 8px;font:12px system-ui,sans-serif;cursor:pointer;';
        return `<div style="margin-top:8px;padding-top:8px;border-top:1px solid ${pal.border};">`
            + `<div style="display:flex;align-items:center;gap:6px;">`
            + `<button type="button" data-tclock="play" aria-label="Play the day" style="${btn}">▶</button>`
            + `<input type="range" min="0" max="23" step="1" value="${_hour == null ? 9 : _hour}" data-tclock="hour" aria-label="Hour of day" style="flex:1;min-width:120px;accent-color:${pal.primary};">`
            + `<button type="button" data-tclock="peak" style="${btn}">Peak</button></div>`
            + (typeof TrafficBuildings !== 'undefined' ? `<label style="display:flex;align-items:center;gap:6px;margin-top:6px;cursor:pointer;"><input type="checkbox" data-tclock="bldg"${TrafficBuildings.isOn() ? ' checked' : ''}> Colour 3D buildings by the clock</label>` : '')
            + (typeof RoadWhatIf !== 'undefined' ? `<button type="button" data-tclock="whatif" style="${btn}margin-top:6px;width:100%;">What if… close, widen or add a road</button>` : '')
            + `<div data-tclock="label" aria-live="polite" style="margin-top:4px;color:${pal.ink};font-weight:600;"></div></div>`;
    }
    function _wireClock(el) {
        const q = (k) => el.querySelector(`[data-tclock="${k}"]`);
        const r = q('hour');
        if (r) r.addEventListener('input', () => { const h = Number(r.value); stop(); setHour(h); });
        const pb = q('play');
        if (pb) pb.addEventListener('click', () => (_play ? stop() : play()));
        const pk = q('peak');
        if (pk) pk.addEventListener('click', () => { stop(); setHour(null); });
        const wi = q('whatif');
        if (wi) wi.addEventListener('click', () => RoadWhatIf.toggle());
        const bl = q('bldg');
        if (bl) bl.addEventListener('change', async () => {
            const ok = bl.checked ? await TrafficBuildings.enable() : (await TrafficBuildings.disable(), false);
            bl.checked = !!ok;
        });
    }
    /** Reflect the current hour / play state in the legend clock. */
    function _syncClock() {
        if (typeof document === 'undefined') return;
        const el = document.getElementById(LEGEND_ID);
        if (!el) return;
        const q = (k) => el.querySelector(`[data-tclock="${k}"]`);
        const r = q('hour'), lab = q('label'), pb = q('play');
        if (r && _hour != null) r.value = String(_hour);
        if (lab) lab.textContent = _hour == null ? 'Worse of the 09:00 / 18:00 peaks' : hourLabel(_hour);
        if (pb) { pb.textContent = _play ? '❚❚' : '▶'; pb.setAttribute('aria-label', _play ? 'Pause' : 'Play the day'); }
    }
    /** Remove the legend element if present. */
    function _removeLegend() { const el = document.getElementById(LEGEND_ID); if (el) el.remove(); }

    /** Activate the overlay and load data. */
    function attach() {
        _active = true;
        if (!_unsub && typeof CitySelector !== 'undefined' && CitySelector.onChange) {
            _unsub = CitySelector.onChange(() => { if (_active) refresh(); });
        }
        refresh();
    }
    /** Deactivate the overlay: abort fetches, drop the popup/legend, and remove layers/source. */
    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        if (_anim) { clearInterval(_anim); _anim = null; }
        stop();
        if (_unsub) { _unsub(); _unsub = null; }
        if (_popup) { _popup.remove(); _popup = null; }
        if (typeof RoadWhatIf !== 'undefined' && RoadWhatIf.close) RoadWhatIf.close();
        if (typeof TrafficBuildings !== 'undefined' && TrafficBuildings.isOn()) TrafficBuildings.disable();
        _removeLegend();
        const map = _map_();
        if (!map) return;
        map.off('click', LINE_ID, _onClick);
        map.off('mouseenter', LINE_ID, _onEnter);
        map.off('mouseleave', LINE_ID, _onLeave);
        if (map.getLayer(FLOW_ID)) map.removeLayer(FLOW_ID);
        if (map.getLayer(CRIT_ID)) map.removeLayer(CRIT_ID);
        if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }
    /** Toggle the overlay on/off. */
    function toggle() { if (_active) detach(); else attach(); }
    /** Whether the overlay is currently active. */
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, refresh, colorFor, gradeForRoad, widthFor, geojsonUrl, region, BANDS,
        setHour, getHour, onHour, config, play, stop, hourCoef, vcAt, losFor, speedAt, hourLabel, paintFor, HOURLY };
})();

if (typeof window !== 'undefined') window.TrafficOverlay = TrafficOverlay;
