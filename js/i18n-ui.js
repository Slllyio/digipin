/**
 * I18nUI — Hindi phrase table for the rendered analysis UI (Intel, Lenses,
 * Compare, What-if, the Agents gallery and the right column).
 *
 * Those panels build their DOM from English literals in several thousand lines
 * of renderers, so rather than thread keys through every one of them, I18n
 * translates their text nodes after render (see I18n.translateTree). Lookup is
 * by exact trimmed English phrase, then by the patterns below for strings that
 * carry numbers or names. Anything unmatched stays English, which is what we
 * want for city names, DIGIPIN codes, units and dataset acronyms.
 */
const I18nUI = (() => {
    // Exact phrases live in data/i18n/<lang>-ui.json (≈45 kB of Devanagari),
    // fetched only when that language is switched on; see load().
    const URLS = { hi: 'data/i18n/hi-ui.json' };
    const tables = {};

    // Strings that carry numbers or names. `tr` translates a sub-phrase.
    const PATTERNS = [
        [/^([\d,.]+) built-up cells \(~([\d,.]+) km²\) of ([\d,.]+) on the grid\.?$/, m => `ग्रिड के ${m[3]} में से ${m[1]} निर्मित सेल (~${m[2]} km²)`],
        [/^Zones of (.+) \(~4 km\)$/, m => `${m[1]} के ज़ोन (~4 km)`],
        [/^(.+) across (\d+) cities$/, m => `${m[2]} शहरों में ${m[1]}`],
        [/^Rank 1 is best\. Precomputed (.+) with the same lenses\.$/, m => `रैंक 1 सबसे अच्छी है। ${m[1]} को इन्हीं लेंसों से पूर्व-गणना।`],
        [/^best of (\d+); worst (.+)$/, m => `${m[1]} में सबसे अच्छा; सबसे ख़राब ${m[2]}`],
        [/^best (.+)$/, m => `सबसे अच्छा ${m[1]}`],
        [/^(.+): (\d+) lenses over ([\d,]+) residents in ([\d,]+) cells$/, m => `${m[1]}: ${m[4]} सेलों में ${m[3]} निवासियों पर ${m[2]} लेंस`],
        [/^Green boost in the park cell: (.+) pts$/, m => `पार्क सेल में हरियाली बढ़त: ${m[1]} अंक`],
        [/^Residents with (\d+)\+ of (\d+) essentials on foot$/, m => `पैदल ${m[2]} में से ${m[1]}+ ज़रूरतों वाले निवासी`],
        [/^Residents below (\d+) junctions\/km²$/, m => `${m[1]} चौराहे/km² से कम वाले निवासी`],
        [/^Months a year above (.+)$/, m => `साल में ${m[1]} से ऊपर के महीने`],
        [/^#(\d+) · (\d+) months?$/, m => `#${m[1]} · ${m[2]} महीने`],
        [/^(.+) in (\S+) vs (.+) in (\S+)\. A (bigger move than usual|typical-sized move) for (.+) \(typical (.+)\); (\d+) cells? changed unusually\.$/,
            m => `${m[1]} (${m[2]}) बनाम ${m[3]} (${m[4]})। ${m[6]} के लिए ${m[5] === 'typical-sized move' ? 'सामान्य आकार का बदलाव' : 'सामान्य से बड़ा बदलाव'} (सामान्य ${m[7]}); ${m[8]} सेल असामान्य रूप से बदले।`],
        [/^(.+): ([\d.−-]+) \(rank (\d+)\)$/, (m, tr) => `${tr(m[1])}: ${m[2]} (रैंक ${m[3]})`],
        [/^(Livability|Flood risk) ([\d.]+) over (\d+) cells: show its insights$/, m => `${m[1] === 'Livability' ? 'रहने योग्यता' : 'बाढ़ जोखिम'} ${m[2]}, ${m[3]} सेलों में: इसकी जानकारी दिखाएँ`],
        [/^(evenly spread|unequal) across residents · top 10% ÷ bottom 40%: (.+)$/, m => `${m[1] === 'unequal' ? 'निवासियों में असमान' : 'निवासियों में समान रूप से फैला'} · शीर्ष 10% ÷ निचले 40%: ${m[2]}`],
        [/^Show (.+) as a 3D cell layer$/, (m, tr) => `${tr(m[1])} को 3D सेल परत के रूप में दिखाएँ`],
        [/^Open ([0-9A-Z-]+)$/, m => `${m[1]} खोलें`],
        [/^on the walking network for (.+) of residents$/, m => `${m[1]} निवासियों के लिए पैदल नेटवर्क पर`],
        [/^References: (.+)$/, m => `संदर्भ: ${m[1]}`],
        [/^Above (NAAQS|WHO) \((.+)\)$/, m => `${m[1]} से ऊपर (${m[2]})`],
        [/^(moderately|highly) unequal across residents · top 10% ÷ bottom 40%: (.+)$/, m => `निवासियों में ${m[1] === 'highly' ? 'अत्यधिक' : 'मध्यम'} असमान · शीर्ष 10% ÷ निचले 40%: ${m[2]}`],
        [/^Tree cover added: (.+) pts$/, m => `जोड़ा गया वृक्ष आवरण: ${m[1]} अंक`],
        [/^(Area|Cell) · (.+)$/, m => `${m[1] === 'Area' ? 'क्षेत्र' : 'सेल'} · ${m[2]}`],
        [/^Unusual (.+) in (\S+): ([\d,]+) cells$/, (m, tr) => `${m[2]} में असामान्य ${tr(m[1])}: ${m[3]} सेल`],
        [/^The map view: (.+)$/, (m, tr) => `मानचित्र दृश्य: ${tr(m[1])}`],
        [/^Residents below (\d+) junctions \/ km²$/, m => `${m[1]} चौराहे / km² से कम वाले निवासी`],
        [/^PM2\.5 per resident \(µg\/m³\), (.+) to (.+)$/, m => `प्रति निवासी PM2.5 (µg/m³), ${m[1]} से ${m[2]}`],
        [/^Daytime surface °C per resident, (.+) to (.+)$/, m => `प्रति निवासी दिन का सतही °C, ${m[1]} से ${m[2]}`],
        [/^Residents: (.+)$/, m => `निवासी: ${m[1]}`],
        [/^#(\d+) of (\d+) cities$/, m => `${m[2]} शहरों में #${m[1]}`],
        [/^(.*) year on year$/, m => `${m[1]} साल-दर-साल`],
        [/^Map (\d{4}(?:-\d{2})?)$/, m => `मानचित्र ${m[1]}`],
        [/^Outline the (\d+) most unusual of (\d+)$/, m => `${m[2]} में से ${m[1]} सबसे असामान्य रेखांकित करें`],
        [/^Outline (\d+) unusual cells$/, m => `${m[1]} असामान्य सेल रेखांकित करें`],
        [/^What changed · latest data (.+)$/, m => `क्या बदला · नवीनतम डेटा ${m[1]}`],
        [/^Combining datasets for (.+)…$/, m => `${m[1]} के लिए डेटासेट जोड़े जा रहे हैं…`],
        [/^Area: the map view, within (.+)\.$/, m => `क्षेत्र: मानचित्र दृश्य, ${m[1]} के भीतर।`],
        [/^Sources?: (.+)$/, (m, tr) => `स्रोत: ${m[1].split(' · ').map(tr).join(' · ')}`],
        [/^Show (.+) on the map \(use the time slider to play it\)$/, (m, tr) => `${tr(m[1])} मानचित्र पर दिखाएँ (चलाने के लिए टाइम स्लाइडर उपयोग करें)`],
        [/^Show (.+) on the map$/, (m, tr) => `${tr(m[1])} मानचित्र पर दिखाएँ`],
        [/^(.+) monthly$/, (m, tr) => `${tr(m[1])} मासिक`],
        [/^(.+) by step$/, (m, tr) => `${tr(m[1])} चरणवार`],
        [/^Weight: (.+) \(([↑↓])\)$/, (m, tr) => `भार: ${tr(m[1])} (${m[2]})`],
        [/^Best at (.+); weakest at (.+)\.$/, (m, tr) => `सबसे अच्छा: ${_list(m[1], tr)}; सबसे कमज़ोर: ${_list(m[2], tr)}।`],
        // Archetype labels: "Name: descriptor, descriptor"
        [/^([^:]+): ([a-z][^:]*)$/, (m, tr) => {
            const name = tr(m[1]);
            if (name === m[1]) return undefined;
            return `${name}: ${m[2].split(', ').map(tr).join(', ')}`;
        }],
    ];

    // "flood risk and education index" → each item translated with its index name.
    function _list(s, tr) {
        return s.split(/, | and /).map(part => {
            const title = part.replace(/\b\w/g, c => c.toUpperCase());
            const t = tr(title);
            return t === title ? part : t;
        }).join(', ');
    }

    /** The phrase table for a language, or null until load() has fetched it. */
    function table(lang) {
        return tables[lang] || null;
    }

    /** Fetch a language's phrases once; resolves to its table (or null offline). */
    const _loading = {};
    function load(lang) {
        if (tables[lang]) return Promise.resolve(tables[lang]);
        if (!URLS[lang] || typeof fetch !== 'function') return Promise.resolve(null);
        if (!_loading[lang]) {
            _loading[lang] = fetch(URLS[lang])
                .then(r => (r.ok ? r.json() : null))
                .then(phrases => {
                    if (phrases) tables[lang] = { phrases, patterns: PATTERNS };
                    return tables[lang] || null;
                })
                .catch(() => null)
                .finally(() => { delete _loading[lang]; });
        }
        return _loading[lang];
    }

    /** Install a phrase table directly (tests, or a bundled copy). */
    function register(lang, phrases) {
        tables[lang] = { phrases, patterns: PATTERNS };
    }

    return { table, load, register, PATTERNS };
})();

if (typeof window !== 'undefined') {
    window.I18nUI = I18nUI;
}
