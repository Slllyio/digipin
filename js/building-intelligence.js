/**
 * Building Intelligence Module — Deep Real Estate & Urban Morphology Analysis
 *
 * DATA SOURCES:
 *  1. Enhanced Overpass (OSM) — building:levels, building:height, building:material, roof:shape
 *  2. Local Climate Zones (LCZ) — 100m global urban morphology classification via TMS tiles
 *  3. Overture Maps Buildings — 2.3B building footprints via PMTiles (best-effort)
 *
 * OUTPUTS:
 *  - Building height distribution, avg levels, material breakdown
 *  - FSI/FAR estimation, building density, ground coverage ratio
 *  - LCZ classification (compact/open highrise/midrise/lowrise etc.)
 *  - Development potential score, redevelopment index
 *  - Real estate micro-metrics for investment analysis
 */

const BuildingIntelligence = (() => {
    const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

    // LCZ TMS tile endpoint (100m resolution, global coverage).
    // The `latest` alias is a 302 to `v3` — hitting v3 directly saves
    // one roundtrip per tile (~51 tiles per viewport).
    const LCZ_TMS = 'https://lcz-generator.rub.de/tms/global-map-tiles/v3';

    // LCZ class definitions — urban morphology at 100m
    const LCZ_CLASSES = {
        1:  { name: 'Compact Highrise',    type: 'built', density: 'very_high', height: 'high',   color: '#8c0000' },
        2:  { name: 'Compact Midrise',     type: 'built', density: 'very_high', height: 'mid',    color: '#d10000' },
        3:  { name: 'Compact Lowrise',     type: 'built', density: 'very_high', height: 'low',    color: '#ff0000' },
        4:  { name: 'Open Highrise',       type: 'built', density: 'moderate',  height: 'high',   color: '#bf4d00' },
        5:  { name: 'Open Midrise',        type: 'built', density: 'moderate',  height: 'mid',    color: '#ff6600' },
        6:  { name: 'Open Lowrise',        type: 'built', density: 'moderate',  height: 'low',    color: '#ff9955' },
        7:  { name: 'Lightweight Lowrise', type: 'built', density: 'low',       height: 'low',    color: '#faee05' },
        8:  { name: 'Large Lowrise',       type: 'built', density: 'moderate',  height: 'low',    color: '#bcbcbc' },
        9:  { name: 'Sparsely Built',      type: 'built', density: 'very_low',  height: 'low',    color: '#ffccaa' },
        10: { name: 'Heavy Industry',      type: 'built', density: 'moderate',  height: 'mid',    color: '#555555' },
        11: { name: 'Dense Trees',         type: 'natural', cover: 'trees',    color: '#006a00' },
        12: { name: 'Scattered Trees',     type: 'natural', cover: 'trees',    color: '#00aa00' },
        13: { name: 'Bush / Scrub',        type: 'natural', cover: 'shrub',    color: '#648525' },
        14: { name: 'Low Plants',          type: 'natural', cover: 'grass',    color: '#b9db79' },
        15: { name: 'Bare Rock / Paved',   type: 'natural', cover: 'bare',     color: '#000000' },
        16: { name: 'Bare Soil / Sand',    type: 'natural', cover: 'bare',     color: '#fbf7ae' },
        17: { name: 'Water',              type: 'natural', cover: 'water',    color: '#6a6aff' }
    };

    // Overture Maps PMTiles (buildings theme)
    const OVERTURE_BUILDINGS_URL = 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2024-08-20/buildings.pmtiles';

    // Cache for building data (separate from main DataFetcher cache)
    const _cache = new Map();
    const CACHE_TTL = 10 * 60 * 1000; // 10 min (building data changes slowly)
    const MAX_CACHE = 50;

    function _cacheKey(lat, lng) { return `${lat.toFixed(4)},${lng.toFixed(4)}`; }

    function _cacheGet(key) {
        const e = _cache.get(key);
        if (!e) return null;
        if (Date.now() - e.time > CACHE_TTL) { _cache.delete(key); return null; }
        _cache.delete(key); _cache.set(key, e); // LRU
        return e.data;
    }

    function _cacheSet(key, data) {
        if (_cache.size >= MAX_CACHE) _cache.delete(_cache.keys().next().value);
        _cache.set(key, { data, time: Date.now() });
    }

    /**
     * Main entry — fetch all building intelligence for a location
     * Returns: { buildings, lcz, metrics, scores }
     */
    async function fetch(lat, lng, radius = 500) {
        const key = _cacheKey(lat, lng);
        const cached = _cacheGet(key);
        if (cached) return cached;

        // Fire all sources in parallel
        const [buildingData, lczData] = await Promise.allSettled([
            fetchEnhancedBuildings(lat, lng, radius),
            fetchLCZ(lat, lng)
        ]);

        const buildings = buildingData.status === 'fulfilled' ? buildingData.value : getEmptyBuildingData();
        const lcz = lczData.status === 'fulfilled' ? lczData.value : null;

        // Compute derived real estate metrics
        const metrics = computeMetrics(buildings, lcz, radius);
        const scores = computeBuildingScores(buildings, lcz, metrics);

        // Enrich with Overture visible stats if overlay is active
        let overtureStats = null;
        if (typeof OvertureBuildings !== 'undefined' && OvertureBuildings.isActive()) {
            overtureStats = OvertureBuildings.getVisibleStats();
        }

        const result = { buildings, lcz, metrics, scores, overtureStats };
        _cacheSet(key, result);
        return result;
    }

    /**
     * Enhanced Overpass query — extracts building metadata beyond basic counts
     * Tags: building:levels, height, building:material, roof:shape, start_date, building type
     */
    async function fetchEnhancedBuildings(lat, lng, radius) {
        const query = `[out:json][timeout:15];
(
  way["building"](around:${radius},${lat},${lng});
  relation["building"](around:${radius},${lat},${lng});
);
out tags center;`;

        const resp = await window.fetch(OVERPASS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query)
        });

        if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
        const data = await resp.json();
        const elements = data.elements || [];

        return classifyBuildings(elements);
    }

    /**
     * Classify building elements into detailed metrics
     */
    function classifyBuildings(elements) {
        const result = {
            totalCount: elements.length,
            withHeight: 0,
            withLevels: 0,
            withMaterial: 0,
            withAge: 0,
            heights: [],         // actual heights in meters
            levels: [],          // floor counts
            types: {},           // residential, commercial, etc.
            materials: {},       // brick, concrete, etc.
            roofShapes: {},      // flat, gabled, etc.
            ageDecades: {},      // 1990s, 2000s, 2010s, etc.
            heightBands: { low: 0, mid: 0, high: 0, vhigh: 0 }, // <3m, 3-12m, 12-40m, 40m+
            avgHeight: 0,
            avgLevels: 0,
            maxHeight: 0,
            maxLevels: 0,
            medianHeight: 0,
            heightStdDev: 0,
            // Per-building records (capped) — centroid + parsed levels/height/type.
            // Retained so consumers (e.g. the DTDL twin export) can emit one twin
            // per footprint instead of a single aggregate building.
            items: []
        };
        const ITEM_CAP = 300;

        for (const el of elements) {
            const tags = el.tags || {};

            // Building type
            const bType = tags.building || 'yes';
            const normalizedType = normalizeBuildingType(bType);
            result.types[normalizedType] = (result.types[normalizedType] || 0) + 1;

            // Height (meters)
            const heightStr = tags.height || tags['building:height'];
            if (heightStr) {
                const h = parseFloat(heightStr);
                if (!isNaN(h) && h > 0 && h < 500) {
                    result.heights.push(h);
                    result.withHeight++;
                    if (h < 3) result.heightBands.low++;
                    else if (h < 12) result.heightBands.mid++;
                    else if (h < 40) result.heightBands.high++;
                    else result.heightBands.vhigh++;
                }
            }

            // Levels (floors)
            const levelsStr = tags['building:levels'];
            if (levelsStr) {
                const l = parseInt(levelsStr, 10);
                if (!isNaN(l) && l > 0 && l < 200) {
                    result.levels.push(l);
                    result.withLevels++;
                }
            }

            // Estimate height from levels if no direct height
            if (!heightStr && levelsStr) {
                const l = parseInt(levelsStr, 10);
                if (!isNaN(l) && l > 0) {
                    const estHeight = l * 3.2; // 3.2m per floor average
                    result.heights.push(estHeight);
                    if (estHeight < 3) result.heightBands.low++;
                    else if (estHeight < 12) result.heightBands.mid++;
                    else if (estHeight < 40) result.heightBands.high++;
                    else result.heightBands.vhigh++;
                }
            }

            // Material
            const mat = tags['building:material'] || tags['building:facade:material'];
            if (mat) {
                const nm = mat.toLowerCase();
                result.materials[nm] = (result.materials[nm] || 0) + 1;
                result.withMaterial++;
            }

            // Roof shape
            const roof = tags['roof:shape'];
            if (roof) {
                result.roofShapes[roof] = (result.roofShapes[roof] || 0) + 1;
            }

            // Age (start_date or building:age)
            const age = tags.start_date || tags['building:start_date'];
            if (age) {
                const year = parseInt(age, 10);
                if (!isNaN(year) && year > 1800 && year <= 2030) {
                    const decade = Math.floor(year / 10) * 10 + 's';
                    result.ageDecades[decade] = (result.ageDecades[decade] || 0) + 1;
                    result.withAge++;
                }
            }

            // Per-building record (centroid from `out center`), capped.
            if (result.items.length < ITEM_CAP && el.center) {
                const lvl = levelsStr ? parseInt(levelsStr, 10) : NaN;
                const lvlValid = !isNaN(lvl) && lvl > 0 && lvl < 200;
                const h = heightStr ? parseFloat(heightStr) : NaN;
                const heightM = (!isNaN(h) && h > 0 && h < 500) ? h
                    : lvlValid ? +(lvl * 3.2).toFixed(1) : null;
                result.items.push({
                    id: el.id != null ? String(el.id) : null,
                    lat: el.center.lat,
                    lng: el.center.lon,
                    type: normalizedType,
                    levels: lvlValid ? lvl : null,
                    heightM,
                });
            }
        }

        // Compute statistics
        if (result.heights.length > 0) {
            const sorted = [...result.heights].sort((a, b) => a - b);
            result.avgHeight = +(sorted.reduce((s, h) => s + h, 0) / sorted.length).toFixed(1);
            result.maxHeight = +sorted[sorted.length - 1].toFixed(1);
            result.medianHeight = +sorted[Math.floor(sorted.length / 2)].toFixed(1);

            const mean = result.avgHeight;
            const variance = sorted.reduce((s, h) => s + (h - mean) ** 2, 0) / sorted.length;
            result.heightStdDev = +Math.sqrt(variance).toFixed(1);
        }

        if (result.levels.length > 0) {
            result.avgLevels = +(result.levels.reduce((s, l) => s + l, 0) / result.levels.length).toFixed(1);
            result.maxLevels = Math.max(...result.levels);
        }

        return result;
    }

    function normalizeBuildingType(raw) {
        const map = {
            'yes': 'unclassified', 'residential': 'residential', 'house': 'residential',
            'apartments': 'residential', 'detached': 'residential', 'terrace': 'residential',
            'commercial': 'commercial', 'office': 'commercial', 'retail': 'commercial',
            'industrial': 'industrial', 'warehouse': 'industrial', 'manufacture': 'industrial',
            'school': 'institutional', 'university': 'institutional', 'hospital': 'institutional',
            'church': 'religious', 'mosque': 'religious', 'temple': 'religious',
            'garage': 'auxiliary', 'shed': 'auxiliary', 'hut': 'auxiliary',
            'construction': 'construction'
        };
        return map[raw.toLowerCase()] || 'other';
    }

    /**
     * Fetch LCZ classification for a point.
     * Strategy: Try TMS pixel sampling via fetch+blob (avoids CORS img tag issue).
     * Fallback: Infer LCZ from building data heuristics.
     */
    async function fetchLCZ(lat, lng) {
        const zoom = 13;
        const tileX = lon2tile(lng, zoom);
        const tileY = lat2tile(lat, zoom);
        const url = `${LCZ_TMS}/${zoom}/${tileX}/${tileY}.png`;

        try {
            // Fetch tile as blob to avoid CORS img+canvas restriction
            const resp = await window.fetch(url, { mode: 'cors' });
            if (!resp.ok) throw new Error('LCZ fetch failed');
            const blob = await resp.blob();
            const bmp = await createImageBitmap(blob);
            const pixel = samplePixelFromBitmap(bmp, lat, lng, zoom, tileX, tileY);
            bmp.close();
            const lczClass = identifyLCZ(pixel);

            if (lczClass) {
                return {
                    classId: lczClass,
                    className: LCZ_CLASSES[lczClass]?.name || 'Unknown',
                    type: LCZ_CLASSES[lczClass]?.type || 'unknown',
                    density: LCZ_CLASSES[lczClass]?.density || null,
                    height: LCZ_CLASSES[lczClass]?.height || null,
                    color: LCZ_CLASSES[lczClass]?.color || '#888',
                    tileUrl: url
                };
            }
        } catch {
            // CORS or network failure — fall through to heuristic
        }

        return null; // Heuristic fallback handled in computeMetrics via classifyUrbanForm
    }

    // === Tile math ===
    function lon2tile(lon, zoom) { return Math.floor((lon + 180) / 360 * (1 << zoom)); }
    function lat2tile(lat, zoom) {
        return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * (1 << zoom));
    }

    function samplePixelFromBitmap(bmp, lat, lng, zoom, tileX, tileY) {
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);

        const n = 1 << zoom;
        const xFrac = ((lng + 180) / 360 * n) - tileX;
        const yFrac = ((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n) - tileY;

        const px = Math.max(0, Math.min(Math.floor(xFrac * bmp.width), bmp.width - 1));
        const py = Math.max(0, Math.min(Math.floor(yFrac * bmp.height), bmp.height - 1));

        const data = ctx.getImageData(px, py, 1, 1).data;
        return { r: data[0], g: data[1], b: data[2], a: data[3] };
    }

    /**
     * Match pixel color to LCZ class using color distance
     */
    function identifyLCZ(pixel) {
        if (pixel.a < 128) return null; // Transparent = no data

        let bestClass = null;
        let bestDist = Infinity;

        for (const [id, cls] of Object.entries(LCZ_CLASSES)) {
            const cr = parseInt(cls.color.slice(1, 3), 16);
            const cg = parseInt(cls.color.slice(3, 5), 16);
            const cb = parseInt(cls.color.slice(5, 7), 16);

            const dist = (pixel.r - cr) ** 2 + (pixel.g - cg) ** 2 + (pixel.b - cb) ** 2;
            if (dist < bestDist) {
                bestDist = dist;
                bestClass = parseInt(id);
            }
        }

        return bestClass;
    }

    /**
     * Compute derived real estate metrics
     */
    function computeMetrics(buildings, lcz, radius) {
        const areaM2 = Math.PI * radius * radius; // circular query area
        const areaHa = areaM2 / 10000;

        // Building density (buildings per hectare)
        const buildingDensity = +(buildings.totalCount / areaHa).toFixed(1);

        // FSI / FAR estimation
        // FSI = Total floor area / Plot area
        // Estimate: avg_levels * building_footprint_area / total_area
        // Without exact footprint areas, we estimate avg footprint ~120m2 for Indian cities
        const estAvgFootprint = 120; // m2, typical for Indian urban
        const estTotalFloorArea = buildings.totalCount * estAvgFootprint * (buildings.avgLevels || 1.5);
        const fsi = +(estTotalFloorArea / areaM2).toFixed(2);

        // Ground coverage ratio (approximate)
        const gcr = +Math.min(1, (buildings.totalCount * estAvgFootprint) / areaM2).toFixed(3);

        // Height diversity index (Shannon entropy on height bands)
        const heightDiversity = computeShannon(buildings.heightBands);

        // Building type mix (Shannon entropy on types)
        const typeMix = computeShannon(buildings.types);

        // Material diversity
        const materialDiversity = computeShannon(buildings.materials);

        // Development potential indicators
        const hasVacantLand = lcz && (lcz.classId === 14 || lcz.classId === 16); // Low plants or bare soil
        const isSparselyBuilt = lcz && lcz.classId === 9;
        const isCompact = lcz && [1, 2, 3].includes(lcz.classId);
        const isIndustrial = lcz && lcz.classId === 10;

        // Verticality index — how much vertical development vs horizontal
        const verticalityIndex = buildings.avgLevels > 0
            ? +Math.min(100, (buildings.avgLevels / 5) * 100).toFixed(0)
            : 0;

        // Modernization ratio — newer buildings percentage
        const totalAged = Object.values(buildings.ageDecades).reduce((s, v) => s + v, 0);
        const recentBuildings = (buildings.ageDecades['2010s'] || 0) + (buildings.ageDecades['2020s'] || 0);
        const modernizationRatio = totalAged > 0
            ? +((recentBuildings / totalAged) * 100).toFixed(0)
            : null;

        // Urban form classification
        const urbanForm = classifyUrbanForm(buildings, lcz);

        return {
            buildingDensity,
            fsi,
            gcr,
            heightDiversity,
            typeMix,
            materialDiversity,
            verticalityIndex,
            modernizationRatio,
            urbanForm,
            hasVacantLand,
            isSparselyBuilt,
            isCompact,
            isIndustrial,
            areaHa,
            estTotalFloorArea: Math.round(estTotalFloorArea)
        };
    }

    function computeShannon(obj) {
        const values = Object.values(obj).filter(v => v > 0);
        const total = values.reduce((s, v) => s + v, 0);
        if (total === 0) return 0;

        let entropy = 0;
        for (const v of values) {
            const p = v / total;
            if (p > 0) entropy -= p * Math.log2(p);
        }

        // Normalize to 0-100 scale (max entropy = log2(n_classes))
        const maxEntropy = Math.log2(Math.max(2, values.length));
        return +(Math.min(100, (entropy / maxEntropy) * 100)).toFixed(0);
    }

    function classifyUrbanForm(buildings, lcz) {
        if (!buildings.totalCount) return 'Undeveloped';

        if (lcz) {
            if ([1, 2, 3].includes(lcz.classId)) return 'Dense Urban Core';
            if ([4, 5, 6].includes(lcz.classId)) return 'Open Urban';
            if (lcz.classId === 7) return 'Informal Settlement';
            if (lcz.classId === 8) return 'Commercial / Warehouse';
            if (lcz.classId === 9) return 'Peri-Urban';
            if (lcz.classId === 10) return 'Industrial Zone';
        }

        // Fallback to building data
        if (buildings.avgLevels >= 5) return 'High-Rise Zone';
        if (buildings.avgLevels >= 3) return 'Mid-Rise Zone';
        if (buildings.totalCount > 50) return 'Dense Low-Rise';
        return 'Low-Density';
    }

    /**
     * Compute building-specific intelligence scores (0-100)
     */
    function computeBuildingScores(buildings, lcz, metrics) {
        const normLog = (val, max) => {
            if (val <= 0) return 0;
            return Math.min(100, Math.round((Math.log(1 + val) / Math.log(1 + max)) * 100));
        };

        return {
            building_density: {
                label: 'Building Density',
                value: normLog(metrics.buildingDensity, 200)
            },
            vertical_development: {
                label: 'Vertical Development',
                value: Math.min(100, metrics.verticalityIndex)
            },
            fsi_intensity: {
                label: 'Floor Space Index',
                value: normLog(metrics.fsi, 4)
            },
            height_diversity: {
                label: 'Height Diversity',
                value: metrics.heightDiversity
            },
            type_mix: {
                label: 'Building Type Mix',
                value: metrics.typeMix
            },
            material_quality: {
                label: 'Material Quality',
                value: computeMaterialQuality(buildings)
            },
            development_potential: {
                label: 'Development Potential',
                value: computeDevPotential(buildings, lcz, metrics)
            },
            redevelopment_index: {
                label: 'Redevelopment Index',
                value: computeRedevelopmentIndex(buildings, metrics)
            },
            urban_compactness: {
                label: 'Urban Compactness',
                value: normLog(metrics.gcr * 100, 60)
            },
            modernization: {
                label: 'Modernization',
                value: metrics.modernizationRatio != null ? metrics.modernizationRatio : 50
            }
        };
    }

    function computeMaterialQuality(buildings) {
        const total = Object.values(buildings.materials).reduce((s, v) => s + v, 0);
        if (total === 0) return 50; // default when no data

        const premium = (buildings.materials['concrete'] || 0) +
                        (buildings.materials['steel'] || 0) +
                        (buildings.materials['glass'] || 0) +
                        (buildings.materials['stone'] || 0);
        const basic = (buildings.materials['brick'] || 0) +
                      (buildings.materials['wood'] || 0);
        const low = (buildings.materials['metal'] || 0) +
                    (buildings.materials['tin'] || 0) +
                    (buildings.materials['mud'] || 0);

        return Math.min(100, Math.round(((premium * 3 + basic * 2 + low * 0.5) / total) * 33));
    }

    function computeDevPotential(buildings, lcz, metrics) {
        let score = 50; // baseline

        // Low density = high potential
        if (metrics.buildingDensity < 20) score += 20;
        else if (metrics.buildingDensity < 50) score += 10;
        else score -= 10;

        // Low FSI = room to build up
        if (metrics.fsi < 0.5) score += 15;
        else if (metrics.fsi < 1) score += 5;
        else score -= 10;

        // LCZ signals
        if (lcz) {
            if (lcz.classId === 9) score += 15;  // Sparsely built
            if ([14, 16].includes(lcz.classId)) score += 20; // Vacant-ish land
            if ([1, 2].includes(lcz.classId)) score -= 20;   // Already dense
        }

        // Low verticality = can go taller
        if (metrics.verticalityIndex < 30) score += 10;

        return Math.max(0, Math.min(100, score));
    }

    function computeRedevelopmentIndex(buildings, metrics) {
        let score = 30; // baseline

        // Old buildings need redevelopment
        if (metrics.modernizationRatio != null && metrics.modernizationRatio < 20) score += 25;
        else if (metrics.modernizationRatio != null && metrics.modernizationRatio < 50) score += 10;

        // High density but low verticality = redevelopment candidate
        if (metrics.buildingDensity > 50 && metrics.verticalityIndex < 30) score += 20;

        // Low material quality
        const lowMat = (buildings.materials['mud'] || 0) + (buildings.materials['tin'] || 0) +
                       (buildings.materials['metal'] || 0);
        const totalMat = Object.values(buildings.materials).reduce((s, v) => s + v, 0);
        if (totalMat > 0 && lowMat / totalMat > 0.3) score += 15;

        return Math.max(0, Math.min(100, score));
    }

    /**
     * Get LCZ TMS URL for MapLibre
     */
    function getLCZURL() {
        return `${LCZ_TMS}/{z}/{x}/{y}.png`;
    }

    function getEmptyBuildingData() {
        return {
            totalCount: 0, withHeight: 0, withLevels: 0, withMaterial: 0, withAge: 0,
            heights: [], levels: [], types: {}, materials: {}, roofShapes: {},
            ageDecades: {}, heightBands: { low: 0, mid: 0, high: 0, vhigh: 0 },
            avgHeight: 0, avgLevels: 0, maxHeight: 0, maxLevels: 0,
            medianHeight: 0, heightStdDev: 0
        };
    }

    /** LCZ class lookup */
    function getLCZClasses() { return LCZ_CLASSES; }

    return {
        fetch, getLCZURL, getLCZClasses, LCZ_CLASSES,
        // Pure scoring internals — exposed for unit testing the real-estate
        // query inputs (these scores get merged into DataFetcher scores).
        computeShannon, computeMetrics, computeBuildingScores,
    };
})();
