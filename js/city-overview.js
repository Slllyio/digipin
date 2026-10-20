/**
 * CityOverview — the "landing" ribbon for the selected city: its name, the
 * headline numbers we actually hold for it, a livability distribution
 * sparkline, and a one-tap cinematic 3D fly-in.
 *
 * Every number is computed from files already in the repo, never invented:
 *   - data/scores/coverage.json + <region>/<shard>.json  → scored level-6
 *     cells (~244 m) and mean scores over the city's *core* cells (non-zero
 *     walkability, i.e. amenities within walking reach — the tile's bbox
 *     takes in farmland and outskirts that would drag every mean to ~0);
 *   - data/heights/index.json → building-height grid cells (DIGIPIN L8) and
 *     the baked footprint extent.
 * Cities with neither file just show their name and the live-fetch note.
 *
 * Yields (fades out) while the cell detail panel or query results are open,
 * collapses to a chip on demand, and remembers that per browser.
 */
const CityOverview = (() => {
    const COLLAPSE_KEY = 'digipin_overview_collapsed';
    const KPIS = [
        { id: 'livability', label: 'Livability' },
        { id: 'walkability', label: 'Walkability' },
        { id: 'green', label: 'Green cover' },
        { id: 'flood_risk', label: 'Flood risk', invert: true },
    ];
    // Region aliases mirror CitySelector (indore → indore_pilot).
    const _regionOf = (city) => (typeof CitySelector !== 'undefined' && CitySelector.regionName)
        ? CitySelector.regionName(city) : city.id;

    let _el = null;
    let _heightsIndex = null;     // Promise<array>
    const _statsCache = new Map(); // region → Promise<stats|null>
    let _orbitRaf = null;

    // ── pure helpers (unit-tested) ──────────────────────────────────────────

    /** Area of a lon/lat bbox in km² (equirectangular; fine at city scale). */
    function bboxAreaKm2(b) {
        if (!b) return 0;
        const [w, s, e, n] = Array.isArray(b) ? b : [b.west, b.south, b.east, b.north];
        if (![w, s, e, n].every(Number.isFinite) || e <= w || n <= s) return 0;
        const midLat = ((s + n) / 2) * Math.PI / 180;
        const kmPerDeg = 111.32;
        return (e - w) * kmPerDeg * Math.cos(midLat) * (n - s) * kmPerDeg;
    }

    /**
     * Summarise score shards. `shards` is an array of {code: values[]} objects
     * and `fields` the coverage field order. Returns counts, core-cell means
     * per field, and a 10-bin livability histogram over core cells.
     */
    function summarise(shards, fields) {
        const idx = Object.fromEntries((fields || []).map((f, i) => [f, i]));
        const coreIdx = idx.walkability;
        let cells = 0, core = 0;
        const sums = {};
        const hist = new Array(10).fill(0);
        for (const shard of shards || []) {
            for (const values of Object.values(shard || {})) {
                if (!Array.isArray(values)) continue;
                cells++;
                if (!(values[coreIdx] > 0)) continue;
                core++;
                for (const f of Object.keys(idx)) {
                    const v = values[idx[f]];
                    if (Number.isFinite(v)) sums[f] = (sums[f] || 0) + v;
                }
                const liv = values[idx.livability];
                if (Number.isFinite(liv)) hist[Math.min(9, Math.max(0, Math.floor(liv / 10)))]++;
            }
        }
        const means = {};
        for (const [f, s] of Object.entries(sums)) means[f] = core ? s / core : null;
        return { cells, core, means, hist };
    }

    /** Compact number: 1234 → "1.2k", 210698 → "211k". */
    function fmtCount(n) {
        if (!Number.isFinite(n)) return '—';
        if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
        if (n >= 1e4) return Math.round(n / 1e3) + 'k';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
        return String(Math.round(n));
    }

    /** SVG bar sparkline for a histogram (theme colour via currentColor). */
    function histogramSvg(hist, w = 120, h = 32) {
        const max = Math.max(1, ...(hist || []));
        const n = (hist || []).length || 1;
        const bw = w / n;
        const bars = (hist || []).map((v, i) => {
            const bh = Math.max(1, (v / max) * (h - 2));
            return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" opacity="${(0.35 + 0.65 * (i + 1) / n).toFixed(2)}"/>`;
        }).join('');
        return `<svg class="co-hist" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="currentColor" role="img" aria-label="Livability distribution across core cells, 0 to 100">${bars}</svg>`;
    }

    // ── data ────────────────────────────────────────────────────────────────

    function _heights() {
        if (!_heightsIndex) {
            _heightsIndex = fetch('data/heights/index.json')
                .then(r => r.ok ? r.json() : [])
                .catch(() => []);
        }
        return _heightsIndex;
    }

    function _scoreStats(regionName) {
        if (_statsCache.has(regionName)) return _statsCache.get(regionName);
        const p = (async () => {
            const regions = (typeof PrecomputedScores !== 'undefined' && PrecomputedScores.getRegions)
                ? PrecomputedScores.getRegions() : [];
            const region = regions.find(r => r.name === regionName);
            if (!region) return null;
            let fields = null;
            try {
                const cov = await fetch('data/scores/coverage.json').then(r => r.json());
                fields = cov.fields;
            } catch { return null; }
            const base = region.path || `data/scores/${region.name}/`;
            const shards = await Promise.all((region.shards || []).map(s =>
                fetch(`${base}${s}.json`).then(r => r.ok ? r.json() : {}).catch(() => ({}))));
            return { ...summarise(shards, fields), bbox: region.bbox, level: region.level };
        })();
        _statsCache.set(regionName, p);
        return p;
    }

    // ── render ──────────────────────────────────────────────────────────────

    const _esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const _ic = (n, s) => (typeof UIPolish !== 'undefined' ? UIPolish.icon(n, s) : '');

    function _kpiHtml(k, v) {
        if (!Number.isFinite(v)) return '';
        const val = Math.round(v);
        // Bar fill mirrors "good": for flood risk, lower is better.
        const good = k.invert ? 100 - val : val;
        const tone = good >= 60 ? 'good' : good >= 35 ? 'mid' : 'low';
        return `<div class="co-kpi co-kpi--${tone}">
            <div class="co-kpi-label">${_esc(k.label)}</div>
            <div class="co-kpi-value">${val}<span>/100</span></div>
            <div class="co-kpi-bar"><i style="width:${Math.max(3, val)}%"></i></div>
        </div>`;
    }

    async function render(city) {
        if (!_el || !city) return;
        const region = _regionOf(city);
        _el.querySelector('.co-name').textContent = city.name;
        _el.querySelector('.co-state').textContent = city.state ? `${city.state} · India` : 'India';
        const body = _el.querySelector('.co-body');
        body.innerHTML = '<div class="co-skeleton"></div><div class="co-skeleton"></div><div class="co-skeleton"></div><div class="co-skeleton"></div>';
        const [stats, heights] = await Promise.all([_scoreStats(region), _heights()]);
        // A newer city may have been picked while we were fetching.
        if (CitySelector.getCurrent && CitySelector.getCurrent().id !== city.id) return;
        const h = (heights || []).find(x => x.region === region);
        const facts = [];
        const area = bboxAreaKm2(stats?.bbox || h?.bbox);
        if (area) facts.push(['Area mapped', `${fmtCount(area)} km²`]);
        if (stats) facts.push(['Scored cells', fmtCount(stats.cells)]);
        if (stats && stats.core) facts.push(['Core cells', fmtCount(stats.core)]);
        if (h) facts.push(['Height cells', fmtCount(h.cells)]);
        const factsHtml = facts.map(([l, v]) =>
            `<div class="co-fact"><div class="co-fact-value">${_esc(v)}</div><div class="co-fact-label">${_esc(l)}</div></div>`).join('');
        let kpis = '';
        if (stats && stats.core) {
            kpis = KPIS.map(k => _kpiHtml(k, stats.means[k.id])).join('');
        }
        const hist = stats && stats.core
            ? `<div class="co-dist">${histogramSvg(stats.hist)}<div class="co-dist-label">Livability spread across ${fmtCount(stats.core)} core cells (0–100)</div></div>`
            : '';
        body.innerHTML = `<div class="co-facts">${factsHtml}</div>`
            + (kpis ? `<div class="co-kpis">${kpis}</div>` : '<div class="co-note">Scores load live when you click a cell.</div>')
            + hist;
    }

    // ── camera ──────────────────────────────────────────────────────────────

    function stopOrbit() {
        if (_orbitRaf) cancelAnimationFrame(_orbitRaf);
        _orbitRaf = null;
        _el?.querySelector('[data-co="orbit"]')?.setAttribute('aria-pressed', 'false');
    }

    function startOrbit(map) {
        if (!map || _orbitRaf) return;
        let last = performance.now();
        const step = (t) => {
            const dt = Math.min(64, t - last); last = t;
            map.setBearing(map.getBearing() + dt * 0.006); // ~6°/s
            _orbitRaf = requestAnimationFrame(step);
        };
        _orbitRaf = requestAnimationFrame(step);
        _el?.querySelector('[data-co="orbit"]')?.setAttribute('aria-pressed', 'true');
        // Any user gesture hands the camera back.
        const stop = () => { stopOrbit(); ['mousedown', 'touchstart', 'wheel'].forEach(e => map.getCanvas().removeEventListener(e, stop)); };
        ['mousedown', 'touchstart', 'wheel'].forEach(e => map.getCanvas().addEventListener(e, stop, { passive: true }));
    }

    /** Cinematic fly-in: tilt into 3D (buildings + terrain via the 3D button). */
    function flyIn3D() {
        const map = MapModule.getMap && MapModule.getMap();
        const city = CitySelector.getCurrent();
        if (!map || !city) return;
        const btn3d = document.getElementById('btn-3d');
        if (btn3d && !btn3d.classList.contains('active')) btn3d.click();
        const reduce = typeof UIPolish !== 'undefined' && UIPolish.prefersReducedMotion();
        const cam = { center: [city.lng, city.lat], zoom: 15.8, pitch: 68, bearing: -28 };
        // Step aside so the city is the hero; the chip brings the card back.
        _setCollapsed(true, false);
        if (reduce) map.jumpTo(cam);
        else map.flyTo({ ...cam, duration: 4200, curve: 1.6, essential: false });
    }

    function _setCollapsed(on, persist = true) {
        if (!_el) return;
        _el.classList.toggle('is-collapsed', on);
        const t = _el.querySelector('[data-co="toggle"]');
        if (t) {
            t.setAttribute('aria-expanded', String(!on));
            t.setAttribute('aria-label', on ? 'Show city overview' : 'Hide city overview');
            t.innerHTML = _ic(on ? 'chevronRight' : 'close', 14);
        }
        if (persist) { try { localStorage.setItem(COLLAPSE_KEY, on ? '1' : '0'); } catch { /* blocked */ } }
    }

    function _watchYield() {
        const targets = ['detail-panel', 'results-panel'].map(id => document.getElementById(id)).filter(Boolean);
        const sync = () => {
            const busy = targets.some(t => t.classList.contains('open'));
            _el.classList.toggle('is-yielding', busy);
        };
        const mo = new MutationObserver(sync);
        targets.forEach(t => mo.observe(t, { attributes: true, attributeFilter: ['class'] }));
        sync();
    }

    function init() {
        if (typeof document === 'undefined' || typeof CitySelector === 'undefined') return;
        if (document.body.classList.contains('presenting')) return;
        _el = document.createElement('section');
        _el.id = 'city-overview';
        _el.setAttribute('aria-label', 'City overview');
        _el.innerHTML = `
            <header class="co-head">
                <div class="co-title">
                    <div class="co-eyebrow">Urban intelligence</div>
                    <h2 class="co-name"></h2>
                    <div class="co-state"></div>
                </div>
                <button class="co-icon-btn" data-co="toggle" aria-expanded="true" aria-controls="city-overview-body"></button>
            </header>
            <div class="co-body" id="city-overview-body"></div>
            <div class="co-actions">
                <button class="co-btn co-btn--primary" data-co="fly">${_ic('cube', 16)}<span>Explore in 3D</span></button>
                <button class="co-btn" data-co="orbit" aria-pressed="false" title="Slowly orbit the camera">${_ic('play', 14)}<span>Orbit</span></button>
            </div>`;
        document.body.appendChild(_el);
        _el.querySelector('[data-co="fly"]').addEventListener('click', flyIn3D);
        _el.querySelector('[data-co="orbit"]').addEventListener('click', () => {
            const map = MapModule.getMap && MapModule.getMap();
            if (_orbitRaf) { stopOrbit(); return; }
            if (map && map.getPitch() < 30) flyIn3D();
            startOrbit(map);
        });
        if (typeof UIPolish !== 'undefined' && UIPolish.prefersReducedMotion()) {
            _el.querySelector('[data-co="orbit"]').hidden = true;
        }
        _el.querySelector('[data-co="toggle"]').addEventListener('click', () =>
            _setCollapsed(!_el.classList.contains('is-collapsed')));
        let collapsed = false;
        try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { /* blocked */ }
        // Phones start collapsed: the map is the hero there.
        if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 640px)').matches) {
            try { if (localStorage.getItem(COLLAPSE_KEY) === null) collapsed = true; } catch { collapsed = true; }
        }
        _setCollapsed(collapsed, false);
        // The collapsed chip is one big target: tap the name to reopen.
        _el.querySelector('.co-title').addEventListener('click', () => {
            if (_el.classList.contains('is-collapsed')) _setCollapsed(false);
        });
        _watchYield();

        const select = document.getElementById('city-select');
        if (select) select.addEventListener('change', () => { stopOrbit(); render(CitySelector.getCurrent()); });
        // Coverage loads async; render now and again once regions are known.
        render(CitySelector.getCurrent());
        let tries = 0;
        const wait = setInterval(() => {
            tries++;
            const ready = typeof PrecomputedScores !== 'undefined' && PrecomputedScores.getRegions().length;
            if (ready || tries > 20) {
                clearInterval(wait);
                if (ready) { _statsCache.clear(); render(CitySelector.getCurrent()); }
            }
        }, 500);
    }

    return { init, render, summarise, bboxAreaKm2, fmtCount, histogramSvg, flyIn3D, stopOrbit };
})();

if (typeof window !== 'undefined') {
    window.CityOverview = CityOverview;
    document.addEventListener('DOMContentLoaded', () => CityOverview.init());
}
