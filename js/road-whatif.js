/**
 * RoadWhatIf — close a road, widen one, or add a new link, then re-route the
 * modelled commute and see which roads get worse, which get better and who
 * lives beside them.
 *
 * Data: data/traffic/<region>/whatif_model.json from
 * pipeline/traffic/demand_model.py: the arterial graph (pieces between
 * junctions, free-flow speed, IRC 106 capacity, source feature index), the
 * home → work matrix (daily PCU) and residents near the network.
 *
 * Method (same as the pipeline): the matrix is scaled to the 09:00 hour
 * (or reversed and scaled to 18:00) and loaded in increments
 * (40/30/20/10 %) by all-or-nothing shortest paths, re-timing links with the
 * BPR curve between increments. The baseline and the scenario run the same
 * code, so the difference isolates the edit. Runs in a Web Worker built from
 * `core` below; `core` is also used directly by the unit tests.
 *
 * Honest framing: destination choice is held fixed (people still go to the
 * same jobs), so this is the first-week effect of a change, not the
 * long-run one. docs/TRAFFIC_MODEL.md
 */
const RoadWhatIf = (() => {
    /** Self-contained routing engine (no globals) so it can run in a Worker. */
    function core() {
        /** Graph over model pieces with edits applied. */
        function build(model, edits = {}) {
            const P = model.pieces, np = P.a.length;
            const closed = new Set((edits.closed || []).map(Number));
            const widened = new Map(Object.entries(edits.widened || {}).map(([k, v]) => [Number(k), Number(v)]));
            const added = edits.added || [];
            const nNodes = model.nodes.length / 2;
            const nl = 2 * np + 2 * added.length;
            const tail = new Int32Array(nl), head = new Int32Array(nl), feat = new Int32Array(nl);
            const len = new Float64Array(nl), t0 = new Float64Array(nl), cap = new Float64Array(nl);
            const open = new Uint8Array(nl);
            const put = (e, a, b, l, ffs, c, f, ok) => {
                tail[e] = a; head[e] = b; len[e] = l; t0[e] = l / 1000 / Math.max(ffs, 1) * 60;
                cap[e] = c; feat[e] = f; open[e] = ok ? 1 : 0;
            };
            for (let i = 0; i < np; i++) {
                const f = P.f[i], ok = !closed.has(f), c = P.cap[i] * (widened.get(f) || 1);
                put(2 * i, P.a[i], P.b[i], P.len[i], P.ffs[i], c, f, ok);
                put(2 * i + 1, P.b[i], P.a[i], P.len[i], P.ffs[i], c, f, ok);
            }
            added.forEach((L, k) => {
                const e = 2 * np + 2 * k;
                put(e, L.a, L.b, L.len, L.ffs, L.cap, -1 - k, true);
                put(e + 1, L.b, L.a, L.len, L.ffs, L.cap, -1 - k, true);
            });
            // CSR adjacency over open links.
            const deg = new Int32Array(nNodes + 1);
            for (let e = 0; e < nl; e++) if (open[e]) deg[tail[e] + 1]++;
            for (let i = 0; i < nNodes; i++) deg[i + 1] += deg[i];
            const adj = new Int32Array(deg[nNodes]), fill = deg.slice(0, nNodes);
            for (let e = 0; e < nl; e++) if (open[e]) adj[fill[tail[e]]++] = e;
            return { n: nNodes, nl, np, tail, head, feat, len, t0, cap, open, start: deg, adj };
        }

        /** Dijkstra from ``src`` over link ``times``; stops once every ``targets`` node is settled.
         *  Returns settle order (for reverse accumulation), dist and predecessor link. */
        function makeSearch(g) {
            const dist = new Float64Array(g.n), pred = new Int32Array(g.n), done = new Uint8Array(g.n);
            const order = new Int32Array(g.n), want = new Uint8Array(g.n);
            const hk = new Float64Array(g.nl + 1), hv = new Int32Array(g.nl + 1);
            return function search(src, times, targets) {
                dist.fill(Infinity); pred.fill(-1); done.fill(0);
                let left = 0;
                for (const t of targets) if (!want[t]) { want[t] = 1; left++; }
                let size = 0, nOrder = 0;
                const push = (k, v) => {
                    let i = size++;
                    while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
                    hk[i] = k; hv[i] = v;
                };
                const pop = () => {
                    const v = hv[0], k = hk[--size], x = hv[size];
                    let i = 0;
                    for (;;) {
                        let c = 2 * i + 1;
                        if (c >= size) break;
                        if (c + 1 < size && hk[c + 1] < hk[c]) c++;
                        if (hk[c] >= k) break;
                        hk[i] = hk[c]; hv[i] = hv[c]; i = c;
                    }
                    hk[i] = k; hv[i] = x;
                    return v;
                };
                dist[src] = 0; push(0, src);
                while (size > 0 && left > 0) {
                    const u = pop();
                    if (done[u]) continue;
                    done[u] = 1; order[nOrder++] = u;
                    if (want[u]) { want[u] = 0; left--; }
                    const du = dist[u];
                    for (let q = g.start[u]; q < g.start[u + 1]; q++) {
                        const e = g.adj[q], v = g.head[e], nd = du + times[e];
                        if (nd < dist[v]) { dist[v] = nd; pred[v] = e; push(nd, v); }
                    }
                }
                for (const t of targets) want[t] = 0;
                return { dist, pred, order, nOrder };
            };
        }

        /** Group the sparse matrix by origin zone node: [{node, dest: Int32Array, v: Float64Array}].
         *  The evening ('pm') period reverses every pair (people going home). */
        function rows(model, period) {
            const zn = model.zones.node, od = model.od, by = new Map();
            const pm = period === 'pm';
            let k = 0;
            od.origins.forEach((oz, i) => {
                for (let c = 0; c < od.counts[i]; c++, k++) {
                    const a = zn[oz], b = zn[od.d[k]];
                    const o = pm ? b : a, d = pm ? a : b;
                    if (o === d) continue;
                    let r = by.get(o);
                    if (!r) by.set(o, r = { d: [], v: [] });
                    r.d.push(d); r.v.push(od.v[k]);
                }
            });
            return [...by.entries()].map(([node, r]) => ({ node, dest: Int32Array.from(r.d), v: Float64Array.from(r.v) }));
        }

        /** Incremental assignment of one period. Returns flows, times and trip totals. */
        function assign(g, model, period = 'am', onProgress) {
            const prm = model.params, share = prm.period_share[period] || prm.period_share.am;
            const [A, B] = prm.bpr, inc = prm.increments, acc = prm.access_min || 0;
            const maxSlow = prm.max_slowdown || 4;
            const R = rows(model, period), search = makeSearch(g);
            const flow = new Float64Array(g.nl), times = Float64Array.from(g.t0);
            const demand = new Float64Array(g.n);
            let tripMin = 0, served = 0, unserved = 0;
            const total = R.length * inc.length;
            let doneRows = 0;
            for (const frac of inc) {
                const add = new Float64Array(g.nl);
                for (const r of R) {
                    const s = search(r.node, times, r.dest);
                    const { dist, pred, order, nOrder } = s;
                    for (let k = 0; k < r.dest.length; k++) {
                        const d = r.dest[k], x = r.v[k] * share * frac;
                        if (Number.isFinite(dist[d])) {
                            demand[d] += x; tripMin += x * acc; served += x;
                        } else unserved += x;
                    }
                    for (let q = nOrder - 1; q > 0; q--) {
                        const v = order[q], x = demand[v];
                        if (x === 0) continue;
                        demand[v] = 0;
                        const e = pred[v];
                        add[e] += x; demand[g.tail[e]] += x;
                    }
                    demand[r.node] = 0;
                    if (onProgress && (++doneRows % 64 === 0)) onProgress(doneRows / total);
                }
                for (let e = 0; e < g.nl; e++) {
                    // Trip minutes at the times the increment was routed on (speeds floored).
                    if (add[e] > 0) tripMin += add[e] * Math.min(times[e], g.t0[e] * maxSlow);
                    flow[e] += add[e];
                    times[e] = g.cap[e] > 0 ? g.t0[e] * (1 + A * Math.pow(flow[e] / g.cap[e], B)) : g.t0[e];
                }
            }
            return { flow, times, tripMin, served, unserved };
        }

        /** Max-direction V/C per feature id (added links get negative ids). */
        function featureVC(g, res) {
            const out = new Map();
            for (let e = 0; e < g.nl; e++) {
                if (!g.open[e]) continue;
                const vc = res.flow[e] / g.cap[e], f = g.feat[e];
                if (!(out.get(f) >= vc)) out.set(f, vc);
            }
            return out;
        }

        /** Vehicle-hours in the modelled hour (speeds floored at free-flow ÷ max_slowdown). */
        function vehHours(g, res, maxSlow) {
            let h = 0;
            for (let e = 0; e < g.nl; e++) {
                if (g.open[e] && res.flow[e] > 0) h += res.flow[e] * Math.min(res.times[e], g.t0[e] * maxSlow) / 60;
            }
            return h;
        }

        /** Compare a baseline and a scenario run. Pure. */
        function compare(model, gB, rB, gS, rS, opts = {}) {
            // "Worse" = V/C up by at least 0.1 and now congested (LOS D or beyond).
            const prm = model.params, jam = opts.jam ?? prm.los_bands[3], dWorse = opts.worse ?? 0.1;
            const busy = opts.busy ?? prm.los_bands[2];
            const vB = featureVC(gB, rB), vS = featureVC(gS, rS);
            const roads = [];
            for (const [f, s] of vS) {
                const b = f >= 0 ? (vB.get(f) ?? 0) : 0;
                roads.push({ f, base: b, scen: s, delta: s - b });
            }
            for (const [f, b] of vB) if (!vS.has(f)) roads.push({ f, base: b, scen: null, delta: null, closed: true });
            const worse = roads.filter(r => r.delta != null && r.delta >= dWorse && r.scen > busy);
            const better = roads.filter(r => r.delta != null && r.delta <= -dWorse && r.base > busy);
            const newlyJammed = worse.filter(r => r.base < jam && r.scen >= jam);
            // Residents within 250 m of a road that got worse (piece midpoints).
            const near = new Set();
            const pc = model.pop_cells || [], N = model.nodes;
            const worseF = new Set(worse.map(r => r.f));
            let affected = 0;
            if (pc.length && worseF.size) {
                const G = 0.0025, grid = new Map();
                for (let i = 0; i < pc.length; i += 3) {
                    const key = `${Math.floor(pc[i] / G)},${Math.floor(pc[i + 1] / G)}`;
                    let a = grid.get(key); if (!a) grid.set(key, a = []); a.push(i);
                }
                const P = model.pieces, k = Math.cos(((N[1] || 22) * Math.PI) / 180);
                const visit = (x, y) => {
                    const gx = Math.floor(x / G), gy = Math.floor(y / G);
                    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                        for (const i of grid.get(`${gx + dx},${gy + dy}`) || []) {
                            if (near.has(i)) continue;
                            const ddx = (pc[i] - x) * k * 111320, ddy = (pc[i + 1] - y) * 111320;
                            if (ddx * ddx + ddy * ddy <= 250 * 250) { near.add(i); affected += pc[i + 2]; }
                        }
                    }
                };
                for (let i = 0; i < P.a.length; i++) {
                    if (!worseF.has(P.f[i])) continue;
                    const a = P.a[i], b = P.b[i];
                    visit((N[2 * a] + N[2 * b]) / 2, (N[2 * a + 1] + N[2 * b + 1]) / 2);
                }
            }
            const ms = prm.max_slowdown || 4;
            const hB = vehHours(gB, rB, ms), hS = vehHours(gS, rS, ms);
            return {
                roads, worse: worse.length, better: better.length, newlyJammed: newlyJammed.length,
                residentsNearWorse: Math.round(affected),
                vehHours: { base: hB, scen: hS, delta: hS - hB },
                tripMin: { base: rB.served ? rB.tripMin / rB.served : null, scen: rS.served ? rS.tripMin / rS.served : null },
                unservedPcu: rS.unserved - rB.unserved,
            };
        }

        /** Nearest graph node to a point (km-scaled); returns {node, m}. */
        function nearestNode(model, lon, lat) {
            const N = model.nodes, k = Math.cos((lat * Math.PI) / 180);
            let best = Infinity, bi = -1;
            for (let i = 0; i < N.length; i += 2) {
                const dx = (N[i] - lon) * k, dy = N[i + 1] - lat, d = dx * dx + dy * dy;
                if (d < best) { best = d; bi = i / 2; }
            }
            return { node: bi, m: Math.sqrt(best) * 111320 };
        }

        /** A new two-way link between nodes a and b with the model's "new road" class. */
        function newLink(model, a, b, detour = 1.1) {
            const N = model.nodes, nr = model.params.new_road;
            const k = Math.cos((N[2 * a + 1] * Math.PI) / 180);
            const dx = (N[2 * a] - N[2 * b]) * k * 111320, dy = (N[2 * a + 1] - N[2 * b + 1]) * 111320;
            return { a, b, len: Math.max(20, Math.hypot(dx, dy) * detour), ffs: nr.ffs, cap: nr.cap };
        }

        /** Full run: baseline (cached by caller) + scenario + comparison. */
        function run(model, period, edits, base, onProgress) {
            const gB = base ? base.g : build(model, {});
            const rB = base ? base.r : assign(gB, model, period, onProgress && (p => onProgress(p / 2)));
            const gS = build(model, edits);
            const rS = assign(gS, model, period, onProgress && (p => onProgress(base ? p : 0.5 + p / 2)));
            return { base: { g: gB, r: rB }, result: compare(model, gB, rB, gS, rS) };
        }

        return { build, makeSearch, rows, assign, featureVC, vehHours, compare, nearestNode, newLink, run };
    }

    const C = core();
    let _worker = null, _seq = 0;
    const _pending = new Map();

    /** Worker that keeps the model + baseline per (region, period) and runs scenarios. */
    function _getWorker() {
        if (_worker || typeof Worker === 'undefined' || typeof Blob === 'undefined') return _worker;
        const src = `const C=(${core.toString()})();const M=new Map(),B=new Map();
onmessage=async(ev)=>{const{id,region,period,edits,url}=ev.data;try{
let m=M.get(region);if(!m){const r=await fetch(url,{cache:'force-cache'});if(!r.ok)throw new Error('no what-if model for this city ('+r.status+')');m=await r.json();M.set(region,m);}
const key=region+'|'+period;const prog=(p)=>postMessage({id,progress:p});
const out=C.run(m,period,edits||{},B.get(key),prog);B.set(key,out.base);
const res=out.result;postMessage({id,result:res});}catch(e){postMessage({id,error:String(e&&e.message||e)});}};`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        _worker = new Worker(url);
        _worker.onmessage = (ev) => {
            const { id, progress, result, error } = ev.data || {};
            const p = _pending.get(id);
            if (!p) return;
            if (progress != null) { if (p.onProgress) p.onProgress(progress); return; }
            _pending.delete(id);
            if (error) p.reject(new Error(error)); else p.resolve(result);
        };
        return _worker;
    }

    /** whatif_model.json URL for a region. */
    function modelUrl(region) {
        return new URL(`./data/traffic/${region}/whatif_model.json`,
            (typeof location !== 'undefined' && location.href) || 'http://localhost/').href;
    }

    /** Run a scenario. edits: {closed: [featureIdx], widened: {featureIdx: factor}, added: [{a,b,len,ffs,cap}]}. */
    function run(region, period, edits, onProgress) {
        const w = _getWorker();
        if (!w) return Promise.reject(new Error('Web Workers unavailable'));
        const id = ++_seq;
        return new Promise((resolve, reject) => {
            _pending.set(id, { resolve, reject, onProgress });
            w.postMessage({ id, region, period, edits, url: modelUrl(region) });
        });
    }

    let _models = new Map();
    /** Load (and cache) the model on the main thread, for snapping clicks to nodes. */
    async function loadModel(region) {
        if (_models.has(region)) return _models.get(region);
        const r = await fetch(modelUrl(region), { cache: 'force-cache' });
        if (!r.ok) throw new Error(`no what-if model for this city (${r.status})`);
        const m = await r.json();
        _models = new Map([[region, m]]);       // keep one city in memory
        return m;
    }

    // ───────────────────────── panel + map interaction ─────────────────────────
    const PANEL_ID = 'road-whatif';
    const SRC = 'road-whatif-src';
    const L_DIFF = 'road-whatif-diff', L_EDIT = 'road-whatif-edits', L_PT = 'road-whatif-pts';
    const ROAD_LAYER = 'traffic-overlay-line';
    const WIDEN = 1.5;                 // one more lane each way on a 4-lane road
    // Monsoon levels: which roads slow (capacity factor) or close, from the road_flood.py flags.
    // tiers: [highest waterlogging index along the road ≥ min, capacity factor (0 = closed)].
    const MONSOON = {
        heavy: { label: 'Heavy shower', tiers: [[65, 0.5], [60, 0.75]], river: null },
        severe: { label: 'Severe waterlogging', tiers: [[65, 0], [60, 0.5], [55, 0.75]], river: null },
        extreme: { label: 'River flood (1-in-100-year)', tiers: [[65, 0], [60, 0.5], [55, 0.75]], river: 0.25 },
    };
    /** V/C for display: overloaded links read "3+" rather than a spurious 26.7. Pure. */
    function fmtVC(v) { return v == null ? '–' : v >= 3 ? '3+' : v.toFixed(2); }
    const S = { open: false, tool: null, period: 'am', closed: [], widened: [], slowed: {}, monsoon: null, added: [], pending: null,
        region: null, roads: null, model: null, result: null, running: false, progress: 0, error: null };

    /** Colour for a V/C change (worse = reds, better = blues), null when too small to show. */
    function diffColor(delta) {
        if (delta == null || !Number.isFinite(delta)) return null;
        if (delta >= 0.3) return '#b30000';
        if (delta >= 0.1) return '#ef6548';
        if (delta <= -0.3) return '#08519c';
        if (delta <= -0.1) return '#6baed6';
        return null;
    }
    /** The edits object the engine takes, from the panel state. Pure. */
    function editsFrom(st) {
        const widened = {};
        for (const f of st.widened) widened[f] = WIDEN;
        for (const [f, k] of Object.entries(st.slowed || {})) widened[f] = k;
        return { closed: st.closed.slice(), widened, added: st.added.map(a => a.link) };
    }
    /** One-line plain-language summary of a comparison. Pure. */
    function headline(res, period) {
        if (!res) return '';
        const when = period === 'pm' ? 'evening peak (18:00)' : 'morning peak (09:00)';
        const f = (n) => Math.round(n).toLocaleString('en-IN');
        if (res.unservedPcu > 1) {
            return `This cuts off about ${f(res.unservedPcu)} vehicle trips in the ${when}: some homes lose their only arterial route.`;
        }
        const d = res.tripMin.scen != null && res.tripMin.base != null ? res.tripMin.scen - res.tripMin.base : 0;
        const pct = res.vehHours.base ? 100 * res.vehHours.delta / res.vehHours.base : 0;
        const dir = pct >= 0.5 ? 'more' : pct <= -0.5 ? 'less' : null;
        return (dir ? `${Math.abs(pct).toFixed(1)}% ${dir} time spent driving in the ${when}` : `Little change in total driving time in the ${when}`)
            + (Math.abs(d) >= 0.05 ? ` (average trip ${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} min)` : '')
            + `. ${res.worse} roads get busier, ${res.better} get quieter`
            + (res.residentsNearWorse ? `; ${f(res.residentsNearWorse)} people live within 250 m of a road that gets worse.` : '.');
    }

    function _g(n) { return (typeof window !== 'undefined' && window[n]) || (typeof globalThis !== 'undefined' && globalThis[n]) || undefined; }
    // MapModule / CitySelector are script-scope consts, not window properties.
    function _map() { return typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null; }
    function _region() {
        const T = _g('TrafficOverlay');
        if (T && T.region) return T.region();
        try {
            const a = typeof CitySelector !== 'undefined' && CitySelector.currentArea && CitySelector.currentArea();
            if (a && a.region) return a.region;
        } catch { /* selector not ready */ }
        return 'indore_pilot';
    }
    function _esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function _pal() {
        const T = _g('Theme');
        if (T && T.palette) return T.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8', surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }
    function _roadName(f) {
        if (f < 0) return `New link ${-f}`;
        const p = (S.roads && S.roads[f] && S.roads[f].properties) || {};
        return p.name || (p.highway ? `Unnamed ${String(p.highway).replace('_link', ' link')} road` : `Road ${f}`);
    }

    /** Is the panel waiting for a map click (so other click handlers can stand down)? */
    function isPicking() { return S.open && !!S.tool; }

    async function _ensureData() {
        const region = _region();
        if (S.region === region && S.roads && S.model) return;
        S.region = region; S.roads = null; S.model = null;
        _reset(false);
        const T = _g('TrafficOverlay');
        const [gj, model] = await Promise.all([
            fetch(T && T.geojsonUrl ? T.geojsonUrl(region) : `./data/traffic/${region}/road_los.geojson`, { cache: 'force-cache' })
                .then(r => (r.ok ? r.json() : null)),
            loadModel(region),
        ]);
        if (S.region !== region) return;
        S.roads = gj ? gj.features : [];
        S.model = model;
    }

    /** Open the what-if panel (turns the Traffic layer on). */
    async function open() {
        const T = _g('TrafficOverlay');
        if (T && !T.isVisible()) T.attach();
        S.open = true; S.error = null;
        _render();
        _bindMap();
        try { await _ensureData(); } catch (e) { S.error = e.message || String(e); }
        _render();
    }
    /** Close the panel and clear its layers. */
    function close() {
        S.open = false; S.tool = null; S.pending = null;
        const el = typeof document !== 'undefined' && document.getElementById(PANEL_ID);
        if (el) el.remove();
        _clearLayers();
        _dimRoads(false);
        _unbindMap();
    }
    function toggle() { if (S.open) close(); else open(); }
    function _reset(render = true) {
        S.closed = []; S.widened = []; S.slowed = {}; S.monsoon = null; S.added = []; S.pending = null; S.result = null; S.error = null;
        _clearLayers(); _dimRoads(false);
        if (render) _render();
    }

    let _bound = null;
    function _bindMap() {
        const map = _map();
        if (!map || _bound) return;
        _bound = (e) => _onMapClick(e);
        map.on('click', _bound);
    }
    function _unbindMap() {
        const map = _map();
        if (map && _bound) map.off('click', _bound);
        _bound = null;
        if (map) map.getCanvas().style.cursor = '';
    }

    function _onMapClick(e) {
        if (!S.open || !S.tool || S.running) return;
        const map = _map();
        if (S.tool === 'close' || S.tool === 'widen') {
            const hits = map.getLayer(ROAD_LAYER) ? map.queryRenderedFeatures(e.point, { layers: [ROAD_LAYER] }) : [];
            const fi = hits.length ? Number(hits[0].properties.fi) : NaN;
            if (!Number.isInteger(fi)) return;
            const list = S.tool === 'close' ? S.closed : S.widened;
            const other = S.tool === 'close' ? S.widened : S.closed;
            const i = list.indexOf(fi);
            if (i >= 0) list.splice(i, 1); else { list.push(fi); const j = other.indexOf(fi); if (j >= 0) other.splice(j, 1); }
        } else if (S.tool === 'add' && S.model) {
            const nn = C.nearestNode(S.model, e.lngLat.lng, e.lngLat.lat);
            if (nn.node < 0 || nn.m > 400) return;
            if (S.pending == null) S.pending = nn.node;
            else if (nn.node !== S.pending) {
                S.added.push({ link: C.newLink(S.model, S.pending, nn.node) });
                S.pending = null;
            }
        }
        S.result = null;
        _drawEdits();
        _render();
    }

    /** Run baseline (cached in the worker) + scenario and paint the result. */
    async function runScenario() {
        if (S.running) return null;
        if (!S.closed.length && !S.widened.length && !S.added.length && !Object.keys(S.slowed).length) {
            S.error = 'Close, widen or add a road first.'; _render(); return null;
        }
        S.running = true; S.progress = 0; S.error = null; S.tool = null; _render();
        try {
            await _ensureData();
            const res = await run(S.region, S.period, editsFrom(S), (p) => { S.progress = p; _syncProgress(); });
            S.result = res;
            _drawResult();
        } catch (e) {
            S.error = e.message || String(e);
        } finally {
            S.running = false;
            _render();
        }
        return S.result;
    }

    function _coordsOf(f) {
        const g = f && f.geometry;
        return !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    }
    function _ensureLayers() {
        const map = _map();
        if (!map) return null;
        if (!map.getSource(SRC)) {
            map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({ id: L_DIFF, type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'diff'],
                layout: { 'line-cap': 'round' },
                paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.95,
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 8] } });
            map.addLayer({ id: L_EDIT, type: 'line', source: SRC, filter: ['in', ['get', 'kind'], ['literal', ['closed', 'widened', 'added', 'slowed']]],
                paint: { 'line-color': ['match', ['get', 'kind'], 'closed', '#111827', 'widened', '#2563eb', 'slowed', '#9ca3af', '#7c3aed'],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 9],
                    'line-dasharray': [1.2, 1] } });
            map.addLayer({ id: L_PT, type: 'circle', source: SRC, filter: ['==', ['get', 'kind'], 'pending'],
                paint: { 'circle-radius': 7, 'circle-color': '#7c3aed', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
        }
        return map;
    }
    function _editFeatures() {
        const out = [];
        const add = (kind, f, extra = {}) => {
            for (const c of _coordsOf(S.roads && S.roads[f])) out.push({ type: 'Feature', properties: { kind, ...extra }, geometry: { type: 'LineString', coordinates: c } });
        };
        S.closed.forEach(f => add('closed', f));
        S.widened.forEach(f => add('widened', f));
        Object.keys(S.slowed).forEach(f => add('slowed', Number(f)));
        const N = S.model && S.model.nodes;
        if (N) {
            for (const a of S.added) {
                out.push({ type: 'Feature', properties: { kind: 'added' }, geometry: { type: 'LineString',
                    coordinates: [[N[2 * a.link.a], N[2 * a.link.a + 1]], [N[2 * a.link.b], N[2 * a.link.b + 1]]] } });
            }
            if (S.pending != null) {
                out.push({ type: 'Feature', properties: { kind: 'pending' }, geometry: { type: 'Point', coordinates: [N[2 * S.pending], N[2 * S.pending + 1]] } });
            }
        }
        return out;
    }
    function _drawEdits() {
        const map = _ensureLayers();
        if (map) map.getSource(SRC).setData({ type: 'FeatureCollection', features: _editFeatures() });
    }
    function _drawResult() {
        const map = _ensureLayers();
        if (!map || !S.result) return;
        const feats = _editFeatures();
        for (const r of S.result.roads) {
            const col = r.f >= 0 && !r.closed ? diffColor(r.delta) : null;
            if (!col) continue;
            for (const c of _coordsOf(S.roads[r.f])) {
                feats.push({ type: 'Feature', properties: { kind: 'diff', color: col, delta: Math.round(r.delta * 100) / 100 },
                    geometry: { type: 'LineString', coordinates: c } });
            }
        }
        map.getSource(SRC).setData({ type: 'FeatureCollection', features: feats });
        _dimRoads(true);
    }
    function _dimRoads(on) {
        const map = _map();
        if (map && map.getLayer && map.getLayer(ROAD_LAYER)) map.setPaintProperty(ROAD_LAYER, 'line-opacity', on ? 0.25 : 0.85);
    }
    function _clearLayers() {
        const map = _map();
        if (!map || !map.getLayer) return;
        for (const id of [L_PT, L_EDIT, L_DIFF]) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SRC)) map.removeSource(SRC);
    }

    const HINT = {
        close: 'Click a road to close it (click again to reopen).',
        widen: 'Click a road to add a lane each way (+50% capacity).',
        add: 'Click two junctions to build a new 4-lane link between them.',
    };
    function _syncProgress() {
        const el = typeof document !== 'undefined' && document.querySelector(`#${PANEL_ID} [data-rw="bar"]`);
        if (el) el.style.width = `${Math.round(100 * S.progress)}%`;
    }
    function _render() {
        if (typeof document === 'undefined' || !S.open) return;
        let el = document.getElementById(PANEL_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = PANEL_ID;
            el.setAttribute('role', 'dialog');
            el.setAttribute('aria-label', 'Road what-if');
            document.body.appendChild(el);
            el.addEventListener('click', _onPanelClick);
        }
        const pal = _pal();
        const btn = (on) => `background:${on ? pal.primary : 'transparent'};color:${on ? pal.surface : pal.ink};border:1px solid ${on ? pal.primary : pal.border};`
            + 'border-radius:6px;padding:3px 8px;font:12px system-ui,sans-serif;cursor:pointer;';
        el.style.cssText = `position:absolute;bottom:24px;left:372px;z-index:6;width:300px;max-height:70vh;overflow:auto;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:12px 14px;color:${pal.ink};`
            + 'font:12px/1.45 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const nSlow = Object.keys(S.slowed).length;
        const edits = S.monsoon ? [] : [
            ...S.closed.map(f => ['closed', f, `Closed: ${_roadName(f)}`]),
            ...S.widened.map(f => ['widened', f, `Widened: ${_roadName(f)}`]),
            ...S.added.map((a, i) => ['added', i, `New link (${(a.link.len / 1000).toFixed(1)} km)`]),
        ];
        let html = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">`
            + `<strong style="font-size:14px;color:${pal.primary};">Road what-if</strong>`
            + `<button type="button" data-rw="close" aria-label="Close what-if" style="${btn(false)}">✕</button></div>`
            + `<div style="display:flex;gap:4px;margin-bottom:6px;">`
            + `<button type="button" data-rw="period" data-v="am" aria-pressed="${S.period === 'am'}" style="${btn(S.period === 'am')}">Morning 09:00</button>`
            + `<button type="button" data-rw="period" data-v="pm" aria-pressed="${S.period === 'pm'}" style="${btn(S.period === 'pm')}">Evening 18:00</button></div>`
            + `<div style="display:flex;gap:4px;flex-wrap:wrap;">`
            + ['close', 'widen', 'add'].map(t => `<button type="button" data-rw="tool" data-v="${t}" aria-pressed="${S.tool === t}" style="${btn(S.tool === t)}">${{ close: 'Close a road', widen: 'Widen a road', add: 'Add a link' }[t]}</button>`).join('')
            + `</div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">`
            + Object.entries(MONSOON).map(([k, m]) => `<button type="button" data-rw="monsoon" data-v="${k}" aria-pressed="${S.monsoon === k}" style="${btn(S.monsoon === k)}">🌧 ${_esc(m.label)}</button>`).join('')
            + `</div>`
            + (S.monsoon ? `<div style="margin-top:6px;">${_esc(MONSOON[S.monsoon].label)}: ${S.closed.length} road segments closed, ${nSlow} slowed (waterlogging-prone).</div>` : '')
            + (S.tool ? `<div style="margin-top:6px;color:${pal.sub};">${HINT[S.tool]}${S.tool === 'add' && S.pending != null ? ' Now click the second junction.' : ''}</div>` : '')
            + (!S.model && !S.error ? `<div style="margin-top:6px;color:${pal.sub};">Loading the road model…</div>` : '');
        if (edits.length) {
            html += `<div style="margin-top:8px;">` + edits.map(([k, i, label]) => `<div style="display:flex;justify-content:space-between;gap:6px;">`
                + `<span>${_esc(label)}</span><button type="button" data-rw="undo" data-k="${k}" data-i="${i}" aria-label="Remove ${_esc(label)}" style="${btn(false)}padding:0 6px;">✕</button></div>`).join('') + `</div>`;
        }
        html += `<div style="display:flex;gap:6px;margin-top:8px;">`
            + `<button type="button" data-rw="run" ${S.running ? 'disabled' : ''} style="${btn(true)}">${S.running ? 'Re-routing…' : 'Run'}</button>`
            + `<button type="button" data-rw="reset" style="${btn(false)}">Reset</button></div>`;
        if (S.running) {
            html += `<div style="margin-top:6px;height:4px;background:${pal.border};border-radius:2px;overflow:hidden;">`
                + `<div data-rw="bar" style="height:100%;width:${Math.round(100 * S.progress)}%;background:${pal.primary};"></div></div>`
                + `<div style="color:${pal.sub};margin-top:2px;">Routing every commute twice (before and after); big cities take ~15 s the first time.</div>`;
        }
        if (S.error) html += `<div role="alert" style="margin-top:6px;color:#ef4444;">${_esc(S.error)}</div>`;
        const R = S.result;
        if (R) {
            // One line per road name (a named road is often several features).
            const top = (arr) => {
                const seen = new Set(), rowsOut = [];
                for (const r of arr) {
                    const nm = _roadName(r.f);
                    if (seen.has(nm)) continue;
                    seen.add(nm);
                    rowsOut.push(`<div>${_esc(nm)}: V/C ${fmtVC(r.base)} → ${fmtVC(r.scen)}</div>`);
                    if (rowsOut.length === 5) break;
                }
                return rowsOut.join('');
            };
            const worse = R.roads.filter(r => r.delta != null && r.f >= 0 && r.delta >= 0.1).sort((a, b) => b.delta - a.delta);
            const better = R.roads.filter(r => r.delta != null && r.f >= 0 && r.delta <= -0.1).sort((a, b) => a.delta - b.delta);
            html += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid ${pal.border};" aria-live="polite">`
                + `<div style="font-weight:600;">${_esc(headline(R, S.period))}</div>`
                + (R.newlyJammed ? `<div style="margin-top:4px;">${R.newlyJammed} roads tip into LOS E/F.</div>` : '')
                + (worse.length ? `<div style="margin-top:6px;color:${pal.sub};">Busier</div>${top(worse)}` : '')
                + (better.length ? `<div style="margin-top:6px;color:${pal.sub};">Quieter</div>${top(better)}` : '')
                + `<div style="display:flex;gap:8px;margin-top:6px;align-items:center;color:${pal.sub};">`
                + ['#b30000', '#ef6548', '#6baed6', '#08519c'].map((c, i) => `<span style="display:inline-flex;align-items:center;gap:3px;"><span style="width:14px;height:4px;background:${c};border-radius:2px;"></span>${['+0.3', '+0.1', '−0.1', '−0.3'][i]}</span>`).join('')
                + `</div><div style="margin-top:4px;color:${pal.sub};font-size:11px;">Change in volume/capacity. People keep their jobs and destinations; only routes change (the first weeks after the change). Modelled, not counts.</div></div>`;
        }
        el.innerHTML = html;
        const map = _map();
        if (map) map.getCanvas().style.cursor = S.tool ? 'crosshair' : '';
    }
    function _onPanelClick(ev) {
        const b = ev.target.closest && ev.target.closest('[data-rw]');
        if (!b) return;
        const k = b.getAttribute('data-rw'), v = b.getAttribute('data-v');
        if (k === 'close') { close(); return; }
        if (k === 'period') { if (S.period !== v) { S.period = v; S.result = null; _drawEdits(); _dimRoads(false); } }
        if (k === 'tool') { if (S.monsoon) _reset(false); S.tool = S.tool === v ? null : v; S.pending = null; _drawEdits(); }
        if (k === 'undo') {
            const i = Number(b.getAttribute('data-i')), kind = b.getAttribute('data-k');
            if (kind === 'closed') S.closed = S.closed.filter(f => f !== i);
            else if (kind === 'widened') S.widened = S.widened.filter(f => f !== i);
            else S.added.splice(i, 1);
            S.result = null; _drawEdits(); _dimRoads(false);
        }
        if (k === 'monsoon') { setMonsoon(v).then(() => runScenario()); return; }
        if (k === 'reset') { _reset(); return; }
        if (k === 'run') { runScenario(); return; }
        _render();
    }

    /** Programmatic edits (DISHA / tests): {closed, widened, added: [[lon,lat],[lon,lat]]}. */
    async function setEdits({ closed = [], widened = [], added = [], period } = {}) {
        await _ensureData();
        if (period) S.period = period;
        S.closed = closed.map(Number); S.widened = widened.map(Number); S.slowed = {}; S.monsoon = null;
        S.added = added.map(([p, q]) => {
            const a = C.nearestNode(S.model, p[0], p[1]).node, b = C.nearestNode(S.model, q[0], q[1]).node;
            return { link: C.newLink(S.model, a, b) };
        });
        S.result = null; _drawEdits(); _render();
    }
    /** Road-name key for matching ("M.G. Road", "MG Rd" and "mg road" agree). Pure. */
    function normRoad(name) {
        return String(name || '').toLowerCase()
            .replace(/\brd\b\.?/g, 'road')
            .replace(/[^a-z0-9]/g, '');
    }
    /** Feature indexes whose name matches ``q`` (exact key first, else containment). Pure over features. */
    function matchRoads(features, q) {
        const k = normRoad(q);
        if (k.length < 3) return [];
        const exact = [], part = [];
        (features || []).forEach((f, i) => {
            const n = f && f.properties && f.properties.name;
            if (!n) return;
            const kn = normRoad(n);
            if (kn === k) exact.push(i);
            else if (kn.includes(k) || (kn.length >= 5 && k.includes(kn))) part.push(i);
        });
        return exact.length ? exact : part;
    }
    /** Feature indexes whose road name matches ``q``. */
    async function findRoads(q) {
        await _ensureData();
        return matchRoads(S.roads, q);
    }

    /** Busier / quieter road names from a result, one line per name. Pure given a namer. */
    function topRoads(res, namer, n = 5) {
        const pick = (arr) => {
            const seen = new Set(), out = [];
            for (const r of arr) {
                const nm = namer(r.f);
                if (seen.has(nm)) continue;
                seen.add(nm);
                out.push({ name: nm, base: r.base, scen: r.scen });
                if (out.length === n) break;
            }
            return out;
        };
        const ok = res.roads.filter(r => r.delta != null && r.f >= 0);
        return {
            worse: pick(ok.filter(r => r.delta >= 0.1).sort((a, b) => b.delta - a.delta)),
            better: pick(ok.filter(r => r.delta <= -0.1).sort((a, b) => a.delta - b.delta)),
        };
    }

    /**
     * Chat entry point: close or widen a named road for a peak and run it.
     * Returns { ok, road, matched, headline, worse, better, result } or { ok:false, error }.
     */
    async function ask({ action = 'close', road, period = 'am' } = {}) {
        await open();
        await _ensureData();
        const fs = matchRoads(S.roads, road);
        if (!fs.length) return { ok: false, error: `No modelled arterial named “${road}” in this city.` };
        _reset(false);
        S.period = period === 'pm' ? 'pm' : 'am';
        if (action === 'widen') S.widened = fs; else S.closed = fs;
        _drawEdits(); _render();
        const res = await runScenario();
        if (!res) return { ok: false, error: S.error || 'The what-if did not run.' };
        const named = S.roads[fs[0]].properties.name;
        const t = topRoads(res, _roadName);
        return { ok: true, road: named, matched: fs.length, action, period: S.period, headline: headline(res, S.period), ...t, result: res };
    }
    /** Plain text of an ask() answer, for DISHA. Pure. */
    function askText(a) {
        if (!a || !a.ok) return (a && a.error) || 'The road what-if did not run.';
        const line = (r) => `${r.name} (V/C ${fmtVC(r.base)} → ${fmtVC(r.scen)})`;
        const lead = a.monsoon
            ? `${a.label}: ${a.closedN} waterlogging-prone road segments closed and ${a.slowedN} slowed`
            : `${a.action === 'widen' ? 'Widening' : 'Closing'} ${a.road} (${a.matched} segment${a.matched === 1 ? '' : 's'})`;
        return `${lead}, ${a.period === 'pm' ? '18:00' : '09:00'} peak: ${a.headline}`
            + (a.result && a.result.newlyJammed ? ` ${a.result.newlyJammed} roads tip into LOS E/F.` : '')
            + (a.worse.length ? `\nBusier: ${a.worse.map(line).join('; ')}.` : '')
            + (a.better.length ? `\nQuieter: ${a.better.map(line).join('; ')}.` : '')
            + '\nModelled re-routing of the commute (destinations fixed), shown on the map in red (busier) and blue (quieter).';
    }
    /**
     * Which features a monsoon level slows or closes, from road_flood.py's
     * wlog (highest waterlogging index along the road) and fl100 (in the
     * 1-in-100-year river flood) flags. The lowest factor that applies wins.
     * Returns { closed: [f], slowed: {f: capacity factor} }. Pure.
     */
    function monsoonEdits(features, level = 'severe') {
        const m = MONSOON[level] || MONSOON.severe, closed = [], slowed = {};
        (features || []).forEach((ft, i) => {
            const p = (ft && ft.properties) || {};
            let k = null;
            for (const [min, f] of m.tiers) if (p.wlog >= min) { k = f; break; }
            if (m.river != null && p.fl100) k = k == null ? m.river : Math.min(k, m.river);
            if (k == null) return;
            if (k === 0) closed.push(i); else slowed[i] = k;
        });
        return { closed, slowed };
    }
    async function setMonsoon(level = 'severe', period) {
        await open();
        await _ensureData();
        _reset(false);
        if (period) S.period = period === 'pm' ? 'pm' : 'am';
        const e = monsoonEdits(S.roads, level);
        S.monsoon = MONSOON[level] ? level : 'severe';
        S.closed = e.closed; S.slowed = e.slowed;
        _drawEdits(); _render();
        return e;
    }
    /** Chat entry point: a monsoon level at a peak. Same shape as ask(). */
    async function monsoon({ level = 'severe', period = 'am' } = {}) {
        const e = await setMonsoon(level, period);
        if (!e.closed.length && !Object.keys(e.slowed).length) {
            return { ok: false, error: 'No modelled road here is flagged as waterlogging-prone (road_flood.py has not run for this city).' };
        }
        const res = await runScenario();
        if (!res) return { ok: false, error: S.error || 'The what-if did not run.' };
        const t = topRoads(res, _roadName);
        return { ok: true, monsoon: S.monsoon, label: MONSOON[S.monsoon].label, closedN: e.closed.length, slowedN: Object.keys(e.slowed).length,
            period: S.period, headline: headline(res, S.period), ...t, result: res };
    }
    function state() { return { ...S, roads: undefined, model: undefined }; }

    return { core: C, run, loadModel, modelUrl, nearestNode: C.nearestNode, newLink: C.newLink,
        open, close, toggle, isPicking, runScenario, setEdits, findRoads, state, diffColor, editsFrom, headline,
        normRoad, matchRoads, topRoads, ask, askText, monsoon, monsoonEdits, setMonsoon, fmtVC, MONSOON };
})();

if (typeof window !== 'undefined') window.RoadWhatIf = RoadWhatIf;
