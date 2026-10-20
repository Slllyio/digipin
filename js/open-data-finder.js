/**
 * OpenDataFinder — "find open data for X" in the DISHA box.
 *
 * Aino's @aino_search agent discovers government data for a prompt. This is
 * the same job done from a hand-curated catalog (data/open-data/catalog.json):
 * each entry points at the publisher's own page, states format / licence /
 * coverage, and — where DigiPin already draws the same data — names the layer
 * so the result can turn it on instead of sending you off to download it.
 *
 * isQuery()/tokens()/search() are pure (unit-tested); load()/renderResults()
 * touch the network and DOM.
 */
const OpenDataFinder = (() => {
    const CATALOG_URL = 'data/open-data/catalog.json';
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

    function _score(entry, terms) {
        const tags = (entry.tags || []).map(t => t.toLowerCase());
        const title = String(entry.title || '').toLowerCase();
        const rest = [entry.publisher, entry.coverage, entry.format].join(' ').toLowerCase();
        let score = 0;
        const hit = [];
        terms.forEach(t => {
            let s = 0;
            if (tags.some(tag => tag === t || tag === t + 's' || _stem(tag) === t)) s = 3;
            else if (tags.some(tag => tag.includes(t))) s = 2;
            else if (title.includes(t)) s = 2;
            else if (rest.includes(t)) s = 1;
            if (s) { score += s; hit.push(t); }
        });
        // Datasets DigiPin already draws are more useful than a download link.
        if (score && (entry.layers || []).length) score += 0.5;
        return { score, hit };
    }

    /** Ranked catalog matches: [{ entry, score, matched }], best first. */
    function search(query, catalog, limit = MAX_RESULTS) {
        const terms = tokens(query);
        const list = (catalog && catalog.datasets) || [];
        if (!terms.length) return [];
        return list
            .map(entry => ({ entry, ..._score(entry, terms) }))
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
            .slice(0, limit)
            .map(r => ({ entry: r.entry, score: r.score, matched: r.hit }));
    }

    async function load() {
        if (_catalog) return _catalog;
        const res = await fetch(CATALOG_URL);
        if (!res.ok) throw new Error('catalog ' + res.status);
        _catalog = await res.json();
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
            meta.textContent = [entry.publisher, entry.format, entry.license, entry.coverage].filter(Boolean).join(' · ');
            card.append(title, meta);
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

    return { isQuery, tokens, search, load, layersFor, renderResults, CATALOG_URL };
})();

if (typeof window !== 'undefined') {
    window.OpenDataFinder = OpenDataFinder;
}
