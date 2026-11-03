/**
 * Analysis — saved, re-runnable analyses over the per-cell data store, and the
 * report contract they produce.
 *
 * An analysis is a small JSON template: a list of sections, each naming the
 * cell-store datasets and fields it reads (docs/CELL_STORE.md). Running it over
 * an area (a DIGIPIN prefix or a bbox) gives a report object that carries its
 * own provenance, so the same report can be rendered in the app, downloaded as
 * standalone HTML/JSON, or reopened from a link that re-runs it. Nothing leaves
 * the browser: every number comes from the static store.
 *
 *   template (digipin.analysis/1)
 *     { id, title, description, version, sections:[section] }
 *   section types
 *     summary       { dataset, fields:[key] }                    mean/min/max per field
 *     index         { terms:[{dataset, field, weight}], limit }   weighted 0-100 index
 *     rank          { dataset, field, order:'desc'|'asc', limit } top cells
 *     filter        { dataset, where:[{field, op, value}], limit } cells meeting all rules
 *     distribution  { dataset, field, bins }                      histogram / category counts
 *   report (digipin.report/1)
 *     { schema, analysis, ranAt, area, highlights, sections, sources, map, warnings }
 *
 * Datasets at different levels join on DIGIPIN prefixes: an index mixing the
 * L6 `scores` with the L7 `traffic` averages each L7 cell into its L6 parent.
 *
 * Everything here is pure (the store is injected) and unit-tested;
 * js/analyses-panel.js owns storage, the panel and the map.
 */
