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

    function _sortedColumn(id, key) {
        const k = `${id}|${key}`;
        if (!_sorted.has(k)) {
            _sorted.set(k, (async () => {
                const t = await CellStore.load(id);
                if (!t) return null;
                return (t.columns[key] || []).filter(v => v != null && Number.isFinite(Number(v)))
                    .map(Number).sort((a, b) => a - b);
            })());
        }
        return _sorted.get(k);
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
            for (const f of spec.fields) {
                const v = row[f.key];
                if (v == null) continue;
                const item = { key: f.key, label: f.label, type: f.type, value: v, text: formatValue(f, v), higherIs: f.higherIs || null };
                if (opts.rank && f.type === 'number') {
                    item.rank = rankOf(await _sortedColumn(spec.id, f.key), Number(v));
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
        const sections = await profile(cell.center.lat, cell.center.lng, { rank: true });
        if (seq !== _seq || !containerEl.isConnected) return null;
        containerEl.querySelectorAll(`[${ATTR}]`).forEach(e => e.remove());
        const wrap = document.createElement('div');
        wrap.setAttribute(ATTR, '');
        wrap.className = 'growth-widget';
        wrap.innerHTML = _html(sections, cell);
        wrap.querySelectorAll('.cell-profile__show').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (typeof CellLayers !== 'undefined') CellLayers.show(btn.dataset.id);
            });
        });
        // Sit with the other analytic cards, ahead of them: first card slot.
        const firstCard = containerEl.querySelector('.growth-widget');
        if (firstCard) containerEl.insertBefore(wrap, firstCard);
        else containerEl.appendChild(wrap);
        return sections;
    }

    /** Drop cached rank columns (e.g. after a dataset is re-registered). */
    function reset() { _sorted.clear(); }

    if (typeof CellStore !== 'undefined' && CellStore.onChange) CellStore.onChange(reset);

    return { profile, attachTo, formatValue, rankOf, rankLabel, reset };
})();

if (typeof window !== 'undefined') {
    window.CellProfile = CellProfile;
}
