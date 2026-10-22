/**
 * DishaIntel — grounds DISHA in the cell store (js/urban-insights.js).
 *
 *   match(question)        routes "what's notable here", "what if we add a
 *                          park / double density / it floods", "compare
 *                          Indore with Pune" and "rank the cities" to the
 *                          deterministic engine, so they answer offline too
 *   answer(el, intent, ctx) renders that answer as cards in the chat and
 *                          returns its plain text for the model to narrate
 *   evidence(cell)         the cited [C#] evidence block for the selected cell
 *   decorate(el, cites)    turns [C#] tags in a reply into source-card chips
 *
 * match() and citeTags() are pure and unit-tested.
 */
const DishaIntel = (() => {
    const RE = {
        insights: /\b(what('?s| is)? (notable|special|unusual|interesting)|stands? out|insights?|hotspots?|anomal(y|ies)|what('?s| is) (going on|happening)|trends? (here|in this))\b/i,
        cool: /\b(plant(ing)?|add(ing)?|more)\b.{0,20}\btrees?\b|\btree cover\b|\bcool(ing)? (down )?(the |this )?(area|street|neighbourhood|neighborhood|city)\b/i,
        closure: /\b(close|closing|closed|shut(ting)?|block(ed|ing)?)\b.{0,25}\b(road|roads|street|junction|flyover|bridge)\b|\broad closure\b/i,
        park: /\b(add(ing)?|new|build(ing)?|create|plant(ing)?)\b.{0,20}\b(park|garden|green space|forest)\b|\bpark here\b/i,
        density: /\b(double|triple|more|increase|densif\w*|(\d(\.\d)?)\s*x)\b.{0,25}\b(density|population|residents|people|housing|homes|units)\b/i,
        flood: /\b(flood(s|ed|ing)? (event|scenario|hits?|happens?)|if it floods|heavy rain|cloudburst|(severe|extreme|moderate) flood|inundat\w*)\b/i,
        dashboard: /\b(rank(ing|ed)? (the )?cities|which city is (best|better|most|least)|city (dashboard|rankings?|league)|best city|compare (all )?cities)\b/i,
        compare: /\b(compare|vs\.?|versus|better than)\b/i,
        // Urban lenses (js/urban-lenses.js): combined-dataset questions about people.
        lens: {
            heat: /\b(heat[\s-]?(vulnerab\w*|risk|wave|stress|exposure)|hottest neighbourhoods?|who (suffers|is most at risk) .{0,20}heat)\b/i,
            flood: /\b(flood\s?plain|flood (exposure|exposed)|(how many|people|residents|population|who)\b.{0,30}\b(flood(ed|s|ing)?|floodplain)\b.{0,20}\b(live|exposed|risk|zone|area))/i,
            fifteen: /\b(15|fifteen)[\s-]?min(ute)?s?\b|\bwalk(ing|able)? (to|distance (to|of)) (daily|essentials?|shops|amenities)|\bdaily needs\b|\bland[\s-]?use mix\b/i,
            waterlog: /\b(water[\s-]?log\w*|rain(water)? (pools?|pooling|collects?|stagnat\w*)|pluvial|urban flood\w*|stagnant water|where (does )?(the )?rain(water)? (collect|pool|stand)s?)\b/i,
            noise: /\b(noise|nois(y|ier|iest)|loud|decibels?|honking|road noise|sound pollution)\b/i,
            traffic: /\b(traffic (load|jams?|congestion|volume|flow|movement)|congest\w*|jams?|peak[\s-]?hour|rush hour|level of service|busiest roads?|bottlenecks?|evening (traffic|peak)|traffic (at|by|through the) (night|day|hour|time)|time of day traffic)\b/i,
            cutoff: /\b(cut off|stranded|isolated|lose access|cannot reach)\b.{0,40}\bfloods?\b|\bfloods?\b.{0,40}\b(cut off|stranded|isolat\w*|lose access|access to (hospitals?|health\s?care|clinics?))\b/i,
            transit: /\b(public transport|transit|bus stops?|metro|stations?)\b.{0,20}\b(access|accessibility|coverage|reach|walk\w*|near\w*|far)\b|\b(access|walk\w*|near\w*|far) to (a |the )?(public transport|transit|bus stops?|metro|stations?)\b|\bsdg 11\.2\b/i,
            health: /\b(health\s?care|hospitals?|clinics?|doctors?)\b.{0,15}\b(access|accessibility|deserts?|scarc\w*|shortages?|reach)\b|\baccess to (health\s?care|hospitals?|clinics?|doctors?)\b|\bcare deserts?\b|\b2sfca\b/i,
            air: /\b(pm\s?2\.?5|air[\s-]?pollution exposure|breathe|dirty air|(people|residents|who)\b.{0,25}\b(polluted|pollution)\b)/i,
            lights: /\b(night[\s-]?lights?|luminosity|economic activity)\b/i,
            walk: /\b(walkability index|how walkable|walkable (streets?|city|fabric)|intersection density|street connectivity)\b/i,
            sprawl: /\b(sprawl\w*|compact(ness)?|infill|leapfrog\w*|density gradient|urban (expansion|growth pattern))\b/i,
            types: /\b(archetypes?|typolog\w*|kinds? of (places?|neighbou?rhoods?)|types? of neighbou?rhoods?|neighbou?rhood types?|cluster(s|ing)? of neighbou?rhoods?)\b/i,
            green: /\b(3[\s-]?30[\s-]?300|tree canopy (rule|target|cover)|green space within|enough (trees|green))\b/i,
            solar: /\b(roof\s?top solar|solar (potential|roofs?|power|capacity)|how much solar)\b/i,
            confidence: /\b(data (confidence|quality|completeness)|how (reliable|accurate|complete) is (the|this) data|osm completeness|can i trust)\b/i,
            seasons: /\b(season(al|s)?|which months?|worst months?|months? (of|with) (heat|pollution|smog)|getting (hotter|warmer)|warming)\b/i,
            burden: /\b(compound (risk|hazard)s?|multi[\s-]?hazard|triple burden|most at risk overall)\b/i,
            all: /\b(equity|inequal\w*|unequal|unfair|gini|fairness|left behind|urban lens(es)?|lenses)\b/i,
        },
        tour: /\b(tour|fly (me )?(through|over|around)|show me around|walk me through (the |this )?city|city overview|overview of (the |this )?city)\b/i,
        where: /\bwhere\b.{0,40}\b(hotter|warmer|cooler|colder|greener|less green|browner|drier|wetter|rainier|more polluted|cleaner|dirtier|chang(ed|e) (the )?most|moved most)\b/i,
        changes: /\b(what('?s| has| have)? changed|what changed|latest (month|data|changes?)|this month|recent(ly)? chang\w*|what'?s new)\b/i,
    };

    function _cities() {
        if (typeof UrbanInsights === 'undefined' || typeof CellStore === 'undefined') return [];
        return UrbanInsights.cities(CellStore);
    }

    /** Cities named in a question, in order of mention. */
    function citiesIn(question, cities) {
        const q = String(question || '').toLowerCase();
        const hits = [];
        for (const c of cities || []) {
            const names = [c.label.toLowerCase(), c.name.replace(/_pilot$/, '').replace(/_/g, ' ')];
            if (c.name === 'delhi') names.push('new delhi');
            if (c.name === 'bengaluru') names.push('bangalore');
            if (c.name === 'mumbai') names.push('bombay');
            const at = Math.min(...names.map(n => { const m = new RegExp(`\\b${n}\\b`).exec(q); return m ? m.index : Infinity; }));
            if (at < Infinity) hits.push({ city: c.name, at });
        }
        return hits.sort((a, b) => a.at - b.at).map(h => h.city);
    }

    // Named-road what-ifs: "what if MG Road closes at 6 pm", "widen AB Road".
    const ROAD_WORD = '(?:ring road|road|rd|marg|street|highway|flyover|bridge|expressway|bypass|avenue|setu|path)';
    const ROAD_VERB_FIRST = new RegExp(`\\b(close|closing|shut(?:ting)?|block(?:ing)?|widen(?:ing)?)\\s+(?:down\\s+)?([a-z0-9][\\w.'\\- ]{0,40}?\\b${ROAD_WORD})\\b`, 'i');
    const ROAD_NAME_FIRST = new RegExp(`([a-z0-9][\\w.'\\- ]{0,40}?\\b${ROAD_WORD})\\s+(?:is |was |were |gets? |got |to be )?(closed|closes|closing|shut|blocked|widened)\\b`, 'i');
    const LEAD = /^(?:(?:what|if|happens|happen|when|would|will|suppose|imagine|we|i|they|the|a|an|and|then|say)\s+)+/i;
    const GENERIC = /^(?:a|an|the|this|that|any|one|main|my|our|some|every|each|nearby|local|busy|busiest)?\s*$/i;

    /** {action, road, period} for a named-road closure/widening question, or null. Pure. */
    function roadAsk(question) {
        const q = String(question || '');
        let action = null, road = null;
        let m = ROAD_VERB_FIRST.exec(q);
        if (m) { action = /widen/i.test(m[1]) ? 'widen' : 'close'; road = m[2]; }
        else if ((m = ROAD_NAME_FIRST.exec(q))) { action = /widen/i.test(m[2]) ? 'widen' : 'close'; road = m[1]; }
        if (!road) return null;
        road = road.replace(LEAD, '').trim();
        const core = road.replace(new RegExp(`\\s*\\b${ROAD_WORD}$`, 'i'), '');
        if (GENERIC.test(core) || core.length < 2) return null;
        const period = /\b(evening|6\s?pm|18:00|19:00|7\s?pm|going home|return trip)\b/i.test(q) ? 'pm' : 'am';
        return { action, road, period };
    }

    /** Route a question to the insights engine, or null. Pure given `cities`. */
    function match(question, cities) {
        const q = String(question || '');
        if (!q.trim()) return null;
        const named = citiesIn(q, cities);
        if (RE.dashboard.test(q)) return { type: 'dashboard' };
        if (RE.where.test(q)) {
            const w = RE.where.exec(q)[1].toLowerCase();
            const topic = /hott|warm|cool|cold/.test(w) ? 'heat' : /green|brown/.test(w) ? 'green' : /dri|wet|rain/.test(w) ? 'rain' : /pollut|clean|dirt/.test(w) ? 'air' : null;
            const out = { type: 'where', topic, dir: /cool|cold|less green|brown|dri|clean/.test(w) ? 'down' : /hott|warm|green|wet|rain|pollut|dirt/.test(w) ? 'up' : null };
            if (named.length) out.city = named[0];
            return out;
        }
        if (RE.tour.test(q)) {
            const out = { type: 'tour', play: /\b(tour|fly|show me around|walk me)\b/i.test(q) };
            if (named.length) out.city = named[0];
            return out;
        }
        if (RE.changes.test(q)) return named.length ? { type: 'changes', city: named[0] } : { type: 'changes' };
        if (RE.compare.test(q) && named.length >= 2) return { type: 'compare', a: { city: named[0] }, b: { city: named[1] } };
        const siting = /\bwhere (should|to|could|would|can)\b.{0,40}\b(clinics?|hospitals?|health (centre|center)s?|schools?|parks?|cool roofs?|ev|charg\w*)\b|\b(best|ideal|suitable) (locations?|sites?|places?) for\b|\bsite (selection|suitability)\b|\bsiting\b/i;
        if (siting.test(q)) {
            const preset = /\bschool/i.test(q) ? 'school' : /\bpark|garden|green/i.test(q) ? 'park' : /\bcool roof/i.test(q) ? 'cool_roofs'
                : /\bev\b|charg/i.test(q) ? 'ev_charging' : 'clinic';
            const out = { type: 'lens', lens: 'siting', preset };
            if (named.length) out.city = named[0];
            return out;
        }
        if (/\bwhat[\s-]?if\b|\bimagine\b|\bsimulate\b|\bscenario\b|\bif (we|they|i)\b|\bwiden/i.test(q) || RE.park.test(q) || RE.flood.test(q) || RE.cool.test(q) || RE.closure.test(q)) {
            const ra = roadAsk(q);
            if (ra) return named.length ? { type: 'roadwhatif', ...ra, city: named[0] } : { type: 'roadwhatif', ...ra };
            if (RE.closure.test(q)) return { type: 'whatif', scenario: 'closure' };
            if (RE.cool.test(q)) {
                const m = /(\d{1,2})\s*(%|percent|pts|points)/i.exec(q);
                return { type: 'whatif', scenario: 'cool', trees: m ? Number(m[1]) : 20 };
            }
            if (RE.park.test(q)) return { type: 'whatif', scenario: 'park' };
            if (RE.flood.test(q) || /\bflood/i.test(q)) {
                const level = /\bextreme|worst|cloudburst\b/i.test(q) ? 'extreme' : /\bmoderate|minor|light\b/i.test(q) ? 'moderate' : 'severe';
                return { type: 'whatif', scenario: 'flood', level };
            }
            if (RE.density.test(q)) {
                const m = /(\d+(?:\.\d+)?)\s*(x|×|times)/i.exec(q);
                const factor = m ? Number(m[1]) : /\btriple\b/i.test(q) ? 3 : /\bdouble\b/i.test(q) ? 2 : 1.5;
                return { type: 'whatif', scenario: 'density', factor };
            }
        }
        if (RE.density.test(q) && /\bwhat|happen|impact|effect\b/i.test(q)) {
            const m = /(\d+(?:\.\d+)?)\s*(x|×|times)/i.exec(q);
            return { type: 'whatif', scenario: 'density', factor: m ? Number(m[1]) : /\btriple\b/i.test(q) ? 3 : /\bdouble\b/i.test(q) ? 2 : 1.5 };
        }
        for (const [id, re] of Object.entries(RE.lens)) {
            if (!re.test(q)) continue;
            const out = { type: 'lens', lens: id === 'all' ? null : id };
            if (named.length) out.city = named[0];
            return out;
        }
        if (RE.insights.test(q)) return { type: 'insights' };
        return null;
    }

    /** The distinct [C#] tags in a reply, in order. Pure. */
    function citeTags(text) {
        const out = [];
        const re = /\[(C\d{1,2})\]/g;
        let m;
        while ((m = re.exec(String(text || '')))) if (!out.includes(m[1])) out.push(m[1]);
        return out;
    }

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function _bbox() {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (!map || !map.getBounds) return null;
        const b = map.getBounds();
        return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
    }

    function _openButton(label, tab) {
        const b = _el('button', 'disha-scan-export', label);
        b.type = 'button';
        b.addEventListener('click', () => { if (typeof InsightsPanel !== 'undefined') InsightsPanel.open(tab); });
        return b;
    }

    function _viewCenter() {
        const m = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        if (!m || !m.getCenter) return null;
        const c = m.getCenter();
        return { lat: c.lat, lng: c.lng };
    }

    /**
     * Answer an intent from the engine into chat element `el`. ctx = { cell }.
     * Returns the plain-text result (for the model to narrate) or '' on failure.
     */
    async function answer(el, intent, ctx = {}) {
        el.textContent = '';
        if (typeof UrbanInsights === 'undefined' || typeof CellStore === 'undefined' || !CellStore.isEnabled()) {
            el.textContent = 'The per-cell data store is not loaded, so I cannot compute this yet.';
            return '';
        }
        const cell = ctx.cell;
        const center = cell && cell.center;
        let r;
        try {
            if (intent.type === 'insights') {
                const code = cell ? cell.code.replace(/-/g, '').slice(0, 5) : null;
                r = await UrbanInsights.areaInsights(code ? { code, label: `The area around ${DigiPin.format(code)}` } : { bbox: _bbox(), label: 'The map view' }, CellStore, { limit: 6 });
            } else if (intent.type === 'changes') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                r = await UrbanInsights.changes(CellStore, { city, limit: 6 });
            } else if (intent.type === 'where') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                r = await whereChanged(CellStore, { city, topic: intent.topic, dir: intent.dir });
                if (!r) { el.textContent = 'No series here has a year-earlier step to compare with.'; return ''; }
            } else if (intent.type === 'tour') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                if (typeof CityTour === 'undefined') { el.textContent = 'The tour module did not load.'; return ''; }
                const stops = await CityTour.buildStops(city, CellStore);
                if (!stops.length) { el.textContent = 'Not enough data in this city for a tour.'; return ''; }
                r = { kind: 'tour', city, cityLabel: UrbanInsights.cityLabel(city), stops, play: !!intent.play };
            } else if (intent.type === 'lens') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                if (typeof UrbanLenses === 'undefined') { el.textContent = 'The lenses module did not load.'; return ''; }
                const run = typeof LensesPanel !== 'undefined' ? LensesPanel.result(city, CellStore) : UrbanLenses.run(city, CellStore);
                const res = await run;
                if (intent.lens === 'siting') {
                    const st = UrbanLenses.site(res, intent.preset || 'clinic');
                    if (!st) { el.textContent = 'Not enough data in this city to site that.'; return ''; }
                    r = { kind: 'siting', cityLabel: res.cityLabel, st, sources: res.sources.filter(x => st.sources.includes(x.id)) };
                } else r = { ...res, only: intent.lens ? [intent.lens] : null };
            } else if (intent.type === 'dashboard') {
                r = await UrbanInsights.cityDashboard(CellStore);
            } else if (intent.type === 'compare') {
                r = await UrbanInsights.compare(intent.a, intent.b, CellStore);
            } else if (intent.type === 'roadwhatif') {
                if (typeof RoadWhatIf === 'undefined') { el.textContent = 'The road what-if module did not load.'; return ''; }
                if (intent.city && typeof TrafficOverlay !== 'undefined' && TrafficOverlay.region && TrafficOverlay.region() !== intent.city) {
                    const sel = typeof document !== 'undefined' && document.getElementById('city-select');
                    const opt = sel && [...sel.options].find(o => o.value === intent.city || o.value === intent.city.replace(/_pilot$/, ''));
                    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(res => setTimeout(res, 1500)); }
                }
                el.textContent = `Re-routing every commute with ${intent.road} ${intent.action === 'widen' ? 'widened' : 'closed'}…`;
                const a = await RoadWhatIf.ask({ action: intent.action, road: intent.road, period: intent.period });
                el.textContent = '';
                r = { kind: 'roadwhatif', a };
            } else if (intent.type === 'whatif') {
                const sc = { type: intent.scenario };
                let heights = null;
                if (intent.scenario === 'flood') {
                    sc.level = intent.level;
                    const b = _bbox();
                    if (b) sc.area = { bbox: b, label: 'the map view' };
                    if (center) heights = await UrbanInsights.loadHeights(center.lat, center.lng);
                } else {
                    if (!cell) { el.textContent = 'Click a cell on the map first, then ask again: the scenario needs a site.'; return ''; }
                    sc.code = cell.code.replace(/-/g, '');
                    if (intent.factor) sc.factor = intent.factor;
                    if (intent.trees) sc.trees = intent.trees;
                    if (intent.scenario === 'density' && center) heights = await UrbanInsights.loadHeights(center.lat, center.lng);
                }
                r = await UrbanInsights.whatIf(sc, CellStore, { heights });
            }
        } catch (e) {
            el.textContent = e && e.message ? e.message : 'That could not be computed here.';
            return '';
        }
        if (!r) return '';
        _render(el, r);
        if (r.kind === 'where') {
            if (typeof InsightsPanel !== 'undefined' && InsightsPanel.showChange) InsightsPanel.showChange({ city: r.city, dataset: r.item.dataset, field: r.item.key, step: r.item.step });
            const u = r.item.unit;
            return `${r.item.label} in ${r.cityLabel}, ${r.layer.vs} → ${r.layer.step}: city mean ${UrbanInsights.fmt(r.item.prev, u)} → ${UrbanInsights.fmt(r.item.latest, u)}. `
                + `${r.layer.rose} cells rose, ${r.layer.fell} fell. Largest ${r.dir === 'up' ? 'rises' : 'falls'}: ${r.top.map(t => `${t.digipin} (${t.change > 0 ? '+' : ''}${UrbanInsights.fmt(t.change, u)})`).join(', ')}. The change is now mapped in 3D (red rose, blue fell).`;
        }
        if (r.kind === 'tour') {
            if (r.play) CityTour.play(r.city, CellStore);
            return `Briefing on ${r.cityLabel}${r.play ? ' (the 3D tour is now flying through these stops)' : ''}:\n${r.stops.map((x, i) => `${i + 1}. ${x.label}: ${x.caption}`).join('\n')}`;
        }
        if (r.kind === 'roadwhatif') return RoadWhatIf.askText(r.a);
        if (r.kind === 'siting') return `${r.st.title} in ${r.cityLabel}: ${r.st.headline}\n${r.st.sites.map(x => `${x.rank}. ${x.code} (score ${x.score}): ${x.why}`).join('\n')}`;
        return r.kind === 'lenses' ? UrbanLenses.toText(r, r.only) : UrbanInsights.toText(r);
    }

    const TOPIC = { heat: /lst|surface temp|heat/i, green: /ndvi|green|vegetation|tree/i, rain: /rain|precip/i, air: /no2|no₂|pm|aerosol|pollut|air/i };

    /**
     * Where a series moved most across a city: picks the latest change on the
     * topic (or the most unusual one), builds its per-cell change layer and
     * names the cells that moved most in the asked direction.
     */
    async function whereChanged(store, { city, topic, dir }) {
        const ch = await UrbanInsights.changes(store, { city, limit: 40 });
        const pool = topic ? ch.items.filter(x => TOPIC[topic].test(`${x.dataset} ${x.key} ${x.label}`)) : ch.items;
        const x = pool[0] || (topic ? null : ch.items[0]);
        if (!x) return null;
        const L = await UrbanInsights.changeLayer(store, { city, dataset: x.dataset, field: x.key, step: x.step });
        if (!L) return null;
        const d = dir || (x.delta >= 0 ? 'up' : 'down');
        const order = L.table.cells.map((c, i) => i).sort((a, b) => (d === 'up' ? L.table.columns.change[b] - L.table.columns.change[a] : L.table.columns.change[a] - L.table.columns.change[b]));
        const top = order.slice(0, 5).map(i => ({ code: L.table.cells[i], digipin: DigiPin.format(L.table.cells[i]), change: L.table.columns.change[i] }));
        return { kind: 'where', city, cityLabel: UrbanInsights.cityLabel(city), item: x, layer: L, dir: d, top };
    }

    function _render(el, r) {
        const head = _el('div', 'disha-scan-header');
        const P = typeof InsightsPanel !== 'undefined' ? InsightsPanel : null;
        if (r.kind === 'insights') {
            head.textContent = 'What stands out';
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.headline));
            if (P) r.findings.forEach(f => el.appendChild(P.findingCard(f, { compact: true })));
            el.appendChild(_openButton('Open full insights', 'here'));
        } else if (r.kind === 'changes') {
            head.textContent = `What changed in ${r.cityLabel} · latest ${r.latest}`;
            el.appendChild(head);
            r.items.forEach(x => el.appendChild(_el('div', 'disha-scan-row', `${x.title}. ${x.detail}`)));
            el.appendChild(_openButton('Open the city dashboard', 'city'));
        } else if (r.kind === 'where') {
            const u = r.item.unit;
            head.textContent = `Where ${r.item.label} ${r.dir === 'up' ? 'rose' : 'fell'} most · ${r.cityLabel}, ${r.layer.vs} → ${r.layer.step}`;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', `City mean ${UrbanInsights.fmt(r.item.prev, u)} → ${UrbanInsights.fmt(r.item.latest, u)}; ${r.layer.rose} cells rose and ${r.layer.fell} fell.`));
            r.top.forEach(t => el.appendChild(_el('div', 'disha-scan-row', `${t.digipin} · ${t.change > 0 ? '+' : ''}${UrbanInsights.fmt(t.change, u)}`)));
            const b = _el('button', 'ui-chip', 'Outline these cells');
            b.type = 'button';
            b.addEventListener('click', () => { if (typeof InsightsPanel !== 'undefined') InsightsPanel.highlight(r.top.map(t => ({ code: t.code, kind: !r.item.higherIs ? 'anomaly' : (r.dir === 'up') === (r.item.higherIs === 'worse') ? 'concern' : 'strength' })), { fit: true }); });
            el.appendChild(b);
        } else if (r.kind === 'tour') {
            head.textContent = `Briefing · ${r.cityLabel}`;
            el.appendChild(head);
            r.stops.filter(x => x.id !== 'end').forEach(x => el.appendChild(_el('div', 'disha-scan-row', `${x.label}: ${x.caption}`)));
            const b = _el('button', 'ui-chip ui-chip--primary', r.play ? '▶ Replay the 3D tour' : '▶ Fly the 3D tour');
            b.type = 'button';
            b.addEventListener('click', () => CityTour.play(r.city, CellStore));
            el.appendChild(b);
        } else if (r.kind === 'dashboard') {
            head.textContent = 'City rankings';
            el.appendChild(head);
            r.cities.forEach(c => el.appendChild(_el('div', 'disha-scan-row', `${c.rank}. ${c.label} · urban index ${c.index} · best at ${c.strengths.map(s => s.label.toLowerCase()).join(', ')}`)));
            el.appendChild(_openButton('Open the city dashboard', 'city'));
        } else if (r.kind === 'compare') {
            head.textContent = `${r.a.label} vs ${r.b.label}`;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.summary));
            r.rows.slice(0, 6).forEach(x => el.appendChild(_el('div', 'disha-scan-row',
                `${x.label}: ${UrbanInsights.fmt(x.a, x.unit)} vs ${UrbanInsights.fmt(x.b, x.unit)}${x.winner === 'a' ? ` (${r.a.label})` : x.winner === 'b' ? ` (${r.b.label})` : ''}`)));
            el.appendChild(_openButton('Open the comparison', 'compare'));
        } else if (r.kind === 'siting') {
            head.textContent = `${r.st.title} · ${r.cityLabel}`;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.st.headline));
            r.st.sites.slice(0, 5).forEach(x => el.appendChild(_el('div', 'disha-scan-row', `${x.rank}. ${DigiPin.format(x.code)} · score ${x.score} · ${x.why}`)));
            el.appendChild(_el('div', 'disha-scan-hint', `Weights (AHP, CR ${r.st.consistency}): ${r.st.weights.map(w => `${w.label} ${Math.round(w.weight * 100)}%`).join(', ')}`));
            el.appendChild(_openButton('Open the lenses', 'lenses'));
        } else if (r.kind === 'lenses') {
            head.textContent = `Urban lenses · ${r.cityLabel}`;
            el.appendChild(head);
            for (const l of r.lenses.filter(x => !r.only || r.only.includes(x.id))) {
                el.appendChild(_el('div', 'ui-headline', `${l.icon} ${l.title}`));
                el.appendChild(_el('div', 'disha-scan-row', l.headline));
                const bits = [];
                if (l.equity && l.equity.gini != null) bits.push(`Gini ${l.equity.gini} across residents`);
                if (l.hotspots && l.hotspots.moranI != null) bits.push(`${l.hotspots.reading} (Moran’s I ${l.hotspots.moranI})`);
                if (bits.length) el.appendChild(_el('div', 'disha-scan-hint', bits.join(' · ')));
                if (r.only) el.appendChild(_el('div', 'disha-scan-hint', `Method: ${l.method}`));
            }
            el.appendChild(_openButton('Open the lenses', 'lenses'));
        } else if (r.kind === 'roadwhatif') {
            const a = r.a;
            head.textContent = a.ok ? `Road what-if · ${a.action === 'widen' ? 'widen' : 'close'} ${a.road} · ${a.period === 'pm' ? '18:00' : '09:00'}` : 'Road what-if';
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', a.ok ? a.headline : a.error));
            if (a.ok) {
                const row = (x) => `${x.name}: V/C ${x.base.toFixed(2)} → ${x.scen.toFixed(2)}`;
                if (a.worse.length) el.appendChild(_el('div', 'disha-scan-row', `Busier: ${a.worse.map(row).join(' · ')}`));
                if (a.better.length) el.appendChild(_el('div', 'disha-scan-row', `Quieter: ${a.better.map(row).join(' · ')}`));
                el.appendChild(_el('div', 'disha-scan-hint', 'Commute re-routed on the modelled arterials (destinations fixed). Edit it in the What-if panel by the Traffic legend.'));
            }
        } else if (r.kind === 'whatif') {
            head.textContent = r.title;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.summary));
            r.metrics.forEach(m => el.appendChild(_el('div', 'disha-scan-row', `${m.label}: ${m.value != null ? m.value : `${m.before} → ${m.after}`}`)));
            el.appendChild(_el('div', 'disha-scan-hint', `Formula: ${r.formula}`));
            el.appendChild(_openButton('Open in What-if', 'whatif'));
        }
        if (r.sources && r.sources.length) {
            el.appendChild(_el('div', 'disha-scan-hint', `Sources: ${r.sources.map(s => s.title).join(' · ')}`));
        }
    }

    /** Cited evidence for the selected cell, or { text:'', citations:[] }. */
    async function evidence(cell) {
        if (!cell || !cell.center || typeof UrbanInsights === 'undefined' || typeof CellStore === 'undefined' || !CellStore.isEnabled()) {
            return { text: '', citations: [] };
        }
        try { return await UrbanInsights.evidence(cell.center.lat, cell.center.lng, CellStore); } catch { return { text: '', citations: [] }; }
    }

    /**
     * Replace [C#] tags in a rendered reply with chips that open the cited
     * dataset's source card, and add a "Sources" line for what was cited.
     */
    function decorate(el, citations) {
        if (!el || !citations || !citations.length || typeof document === 'undefined') return [];
        const byTag = new Map(citations.map(c => [c.tag, c]));
        const used = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) if (/\[C\d{1,2}\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
        for (const node of nodes) {
            const frag = document.createDocumentFragment();
            const parts = node.nodeValue.split(/(\[C\d{1,2}\])/);
            for (const part of parts) {
                const m = /^\[(C\d{1,2})\]$/.exec(part);
                const c = m && byTag.get(m[1]);
                if (!c) { frag.appendChild(document.createTextNode(part)); continue; }
                if (!used.includes(c)) used.push(c);
                const chip = _el('button', 'disha-cite', c.tag);
                chip.type = 'button';
                chip.title = `${c.title}: ${c.source}${c.license ? ` (${c.license})` : ''}`;
                chip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const next = chip.nextElementSibling;
                    if (next && next.classList.contains('source-card')) { next.remove(); return; }
                    if (typeof Provenance === 'undefined') return;
                    const spec = CellStore.get(c.id);
                    const card = Provenance.renderCard(spec ? Provenance.fromSpec(spec, CellStore.generated(), CellStore.isLocal(c.id)) : { source: c.source, license: c.license });
                    chip.insertAdjacentElement('afterend', card);
                });
                frag.appendChild(chip);
            }
            node.parentNode.replaceChild(frag, node);
        }
        if (used.length) {
            const src = _el('div', 'disha-cite-sources', `Cited: ${used.map(c => `${c.tag} ${c.title}`).join(' · ')}`);
            el.appendChild(src);
        }
        return used;
    }

    return { match, roadAsk, citiesIn, citeTags, answer, evidence, decorate, whereChanged, cities: _cities };
})();

if (typeof window !== 'undefined') {
    window.DishaIntel = DishaIntel;
}
