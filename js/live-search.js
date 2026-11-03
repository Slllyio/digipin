/**
 * LiveSearch — the map search also finds what the live layers are showing:
 * a flight by callsign or registration (Live sky), a place by name (Places)
 * and a live correlation by its words (Live now), before falling back to
 * the geocoder. Offentligdata's "Search the map: vessel, callsign, place".
 *
 * match() is pure (unit-tested); candidates() reads the live modules.
 */
const LiveSearch = (() => {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_.]+/g, ' ').trim();

    /** Best item for the query, or null. Exact > prefix > word prefix > contains; ties keep list order. */
    function match(query, items) {
        const q = norm(query), qc = q.replace(/ /g, '');
        if (qc.length < 2) return null;
        let best = null, bestScore = 0;
        for (const it of items || []) {
            for (const key of it.keys || []) {
                const k = norm(key), kc = k.replace(/ /g, '');
                if (!kc) continue;
                // Compact forms (no spaces or dashes) so "VTNHX" finds "VT-NHX".
                const score = kc === qc ? 4 : kc.startsWith(qc) ? 3 : k.split(' ').some(w => w.startsWith(q)) ? 2 : (qc.length >= 4 && kc.includes(qc)) ? 1 : 0;
                if (score > bestScore) { best = it; bestScore = score; }
            }
        }
        return best;
    }

    /** Searchable things on the live layers that are on now. */
    function candidates() {
        const out = [];
        if (typeof LiveSky !== 'undefined' && LiveSky.isActive()) {
            for (const a of LiveSky.aircraft()) {
                out.push({ kind: 'aircraft', label: `${a.flight}${a.type ? ` (${a.type})` : ''}`, keys: [a.flight, a.reg, a.hex], id: a.hex });
            }
        }
        if (typeof PlacesNearby !== 'undefined' && PlacesNearby.isActive()) {
            for (const p of PlacesNearby.places()) {
                out.push({ kind: 'place', label: p.title, keys: [p.title], id: p.id, lat: p.lat, lng: p.lng });
            }
        }
        const s = typeof LiveNow !== 'undefined' && LiveNow.isActive() && LiveNow.snapshot();
        if (s) {
            for (const c of s.correlations) out.push({ kind: 'correlation', label: c.title, keys: [c.title], item: c });
        }
        return out;
    }

    function find(query) { return match(query, candidates()); }

    /** Show a found item; returns true when it was shown. */
    function go(hit) {
        if (!hit) return false;
        if (hit.kind === 'aircraft') return LiveSky.focus(hit.id);
        if (hit.kind === 'place') return PlacesNearby.focus(hit.id);
        if (hit.kind === 'correlation') { LiveNow.focus(hit.item); return true; }
        return false;
    }

    return { match, candidates, find, go };
})();

if (typeof window !== 'undefined') window.LiveSearch = LiveSearch;
