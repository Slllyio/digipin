/**
 * Digital Twin Data Layers — Infrastructure overlays on MapLibre GL JS
 *
 * Layer sources:
 *   - Overture Maps PMTiles (roads, water, boundaries, places)
 *   - Bhuvan WMS raster tiles (drainage, water bodies, admin)
 *   - GeoJSON (city boundary, sensors, Google Open Buildings)
 *   - GeoTIFF raster (ESA WorldCover — disabled pending XYZ tile conversion)
 */

const DigitalTwinLayers = (() => {
    const DATA_BASE = './data';
    const OVERTURE_BASE = 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2024-08-20';
    const BHUVAN_WMS = 'https://bhuvan-vec2.nrsc.gov.in/bhuvan/wms';

    const _layers = {};       // key -> { visible, loading, sourceId, layerIds[] }
    const _cache = new Map(); // key -> geojson data
    let _map = null;
    let _hoverPopup = null;
    let _clickPopup = null;

    // Theme-aware paint: a layer def may carry a `paintLight` variant tuned for
    // the Aino-style paper theme (pale shaded buildings, soft sage greens). When
    // the light theme is active and a variant exists, use it; else the default.
    function _paintFor(def) {
        const light = typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light';
        return (light && def.paintLight) ? def.paintLight : def.paint;
    }

    // ─── Layer Definitions ─────────────────────────────────────────
    const LAYER_DEFS = {
        // ── Overture Maps PMTiles (vector tiles, no download needed) ──
        overture_roads: {
            name: 'Roads (Overture)',
            icon: '\u{1F6E3}',
            group: 'Infrastructure',
            isPMTiles: true,
            pmtilesUrl: `${OVERTURE_BASE}/transportation.pmtiles`,
            sourceLayer: 'segment',
            type: 'line',
            paint: {
                'line-color': [
                    'match', ['get', 'class'],
                    'motorway',     '#f97316',
                    'primary',      '#eab308',
                    'secondary',    '#a3e635',
                    'tertiary',     '#67e8f9',
                    'residential',  '#94a3b8',
                    'service',      '#64748b',
                    'track',        '#78716c',
                    'footway',      '#a78bfa',
                    'cycleway',     '#34d399',
                    '#6b7280'
                ],
                'line-width': [
                    'match', ['get', 'class'],
                    'motorway', 3,
                    'primary', 2.5,
                    'secondary', 2,
                    'tertiary', 1.5,
                    'residential', 1,
                    0.8
                ],
                'line-opacity': 0.85
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                const parts = [];
                if (p.class) parts.push(p.class);
                if (p.subclass) parts.push(p.subclass);
                if (p.names) {
                    try {
                        const n = typeof p.names === 'string' ? JSON.parse(p.names) : p.names;
                        if (n.primary) parts.unshift(n.primary);
                    } catch { /* ignore */ }
                }
                return parts.join(' | ') || 'Road segment';
            }
        },
        overture_water: {
            name: 'Water Bodies (Overture)',
            icon: '\u{1F30A}',
            group: 'Infrastructure',
            isPMTiles: true,
            pmtilesUrl: `${OVERTURE_BASE}/base.pmtiles`,
            sourceLayer: 'water',
            type: 'fill',
            paint: {
                'fill-color': '#0ea5e9',
                'fill-opacity': 0.5,
                'fill-outline-color': '#0284c7'
            },
            minZoom: 8,
            tooltip: f => {
                const p = f.properties || {};
                const parts = [];
                if (p.class) parts.push(p.class);
                if (p.subclass) parts.push(p.subclass);
                if (p.names) {
                    try {
                        const n = typeof p.names === 'string' ? JSON.parse(p.names) : p.names;
                        if (n.primary) parts.unshift(n.primary);
                    } catch { /* ignore */ }
                }
                return parts.join(' | ') || 'Water body';
            }
        },
        overture_landuse: {
            name: 'Land Use (Overture)',
            icon: '\u{1F333}',
            group: 'Infrastructure',
            isPMTiles: true,
            pmtilesUrl: `${OVERTURE_BASE}/base.pmtiles`,
            sourceLayer: 'land_use',
            type: 'fill',
            paint: {
                'fill-color': [
                    'match', ['get', 'class'],
                    'residential',   '#818cf8',
                    'commercial',    '#f59e0b',
                    'industrial',    '#6b7280',
                    'park',          '#22c55e',
                    'forest',        '#15803d',
                    'farmland',      '#a3e635',
                    'cemetery',      '#78716c',
                    'military',      '#ef4444',
                    'education',     '#8b5cf6',
                    'medical',       '#ec4899',
                    'recreation',    '#14b8a6',
                    '#4b5563'
                ],
                'fill-opacity': 0.3,
                'fill-outline-color': '#9ca3af'
            },
            // Paper theme: greens become soft sage canopy; everything else is a
            // muted warm-paper wash so vegetation reads as the only colour.
            paintLight: {
                'fill-color': [
                    'match', ['get', 'class'],
                    'park',          '#bcd3a6',
                    'forest',        '#a6c48c',
                    'recreation',    '#c4d8b2',
                    'farmland',      '#d8dcb0',
                    'cemetery',      '#cdd3bd',
                    '#e6e0d5'
                ],
                'fill-opacity': 0.5,
                'fill-outline-color': '#c2bbac'
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                return p.class ? `Land use: ${p.class}` : 'Land use zone';
            }
        },
        overture_places: {
            name: 'Places / POI (Overture)',
            icon: '\u{1F4CD}',
            group: 'Infrastructure',
            isPMTiles: true,
            pmtilesUrl: `${OVERTURE_BASE}/places.pmtiles`,
            sourceLayer: 'place',
            type: 'circle',
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    10, 2,
                    14, 4,
                    18, 7
                ],
                'circle-color': [
                    'match', ['get', 'class'],
                    'eat_and_drink',      '#f97316',
                    'shopping',           '#8b5cf6',
                    'health_and_medical', '#ef4444',
                    'education',          '#3b82f6',
                    'accommodation',      '#eab308',
                    'sports_and_recreation', '#22c55e',
                    'arts_and_entertainment', '#ec4899',
                    'public_service',     '#14b8a6',
                    'religious_organization', '#a78bfa',
                    '#6b7280'
                ],
                'circle-stroke-width': 1,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 0.8
            },
            // On the light Positron basemap the white stroke disappears; give the
            // dots a warm-ink outline so they keep definition on paper.
            paintLight: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    10, 2,
                    14, 4,
                    18, 7
                ],
                'circle-color': [
                    'match', ['get', 'class'],
                    'eat_and_drink',      '#dd6b4a',
                    'shopping',           '#5f7184',
                    'health_and_medical', '#c0392b',
                    'education',          '#3f6f8f',
                    'accommodation',      '#a3781f',
                    'sports_and_recreation', '#5f8a5a',
                    'arts_and_entertainment', '#b3627a',
                    'public_service',     '#4f8a86',
                    'religious_organization', '#6c727a',
                    '#7a7f85'
                ],
                'circle-stroke-width': 1,
                'circle-stroke-color': 'rgba(40,44,48,0.45)',
                'circle-opacity': 0.9
            },
            minZoom: 12,
            tooltip: f => {
                const p = f.properties || {};
                const parts = [];
                if (p.names) {
                    try {
                        const n = typeof p.names === 'string' ? JSON.parse(p.names) : p.names;
                        if (n.primary) parts.push(n.primary);
                    } catch { /* ignore */ }
                }
                if (p.class) parts.push(p.class.replace(/_/g, ' '));
                return parts.join(' | ') || 'Place';
            }
        },
        overture_divisions: {
            name: 'Admin Boundaries (Overture)',
            icon: '\u{1F3DB}',
            group: 'Boundaries',
            isPMTiles: true,
            pmtilesUrl: `${OVERTURE_BASE}/divisions.pmtiles`,
            sourceLayer: 'division_boundary',
            type: 'line',
            paint: {
                'line-color': '#f472b6',
                'line-width': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 1,
                    10, 2.5,
                    14, 1.5
                ],
                'line-dasharray': [3, 2],
                'line-opacity': 0.7
            },
            minZoom: 6,
            tooltip: () => 'Administrative boundary'
        },

        // ── Bhuvan WMS Raster Overlays (ISRO — no auth needed) ──
        bhuvan_drainage: {
            name: 'Drainage (Bhuvan)',
            icon: '\u{1F4A7}',
            group: 'Infrastructure',
            isWMS: true,
            wmsLayers: 'drainage:drainage_india',
            minZoom: 10,
            tooltip: () => 'Bhuvan WMS: Drainage Network'
        },
        bhuvan_water: {
            name: 'Water Bodies (Bhuvan)',
            icon: '\u{2693}',
            group: 'Infrastructure',
            isWMS: true,
            wmsLayers: 'waterbody:waterbody_india',
            minZoom: 8,
            tooltip: () => 'Bhuvan WMS: Water Bodies'
        },

        // ── Buildings ──
        google_buildings: {
            name: 'Google Open Buildings (3D)',
            icon: '\u{1F3E2}',
            group: 'Buildings',
            isPMTiles: true,
            pmtilesUrl: `${DATA_BASE}/vectors/google_open_buildings_indore.pmtiles`,
            sourceLayer: 'building',
            type: 'fill-extrusion',
            paint: {
                'fill-extrusion-color': [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'confidence'], 0.7],
                    0.65, '#f97316',
                    0.75, '#facc15',
                    0.85, '#22d3ee',
                    0.95, '#a78bfa'
                ],
                'fill-extrusion-height': [
                    '*',
                    ['sqrt', ['to-number', ['get', 'area_in_meters'], 50]],
                    3
                ],
                'fill-extrusion-base': 0,
                'fill-extrusion-opacity': 0.75
            },
            // Aino (aino.world) light: a white architectural massing model —
            // cool near-white volumes that deepen to light grey by footprint
            // (pseudo ambient occlusion), grounded (not floating), with a calm
            // low-rise height curve. MapLibre's vertical gradient + the
            // directional map light (set on attach) supply the model shading.
            paintLight: {
                'fill-extrusion-color': [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'area_in_meters'], 80],
                    0, '#f3f5f7',
                    150, '#e9edf0',
                    600, '#dce1e6',
                    2000, '#ccd2d9'
                ],
                'fill-extrusion-height': [
                    '+', 5,
                    ['*', ['sqrt', ['to-number', ['get', 'area_in_meters'], 50]], 1.1]
                ],
                'fill-extrusion-base': 0,
                'fill-extrusion-opacity': 0.96,
                'fill-extrusion-vertical-gradient': true
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                const conf = parseFloat(p.confidence) || 0;
                const area = parseFloat(p.area_in_meters) || 0;
                return `Conf: ${conf.toFixed(2)} | ${area.toFixed(0)}m\u00b2`;
            }
        },
        google_buildings_flat: {
            name: 'Google Open Buildings (2D)',
            icon: '\u{1F4D0}',
            group: 'Buildings',
            isPMTiles: true,
            pmtilesUrl: `${DATA_BASE}/vectors/google_open_buildings_indore.pmtiles`,
            sourceLayer: 'building',
            type: 'fill',
            paint: {
                'fill-color': [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'confidence'], 0.7],
                    0.65, '#f97316',
                    0.75, '#facc15',
                    0.85, '#22d3ee',
                    0.95, '#a78bfa'
                ],
                'fill-opacity': 0.5,
                'fill-outline-color': '#ffffff'
            },
            // Aino light: flat cool-grey building footprints, hairline outline.
            paintLight: {
                'fill-color': '#e7ebef',
                'fill-opacity': 0.88,
                'fill-outline-color': '#aab2bb'
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                const conf = parseFloat(p.confidence) || 0;
                const area = parseFloat(p.area_in_meters) || 0;
                return `Conf: ${conf.toFixed(2)} | ${area.toFixed(0)}m\u00b2`;
            }
        },

        // ── Boundaries ──
        city_boundary: {
            name: 'Indore City Boundary',
            icon: '\u{1F3D9}',
            file: null,
            group: 'Boundaries',
            type: 'fill',
            paint: {
                'fill-color': '#e879f9',
                'fill-opacity': 0.05
            },
            minZoom: 8,
            tooltip: () => 'Indore Municipal Boundary'
        },
        osm_admin: {
            name: 'Admin Zones (OSM)',
            icon: '\u{1F5FA}',
            file: 'vectors/osm_admin_boundaries_indore.geojson',
            group: 'Boundaries',
            type: 'fill',
            paint: {
                'fill-color': '#818cf8',
                'fill-opacity': 0.08,
                'fill-outline-color': '#a78bfa'
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                return p.name || `Admin level ${p.admin_level || '?'}`;
            }
        },

        // ── Environment ──
        osm_green_spaces: {
            name: 'Green Spaces (OSM)',
            icon: '\u{1F333}',
            file: 'vectors/osm_green_spaces_indore.geojson',
            group: 'Environment',
            type: 'fill',
            paint: {
                'fill-color': '#22c55e',
                'fill-opacity': 0.45,
                'fill-outline-color': '#16a34a'
            },
            // Paper theme: soft sage canopy (Aino's muted greens, not saturated).
            paintLight: {
                'fill-color': '#bcd3a6',
                'fill-opacity': 0.6,
                'fill-outline-color': '#9bbb80'
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                return p.name || p.natural || 'Green space';
            }
        },

        // ── Local Infrastructure (OSM) ──
        osm_pois: {
            name: 'Points of Interest',
            icon: '\u{1F4CD}',
            file: 'vectors/osm_pois_indore.geojson',
            group: 'Local Data',
            type: 'circle',
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    10, 2, 14, 5, 18, 8
                ],
                'circle-color': [
                    'match', ['get', 'amenity'],
                    'hospital',     '#ef4444',
                    'clinic',       '#f87171',
                    'pharmacy',     '#fb923c',
                    'police',       '#3b82f6',
                    'fire_station', '#dc2626',
                    'school',       '#8b5cf6',
                    'college',      '#7c3aed',
                    'university',   '#6d28d9',
                    'bank',         '#eab308',
                    'atm',          '#facc15',
                    'restaurant',   '#f97316',
                    'fast_food',    '#fb923c',
                    'cafe',         '#a16207',
                    'fuel',         '#64748b',
                    'place_of_worship', '#a78bfa',
                    'townhall',     '#14b8a6',
                    '#6b7280'
                ],
                'circle-stroke-width': 1,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 0.85
            },
            minZoom: 12,
            tooltip: f => {
                const p = f.properties || {};
                const parts = [];
                if (p.name) parts.push(p.name);
                if (p.amenity) parts.push(p.amenity.replace(/_/g, ' '));
                return parts.join(' | ') || 'POI';
            }
        },
        osm_shops: {
            name: 'Shops & Markets',
            icon: '\u{1F6CD}',
            file: 'vectors/osm_shops_indore.geojson',
            group: 'Local Data',
            type: 'circle',
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    12, 3, 16, 6
                ],
                'circle-color': '#f59e0b',
                'circle-stroke-width': 1,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 0.8
            },
            minZoom: 13,
            tooltip: f => {
                const p = f.properties || {};
                const parts = [];
                if (p.name) parts.push(p.name);
                if (p.shop) parts.push(p.shop.replace(/_/g, ' '));
                return parts.join(' | ') || 'Shop';
            }
        },
        osm_railways: {
            name: 'Railway Stations',
            icon: '\u{1F682}',
            file: 'vectors/osm_railways_indore.geojson',
            group: 'Local Data',
            type: 'circle',
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    10, 4, 14, 8
                ],
                'circle-color': '#06b6d4',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 0.9
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                return p.name || p.railway || 'Railway';
            }
        },
        osm_utilities: {
            name: 'Power Infrastructure',
            icon: '\u{26A1}',
            file: 'vectors/osm_utilities_indore.geojson',
            group: 'Local Data',
            type: 'circle',
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    10, 1.5, 14, 3, 18, 5
                ],
                'circle-color': '#facc15',
                'circle-stroke-width': 0.5,
                'circle-stroke-color': '#ca8a04',
                'circle-opacity': 0.6
            },
            minZoom: 13,
            tooltip: f => {
                const p = f.properties || {};
                return p.power ? `Power: ${p.power}` : 'Utility';
            }
        },

        osm_roads: {
            name: 'Road Network (OSM)',
            icon: '\u{1F6E3}',
            file: 'vectors/osm_roads_indore.geojson',
            group: 'Local Data',
            type: 'line',
            paint: {
                'line-color': [
                    'match', ['get', 'highway'],
                    'motorway',     '#f97316',
                    'trunk',        '#fb923c',
                    'primary',      '#eab308',
                    'secondary',    '#a3e635',
                    'tertiary',     '#67e8f9',
                    'residential',  '#94a3b8',
                    'service',      '#64748b',
                    'track',        '#78716c',
                    'footway',      '#a78bfa',
                    'cycleway',     '#34d399',
                    'path',         '#d4d4d8',
                    '#6b7280'
                ],
                'line-width': [
                    'match', ['get', 'highway'],
                    'motorway', 3,
                    'trunk', 2.5,
                    'primary', 2.5,
                    'secondary', 2,
                    'tertiary', 1.5,
                    'residential', 1,
                    0.8
                ],
                'line-opacity': 0.8
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                const parts = [];
                if (p.name) parts.push(p.name);
                if (p.highway) parts.push(p.highway.replace(/_/g, ' '));
                if (p.surface) parts.push(p.surface);
                return parts.join(' | ') || 'Road';
            }
        },
        osm_water: {
            name: 'Water Bodies (OSM)',
            icon: '\u{1F4A7}',
            file: 'vectors/osm_water_indore.geojson',
            group: 'Environment',
            type: 'fill',
            paint: {
                'fill-color': '#0ea5e9',
                'fill-opacity': 0.5,
                'fill-outline-color': '#0284c7'
            },
            minZoom: 10,
            tooltip: f => {
                const p = f.properties || {};
                const parts = [];
                if (p.name) parts.push(p.name);
                if (p.waterway) parts.push(p.waterway);
                if (p.natural) parts.push(p.natural);
                return parts.join(' | ') || 'Water body';
            }
        },

        // ── Sensors (Live API) ──
        sensor_weather: {
            name: 'Weather Station',
            icon: '\u{1F321}',
            file: null,
            group: 'Sensors',
            type: 'circle',
            paint: {
                'circle-radius': 10,
                'circle-color': '#fbbf24',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            },
            minZoom: 8,
            tooltip: f => {
                const p = f.properties || {};
                if (p.temperature_2m != null) {
                    return `${p.temperature_2m}\u00b0C | ${p.relative_humidity_2m || '?'}% RH | Wind ${p.wind_speed_10m || '?'} km/h`;
                }
                return 'Open-Meteo Weather';
            }
        },
        sensor_aqi: {
            name: 'Air Quality',
            icon: '\u{1F32C}',
            file: null,
            group: 'Sensors',
            type: 'circle',
            paint: {
                'circle-radius': 10,
                'circle-color': '#ef4444',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            },
            minZoom: 8,
            tooltip: f => {
                const p = f.properties || {};
                if (p.pm2_5 != null) {
                    return `PM2.5: ${p.pm2_5} | PM10: ${p.pm10 || '?'} | AQI: ${p.european_aqi || '?'}`;
                }
                return 'Open-Meteo AQI';
            }
        },
        sensor_solar: {
            name: 'Solar Radiation',
            icon: '\u{2600}',
            file: null,
            group: 'Sensors',
            type: 'circle',
            paint: {
                'circle-radius': 10,
                'circle-color': '#f97316',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            },
            minZoom: 8,
            tooltip: f => {
                const p = f.properties || {};
                if (p.shortwave_radiation != null) {
                    return `GHI: ${p.shortwave_radiation} W/m\u00b2 | Direct: ${p.direct_radiation || '?'} W/m\u00b2`;
                }
                return 'Open-Meteo Solar';
            }
        }
    };

    // Indore city boundary from KML (inline GeoJSON)
    const CITY_BOUNDARY_GEOJSON = {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [75.79962, 22.62456], [75.93717, 22.64608], [76.00026, 22.68581],
                    [75.95978, 22.72031], [75.96720, 22.85024], [75.98306, 22.89800],
                    [75.95646, 22.90590], [75.87929, 22.79589], [75.84642, 22.81872],
                    [75.77486, 22.75523], [75.75684, 22.74858], [75.75686, 22.72617],
                    [75.79962, 22.62456]
                ]]
            },
            properties: { name: 'Indore Municipal Boundary', source: 'Google Earth KML' }
        }]
    };

    // ─── Core Functions ────────────────────────────────────────────

    async function _loadGeoJSON(key) {
        if (_cache.has(key)) return _cache.get(key);

        const def = LAYER_DEFS[key];
        if (!def) throw new Error(`Unknown layer: ${key}`);

        if (key === 'city_boundary') {
            _cache.set(key, CITY_BOUNDARY_GEOJSON);
            return CITY_BOUNDARY_GEOJSON;
        }

        if (key === 'sensor_weather' || key === 'sensor_aqi' || key === 'sensor_solar') {
            const data = await _loadSensorData(key);
            _cache.set(key, data);
            return data;
        }

        if (!def.file) throw new Error(`No data source for ${def.name}`);

        const url = `${DATA_BASE}/${def.file}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to load ${def.name}: ${resp.status}`);

        const data = await resp.json();
        _cache.set(key, data);
        return data;
    }

    async function _loadSensorData(key) {
        const CENTER = { lat: 22.7196, lon: 75.8577 };

        try {
            let metrics = {};
            if (key === 'sensor_weather') {
                const params = 'current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,weather_code';
                const resp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${CENTER.lat}&longitude=${CENTER.lon}&${params}&timezone=Asia/Kolkata`);
                const data = await resp.json();
                metrics = data.current || {};
            } else if (key === 'sensor_aqi') {
                const params = 'current=pm2_5,pm10,european_aqi,uv_index';
                const resp = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${CENTER.lat}&longitude=${CENTER.lon}&${params}&timezone=Asia/Kolkata`);
                const data = await resp.json();
                metrics = data.current || {};
            } else if (key === 'sensor_solar') {
                const params = 'current=shortwave_radiation,direct_radiation,diffuse_radiation,direct_normal_irradiance';
                const resp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${CENTER.lat}&longitude=${CENTER.lon}&${params}&timezone=Asia/Kolkata`);
                const data = await resp.json();
                metrics = data.current || {};
            }

            return {
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [CENTER.lon, CENTER.lat] },
                    properties: { sensor_type: key.replace('sensor_', ''), ...metrics }
                }]
            };
        } catch {
            return { type: 'FeatureCollection', features: [] };
        }
    }

    // ─── PMTiles Layer Init ────────────────────────────────────────

    function _initPMTilesLayer(key) {
        const def = LAYER_DEFS[key];
        const sourceId = `dt-source-${key}`;
        const layerId = `dt-layer-${key}`;
        const tetherLayerId = `dt-tether-${key}`;

        if (!_map.getSource(sourceId)) {
            _map.addSource(sourceId, {
                type: 'vector',
                url: `pmtiles://${def.pmtilesUrl}`
            });
        }

        // Add holographic tether layer first (renders below the main layer)
        if (def.tether && !_map.getLayer(tetherLayerId)) {
            _map.addLayer({
                id: tetherLayerId,
                type: 'fill-extrusion',
                source: sourceId,
                'source-layer': def.sourceLayer,
                paint: def.tether.paint,
                minzoom: def.minZoom || 0,
                layout: { visibility: 'visible' }
            });
        }

        if (!_map.getLayer(layerId)) {
            _map.addLayer({
                id: layerId,
                type: def.type,
                source: sourceId,
                'source-layer': def.sourceLayer,
                paint: _paintFor(def),
                minzoom: def.minZoom || 0,
                layout: { visibility: 'visible' }
            });

            _map.on('mousemove', layerId, (e) => onMouseMove(e, key));
            _map.on('mouseleave', layerId, onMouseLeave);
            _map.on('click', layerId, onClick);

            // Aino light: give 3D extrusions a fixed directional "sun" so the
            // white massing model reads with a consistent lit/shadow side
            // (anchor:'map' keeps the light tied to geography as you rotate).
            const light = typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light';
            if (light && def.type === 'fill-extrusion') {
                try {
                    _map.setLight({ anchor: 'map', position: [1.4, 210, 38], color: '#ffffff', intensity: 0.45 });
                } catch { /* older MapLibre without setLight — vertical gradient still applies */ }
            }
        } else {
            _map.setLayoutProperty(layerId, 'visibility', 'visible');
            if (def.tether) _map.setLayoutProperty(tetherLayerId, 'visibility', 'visible');
        }

        _layers[key].sourceId = sourceId;
        _layers[key].layerIds = def.tether ? [tetherLayerId, layerId] : [layerId];
    }

    // ─── WMS Raster Layer Init ─────────────────────────────────────

    function _initWMSLayer(key) {
        const def = LAYER_DEFS[key];
        const sourceId = `dt-source-${key}`;
        const layerId = `dt-layer-${key}`;

        // Build WMS GetMap URL template for MapLibre raster source
        const wmsUrl = `${BHUVAN_WMS}?service=WMS&version=1.1.1&request=GetMap`
            + `&layers=${encodeURIComponent(def.wmsLayers)}`
            + `&srs=EPSG:3857&format=image/png&transparent=true`
            + `&width=256&height=256&bbox={bbox-epsg-3857}`;

        if (!_map.getSource(sourceId)) {
            _map.addSource(sourceId, {
                type: 'raster',
                tiles: [wmsUrl],
                tileSize: 256,
                attribution: '&copy; ISRO/NRSC Bhuvan'
            });
        }

        if (!_map.getLayer(layerId)) {
            _map.addLayer({
                id: layerId,
                type: 'raster',
                source: sourceId,
                minzoom: def.minZoom || 0,
                paint: {
                    'raster-opacity': 0.6
                },
                layout: { visibility: 'visible' }
            });
        } else {
            _map.setLayoutProperty(layerId, 'visibility', 'visible');
        }

        _layers[key].sourceId = sourceId;
        _layers[key].layerIds = [layerId];
    }

    // ─── GeoJSON Layer Init ────────────────────────────────────────

    function _initGeoJSONLayers(key, geojson) {
        const def = LAYER_DEFS[key];
        const sourceId = `dt-source-${key}`;
        const layerIds = [];

        if (!_map.getSource(sourceId)) {
            _map.addSource(sourceId, {
                type: 'geojson',
                data: geojson
            });
        }

        const baseLayerId = `dt-layer-${key}`;

        if (!_map.getLayer(baseLayerId)) {
            _map.addLayer({
                id: baseLayerId,
                type: def.type,
                source: sourceId,
                paint: _paintFor(def),
                minzoom: def.minZoom || 0,
                layout: { visibility: 'visible' }
            });
            layerIds.push(baseLayerId);

            // City boundary gets an additional dashed line layer
            if (key === 'city_boundary') {
                const lineLayerId = `dt-layer-line-${key}`;
                _map.addLayer({
                    id: lineLayerId,
                    type: 'line',
                    source: sourceId,
                    paint: {
                        'line-color': '#e879f9',
                        'line-width': 3,
                        'line-dasharray': [2, 1]
                    },
                    minzoom: def.minZoom || 0,
                    layout: { visibility: 'visible' }
                });
                layerIds.push(lineLayerId);
            }
        } else {
            layerIds.push(baseLayerId);
            _map.setLayoutProperty(baseLayerId, 'visibility', 'visible');
            if (key === 'city_boundary') {
                const lineLayerId = `dt-layer-line-${key}`;
                _map.setLayoutProperty(lineLayerId, 'visibility', 'visible');
                layerIds.push(lineLayerId);
            }
        }

        layerIds.forEach(lId => {
            _map.on('mousemove', lId, (e) => onMouseMove(e, key));
            _map.on('mouseleave', lId, onMouseLeave);
            _map.on('click', lId, onClick);
        });

        _layers[key].sourceId = sourceId;
        _layers[key].layerIds = layerIds;
    }

    // ─── Mouse / Click Handlers ────────────────────────────────────

    function onMouseMove(e, key) {
        if (!_map) return;
        _map.getCanvas().style.cursor = 'pointer';

        const def = LAYER_DEFS[key];
        if (!def.tooltip) return;

        const f = e.features[0];
        const text = def.tooltip(f);
        if (!text) return;

        if (!_hoverPopup) {
            _hoverPopup = new maplibregl.Popup({
                closeButton: false,
                closeOnClick: false,
                className: 'dt-tooltip-native'
            });
        }

        // tooltip() returns plain text built from external Overture props
        // (names, class, subclass) — setText escapes it; setHTML would not.
        _hoverPopup.setLngLat(e.lngLat).setText(text).addTo(_map);
    }

    function onMouseLeave() {
        if (!_map) return;
        _map.getCanvas().style.cursor = '';
        if (_hoverPopup) _hoverPopup.remove();
    }

    function onClick(e) {
        if (!e.features || e.features.length === 0) return;

        const feature = e.features[0];
        const props = feature.properties || {};

        // Parse nested JSON fields for Overture data
        const displayProps = {};
        for (const [k, v] of Object.entries(props)) {
            if (k === 'geometry' || k.startsWith('osm_')) continue;
            if (k === 'names' && typeof v === 'string') {
                try {
                    const n = JSON.parse(v);
                    if (n.primary) displayProps['Name'] = n.primary;
                } catch { displayProps[k] = v; }
                continue;
            }
            if (k === 'sources' || k === 'source_tags') continue;
            displayProps[k] = v;
        }

        const entries = Object.entries(displayProps).slice(0, 12);
        if (entries.length === 0) return;

        // Overture props (incl. the building name) are external data — escape
        // both key and value before interpolating into setHTML.
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        let html = '<div class="dt-popup" style="font-family:Inter,sans-serif; min-width:180px;">';
        entries.forEach(([k, v]) => {
            html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px; border-bottom:1px solid #eee; padding-bottom:2px;">
                <span style="color:#555; text-transform:capitalize; margin-right:8px;">${esc(k.replace(/_/g, ' '))}</span>
                <span style="font-weight:bold; text-align:right;">${esc(String(v).slice(0, 60))}</span>
            </div>`;
        });
        html += '</div>';

        if (_clickPopup) _clickPopup.remove();

        _clickPopup = new maplibregl.Popup({ className: 'dt-building-popup', maxWidth: '300px' })
            .setLngLat(e.lngLat)
            .setHTML(html)
            .addTo(_map);
    }

    // ─── Toggle (unified entry point) ──────────────────────────────

    async function toggle(key, map) {
        _map = map;
        const state = _layers[key] || { visible: false, loading: false, sourceId: null, layerIds: [] };
        _layers[key] = state;

        // Toggle off
        if (state.visible && state.layerIds.length > 0) {
            state.layerIds.forEach(id => map.setLayoutProperty(id, 'visibility', 'none'));
            state.visible = false;
            if (_clickPopup) _clickPopup.remove();
            if (_hoverPopup) _hoverPopup.remove();
            return false;
        }

        if (state.loading) return state.visible;

        const def = LAYER_DEFS[key];
        if (!def) throw new Error(`Unknown layer: ${key}`);

        state.loading = true;

        try {
            // GeoTIFF raster — disabled pending tile conversion
            if (def.isRaster) {
                state.loading = false;
                throw new Error('GeoTIFF display requires XYZ tile conversion. Use pipeline/raster_to_tiles.py first.');
            }

            // PMTiles vector tiles
            if (def.isPMTiles) {
                _initPMTilesLayer(key);
                state.visible = true;
                state.loading = false;
                return true;
            }

            // WMS raster tiles
            if (def.isWMS) {
                _initWMSLayer(key);
                state.visible = true;
                state.loading = false;
                return true;
            }

            // GeoJSON vector data
            const geojson = await _loadGeoJSON(key);
            const featureCount = geojson.features?.length || 0;
            if (featureCount === 0) {
                state.loading = false;
                return false;
            }

            _initGeoJSONLayers(key, geojson);
            state.visible = true;
            state.loading = false;
            return true;
        } catch (err) {
            state.loading = false;
            console.warn(`DigitalTwinLayers: ${err.message}`);
            throw err;
        }
    }

    async function checkAvailability(key) {
        const def = LAYER_DEFS[key];
        if (!def) return false;
        if (def.isPMTiles || def.isWMS) return true;
        if (!def.file) return true;
        try {
            const resp = await fetch(`${DATA_BASE}/${def.file}`, { method: 'HEAD' });
            return resp.ok;
        } catch {
            return false;
        }
    }

    function getLayerDefs() {
        return Object.entries(LAYER_DEFS).map(([key, def]) => ({
            key,
            name: def.name,
            icon: def.icon,
            group: def.group,
            visible: _layers[key]?.visible || false,
            loading: _layers[key]?.loading || false
        }));
    }

    function isVisible(key) {
        return _layers[key]?.visible || false;
    }

    function getFeatureCount(key) {
        const def = LAYER_DEFS[key];
        if (def?.isPMTiles || def?.isWMS || def?.isRaster) {
            return _layers[key]?.visible ? 1 : 0;
        }
        const data = _cache.get(key);
        return data?.features?.length || 0;
    }

    function clearAll(map) {
        Object.entries(_layers).forEach(([, state]) => {
            if (state.visible && state.layerIds?.length > 0) {
                state.layerIds.forEach(id => map.setLayoutProperty(id, 'visibility', 'none'));
                state.visible = false;
            }
        });
        if (_clickPopup) _clickPopup.remove();
        if (_hoverPopup) _hoverPopup.remove();
    }

    return {
        toggle,
        checkAvailability,
        getLayerDefs,
        isVisible,
        getFeatureCount,
        clearAll,
        paintFor: _paintFor,
        LAYER_DEFS
    };
})();