const Analysis = (() => {
    const TEMPLATE_SCHEMA = 'digipin.analysis/1';
    const REPORT_SCHEMA = 'digipin.report/1';
    const SECTION_TYPES = ['summary', 'index', 'rank', 'filter', 'distribution'];
    const OPS = ['>', '>=', '<', '<=', '==', '!=', 'in'];

    // Shipped analyses: India-native questions over the datasets in the store.
    const BUILTINS = [
        {
            id: 'neighbourhood-profile',
            title: 'Neighbourhood profile',
            description: 'Headline scores, traffic and law-and-order access for an area, with its best-rated cells.',
            sections: [
                { type: 'summary', title: 'Headline scores', dataset: 'scores',
                    fields: ['livability', 'safety', 'walkability', 'connectivity', 'green', 'healthcare_access', 'education_score', 'flood_risk'] },
                { type: 'summary', title: 'Roads and transit', dataset: 'traffic',
                    fields: ['congestion_risk', 'transit_access', 'transit_stops'] },
                { type: 'distribution', title: 'How livable is it?', dataset: 'scores', field: 'livability', bins: 5 },
                { type: 'distribution', title: 'Worst level of service on the roads', dataset: 'traffic', field: 'worst_los' },
                { type: 'rank', title: 'Most livable cells', dataset: 'scores', field: 'livability', order: 'desc', limit: 5 },
            ],
        },
        {
            id: 'family-home-finder',
            title: 'Family home finder',
            description: 'Ranks cells for a family move: schools, healthcare, safety and livability up; flood risk and congestion down.',
            sections: [
                { type: 'index', title: 'Family-fit index', limit: 10, terms: [
                    { dataset: 'scores', field: 'livability', weight: 3 },
                    { dataset: 'scores', field: 'education_score', weight: 2 },
                    { dataset: 'scores', field: 'healthcare_access', weight: 2 },
                    { dataset: 'scores', field: 'safety', weight: 2 },
                    { dataset: 'scores', field: 'flood_risk', weight: 2 },
                    { dataset: 'traffic', field: 'congestion_risk', weight: 1 },
                ] },
                { type: 'filter', title: 'Low flood risk and good schools', dataset: 'scores', limit: 10,
                    where: [{ field: 'flood_risk', op: '<=', value: 40 }, { field: 'education_score', op: '>=', value: 50 }] },
                { type: 'summary', title: 'Area averages', dataset: 'scores',
                    fields: ['livability', 'education_score', 'healthcare_access', 'safety', 'flood_risk'] },
            ],
        },
        {
            id: 'flood-access-audit',
            title: 'Flood and emergency access audit',
            description: 'Where flood risk is high, which pockets can be sealed off, and how far the nearest police station is.',
            sections: [
                { type: 'filter', title: 'High flood-risk cells', dataset: 'scores', limit: 10,
                    where: [{ field: 'flood_risk', op: '>=', value: 60 }] },
                { type: 'rank', title: 'Highest flood risk', dataset: 'scores', field: 'flood_risk', order: 'desc', limit: 5 },
                { type: 'filter', title: 'Sealable pockets', dataset: 'mobility', limit: 10,
                    where: [{ field: 'sealable', op: '==', value: true }] },
                { type: 'summary', title: 'Emergency access', dataset: 'mobility', fields: ['mobility_risk', 'nearest_police_km'] },
                { type: 'distribution', title: 'Road access class', dataset: 'mobility', field: 'access_class' },
            ],
        },
        {
            id: 'retail-site-scan',
            title: 'Retail site scan',
            description: 'Scores cells for a shop or clinic: footfall proxies and transit up, congestion down.',
            sections: [
                { type: 'index', title: 'Retail opportunity index', limit: 10, terms: [
                    { dataset: 'scores', field: 'commercial', weight: 3 },
                    { dataset: 'scores', field: 'population_proxy', weight: 2 },
                    { dataset: 'scores', field: 'connectivity', weight: 2 },
                    { dataset: 'traffic', field: 'transit_access', weight: 2 },
                    { dataset: 'traffic', field: 'congestion_risk', weight: 1 },
                ] },
                { type: 'rank', title: 'Strongest commercial cells', dataset: 'scores', field: 'commercial', order: 'desc', limit: 5 },
                { type: 'summary', title: 'Area averages', dataset: 'scores', fields: ['commercial', 'population_proxy', 'connectivity', 'investment'] },
            ],
        },
    ].map(t => ({ schema: TEMPLATE_SCHEMA, version: 1, builtin: true, ...t }));

    // ── templates ───────────────────────────────────────────────────────────

    function slug(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'analysis';
    }

    /**
     * Check a template's shape. Returns { ok, errors, template } where template
     * is a normalised copy (schema, id, version filled in). Dataset and field
     * names are checked against `store` when given, since a template may be
     * written before its data is published.
     */
    function validate(tpl, store) {
        const errors = [];
        if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) return { ok: false, errors: ['Template must be a JSON object.'], template: null };
        const title = typeof tpl.title === 'string' ? tpl.title.trim() : '';
        if (!title) errors.push('Give the analysis a "title".');
        if (!Array.isArray(tpl.sections) || !tpl.sections.length) errors.push('Add at least one entry to "sections".');
        const checkField = (where, dataset, field) => {
            if (!dataset || typeof dataset !== 'string') { errors.push(`${where}: "dataset" is required.`); return; }
            if (!field || typeof field !== 'string') { errors.push(`${where}: a field key is required.`); return; }
            if (!store) return;
            const spec = store.get(dataset);
            if (!spec) { errors.push(`${where}: no dataset "${dataset}" in the cell store.`); return; }
            if (!spec.fields.some(f => f.key === field)) errors.push(`${where}: "${dataset}" has no field "${field}".`);
        };
        (Array.isArray(tpl.sections) ? tpl.sections : []).forEach((s, i) => {
            const where = `Section ${i + 1}`;
            if (!s || typeof s !== 'object') { errors.push(`${where}: must be an object.`); return; }
            if (!SECTION_TYPES.includes(s.type)) { errors.push(`${where}: "type" must be one of ${SECTION_TYPES.join(', ')}.`); return; }
            if (s.type === 'summary') {
                if (!Array.isArray(s.fields) || !s.fields.length) errors.push(`${where}: "fields" must list at least one field.`);
                else s.fields.forEach(f => checkField(where, s.dataset, f));
            } else if (s.type === 'index') {
                if (!Array.isArray(s.terms) || !s.terms.length) errors.push(`${where}: "terms" must list at least one {dataset, field, weight}.`);
                else s.terms.forEach(t => {
                    checkField(where, t && t.dataset, t && t.field);
                    if (t && t.weight != null && !Number.isFinite(Number(t.weight))) errors.push(`${where}: weight for "${t.field}" must be a number.`);
                });
            } else if (s.type === 'filter') {
                if (!Array.isArray(s.where) || !s.where.length) errors.push(`${where}: "where" must list at least one {field, op, value}.`);
                else s.where.forEach(w => {
                    checkField(where, s.dataset, w && w.field);
                    if (w && !OPS.includes(w.op)) errors.push(`${where}: op must be one of ${OPS.join(' ')}.`);
                });
            } else {
                checkField(where, s.dataset, s.field);
                if (s.order && !['asc', 'desc'].includes(s.order)) errors.push(`${where}: "order" must be asc or desc.`);
            }
        });
        if (errors.length) return { ok: false, errors, template: null };
        const template = {
            schema: TEMPLATE_SCHEMA,
            version: Number.isFinite(Number(tpl.version)) ? Number(tpl.version) : 1,
            ...tpl,
            id: tpl.id ? slug(tpl.id) : slug(title),
            title,
            description: typeof tpl.description === 'string' ? tpl.description : '',
        };
        delete template.builtin;
        return { ok: true, errors: [], template };
    }

    function builtin(id) { return BUILTINS.find(t => t.id === id) || null; }

    // ── areas ───────────────────────────────────────────────────────────────

    /**
     * Normalise an area. Accepts { code } (a DIGIPIN prefix, dashes optional,
     * 1-10 characters) or { bbox:{west,south,east,north} }, or the share-link
     * form "p:34PLL5" / "b:w,s,e,n". Returns { kind, code?, bbox, label } or null.
     */
    function parseArea(a) {
        if (typeof a === 'string') {
            const m = /^([pb]):(.+)$/.exec(a.trim());
            if (!m) return parseArea({ code: a });
            if (m[1] === 'p') return parseArea({ code: m[2] });
            const n = m[2].split(',').map(Number);
            if (n.length !== 4) return null;
            return parseArea({ bbox: { west: n[0], south: n[1], east: n[2], north: n[3] } });
        }
        if (!a || typeof a !== 'object') return null;
        if (a.code != null) {
            const code = String(a.code).replace(/-/g, '').trim().toUpperCase();
            if (!code || code.length > 10) return null;
            let bounds;
            try { bounds = DigiPin.decodePartial(code).bounds; } catch { return null; }
            return { kind: 'prefix', code, bbox: { west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north },
                label: a.label || `DIGIPIN ${DigiPin.format(code)}` };
        }
        const b = a.bbox;
        if (b && [b.west, b.south, b.east, b.north].every(Number.isFinite) && b.east > b.west && b.north > b.south) {
            const r = (x) => Math.round(x * 1e5) / 1e5;
            const bbox = { west: r(b.west), south: r(b.south), east: r(b.east), north: r(b.north) };
            return { kind: 'bbox', bbox, label: a.label || `${bbox.south.toFixed(3)}–${bbox.north.toFixed(3)}°N, ${bbox.west.toFixed(3)}–${bbox.east.toFixed(3)}°E` };
        }
        return null;
    }

    /** Share-link form of an area: "p:<code>" or "b:w,s,e,n". */
    function areaParam(area) {
        if (!area) return '';
        if (area.kind === 'prefix') return `p:${area.code}`;
        const b = area.bbox;
        return `b:${[b.west, b.south, b.east, b.north].join(',')}`;
    }

    /** Indices of a table's cells that fall in the area. */
    function cellsInArea(table, area) {
        const out = [];
        if (!table || !area) return out;
        if (area.kind === 'prefix') {
            const p = area.code;
            for (let i = 0; i < table.cells.length; i++) {
                const c = table.cells[i];
                // Finer data: every cell under the prefix. Coarser data: the one
                // cell that contains the whole area.
                if (c.length >= p.length ? c.startsWith(p) : p.startsWith(c)) out.push(i);
            }
            return out;
        }
        const b = area.bbox;
        for (let i = 0; i < table.cells.length; i++) {
            let c;
            try { c = DigiPin.decodePartial(table.cells[i]); } catch { continue; }
            if (c.lat >= b.south && c.lat <= b.north && c.lng >= b.west && c.lng <= b.east) out.push(i);
        }
        return out;
    }

    // ── maths ───────────────────────────────────────────────────────────────

    const _round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

    function stats(values) {
        const xs = values.filter(v => v != null && Number.isFinite(Number(v))).map(Number);
        if (!xs.length) return { n: 0, mean: null, min: null, max: null };
        let lo = Infinity, hi = -Infinity, sum = 0;
        for (const x of xs) { sum += x; if (x < lo) lo = x; if (x > hi) hi = x; }
        return { n: xs.length, mean: sum / xs.length, min: lo, max: hi };
    }

    function _domain(f, values) {
        if (Array.isArray(f.domain) && f.domain.length === 2 && f.domain.every(Number.isFinite) && f.domain[1] > f.domain[0]) return f.domain;
        const s = stats(values);
        return s.n && s.max > s.min ? [s.min, s.max] : null;
    }

    /** 0-100 where 100 is "good": inverted when the field's higherIs is "worse". */
    function normalise(v, domain, higherIs) {
        if (v == null || !Number.isFinite(Number(v)) || !domain) return null;
        const t = Math.max(0, Math.min(1, (Number(v) - domain[0]) / (domain[1] - domain[0])));
        return (higherIs === 'worse' ? 1 - t : t) * 100;
    }

    function _test(v, op, want) {
        if (v == null) return false;
        switch (op) {
            case '>': return Number(v) > Number(want);
            case '>=': return Number(v) >= Number(want);
            case '<': return Number(v) < Number(want);
            case '<=': return Number(v) <= Number(want);
            case '==': return typeof want === 'boolean' ? !!v === want : String(v) === String(want);
            case '!=': return typeof want === 'boolean' ? !!v !== want : String(v) !== String(want);
            case 'in': return Array.isArray(want) && want.map(String).includes(String(v));
            default: return false;
        }
    }

    function _fieldMeta(spec, key) {
        const f = spec.fields.find(x => x.key === key) || { key, label: key, type: 'number' };
        return { key: f.key, label: f.label || f.key, unit: f.unit || '', type: f.type || 'number', higherIs: f.higherIs || null };
    }

    function _cellRef(code, extra) {
        let c = null;
        try { c = DigiPin.decodePartial(code); } catch { /* bad code */ }
        return { digipin: DigiPin.format(code), lat: c ? _round(c.lat, 5) : null, lng: c ? _round(c.lng, 5) : null, ...extra };
    }

    // ── run ─────────────────────────────────────────────────────────────────

    /**
     * Run a template over an area. `store` defaults to the global CellStore and
     * needs get(id) and load(id). `opts.now` and `opts.link(template, area)`
     * make output deterministic in tests. Resolves to a digipin.report/1 object.
     */
    async function run(template, areaIn, store, opts = {}) {
        store = store || (typeof CellStore !== 'undefined' ? CellStore : null);
        const area = parseArea(areaIn);
        if (!area) throw new Error('Pick an area: a DIGIPIN prefix or a map extent.');
        const v = validate(template, null);
        if (!v.ok) throw new Error(v.errors.join(' '));
        const tpl = v.template;
        const warnings = [];
        const used = new Map();     // dataset id -> { spec, inArea }
        const loaded = new Map();

        async function ds(id) {
            if (loaded.has(id)) return loaded.get(id);
            const spec = store && store.get(id);
            const table = spec ? await store.load(id) : null;
            const entry = spec && table ? { spec, table, idx: cellsInArea(table, area) } : null;
            if (!spec) warnings.push(`Dataset "${id}" is not in the cell store, so its sections are empty.`);
            else if (!table) warnings.push(`No data is published for "${spec.title}" yet.`);
            else {
                if (!entry.idx.length) warnings.push(`${spec.title} has no cells in this area.`);
                else if (area.kind === 'prefix' && area.code.length > spec.level) {
                    warnings.push(`${spec.title} is stored at level ${spec.level} (~${spec.approxCellM || '?'} m), coarser than this area, so it reports the one cell that contains it.`);
                }
                used.set(id, { spec, inArea: entry.idx.length });
            }
            loaded.set(id, entry);
            return entry;
        }

        const sections = [];
        let mapLayer = null;
        for (let si = 0; si < tpl.sections.length; si++) {
            const s = tpl.sections[si];
            const base = { id: `s${si + 1}`, type: s.type, title: s.title || _defaultTitle(s) };
            if (s.type === 'index') {
                const out = await _runIndex(s, ds, warnings);
                sections.push({ ...base, ...out.section });
                if (!mapLayer && out.layer) mapLayer = out.layer;
                continue;
            }
            const d = await ds(s.dataset);
            if (!d) { sections.push({ ...base, dataset: s.dataset, empty: true, sources: [s.dataset] }); continue; }
            const { spec, table, idx } = d;
            const col = (k) => idx.map(i => (table.columns[k] || [])[i] ?? null);
            if (s.type === 'summary') {
                const rows = s.fields.map(k => {
                    const st = stats(col(k));
                    return { ..._fieldMeta(spec, k), n: st.n, mean: _round(st.mean), min: _round(st.min), max: _round(st.max) };
                });
                sections.push({ ...base, dataset: spec.id, cells: idx.length, rows, sources: [spec.id] });
            } else if (s.type === 'rank') {
                const order = s.order === 'asc' ? 'asc' : 'desc';
                const limit = Math.max(1, Math.min(100, Number(s.limit) || 10));
                const vals = col(s.field);
                const pairs = idx.map((i, j) => [table.cells[i], vals[j]]).filter(p => p[1] != null && Number.isFinite(Number(p[1])));
                pairs.sort((a, b) => (order === 'asc' ? a[1] - b[1] : b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
                sections.push({ ...base, dataset: spec.id, field: _fieldMeta(spec, s.field), order,
                    rows: pairs.slice(0, limit).map(([c, val]) => _cellRef(c, { value: _round(Number(val)) })), sources: [spec.id] });
                if (!mapLayer && pairs.length) mapLayer = { field: _fieldMeta(spec, s.field), level: table.level, values: pairs.map(([c, val]) => [c, Number(val)]) };
            } else if (s.type === 'filter') {
                const limit = Math.max(1, Math.min(100, Number(s.limit) || 10));
                const hits = idx.filter(i => s.where.every(w => _test((table.columns[w.field] || [])[i], w.op, w.value)));
                const shown = s.where.map(w => w.field).filter((k, i, a) => a.indexOf(k) === i);
                sections.push({ ...base, dataset: spec.id, cells: idx.length, matched: hits.length,
                    share: idx.length ? _round((hits.length / idx.length) * 100) : null,
                    where: s.where.map(w => ({ ...w, label: _fieldMeta(spec, w.field).label })),
                    fields: shown.map(k => _fieldMeta(spec, k)),
                    rows: hits.slice(0, limit).map(i => _cellRef(table.cells[i], Object.fromEntries(shown.map(k => [k, (table.columns[k] || [])[i] ?? null])))),
                    sources: [spec.id] });
            } else if (s.type === 'distribution') {
                const meta = _fieldMeta(spec, s.field);
                const vals = col(s.field).filter(x => x != null);
                let buckets;
                if (meta.type === 'number') {
                    const f = spec.fields.find(x => x.key === s.field) || {};
                    const dom = _domain(f, vals) || [0, 1];
                    const n = Math.max(2, Math.min(10, Number(s.bins) || 5));
                    const w = (dom[1] - dom[0]) / n;
                    buckets = Array.from({ length: n }, (_, b) => ({ label: `${_round(dom[0] + b * w)}–${_round(dom[0] + (b + 1) * w)}`, count: 0 }));
                    for (const x of vals) buckets[Math.max(0, Math.min(n - 1, Math.floor((Number(x) - dom[0]) / w)))].count++;
                } else {
                    const counts = new Map();
                    for (const x of vals) counts.set(String(x), (counts.get(String(x)) || 0) + 1);
                    buckets = [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([label, count]) => ({ label, count }));
                }
                sections.push({ ...base, dataset: spec.id, field: meta, total: vals.length, buckets, sources: [spec.id] });
            }
        }

        const sources = [...used.values()].map(({ spec, inArea }) => ({
            id: spec.id, title: spec.title, description: spec.description || '',
            source: spec.source || '', license: spec.license || '', level: spec.level,
            approxCellM: spec.approxCellM || null, cellsInArea: inArea,
            generated: (store && store.generated) ? store.generated() : null,
        }));
        const link = opts.link ? opts.link(tpl, area) : null;
        return {
            schema: REPORT_SCHEMA,
            analysis: { id: tpl.id, title: tpl.title, description: tpl.description, version: tpl.version, builtin: !!template.builtin },
            template: tpl,
            ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            area,
            highlights: highlights(sections),
            sections,
            sources,
            map: { link, layer: mapLayer },
            warnings: [...new Set(warnings)],
        };
    }

    function _defaultTitle(s) {
        if (s.type === 'index') return 'Weighted index';
        if (s.type === 'summary') return 'Summary';
        if (s.type === 'rank') return `Top cells by ${s.field}`;
        if (s.type === 'filter') return 'Matching cells';
        return `Distribution of ${s.field}`;
    }

    /** Values of one field per cell, rolled up (mean) to `level` when finer. */
    function rollUp(table, field, level, idx) {
        const acc = new Map();
        for (const i of idx) {
            const v = (table.columns[field] || [])[i];
            if (v == null || !Number.isFinite(Number(v))) continue;
            const code = table.cells[i].slice(0, level);
            const a = acc.get(code) || { sum: 0, n: 0 };
            a.sum += Number(v); a.n++;
            acc.set(code, a);
        }
        return new Map([...acc].map(([k, a]) => [k, a.sum / a.n]));
    }

    async function _runIndex(s, ds, warnings) {
        const terms = [];
        for (const t of s.terms) {
            const d = await ds(t.dataset);
            if (!d) continue;
            const f = d.spec.fields.find(x => x.key === t.field);
            if (!f || (f.type && f.type !== 'number')) { warnings.push(`Index term "${t.dataset}.${t.field}" is not numeric, so it was skipped.`); continue; }
            const all = d.table.columns[t.field] || [];
            terms.push({ d, f, weight: Number(t.weight ?? 1), domain: _domain(f, all) });
        }
        const limit = Math.max(1, Math.min(100, Number(s.limit) || 10));
        if (!terms.length) return { section: { empty: true, terms: [], rows: [], sources: s.terms.map(t => t.dataset) } };
        // Join at the coarsest level among the terms: finer cells roll up into their parent.
        const level = Math.min(...terms.map(t => t.d.table.level));
        const per = terms.map(t => rollUp(t.d.table, t.f.key, level, t.d.idx));
        const codes = new Set();
        per.forEach(m => m.forEach((_, k) => codes.add(k)));
        const rows = [];
        for (const code of codes) {
            let wsum = 0, acc = 0;
            const parts = {};
            terms.forEach((t, j) => {
                const raw = per[j].get(code);
                const n = normalise(raw, t.domain, t.f.higherIs);
                parts[`${t.d.spec.id}.${t.f.key}`] = _round(raw);
                if (n == null || !(t.weight > 0)) return;
                acc += n * t.weight; wsum += t.weight;
            });
            if (wsum > 0) rows.push({ code, score: acc / wsum, parts, coverage: wsum });
        }
        const total = terms.reduce((a, t) => a + (t.weight > 0 ? t.weight : 0), 0);
        rows.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));
        const st = stats(rows.map(r => r.score));
        return {
            section: {
                level, cells: rows.length,
                terms: terms.map(t => ({ dataset: t.d.spec.id, ..._fieldMeta(t.d.spec, t.f.key), weight: t.weight, domain: t.domain })),
                mean: _round(st.mean), min: _round(st.min), max: _round(st.max),
                rows: rows.slice(0, limit).map(r => _cellRef(r.code, { score: _round(r.score), parts: r.parts, partial: r.coverage < total })),
                bottom: rows.length > limit ? rows.slice(-Math.min(3, rows.length - limit)).reverse().map(r => _cellRef(r.code, { score: _round(r.score) })) : [],
                sources: [...new Set(terms.map(t => t.d.spec.id))],
            },
            layer: rows.length ? { field: { key: 'index', label: s.title || 'Index', unit: '0-100', type: 'number', higherIs: 'better' },
                level, values: rows.map(r => [r.code, _round(r.score)]) } : null,
        };
    }

    /** One-line findings from the sections, for the top of the report. */
    function highlights(sections) {
        const out = [];
        for (const s of sections) {
            if (s.empty) continue;
            if (s.type === 'index' && s.rows.length) {
                out.push(`${s.title}: best cell ${s.rows[0].digipin} scores ${s.rows[0].score}/100; the area averages ${s.mean} across ${s.cells} cells.`);
            } else if (s.type === 'summary') {
                const best = s.rows.filter(r => r.mean != null);
                if (!best.length) continue;
                const top = best.map(r => `${r.label} ${r.mean}${r.unit && r.unit !== '0-100' ? ' ' + r.unit : ''}`).slice(0, 3).join(', ');
                out.push(`${s.title} (${s.cells} cells): ${top}.`);
            } else if (s.type === 'filter') {
                out.push(`${s.title}: ${s.matched} of ${s.cells} cells (${s.share ?? 0}%).`);
            }
        }
        return out.slice(0, 5);
    }

    // ── report HTML (standalone; also shown in the app) ────────────────────

    function _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function _fmt(v, unit) {
        if (v == null) return '—';
        return unit && unit !== '0-100' ? `${v} ${unit}` : String(v);
    }

    const RAMP = ['#d7191c', '#fdae61', '#ffffbf', '#a6d96a', '#1a9641'];

    function _rampColor(t, higherIs) {
        if (t == null) return '#cbd5e1';
        const u = higherIs === 'worse' ? 1 - t : t;
        return RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.floor(u * RAMP.length)))];
    }

    /** Inline SVG of the area's cells coloured by the report's map layer. */
    function cellMapSVG(report, size = 320) {
        const layer = report.map && report.map.layer;
        const b = report.area.bbox;
        if (!layer || !layer.values.length) return '';
        let { west, south, east, north } = b;
        // Grow to the cells' own extent so coarse cells around a small area show whole.
        const rects = [];
        for (const [code, v] of layer.values) {
            let bb;
            try { bb = DigiPin.decodePartial(code).bounds; } catch { continue; }
            rects.push([bb, v]);
            west = Math.min(west, bb.west); east = Math.max(east, bb.east);
            south = Math.min(south, bb.south); north = Math.max(north, bb.north);
        }
        const k = Math.cos(((south + north) / 2) * Math.PI / 180);
        const wDeg = (east - west) * k, hDeg = north - south;
        const sc = size / Math.max(wDeg, hDeg);
        const W = Math.round(wDeg * sc), H = Math.round(hDeg * sc);
        const vs = layer.values.map(x => x[1]);
        const lo = Math.min(...vs), hi = Math.max(...vs);
        const body = rects.map(([bb, v]) => {
            const x = (bb.west - west) * k * sc, y = (north - bb.north) * sc;
            const w = (bb.east - bb.west) * k * sc, h = (bb.north - bb.south) * sc;
            const t = hi > lo ? (v - lo) / (hi - lo) : 1;
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.5, w).toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${_rampColor(t, layer.field.higherIs)}" stroke="#fff" stroke-width="0.3"/>`;
        }).join('');
        const ax = (b.west - west) * k * sc, ay = (north - b.north) * sc;
        const aw = (b.east - b.west) * k * sc, ah = (b.north - b.south) * sc;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${_esc(layer.field.label)} by DIGIPIN cell">`
            + body
            + `<rect x="${ax.toFixed(1)}" y="${ay.toFixed(1)}" width="${aw.toFixed(1)}" height="${ah.toFixed(1)}" fill="none" stroke="#0f172a" stroke-width="1.5" stroke-dasharray="4 3"/></svg>`;
    }

    function _table(head, rows) {
        return `<table><thead><tr>${head.map(h => `<th>${_esc(h)}</th>`).join('')}</tr></thead><tbody>`
            + rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')
            + '</tbody></table>';
    }

    function _cellLink(row, report) {
        const base = report.map && report.map.link ? report.map.link.split('?')[0] : '';
        return base ? `<a href="${_esc(base)}?cell=${_esc(row.digipin)}">${_esc(row.digipin)}</a>` : `<code>${_esc(row.digipin)}</code>`;
    }

    function _sectionHTML(s, report) {
        let body = '';
        if (s.empty) {
            body = '<p class="muted">No data for this section in this area.</p>';
        } else if (s.type === 'summary') {
            body = _table(['Field', 'Mean', 'Min', 'Max', 'Cells'], s.rows.map(r => [
                `${_esc(r.label)}${r.higherIs ? ` <span class="muted">(${r.higherIs === 'worse' ? 'lower is better' : 'higher is better'})</span>` : ''}`,
                `<b>${_esc(_fmt(r.mean, r.unit))}</b>`, _esc(_fmt(r.min, r.unit)), _esc(_fmt(r.max, r.unit)), _esc(r.n)]));
        } else if (s.type === 'index') {
            body = `<p>${_esc(s.cells)} cells at level ${_esc(s.level)}, average <b>${_esc(s.mean)}</b>/100 (range ${_esc(s.min)}–${_esc(s.max)}). `
                + `Weights: ${s.terms.map(t => `${_esc(t.label)} ×${_esc(t.weight)}${t.higherIs === 'worse' ? ' (inverted)' : ''}`).join(', ')}.</p>`
                + _table(['Cell', 'Index', ...s.terms.map(t => t.label)], s.rows.map(r => [
                    _cellLink(r, report) + (r.partial ? ' <span class="muted">*</span>' : ''), `<b>${_esc(r.score)}</b>`,
                    ...s.terms.map(t => _esc(_fmt(r.parts[`${t.dataset}.${t.key}`], t.unit)))]))
                + (s.rows.some(r => r.partial) ? '<p class="muted">* Some inputs had no data for this cell; the index uses the rest.</p>' : '')
                + (s.bottom.length ? `<p class="muted">Lowest: ${s.bottom.map(r => `${_esc(r.digipin)} (${_esc(r.score)})`).join(', ')}.</p>` : '');
        } else if (s.type === 'rank') {
            body = _table(['Cell', s.field.label], s.rows.map(r => [_cellLink(r, report), `<b>${_esc(_fmt(r.value, s.field.unit))}</b>`]));
        } else if (s.type === 'filter') {
            const rule = s.where.map(w => `${_esc(w.label)} ${_esc(w.op)} ${_esc(Array.isArray(w.value) ? w.value.join('/') : w.value)}`).join(' and ');
            body = `<p><b>${_esc(s.matched)}</b> of ${_esc(s.cells)} cells (${_esc(s.share ?? 0)}%) meet ${rule}.</p>`
                + (s.rows.length ? _table(['Cell', ...s.fields.map(f => f.label)], s.rows.map(r => [_cellLink(r, report), ...s.fields.map(f => _esc(_fmt(r[f.key], f.unit)))])) : '');
        } else if (s.type === 'distribution') {
            const max = Math.max(1, ...s.buckets.map(b => b.count));
            body = `<div class="bars">${s.buckets.map(b => `<div class="bar"><span class="bl">${_esc(b.label)}</span>`
                + `<span class="bt"><span class="bf" style="width:${((b.count / max) * 100).toFixed(1)}%"></span></span><span class="bn">${_esc(b.count)}</span></div>`).join('')}</div>`;
        }
        const src = (s.sources || []).map(id => {
            const meta = report.sources.find(x => x.id === id);
            return `<a href="#src-${_esc(id)}">${_esc(meta ? meta.title : id)}</a>`;
        }).join(', ');
        return `<section id="${_esc(s.id)}"><h2>${_esc(s.title)}</h2>${body}${src ? `<p class="src">Source: ${src}</p>` : ''}</section>`;
    }

    /** A self-contained HTML document for the report (no scripts, no network). */
    function toHTML(report, opts = {}) {
        const when = new Date(report.ranAt);
        const date = isNaN(when) ? report.ranAt : when.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        const svg = cellMapSVG(report);
        const img = opts.image ? `<img src="${_esc(opts.image)}" alt="Map of the analysed area" class="snap">` : '';
        const layer = report.map && report.map.layer;
        const mapBlock = (img || svg) ? `<section class="map"><h2>Map</h2>${img || svg}`
            + (layer ? `<p class="muted">${img
                ? `3D DIGIPIN cells, height and colour by ${_esc(layer.field.label)}.`
                : `Each square is a DIGIPIN cell, coloured red (worst) to green (best) by ${_esc(layer.field.label)}. The dashed box is the area.`}</p>` : '')
            + '</section>' : '';
        const cards = report.sources.map(s => `<div class="card" id="src-${_esc(s.id)}"><h3>${_esc(s.title)}</h3>`
            + (s.description ? `<p>${_esc(s.description)}</p>` : '')
            + `<dl><dt>Dataset</dt><dd><code>${_esc(s.id)}</code></dd><dt>Cell size</dt><dd>DIGIPIN level ${_esc(s.level)}${s.approxCellM ? ` (~${_esc(s.approxCellM)} m)` : ''}</dd>`
            + `<dt>Cells in area</dt><dd>${_esc(s.cellsInArea)}</dd>`
            + (s.source ? `<dt>Built by</dt><dd><code>${_esc(s.source)}</code></dd>` : '')
            + (s.license ? `<dt>Licence</dt><dd>${_esc(s.license)}</dd>` : '')
            + (s.generated ? `<dt>Store built</dt><dd>${_esc(s.generated)}</dd>` : '')
            + '</dl></div>').join('');
        const link = report.map && report.map.link;
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
            + `<title>${_esc(report.analysis.title)} · ${_esc(report.area.label)}</title><style>${REPORT_CSS}</style></head><body><main>`
            + `<header><p class="kicker">DigiPin analysis report</p><h1>${_esc(report.analysis.title)}</h1>`
            + `<p class="meta">${_esc(report.area.label)} · run ${_esc(date)}${link ? ` · <a href="${_esc(link)}">Re-run in DigiPin</a>` : ''}</p>`
            + (report.analysis.description ? `<p>${_esc(report.analysis.description)}</p>` : '') + '</header>'
            + (report.highlights.length ? `<section class="hl"><h2>Key findings</h2><ul>${report.highlights.map(h => `<li>${_esc(h)}</li>`).join('')}</ul></section>` : '')
            + (report.warnings.length ? `<section class="warn"><ul>${report.warnings.map(w => `<li>${_esc(w)}</li>`).join('')}</ul></section>` : '')
            + mapBlock
            + report.sections.map(s => _sectionHTML(s, report)).join('')
            + `<section><h2>Sources</h2><div class="cards">${cards || '<p class="muted">No datasets had data for this area.</p>'}</div>`
            + `<p class="muted">Computed in the browser from the DigiPin per-cell data store (${_esc(report.schema)}, analysis v${_esc(report.analysis.version)}). Scores are model estimates from open data, not surveys.</p></section>`
            + '</main></body></html>';
    }

    const REPORT_CSS = [
        ':root{--ink:#1e293b;--sub:#64748b;--line:#e2e8f0;--soft:#f8fafc;--accent:#dd6b4a;--bg:#fff}',
        '@media (prefers-color-scheme:dark){:root{--ink:#e2e8f0;--sub:#94a3b8;--line:#334155;--soft:#1e293b;--bg:#0f172a}}',
        '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}',
        'main{max-width:820px;margin:0 auto;padding:28px 16px 40px}h1{font-size:24px;margin:2px 0 4px}h2{font-size:16px;margin:0 0 8px}h3{font-size:14px;margin:0 0 4px}',
        '.kicker{margin:0;color:var(--accent);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.meta{color:var(--sub);margin:0 0 8px}',
        'header{border-bottom:2px solid var(--ink);padding-bottom:12px;margin-bottom:18px}section{margin:0 0 22px}a{color:var(--accent)}',
        '.hl ul,.warn ul{margin:0;padding-left:18px}.hl{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px 14px}',
        '.warn{border-left:3px solid #f59e0b;padding:6px 12px;color:var(--sub);font-size:13px}',
        'table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}th{color:var(--sub);font-weight:600}td.num{font-variant-numeric:tabular-nums}',
        '.muted{color:var(--sub);font-size:12px}.src{color:var(--sub);font-size:12px;margin:6px 0 0}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}',
        '.bars{display:grid;gap:4px}.bar{display:grid;grid-template-columns:110px 1fr 40px;gap:8px;align-items:center;font-size:12px}.bt{background:var(--soft);border-radius:3px;height:12px;overflow:hidden}.bf{display:block;height:100%;background:var(--accent)}.bn{text-align:right;font-variant-numeric:tabular-nums}',
        '.map svg,.snap{max-width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:6px}',
        '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}.card{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--soft)}.card p{margin:0 0 6px;font-size:12px;color:var(--sub)}',
        'dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;font-size:12px}dt{color:var(--sub)}dd{margin:0}',
        '@media print{main{padding:0}section{break-inside:avoid}}',
    ].join('');

    // ── share links ─────────────────────────────────────────────────────────

    function _b64url(s) {
        const bytes = new TextEncoder().encode(s);
        let bin = '';
        bytes.forEach(b => { bin += String.fromCharCode(b); });
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function _unb64url(s) {
        const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
        return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    }

    /**
     * Query string that re-runs an analysis on open. Built-ins go by id; a
     * custom template travels inline (base64url JSON) so the link works for
     * someone who never saved it.
     */
    function shareQuery(tpl, area) {
        const p = new URLSearchParams();
        if (tpl.builtin && builtin(tpl.id)) p.set('analysis', tpl.id);
        else {
            const { builtin: _b, ...clean } = tpl;
            p.set('analysis_def', _b64url(JSON.stringify(clean)));
        }
        p.set('area', areaParam(area));
        return p.toString();
    }

    /** { template, area } from a query string, or null. */
    function parseShare(search) {
        const p = new URLSearchParams(search || '');
        const area = p.get('area') ? parseArea(p.get('area')) : null;
        let template = null;
        if (p.get('analysis')) template = builtin(p.get('analysis'));
        else if (p.get('analysis_def')) {
            try {
                const v = validate(JSON.parse(_unb64url(p.get('analysis_def'))), null);
                template = v.ok ? v.template : null;
            } catch { template = null; }
        }
        return template && area ? { template, area } : null;
    }

    return {
        TEMPLATE_SCHEMA, REPORT_SCHEMA, SECTION_TYPES, OPS, BUILTINS,
        validate, builtin, slug, parseArea, areaParam, cellsInArea,
        stats, normalise, rollUp, run, highlights,
        cellMapSVG, toHTML, shareQuery, parseShare,
    };
})();

if (typeof window !== 'undefined') {
    window.Analysis = Analysis;
}
