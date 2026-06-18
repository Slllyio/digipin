/**
 * DTDLExport — export a DIGIPIN cell as a Digital Twins graph.
 *
 * Turns a fetched cell-data object into a DTDL (Digital Twins Definition
 * Language) model set + twin graph, RealEstateCore-aligned (the same shape as
 * Azure/opendigitaltwins-building: Space → Building, Asset, Capability with
 * hasPart / hasCapability / hasAsset / locatedIn relationships).
 *
 * The output is a single JSON file in the Azure Digital Twins Explorer import
 * format ({ digitalTwinsModels, digitalTwinsGraph:{ digitalTwins, relationships }})
 * so it loads straight into ADT Explorer or a bulk-import job. The DTDL models
 * are self-contained under a `dtmi:digipin:*;1` namespace (they don't require
 * uploading the full RealEstateCore ontology first), but mirror its vocabulary.
 *
 * Mapping:
 *   - the cell            → one Space twin (digipin code, centroid, area)
 *   - building morphology → one Building twin (avg levels, FSI, LCZ, …) hasPart Space
 *   - each score          → a Capability twin (Parameter, 0–100) hasCapability Space
 *   - live sources        → Capability twins (Sensor/Forecast: AQI, weather, flood)
 *   - each amenity type   → an Asset twin (category + count) locatedIn Space
 *
 * build()/summarize() are pure (unit-tested); download() is the DOM side.
 */
