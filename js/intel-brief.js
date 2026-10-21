/**
 * IntelBrief — share links and printable briefs for the Urban Intelligence dialog.
 *
 * Two jobs, both pure apart from build() reading the cell store:
 *
 *   Links   the dialog's state (tab, city, area, compare pair, what-if) as
 *           query params, so URLState share links and saved views reopen the
 *           exact Intel view:
 *             &intel=<tab>          city | here | compare | whatif
 *             &ic=<region>          the city (cell-store region name)
 *             &ia=<area> &ib=<area> area tokens: city:<region> | p:<prefix> | b:w,s,e,n
 *             &wi=<scenario>        park:<code>:<boost> | density:<code>:<factor> | flood:<level>
 *
 *   Briefs  a self-contained HTML document (no scripts, no network) for a city
 *           and optionally an area and a what-if: headline, key indicators and
 *           rank, monthly environment with sparklines, city ranking, best/worst
 *           zones, what stands out, hotspots, the scenario, and a source card
 *           for every dataset used. Opens in a tab for Print → Save as PDF.
 */
const IntelBrief = (() => {
    const SCHEMA = 'digipin.brief/1';
    const TABS = ['city', 'here', 'compare', 'whatif'];
    const FLOOD = ['moderate', 'severe', 'extreme'];
    const REGION_RE = /^[a-z][a-z0-9_]{0,63}$/;
    const CODE_RE = /^[2-9CFJKLMPT]{1,10}$/;

    function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

    // ── area + scenario tokens ──────────────────────────────────────────────

    /** Area object → link token, or '' when it cannot travel in a link. */
    function areaToken(a) {
        if (!a) return '';
        if (a.city && REGION_RE.test(a.city)) return `city:${a.city}`;
        const code = a.code ? String(a.code).replace(/-/g, '').toUpperCase() : '';
        if (CODE_RE.test(code)) return `p:${code}`;
        const b = a.bbox;
        if (b && [b.west, b.south, b.east, b.north].every(Number.isFinite)) {
            return `b:${[b.west, b.south, b.east, b.north].map(v => Math.round(v * 1e5) / 1e5).join(',')}`;
        }
        return '';
    }

    /** Link token → area object (with a readable label), or null. */
    function parseAreaToken(s) {
        if (!s) return null;
        const m = /^(city|p|b):(.+)$/.exec(String(s).trim());
        if (!m) return null;
        if (m[1] === 'city') return REGION_RE.test(m[2]) ? { city: m[2] } : null;
        if (m[1] === 'p') {
            const code = m[2].replace(/-/g, '').toUpperCase();
            if (!CODE_RE.test(code)) return null;
            const label = typeof DigiPin !== 'undefined' && DigiPin.format ? DigiPin.format(code) : code;
            return { code, label: `${code.length <= 5 ? 'Neighbourhood' : 'Cell'} ${label}` };
        }
        const v = m[2].split(',').map(_num);
        if (v.length !== 4 || v.some(x => x == null)) return null;
        const [west, south, east, north] = v;
        if (!(west < east && south < north) || Math.abs(south) > 90 || Math.abs(north) > 90) return null;
        return { bbox: { west, south, east, north }, label: 'The shared map view' };
    }

    /** Scenario object → token ('' when incomplete). */
    function scenarioToken(s) {
        if (!s || !s.type) return '';
        const code = s.code ? String(s.code).replace(/-/g, '').toUpperCase() : '';
        if (s.type === 'park' && CODE_RE.test(code)) return `park:${code}:${_num(s.boost) ?? 30}`;
        if (s.type === 'density' && CODE_RE.test(code)) return `density:${code}:${_num(s.factor) ?? 2}`;
        if (s.type === 'flood' && FLOOD.includes(s.level)) return `flood:${s.level}`;
        return '';
    }

    function parseScenarioToken(s) {
        const p = String(s || '').split(':');
        if (p[0] === 'flood') return FLOOD.includes(p[1]) ? { type: 'flood', level: p[1] } : null;
        if (p[0] !== 'park' && p[0] !== 'density') return null;
        const code = (p[1] || '').toUpperCase();
        if (!CODE_RE.test(code)) return null;
        const v = _num(p[2]);
        if (p[0] === 'park') return { type: 'park', code, boost: v != null ? Math.max(10, Math.min(80, v)) : 30 };
        return { type: 'density', code, factor: v != null ? Math.max(1.1, Math.min(4, v)) : 2 };
    }

    // ── link params ─────────────────────────────────────────────────────────

    /** URLSearchParams (or a query string) → Intel link state, or null. */
    function parseParams(p) {
        const q = p instanceof URLSearchParams ? p : new URLSearchParams(p || '');
        const tab = q.get('intel');
        if (!tab || !TABS.includes(tab)) return null;
        const st = { tab };
        if (REGION_RE.test(q.get('ic') || '')) st.city = q.get('ic');
        const a = parseAreaToken(q.get('ia'));
        const b = parseAreaToken(q.get('ib'));
        if (a) st.a = a;
        if (b) st.b = b;
        const sc = parseScenarioToken(q.get('wi'));
        if (sc) st.scenario = sc;
        return st;
    }

    /** Intel link state → [key, value] pairs in a stable order. */
    function toParams(st) {
        if (!st || !TABS.includes(st.tab)) return [];
        const out = [['intel', st.tab]];
        if (st.city && REGION_RE.test(st.city)) out.push(['ic', st.city]);
        const a = areaToken(st.a), b = areaToken(st.b);
        if (a) out.push(['ia', a]);
        if (b) out.push(['ib', b]);
        const w = scenarioToken(st.scenario);
        if (w) out.push(['wi', w]);
        return out;
    }

    // ── building a brief ────────────────────────────────────────────────────

    /**
     * Gather everything a brief shows. opts: { city, area?, whatif?, link?, now? }.
     * `whatif` is an already-computed UrbanInsights.whatIf result.
     */
    async function build(opts, store) {
        const UI = UrbanInsights;
        const now = opts.now ? opts.now() : new Date();
        const dash = await UI.cityDashboard(store, { now: () => now });
        const city = opts.city || (dash.cities[0] || {}).region || null;
        const row = dash.cities.find(c => c.region === city) || null;
        const cityIns = city ? await UI.areaInsights({ city }, store, { limit: 8, now: () => now }) : null;
        const areaIns = opts.area && !opts.area.city ? await UI.areaInsights(opts.area, store, { limit: 8, city, now: () => now }) : null;
        const seen = new Set();
        const sources = [];
        for (const r of [dash, cityIns, areaIns, opts.whatif]) {
            for (const s of (r && r.sources) || []) {
                const id = typeof s === 'string' ? s : s.id;
                if (seen.has(id)) continue;
                seen.add(id);
                const spec = store.get(id);
                if (spec) sources.push({ ...UI.sourceOf(spec, store), description: spec.description || '' });
            }
        }
        return {
            schema: SCHEMA, ranAt: now.toISOString(), city, cityLabel: UI.cityLabel(city),
            dashboard: { dataset: dash.dataset, fields: dash.fields, cities: dash.cities, row, method: dash.method },
            cityInsights: cityIns, areaInsights: areaIns, whatif: opts.whatif || null,
            link: opts.link || null, sources,
        };
    }

    // ── HTML ────────────────────────────────────────────────────────────────

    function _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function _f(v, unit) { return _esc(UrbanInsights.fmt(v, unit)); }

    function _spark(values, w = 160, h = 32) {
        const vs = (values || []).map(_num);
        const ok = vs.filter(v => v != null);
        if (ok.length < 2) return '';
        const lo = Math.min(...ok), hi = Math.max(...ok);
        const pts = vs.map((v, i) => (v == null ? null
            : `${((i / (vs.length - 1)) * w).toFixed(1)},${(h - 2 - (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (h - 4)).toFixed(1)}`)).filter(Boolean);
        return `<svg class="sp" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
    }

    function _base(link) { return link ? String(link).split('?')[0] : ''; }

    function _cell(code, link) {
        const d = _esc(code);
        const b = _base(link);
        return b ? `<a href="${_esc(b)}?cell=${encodeURIComponent(String(code).replace(/-/g, ''))}">${d}</a>` : `<code>${d}</code>`;
    }

    const KIND = { strength: 'Strength', concern: 'Concern', notable: 'Notable', trend: 'Trend', anomaly: 'Anomaly' };

    function _findings(r, link) {
        if (!r) return '';
        const items = r.findings.map(f => `<li class="k-${_esc(f.kind)}"><span class="tag">${_esc(KIND[f.kind] || f.kind)}</span> `
            + `<b>${_esc(f.title)}</b><br><span class="muted">${_esc(f.detail)}</span>`
            + (f.cells && f.cells.length ? `<br><span class="muted">Cells: ${f.cells.slice(0, 3).map(c => _cell(c.digipin, link)).join(', ')}</span>` : '')
            + ` <a class="src" href="#src-${_esc(f.dataset || (f.sources || [])[0])}">source</a></li>`).join('');
        const hs = r.hotspots && r.hotspots.length
            ? `<h3>Hotspots</h3><ul class="plain">${r.hotspots.map(h => `<li class="k-${_esc(h.kind)}">${_cell(h.digipin, link)} ${_esc(h.why)}</li>`).join('')}</ul>` : '';
        return `<p class="lead">${_esc(r.headline)}</p>`
            + (items ? `<ul class="find">${items}</ul>` : `<p class="muted">Nothing stands out from ${_esc(r.cityLabel)} in the published data.</p>`)
            + hs;
    }

    function _whatif(w, link) {
        if (!w) return '';
        const rows = w.metrics.map(m => `<tr${m.flag ? ' class="flag"' : ''}><td>${_esc(m.label)}</td><td class="num">`
            + (m.value != null ? `<b>${_esc(m.value)}</b>` : `${_esc(m.before)} → <b>${_esc(m.after)}</b>`) + '</td></tr>').join('');
        const cells = (w.cells || []).slice(0, 12).map(c => _cell(c.digipin, link)).join(', ');
        return `<section><h2>What-if: ${_esc(w.title)}</h2><p class="lead">${_esc(w.summary)}</p>`
            + `<table><tbody>${rows}</tbody></table>`
            + (cells ? `<p class="muted">${w.type === 'flood' ? 'Most exposed cells' : 'Cells affected'}: ${cells}</p>` : '')
            + `<p class="muted"><b>How:</b> ${_esc(w.formula)}</p>`
            + (w.assumptions && w.assumptions.length ? `<ul class="muted">${w.assumptions.map(a => `<li>${_esc(a)}</li>`).join('')}</ul>` : '')
            + '</section>';
    }

    /** Self-contained HTML document for a brief from build(). */
    function toHTML(brief) {
        const d = brief.dashboard;
        const c = d.row;
        const n = d.cities.length;
        const link = brief.link;
        const when = new Date(brief.ranAt);
        const date = isNaN(when) ? brief.ranAt : when.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        const area = brief.areaInsights;
        const title = area ? `${area.area.label || 'Area'} · ${brief.cityLabel}` : brief.cityLabel;

        let kpi = '';
        if (c) {
            kpi = `<section class="hero"><div class="big"><div class="num">${_esc(c.index ?? '—')}</div><div class="muted">Urban index</div></div>`
                + `<div><p class="lead">#${_esc(c.rank)} of ${n} cities. Best at ${_esc(c.strengths.map(s => s.label.toLowerCase()).join(' and '))}; `
                + `weakest at ${_esc(c.weaknesses.map(s => s.label.toLowerCase()).join(' and '))}.</p>`
                + `<p class="muted">${_esc(c.active.toLocaleString('en-IN'))} built-up cells (~${_esc(c.areaKm2.toLocaleString('en-IN'))} km²) of ${_esc(c.cells.toLocaleString('en-IN'))} on the grid.</p></div></section>`
                + `<section><h2>Key indicators</h2><table><thead><tr><th>Indicator</th><th class="num">${_esc(brief.cityLabel)}</th><th class="num">Rank</th><th class="num">Best city</th></tr></thead><tbody>`
                + d.fields.map(f => {
                    const ind = c.indicators[f.key];
                    const best = d.cities.find(x => x.indicators[f.key].rank === 1);
                    return `<tr><td>${_esc(f.label)}${f.higherIs === 'worse' ? ' <span class="muted">(lower is better)</span>' : ''}</td>`
                        + `<td class="num"><b>${_f(ind.mean, f.unit)}</b></td><td class="num">${ind.rank ? `#${_esc(ind.rank)}` : '—'}</td>`
                        + `<td class="num">${best ? `${_esc(best.label)} ${_f(best.indicators[f.key].mean, f.unit)}` : '—'}</td></tr>`;
                }).join('')
                + `</tbody></table><p class="src">Source: <a href="#src-${_esc(d.dataset)}">${_esc((brief.sources.find(s => s.id === d.dataset) || {}).title || d.dataset)}</a></p></section>`;
            if (c.extras.length) {
                kpi += `<section><h2>Environment, month by month</h2><div class="env">`
                    + c.extras.map(e => {
                        const bad = e.higherIs === 'worse' ? e.yoy > 0 : e.higherIs === 'better' ? e.yoy < 0 : null;
                        return `<div class="tile"><div class="muted">${_esc(e.label)}</div><div class="val">${_f(e.mean, e.unit)}</div>`
                            + (e.yoy != null ? `<div class="${bad === true ? 'bad' : bad === false ? 'good' : 'muted'}">${e.yoy > 0 ? '▲ +' : '▼ '}${_f(e.yoy, e.unit)} year on year</div>` : '')
                            + _spark(e.series) + `<a class="src" href="#src-${_esc(e.dataset)}">source</a></div>`;
                    }).join('') + '</div></section>';
            }
            const z = c.zones;
            const zl = (rows) => rows.map(r => `<li>${_cell(r.digipin, link)} <b>${_esc(r.mean)}</b> <span class="muted">(${_esc(r.cells)} cells)</span></li>`).join('');
            kpi += `<section><h2>Zones of ${_esc(brief.cityLabel)} (~4 km)</h2><div class="cols">`
                + `<div><h3 class="k-strength">Most livable</h3><ol>${zl(z.best)}</ol></div>`
                + `<div><h3 class="k-concern">Least livable</h3><ol>${zl(z.worst)}</ol></div>`
                + `<div><h3 class="k-concern">Flood hotspots</h3><ol>${zl(z.flood)}</ol></div></div></section>`;
        }

        const rank = n ? `<section><h2>How the cities rank</h2><table><thead><tr><th>City</th><th class="num">Index</th>`
            + d.fields.map(f => `<th class="num" title="${_esc(f.label)}">${_esc(f.label.replace(/ (Index|Score)$/, ''))}</th>`).join('') + '</tr></thead><tbody>'
            + d.cities.map(x => `<tr${x.region === brief.city ? ' class="cur"' : ''}><td>${_esc(x.rank)}. ${_esc(x.label)}</td><td class="num"><b>${_esc(x.index ?? '—')}</b></td>`
                + d.fields.map(f => { const m = x.indicators[f.key].mean; return `<td class="num">${m == null ? '—' : Math.round(m)}</td>`; }).join('') + '</tr>').join('')
            + `</tbody></table><p class="muted">${_esc(d.method)}</p></section>` : '';

        const cards = brief.sources.map(s => `<div class="card" id="src-${_esc(s.id)}"><h3>${_esc(s.title)}</h3>`
            + (s.description ? `<p>${_esc(s.description)}</p>` : '')
            + `<dl><dt>Dataset</dt><dd><code>${_esc(s.id)}</code></dd><dt>Cell size</dt><dd>DIGIPIN level ${_esc(s.level)}${s.approxCellM ? ` (~${_esc(s.approxCellM)} m)` : ''}</dd>`
            + (s.period ? `<dt>Period</dt><dd>${_esc(s.period)}</dd>` : '')
            + (s.source ? `<dt>Built by</dt><dd><code>${_esc(s.source)}</code></dd>` : '')
            + (s.license ? `<dt>Licence</dt><dd>${_esc(s.license)}</dd>` : '')
            + (s.generated ? `<dt>Store built</dt><dd>${_esc(s.generated)}</dd>` : '')
            + '</dl></div>').join('');

        const method = (brief.cityInsights || area || {}).method;
        return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            + `<title>${_esc(title)} · DigiPin brief</title><style>${CSS}</style></head><body><main>`
            + `<header><p class="kicker">DigiPin urban intelligence brief</p><h1>${_esc(title)}</h1>`
            + `<p class="meta">Computed ${_esc(date)}${link ? ` · <a href="${_esc(link)}">Open this view in DigiPin</a>` : ''}</p>`
            + `<p class="muted noscreen">Print this page (Ctrl/⌘ P) to save it as a PDF.</p></header>`
            + (area ? `<section><h2>What stands out in ${_esc(area.area.label || 'this area')}</h2>${_findings(area, link)}</section>` : '')
            + _whatif(brief.whatif, link)
            + kpi
            + (brief.cityInsights ? `<section><h2>What stands out in ${_esc(brief.cityLabel)}</h2>${_findings(brief.cityInsights, link)}</section>` : '')
            + rank
            + `<section><h2>Sources</h2><div class="cards">${cards || '<p class="muted">No datasets were used.</p>'}</div>`
            + (method ? `<p class="muted">${_esc(method)}</p>` : '')
            + `<p class="muted">Computed in the browser from the DigiPin per-cell data store (${_esc(brief.schema)}). Scores are model estimates from open data, not surveys.</p></section>`
            + '</main></body></html>';
    }

    const CSS = [
        ':root{--ink:#1e293b;--sub:#64748b;--line:#e2e8f0;--soft:#f8fafc;--accent:#dd6b4a;--bg:#fff;--good:#15803d;--bad:#b91c1c;--note:#7c3aed}',
        '@media (prefers-color-scheme:dark){:root{--ink:#e2e8f0;--sub:#94a3b8;--line:#334155;--soft:#1e293b;--bg:#0f172a;--good:#4ade80;--bad:#f87171;--note:#c4b5fd}}',
        '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}',
        'main{max-width:860px;margin:0 auto;padding:28px 16px 40px}h1{font-size:26px;margin:2px 0 4px}h2{font-size:16px;margin:0 0 8px}h3{font-size:13px;margin:8px 0 4px}',
        '.kicker{margin:0;color:var(--accent);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.meta{color:var(--sub);margin:0 0 4px}',
        'header{border-bottom:2px solid var(--ink);padding-bottom:12px;margin-bottom:18px}section{margin:0 0 24px}a{color:var(--accent)}',
        '.lead{font-size:15px;margin:0 0 8px}.muted{color:var(--sub);font-size:12px}.src{color:var(--sub);font-size:11px}',
        '.hero{display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:center;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:14px 16px}',
        '.big .num{font-size:44px;font-weight:700;line-height:1;color:var(--accent)}',
        'table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}th{color:var(--sub);font-weight:600}',
        '.num{text-align:right;font-variant-numeric:tabular-nums}tr.cur td{background:var(--soft);font-weight:600}tr.flag td{color:var(--bad)}',
        '.env{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.tile{border:1px solid var(--line);border-radius:8px;padding:8px 10px}.tile .val{font-size:18px;font-weight:600}',
        '.sp{display:block;color:var(--accent);margin-top:4px}.good{color:var(--good);font-size:12px}.bad{color:var(--bad);font-size:12px}',
        '.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.cols ol{margin:0;padding-left:18px}',
        '@media (max-width:600px){.cols{grid-template-columns:1fr}.hero{grid-template-columns:1fr}}',
        'ul.find,ul.plain{list-style:none;margin:0;padding:0}ul.find li,ul.plain li{padding:6px 0 6px 10px;border-left:3px solid var(--line);margin:0 0 6px}',
        '.k-strength{border-color:var(--good)!important}.k-concern{border-color:var(--bad)!important}.k-trend,.k-anomaly{border-color:var(--note)!important}',
        'h3.k-strength{color:var(--good)}h3.k-concern{color:var(--bad)}',
        '.tag{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--sub);border:1px solid var(--line);border-radius:4px;padding:0 4px}',
        '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}.card{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--soft)}.card p{margin:0 0 6px;font-size:12px;color:var(--sub)}',
        'dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;font-size:12px}dt{color:var(--sub)}dd{margin:0}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}',
        '.noscreen{display:block}@media print{.noscreen{display:none}main{padding:0}section{break-inside:avoid}a{color:inherit;text-decoration:none}}',
    ].join('');

    return { SCHEMA, TABS, areaToken, parseAreaToken, scenarioToken, parseScenarioToken, parseParams, toParams, build, toHTML };
})();

if (typeof window !== 'undefined') {
    window.IntelBrief = IntelBrief;
}
