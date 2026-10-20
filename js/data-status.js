/**
 * DataStatus — a persistent, keyed status strip for degraded data states.
 *
 * Toasts vanish; a user who comes back to the tab after lunch needs to see
 * *why* half the layers are dimmed. Each condition gets a key, so it can be
 * cleared independently when it recovers:
 *
 *   DataStatus.set('offline',   { text: 'You’re offline …', kind: 'warning' });
 *   DataStatus.set('cellstore', { text: 'Cell datasets unavailable', kind: 'error',
 *                                 action: { label: 'Retry', run: () => CellStore.init() } });
 *   DataStatus.clear('offline');
 *
 * Pure DOM, no map dependency; the strip is created lazily and removed when
 * the last entry clears. Dismissing hides an entry until it is set again
 * with different text.
 */
const DataStatus = (() => {
    const HOST_ID = 'data-status';
    const _entries = new Map();   // key → { text, kind, action, dismissed }

    function _host() {
        if (typeof document === 'undefined') return null;
        let el = document.getElementById(HOST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = HOST_ID;
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            document.body.appendChild(el);
        }
        return el;
    }

    function _render() {
        const host = _host();
        if (!host) return;
        while (host.firstChild) host.removeChild(host.firstChild);
        const visible = [..._entries.entries()].filter(([, e]) => !e.dismissed);
        if (!visible.length) { host.remove(); return; }
        visible.forEach(([key, e]) => {
            const row = document.createElement('div');
            row.className = `data-status-row ds-${e.kind || 'warning'}`;
            row.dataset.key = key;
            const dot = document.createElement('span');
            dot.className = 'ds-dot';
            dot.setAttribute('aria-hidden', 'true');
            const txt = document.createElement('span');
            txt.className = 'ds-text';
            txt.textContent = e.text;
            row.append(dot, txt);
            if (e.action && typeof e.action.run === 'function') {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ds-action';
                btn.textContent = e.action.label || 'Retry';
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    btn.textContent = e.action.busy || 'Retrying…';
                    try {
                        const ok = await e.action.run();
                        if (ok) clear(key); else _render();
                    } catch { _render(); }
                });
                row.appendChild(btn);
            }
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'ds-dismiss';
            x.setAttribute('aria-label', 'Dismiss');
            x.textContent = '✕';
            x.addEventListener('click', () => { e.dismissed = true; _render(); });
            row.appendChild(x);
            host.appendChild(row);
        });
    }

    /** Show (or update) the entry for `key`. Re-setting with new text un-dismisses it. */
    function set(key, opts = {}) {
        if (!key) return;
        const prev = _entries.get(key);
        const text = String(opts.text || '');
        const dismissed = !!(prev && prev.dismissed && prev.text === text);
        _entries.set(key, { text, kind: opts.kind || 'warning', action: opts.action || null, dismissed });
        _render();
    }

    function clear(key) {
        if (!_entries.has(key)) return;
        _entries.delete(key);
        _render();
    }

    function has(key) { const e = _entries.get(key); return !!e && !e.dismissed; }
    function active() { return [..._entries.entries()].filter(([, e]) => !e.dismissed).map(([k]) => k); }
    function reset() { _entries.clear(); _render(); }

    return { set, clear, has, active, reset };
})();