const DTDLExport = (() => {
    const NS = 'dtmi:digipin';
    const CTX = 'dtmi:dtdl:context;2';
    const M = {
        space: `${NS}:Space;1`,
        building: `${NS}:Building;1`,
        level: `${NS}:Level;1`,
        asset: `${NS}:Asset;1`,
        capability: `${NS}:Capability;1`,
    };

    /** Azure Digital Twins Explorer (graph import target). */
    const ADT_EXPLORER_URL = 'https://explorer.digitaltwins.azure.net/';

    // Keep the graph bounded so a dense cell can't emit thousands of twins.
    const MAX_BUILDINGS = 60;
    const MAX_LEVELS = 200;

    /** The DTDL interface definitions (RealEstateCore-aligned, self-contained). */
    function models() {
        return [
            {
                '@context': CTX, '@id': M.space, '@type': 'Interface', displayName: 'Space',
                contents: [
                    { '@type': 'Property', name: 'digipinCode', schema: 'string' },
                    { '@type': 'Property', name: 'name', schema: 'string' },
                    { '@type': 'Property', name: 'latitude', schema: 'double' },
                    { '@type': 'Property', name: 'longitude', schema: 'double' },
                    { '@type': 'Property', name: 'areaSqm', schema: 'double' },
                    { '@type': 'Relationship', name: 'hasPart', target: M.space },
                    { '@type': 'Relationship', name: 'hasCapability', target: M.capability },
                    { '@type': 'Relationship', name: 'hasAsset', target: M.asset },
                ],
            },
            {
                '@context': CTX, '@id': M.building, '@type': 'Interface', displayName: 'Building',
                extends: M.space,
                contents: [
                    { '@type': 'Property', name: 'buildingCount', schema: 'integer' },
                    { '@type': 'Property', name: 'avgLevels', schema: 'double' },
                    { '@type': 'Property', name: 'floorSpaceIndex', schema: 'double' },
                    { '@type': 'Property', name: 'groundCoverageRatio', schema: 'double' },
                    { '@type': 'Property', name: 'urbanForm', schema: 'string' },
                    { '@type': 'Property', name: 'localClimateZone', schema: 'string' },
                    // per-footprint properties (used when real building records exist)
                    { '@type': 'Property', name: 'buildingType', schema: 'string' },
                    { '@type': 'Property', name: 'levels', schema: 'integer' },
                    { '@type': 'Property', name: 'heightM', schema: 'double' },
                ],
            },
            {
                '@context': CTX, '@id': M.level, '@type': 'Interface', displayName: 'Level',
                extends: M.space,
                contents: [
                    { '@type': 'Property', name: 'levelNumber', schema: 'integer' },
                ],
            },
            {
                '@context': CTX, '@id': M.asset, '@type': 'Interface', displayName: 'Asset',
                contents: [
                    { '@type': 'Property', name: 'category', schema: 'string' },
                    { '@type': 'Property', name: 'count', schema: 'integer' },
                    { '@type': 'Relationship', name: 'locatedIn', target: M.space },
                ],
            },
            {
                '@context': CTX, '@id': M.capability, '@type': 'Interface', displayName: 'Capability',
                contents: [
                    { '@type': 'Property', name: 'kind', schema: 'string' },   // Parameter | Sensor | Forecast
                    { '@type': 'Property', name: 'label', schema: 'string' },
                    { '@type': 'Property', name: 'value', schema: 'double' },
                    { '@type': 'Property', name: 'unit', schema: 'string' },
                    { '@type': 'Relationship', name: 'isCapabilityOf', target: M.space },
                ],
            },
        ];
    }

    /** Sanitise a DIGIPIN code into a valid $dtId stem. */
    function _stem(code) {
        return 'digipin_' + String(code || 'cell').replace(/[^a-zA-Z0-9]/g, '');
    }

    function _twin(id, model, props) {
        return Object.assign({ $dtId: id, $metadata: { $model: model } }, props);
    }

    function _rel(sourceId, name, targetId) {
        return {
            $relationshipId: `${sourceId}__${name}__${targetId}`,
            $sourceId: sourceId,
            $relationshipName: name,
            $targetId: targetId,
        };
    }

    /**
     * Build the full Digital Twins graph for a cell. Pure: no DOM, no network.
     * Returns { digitalTwinsModels, digitalTwinsGraph:{ digitalTwins, relationships } }.
     */
    function build(cell, data) {
        cell = cell || {};
        data = data || {};
        const center = cell.center || {};
        const root = _stem(cell.code);
        const twins = [];
        const rels = [];

        // 1) the cell as a Space
        twins.push(_twin(root, M.space, {
            digipinCode: cell.code || null,
            name: `DIGIPIN ${cell.code || ''}`.trim(),
            latitude: Number.isFinite(center.lat) ? center.lat : null,
            longitude: Number.isFinite(center.lng) ? center.lng : null,
            areaSqm: Number.isFinite(cell.areaSqm) ? cell.areaSqm : null,
        }));

        // 2) buildings → Building twins (one per real footprint when available,
        //    each with its Level twins), else one aggregate Building twin.
        const bi = data.buildingIntel || {};
        const metrics = bi.metrics || {};
        const buildings = bi.buildings || {};
        const items = Array.isArray(buildings.items) ? buildings.items : [];
        if (items.length) {
            let levelBudget = MAX_LEVELS;
            items.slice(0, MAX_BUILDINGS).forEach((b, i) => {
                if (!b || typeof b !== 'object') return;
                const levelCount = Math.max(0, _int(b.levels) || 0);   // one source of truth
                const bId = `${root}_bldg_${i}`;
                twins.push(_twin(bId, M.building, {
                    name: b.type ? `${b.type} building` : `Building ${i + 1}`,
                    buildingType: b.type || null,
                    levels: levelCount,
                    heightM: _num(b.heightM),
                    latitude: _num(b.lat),
                    longitude: _num(b.lng),
                }));
                rels.push(_rel(root, 'hasPart', bId));
                // a Level twin per floor (isPartOf the Building), within a global budget
                for (let lvl = 1; lvl <= levelCount && levelBudget > 0; lvl++, levelBudget--) {
                    const lId = `${bId}_level_${lvl}`;
                    twins.push(_twin(lId, M.level, { name: `Level ${lvl}`, levelNumber: lvl }));
                    rels.push(_rel(bId, 'hasPart', lId));
                }
            });
        } else if (Object.keys(metrics).length || Object.keys(buildings).length) {
            const bId = `${root}_buildings`;
            twins.push(_twin(bId, M.building, {
                buildingCount: _int(buildings.count != null ? buildings.count : buildings.totalCount),
                avgLevels: _num(buildings.avgLevels),
                floorSpaceIndex: _num(metrics.fsi),
                groundCoverageRatio: _num(metrics.gcr),
                urbanForm: metrics.urbanForm || null,
                localClimateZone: (bi.lcz && bi.lcz.name) || null,
            }));
            rels.push(_rel(root, 'hasPart', bId));
        }

        // 3) every score → a Capability (Parameter, 0–100)
        const scores = data.scores || {};
        for (const key of Object.keys(scores)) {
            const s = scores[key];
            if (!s || typeof s.value !== 'number') continue;
            const cId = `${root}_cap_${_slug(key)}`;
            twins.push(_twin(cId, M.capability, {
                kind: 'Parameter',
                label: s.label || key,
                value: s.value,
                unit: 'score',
            }));
            rels.push(_rel(root, 'hasCapability', cId));
        }

        // 4) live sources → Sensor / Forecast capabilities
        for (const cap of _liveCapabilities(data.realtime || {})) {
            const cId = `${root}_cap_${_slug(cap.key)}`;
            twins.push(_twin(cId, M.capability, {
                kind: cap.kind, label: cap.label, value: cap.value, unit: cap.unit,
            }));
            rels.push(_rel(root, 'hasCapability', cId));
        }

        // 5) every present amenity type → an Asset (locatedIn the cell)
        const cats = data.categories || {};
        for (const catKey of Object.keys(cats)) {
            const feats = (cats[catKey] && cats[catKey].features) || {};
            for (const fKey of Object.keys(feats)) {
                const f = feats[fKey];
                if (!f || !(f.count > 0)) continue;
                const aId = `${root}_asset_${_slug(catKey)}_${_slug(fKey)}`;
                twins.push(_twin(aId, M.asset, {
                    category: f.name || fKey,
                    count: f.count,
                }));
                rels.push(_rel(root, 'hasAsset', aId));
                rels.push(_rel(aId, 'locatedIn', root));
            }
        }

        return {
            digitalTwinsFileInfo: { fileVersion: '1.0.0', author: 'DigiPin Urban Intelligence' },
            digitalTwinsModels: models(),
            digitalTwinsGraph: { digitalTwins: twins, relationships: rels },
        };
    }

    /** Pull sensor/forecast capabilities from the realtime block (best-effort). */
    function _liveCapabilities(rt) {
        const out = [];
        if (rt.aqi && Number.isFinite(rt.aqi.aqi)) {
            out.push({ key: 'air_quality', kind: 'Sensor', label: 'Air Quality Index', value: rt.aqi.aqi, unit: 'AQI' });
        }
        if (rt.weather && Number.isFinite(rt.weather.temp)) {
            out.push({ key: 'temperature', kind: 'Sensor', label: 'Temperature', value: rt.weather.temp, unit: '°C' });
        }
        if (rt.flood && Number.isFinite(rt.flood.peak_ratio)) {
            out.push({ key: 'flood_forecast', kind: 'Forecast', label: 'Flood peak ratio (GloFAS)', value: +rt.flood.peak_ratio.toFixed(2), unit: '×baseline' });
        }
        return out;
    }

    function _num(v) { return Number.isFinite(v) ? v : null; }
    function _int(v) { return Number.isFinite(v) ? Math.round(v) : null; }
    function _slug(s) { return String(s).replace(/[^a-zA-Z0-9]/g, '_'); }

    /** Counts for the export-dialog summary. Pure. */
    function summarize(cell, data) {
        const g = build(cell, data);
        const tw = g.digitalTwinsGraph.digitalTwins;
        const byModel = (m) => tw.filter(t => t.$metadata.$model === m).length;
        return {
            models: g.digitalTwinsModels.length,
            twins: tw.length,
            buildings: byModel(M.building),
            levels: byModel(M.level),
            capabilities: byModel(M.capability),
            assets: byModel(M.asset),
            relationships: g.digitalTwinsGraph.relationships.length,
        };
    }

    function toJSON(cell, data) { return JSON.stringify(build(cell, data), null, 2); }

    /** Trigger a browser download of the twin graph JSON. */
    function download(cell, data, name) {
        if (typeof document === 'undefined') return;
        const blob = new Blob([toJSON(cell, data)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name || `digipin_${_stem(cell && cell.code).replace('digipin_', '')}_twin.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return { build, summarize, toJSON, download, models, MODELS: M, ADT_EXPLORER_URL };
})();

if (typeof window !== 'undefined') window.DTDLExport = DTDLExport;
