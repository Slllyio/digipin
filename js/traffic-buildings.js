/**
 * TrafficBuildings — colour the 3D buildings by the traffic clock.
 *
 * The demand model gives each L7 cell on an arterial its V/C in the morning
 * peak, evening peak and midday (cell dataset traffic_load: am_vc, pm_vc,
 * mid_vc). For the hour on the Traffic legend clock this builds a runtime
 * cell dataset `traffic_clock` (field vc_now = the worst road V/C in the cell
 * or the next one, ~250 m, at that hour, via TrafficOverlay.vcAt) and points
 * BuildingData's colour driver at it. Moving the clock or playing the day
 * repaints the buildings beside each road as it fills and empties.
 *
 *   traffic_load (cells) ── neighbours() once per city ──┐
 *   TrafficOverlay.onHour(h) ── tableFor(base, h) ── CellStore.register ── BuildingData.refresh
 *
 * neighbours/tableFor are pure and unit-tested.
 */
const TrafficBuildings = (() => {
    const ID = 'traffic_clock';
    const KEY = `${ID}:vc_now`;
    const LEVEL = 7;
    const NEIGHBOUR_W = 0.75;  // a road one cell away counts at 3/4 of its V/C, so colour falls off from the street

    let _on = false;
    let _base = null;          // { cells, am, pm, mid, peak, targets: [[code, [src…]]] }
    let _unsubHour = null, _unsubCity = null;

    // Script-scope consts (not window properties), so look each one up by typeof.
    const _g = (name) => ({
        CellStore: () => (typeof CellStore !== 'undefined' ? CellStore : null),
        DigiPin: () => (typeof DigiPin !== 'undefined' ? DigiPin : null),
        TrafficOverlay: () => (typeof TrafficOverlay !== 'undefined' ? TrafficOverlay : null),
        BuildingData: () => (typeof BuildingData !== 'undefined' ? BuildingData : null),
        CitySelector: () => (typeof CitySelector !== 'undefined' ? CitySelector : null),
        OvertureBuildings: () => (typeof OvertureBuildings !== 'undefined' ? OvertureBuildings : null),
        MapModule: () => (typeof MapModule !== 'undefined' ? MapModule : null),
    }[name] || (() => null))();

    // ── pure helpers ────────────────────────────────────────────────────────

    /**
     * For each source cell (with centre lat/lng and size in degrees), the codes
     * of itself and its 8 neighbours; returns [[code, [[source index, weight]…]]]
     * (weight 1 for the cell itself, NEIGHBOUR_W next door) so a target cell
     * takes the worst weighted V/C of the roads in or beside it. Pure given
     * `codeAt(lat, lng)`.
     */
    function neighbours(centres, step, codeAt) {
        const map = new Map();
        centres.forEach(([lat, lng], i) => {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const c = codeAt(lat + dy * step, lng + dx * step);
                    if (!c) continue;
                    let s = map.get(c);
                    if (!s) map.set(c, (s = []));
                    s.push([i, dx === 0 && dy === 0 ? 1 : NEIGHBOUR_W]);
                }
            }
        });
        return [...map.entries()];
    }

    /**
     * The runtime table for `hour` (null = worse peak): { level, cells, columns:
     * { vc_now } }, each target cell holding the max V/C of its sources. Pure
     * given `vcAt(props, hour)`.
     */
    function tableFor(base, hour, vcAt) {
        const n = base.am.length, v = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            v[i] = hour == null
                ? (base.peak[i] != null ? base.peak[i] : Math.max(base.am[i] || 0, base.pm[i] || 0))
                : (vcAt({ vc_am: base.am[i] || 0, vc_pm: base.pm[i] || 0, vc_mid: base.mid[i] || 0 }, hour) || 0);
        }
        const cells = [], col = [];
        for (const [code, src] of base.targets) {
            let m = -1;
            for (const [i, w] of src) if (v[i] * w > m) m = v[i] * w;
            cells.push(code);
            col.push(Math.round(m * 100) / 100);
        }
        return { level: LEVEL, cells, columns: { vc_now: col } };
    }

    function spec(hour, label) {
        return {
            id: ID, title: 'Traffic by the clock', group: 'Traffic & mobility', level: LEVEL,
            description: 'Worst modelled road volume/capacity in or beside each cell at the hour on the Traffic clock.',
            source: 'js/traffic-buildings.js over traffic_load (pipeline/traffic/demand_model.py)',
            license: 'ODbL (OpenStreetMap) + CC BY 4.0 (GHSL)',
            fields: [{ key: 'vc_now', label: `Road V/C nearby · ${label}`, type: 'number', agg: 'max', unit: 'ratio',
                domain: [0, 1.2], ramp: 'heat', higherIs: 'worse' }],
            default: { field: 'vc_now', extrude: false },
        };
    }

    // ── runtime ─────────────────────────────────────────────────────────────

    async function _prepare() {
        const CS = _g('CellStore'), DP = _g('DigiPin');
        if (!CS || !DP) return null;
        const t = await CS.load('traffic_load');
        if (!t || !t.columns.am_vc) return null;
        const centres = [];
        let step = null;
        for (const code of t.cells) {
            const c = DP.decodePartial(code);
            centres.push([c.lat, c.lng]);
            if (step == null && c.bounds) step = c.bounds.north - c.bounds.south;
        }
        if (step == null) step = 0.0022;
        const codeAt = (lat, lng) => { try { return CS.cellCode(LEVEL, lat, lng); } catch { return null; } };
        return { cells: t.cells, am: t.columns.am_vc, pm: t.columns.pm_vc, mid: t.columns.mid_vc,
            peak: t.columns.peak_vc || [], targets: neighbours(centres, step, codeAt) };
    }

    async function _apply() {
        if (!_on || !_base) return;
        const T = _g('TrafficOverlay'), CS = _g('CellStore'), BD = _g('BuildingData');
        if (!T || !CS || !BD) return;
        const h = T.getHour();
        const cfg = T.config ? T.config() : undefined;
        CS.register(spec(h, h == null ? 'worse peak' : T.hourLabel(h)), tableFor(_base, h, (p, hr) => T.vcAt(p, hr, cfg)));
        if (BD.refresh) await BD.refresh(ID);
        if (BD.get().color !== KEY) await BD.set({ color: KEY, stretch: false });
    }

    /** Colour the buildings by the clock (turning 3D buildings on if needed). */
    async function enable() {
        _on = true;
        _base = await _prepare();
        if (!_base) { _on = false; return false; }
        const T = _g('TrafficOverlay');
        if (T && T.onHour && !_unsubHour) _unsubHour = T.onHour(() => { _apply(); });
        const C = _g('CitySelector');
        if (C && C.onChange && !_unsubCity) _unsubCity = C.onChange(async () => { if (_on) { _base = await _prepare(); _apply(); } });
        await _apply();
        const OB = _g('OvertureBuildings'), M = _g('MapModule');
        const map = M && M.getMap && M.getMap();
        if (OB && !OB.isActive() && map) {
            const btn = typeof document !== 'undefined' && document.getElementById('btn-buildings');
            if (btn) btn.click(); else OB.toggle(map);
        }
        return true;
    }

    /** Back to the colour driver the user had (plain massing). */
    async function disable() {
        _on = false;
        if (_unsubHour) { _unsubHour(); _unsubHour = null; }
        if (_unsubCity) { _unsubCity(); _unsubCity = null; }
        const BD = _g('BuildingData'), CS = _g('CellStore');
        if (BD && BD.get().color === KEY) await BD.set({ color: null });
        if (CS && CS.unregister) CS.unregister(ID);
    }

    function toggle() { return _on ? disable().then(() => false) : enable(); }
    function isOn() { return _on; }

    return { enable, disable, toggle, isOn, neighbours, tableFor, spec, KEY, ID };
})();

if (typeof window !== 'undefined') window.TrafficBuildings = TrafficBuildings;
