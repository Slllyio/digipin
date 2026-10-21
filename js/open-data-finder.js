/**
 * OpenDataFinder — "find open data for X" in the DISHA box.
 *
 * Aino's @aino_search agent discovers government data for a prompt. This is
 * the same job done from a hand-curated catalog (data/open-data/catalog.json):
 * each entry points at the publisher's own page, states format / licence /
 * coverage, and — where DigiPin already draws the same data — names the layer
 * so the result can turn it on instead of sending you off to download it.
 *
 * A second, generated catalog (data/open-data/cloud_catalogs.json, built by
 * pipeline/catalogs/fetch_cloud_catalogs.py from opengeos'
 * geospatial-data-catalogs) adds every Earth Engine and Planetary Computer
 * dataset whose extent reaches India. Curated entries rank above it on a tie.
 *
 * isQuery()/tokens()/search()/merge() are pure (unit-tested); load()/renderResults()
 * touch the network and DOM.
 */
const OpenDataFinder = (() => {
    const CATALOG_URL = 'data/open-data/catalog.json';
    const CLOUD_CATALOG_URL = 'data/open-data/cloud_catalogs.json';
    const MAX_RESULTS = 6;
    const STOP = new Set(['a', 'an', 'the', 'for', 'on', 'of', 'about', 'in', 'to', 'and', 'or', 'any', 'some', 'my', 'me', 'i', 'is', 'are', 'there', 'data', 'dataset', 'datasets', 'open', 'public', 'free', 'source', 'sources', 'india', 'indian', 'city', 'indore']);
    // Words people use → words the catalog uses.
    const ALIAS = {
        buildings: ['building', 'footprint', 'footprints'], roads: ['road', 'street', 'streets'],
        trees: ['tree', 'greenery', 'vegetation', 'ndvi'], green: ['vegetation', 'greenery', 'ndvi', 'park', 'parks'],
        heat: ['temperature', 'urban heat', 'heat island'], pollution: ['air quality', 'aqi', 'pm2.5'],
        air: ['air quality', 'aqi'], flooding: ['flood'], floods: ['flood'], rain: ['rainfall'],
        people: ['population', 'demographics'], residents: ['population'], hills: ['elevation', 'terrain'],
        height: ['elevation', 'building height'], satellite: ['imagery', 'satellite'], lakes: ['water'], rivers: ['water'],
    };

    let _catalog = null;

    /** Does the question ask to find datasets? Returns { query } or null. */
    function isQuery(text) {
        const s = String(text || '').trim();
        const m = s.match(/^(?:please\s+)?(?:(?:find|search(?:\s+for)?|look\s+for|get|show|list|discover)\s+(?:me\s+)?|where\s+(?:can|do)\s+i\s+(?:get|find)\s+|is\s+there\s+(?:any\s+)?|are\s+there\s+(?:any\s+)?)(?:(?:open|public|free|government|gov)\s+)*(?:data\s*sets?|data\s*sources?|data)\b\s*(?:on|for|about|of|in|from|to\s+(?:map|plot))?\s*(.*)$/i);
        if (!m) return null;
        return { query: m[1].replace(/[?.!]+$/, '').trim() };
    }

    function _stem(w) {
        return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
    }

    /** Query → lower-case search terms, stop-words dropped, aliases expanded. */
    function tokens(query) {
        const base = String(query || '').toLowerCase().split(/[^a-z0-9.+]+/).filter(Boolean)
            .filter(w => !STOP.has(w)).map(_stem);
        const out = new Set(base);
        base.forEach(w => (ALIAS[w] || ALIAS[w + 's'] || []).forEach(a => out.add(a)));
        return [...out];
    }

    /** Rows generated from the cloud catalogs (Earth Engine, Planetary Computer, NASA CMR, Copernicus, AWS). */
    function _isCloud(entry) {
        return /^(ee|pc|cmr|cds|ewds|aws):/.test(String(entry.id || ''));
    }

    function _score(entry, terms, phrase) {
        const tags = (entry.tags || []).map(t => t.toLowerCase());
        const title = String(entry.title || '').toLowerCase();
        const rest = [entry.publisher, entry.coverage, entry.format].join(' ').toLowerCase();
        let score = 0;
        const hit = [];
        // A multi-word topic named as one thing ("land cover" → landcover tag)
        // scores as full tag hits on every word, so rows that only match the
        // words separately ("land" + "cover" in a grassland row) rank below it.
        if (phrase && (tags.some(tag => tag.replace(/[^a-z0-9]/g, '') === phrase.compact) || title.includes(phrase.text))) {
            score = 3 * phrase.words.length + 1;
            hit.push(...phrase.words);
            terms = terms.filter(t => !phrase.words.includes(t));
        }
        terms.forEach(t => {
            let s = 0;
            if (tags.some(tag => tag === t || tag === t + 's' || _stem(tag) === t)) s = 3;
            else if (tags.some(tag => tag.includes(t))) s = 2;
            else if (title.includes(t)) s = 2;
            else if (rest.includes(t)) s = 1;
            if (s) { score += s; hit.push(t); }
        });
        // Datasets DigiPin already draws are more useful than a download link,
        // and a hand-checked entry beats a generated cloud-catalog row.
        if (score && (entry.layers || []).length) score += 0.5;
        if (score && !_isCloud(entry)) score += 0.25;
        return { score, hit };
    }

    /** Ranked catalog matches: [{ entry, score, matched }], best first. */
    function search(query, catalog, limit = MAX_RESULTS) {
        const terms = tokens(query);
        const list = (catalog && catalog.datasets) || [];
        if (!terms.length) return [];
        const words = String(query).toLowerCase().split(/[^a-z0-9.+]+/).filter(w => w && !STOP.has(w));
        const phrase = words.length > 1 ? { words, text: words.join(' '), compact: words.join('') } : null;
        return list
            .map(entry => ({ entry, ..._score(entry, terms, phrase) }))
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
            .slice(0, limit)
            .map(r => ({ entry: r.entry, score: r.score, matched: r.hit }));
    }

    /** One catalog from several: concatenated, first id wins. */
    function merge(...catalogs) {
        const seen = new Set();
        const datasets = [];
        catalogs.forEach(c => ((c && c.datasets) || []).forEach(d => {
            if (!d || !d.id || seen.has(d.id)) return;
            seen.add(d.id);
            datasets.push(d);
        }));
        return { datasets };
    }

    async function _get(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(url + ' ' + res.status);
        return res.json();
    }

    /** Curated + cloud catalogs; either may be missing, not both. */
    async function load() {
        if (_catalog) return _catalog;
        const got = await Promise.allSettled([_get(CATALOG_URL), _get(CLOUD_CATALOG_URL)]);
        const ok = got.filter(g => g.status === 'fulfilled').map(g => g.value);
        if (!ok.length) throw got[0].reason;
        _catalog = merge(...ok);
        return _catalog;
    }

    /** Layer candidates (from DishaMentions) that match the entry's layer ids. */
    function layersFor(entry, candidates) {
        const out = [];
        (entry.layers || []).forEach(id => {
            const c = (candidates || []).find(x => x.id === id);
            if (c && !out.some(o => o.id === c.id)) out.push(c);
        });
        return out;
    }

    /** Draw result cards into `container`; `showLayer(candidate)` turns a layer on. */
    function renderResults(container, results, query, opts = {}) {
        const candidates = opts.candidates || [];
        container.textContent = '';
        const head = document.createElement('div');
        head.className = 'odf-head';
        head.textContent = results.length
            ? `${results.length} public dataset${results.length === 1 ? '' : 's'} for “${query}”`
            : `No catalog match for “${query}”. Try a theme like buildings, flood, population, air quality or elevation.`;
        container.appendChild(head);
        results.forEach(({ entry }) => {
            const card = document.createElement('div');
            card.className = 'odf-card';
            const title = document.createElement('a');
            title.className = 'odf-title';
            title.href = entry.url;
            title.target = '_blank';
            title.rel = 'noopener noreferrer';
            title.textContent = entry.title;
            const meta = document.createElement('div');
            meta.className = 'odf-meta';
            meta.textContent = [entry.platform, entry.publisher, entry.format, entry.license, entry.coverage, entry.years].filter(Boolean).join(' · ');
            card.append(title, meta);
            if (entry.access) {
                // The Earth Engine snippet / STAC URL a pipeline needs to pull it per cell.
                const access = document.createElement('code');
                access.className = 'odf-access';
                access.textContent = entry.access;
                card.appendChild(access);
            }
            layersFor(entry, candidates).forEach(c => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'odf-layer';
                btn.textContent = `Show ${c.name} on the map`;
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    let ok = false;
                    try { ok = opts.showLayer ? await opts.showLayer(c) : false; } catch { ok = false; }
                    btn.textContent = ok ? `${c.name} is on` : 'Could not turn it on here';
                    btn.disabled = false;
                });
                card.appendChild(btn);
            });
            container.appendChild(card);
        });
    }

    return { isQuery, tokens, search, merge, load, layersFor, renderResults, CATALOG_URL, CLOUD_CATALOG_URL };
})();

if (typeof window !== 'undefined') {
    window.OpenDataFinder = OpenDataFinder;
}
