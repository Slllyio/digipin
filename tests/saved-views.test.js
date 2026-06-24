import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// SavedViews + URLState are exposed on globalThis by tests/setup.js.
const SV = globalThis.SavedViews;

const realCapture = URLState.capture;
const realApply = URLState.apply;

beforeEach(() => {
    localStorage.clear();
    SV.init();
});

afterEach(() => {
    URLState.capture = realCapture;
    URLState.apply = realApply;
});

describe('SavedViews persistence', () => {
    it('starts empty and ships templates', () => {
        expect(SV.getAll()).toEqual([]);
        expect(SV.getTemplates().length).toBeGreaterThan(0);
        // templates are India-native Text2Map starting points
        expect(SV.getTemplates()[0].state.q).toBeTruthy();
    });

    it('adds a named view and persists it across re-init', () => {
        expect(SV.add('My area', { cell: '4P3JK8', score: 'safety' })).toBe(true);
        expect(SV.getAll()).toHaveLength(1);
        SV.init(); // reload from localStorage
        const v = SV.getAll()[0];
        expect(v.name).toBe('My area');
        expect(v.state.cell).toBe('4P3JK8');
        expect(Number.isFinite(v.timestamp)).toBe(true);
    });

    it('overwrites a repeated name (last-write-wins)', () => {
        SV.add('Home', { score: 'safety' });
        SV.add('Home', { score: 'green' });
        expect(SV.getAll()).toHaveLength(1);
        expect(SV.getAll()[0].state.score).toBe('green');
    });

    it('rejects an empty name or non-object state', () => {
        expect(SV.add('', { score: 'x' })).toBe(false);
        expect(SV.add('  ', { score: 'x' })).toBe(false);
        expect(SV.add('ok', null)).toBe(false);
        expect(SV.getAll()).toHaveLength(0);
    });

    it('removes by name', () => {
        SV.add('A', { score: 'safety' });
        SV.add('B', { score: 'green' });
        SV.remove('A');
        expect(SV.getAll().map(v => v.name)).toEqual(['B']);
    });
});

describe('SavedViews.load() resilience', () => {
    it('returns [] for non-array or corrupt storage', () => {
        localStorage.setItem('digipin_saved_views', '{"not":"array"}');
        expect(SV.load()).toEqual([]);
        localStorage.setItem('digipin_saved_views', 'not json');
        expect(SV.load()).toEqual([]);
    });

    it('drops entries missing a name or state', () => {
        localStorage.setItem('digipin_saved_views', JSON.stringify([
            { name: 'good', state: { score: 'safety' } },
            { name: '', state: {} },
            { state: { score: 'x' } },
            { name: 'nostate' },
        ]));
        const loaded = SV.load();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].name).toBe('good');
    });
});

describe('SavedViews.saveCurrent() / restore()', () => {
    it('captures the live view via URLState and saves it', () => {
        URLState.capture = vi.fn(() => ({ cell: '4P3JK8', score: 'safety' }));
        expect(SV.saveCurrent('Snapshot')).toBe(true);
        expect(SV.getAll()[0].state).toEqual({ cell: '4P3JK8', score: 'safety' });
    });

    it('refuses to save an empty capture', () => {
        URLState.capture = vi.fn(() => ({}));
        expect(SV.saveCurrent('Empty')).toBe(false);
        expect(SV.getAll()).toHaveLength(0);
    });

    it('restore() applies the state through URLState', () => {
        URLState.apply = vi.fn();
        SV.restore({ cell: '4P3JK8' });
        expect(URLState.apply).toHaveBeenCalledWith({ cell: '4P3JK8' });
    });
});
