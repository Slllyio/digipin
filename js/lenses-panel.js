/**
 * LensesPanel — the Intel dialog's "Lenses" tab over js/urban-lenses.js.
 *
 * One card per lens (heat vulnerability, flood exposure, 15-minute
 * completeness, healthcare access, air exposure, night lights vs people,
 * compound risk): the headline in people, key numbers, the population-weighted
 * Gini with a Lorenz curve, the Moran's I reading, and buttons to put the lens
 * on the map in 3D (runtime dataset `lenses`), outline its Gi* hot and cold
 * spots, or run the Local Moran's I cluster test. InsightsPanel owns the
 * dialog and passes a small kit (see render()).
 */
const LensesPanel = (() => {
    const LAYER_ID = 'lenses';
    const MAX_OUTLINE = 600;
    const _runs = new Map();    // city -> Promise<result>
    let _open = null;           // lens id whose details are expanded
    let _painted = null;        // city whose layer is registered
    let _preset = 'clinic';     // siting preset on show
    const SITING_ID = 'siting';

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function _btn(label, onClick, cls, title) {
        const b = _el('button', cls || 'ui-chip', label);
        b.type = 'button';
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    function result(city, store) {
        if (!_runs.has(city)) {
            const p = UrbanLenses.run(city, store);
            _runs.set(city, p);
            p.catch(() => _runs.delete(city));
            if (_runs.size > 3) _runs.delete(_runs.keys().next().value);
        }
        return _runs.get(city);
    }

    /** Which outline colour a hot / cold spot gets, by the lens's direction. */
    function _kinds(field) {
        if (field.higherIs === 'worse') return { hot: 'concern', cold: 'strength' };
        if (field.higherIs === 'better') return { hot: 'strength', cold: 'concern' };
        return { hot: 'anomaly', cold: 'trend' };
    }

    async function _paint(r, field, extrude = true) {
        if (typeof CellStore === 'undefined' || typeof CellLayers === 'undefined') return false;
        if (_painted !== r.city || !CellStore.isLocal(LAYER_ID)) {
            const layer = UrbanLenses.toLayer(r, LAYER_ID);
            if (!layer) return false;
            if (CellLayers.isVisible(LAYER_ID)) CellLayers.hide(LAYER_ID);
            CellStore.register(layer.spec, layer.table);
            _painted = r.city;
        }
        _flyToCity(r.city);
        return CellLayers.show(LAYER_ID, { field, extrude });
    }

    /** Frame the city when the map is looking somewhere else. */
    function _flyToCity(city) {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        const spec = typeof CellStore !== 'undefined' ? CellStore.get('population') : null;
        const b = ((spec && spec.regions) || []).find(x => x.name === city)?.bbox;
        if (!map || !b || !map.getCenter) return;
        const c = map.getCenter();
        if (c.lat >= b.south && c.lat <= b.north && c.lng >= b.west && c.lng <= b.east) return;
        try { map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 900 }); } catch { /* not ready */ }
    }

    /** Remove the lens layer (InsightsPanel.clear calls this). */
    function clear() {
        if (typeof CellLayers !== 'undefined' && CellLayers.isVisible(LAYER_ID)) CellLayers.hide(LAYER_ID);
        if (typeof BuildingData !== 'undefined' && BuildingData.get && String(BuildingData.get().color || '').startsWith(`${LAYER_ID}:`)) BuildingData.set({ color: null });
        if (typeof CellStore !== 'undefined' && CellStore.isLocal(LAYER_ID)) CellStore.unregister(LAYER_ID);
        if (typeof CellLayers !== 'undefined' && CellLayers.isVisible(SITING_ID)) CellLayers.hide(SITING_ID);
        if (typeof CellStore !== 'undefined' && CellStore.isLocal(SITING_ID)) CellStore.unregister(SITING_ID);
        _painted = null;
    }

    let _league = null;
    function _loadLeague() {
        if (!_league) {
            _league = fetch('data/lenses/league.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
        }
        return _league;
    }

    /** "Across the cities": the city's rank on each lens metric. */
    async function _leagueCard(r) {
        const data = await _loadLeague();
        const rows = UrbanLenses.leagueFor(data, r.city);
        if (!rows.length) return null;
        const card = _el('section', 'ui-lens');
        card.dataset.lens = 'league';
        card.appendChild(_el('div', 'ui-lens-title', `${r.cityLabel} across ${rows[0].of} cities`));
        card.appendChild(_el('div', 'ui-muted', `Rank 1 is best. Precomputed ${data.generated} with the same lenses.`));
        const tbl = _el('div', 'ui-lens-area');
        for (const x of rows) {
            const row = _el('div', 'ui-lens-arow');
            row.appendChild(_el('span', null, x.label));
            row.appendChild(_el('span', `ui-lens-num${x.rank === 1 ? ' is-good' : x.rank === x.of ? ' is-bad' : ''}`, `#${x.rank} · ${x.value}${x.unit === '%' ? '%' : ` ${x.unit}`}`));
            row.appendChild(_el('span', 'ui-muted', x.rank === 1 ? `best of ${x.of}; worst ${x.worst.city} (${x.worst.value})` : `best ${x.best.city} (${x.best.value})`));
            tbl.appendChild(row);
        }
        card.appendChild(tbl);
        return card;
    }

    /** Mobility scorecard: every city on access, flow, safety and walking (0–100 between worst and best city). */
    async function _mobilityCard(r) {
        if (!UrbanLenses.scorecard) return null;
        const sc = UrbanLenses.scorecard(await _loadLeague());
        if (!sc) return null;
        const me = sc.cities.find(x => x.city === r.city);
        const card = _el('section', 'ui-lens');
        card.dataset.lens = 'mobility';
        card.appendChild(_el('div', 'ui-lens-title', `🚦 Mobility scorecard${me ? `: ${r.cityLabel} #${me.rank} of ${sc.cities.length}` : ''}`));
        card.appendChild(_el('div', 'ui-muted', `0–100 between the worst and best city on each measure; ${sc.pillars.map(p => `${p.label.toLowerCase()} = ${p.metrics.map(id => sc.metrics[id].label.replace(/^./, ch => ch.toLowerCase())).join(', ')}`).join('; ')}.`));
        const tbl = _el('div', 'ui-lens-area');
        for (const x of sc.cities) {
            const row = _el('div', 'ui-lens-arow');
            row.appendChild(_el('span', null, `${x.rank}. ${x.label}`));
            row.appendChild(_el('span', `ui-lens-num${x.rank === 1 ? ' is-good' : x.rank === sc.cities.length ? ' is-bad' : ''}${x.city === r.city ? ' is-current' : ''}`, `${x.overall}/100`));
            row.appendChild(_el('span', 'ui-muted', sc.pillars.map(p => `${p.label} ${x.pillars[p.id] ?? '–'}`).join(' · ')));
            tbl.appendChild(row);
        }
        card.appendChild(tbl);
        if (me) card.appendChild(_el('div', 'ui-muted', `${r.cityLabel} is strongest on ${me.best.label.replace(/^./, ch => ch.toLowerCase())} and weakest on ${me.worst.label.replace(/^./, ch => ch.toLowerCase())}.`));
        return card;
    }

    /** The selected ~1 km cell read through every lens, against its city. */
    function _areaCard(r, prefix) {
        const prof = UrbanLenses.areaProfile(r, prefix);
        if (!prof || !prof.rows.length) return null;
        const card = _el('section', 'ui-lens ui-lens--area');
        card.dataset.lens = 'area';
        card.appendChild(_el('div', 'ui-lens-title', `Your selection: ${DigiPin.format(prof.prefix)} (~1 km, ${prof.people.toLocaleString('en-IN')} residents)`));
        card.appendChild(_el('div', 'ui-muted', 'Each lens here against the whole city. “Better off than” is the share of the city’s residents this place beats.'));
        const tbl = _el('div', 'ui-lens-area');
        for (const x of prof.rows) {
            const row = _el('div', 'ui-lens-arow');
            row.appendChild(_el('span', null, `${x.icon} ${x.label}`));
            row.appendChild(_el('span', 'ui-lens-num', `${x.area} vs ${x.city}${x.unit && x.unit !== '0-100' ? ` ${x.unit}` : ''}`));
            const b = _el('span', `ui-muted${x.betterThan != null ? (x.betterThan >= 60 ? ' is-good' : x.betterThan <= 40 ? ' is-bad' : '') : ''}`,
                x.betterThan != null ? `better off than ${x.betterThan}%` : '');
            row.appendChild(b);
            tbl.appendChild(row);
        }
        card.appendChild(tbl);
        return card;
    }

    /** The siting card: preset chips, AHP weights, candidate sites. */
    function _sitingCard(kit, r) {
        const card = _el('section', 'ui-lens');
        card.dataset.lens = 'siting';
        const draw = () => {
            card.replaceChildren();
            const st = UrbanLenses.site(r, _preset, { layerId: SITING_ID });
            const head = _el('div', 'ui-lens-head');
            head.appendChild(_el('span', 'ui-lens-icon', '📍'));
            const ttl = _el('div', 'ui-lens-ttl');
            ttl.appendChild(_el('div', 'ui-lens-title', 'Siting suitability'));
            ttl.appendChild(_el('div', 'ui-muted', 'Where should the next facility go? Weighted overlay with AHP weights.'));
            head.appendChild(ttl);
            card.appendChild(head);
            const chips = _el('div', 'ui-actions');
            for (const [id, P] of Object.entries(UrbanLenses.PRESETS)) {
                chips.appendChild(_btn(`${P.icon} ${P.title}`, () => { _preset = id; draw(); }, `ui-chip${id === _preset ? ' active' : ''}`));
            }
            card.appendChild(chips);
            if (!st) { card.appendChild(_el('div', 'ui-muted', 'Not enough data in this city for this preset.')); return; }
            card.appendChild(_el('div', 'ui-headline', st.headline));
            const kpis = _el('div', 'ui-kpis');
            for (const x of st.stats) {
                const t = _el('div', 'ui-kpi');
                t.appendChild(_el('div', 'ui-kpi-lbl', x.label));
                t.appendChild(_el('div', 'ui-kpi-val', x.value));
                kpis.appendChild(t);
            }
            card.appendChild(kpis);
            card.appendChild(_el('div', 'ui-lens-num', 'Candidate sites'));
            const list = _el('ol', 'ui-lens-sites');
            for (const x of st.sites) {
                const li = _el('li');
                li.appendChild(_btn(x.code, () => {
                    if (typeof MapModule !== 'undefined' && MapModule.selectByCode) MapModule.selectByCode(x.code);
                }, 'ui-chip ui-chip--code', `Open ${x.code}`));
                li.appendChild(_el('span', 'ui-muted', ` score ${x.score} · ${x.why}`));
                list.appendChild(li);
            }
            card.appendChild(list);
            const acts = _el('div', 'ui-actions');
            acts.appendChild(_btn('▦ Map suitability in 3D', async () => {
                if (typeof CellStore === 'undefined' || typeof CellLayers === 'undefined') return;
                if (CellLayers.isVisible(SITING_ID)) CellLayers.hide(SITING_ID);
                CellStore.register(st.layer.spec, st.layer.table);
                _flyToCity(r.city);
                const ok = await CellLayers.show(SITING_ID, { field: st.fields[0].key, extrude: true });
                if (!ok && kit.toast) kit.toast('Layer unavailable', 'Could not paint the suitability layer.', 'warning');
            }, 'ui-chip'));
            acts.appendChild(_btn('◉ Outline sites', () => kit.highlight(st.sites.map(x => ({ code: x.code, kind: 'strength' })), { fit: true }), 'ui-chip'));
            if (kit.copy) acts.appendChild(_btn('⧉ Copy', () => kit.copy(st.headline + '\n' + st.sites.map(x => `${x.rank}. ${x.code} (score ${x.score}): ${x.why}`).join('\n')), 'ui-chip'));
            card.appendChild(acts);
            const det = _el('details', 'ui-lens-method');
            det.appendChild(_el('summary', null, 'Method and sources'));
            det.appendChild(_el('div', null, st.method));
            det.appendChild(_el('div', 'ui-muted', `References: ${st.refs}`));
            if (kit.sourcesFooter) {
                const srcs = r.sources.filter(x => st.sources.includes(x.id));
                if (srcs.length) det.appendChild(kit.sourcesFooter(srcs));
            }
            card.appendChild(det);
        };
        draw();
        return card;
    }

    function _lorenz(kit, lz) {
        if (!lz || !kit.sparkline) return null;
        return kit.sparkline([
            { values: lz.map(p => p[0]), cls: 'is-city' },
            { values: lz.map(p => p[1]) },
        ], { w: 120, h: 44, label: 'Lorenz curve: share of residents (x) against share of the total (y); the straight line is perfect equality' });
    }

    function _giniWord(g) {
        if (g == null) return '';
        if (g < 0.2) return 'evenly spread';
        if (g < 0.35) return 'moderately unequal';
        if (g < 0.5) return 'unequal';
        return 'highly unequal';
    }

    function _card(kit, r, l) {
        const card = _el('section', 'ui-lens');
        card.dataset.lens = l.id;
        const head = _el('div', 'ui-lens-head');
        head.appendChild(_el('span', 'ui-lens-icon', l.icon));
        const ttl = _el('div', 'ui-lens-ttl');
        ttl.appendChild(_el('div', 'ui-lens-title', l.title));
        ttl.appendChild(_el('div', 'ui-muted', l.question));
        head.appendChild(ttl);
        card.appendChild(head);
        card.appendChild(_el('div', 'ui-headline', l.headline));

        const kpis = _el('div', 'ui-kpis');
        for (const s of l.stats) {
            const t = _el('div', 'ui-kpi');
            t.appendChild(_el('div', 'ui-kpi-lbl', s.label));
            t.appendChild(_el('div', 'ui-kpi-val', s.value));
            kpis.appendChild(t);
        }
        card.appendChild(kpis);

        if (l.series && kit.sparkline) {
            for (const sr of Object.values(l.series)) {
                const sv = kit.sparkline([{ values: sr.values }], { w: 380, h: 40, label: sr.label });
                if (!sv) continue;
                const box = _el('div', 'ui-lens-series');
                box.append(_el('div', 'ui-muted', `${sr.label}, ${sr.steps[0] || ''} to ${sr.steps[sr.steps.length - 1] || ''}`), sv);
                card.appendChild(box);
            }
        }
        const read = _el('div', 'ui-lens-read');
        if (l.equity && l.equity.gini != null) {
            const eq = _el('div', 'ui-lens-eq');
            const txt = _el('div');
            txt.appendChild(_el('div', 'ui-lens-num', `Gini ${l.equity.gini}`));
            txt.appendChild(_el('div', 'ui-muted', `${_giniWord(l.equity.gini)} across residents${l.equity.palma != null ? ` · top 10% ÷ bottom 40%: ${l.equity.palma}×` : ''}`));
            eq.appendChild(txt);
            const sv = _lorenz(kit, l.equity.lorenz);
            if (sv) eq.appendChild(sv);
            read.appendChild(eq);
        }
        if (l.hotspots && l.hotspots.moranI != null) {
            const hs = _el('div', 'ui-lens-hs');
            hs.appendChild(_el('div', 'ui-lens-num', l.hotspots.reading));
            hs.appendChild(_el('div', 'ui-muted', `Moran’s I ${l.hotspots.moranI} (z ${l.hotspots.z}) · ${l.hotspots.hot.length.toLocaleString('en-IN')} hot, ${l.hotspots.cold.length.toLocaleString('en-IN')} cold cells (Gi*, 95%)`));
            read.appendChild(hs);
        }
        card.appendChild(read);

        const field = l.fields[0];
        const kinds = _kinds(l.fields.find(f => f.key === (l.hotspots && l.hotspots.field)) || field);
        const acts = _el('div', 'ui-actions');
        for (const f of l.fields) {
            acts.appendChild(_btn(`▦ Map ${l.fields.length > 1 ? f.label.toLowerCase() : 'in 3D'}`, async () => {
                const ok = await _paint(r, f.key, f.type !== 'category');
                if (!ok && kit.toast) kit.toast('Layer unavailable', 'Could not paint this lens here.', 'warning');
            }, 'ui-chip', `Show ${f.label} as a 3D cell layer`));
        }
        if (l.hotspots && l.hotspots.hot.length) {
            acts.appendChild(_btn('◉ Hot spots', () => kit.highlight(l.hotspots.hot.slice(0, MAX_OUTLINE).map(code => ({ code, kind: kinds.hot })), { fit: true }),
                'ui-chip', 'Outline the statistically significant high clusters (Getis-Ord Gi*)'));
        }
        if (l.hotspots && l.hotspots.cold.length) {
            acts.appendChild(_btn('○ Cold spots', () => kit.highlight(l.hotspots.cold.slice(0, MAX_OUTLINE).map(code => ({ code, kind: kinds.cold })), { fit: true }),
                'ui-chip', 'Outline the statistically significant low clusters (Getis-Ord Gi*)'));
        }
        const lisaOut = _el('div', 'ui-muted ui-lens-lisa');
        acts.appendChild(_btn('✣ Clusters & outliers', () => {
            lisaOut.textContent = 'Running 99 permutations…';
            setTimeout(() => {
                const c = UrbanLenses.clusters(r, l.id);
                if (!c) { lisaOut.textContent = 'Not available for this lens.'; return; }
                lisaOut.textContent = `Local Moran’s I (p ≤ 0.05): ${c.HH.length} high-high, ${c.LL.length} low-low clusters; `
                    + `${c.HL.length} high-low and ${c.LH.length} low-high outliers (outlined; outliers in amber/indigo).`;
                kit.highlight([
                    ...c.HH.slice(0, MAX_OUTLINE / 2).map(code => ({ code, kind: kinds.hot })),
                    ...c.LL.slice(0, MAX_OUTLINE / 4).map(code => ({ code, kind: kinds.cold })),
                    ...c.HL.slice(0, 60).map(code => ({ code, kind: 'anomaly' })),
                    ...c.LH.slice(0, 60).map(code => ({ code, kind: 'trend' })),
                ], { fit: true });
            }, 0);
        }, 'ui-chip', 'Local Moran’s I with a permutation test: clusters and spatial outliers'));
        card.appendChild(acts);
        card.appendChild(lisaOut);

        const det = _el('details', 'ui-lens-method');
        if (_open === l.id) det.open = true;
        det.addEventListener('toggle', () => { if (det.open) _open = l.id; });
        det.appendChild(_el('summary', null, 'Method and sources'));
        det.appendChild(_el('div', null, l.method));
        det.appendChild(_el('div', 'ui-muted', `References: ${l.refs}`));
        if (l.missing && l.missing.length) det.appendChild(_el('div', 'ui-muted', `Not available here: ${l.missing.join(', ')}`));
        if (kit.sourcesFooter) {
            const srcs = r.sources.filter(s => l.sources.includes(s.id));
            if (srcs.length) det.appendChild(kit.sourcesFooter(srcs));
        }
        card.appendChild(det);
        return card;
    }

    /**
     * Draw the tab into `body`. kit: { store, city, cities, isCurrent(),
     * setCity(c), highlight(cells, opts), sourcesFooter(sources), sparkline,
     * toast, copy(text) }.
     */
    async function render(body, kit) {
        const pick = _el('div', 'ui-citypick');
        for (const c of kit.cities || []) {
            pick.appendChild(_btn(c.label, () => kit.setCity(c.name), `ui-chip${c.name === kit.city ? ' active' : ''}`));
        }
        body.appendChild(pick);
        const wait = _el('div', 'ui-empty', `Combining datasets for ${UrbanInsights.cityLabel(kit.city)}…`);
        body.appendChild(wait);
        let r;
        try {
            r = await result(kit.city, kit.store);
        } catch (e) {
            if (kit.isCurrent()) wait.textContent = `Could not compute the lenses: ${e && e.message ? e.message : e}`;
            return;
        }
        if (!kit.isCurrent()) return;
        wait.remove();
        const intro = _el('div', 'ui-lens-intro');
        intro.appendChild(_el('div', 'ui-headline', `${r.cityLabel}: ${r.lenses.length} lenses over ${r.residents.toLocaleString('en-IN')} residents in ${r.cells.toLocaleString('en-IN')} cells`));
        intro.appendChild(_el('div', 'ui-muted', 'Each lens combines several datasets with an established urban-analytics method and answers in people. Equity is population-weighted; hot and cold spots are statistically tested.'));
        const tools = _el('div', 'ui-actions');
        if (kit.copy) tools.appendChild(_btn('⧉ Copy summary', () => kit.copy(UrbanLenses.toText(r)), 'ui-chip'));
        tools.appendChild(_btn('✕ Clear map', () => { clear(); if (kit.clearHighlight) kit.clearHighlight(); }, 'ui-chip'));
        intro.appendChild(tools);
        body.appendChild(intro);
        const sel = kit.selected ? kit.selected() : null;
        if (sel) {
            const card = _areaCard(r, String(sel).replace(/-/g, '').slice(0, 6));
            if (card) body.appendChild(card);
        }
        const leagueSlot = _el('div');
        body.appendChild(leagueSlot);
        _leagueCard(r).then(c => { if (c && kit.isCurrent()) leagueSlot.replaceWith(c); }).catch(() => {});
        const mobSlot = _el('div');
        body.appendChild(mobSlot);
        _mobilityCard(r).then(c => { if (c && kit.isCurrent()) mobSlot.replaceWith(c); }).catch(() => {});
        for (const l of r.lenses) body.appendChild(_card(kit, r, l));
        body.appendChild(_sitingCard(kit, r));
    }

    return { render, result, clear, LAYER_ID };
})();

if (typeof window !== 'undefined') {
    window.LensesPanel = LensesPanel;
}
