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

    /** What a row shows; a row is rebuilt only when this changes. */
    function _sig(e) {
        return `${e.kind || 'warning'}\u0000${e.text}\u0000${e.action && typeof e.action.run === 'function' ? (e.action.label || 'Retry') : ''}`;
    }

    function _row(key, e) {
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
            const label = e.action.label || 'Retry';
            btn.textContent = label;
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = e.action.busy || 'Retrying…';
                let ok = false;
                try { ok = await e.action.run(); } catch { ok = false; }
                if (ok) { clear(key); return; }
                // Still failing: the row stays as it is, the button comes back.
                btn.disabled = false;
                btn.textContent = label;
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
        return row;
    }

    // Incremental: a row whose text, kind and button have not changed keeps
    // its DOM node. Rebuilding the whole strip on every change (another key's
    // row arriving or clearing) dropped focus and detached a Retry button the
    // user, or the browser suite, was in the middle of clicking.
    function _render() {
        const host = _host();
        if (!host) return;
        const visible = [..._entries.entries()].filter(([, e]) => !e.dismissed);
        if (!visible.length) { _entries.forEach((e) => { e.el = null; }); host.remove(); return; }
        const keep = new Set();
        visible.forEach(([key, e], i) => {
            const sig = _sig(e);
            if (!e.el || e.sig !== sig || e.el.parentNode !== host) {
                const fresh = _row(key, e);
                if (e.el && e.el.parentNode === host) host.replaceChild(fresh, e.el); else host.appendChild(fresh);
                e.el = fresh;
                e.sig = sig;
            }
            keep.add(e.el);
            if (host.children[i] !== e.el) host.insertBefore(e.el, host.children[i] || null);
        });
        [...host.children].forEach((el) => { if (!keep.has(el)) el.remove(); });
        _entries.forEach((e) => { if (e.dismissed) e.el = null; });
    }

    /** Show (or update) the entry for `key`. Re-setting with new text un-dismisses it. */
    function set(key, opts = {}) {
        if (!key) return;
        const prev = _entries.get(key);
        const text = String(opts.text || '');
        const kind = opts.kind || 'warning';
        const action = opts.action || null;
        const dismissed = !!(prev && prev.dismissed && prev.text === text);
        // Same text, kind and button on a row already shown: keep the DOM as it
        // is (only refresh the action callback). A module that reports the same
        // condition on every failed part would otherwise rebuild the strip each
        // time, which drops focus and detaches a Retry the user is clicking.
        if (prev && !prev.dismissed && prev.text === text && prev.kind === kind
            && !!prev.action === !!action && (!action || (prev.action.label || 'Retry') === (action.label || 'Retry'))) {
            prev.action = action;
            return;
        }
        _entries.set(key, { text, kind, action, dismissed, el: prev && !dismissed ? prev.el : null, sig: prev ? prev.sig : null });
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
