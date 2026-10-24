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
            'tb.terrain': 'Terrain',
            'tb.sun': 'Sun',
            'tb.massing': 'Massing',
            'tb.pitch': 'Pitch',
            'tb.measure': 'Measure',
            'tb.present': 'Present',
            'tb.annotate': 'Annotate',
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
            'tb.emergency': 'Access',
            'tb.heat': 'Heat',
            'tb.ndvi': 'NDVI',
            'tb.bivariate': 'Bivariate',
            'tb.viewshed': 'Viewshed',
            'tb.hydrology': 'Hydrology',
            'tb.swipe': 'Swipe',
            'tb.sentinel': 'Sentinel-2',
            'tb.pointcloud': 'Point cloud',
            'tb.livenow': 'Live now',
            'tb.livesky': 'Live sky',
            'tb.places': 'Places',
            'tb.satpasses': 'Satellites',
            'tb.kde': 'Hotspot',
            'tb.access': '15-min',
            'tb.grid': 'Grid',
            // DISHA panel
            'disha.subtitle': 'India-native DIGIPIN intelligence • free & auditable',
            'disha.placeholder': 'Ask about this location...',
            'disha.send': 'Send message',
            'disha.stop': 'Stop generation',
            // City overview ribbon
            'co.eyebrow': 'Urban intelligence',
            'co.area': 'Area mapped',
            'co.scored': 'Scored cells',
            'co.core': 'Core cells',
            'co.heights': 'Height cells',
            'co.livability': 'Livability',
            'co.walkability': 'Walkability',
            'co.green': 'Green cover',
            'co.flood': 'Flood risk',
            'co.explore': 'Explore in 3D',
            'co.orbit': 'Orbit',
            'co.spread': 'Livability spread across {n} core cells (0–100)',
            'co.live': 'Scores load live when you click a cell.',
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
            'tb.terrain': 'भू-भाग',
            'tb.sun': 'सूर्य',
            'tb.massing': 'प्रस्तावित भवन',
            'tb.pitch': 'पिच मानचित्र',
            'tb.measure': 'मापें',
            'tb.present': 'प्रस्तुति',
            'tb.annotate': 'टिप्पणी',
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
            'tb.emergency': 'पहुँच',
            'tb.heat': 'गर्मी',
            'tb.ndvi': 'हरियाली',
            'tb.bivariate': 'द्विचर',
            'tb.viewshed': 'दृश्यक्षेत्र',
            'tb.hydrology': 'जलभराव',
            'tb.swipe': 'तुलना स्वाइप',
            'tb.sentinel': 'सेंटिनल-2',
            'tb.pointcloud': 'पॉइंट क्लाउड',
            'tb.livenow': 'अभी लाइव',
            'tb.livesky': 'लाइव आसमान',
            'tb.places': 'स्थान',
            'tb.satpasses': 'उपग्रह',
            'tb.kde': 'हॉटस्पॉट',
            'tb.access': '15-मिनट',
            'tb.grid': 'ग्रिड',
            'disha.subtitle': 'भारत-केंद्रित डिजीपिन इंटेलिजेंस • निःशुल्क व सत्यापन-योग्य',
            'disha.placeholder': 'इस स्थान के बारे में पूछें...',
            'disha.send': 'संदेश भेजें',
            'disha.stop': 'जनरेशन रोकें',
            'co.eyebrow': 'शहरी इंटेलिजेंस',
            'co.area': 'मैप किया गया क्षेत्र',
            'co.scored': 'स्कोर किए गए सेल',
            'co.core': 'मुख्य सेल',
            'co.heights': 'ऊँचाई सेल',
            'co.livability': 'रहने योग्यता',
            'co.walkability': 'पैदल सुगमता',
            'co.green': 'हरित आवरण',
            'co.flood': 'बाढ़ जोखिम',
            'co.explore': '3D में देखें',
            'co.orbit': 'परिक्रमा',
            'co.spread': 'रहने योग्यता का फैलाव — {n} मुख्य सेल (0–100)',
            'co.live': 'किसी सेल पर क्लिक करते ही स्कोर लाइव लोड होते हैं।',
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
        if (l === 'hi') { _ensureFont(); _ensurePhrases(l); }
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

    // ── Rendered-panel translation ────────────────────────────────────────
    // The analysis dialogs (Intel, Lenses, What-if, Agents) render English
    // literals; translateTree() swaps their text nodes and title/aria/
    // placeholder attributes through the I18nUI phrase table. Each node
    // remembers the English it came from and what we wrote, so switching back
    // restores English and a renderer rewriting a node is picked up as new
    // English rather than re-translated Hindi.
    const _textMemo = new WeakMap();   // Text node → { en, out }
    const _attrMemo = new WeakMap();   // Element → { attr: { en, out } }
    const ATTRS = ['title', 'aria-label', 'placeholder'];

    function _table(l) {
        return (typeof I18nUI !== 'undefined' && I18nUI.table) ? I18nUI.table(l) : null;
    }

    // Fetch the phrase table for a non-English language, then re-run the
    // open panels through it (the first switch to Hindi lands a beat later).
    function _ensurePhrases(l) {
        if (l === 'en' || typeof I18nUI === 'undefined' || !I18nUI.load || _table(l)) return;
        I18nUI.load(l).then(t => {
            if (!t || get() !== l || typeof document === 'undefined') return;
            document.querySelectorAll(PANEL_SELECTOR).forEach(el => translateTree(el, l));
        });
    }

    /** Translate one English UI phrase; unknown phrases come back unchanged. Pure. */
    function phrase(en, lang) {
        const l = normalize(lang !== undefined ? lang : get());
        const table = _table(l);
        if (!table || typeof en !== 'string') return en;
        const core = en.trim();
        if (!core) return en;
        const out = _lookup(core, table, 0);
        if (out === undefined || out === core) return en;
        return en.slice(0, en.indexOf(core)) + out + en.slice(en.indexOf(core) + core.length);
    }

    // Insight sentences lower-case field labels mid-sentence ("night-time LST");
    // index the phrase table the same way (UrbanInsights' lc rule) so those resolve.
    const _lcIndexes = new WeakMap();
    function _lcKey(str) {
        const cut = str.indexOf('(');
        const head = cut < 0 ? str : str.slice(0, cut), tail = cut < 0 ? '' : str.slice(cut);
        const keep = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;
        return head.split(' ').map(w => ((/^[A-Z][a-z]/.test(w) || /^[A-Z]$/.test(w)) && !keep.test(w) ? w.toLowerCase() : w)).join(' ') + tail;
    }
    function _lcLookup(text, table) {
        let idx = _lcIndexes.get(table);
        if (!idx) {
            idx = new Map();
            for (const [en, hi] of Object.entries(table.phrases)) { const k = _lcKey(en); if (k !== en && !idx.has(k)) idx.set(k, hi); }
            _lcIndexes.set(table, idx);
        }
        return idx.get(text);
    }

    function _lookup(core, table, depth) {
        if (Object.prototype.hasOwnProperty.call(table.phrases, core)) return table.phrases[core];
        if (depth > 0) { const lcHit = _lcLookup(core, table); if (lcHit !== undefined) return lcHit; }
        if (depth > 3) return undefined;
        const tr = s => { const r = _lookup(s, table, depth + 1); return r === undefined ? s : r; };
        for (const [re, fn] of table.patterns) {
            const m = core.match(re);
            if (!m) continue;
            const r = fn(m, tr);
            if (r !== undefined) return r;
        }
        // Several sentences: translate each, but only if every one has a
        // translation, so a paragraph never comes out half Hindi.
        if (depth === 0) {
            const clauses = (text, sep, re) => {
                const parts = text.split(re);
                if (parts.length < 2) return undefined;
                const out = parts.map(part => _lookup(part, table, 1)
                    ?? (sep === ' ' ? clauses(part, '; ', /(?<=;)\s+/) : undefined));
                return out.every(o => o !== undefined) ? out.join(sep) : undefined;
            };
            const r = clauses(core, ' ', /(?<=\.)\s+(?=[A-Z0-9“])/) ?? clauses(core, '; ', /(?<=;)\s+/);
            if (r !== undefined) return r;
        }
        // Leading symbol or emoji ("➕ Add to plan", "ⓘ Source"), then trailing punctuation.
        const lead = core.match(/^([^\p{L}\p{N}#←]+)(\p{L}.*)$/u);
        if (lead) { const r = _lookup(lead[2], table, depth + 1); if (r !== undefined) return lead[1] + r; }
        const tail = core.match(/^(.*?\p{L})([:.…]+)$/u);
        if (tail) { const r = _lookup(tail[1], table, depth + 1); if (r !== undefined) return r + tail[2]; }
        return undefined;
    }

    // Hindi → English for nodes another module rebuilt from already-translated
    // text (so they carry no memo), e.g. UIPolish splitting a chip's emoji off.
    let _reverse = null;
    function _unphrase(text) {
        const table = _table('hi');
        if (!table || !/[\u0900-\u097F]/.test(text)) return text;
        if (!_reverse) {
            _reverse = new Map();
            for (const [en, hi] of Object.entries(table.phrases)) if (!_reverse.has(hi)) _reverse.set(hi, en);
        }
        const core = text.trim();
        const en = _reverse.get(core);
        return en === undefined ? text : text.replace(core, en);
    }

    function _swapText(node, l) {
        const memo = _textMemo.get(node);
        const en = memo && node.nodeValue === memo.out ? memo.en : _unphrase(node.nodeValue);
        const out = l === 'en' ? en : phrase(en, l);
        if (node.nodeValue !== out) node.nodeValue = out;
        if (out !== en) _textMemo.set(node, { en, out });
        else _textMemo.delete(node);
    }

    function _swapAttrs(el, l) {
        let memo = _attrMemo.get(el);
        for (const a of ATTRS) {
            const v = el.getAttribute(a);
            if (v === null) continue;
            const m = memo && memo[a];
            const en = m && v === m.out ? m.en : v;
            const out = l === 'en' ? en : phrase(en, l);
            if (v !== out) el.setAttribute(a, out);
            if (out !== en) { memo = memo || {}; memo[a] = { en, out }; _attrMemo.set(el, memo); }
            else if (m) delete memo[a];
        }
    }

    /** Translate (or restore to English) every text node and label under root. */
    function translateTree(root, lang) {
        if (!root || typeof document === 'undefined') return;
        const l = normalize(lang !== undefined ? lang : get());
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
        nodes.forEach(n => {
            const p = n.parentNode;
            if (p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE' || p.isContentEditable)) return;
            _swapText(n, l);
        });
        if (root.nodeType === 1) _swapAttrs(root, l);
        if (root.querySelectorAll) root.querySelectorAll('[title],[aria-label],[placeholder]').forEach(el => _swapAttrs(el, l));
    }

    const PANEL_SELECTOR = '.ui-dialog, #aino-right, #sidebar, #detail-panel';
    const _watched = new WeakSet();
    let _bodyObserver = null;

    function _watchPanel(el) {
        if (_watched.has(el) || typeof MutationObserver === 'undefined') return;
        _watched.add(el);
        // Runs as a microtask after each render, before paint, so English never
        // flashes; takeRecords() drops the records our own writes produce.
        const obs = new MutationObserver(() => {
            if (get() === 'en') return;
            translateTree(el);
            obs.takeRecords();
        });
        obs.observe(el, { childList: true, subtree: true, characterData: true });
        if (get() !== 'en') translateTree(el);
    }

    /** Keep every analysis dialog (present and future) in the active language. */
    function watchPanels() {
        if (typeof document === 'undefined' || !document.body) return;
        document.querySelectorAll(PANEL_SELECTOR).forEach(_watchPanel);
        if (_bodyObserver || typeof MutationObserver === 'undefined') return;
        _bodyObserver = new MutationObserver(recs => recs.forEach(r => r.addedNodes.forEach(n => {
            if (n.nodeType === 1 && n.matches && n.matches(PANEL_SELECTOR)) _watchPanel(n);
        })));
        _bodyObserver.observe(document.body, { childList: true });
    }

    function set(lang) {
        const l = normalize(lang);
        try { localStorage.setItem(STORAGE_KEY, l); } catch { /* blocked */ }
        apply(l);
        if (typeof document !== 'undefined') {
            document.querySelectorAll(PANEL_SELECTOR).forEach(el => translateTree(el, l));
            try { document.dispatchEvent(new CustomEvent('digipin:language', { detail: { lang: l } })); } catch { /* old browsers */ }
        }
        return l;
    }

    /** Wire the top-bar language selector (lang itself is applied pre-paint). */
    function init() {
        const current = get();
        apply(current);
        if (typeof document === 'undefined') return;
        watchPanels();
        const sel = document.getElementById('lang-select');
        if (sel) {
            sel.value = current;
            sel.addEventListener('change', () => set(sel.value));
        }
    }

    return { init, get, set, apply, normalize, t, phrase, translateTree, watchPanels, langName, langNameEn, LANGS };
})();

if (typeof window !== 'undefined') {
    window.I18n = I18n;
}
