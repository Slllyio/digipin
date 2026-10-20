/**
 * DishaMentions — `/layer` and `@score` shortcuts in the DISHA box.
 *
 * Aino lets a prompt name its target layer with `/` and its data source with
 * `@`, so the model can't silently pick the wrong one. DigiPin's version:
 *   /heat, /ndvi, /traffic   turn that map layer on alongside the answer
 *   @safety, @flood_risk     pin that score into the Text2Map ranking
 * Tokens are resolved against the real registries (Layers panel, Digital-Twin
 * layers, cell store, score vocabulary); anything unknown is reported with
 * close matches instead of being guessed.
 *
 * extract()/resolve()/rewrite()/applyPins()/tokenAtCaret() are pure
 * (unit-tested); candidates()/attachAutocomplete() read the running app.
 */
const DishaMentions = (() => {
    const TOKEN_RE = /(^|\s)([/@])([A-Za-z0-9][\w-]{0,63})/g;
    const PIN_WEIGHT = 0.8;     // a pinned score the parser left out joins at this weight
    const MAX_SUGGEST = 6;

    const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

    /** Pull `/x` and `@y` tokens out of a question. */
    function extract(text) {
        const layers = [];
        const scores = [];
        const src = String(text || '');
        for (const m of src.matchAll(TOKEN_RE)) {
            (m[2] === '/' ? layers : scores).push(m[3]);
        }
        return { layers, scores };
    }

    /**
     * Match one token against candidates [{id, name}]: exact id or name first,
     * then a unique prefix, then a unique substring. Returns the candidate or null.
     */
    function match(token, candidates) {
        const t = _norm(token);
        if (!t) return null;
        const list = candidates || [];
        const exact = list.filter(c => _norm(c.id) === t || _norm(c.name) === t);
        if (exact.length) return exact[0];
        const prefix = list.filter(c => _norm(c.id).startsWith(t) || _norm(c.name).startsWith(t));
        if (prefix.length === 1) return prefix[0];
        const inner = list.filter(c => _norm(c.name).includes(t));
        if (inner.length === 1) return inner[0];
        return null;
    }

    /** Up to n candidates whose id/name contains the token (for "did you mean"). */
    function suggest(token, candidates, n = MAX_SUGGEST) {
        const t = _norm(token);
        const list = candidates || [];
        if (!t) return list.slice(0, n);
        return list.filter(c => _norm(c.id).includes(t) || _norm(c.name).includes(t))
            .slice(0, n);
    }

    /** Resolve tokens → { matched:[{token, ...candidate}], unknown:[{token, suggestions}] }. */
    function resolve(tokens, candidates) {
        const matched = [];
        const unknown = [];
        (tokens || []).forEach(token => {
            const hit = match(token, candidates);
            if (hit) {
                if (!matched.some(m => m.id === hit.id)) matched.push({ token, ...hit });
            } else {
                unknown.push({ token, suggestions: suggest(token, candidates, 3).map(c => c.name) });
            }
        });
        return { matched, unknown };
    }

    /**
     * Question text for the model: `@score` becomes its label (keeps meaning),
     * `/layer` is dropped (it's an instruction to the map, not to the model).
     */
    function rewrite(text, scoreMatches) {
        const byToken = new Map((scoreMatches || []).map(m => [m.token, m.name]));
        return String(text || '')
            .replace(TOKEN_RE, (all, lead, sigil, tok) => {
                if (sigil === '/') return lead;
                return lead + (byToken.get(tok) || tok);
            })
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    /**
     * Force pinned score ids into a Text2Map weighting. A pin the parser already
     * weighted keeps its sign (a negative weight stays negative) but gets at
     * least PIN_WEIGHT magnitude; a missing one joins at +PIN_WEIGHT.
     */
    function applyPins(parsed, ids) {
        if (!parsed || !ids || !ids.length) return parsed;
        const weights = { ...(parsed.weights || {}) };
        ids.forEach(id => {
            const cur = weights[id];
            if (cur == null) weights[id] = PIN_WEIGHT;
            else weights[id] = Math.sign(cur || 1) * Math.max(Math.abs(cur), PIN_WEIGHT);
        });
        return { ...parsed, weights, pinned: ids.slice() };
    }

    /** The `/x` or `@x` token being typed at caret position `pos`, or null. */
    function tokenAtCaret(text, pos) {
        const before = String(text || '').slice(0, pos);
        const m = before.match(/(^|\s)([/@])([\w-]*)$/);
        if (!m) return null;
        return { sigil: m[2], partial: m[3], start: before.length - m[3].length - 1 };
    }

    // ── Registries in the running app ──────────────────────────────

    /** Layer candidates: toolbar overlays, Digital-Twin layers, cell-store datasets. */
    function layerCandidates() {
        const out = [];
        if (typeof LayersPanel !== 'undefined' && LayersPanel.ANALYTICS) {
            LayersPanel.ANALYTICS.forEach(a => out.push({
                id: a.btnId.replace(/^btn-/, ''), name: a.name, kind: 'btn', ref: a.btnId,
            }));
        }
        if (typeof DigitalTwinLayers !== 'undefined' && DigitalTwinLayers.getLayerDefs) {
            DigitalTwinLayers.getLayerDefs().forEach(d => out.push({ id: d.key, name: d.name, kind: 'dt', ref: d.key }));
        }
        if (typeof CellStore !== 'undefined' && CellStore.datasets) {
            CellStore.datasets().forEach(d => out.push({ id: d.id, name: d.title || d.id, kind: 'cell', ref: d.id }));
        }
        return out;
    }

    /** Score candidates from the live score vocabulary. */
    function scoreCandidates() {
        if (typeof DataFetcher === 'undefined' || !DataFetcher.computeScores) return [];
        const all = DataFetcher.computeScores({});
        return Object.keys(all).map(id => ({ id, name: (all[id] && all[id].label) || id }));
    }

    /**
     * Turn on a resolved layer through its own owner. Resolves to true when it
     * ends up on (already-on counts).
     */
    async function showLayer(c) {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (c.kind === 'btn' && typeof LayersPanel !== 'undefined') {
            if (!LayersPanel.isActive(c.ref)) LayersPanel.drive(c.ref);
            await new Promise(r => setTimeout(r, 150));
            return LayersPanel.isActive(c.ref);
        }
        if (c.kind === 'dt' && typeof DigitalTwinLayers !== 'undefined') {
            if (DigitalTwinLayers.isVisible(c.ref)) return true;
            return !!(await DigitalTwinLayers.toggle(c.ref, map));
        }
        if (c.kind === 'cell' && typeof CellLayers !== 'undefined') {
            if (CellLayers.isVisible(c.ref)) return true;
            return !!(await CellLayers.show(c.ref));
        }
        return false;
    }

    /** Show a pick-list under the DISHA input while a `/` or `@` token is typed. */
    function attachAutocomplete(input) {
        if (!input || typeof document === 'undefined' || input._mentionsWired) return;
        input._mentionsWired = true;
        const box = document.createElement('div');
        box.className = 'disha-mention-list';
        box.setAttribute('role', 'listbox');
        box.hidden = true;
        input.parentNode.insertBefore(box, input);

        const close = () => { box.hidden = true; box.textContent = ''; };
        const pick = (tok, c) => {
            const v = input.value;
            const end = tok.start + 1 + tok.partial.length;
            input.value = v.slice(0, tok.start) + tok.sigil + c.id + ' ' + v.slice(end);
            const caret = tok.start + c.id.length + 2;
            input.focus();
            input.setSelectionRange(caret, caret);
            close();
        };

        input.addEventListener('input', () => {
            const tok = tokenAtCaret(input.value, input.selectionStart);
            if (!tok) { close(); return; }
            const list = suggest(tok.partial, tok.sigil === '/' ? layerCandidates() : scoreCandidates());
            box.textContent = '';
            if (!list.length) { close(); return; }
            list.forEach(c => {
                const opt = document.createElement('button');
                opt.type = 'button';
                opt.className = 'disha-mention-opt';
                opt.setAttribute('role', 'option');
                const code = document.createElement('code');
                code.textContent = tok.sigil + c.id;
                const label = document.createElement('span');
                label.textContent = c.name;
                opt.appendChild(code);
                opt.appendChild(label);
                // mousedown, so the input doesn't blur (and close the list) first.
                opt.addEventListener('mousedown', (e) => { e.preventDefault(); pick(tok, c); });
                box.appendChild(opt);
            });
            box.hidden = false;
        });
        input.addEventListener('blur', () => setTimeout(close, 100));
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) { e.stopPropagation(); close(); } });
    }

    return {
        extract, match, suggest, resolve, rewrite, applyPins, tokenAtCaret,
        layerCandidates, scoreCandidates, showLayer, attachAutocomplete, PIN_WEIGHT,
    };
})();

if (typeof window !== 'undefined') {
    window.DishaMentions = DishaMentions;
}
