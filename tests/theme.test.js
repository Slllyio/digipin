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
    it('accepts only known themes, defaulting to dark', () => {
        expect(T.normalize('light')).toBe('light');
        expect(T.normalize('dark')).toBe('dark');
        expect(T.normalize('neon')).toBe('dark');
        expect(T.normalize(null)).toBe('dark');
    });
});

describe('Theme.get()/set()', () => {
    it('defaults to dark with empty storage', () => {
        expect(T.get()).toBe('dark');
    });

    it('persists and round-trips a theme choice', () => {
        expect(T.set('light')).toBe('light');
        expect(T.get()).toBe('light');
        expect(localStorage.getItem('digipin_theme')).toBe('light');
    });

    it('normalizes corrupt stored values to dark', () => {
        localStorage.setItem('digipin_theme', 'hotdog');
        expect(T.get()).toBe('dark');
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

    it('serves positron + coral grid for light', () => {
        expect(T.mapStyleUrl('light')).toContain('positron');
        expect(T.gridColors('light')).toEqual({ base: '#c2410c', selected: '#7c3aed' });
    });

    it('follows the persisted theme when no argument is given', () => {
        T.set('light');
        expect(T.mapStyleUrl()).toContain('positron');
        T.set('dark');
        expect(T.mapStyleUrl()).toContain('dark-matter');
    });
});

describe('Theme.palette() — JS-surface colours', () => {
    it('returns coral-ink paper colours for light', () => {
        const p = T.palette('light');
        expect(p.primary).toBe('#c2410c');
        expect(p.ink).toBe('#1c1917');
        expect(p.inkOnPrimary).toBe('#ffffff');   // readable label on coral
        expect(p.surfaceSolid).toBe('#ffffff');
    });

    it('returns neon-on-navy colours for dark', () => {
        const p = T.palette('dark');
        expect(p.primary).toBe('#00f5ff');
        expect(p.ink).toBe('#e2e8f0');
        expect(p.inkOnPrimary).toBe('#0a0e27');   // dark ink on cyan, not white
    });

    it('every theme exposes the full semantic key set', () => {
        const keys = ['primary', 'primarySoft', 'secondary', 'ink', 'sub', 'surface', 'surfaceSolid', 'border', 'inkOnPrimary'];
        for (const theme of T.THEMES) {
            for (const k of keys) expect(T.palette(theme)[k], `${theme}.${k}`).toBeTruthy();
        }
    });

    it('follows the persisted theme with no argument', () => {
        T.set('light');
        expect(T.palette().primary).toBe('#c2410c');
        T.set('dark');
        expect(T.palette().primary).toBe('#00f5ff');
    });
});

