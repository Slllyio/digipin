/**
 * SavedViews — named, reusable map views + shipped templates.
 *
 * A "view" is a captured URLState snapshot ({cell?,q?,score?,z?,ll?}) given a
 * name and persisted to localStorage — "Family home shortlist", "Flood-safe +
 * transit". Restoring one re-applies it through URLState.apply (fly, select,
 * set score, prefill the Text2Map question). TEMPLATES are pre-seeded views
 * shipped with the app so a first-time user has India-native starting points.
 *
 * Modelled on js/bookmarks.js (same localStorage + list-panel shape). load()/
 * add()/remove()/getAll()/getTemplates() are pure-ish (unit-tested); the panel
 * rendering mirrors the bookmarks panel.
 */
const SavedViews = (() => {
    const STORAGE_KEY = 'digipin_saved_views';
    let _views = [];

    // Shipped starting points — India-native questions over the precomputed grid.
    const TEMPLATES = [
        { name: 'Family home shortlist', state: { q: 'family-friendly area near good schools with low flood risk', score: 'livability' } },
        { name: 'Flood-safe + transit', state: { q: 'low flood risk with good public transport access', score: 'flood_risk' } },
        { name: 'IT hub / coworking', state: { q: 'best area for an IT hub or coworking space', score: 'digital_readiness' } },
        { name: 'Healthcare access', state: { q: 'strong healthcare access and pharmacies nearby', score: 'healthcare_access' } },
    ];

    function init() {
        _views = load();
    }

    function load() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
            // Guard valid-JSON-but-wrong-type and drop entries missing a name or
            // a state object (would crash apply/render).
            if (!Array.isArray(raw)) return [];
            return raw.filter(v =>
                v && typeof v.name === 'string' && v.name.trim() &&
                v.state && typeof v.state === 'object');
        } catch { return []; }
    }

    function save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_views)); }
        catch { /* storage full or blocked */ }
    }

    /** Persist a named view. A repeated name overwrites (last-write-wins). */
    function add(name, state) {
        const clean = (name || '').trim();
        if (!clean || !state || typeof state !== 'object') return false;
        _views = _views.filter(v => v.name !== clean);
        _views.push({ name: clean, state, timestamp: Date.now() });
        save();
        return true;
    }

    /** Capture the live view (via URLState) and save it under `name`. */
    function saveCurrent(name) {
        if (typeof URLState === 'undefined') return false;
        const state = URLState.capture();
        if (!state || Object.keys(state).length === 0) {
            if (typeof App !== 'undefined' && App.showToast) {
                App.showToast('Nothing to save', 'Move the map or select a cell first.', 'warning');
            }
            return false;
        }
        const ok = add(name, state);
        if (ok && typeof App !== 'undefined' && App.showToast) {
            App.showToast('View saved', `"${name.trim()}" added to Saved Views.`, 'success');
        }
        return ok;
    }

    function remove(name) {
        _views = _views.filter(v => v.name !== name);
        save();
    }

    function restore(state) {
        if (typeof URLState !== 'undefined') URLState.apply(state);
    }

    function getAll() { return _views; }
    function getTemplates() { return TEMPLATES; }

    // ===== PANEL UI (mirrors the bookmarks panel) =====

    function openPanel() {
        const panel = document.getElementById('saved-views-panel');
        if (!panel) return;
        panel.classList.add('open');
        renderPanel();
    }

    function closePanel() {
        const panel = document.getElementById('saved-views-panel');
        if (panel) panel.classList.remove('open');
    }

    function _row(view, isTemplate) {
        const item = document.createElement('div');
        item.className = 'bm-item';

        const info = document.createElement('div');
        info.className = 'bm-info';
        info.style.cursor = 'pointer';
        info.addEventListener('click', () => { restore(view.state); closePanel(); });

        const name = document.createElement('div');
        name.className = 'bm-code';
        name.textContent = (isTemplate ? '✨ ' : '') + view.name;
        info.appendChild(name);

        const desc = document.createElement('div');
        desc.className = 'bm-note';
        desc.textContent = view.state.q || [view.state.cell, view.state.score].filter(Boolean).join(' · ') || 'Map view';
        info.appendChild(desc);

        item.appendChild(info);

        if (!isTemplate) {
            const delBtn = document.createElement('button');
            delBtn.className = 'bm-delete';
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', () => { remove(view.name); renderPanel(); });
            item.appendChild(delBtn);
        }
        return item;
    }

    function renderPanel() {
        const list = document.getElementById('saved-views-list');
        if (!list) return;
        while (list.firstChild) list.removeChild(list.firstChild);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'sv-save-btn';
        saveBtn.textContent = '+ Save current view';
        saveBtn.addEventListener('click', () => {
            const name = window.prompt('Name this view:');
            if (name && name.trim()) { saveCurrent(name); renderPanel(); }
        });
        list.appendChild(saveBtn);

        if (_views.length) {
            _views.forEach(v => list.appendChild(_row(v, false)));
        }

        const tHeader = document.createElement('div');
        tHeader.className = 'sv-templates-header';
        tHeader.textContent = 'Templates';
        list.appendChild(tHeader);
        TEMPLATES.forEach(t => list.appendChild(_row(t, true)));
    }

    return {
        init, load, add, saveCurrent, remove, restore,
        getAll, getTemplates, openPanel, closePanel,
    };
})();

if (typeof window !== 'undefined') {
    window.SavedViews = SavedViews;
}
