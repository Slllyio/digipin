/**
 * MapSnapshot — "Export the map as a PNG" with the paperwork a planner needs
 * to paste it into a report: a title bar (place, date), the names of the
 * visible layers, and a source line per layer (from Provenance), so a screenshot
 * never travels without its data credits.
 *
 * layerTokens → keys → attribution lines, wrapLines() and layout() are pure
 * (unit-tested); snapshot()/download() draw on a canvas and need the live map.
 */
const MapSnapshot = (() => {
    const PAD = 14;
    const HEAD_H = 40;
    const LINE_H = 16;
    const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';

    /** URLState layer token → Provenance registry key. */
    function keyForToken(tok) {
        if (typeof tok !== 'string' || !tok) return null;
        if (tok.startsWith('dt:')) return tok.slice(3);
        if (tok.startsWith('cell:')) return '_cell_' + tok.slice(5);
        return '_btn_btn-' + tok;
    }

    /**
     * One line per distinct source for the given layer tokens:
     * [{ name, text }]. `lookup(key)` → provenance meta, `nameOf(token)` → label.
     * Layers sharing a source are merged ("A, B — OpenStreetMap …").
     */
    function attributions(tokens, lookup, nameOf) {
        const bySource = new Map();
        (tokens || []).forEach(tok => {
            const meta = lookup(keyForToken(tok));
            if (!meta || !meta.source) return;
            const text = meta.license ? `${meta.source} · ${meta.license}` : meta.source;
            const name = (nameOf && nameOf(tok)) || tok;
            if (!bySource.has(text)) bySource.set(text, []);
            const names = bySource.get(text);
            if (!names.includes(name)) names.push(name);
        });
        return [...bySource.entries()].map(([text, names]) => ({ name: names.join(', '), text }));
    }

    /** Greedy word wrap using `measure(str) → px`; never returns an empty list. */
    function wrapLines(text, maxWidth, measure) {
        const words = String(text || '').split(/\s+/).filter(Boolean);
        const lines = [];
        let cur = '';
        words.forEach(w => {
            const next = cur ? cur + ' ' + w : w;
            if (cur && measure(next) > maxWidth) { lines.push(cur); cur = w; } else { cur = next; }
        });
        if (cur) lines.push(cur);
        return lines.length ? lines : [''];
    }

    /**
     * Footer geometry. `blocks` is [{ lines:[…] }]; returns the footer height
     * and the canvas height for a map of `mapH` px.
     */
    function layout(mapH, blocks) {
        const n = (blocks || []).reduce((s, b) => s + b.lines.length, 0);
        const footer = n ? PAD * 2 + n * LINE_H : PAD * 2 + LINE_H;
        return { head: HEAD_H, footer, total: HEAD_H + mapH + footer, lineHeight: LINE_H, pad: PAD };
    }

    /** Default file name: digipin_map_<place>_<yyyy-mm-dd>.png. */
    function filename(place, date) {
        const slug = String(place || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
        const d = (date instanceof Date ? date : new Date()).toISOString().slice(0, 10);
        return `digipin_map_${slug}_${d}.png`;
    }

    // ── Live app ──────────────────────────────────────────────────

    function _activeTokens() {
        return (typeof URLState !== 'undefined' && URLState.activeLayers) ? URLState.activeLayers() : [];
    }

    function _nameOf(tok) {
        if (tok.startsWith('dt:') && typeof DigitalTwinLayers !== 'undefined') {
            const d = DigitalTwinLayers.getLayerDefs().find(x => x.key === tok.slice(3));
            return d && d.name;
        }
        if (tok.startsWith('cell:') && typeof CellStore !== 'undefined') {
            const s = CellStore.get(tok.slice(5));
            return s && s.title;
        }
        if (typeof LayersPanel !== 'undefined' && LayersPanel.ANALYTICS) {
            const a = LayersPanel.ANALYTICS.find(x => x.btnId === 'btn-' + tok);
            return a && a.name;
        }
        return null;
    }

    function _lookup(key) {
        return (typeof Provenance !== 'undefined' && key) ? Provenance.forKey(key) : null;
    }

    /**
     * Draw the current map plus header and credits onto a new canvas.
     * Resolves with the canvas, or null when there is no map to capture.
     */
    function snapshot(opts = {}) {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (!map || typeof document === 'undefined') return null;
        // Render now so the drawing buffer holds the current frame.
        if (map.triggerRepaint) map.triggerRepaint();
        const src = map.getCanvas();
        const lines = attributions(_activeTokens(), _lookup, _nameOf);
        const probe = document.createElement('canvas').getContext('2d');
        probe.font = FONT;
        const measure = (s) => probe.measureText(s).width;
        const blocks = lines.map(l => ({
            name: l.name,
            lines: wrapLines(`${l.name}: ${l.text}`, src.width - PAD * 2, measure),
        }));
        const L = layout(src.height, blocks);

        const out = document.createElement('canvas');
        out.width = src.width;
        out.height = L.total;
        const g = out.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, out.width, out.height);
        g.drawImage(src, 0, L.head);

        g.fillStyle = '#111827';
        g.font = '600 15px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.textBaseline = 'middle';
        const title = opts.title || 'DigiPin map';
        g.fillText(title, PAD, L.head / 2);
        g.font = FONT;
        g.fillStyle = '#6b7280';
        const stamp = (opts.date instanceof Date ? opts.date : new Date()).toISOString().slice(0, 10);
        g.textAlign = 'right';
        g.fillText(stamp, out.width - PAD, L.head / 2);
        g.textAlign = 'left';

        g.fillStyle = '#374151';
        g.textBaseline = 'top';
        let y = L.head + src.height + PAD;
        if (!blocks.length) {
            g.fillText('Base map only. Built with DigiPin.', PAD, y);
        } else {
            blocks.forEach(b => b.lines.forEach(line => { g.fillText(line, PAD, y); y += L.lineHeight; }));
        }
        return out;
    }

    /** Capture and download. Resolves true when a file was handed to the browser. */
    function download(opts = {}) {
        const canvas = snapshot(opts);
        if (!canvas) return Promise.resolve(false);
        return new Promise(resolve => {
            canvas.toBlob(blob => {
                if (!blob) { resolve(false); return; }
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = opts.filename || filename(opts.place);
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
                resolve(true);
            }, 'image/png');
        });
    }

    return { keyForToken, attributions, wrapLines, layout, filename, snapshot, download };
})();

if (typeof window !== 'undefined') {
    window.MapSnapshot = MapSnapshot;
}
