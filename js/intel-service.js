/**
 * IntelService — the browser client for the Intelligence-as-a-Service artifact
 * (data/intel/<region>/intel.json, produced by pipeline/build_intel_export.mjs).
 *
 * It exposes the same precomputed per-cell intelligence (indices + utilities +
 * priorities) that an external ULB system would fetch — proving the IaaS contract
 * from inside the app. A point or DigiPin code resolves to its full record in one
 * static fetch; no live computation.
 *
 *   await IntelService.cell(22.72, 75.86)   -> { code, center, indices, utilities, priorities }
 *   await IntelService.regions()            -> manifest entries
 *
 * Pure helpers (_inBbox, _regionFor, _expand) are unit-tested; fetches degrade to
 * null when the artifact is absent (DIGIPIN_CONFIG.intelBase overrides the base).
 */
const IntelService = (() => {
    let _manifest = null;
    const _regionData = new Map();   // region -> Promise<data|null>

    function _base() {
        const cfg = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG) || {};
        return cfg.intelBase || 'data/intel/';
    }

    async function _fetch(url) {
        try {
            const r = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
            return r.ok ? await r.json() : null;
        } catch { return null; }
    }

    async function manifest() {
        if (_manifest) return _manifest;
        const m = await _fetch(`${_base()}manifest.json`);
        _manifest = (m && Array.isArray(m.regions)) ? m : { regions: [] };
        return _manifest;
    }
    async function regions() { return (await manifest()).regions; }

    function _inBbox(b, lat, lng) {
        return b && lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
    }
    /** Manifest entry covering a point, or null. Pure. */
    function _regionFor(man, lat, lng) {
        return (man && man.regions || []).find(r => _inBbox(r.bbox, lat, lng)) || null;
    }

    async function _data(region) {
        if (!_regionData.has(region.name)) {
            _regionData.set(region.name, _fetch(`${_base()}${region.name}/intel.json`));
        }
        return _regionData.get(region.name);
    }

    /** Expand a compact cell record using the file's field catalogue. Pure. */
    function _expand(raw, fileFields, code) {
        if (!raw) return null;
        const labels = (typeof IntelIndices !== 'undefined') ? IntelIndices.DEFS : {};
        const indices = {};
        for (const [id, v] of Object.entries(raw.ix || {})) indices[id] = { value: v, label: labels[id] ? labels[id].label : id };
        return {
            code: (typeof DigiPin !== 'undefined' && DigiPin.format) ? DigiPin.format(code) : code,
            center: raw.c ? { lng: raw.c[0], lat: raw.c[1] } : null,
            indices,
            utilities: raw.ut ? {
                electricityKwhPerDay: raw.ut.e, waterKlPerDay: raw.ut.w, wasteKgPerDay: raw.ut.g,
                solarKwhPerDay: raw.ut.s, supplyStress: raw.ut.st,
            } : null,
            priorities: raw.pr || {},
        };
    }

    /** Full IaaS record for a point, or null if outside coverage / artifact missing. */
    async function cell(lat, lng) {
        const man = await manifest();
        const region = _regionFor(man, lat, lng);
        if (!region) return null;
        const data = await _data(region);
        if (!data) return null;
        const code = DigiPin.encode(lat, lng).replace(/-/g, '').slice(0, data.level);
        return _expand(data.cells[code], data.fields, code);
    }

    /** Record for a DigiPin code (decodes to a point, then resolves). */
    async function cellByCode(code) {
        if (typeof DigiPin === 'undefined' || !DigiPin.decodePartial) return null;
        const d = DigiPin.decodePartial(String(code).replace(/-/g, ''));
        return cell(d.lat, d.lng);
    }

    return { manifest, regions, cell, cellByCode, _inBbox, _regionFor, _expand };
})();

if (typeof window !== 'undefined') window.IntelService = IntelService;
