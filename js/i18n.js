/**
 * I18n — lightweight English/Hindi UI localization (MVP).
 *
 * Mirrors js/theme.js: a tiny persisted-preference module with get/set/apply +
 * a string lookup `t(key)`. The preference lives in localStorage
 * ('digipin_language') and is reflected as `<html lang="hi">` *pre-paint* by an
 * inline snippet in app.html (so the Devanagari font + RTL-safe rules apply with
 * no flash). This module is the runtime API around that.
 *
 * Scope (deliberate MVP): the **Tier-1, high-traffic surface** — top-bar +
 * toolbar labels, the search/DISHA placeholders, and the DISHA header. Elements
 * opt in declaratively:
 *
 *   <span data-i18n="tb.heatmap">Heatmap</span>          → textContent
 *   <input data-i18n-placeholder="search.placeholder">   → placeholder attr
 *   <button data-i18n-title="btn.share">                 → title attr
 *   <button data-i18n-aria="btn.share">                  → aria-label attr
 *
 * `apply()` walks those attributes and swaps text for the active language;
 * `t(key)` is pure (English fallback, then the key itself). Switching language
 * re-applies in place (no reload) and updates DISHA's "respond in" preference.
 * Full-app translation is a later expansion; this covers the visible chrome.
 */
const I18n = (() => {
    const STORAGE_KEY = 'digipin_language';
    const LANGS = ['en', 'hi'];
    const DEFAULT_LANG = 'en';

    // Human-readable names (for the selector + DISHA "respond in <lang>").
    const LANG_NAMES = { en: 'English', hi: 'हिन्दी' };
    const LANG_NAMES_EN = { en: 'English', hi: 'Hindi' };

    // Tier-1 string table. `en` is the source of truth; `hi` translates the same
    // keys. Missing hi keys fall back to en (then to the key) via t().
    const STRINGS = {
        en: {
            'app.logo': 'DigiPin Intelligence',
            'search.placeholder': 'Search DigiPin code or place name (e.g. Rajwada, Indore)',
            'btn.search': 'Search',
            'btn.share': 'Copy a shareable link to this view',
            'btn.theme': 'Switch theme',
            'lang.label': 'Language',
            // toolbar labels (match the .tb-label text in app.html)
            'tb.heatmap': 'Heatmap',
            'tb.wards': 'Wards',
            'tb.lcz': 'LCZ',
            'tb.buildings': 'Buildings',
            'tb.3d': '3D Mode',
            'tb.sun': 'Sun',
            'tb.pitch': 'Pitch',
            'tb.lulc': 'LULC',
            'tb.roads': 'Roads',
            'tb.layers': 'Layers',
            'tb.compare': 'Compare',
            'tb.saved': 'Saved',
            'tb.views': 'Views',
            'tb.growth': 'Growth',
            'tb.predict': 'Predict',
            'tb.scenario': 'Scenario',
            'tb.traffic': 'Traffic',
            'tb.mobility': 'L&O',
            'tb.heat': 'Heat',
            'tb.ndvi': 'NDVI',
            'tb.bivariate': 'Bivariate',
            'tb.viewshed': 'Viewshed',
            'tb.kde': 'Hotspot',
            'tb.access': '15-min',
            'tb.grid': 'Grid',
            // DISHA panel
            'disha.subtitle': 'India-native DIGIPIN intelligence • free & auditable',
            'disha.placeholder': 'Ask about this location...',
            'disha.send': 'Send message',
            'disha.stop': 'Stop generation',
        },
        hi: {
            'app.logo': 'डिजीपिन इंटेलिजेंस',
            'search.placeholder': 'डिजीपिन कोड या स्थान का नाम खोजें (जैसे राजवाड़ा, इंदौर)',
            'btn.search': 'खोजें',
            'btn.share': 'इस दृश्य का साझा करने योग्य लिंक कॉपी करें',
            'btn.theme': 'थीम बदलें',
            'lang.label': 'भाषा',
            'tb.heatmap': 'हीटमैप',
            'tb.wards': 'वार्ड',
            'tb.lcz': 'एलसीज़ेड',
            'tb.buildings': 'इमारतें',
            'tb.3d': '3डी मोड',
            'tb.sun': 'सूर्य',
            'tb.pitch': 'पिच मानचित्र',
            'tb.lulc': 'भू-उपयोग',
            'tb.roads': 'सड़कें',
            'tb.layers': 'परतें',
            'tb.compare': 'तुलना',
            'tb.saved': 'सहेजे',
            'tb.views': 'दृश्य',
            'tb.growth': 'विकास',
            'tb.predict': 'पूर्वानुमान',
            'tb.scenario': 'परिदृश्य',
            'tb.traffic': 'यातायात',
            'tb.mobility': 'कानून-व्यवस्था',
            'tb.heat': 'गर्मी',
            'tb.ndvi': 'हरियाली',
            'tb.bivariate': 'द्विचर',
            'tb.viewshed': 'दृश्यक्षेत्र',
            'tb.kde': 'हॉटस्पॉट',
            'tb.access': '15-मिनट',
            'tb.grid': 'ग्रिड',
            'disha.subtitle': 'भारत-केंद्रित डिजीपिन इंटेलिजेंस • निःशुल्क व सत्यापन-योग्य',
            'disha.placeholder': 'इस स्थान के बारे में पूछें...',
            'disha.send': 'संदेश भेजें',
            'disha.stop': 'जनरेशन रोकें',
        },
    };

    function normalize(value) {
        return LANGS.includes(value) ? value : DEFAULT_LANG;
    }

    function get() {
        try { return normalize(localStorage.getItem(STORAGE_KEY)); }
        catch { return DEFAULT_LANG; }
    }

    /** Look up a key in the active (or given) language; en fallback, then key. Pure. */
    function t(key, lang) {
        const l = normalize(lang !== undefined ? lang : get());
        return (STRINGS[l] && STRINGS[l][key]) || STRINGS.en[key] || key;
    }

    /** Human name of a language, in that language (for the selector). */
    function langName(lang) {
        return LANG_NAMES[normalize(lang)] || LANG_NAMES[DEFAULT_LANG];
    }

    /** Human name of a language, in English (for DISHA "respond in <lang>"). */
    function langNameEn(lang) {
        return LANG_NAMES_EN[normalize(lang !== undefined ? lang : get())] || LANG_NAMES_EN[DEFAULT_LANG];
    }

    // Inject the Devanagari webfont once, and only when Hindi is actually used —
    // English users (the majority) shouldn't pay a third-party Google Fonts
    // request for a font that never renders. Idempotent (guards on the id).
    const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;500;600;700&display=swap';
    function _ensureFont() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('i18n-deva-font')) return;
        const link = document.createElement('link');
        link.id = 'i18n-deva-font';
        link.rel = 'stylesheet';
        link.href = FONT_HREF;
        document.head.appendChild(link);
    }

    /** Swap every opted-in element to the active (or given) language. */
    function apply(lang) {
        if (typeof document === 'undefined') return;
        const l = normalize(lang !== undefined ? lang : get());
        document.documentElement.setAttribute('lang', l);
        if (l === 'hi') _ensureFont();
        document.querySelectorAll('[data-i18n]').forEach(el => {
            el.textContent = t(el.getAttribute('data-i18n'), l);
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), l));
        });
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            el.setAttribute('title', t(el.getAttribute('data-i18n-title'), l));
        });
        document.querySelectorAll('[data-i18n-aria]').forEach(el => {
            el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'), l));
        });
    }

    function set(lang) {
        const l = normalize(lang);
        try { localStorage.setItem(STORAGE_KEY, l); } catch { /* blocked */ }
        apply(l);
        return l;
    }

    /** Wire the top-bar language selector (lang itself is applied pre-paint). */
    function init() {
        const current = get();
        apply(current);
        if (typeof document === 'undefined') return;
        const sel = document.getElementById('lang-select');
        if (sel) {
            sel.value = current;
            sel.addEventListener('change', () => set(sel.value));
        }
    }

    return { init, get, set, apply, normalize, t, langName, langNameEn, LANGS };
})();

if (typeof window !== 'undefined') {
    window.I18n = I18n;
}
