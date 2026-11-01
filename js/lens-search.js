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
        train: ['rail', 'train'], walk: ['walk', 'foot'], walking: ['walk', 'foot'], cycle: ['cycle', 'cycling'], parking: ['parking'],
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
        // amenities and people, so dataset fields answer what no lens covers
        pharmacy: ['pharmacy'], chemist: ['pharmacy'], medical: ['pharmacy', 'health'], gym: ['gyms', 'sport', 'leisure'], gyms: ['gyms', 'sport'],
        restaurant: ['restaurant', 'food', 'cafe'], restaurants: ['restaurant', 'food'], cafe: ['cafe', 'food'], food: ['food', 'restaurant'], eat: ['food', 'restaurant'],
        temple: ['worship', 'religious'], mosque: ['worship', 'religious'], church: ['worship', 'religious'], gurudwara: ['worship'],
        bank: ['bank', 'atm', 'financ'], atm: ['atm', 'bank'], library: ['library'], libraries: ['library'], hotel: ['hotel', 'lodging', 'stay'],
        hostel: ['hostel'], pg: ['hostel'], grocery: ['grocer'], kirana: ['grocer'], supermarket: ['grocer'], dentist: ['dental'], petrol: ['fuel'],
        mall: ['mall'], malls: ['mall'], creche: ['preschool'], daycare: ['preschool'], playschool: ['preschool'], coaching: ['coaching'], tuition: ['coaching'],
        coworking: ['coworking'], office: ['office'], offices: ['office'], broker: ['real-estate', 'agent'], police: ['police'], fire: ['fire'],
        hilly: ['slope', 'elevation', 'terrain'], hill: ['slope', 'elevation'], steep: ['slope'], height: ['elevation', 'height'],
        humid: ['humid', 'wet', 'bulb'], humidity: ['humid'], literacy: ['literacy', 'literate'], literate: ['literacy'], migrants: ['migra'], migrant: ['migra'],
        unemployment: ['unemploy', 'job'], unemployed: ['unemploy'], river: ['river'], agricultural: ['farm', 'crop', 'cropland'], agriculture: ['farm', 'crop'],
        fsi: ['floor', 'fsi'], far: ['floor', 'fsi'], diverse: ['diversity', 'mix'], diversity: ['diversity', 'mix'], cyclist: ['cycle', 'cycling'], cyclists: ['cycle', 'cycling'], bike: ['cycle', 'cycling'],
        seniors: ['aged', 'elderly'], senior: ['aged', 'elderly'], aged: ['aged', 'elderly'], youth: ['young', 'youth'], young: ['young', 'youth'],
        toddlers: ['under', 'children'], babies: ['under', 'children'],
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
        let fc = { text: '', fields: [] };
        try { fc = await fieldContext(q, city, store, { code: opts.code }); } catch { /* fields are a bonus */ }
        const onlyFields = { text: fc.text, ids: [], fields: fc.fields };
        if (!hits.length) return onlyFields;
        const res = await UrbanLenses.run(city, store, { only: hits.map(h => h.id), hotspots: false });
        if (!res.lenses.length) return onlyFields;
        const prof = opts.code ? UrbanLenses.areaProfile(res, String(opts.code).replace(/-/g, '').slice(0, 6)) : null;
        const ranks = opts.league ? UrbanLenses.leagueFor(opts.league, city) : [];
        const blocks = res.lenses.map(l => lensText(l, {
            area: prof && prof.rows.find(r => r.id === l.id), areaCode: prof && prof.prefix,
            rank: ranks.find(r => r.id === l.id),
        }));
        const lensBlock = `=== RELEVANT URBAN LENS RESULTS for ${res.cityLabel} (computed from DigiPin's open datasets; cite them, say where data are thin) ===\n${blocks.join('\n')}`;
        return { ids: res.lenses.map(l => l.id), fields: fc.fields, text: fc.text ? `${lensBlock}\n${fc.text}` : lensBlock };
    }

    // ---------- dataset fields: answers where no lens fits ----------

    // Words too generic to pick a field on their own ('good' would find good_nights).
    const FIELD_STOP = new Set(('good best bad worst nice nearby near close left allowed rate number share many few residents resident people ' +
        'here city district level total count percent pct per lakh top high low highest lowest big small').split(' '));

    // What a reader must know before trusting a dataset's block numbers.
    const CAVEAT = {
        places: 'Overture listings miss many small shops, clinics and kiranas, so read low counts as possible listing gaps',
        osm_amenities: 'OpenStreetMap is mapped by volunteers and is patchy outside central areas',
        demographics: 'age and sex shares are WorldPop model values spread from district totals, not counted per block',
    };

    const _fieldCache = new WeakMap();
    function _fieldDocs(datasets) {
        let d = _fieldCache.get(datasets);
        if (d) return d;
        d = [];
        for (const spec of datasets || []) {
            if (!spec || !Array.isArray(spec.fields) || spec.time) continue;
            for (const f of spec.fields) {
                if (f.type && f.type !== 'number') continue;
                d.push({ ds: spec.id, key: f.key, label: f.label || f.key, spec, field: f,
                    parts: [[new Set(tokens(`${f.label || ''} ${String(f.key).replace(/_/g, ' ')}`).map(_stem)), 3],
                        [new Set(tokens(spec.title).map(_stem)), 1]] });
            }
        }
        const df = new Map();
        for (const x of d) {
            const all = new Set();
            for (const [set] of x.parts) for (const t of set) all.add(t);
            for (const t of all) df.set(t, (df.get(t) || 0) + 1);
        }
        d.idf = t => Math.log(1 + d.length / (1 + (df.get(t) || 0)));
        _fieldCache.set(datasets, d);
        return d;
    }

    /**
     * Rank dataset fields for a question: [{ ds, key, label, score }], best first.
     * A field needs at least one query word in its own label or key; at most two
     * fields per dataset. `datasets` is CellStore.datasets() or catalog.json's list. Pure.
     */
    function searchFields(q, datasets, opts = {}) {
        const limit = opts.limit || 3, terms = expand(q);
        for (const t of [...terms.keys()]) if (FIELD_STOP.has(t)) terms.delete(t);
        if (!terms.size) return [];
        const docs = _fieldDocs(datasets);
        const scored = [];
        for (const d of docs) {
            let s = 0, own = false;
            for (const [t, w] of terms) {
                let best = 0;
                for (const [set, wt] of d.parts) if (wt > best && _hit(set, t)) best = wt;
                if (best === 3) own = true;
                s += best * w * docs.idf(t);
            }
            if (own && s >= (opts.min ?? 6)) scored.push({ d, s });
        }
        // ties go to the field whose label says least besides the match ('Women' before 'Crimes against women')
        scored.sort((a, b) => b.s - a.s || a.d.parts[0][0].size - b.d.parts[0][0].size);
        const out = [], per = new Map(), floor = scored.length ? scored[0].s * 0.55 : 0;
        for (const { d, s } of scored) {
            if (s < floor) break;
            if ((per.get(d.ds) || 0) >= 2 || out.some(o => o.ds === d.ds && o.key === d.key)) continue;
            per.set(d.ds, (per.get(d.ds) || 0) + 1);
            out.push({ ds: d.ds, key: d.key, label: d.label, score: Math.round(10 * s) / 10 });
            if (out.length >= limit) break;
        }
        return out;
    }

    const _fmt = v => (v == null || !Number.isFinite(v) ? 'n/a' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-IN') : String(Math.round(v * 10) / 10));

    /**
     * One field summarised over a city's L7 blocks as prompt text. `col` and `pop`
     * are per-block arrays aligned with `codes`; `names` maps code -> neighbourhood.
     * Counts (agg sum) give the city total, per lakh residents, the share of residents
     * in a block with at least one, and the top blocks; levels (agg mean) give the
     * resident-weighted median and spread. `area` (a DIGIPIN prefix) adds that area. Pure.
     */
    function fieldText(spec, field, col, pop, codes, opts = {}) {
        const n = codes.length, unit = field.unit ? ` ${field.unit}` : '';
        const isCount = field.agg === 'sum' || field.agg === 'count';
        const fin = Number.isFinite;
        const lines = [`[data ${spec.id}.${field.key}] ${field.label || field.key} (${spec.title || spec.id})`];
        let P = 0;
        for (let i = 0; i < n; i++) if (fin(pop[i])) P += pop[i];
        const idx = [];
        for (let i = 0; i < n; i++) if (fin(col[i])) idx.push(i);
        if (!idx.length) return '';
        const nm = c => (opts.names && opts.names.get(c) ? ` · ${opts.names.get(c)}` : '');
        const top = idx.slice().sort((a, b) => col[b] - col[a]).filter(i => col[i] > 0).slice(0, 5);
        const peopleUnit = /people|residents/i.test(field.unit || '') && !/%/.test(field.unit || '');
        const wq = (q) => {
            const xs = idx.filter(i => pop[i] > 0).sort((a, b) => col[a] - col[b]);
            const tot = xs.reduce((a, i) => a + pop[i], 0);
            let c = 0;
            for (const i of xs) { c += pop[i]; if (c >= q * tot) return col[i]; }
            return xs.length ? col[xs[xs.length - 1]] : null;
        };
        const inArea = opts.area ? idx.filter(i => codes[i].startsWith(opts.area)) : [];
        if (isCount) {
            let T = 0, cov = 0;
            for (const i of idx) { T += col[i]; if (col[i] > 0 && fin(pop[i])) cov += pop[i]; }
            const rate = P ? (T / P) * 1e5 : null;
            lines.push(`  · City total ${_fmt(T)}${unit}${peopleUnit ? ` (${P ? _fmt(100 * T / P) : 'n/a'}% of residents)` : ` (${_fmt(rate)} per lakh residents)`}; `
                + `${P ? Math.round(100 * cov / P) : 'n/a'}% of residents live in a block (~1 km²) with at least one`);
            if (inArea.length) {
                let a = 0, ap = 0;
                for (const i of inArea) { a += col[i]; if (fin(pop[i])) ap += pop[i]; }
                lines.push(`  · Selected area ${opts.area}: ${_fmt(a)}${unit} over ${inArea.length} blocks`
                    + (peopleUnit ? ` (${ap ? _fmt(100 * a / ap) : 'n/a'}% of its residents vs city ${P ? _fmt(100 * T / P) : 'n/a'}%)`
                        : ` (${ap ? _fmt(a / ap * 1e5) : 'n/a'} per lakh residents vs city ${_fmt(rate)})`));
            }
        } else {
            lines.push(`  · Resident-weighted median ${_fmt(wq(0.5))}${unit} (10th–90th percentile ${_fmt(wq(0.1))} to ${_fmt(wq(0.9))})`);
            if (inArea.length) {
                let s = 0, w = 0;
                for (const i of inArea) { const wi = fin(pop[i]) && pop[i] > 0 ? pop[i] : 0; s += col[i] * wi; w += wi; }
                const a = w ? s / w : inArea.reduce((x, i) => x + col[i], 0) / inArea.length;
                let below = 0, all = 0;
                for (const i of idx) if (pop[i] > 0) { all += pop[i]; if (col[i] < a) below += pop[i]; }
                lines.push(`  · Selected area ${opts.area}: ${_fmt(a)}${unit} (higher than where ${all ? Math.round(100 * below / all) : 'n/a'}% of the city's residents live)`);
            }
        }
        if (top.length) lines.push(`  · Highest blocks: ${top.map(i => `${codes[i]}${nm(codes[i])} ${_fmt(col[i])}`).join('; ')}`);
        if (spec.level && spec.level < 7) lines.push(`  · Measured at DIGIPIN level ${spec.level}${spec.approxCellM ? ` (~${_fmt(spec.approxCellM / 1000)} km cells)` : ''}, so neighbouring blocks share one value; do not over-read block differences`);
        if (CAVEAT[spec.id]) lines.push(`  · Caveat: ${CAVEAT[spec.id]}`);
        const src = [spec.source, spec.license].filter(Boolean).join('; ');
        if (src) lines.push(`  · Source: ${String(src).slice(0, 220)}`);
        return lines.join('\n');
    }

    /** Fields that bear on `q`, summarised for `city`: { text, fields }. */
    async function fieldContext(q, city, store, opts = {}) {
        if (typeof UrbanLenses === 'undefined' || !city || !store || !store.datasets) return { text: '', fields: [] };
        const covers = s => (s.regions || []).some(r => r.name === city);
        const hits = searchFields(q, store.datasets().filter(covers), { limit: opts.limit || 3 });
        if (!hits.length) return { text: '', fields: [] };
        const needs = [...new Set([...hits.map(h => `${h.ds}.${h.key}`), 'population.population'])];
        const fr = await UrbanLenses.frame(city, store, needs);
        const pop = fr.cols['population.population'];
        if (!pop) return { text: '', fields: [] };
        let names = null;
        try { names = await UrbanLenses.names(city, store); } catch { names = null; }
        const area = opts.code ? String(opts.code).replace(/-/g, '').slice(0, 6) : null;
        const blocks = [];
        for (const h of hits) {
            const col = fr.cols[`${h.ds}.${h.key}`], spec = store.get(h.ds);
            if (!col || !spec) continue;
            const t = fieldText(spec, spec.fields.find(f => f.key === h.key), col, pop, fr.grid.codes, { names, area });
            if (t) blocks.push(t);
        }
        if (!blocks.length) return { text: '', fields: [] };
        return {
            fields: hits.map(h => `${h.ds}.${h.key}`),
            text: `=== RELEVANT DATASET FIELDS for ${typeof UrbanInsights !== 'undefined' ? UrbanInsights.cityLabel(city) : city} (per ~1 km² DIGIPIN block; cite the source) ===\n${blocks.join('\n')}`,
        };
    }

    return { search, expand, tokens, lensText, context, searchFields, fieldText, fieldContext };
})();

if (typeof window !== 'undefined') window.LensSearch = LensSearch;
