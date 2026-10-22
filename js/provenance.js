/**
 * Provenance — a "source card" for every map layer and every Text2Map answer.
 *
 * Aino attaches a card to each layer (source, fetch time, coverage, method,
 * licence) and badges anything the AI derived. This is DigiPin's own version:
 * one registry keyed by the Layers-panel row key, plus the cell-store catalog
 * (data/cells/catalog.json already carries `source` + `license` per dataset),
 * rendered as a small expandable card under the row. Text2Map rankings get the
 * same treatment: which parser read the question, which scores were weighted,
 * and whether they came from the precomputed grid or live sampling.
 *
 * forKey()/card()/forRanking() are pure (unit-tested); decorateRow()/
 * renderCard() touch the DOM.
 */
const Provenance = (() => {
    const LIVE = 'Sampled live per viewport from DigiPin’s cell scores (public APIs)';
    const OSM = 'ODbL (© OpenStreetMap contributors)';
    const OVERTURE = 'Overture Maps Foundation, release 2024-08-20';

    // Row key → card fields. Keys match js/app.js (QUICK_OVERLAYS, heatmap
    // '_heat_*', LayersPanel '_btn_<btnId>') and DigitalTwinLayers LAYER_DEFS.
    const REGISTRY = {
        _wards: { source: 'OpenStreetMap admin boundaries via Overpass API', method: 'Fetched live for the current view', license: OSM },
        _lcz: { source: 'LCZ Generator (RUB / WUDAPT)', method: 'Local Climate Zone raster', license: 'See lcz-generator.rub.de' },
        _lulc: { source: 'ISRO / NRSC Bhuvan WMS (lulc50k_1112)', method: 'Land use / land cover raster, 1:50k, 2011-12', license: '© ISRO/NRSC Bhuvan' },

        '_btn_btn-choropleth': { source: 'DigiPin precomputed score grid', method: 'Static grid built by pipeline/scores, no live calls', license: OSM },
        '_btn_btn-growth': { source: 'DigiPin growth forecast (RealtimeGrowth)', method: LIVE },
        '_btn_btn-ca-growth': { source: 'CA-ML urban growth prediction (data/growth/ca_urban_prediction.tif)', method: 'Model projection to ~2035, hindcast-validated (docs/CA_GROWTH_MODEL.md)', ai: true },
        '_btn_btn-scenario': { source: 'CA-ML growth prediction + ScenarioModel lens', method: 'Illustrative what-if adjustment, not a re-trained run', ai: true },
        '_btn_btn-traffic': { source: 'OpenStreetMap road network (pipeline/traffic/road_network.py)', method: 'Structural Level-of-Service from betweenness centrality', license: OSM },
        '_btn_btn-mobility': { source: 'OpenStreetMap (pipeline/safety/mobility.py)', method: 'Chokepoints and sole-connector links', license: OSM },
        '_btn_btn-emergency': { source: 'OpenStreetMap mobility + traffic grids (pipeline/safety, pipeline/traffic)', method: 'Emergency Accessibility Index from police reach, chokepoints and road level-of-service', license: OSM },
        '_btn_btn-heat': { source: 'MODIS land surface temperature 2016-2024 (data/heat/)', method: 'Urban Heat Index per cell' },
        '_btn_btn-ndvi': { source: 'NASA GIBS MODIS/Terra NDVI 8-day, 250 m', method: 'Keyless WMTS tiles', license: 'NASA open data' },
        '_btn_btn-bivariate': { source: 'DigiPin cell scores', method: LIVE + ', two scores binned 3×3' },
        '_btn_btn-kde': { source: 'DigiPin cell scores', method: LIVE + ', Gaussian kernel density' },
        '_btn_btn-sentinel': { source: 'Copernicus Sentinel-2 L2A (ESA) via Microsoft Planetary Computer STAC + tiler', method: 'Newest scene under 20% cloud in the last 120 days covering the selected cell; true colour, NIR false colour or NDVI' },
        '_btn_btn-pointcloud': { source: 'Your own LAS / LAZ / COPC / EPT point cloud (no open Indian LiDAR yet)', method: 'opengeos/maplibre-gl-lidar 0.21 (MIT): deck.gl point cloud, CRS reprojected to WGS84, COPC streamed by viewport' },
        '_btn_btn-livenow': { source: 'Open-Meteo forecast, CAMS air quality and GloFAS v4 river discharge; USGS earthquakes (M2.5+, 7 days); NASA EONET open events; NDMA SACHET when fresh; DigiPin population, water and surface_heat cells', method: 'Live feeds checked against the cells in view: IMD rain classes × 100-year flood cells, max temperature × heat-island cells (+2 °C), CPCB National AQI from PM2.5/PM10 × people, river peak vs 30-day mean, events within 300 km', license: 'CC BY 4.0 (Open-Meteo); public domain (USGS, NASA)' },
        '_btn_btn-livesky': { source: 'adsb.lol community ADS-B feed via the DigiPin data proxy', method: 'Aircraft within 75 km of the view centre, polled every 10 s and dead-reckoned along track; drawn as fill-extrusions at reported geometric altitude', license: 'ODbL 1.0' },
        '_btn_btn-swipe': { source: 'Whatever layers are on (each keeps its own source line)', method: 'Second map from a style snapshot, same camera, clipped beside a draggable divider' },
        '_btn_btn-hydrology': { source: 'AWS Terrarium DEM tiles (SRTM, z13 ~18 m/px)', method: 'Whitebox depth_in_sink, breach + D8 flow accumulation, slope and TWI via geolibre-wasm, binned to DIGIPIN L8' },
        '_btn_btn-viewshed': { source: 'AWS Terrarium DEM tiles (elevation-tiles-prod)', method: 'Line-of-sight sweep from the map centre, z14 (~9 m/px)' },
        '_btn_btn-terrain': { source: 'AWS Terrarium DEM tiles (elevation-tiles-prod)', method: 'MapLibre raster-dem terrain and hillshade' },
        '_btn_btn-access': { source: 'OpenStreetMap amenities', method: 'Walking time to the nearest amenity per cell', license: OSM },
        '_btn_btn-area': { source: 'DigiPin cell scores', method: 'Average / min / max over the cells in a drawn rectangle' },
        '_btn_btn-roads': { source: OVERTURE + ' (transportation)', method: 'Vector tiles (PMTiles), coloured by road class', license: 'ODbL' },
        '_btn_btn-buildings': { source: OVERTURE + ' (buildings)', method: 'Footprints streamed as PMTiles, extruded in 3D', license: 'ODbL' },
        '_btn_btn-3d': { source: 'No data of its own', method: 'Tilts the camera and turns on 3D buildings' },
        '_btn_btn-measure': { source: 'No external data', method: 'Distance and area measured on the map' },
        '_btn_btn-annotate': { source: 'Your own notes', method: 'Stored in this browser and in share links' },
        '_btn_btn-sun': { source: 'Computed solar position (no external data)', method: 'Sun azimuth and altitude for the selected place and time' },

        overture_roads: { source: OVERTURE + ' (transportation)', method: 'Vector tiles (PMTiles)', license: 'ODbL' },
        overture_water: { source: OVERTURE + ' (base / water)', method: 'Vector tiles (PMTiles)', license: 'ODbL' },
        overture_landuse: { source: OVERTURE + ' (base / land_use)', method: 'Vector tiles (PMTiles)', license: 'ODbL' },
        overture_places: { source: OVERTURE + ' (places)', method: 'Vector tiles (PMTiles)', license: 'CDLA Permissive 2.0' },
        overture_divisions: { source: OVERTURE + ' (divisions)', method: 'Vector tiles (PMTiles)', license: 'ODbL' },
        bhuvan_drainage: { source: 'ISRO / NRSC Bhuvan WMS', method: 'Raster WMS tiles', license: '© ISRO/NRSC Bhuvan' },
        bhuvan_water: { source: 'ISRO / NRSC Bhuvan WMS', method: 'Raster WMS tiles', license: '© ISRO/NRSC Bhuvan' },
        google_buildings: { source: 'Google Open Buildings', method: 'Footprints extruded by estimated height', license: 'CC BY 4.0 / ODbL' },
        google_buildings_flat: { source: 'Google Open Buildings', method: 'Footprints (PMTiles)', license: 'CC BY 4.0 / ODbL' },
        city_boundary: { source: 'Indore municipal boundary (Google Earth KML)' },
        osm_admin: { source: 'OpenStreetMap extract (data/vectors)', license: OSM },
        osm_green_spaces: { source: 'OpenStreetMap extract (data/vectors)', license: OSM },
        osm_pois: { source: 'OpenStreetMap extract (data/vectors)', license: OSM },
        osm_shops: { source: 'OpenStreetMap extract (data/vectors)', license: OSM },
        osm_railways: { source: 'OpenStreetMap extract (data/vectors)', license: OSM },
        osm_utilities: { source: 'OpenStreetMap extract (data/vectors)', license: OSM },
        osm_roads: { source: 'OpenStreetMap extract (data/vectors)', license: OSM },
        osm_water: { source: 'OpenStreetMap extract (data/vectors)', license: OSM },
        sensor_weather: { source: 'Open-Meteo forecast API', method: 'Live reading at the view centre', license: 'CC BY 4.0' },
        sensor_aqi: { source: 'Open-Meteo air quality API', method: 'Live reading at the view centre', license: 'CC BY 4.0' },
        sensor_solar: { source: 'Open-Meteo forecast API (radiation)', method: 'Live reading at the view centre', license: 'CC BY 4.0' },
    };

    /** Human labels for the parser that read a Text2Map question. */
    const PARSERS = {
        llm: { label: 'Language model', ai: true },
        embeddings: { label: 'On-device embeddings', ai: true },
        lexicon: { label: 'Offline keyword lexicon', ai: false },
        keyword: { label: 'Canned query match', ai: false },
    };

    function _cellStoreSpec(id) {
        if (typeof CellStore === 'undefined' || !CellStore.get) return null;
        return CellStore.get(id);
    }

    function _catalogGenerated() {
        if (typeof CellStore === 'undefined' || !CellStore.generated) return null;
        return CellStore.generated();
    }

    /** Card fields for a cell-store dataset spec (catalog.json shape). */
    function fromSpec(spec, generated, isLocal) {
        if (!spec) return null;
        const regions = (spec.regions || []).map(r => r.name).filter(Boolean);
        const level = Number.isFinite(spec.level) ? `DIGIPIN level ${spec.level}` : null;
        const size = Number.isFinite(spec.approxCellM) ? `~${spec.approxCellM} m cells` : null;
        return {
            source: spec.source || null,
            method: [level, size].filter(Boolean).join(', ') || null,
            coverage: isLocal ? 'Your uploaded file' : (regions.length ? regions.join(', ') : null),
            license: spec.license || null,
            asOf: isLocal ? null : (generated || null),
        };
    }

    /**
     * Provenance for a Layers-panel row key, or null when unknown. Cell-store
     * rows ('_cell_<id>') read the live catalog; heatmap rows share one entry.
     */
    function forKey(key, specLookup, generated) {
        if (typeof key !== 'string' || !key) return null;
        if (key.startsWith('_cell_')) {
            const id = key.slice('_cell_'.length);
            const spec = (specLookup || _cellStoreSpec)(id);
            const local = typeof CellStore !== 'undefined' && CellStore.isLocal ? CellStore.isLocal(id) : false;
            return fromSpec(spec, generated !== undefined ? generated : _catalogGenerated(), local);
        }
        if (key.startsWith('_heat_')) {
            return { source: 'DigiPin cell scores', method: LIVE };
        }
        return REGISTRY[key] || null;
    }

    /** Card fields → ordered [{label, value}] rows, empties dropped. */
    function card(meta) {
        if (!meta) return [];
        const rows = [
            ['Source', meta.source],
            ['Method', meta.method],
            ['Coverage', meta.coverage],
            ['As of', meta.asOf],
            ['Licence', meta.license],
        ];
        return rows.filter(([, v]) => v != null && String(v).trim() !== '')
            .map(([label, value]) => ({ label, value: String(value) }));
    }

    /**
     * Source card for a Text2Map ranking. `parsed` is Text2Map's
     * {weights, source, ...}; `mode` is 'precomputed' | 'live'.
     */
    function forRanking(parsed, mode, opts = {}) {
        if (!parsed) return null;
        const parser = PARSERS[parsed.source] || { label: parsed.source || 'Unknown', ai: false };
        const n = Object.keys(parsed.weights || {}).length;
        const spec = opts.scoresSpec !== undefined ? opts.scoresSpec : _cellStoreSpec('scores');
        const generated = opts.generated !== undefined ? opts.generated : _catalogGenerated();
        const grid = fromSpec(spec, generated) || {};
        const provider = parser.ai && parsed.source === 'llm' && opts.provider ? ` (${opts.provider})` : '';
        const precomputed = mode === 'precomputed';
        return {
            ai: parser.ai,
            source: precomputed
                ? `Precomputed DIGIPIN score grid${grid.source ? ' (' + grid.source + ')' : ''}`
                : 'Live public-API sampling of the current view',
            method: `Question read by ${parser.label}${provider}; weighted sum of ${n} score${n === 1 ? '' : 's'}`,
            coverage: precomputed ? (grid.coverage || null) : 'Current map view',
            asOf: precomputed ? (grid.asOf || null) : 'Now',
            license: precomputed ? (grid.license || null) : null,
        };
    }

    /** Build the card element (a <dl>), with an "AI-derived" badge when set. */
    function renderCard(meta) {
        if (typeof document === 'undefined') return null;
        const wrap = document.createElement('div');
        wrap.className = 'source-card';
        if (meta && meta.ai) {
            const badge = document.createElement('span');
            badge.className = 'source-card-badge';
            badge.textContent = 'AI-derived';
            badge.title = 'A model produced or interpreted this. Check the method before relying on it.';
            wrap.appendChild(badge);
        }
        const rows = card(meta);
        const dl = document.createElement('dl');
        if (!rows.length) {
            const none = document.createElement('div');
            none.className = 'source-card-empty';
            none.textContent = 'No source recorded for this layer yet.';
            wrap.appendChild(none);
        }
        rows.forEach(({ label, value }) => {
            const dt = document.createElement('dt');
            dt.textContent = label;
            const dd = document.createElement('dd');
            dd.textContent = value;
            dl.appendChild(dt);
            dl.appendChild(dd);
        });
        if (rows.length) wrap.appendChild(dl);
        return wrap;
    }

    /**
     * Add an ⓘ button to a Layers-panel row that toggles its source card just
     * below the row. Idempotent; the click never toggles the layer itself.
     */
    function decorateRow(item) {
        if (!item || typeof document === 'undefined') return;
        if (item.querySelector('.dt-source-btn')) return;
        const key = item.dataset.layerKey;
        if (!key || key === '_cell_ingest') return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dt-source-btn';
        btn.textContent = 'ⓘ';
        btn.title = 'Where this layer’s data comes from';
        btn.setAttribute('aria-label', 'Source for ' + (item.getAttribute('aria-label') || 'this layer'));
        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const next = item.nextElementSibling;
            if (next && next.classList.contains('source-card')) {
                next.remove();
                btn.setAttribute('aria-expanded', 'false');
                return;
            }
            const el = renderCard(forKey(key));
            el.addEventListener('click', (ev) => ev.stopPropagation());
            item.insertAdjacentElement('afterend', el);
            btn.setAttribute('aria-expanded', 'true');
        });
        btn.addEventListener('keydown', (e) => e.stopPropagation());
        const toggle = item.querySelector('.dt-toggle-switch');
        if (toggle) item.insertBefore(btn, toggle);
        else item.appendChild(btn);
    }

    return { forKey, fromSpec, card, forRanking, renderCard, decorateRow, REGISTRY, PARSERS };
})();

if (typeof window !== 'undefined') {
    window.Provenance = Provenance;
}
