/**
 * LensSearch — find the urban lenses that bear on a free-form question, so
 * DISHA's model can ground an answer in computed results instead of guessing.
 *
 * DishaIntel's regex router sends a question to at most one lens; most
 * questions people type ("is it safe to buy a flat near the lake in
 * Bellandur?") touch several. search() scores every lens in
 * UrbanLenses.catalog() on the question's words (title ×3, question ×2,
 * method ×1, with a small synonym table for everyday words) and puts the
 * lenses whose DISHA route matches first. context() runs the top few for the
 * city in view and renders their headlines, key stats, the selected area
 * against the city, and the city's rank among the 13, as a prompt block.
 */
const LensSearch = (() => {
    const STOP = new Set(('a an the of in on at to for from by with and or is are was were be been it its this that these those my our your their ' +
        'i we you they me us what which who whom where when why how much many more most less least do does did can could should would will ' +
        'there here than then as if so not no any some all very about near around into over under city area areas place places part parts ' +
        'tell show give get me please like kind sort get got have has had live living').split(' '));

    // Everyday words people use -> words the lens catalogue uses.
    const SYN = {
        pollution: ['air', 'pm2', 'no2', 'smog', 'haze'], polluted: ['air', 'pm2'], smog: ['air', 'haze', 'pm2'], aqi: ['air', 'pm2'],
        breathe: ['air'], dust: ['air', 'pm2', 'dust'],
        flat: ['housing', 'home', 'homes'], apartment: ['housing', 'home'], house: ['housing', 'home'], buy: ['value', 'price', 'property'],
        rent: ['rental', 'rent'], invest: ['value', 'growth', 'property'], investment: ['value', 'growth', 'property'], price: ['value', 'price'],
        cheap: ['affordab', 'value'], afford: ['affordab'], expensive: ['value', 'premium'],
        flood: ['flood', 'waterlog'], flooding: ['flood', 'waterlog'], waterlogging: ['waterlog', 'flood'], rain: ['rain', 'flood'],
        hot: ['heat', 'temperature'], heat: ['heat', 'temperature'], summer: ['heat'], cool: ['cool', 'shade', 'tree'],
        tree: ['tree', 'green', 'canopy'], trees: ['tree', 'green', 'canopy'], green: ['green', 'park', 'tree'], park: ['park', 'green', 'open'],
        water: ['water', 'groundwater', 'lake'], lake: ['lake', 'water'], groundwater: ['groundwater', 'well'], borewell: ['groundwater', 'well'],
        safe: ['safety', 'crime', 'risk', 'hazard'], safety: ['safety', 'crime', 'risk'], crime: ['crime', 'police'], risk: ['risk', 'hazard'],
        earthquake: ['quake', 'seismic'], quake: ['quake'],
        school: ['school', 'education'], schools: ['school', 'education'], college: ['college', 'education'], hospital: ['hospital', 'health', 'care'],
        doctor: ['health', 'care'], clinic: ['health', 'care', 'clinic'], health: ['health', 'care'],
        traffic: ['traffic', 'road', 'congestion'], commute: ['commute', 'job', 'transit'], bus: ['bus', 'transit'], metro: ['metro', 'rail', 'transit'],
        train: ['rail', 'train'], walk: ['walk', 'foot'], walking: ['walk', 'foot'], cycle: ['cycl'], parking: ['parking'],
        noise: ['noise', 'quiet'], noisy: ['noise'], quiet: ['noise', 'quiet'],
        jobs: ['job', 'work'], job: ['job', 'work'], work: ['job', 'work'], shops: ['shop', 'market', 'commercial'], market: ['market', 'commercial'],
        slum: ['slum', 'informal'], slums: ['slum', 'informal'], poor: ['deprivation', 'poverty', 'informal'], poverty: ['deprivation', 'poverty'],
        rich: ['wealth', 'premium'], wealthy: ['wealth', 'premium'],
        kids: ['child', 'school', 'play'], children: ['child', 'school', 'play'], elderly: ['elderly', 'old'], women: ['women'],
        electricity: ['power', 'blackout'], power: ['power', 'blackout'], outage: ['blackout', 'power'],
        garbage: ['waste', 'dump', 'landfill'], waste: ['waste', 'dump'], sewage: ['sewer', 'sewage', 'stp'], drains: ['drain'],
        build: ['build', 'construction'], construction: ['construction', 'build'], growth: ['growth', 'grow'], grow: ['growth', 'grow'],
        climate: ['climate', 'heat', 'flood'], carbon: ['co2', 'carbon', 'emission'], emissions: ['emission', 'co2'],
        population: ['resident', 'population', 'people'], crowded: ['density', 'crowd', 'packed'], dense: ['density'],
        old: ['old', 'heritage', 'age'], history: ['since', 'old', 'heritage'],
    };

    const _stem = w => w.replace(/(ings|ing|ies|es|s|ed)$/, (m) => (m === 'ies' ? 'y' : '')).slice(0, 12);

    /** Lower-case content words of a string, stemmed. Pure. */
    function tokens(s) {
        return String(s || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9.]+/)
            .map(w => w.replace(/\.+$/, '')).filter(w => w.length > 1 && !STOP.has(w));
    }

    /** Query words plus their synonyms, each stemmed, with weights (own word 1, synonym 0.6). Pure. */
    function expand(q) {
        const out = new Map();
        for (const w of tokens(q)) {
            const s = _stem(w);
            out.set(s, Math.max(out.get(s) || 0, 1));
            for (const x of SYN[w] || SYN[s] || []) {
                const t = _stem(x);
                out.set(t, Math.max(out.get(t) || 0, 0.6));
            }
        }
        return out;
    }

    const _docCache = new WeakMap();
    function _docs(catalog) {
        let d = _docCache.get(catalog);
        if (d) return d;
        d = catalog.map(l => ({
            id: l.id,
            parts: [[l.title, 3], [l.question, 2], [l.method, 1]].map(([t, wt]) => [new Set(tokens(t).map(_stem)), wt]),
        }));
        // inverse document frequency over the catalogue, so 'residents' or 'block' count for little
        const df = new Map();
        for (const x of d) {
            const all = new Set();
            for (const [set] of x.parts) for (const t of set) all.add(t);
            for (const t of all) df.set(t, (df.get(t) || 0) + 1);
        }
        d.idf = t => Math.log(1 + d.length / (1 + (df.get(t) || 0)));
        _docCache.set(catalog, d);
        return d;
    }

    /** True when a stemmed query term matches a document term (exact, or a shared prefix of 5+ letters). */
    function _hit(set, t) {
        if (set.has(t)) return true;
        if (t.length < 5) return false;
        for (const x of set) if (x.length >= 5 && (x.startsWith(t) || t.startsWith(x))) return true;
        return false;
    }

    /**
     * Rank lenses for a question: [{ id, title, question, score }], best first.
     * `routed` lens ids (DishaIntel.lensHits) are boosted to the top. Pure.
     */
    function search(q, catalog, opts = {}) {
        const limit = opts.limit || 6, routed = opts.routed || [];
        const terms = expand(q);
        if (!terms.size && !routed.length) return [];
        const docs = _docs(catalog);
        const scored = docs.map((d, k) => {
            let s = 0;
            for (const [t, w] of terms) {
                let best = 0;
                for (const [set, wt] of d.parts) if (wt > best && _hit(set, t)) best = wt;
                s += best * w * docs.idf(t);
            }
            const r = routed.indexOf(d.id);
            if (r >= 0) s += 100 - r;
            return { id: d.id, k, score: Math.round(10 * s) / 10 };
        }).filter(x => x.score >= (opts.min ?? 4));
        scored.sort((a, b) => b.score - a.score || a.k - b.k);
        return scored.slice(0, limit).map(x => ({ id: x.id, title: catalog[x.k].title, question: catalog[x.k].question, score: x.score }));
    }

    /** One lens result as prompt text: headline, top stats, area vs city, rank, source. Pure. */
    function lensText(l, opts = {}) {
        const lines = [`[${l.id}] ${l.title}: ${l.headline}`];
        for (const st of (l.stats || []).slice(0, opts.stats ?? 5)) lines.push(`  · ${st.label}: ${st.value}`);
        const a = opts.area;
        if (a) {
            const better = a.betterThan == null ? '' : ` (better than ${a.betterThan}% of the city's residents)`;
            lines.push(`  · Selected area ${opts.areaCode}: ${a.label} ${a.area}${a.unit ? ` ${a.unit}` : ''} vs city ${a.city}${a.unit ? ` ${a.unit}` : ''}${better}`);
        }
        const rk = opts.rank;
        if (rk) lines.push(`  · Among ${rk.of} cities: rank ${rk.rank} of ${rk.of} on ${rk.label} (${rk.value}${rk.unit ? ` ${rk.unit}` : ''}; best ${rk.best.city} ${rk.best.value}, worst ${rk.worst.city} ${rk.worst.value})`);
        if (l.refs) lines.push(`  · Source: ${String(l.refs).slice(0, 220)}`);
        return lines.join('\n');
    }

    /**
     * Run the lenses that bear on `q` for `city` and return a context block for
     * the model: { text, ids }. `code` (a DIGIPIN, optional) adds the area vs city
     * row; `league` (data/lenses/league.json, optional) adds the cross-city rank.
     */
    async function context(q, city, store, opts = {}) {
        if (typeof UrbanLenses === 'undefined' || !city) return { text: '', ids: [] };
        const routed = typeof DishaIntel !== 'undefined' && DishaIntel.lensHits ? DishaIntel.lensHits(q) : [];
        const hits = search(q, UrbanLenses.catalog().filter(l => l.id !== 'siting'), { limit: opts.limit || 3, routed });
        if (!hits.length) return { text: '', ids: [] };
        const res = await UrbanLenses.run(city, store, { only: hits.map(h => h.id), hotspots: false });
        if (!res.lenses.length) return { text: '', ids: [] };
        const prof = opts.code ? UrbanLenses.areaProfile(res, String(opts.code).replace(/-/g, '').slice(0, 6)) : null;
        const ranks = opts.league ? UrbanLenses.leagueFor(opts.league, city) : [];
        const blocks = res.lenses.map(l => lensText(l, {
            area: prof && prof.rows.find(r => r.id === l.id), areaCode: prof && prof.prefix,
            rank: ranks.find(r => r.id === l.id),
        }));
        return {
            ids: res.lenses.map(l => l.id),
            text: `=== RELEVANT URBAN LENS RESULTS for ${res.cityLabel} (computed from DigiPin's open datasets; cite them, say where data are thin) ===\n${blocks.join('\n')}`,
        };
    }

    return { search, expand, tokens, lensText, context };
})();

if (typeof window !== 'undefined') window.LensSearch = LensSearch;
