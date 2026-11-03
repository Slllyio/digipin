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

    // Sentence templates: {n} matches a number (Indian grouping, optional
    // lakh/crore), {w} any short phrase. Captures arrive in order as m[1..].
    const NUM = '(-?[\\d.,]+(?: lakh| crore)?)';
    function T(template, fn) {
        const src = template.split(/(\{n\}|\{w\})/).map(part => {
            if (part === '{n}') return NUM;
            if (part === '{w}') return '(.+?)';
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('');
        return [new RegExp('^' + src + '$'), fn];
    }
    // "12.8 lakh" → "12.8 लाख"
    const n = s => String(s).replace(/ lakh$/, ' लाख').replace(/ crore$/, ' करोड़');
    const WORDS = {
        hotter: 'अधिक गर्म', cooler: 'ठंडी', warmer: 'अधिक गर्म',
        'mostly infill (compact)': 'ज़्यादातर भराव (सघन)', 'leapfrogging (sprawling)': 'छलाँग (फैलाव)',
        'mostly edge expansion': 'ज़्यादातर किनारे पर विस्तार', 'agrees with': 'मेल खाता है', 'partly agrees with': 'आंशिक रूप से मेल खाता है',
        'differs from': 'अलग है',
        'many people, little healthcare in reach, good road access, out of the floodplain': 'अधिक लोग, पहुँच में कम स्वास्थ्य सेवा, अच्छी सड़क पहुँच, बाढ़ क्षेत्र से बाहर',
        'dense, few schools within a walk, walkable streets, out of the floodplain': 'सघन, पैदल दूरी में कम स्कूल, पैदल योग्य सड़कें, बाढ़ क्षेत्र से बाहर',
        'heat-vulnerable, few trees, dense, no leisure space nearby': 'गर्मी-संवेदनशील, कम पेड़, सघन, पास में कोई मनोरंजन स्थल नहीं',
        'heat-vulnerable, roof-dense, many residents': 'गर्मी-संवेदनशील, घनी छतें, अधिक निवासी',
        'busy (bright at night), on major roads, many residents': 'व्यस्त (रात में रोशन), मुख्य सड़कों पर, अधिक निवासी',
    };
    const w = s => WORDS[s] || s;

    // Lens findings, one template per sentence (I18n splits multi-sentence text).
    const SENTENCES = [
        T('{n} people ({n}% of residents) live in the city’s most heat-vulnerable tenth of neighbourhoods, where surfaces run {n} °C {w} by day and tree canopy is {n}% against {n}% city-wide.',
            m => `${n(m[1])} लोग (निवासियों का ${m[2]}%) शहर के सबसे गर्मी-संवेदनशील दसवें हिस्से के मोहल्लों में रहते हैं, जहाँ दिन में सतह ${m[3]} °C ${w(m[4])} रहती है और वृक्ष-छत्र ${m[5]}% है, जबकि पूरे शहर में ${m[6]}%।`),
        T('{n} people ({n}% of residents) live in the city’s most heat-vulnerable tenth of neighbourhoods.',
            m => `${n(m[1])} लोग (निवासियों का ${m[2]}%) शहर के सबसे गर्मी-संवेदनशील दसवें हिस्से के मोहल्लों में रहते हैं।`),
        T('{n} people ({n}% of residents) live in the 100-year floodplain, {n} of them where floods come about once a decade.',
            m => `${n(m[1])} लोग (निवासियों का ${m[2]}%) 100-वर्षीय बाढ़ क्षेत्र में रहते हैं, जिनमें से ${n(m[3])} वहाँ जहाँ लगभग हर दशक बाढ़ आती है।`),
        T('{n} people ({n}% of residents) live in the 100-year floodplain.',
            m => `${n(m[1])} लोग (निवासियों का ${m[2]}%) 100-वर्षीय बाढ़ क्षेत्र में रहते हैं।`),
        T('{n}% of residents can walk to at least {n} of {n} daily essentials within 15 minutes; {w} is the one most often out of reach ({n} people).',
            (m, tr) => `${m[1]}% निवासी 15 मिनट में ${m[3]} में से कम से कम ${m[2]} रोज़मर्रा की ज़रूरतों तक पैदल पहुँच सकते हैं; ${tr(m[4])} सबसे अधिक पहुँच से बाहर रहता है (${n(m[5])} लोग)।`),
        T('{n} people ({n}% of residents) have no mapped healthcare within {n} km; the typical resident shares each nearby facility with {n} others.',
            m => `${n(m[1])} लोगों (निवासियों का ${m[2]}%) के ${m[3]} km के भीतर कोई मैप की गई स्वास्थ्य सेवा नहीं है; आम निवासी हर पास की सुविधा ${n(m[4])} अन्य लोगों के साथ साझा करता है।`),
        T('The average resident breathes {n} µg/m³ of PM2.5 ({n}× the WHO guideline); {n} people ({n}%) live above India’s annual standard of {n}.',
            m => `औसत निवासी ${m[1]} µg/m³ PM2.5 में साँस लेता है (WHO दिशानिर्देश का ${m[2]}×); ${n(m[3])} लोग (${m[4]}%) भारत के ${m[5]} के वार्षिक मानक से ऊपर रहते हैं।`),
        T('Night lights rise {n}% for each 1% more residents (R² {n}).',
            m => `हर 1% अधिक निवासियों पर रात की रोशनी ${m[1]}% बढ़ती है (R² ${m[2]})।`),
        T('{n} cells glow well above their residents (activity hubs); {n} dense cells with {n} people are under-lit for their size.',
            m => `${m[1]} सेल अपने निवासियों से कहीं ज़्यादा रोशन हैं (गतिविधि केंद्र); ${n(m[3])} लोगों वाले ${m[2]} सघन सेल अपने आकार के हिसाब से कम रोशन हैं।`),
        T('{n} people ({n}%) carry two or more of the city’s worst heat, flood and air burdens; {n} carry all {n}.',
            m => `${n(m[1])} लोग (${m[2]}%) शहर के सबसे बुरे गर्मी, बाढ़ और वायु बोझों में से दो या अधिक झेलते हैं; ${n(m[3])} सभी ${m[4]} झेलते हैं।`),
        T('{n} people ({n}%) live where streets have fewer than {n} junctions per km² (the LEED-ND connectivity bar); the most walkable fifth of cells has {n} per km², the least {n}.',
            m => `${n(m[1])} लोग (${m[2]}%) वहाँ रहते हैं जहाँ सड़कों पर प्रति km² ${m[3]} से कम चौराहे हैं (LEED-ND कनेक्टिविटी मानक); सबसे पैदल योग्य पाँचवें हिस्से में प्रति km² ${m[4]}, सबसे कम में ${m[5]}।`),
        T('The index {w} the OSM walkability score (r = {n}).',
            m => `यह सूचकांक OSM पैदल योग्यता स्कोर से ${w(m[1])} (r = ${m[2]})।`),
        T('{n} km² of land was newly built 2016–2023, {w}: {n}% infill, {n}% at the edge, {n}% leapfrog.',
            m => `2016–2023 में ${m[1]} km² भूमि नई निर्मित हुई, ${w(m[2])}: ${m[3]}% भराव, ${m[4]}% किनारे पर, ${m[5]}% छलाँग।`),
        T('Density falls {n}% per km from the centre (Clark gradient {n}/km).',
            m => `केंद्र से हर km पर घनत्व ${m[1]}% घटता है (क्लार्क प्रवणता ${m[2]}/km)।`),
        T('Too little new built-up land 2016–2023 to classify growth.', () => '2016–2023 में विकास वर्गीकृत करने के लिए बहुत कम नई निर्मित भूमि।'),
        T('The urban fabric ({n} cells at ≥ {n} people/km²) sorts into {n} kinds of place; the most lived-in are “{w}” ({n}% of residents) and “{w}” ({n}%).',
            (m, tr) => `शहरी ताना-बाना (≥ ${m[2]} लोग/km² वाले ${m[1]} सेल) ${m[3]} तरह की जगहों में बँटता है; सबसे ज़्यादा आबाद हैं “${tr(m[4])}” (निवासियों का ${m[5]}%) और “${tr(m[6])}” (${m[7]}%)।`),
        T('{n}% of residents have 30% tree canopy around home and {n}% have green space within 300 m; {n} people ({n}%) meet neither.',
            m => `${m[1]}% निवासियों के घर के आसपास 30% वृक्ष-छत्र है और ${m[2]}% के 300 m के भीतर हरित स्थान है; ${n(m[3])} लोग (${m[4]}%) दोनों में से कोई शर्त पूरी नहीं करते।`),
        T('Roofs covering {n} km² could host about {n} GW of solar and make {n} GWh a year, {n}% of what the city’s residents use (at {n} kWh each).',
            m => `${m[1]} km² की छतों पर लगभग ${m[2]} GW सौर ऊर्जा लग सकती है जो साल में ${m[3]} GWh बनाएगी, शहर के निवासियों की खपत का ${m[4]}% (प्रति व्यक्ति ${m[5]} kWh पर)।`),
        T('OpenStreetMap maps about {n}% of the buildings Open Buildings sees where the average resident lives; {n} people ({n}%) live where it maps under half, so amenity-based lenses there are lower bounds.',
            m => `जहाँ औसत निवासी रहता है, वहाँ OpenStreetMap लगभग ${m[1]}% इमारतें मैप करता है जो Open Buildings में दिखती हैं; ${n(m[2])} लोग (${m[3]}%) वहाँ रहते हैं जहाँ यह आधे से कम मैप करता है, इसलिए वहाँ सुविधा-आधारित लेंस न्यूनतम अनुमान हैं।`),
        T('The average resident lives through {n} month(s) a year when PM2.5 averages over 60 µg/m³ (worst {w}, {n} µg/m³).',
            m => `औसत निवासी साल में ${m[1]} महीने ऐसे झेलता है जब PM2.5 का औसत 60 µg/m³ से ऊपर होता है (सबसे ख़राब ${m[2]}, ${m[3]} µg/m³)।`),
        T('The average resident lives through {n} month(s) a year when PM2.5 averages over 60 µg/m³.',
            m => `औसत निवासी साल में ${m[1]} महीने ऐसे झेलता है जब PM2.5 का औसत 60 µg/m³ से ऊपर होता है।`),
        T('{n} people ({n}%) live where the month-average daytime surface tops 40 °C in three or more months; nights ran {n} °C {w} than the year before.',
            m => `${n(m[1])} लोग (${m[2]}%) वहाँ रहते हैं जहाँ तीन या अधिक महीनों में दिन की औसत सतह 40 °C से ऊपर जाती है; रातें पिछले साल से ${m[3]} °C ${w(m[4])} रहीं।`),
        T('{n} people ({n}%) live where the month-average daytime surface tops 40 °C in three or more months.',
            m => `${n(m[1])} लोग (${m[2]}%) वहाँ रहते हैं जहाँ तीन या अधिक महीनों में दिन की औसत सतह 40 °C से ऊपर जाती है।`),
        T('The {n} best-placed sites (≥ {n} km apart) favour {w}; together they would sit within {n} km of {n} residents.',
            m => `${m[1]} सबसे उपयुक्त स्थल (≥ ${m[2]} km दूर) इन्हें प्राथमिकता देते हैं: ${w(m[3])}; मिलकर वे ${n(m[5])} निवासियों से ${m[4]} km के भीतर होंगे।`),
        T('The {n} best-placed sites (≥ {n} km apart) favour {w}; their cells hold {n} residents.',
            m => `${m[1]} सबसे उपयुक्त स्थल (≥ ${m[2]} km दूर) इन्हें प्राथमिकता देते हैं: ${w(m[3])}; उनके सेलों में ${n(m[4])} निवासी हैं।`),
        T('No cell passes the constraints.', () => 'कोई सेल शर्तें पूरी नहीं करता।'),
        // Here tab (UrbanInsights.areaInsights)
        T('Nothing here stands out from the {w} average in the published data.', m => `प्रकाशित डेटा में यहाँ कुछ भी ${m[1]} के औसत से अलग नहीं दिखता।`),
        [/^(.+?) ((?:stands out for|lags on) .+) compared with (.+)\.$/, (m, tr) => {
            const list = x => x.split(' and ').map(tr).join(' और ');
            const parts = m[2].split(/, (?=but lags on|and )/).map(p => {
                let k = p.match(/^stands out for (.+)$/); if (k) return `${list(k[1])} में आगे`;
                k = p.match(/^(?:but )?lags on (.+)$/); if (k) return `${list(k[1])} में पीछे`;
                k = p.match(/^and (.+) is (rising|falling)$/); if (k) return `${tr(k[1])} ${k[2] === 'rising' ? 'बढ़ रहा है' : 'घट रहा है'}`;
                return null;
            });
            if (parts.some(x => x == null)) return undefined;
            return `${tr(m[1])}, ${m[3]} की तुलना में: ${parts.join(', ')}।`;
        }],
        T('The neighbourhood {w}', m => `मोहल्ला ${m[1]}`),
        T('The cell {w}', m => `सेल ${m[1]}`),
        T('Around {w}', m => `${m[1]} के आसपास`),
        T('the area around {w}', m => `${m[1]} के आसपास का क्षेत्र`),
        [/^(.+) (above|below) the (.+) average$/, (m, tr) => `${tr(m[1])} ${m[3]} के औसत से ${m[2] === 'above' ? 'ऊपर' : 'नीचे'}`],
        [/^(.+) ([\d.]+)× the (.+) average$/, (m, tr) => `${tr(m[1])} ${m[3]} के औसत का ${m[2]}×`],
        [/^(.+) (\d+)% below the (.+) average$/, (m, tr) => `${tr(m[1])} ${m[3]} के औसत से ${m[2]}% कम`],
        [/^(.+?)( \(12-month mean\))? is (.+) here across (\d+) cells?, vs (.+) for (.+) \((\d+) cells\)(?:, (top|bottom) (\d+)% of the city)?\.$/,
            (m, tr) => `${tr(m[1])}${m[2] ? ' (12-महीने का औसत)' : ''} यहाँ ${m[4]} सेलों में ${m[3]} है, जबकि ${m[6]} में ${m[5]} (${m[7]} सेल)${m[8] ? `, शहर के ${m[8] === 'top' ? 'शीर्ष' : 'निचले'} ${m[9]}% में` : ''}।`],
        [/^(\d+) of (\d+) cells in (\S+) are in (.+)'s (highest|lowest|best|worst) 10% for (.+) \(mean (.+)\)\.$/,
            (m, tr) => `${m[3]} के ${m[2]} में से ${m[1]} सेल ${m[4]} के ${{ highest: 'सबसे ऊँचे', lowest: 'सबसे निचले', best: 'सबसे अच्छे', worst: 'सबसे ख़राब' }[m[5]]} 10% में हैं: ${tr(m[6])} (औसत ${m[7]})।`],
        [/^(\d+)% of cells: (.+)$/, (m, tr) => `${m[1]}% सेल: ${tr(m[2])}`],
        [/^([\d.,]+) (lakh|crore)$/, m => n(`${m[1]} ${m[2]}`)],
        [/^([\d.,]+ (?:lakh|crore)?) ?\(([\d.]+%)\)$/, m => `${n(m[1].trim())} (${m[2]})`],
        [/^([\d.,]+) \(([\d.,]+(?: lakh| crore)?) people\)$/, m => `${m[1]} (${n(m[2])} लोग)`],
        T('{n}% of residents · {n} cells', m => `निवासियों का ${m[1]}% · ${m[2]} सेल`),
        T('… {n} more', m => `… ${m[1]} और`),
        T('{n} (consistent)', m => `${m[1]} (संगत)`),
        T('{n} (review weights)', m => `${m[1]} (भार जाँचें)`),
        T('{n} per km (R² {n})', m => `प्रति km ${m[1]} (R² ${m[2]})`),
        T('Zone {w}: {n} over {n} cells.', m => `ज़ोन ${m[1]}: ${m[3]} सेलों पर ${m[2]}।`),
        T('Click to fly there; open Here for its insights.', () => 'वहाँ जाने के लिए क्लिक करें; जानकारी के लिए "यहाँ" खोलें।'),
        T('Local Moran’s I (p ≤ 0.05): {n} high-high, {n} low-low clusters; {n} high-low and {n} low-high outliers (outlined; outliers in amber/indigo).',
            m => `लोकल मोरान I (p ≤ 0.05): ${m[1]} उच्च-उच्च, ${m[2]} निम्न-निम्न समूह; ${m[3]} उच्च-निम्न और ${m[4]} निम्न-उच्च अपवाद (रेखांकित; अपवाद एम्बर/इंडिगो में)।`),
        T('{n} cells here changed by 2+ standard deviations more than the city\'s cells between {w} and {w}.',
            m => `यहाँ ${m[1]} सेल ${m[2]} और ${m[3]} के बीच शहर के सेलों से 2+ मानक विचलन ज़्यादा बदले।`),
        T('Largest: {w}, {w} (z = {n}).', m => `सबसे बड़ा: ${m[1]}, ${m[2]} (z = ${m[3]})।`),
        T('{n} datasets · {n} cell values compared with {w} · {n} smaller findings hidden',
            m => `${m[1]} डेटासेट · ${m[3] === 'the city' ? 'शहर' : m[3]} से तुलना किए गए ${m[2]} सेल मान · ${m[4]} छोटे निष्कर्ष छिपे`),
        T('{w} comes out ahead on {n} of {n} indicators that have a better direction (notably {w})',
            m => `बेहतर दिशा वाले ${m[3]} संकेतकों में से ${m[2]} पर ${m[1]} आगे है (ख़ासकर ${m[4]})`),
        T('{w} leads on {n} ({w}).', m => `${m[1]} ${m[2]} पर आगे है (${m[3]})।`),
        T('Weighted-overlay multi-criteria decision analysis: each criterion is a within-city percentile rank (direction-corrected), weighted by AHP from a pairwise comparison matrix (consistency ratio {n}); flood-prone cells (hazard ≥ 60) are excluded where it matters. Candidate sites are the top-scoring cells at least {n} km apart.',
            m => `भारित-ओवरले बहु-मानदंड निर्णय विश्लेषण: हर मानदंड शहर के भीतर प्रतिशतक रैंक है (दिशा-सुधारित), युग्मित तुलना मैट्रिक्स से AHP द्वारा भारित (संगति अनुपात ${m[1]}); जहाँ ज़रूरी हो, बाढ़-प्रवण सेल (खतरा ≥ 60) बाहर रखे जाते हैं। संभावित स्थल कम से कम ${m[2]} km दूर सबसे ऊँचे स्कोर वाले सेल हैं।`),
        T('Moran’s I {n} (z {n}) · {n} hot, {n} cold cells (Gi*, 95%)',
            m => `मोरान I ${m[1]} (z ${m[2]}) · ${m[3]} हॉट, ${m[4]} कोल्ड सेल (Gi*, 95%)`),
        T('Gini {n}', m => `गिनी ${m[1]}`),
        T('{n} zones · {w} mean {n}.', m => `${m[1]} ज़ोन · ${m[2]} औसत ${m[3]}।`),
        T('Mean of each zone’s ~975 m cells (zones with at least 3 cells), built-up cells only.', () => 'हर ज़ोन के ~975 m सेलों का औसत (कम से कम 3 सेल वाले ज़ोन), केवल निर्मित सेल।'),
        T('Rank 1 is the best.', () => 'रैंक 1 सबसे अच्छी है।'),
        T('Rank 1 is best.', () => 'रैंक 1 सबसे अच्छी है।'),
        [/^score ([\d.]+) · (.+)$/, (m, tr) => `स्कोर ${m[1]} · ${m[2].split('; ').map(part => {
            const k = part.match(/^(.+) (-?[\d.,]+)$/);
            return k ? `${tr(k[1])} ${k[2]}` : tr(part);
        }).join('; ')}`],
        [/^Run query: (.+)$/, (m, tr) => `क्वेरी चलाएँ: ${tr(m[1])}`],
        [/^Urban Queries \((\d+)\)$/, m => `शहरी क्वेरी (${m[1]})`],
    ];

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
                    if (phrases) tables[lang] = { phrases, patterns: SENTENCES.concat(PATTERNS) };
                    return tables[lang] || null;
                })
                .catch(() => null)
                .finally(() => { delete _loading[lang]; });
        }
        return _loading[lang];
    }

    /** Install a phrase table directly (tests, or a bundled copy). */
    function register(lang, phrases) {
        tables[lang] = { phrases, patterns: SENTENCES.concat(PATTERNS) };
    }

    return { table, load, register, PATTERNS };
})();

if (typeof window !== 'undefined') {
    window.I18nUI = I18nUI;
}
