/**
 * Theme — paper-light (default) / dark theme switching.
 *
 * Two complete looks over one token system (css/styles.css):
 *   - "light" — Aino-style warm-paper consultancy look (DEFAULT): ink text,
 *               coral primary accent, light Positron basemap.
 *   - "dark"  — the original premium dark / neon control-room theme.
 *
 * Paper-light is the default (matching the landing page) so the landing→app
 * hand-off stays cohesive; an explicit "dark" choice flips it. The choice
 * persists in localStorage and is applied as <html data-theme="light">
 * *pre-paint* by an inline snippet in app.html / index.html (so there is no
 * flash); this module is the runtime API around that.
 *
 * Switching themes reloads the page: MapLibre's setStyle() drops every custom
 * source/layer (grid, choropleth, overlays), so a clean re-init against the
 * other basemap is the robust path. URLState.sync() runs first, so the
 * reload restores the exact view (centre/zoom/cell/score).
 */
const Theme = (() => {
    const STORAGE_KEY = 'digipin_theme';
    const THEMES = ['dark', 'light'];
    const DEFAULT_THEME = 'light';   // Aino paper-light is the default look

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

    // Semantic colours for JS-built surfaces (overlay legends, MapLibre popups,
    // canvas charts, pin markers) that can't read CSS variables. Mirrors the
    // CSS token system: `primary` == --accent-cyan, `ink`/`sub` == text, etc.
    // A theme switch reloads the page, so reading this at render time is enough.
    const PALETTE = {
        dark: {
            primary: '#00f5ff', primarySoft: 'rgba(0,245,255,0.22)',
            secondary: '#a855f7', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', surfaceSolid: '#111638',
            border: 'rgba(255,255,255,0.12)', inkOnPrimary: '#0a0e27',
            // status colours (mirror CSS --accent-green/yellow/red)
            success: '#22c55e', warn: '#eab308', danger: '#ef4444',
        },
        light: {
            primary: '#c2410c', primarySoft: 'rgba(194,65,12,0.20)',
            secondary: '#7c3aed', ink: '#1c1917', sub: '#57534e',
            surface: 'rgba(246,245,241,0.96)', surfaceSolid: '#faf8f3',
            border: 'rgba(28,25,23,0.12)', inkOnPrimary: '#ffffff',
            success: '#15803d', warn: '#a16207', danger: '#b91c1c',
        },
    };

    // Theme foreground ("ink") at an arbitrary alpha — for canvas chart grids,
    // axes, ticks and labels that were hardcoded white. Dark returns the exact
    // white the charts used (pixel-identical); light returns warm ink.
    const FG = { dark: '255, 255, 255', light: '28, 25, 23' };

    // Per-theme data ramps for the overlays whose dark-tuned palettes wash out
    // on the light Positron basemap. Dark arrays == the overlays' current
    // colours (no change); light arrays deepen the pale stops so they read on
    // white. Bivariate is row-major (yBin*3 + xBin) of the 3x3 grid.
    const SCALES = {
        growth: {
            dark:  ['#b2182b', '#ef8a62', '#fddbc7', '#67a9cf'],
            light: ['#b2182b', '#e8765a', '#f4a582', '#4393c3'],
        },
        accessibility: {
            dark:  ['#1a9850', '#91cf60', '#fee08b', '#d73027'],
            light: ['#1a9850', '#7fb348', '#d9a015', '#c4302b'],
        },
        bivariate: {
            dark:  ['#e8e8e8', '#ace4e4', '#5ac8c8', '#dfb0d6', '#a5add3',
                    '#5698b9', '#be64ac', '#8c62aa', '#3b4994'],
            light: ['#cfc7ba', '#86cfc9', '#3aa8a8', '#c98fbf', '#8f8fbf',
                    '#4f87ad', '#a84f96', '#74508f', '#2e3a78'],
        },
    };

    function normalize(value) {
        return THEMES.includes(value) ? value : DEFAULT_THEME;
    }

    function get() {
        try { return normalize(localStorage.getItem(STORAGE_KEY)); }
        catch { return DEFAULT_THEME; }
    }

    function apply(theme) {
        if (typeof document === 'undefined') return;
        const isLight = normalize(theme) === 'light';
        if (isLight) {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        // Keep the mobile browser chrome (status bar) in sync: paper vs navy.
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', isLight ? '#f6f5f1' : '#0a0e27');
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

    /** Semantic colours for JS-built surfaces (legends, popups, canvas, pins). */
    function palette(theme) {
        return PALETTE[normalize(theme !== undefined ? theme : get())];
    }

    /** Per-theme data ramp (copy) for an overlay; undefined for unknown names. */
    function scale(name, theme) {
        const s = SCALES[name];
        return s ? s[normalize(theme !== undefined ? theme : get())].slice() : undefined;
    }

    /** Theme-aware score colour: success ≥70, warn ≥40, else danger. */
    function scoreColor(value, theme) {
        const p = palette(theme);
        return value >= 70 ? p.success : value >= 40 ? p.warn : p.danger;
    }

    /** Theme foreground at alpha a, e.g. fg(0.08) for a faint chart grid line. */
    function fg(a, theme) {
        return `rgba(${FG[normalize(theme !== undefined ? theme : get())]}, ${a})`;
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

    return { init, get, set, apply, normalize, toggle, mapStyleUrl, gridColors,
        palette, scale, scoreColor, fg, THEMES };
})();

if (typeof window !== 'undefined') {
    window.Theme = Theme;
}
