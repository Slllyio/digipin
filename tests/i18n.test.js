import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// I18n is exposed on globalThis by tests/setup.js. t()/normalize()/langNameEn()
// are pure; get/set/apply touch localStorage + the DOM (jsdom provides both).
const I = globalThis.I18n;

describe('I18n.t / normalize', () => {
    it('returns the Hindi string for a known key', () => {
        expect(I.t('tb.heatmap', 'hi')).toBe('हीटमैप');
        expect(I.t('tb.heatmap', 'en')).toBe('Heatmap');
    });

    it('falls back to English when a key is missing in the target language', () => {
        // 'app.logo' exists in both, but force the fallback path with a bogus lang.
        expect(I.t('tb.wards', 'xx')).toBe('Wards');
    });

    it('falls back to the key itself when it is unknown everywhere', () => {
        expect(I.t('does.not.exist', 'hi')).toBe('does.not.exist');
    });

    it('normalizes unknown languages to the default (en)', () => {
        expect(I.normalize('fr')).toBe('en');
        expect(I.normalize('hi')).toBe('hi');
        expect(I.normalize(null)).toBe('en');
    });

    it('langNameEn gives the English name for DISHA prompts', () => {
        expect(I.langNameEn('hi')).toBe('Hindi');
        expect(I.langNameEn('en')).toBe('English');
        expect(I.langNameEn('xx')).toBe('English');
    });
});

describe('I18n.set / get / apply (DOM)', () => {
    beforeEach(() => {
        try { localStorage.clear(); } catch { /* ignore */ }
        document.documentElement.removeAttribute('lang');
        document.body.innerHTML =
            '<span data-i18n="tb.heatmap">Heatmap</span>' +
            '<input data-i18n-placeholder="search.placeholder">' +
            '<button data-i18n-title="btn.share" data-i18n-aria="btn.share"></button>';
    });
    afterEach(() => {
        try { localStorage.clear(); } catch { /* ignore */ }
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('lang');
    });

    it('set persists the choice and apply swaps text/placeholder/title/aria', () => {
        expect(I.set('hi')).toBe('hi');
        expect(I.get()).toBe('hi');
        expect(document.documentElement.getAttribute('lang')).toBe('hi');
        expect(document.querySelector('[data-i18n]').textContent).toBe('हीटमैप');
        expect(document.querySelector('input').getAttribute('placeholder'))
            .toBe(I.t('search.placeholder', 'hi'));
        const btn = document.querySelector('button');
        expect(btn.getAttribute('title')).toBe(I.t('btn.share', 'hi'));
        expect(btn.getAttribute('aria-label')).toBe(I.t('btn.share', 'hi'));
    });

    it('switching back to English restores the English chrome', () => {
        I.set('hi');
        I.set('en');
        expect(I.get()).toBe('en');
        expect(document.querySelector('[data-i18n]').textContent).toBe('Heatmap');
    });

    it('defaults to en when nothing is stored', () => {
        expect(I.get()).toBe('en');
    });
});
