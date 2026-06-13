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
