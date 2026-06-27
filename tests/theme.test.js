import { describe, it, expect, beforeEach } from 'vitest';

// Theme is exposed on globalThis by tests/setup.js. toggle() reloads the page,
// so these lock the pure/persistence layer: normalize/get/set/apply and the
// per-theme basemap + grid-colour lookups that map.js consumes.
const T = globalThis.Theme;

beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
});

describe('Theme.normalize()', () => {
    it('accepts only known themes, defaulting to light (paper-light)', () => {
        expect(T.normalize('light')).toBe('light');
        expect(T.normalize('dark')).toBe('dark');
        expect(T.normalize('neon')).toBe('light');
        expect(T.normalize(null)).toBe('light');
    });
});

describe('Theme.get()/set()', () => {
    it('defaults to light (paper) with empty storage', () => {
        expect(T.get()).toBe('light');
    });

    it('persists and round-trips a theme choice', () => {
        expect(T.set('dark')).toBe('dark');
        expect(T.get()).toBe('dark');
        expect(localStorage.getItem('digipin_theme')).toBe('dark');
    });

    it('normalizes corrupt stored values to light', () => {
        localStorage.setItem('digipin_theme', 'hotdog');
        expect(T.get()).toBe('light');
    });
});

describe('Theme.apply() — the data-theme attribute', () => {
    it('sets data-theme="light" on <html> for light', () => {
        T.apply('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('removes the attribute for dark (dark is the bare default)', () => {
        T.apply('light');
        T.apply('dark');
        expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
});

describe('Theme.mapStyleUrl() / gridColors()', () => {
    it('serves dark-matter + neon grid for dark', () => {
        expect(T.mapStyleUrl('dark')).toContain('dark-matter');
        expect(T.gridColors('dark')).toEqual({ base: '#00f5ff', selected: '#a855f7' });
    });

    it('serves positron + blue-selected grid for light', () => {
        expect(T.mapStyleUrl('light')).toContain('positron');
        expect(T.gridColors('light')).toEqual({ base: '#b8bfc6', selected: '#0099ff' });
    });

    it('follows the persisted theme when no argument is given', () => {
        T.set('light');
        expect(T.mapStyleUrl()).toContain('positron');
        T.set('dark');
        expect(T.mapStyleUrl()).toContain('dark-matter');
    });
});

describe('Theme.palette() — JS-surface colours', () => {
    it('returns blue-interactive / coral-brand paper colours for light', () => {
        const p = T.palette('light');
        expect(p.primary).toBe('#0099ff');        // accent blue — interactive primary
        expect(p.brand).toBe('#ff673d');          // brand coral — brand/headlines
        expect(p.ink).toBe('#292929');
        expect(p.inkOnPrimary).toBe('#ffffff');   // readable label on blue
        expect(p.surfaceSolid).toBe('#ffffff');   // clean white card (Paper)
    });

    it('returns neon-on-navy colours for dark', () => {
        const p = T.palette('dark');
        expect(p.primary).toBe('#00f5ff');
        expect(p.ink).toBe('#e2e8f0');
        expect(p.inkOnPrimary).toBe('#0a0e27');   // dark ink on cyan, not white
    });

    it('every theme exposes the full semantic key set', () => {
        const keys = ['primary', 'primarySoft', 'secondary', 'ink', 'sub', 'surface', 'surfaceSolid', 'border', 'inkOnPrimary',
            'success', 'warn', 'danger'];
        for (const theme of T.THEMES) {
            for (const k of keys) expect(T.palette(theme)[k], `${theme}.${k}`).toBeTruthy();
        }
    });

    it('follows the persisted theme with no argument', () => {
        T.set('light');
        expect(T.palette().primary).toBe('#0099ff');
        T.set('dark');
        expect(T.palette().primary).toBe('#00f5ff');
    });
});

describe('Theme.scoreColor()', () => {
    it('maps score bands to theme status colours', () => {
        expect(T.scoreColor(85, 'dark')).toBe('#22c55e');
        expect(T.scoreColor(55, 'dark')).toBe('#eab308');
        expect(T.scoreColor(10, 'dark')).toBe('#ef4444');
        expect(T.scoreColor(85, 'light')).toBe('#5f8a5a');
        expect(T.scoreColor(10, 'light')).toBe('#b3392f');
    });
});

describe('Theme.fg() — canvas ink at alpha', () => {
    it('returns the exact white the charts used on dark (pixel-identical)', () => {
        expect(T.fg(0.08, 'dark')).toBe('rgba(255, 255, 255, 0.08)');
        expect(T.fg(0.5, 'dark')).toBe('rgba(255, 255, 255, 0.5)');
    });
    it('returns warm ink on light', () => {
        expect(T.fg(0.08, 'light')).toBe('rgba(40, 44, 48, 0.08)');
    });
});

describe('Theme.scale() — overlay ramps', () => {
    it('returns a copy of the per-theme ramp; dark == overlay originals', () => {
        expect(T.scale('growth', 'dark')).toEqual(['#b2182b', '#ef8a62', '#fddbc7', '#67a9cf']);
        expect(T.scale('accessibility', 'dark')[2]).toBe('#fee08b');
        expect(T.scale('bivariate', 'dark')).toHaveLength(9);
    });

    it('light ramps deepen the pale stops that wash out on Positron', () => {
        expect(T.scale('growth', 'light')[2]).not.toBe('#fddbc7');       // emerging deepened
        expect(T.scale('accessibility', 'light')[2]).not.toBe('#fee08b'); // fair deepened
        expect(T.scale('bivariate', 'light')[0]).not.toBe('#e8e8e8');     // low corner deepened
    });

    it('returns a fresh copy (mutation-safe) and undefined for unknown names', () => {
        const a = T.scale('growth', 'dark');
        a[0] = 'x';
        expect(T.scale('growth', 'dark')[0]).toBe('#b2182b');
        expect(T.scale('nope', 'dark')).toBeUndefined();
    });
});

