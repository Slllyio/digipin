import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Bookmarks is exposed on globalThis by tests/setup.js. It reaches for App and
// MapModule at call time; with getMap() -> null, renderMarkers short-circuits
// before any maplibre code, so the data layer is testable under jsdom.
const Bookmarks = globalThis.Bookmarks;
const STORAGE_KEY = 'digipin_bookmarks';

let toasts;

beforeEach(() => {
    localStorage.clear();
    toasts = [];
    globalThis.App = { showToast: (title, msg, kind) => toasts.push({ title, msg, kind }) };
    globalThis.MapModule = { getMap: () => null, flyTo: () => {} };
});

afterEach(() => {
    delete globalThis.App;
    delete globalThis.MapModule;
    localStorage.clear();
});

const cell = (code, lat = 22.7, lng = 75.8) => ({ code, center: { lat, lng } });

describe('Bookmarks.load() robustness (via init/getAll)', () => {
    it('loads a well-formed array', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([
            { code: 'ABC', lat: 1, lng: 2, note: 'x', timestamp: 0 },
        ]));
        Bookmarks.init();
        expect(Bookmarks.getAll()).toHaveLength(1);
    });

    it('returns [] for corrupt JSON', () => {
        localStorage.setItem(STORAGE_KEY, '{not valid json');
        Bookmarks.init();
        expect(Bookmarks.getAll()).toEqual([]);
    });

    it('returns [] for valid JSON that is not an array', () => {
        for (const bad of ['{}', '42', '"hello"', 'null', 'true']) {
            localStorage.setItem(STORAGE_KEY, bad);
            Bookmarks.init();
            expect(Bookmarks.getAll()).toEqual([]);
        }
    });

    it('drops entries missing a code or finite coordinates', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([
            { code: 'GOOD', lat: 1, lng: 2 },
            { code: 'NOLAT', lng: 2 },
            { code: 'NANLNG', lat: 1, lng: NaN },
            { lat: 1, lng: 2 },          // no code
            null,
            'garbage',
        ]));
        Bookmarks.init();
        const all = Bookmarks.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].code).toBe('GOOD');
    });
});

describe('Bookmarks add / remove / updateNote', () => {
    beforeEach(() => Bookmarks.init());

    it('adds a bookmark and persists it to localStorage', () => {
        Bookmarks.add(cell('XYZ'), 'my note');
        const all = Bookmarks.getAll();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ code: 'XYZ', lat: 22.7, lng: 75.8, note: 'my note' });
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toHaveLength(1);
    });

    it('refuses duplicate codes and warns', () => {
        Bookmarks.add(cell('DUP'));
        Bookmarks.add(cell('DUP'));
        expect(Bookmarks.getAll()).toHaveLength(1);
        expect(toasts.some(t => t.kind === 'warning')).toBe(true);
    });

    it('removes by code', () => {
        Bookmarks.add(cell('A'));
        Bookmarks.add(cell('B'));
        Bookmarks.remove('A');
        expect(Bookmarks.getAll().map(b => b.code)).toEqual(['B']);
    });

    it('updates a note in place and persists it', () => {
        Bookmarks.add(cell('N'));
        Bookmarks.updateNote('N', 'updated');
        expect(Bookmarks.getAll()[0].note).toBe('updated');
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY))[0].note).toBe('updated');
    });

    it('updateNote on an unknown code is a no-op', () => {
        Bookmarks.add(cell('N'));
        Bookmarks.updateNote('MISSING', 'x');
        expect(Bookmarks.getAll()[0].note).toBe('');
    });
});
