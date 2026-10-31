/**
 * CellProfile — "everything about this DIGIPIN": one click on a cell lists the
 * value of every dataset in the cell-store registry (js/cell-store.js) for
 * that cell, catalog layers and dropped files alike, with where it ranks in
 * its region and a button to put that layer on the map.
 *
 * Nothing here is per-dataset: a dataset added to data/cells/catalog.json (or
 * dropped on the map) shows up in the profile with no code change. Lookups go
 * through CellStore.rowAt, which fetches at most one shard per region, so a
 * click stays cheap however large the store grows.
 *
 * profile/formatValue/rankOf are pure-ish and unit-tested; attachTo renders
 * into the cell panel (js/panel.js) as a growth-widget-styled card.
 */
const CellProfile = (() => {
    const ATTR = 'data-cell-profile';
    const _sorted = new Map();    // "<id>|<key>" -> Promise<sorted finite numbers>
    let _seq = 0;                 // guards against a slow profile painting over a newer click

    function _esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Human value: rounded number + real unit, category text, yes/no. */
    function formatValue(f, v) {
        if (v == null) return '—';
        if (f.type === 'boolean') return v ? 'yes' : 'no';
        if (f.type !== 'number') return String(v);
        const x = Number(v);
        if (!Number.isFinite(x)) return '—';
        const abs = Math.abs(x);
        const s = abs >= 1000 ? Math.round(x).toLocaleString('en-IN')
            : abs >= 100 ? String(Math.round(x))
                : abs >= 1 ? String(Math.round(x * 10) / 10)
                    : String(Math.round(x * 100) / 100);
        // "0-100"-style units restate the domain; only real units get a suffix.
        const unit = f.unit && !/^[\d.]+\s*[-–]\s*[\d.]+$/.test(f.unit) ? ` ${f.unit}` : '';
        return s + unit;
    }

    /** First index in ascending `sorted` where pred(value) is false. */
    function _bound(sorted, pred) {
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pred(sorted[mid])) lo = mid + 1; else hi = mid; }
        return lo;
    }

    /**
     * Mid-rank percentile of v in ascending `sorted`, in [0,1]; null without
     * data. Ties count half, so a 0 shared by most cells lands mid-pack
     * instead of reading as "top third".
     */
    function rankOf(sorted, v) {
        if (!sorted || !sorted.length || v == null || !Number.isFinite(Number(v))) return null;
        const below = _bound(sorted, x => x < v);
        const atOrBelow = _bound(sorted, x => x <= v);
        return (below + atOrBelow) / 2 / sorted.length;
    }

    /** "top 8%" / "bottom 12%" phrasing, honest about which end is good. */
    function rankLabel(f, r) {
        if (r == null) return '';
        const top = Math.max(1, Math.round((1 - r) * 100));
        const bottom = Math.max(1, Math.round(r * 100));
        if (r >= 0.5) return `top ${top}%`;
        return `bottom ${bottom}%`;
    }

    /** Let the event loop breathe between heavy columns (keeps the UI responsive). */
    const _yield = () => new Promise(res => {
        if (typeof scheduler !== 'undefined' && scheduler.yield) scheduler.yield().then(res, res);
        else setTimeout(res, 0);
    });

    /** The catalog region (city) whose bbox contains the point, or null. */
    function _regionAt(spec, lat, lng) {
        for (const r of (spec && spec.regions) || []) {
            const b = r.bbox;
            if (b && lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east) return r;
        }
        return null;
    }

    /**
     * Sorted finite values of one column, for ranking. The comparison set is
     * the cell's own region (city): loading every region of every dataset to
     * rank one cell pulled ~3.4 M rows into memory and froze the page for
     * seconds. Sorting happens in its own task per column, on a typed array.
     */
    let _sortedRegion = null;
    function _sortedColumn(id, key, lat, lng) {
        const spec = CellStore.get(id);
        const region = _regionAt(spec, lat, lng);
        const name = region ? region.name : '*';
        // Sorted columns are per city; moving to another city drops the old
        // ones (a city's worth is ~100 typed arrays of up to 50k values).
        if (name !== _sortedRegion) { _sorted.clear(); _sortedRegion = name; }
        const k = `${id}|${key}|${name}`;
        if (!_sorted.has(k)) {
            _sorted.set(k, (async () => {
                const t = region && CellStore.loadView ? await CellStore.loadView(id, region.bbox) : await CellStore.load(id);
                if (!t) return null;
                await _yield();
                const col = t.columns[key] || [];
                const vals = [];
                for (let i = 0; i < col.length; i++) {
                    const v = col[i];
                    if (v != null && Number.isFinite(Number(v))) vals.push(Number(v));
                }
                return Float64Array.from(vals).sort();
            })());
        }
        return _sorted.get(k);
    }

    /** Index of the last non-null value in a series, or -1. */
    function latestStep(series) {
        if (!Array.isArray(series)) return -1;
        for (let t = series.length - 1; t >= 0; t--) if (series[t] != null) return t;
        return -1;
    }

    /**
     * Profile of the cell at (lat,lng): one section per dataset that has a row
     * there, in registry order. With { rank: true } numeric fields also carry
     * their rank in the dataset (loads the dataset's whole table once).
     */
    async function profile(lat, lng, opts = {}) {
        if (typeof CellStore === 'undefined') return [];
        const specs = CellStore.datasets();
        const rows = await Promise.all(specs.map(s => CellStore.rowAt(s.id, lat, lng).catch(() => null)));
        const out = [];
        for (let i = 0; i < specs.length; i++) {
            const spec = specs[i], row = rows[i];
            if (!row) continue;
            const fields = [];
            const temporal = CellStore.isTemporal && CellStore.isTemporal(spec);
            for (const f of spec.fields) {
                let v = row[f.key];
                let when = '';
                if (temporal) {
                    // A series: show its latest value, labelled with its step.
                    const t = latestStep(v);
                    if (t < 0) continue;
                    v = v[t];
                    when = ` (${spec.time.steps[t]})`;
                }
                if (v == null) continue;
                const item = { key: f.key, label: f.label, type: f.type, value: v, text: formatValue(f, v) + when, higherIs: f.higherIs || null };
                // Ranking needs the whole dataset; series datasets span every city, so skip them.
                if (opts.rank && f.type === 'number' && !temporal) {
                    item.rank = rankOf(await _sortedColumn(spec.id, f.key, lat, lng), Number(v));
                    item.rankText = rankLabel(f, item.rank);
                }
                fields.push(item);
            }
            if (fields.length) {
                out.push({ id: spec.id, title: spec.title, group: spec.group || 'Cell Data',
                    level: spec.level, digipin: row.digipin, source: spec.source || '', fields });
            }
        }
        return out;
    }

    function _rankColor(item) {
        if (item.rank == null || !item.higherIs) return 'var(--text-secondary)';
        const good = item.higherIs === 'better' ? item.rank : 1 - item.rank;
        return good >= 0.75 ? '#16a34a' : good <= 0.25 ? '#dc2626' : 'var(--text-secondary)';
    }

    function _html(sections, cell) {
        if (!sections.length) {
            return `<div class="growth-widget__title">📇 Everything in this cell</div>
                <div class="growth-widget__msg">No cell-store dataset covers ${_esc(cell.code)} yet. Drop a CSV or GeoJSON on the map to add one.</div>`;
        }
        const n = sections.reduce((a, s) => a + s.fields.length, 0);
        const body = sections.map(s => `
            <div class="cell-profile__ds" style="margin-top:8px;">
                <div style="display:flex;align-items:center;gap:6px;">
                    <strong style="flex:1;font-size:12px;">${_esc(s.title)}</strong>
                    <span style="font-size:10px;color:var(--text-secondary);">L${s.level} · ${_esc(DigiPin.format(s.digipin.replace(/-/g, '')))}</span>
                    <button type="button" class="cell-profile__show" data-id="${_esc(s.id)}" title="Show ${_esc(s.title)} on the map"
                        style="font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid var(--border-color,#ccc);background:none;color:inherit;cursor:pointer;">Map</button>
                </div>
                ${s.fields.map(f => `
                <div class="growth-widget__row" style="justify-content:space-between;font-size:11px;">
                    <span style="color:var(--text-secondary);">${_esc(f.label)}</span>
                    <span><strong>${_esc(f.text)}</strong>${f.rankText ? ` <span style="color:${_rankColor(f)};font-size:10px;">${_esc(f.rankText)}</span>` : ''}</span>
                </div>`).join('')}
            </div>`).join('');
        return `<div class="growth-widget__header">
                <div class="growth-widget__title">📇 Everything in this cell</div>
                <span style="font-size:10px;color:var(--text-secondary);">${sections.length} layers · ${n} values</span>
            </div>${body}`;
    }

    /**
     * Render the profile card into the cell panel. Idempotent (replaces its
     * previous card); ignores results for a cell the user has since left.
     */
    async function attachTo(containerEl, cell) {
        if (!containerEl || !cell || typeof CellStore === 'undefined' || !CellStore.isEnabled()) return null;
        const seq = ++_seq;
        // Say at once that cell data is on its way: on a slow link the ~60
        // fetches behind a profile can take tens of seconds, and an empty slot
        // reads as "nothing here". The placeholder carries the same attribute
        // (value "loading") so it is replaced, never duplicated, and so tests
        // can tell it from the real card.
        const place = _slot(containerEl, 'loading');
        place.setAttribute('aria-busy', 'true');
        place.innerHTML = `<div class="growth-widget__title">📇 Everything in this cell</div>
            <div class="growth-widget__msg">Loading cell data for ${_esc(cell.code)}…</div>`;
        const sections = await profile(cell.center.lat, cell.center.lng, { rank: true });
        if (seq !== _seq || !containerEl.isConnected) return null;
        const wrap = _slot(containerEl, '');
        wrap.innerHTML = _html(sections, cell);
        wrap.querySelectorAll('.cell-profile__show').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (typeof CellLayers !== 'undefined') CellLayers.show(btn.dataset.id);
            });
        });
        return sections;
    }

    /**
     * The profile's card element, fresh: drops any earlier profile card and
     * puts a new one ahead of the other analytic cards (first card slot).
     */
    function _slot(containerEl, state) {
        containerEl.querySelectorAll(`[${ATTR}]`).forEach(e => e.remove());
        const wrap = document.createElement('div');
        wrap.setAttribute(ATTR, state);
        wrap.className = 'growth-widget';
        const firstCard = containerEl.querySelector('.growth-widget');
        if (firstCard) containerEl.insertBefore(wrap, firstCard);
        else containerEl.appendChild(wrap);
        return wrap;
    }

    /** Drop cached rank columns (e.g. after a dataset is re-registered). */
    function reset() { _sorted.clear(); _sortedRegion = null; }

    if (typeof CellStore !== 'undefined' && CellStore.onChange) CellStore.onChange(reset);

    return { profile, attachTo, formatValue, rankOf, rankLabel, latestStep, reset };
})();

if (typeof window !== 'undefined') {
    window.CellProfile = CellProfile;
}
