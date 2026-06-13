/**
 * Theme — dark (default) / paper-light theme switching.
 *
 * Two complete looks over one token system (css/styles.css):
 *   - "dark"  — the original premium dark / neon control-room theme.
 *   - "light" — Aino-style warm-paper consultancy look: ink text, coral
 *               primary accent, light Positron basemap.
 *
 * The choice persists in localStorage and is applied as
 * <html data-theme="light"> *pre-paint* by an inline snippet in index.html
 * (so there is no dark flash); this module is the runtime API around that.
 *
 * Switching themes reloads the page: MapLibre's setStyle() drops every custom
 * source/layer (grid, choropleth, overlays), so a clean re-init against the
 * other basemap is the robust path. URLState.sync() runs first, so the
 * reload restores the exact view (centre/zoom/cell/score).
 */
const Theme = (() => {
    const STORAGE_KEY = 'digipin_theme';
    const THEMES = ['dark', 'light'];

    const BASEMAPS = {
        dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    };

    // DIGIPIN grid paint per theme (map.js layers are created once at init;
    // a theme change reloads, so init-time colours are sufficient).
    const GRID_COLORS = {
        dark: { base: '#00f5ff', selected: '#a855f7' },
        light: { base: '#c2410c', selected: '#7c3aed' },
    };

    function normalize(value) {
        return THEMES.includes(value) ? value : 'dark';
    }

    function get() {
        try { return normalize(localStorage.getItem(STORAGE_KEY)); }
        catch { return 'dark'; }
    }

    function apply(theme) {
        if (typeof document === 'undefined') return;
        if (normalize(theme) === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    }

    function set(theme) {
        const t = normalize(theme);
        try { localStorage.setItem(STORAGE_KEY, t); } catch { /* blocked */ }
        apply(t);
        return t;
    }

    /** Basemap style URL for the active (or given) theme. */
    function mapStyleUrl(theme) {
        return BASEMAPS[normalize(theme !== undefined ? theme : get())];
    }

    /** Grid base/selected colours for the active (or given) theme. */
    function gridColors(theme) {
        return GRID_COLORS[normalize(theme !== undefined ? theme : get())];
    }

    /** Flip theme and reload (preserving the view via URL state). */
    function toggle() {
        const next = get() === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(STORAGE_KEY, next); } catch { /* blocked */ }
        if (typeof URLState !== 'undefined' && URLState.sync) {
            try { URLState.sync(); } catch { /* best-effort view restore */ }
        }
        if (typeof window !== 'undefined' && window.location && window.location.reload) {
            window.location.reload();
        }
        return next;
    }

    /** Wire the toolbar toggle button (theme itself was applied pre-paint). */
    function init() {
        apply(get());
        if (typeof document === 'undefined') return;
        const btn = document.getElementById('theme-toggle-btn');
        if (btn) {
            btn.textContent = get() === 'light' ? '\u{1F319}' : '☀️';
            btn.title = get() === 'light' ? 'Switch to dark theme' : 'Switch to paper-light theme';
            btn.addEventListener('click', toggle);
        }
    }

    return { init, get, set, apply, normalize, toggle, mapStyleUrl, gridColors, THEMES };
})();

if (typeof window !== 'undefined') {
    window.Theme = Theme;
}
