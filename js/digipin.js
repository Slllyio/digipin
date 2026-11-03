/**
 * DIGIPIN Encoder and Decoder Library
 * Based on Official India Post / INDIAPOST-gov/digipin GitHub repo
 * 
 * 10-character code; each symbol splits the parent cell 4×4, so a level-L
 * prefix is a 36°/4^L square: L4 ~15.6 km, L5 ~3.9 km, L6 ~978 m,
 * L7 ~245 m, L8 ~61 m, L9 ~15 m, L10 ~3.8 m (see docs/DIGIPIN_LEVELS.md).
 * India bounding box: lat 2.5°–38.5°N, lng 63.5°–99.5°E
 */

const DigiPin = (() => {
    const GRID = [
        ['F', 'C', '9', '8'],
        ['J', '3', '2', '7'],
        ['K', '4', '5', '6'],
        ['L', 'M', 'P', 'T']
    ];

    const BOUNDS = {
        minLat: 2.5,
        maxLat: 38.5,
        minLon: 63.5,
        maxLon: 99.5
    };

    // Build reverse lookup for decoding
    const CHAR_TO_POS = {};
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            CHAR_TO_POS[GRID[r][c]] = { row: r, col: c };
        }
    }

    /**
     * Encode latitude/longitude to a 10-character DigiPin
     * @param {number} lat - Latitude (2.5 to 38.5)
     * @param {number} lon - Longitude (63.5 to 99.5)
     * @returns {string} 10-character DigiPin with dashes (XXX-XXX-XXXX)
     */
    function encode(lat, lon) {
        if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat) {
            throw new Error(`Latitude ${lat} out of range [${BOUNDS.minLat}, ${BOUNDS.maxLat}]`);
        }
        if (lon < BOUNDS.minLon || lon > BOUNDS.maxLon) {
            throw new Error(`Longitude ${lon} out of range [${BOUNDS.minLon}, ${BOUNDS.maxLon}]`);
        }

        let minLat = BOUNDS.minLat, maxLat = BOUNDS.maxLat;
        let minLon = BOUNDS.minLon, maxLon = BOUNDS.maxLon;
        let digiPin = '';

        for (let level = 1; level <= 10; level++) {
            const latDiv = (maxLat - minLat) / 4;
            const lonDiv = (maxLon - minLon) / 4;

            let row = 3 - Math.floor((lat - minLat) / latDiv);
            let col = Math.floor((lon - minLon) / lonDiv);

            row = Math.max(0, Math.min(row, 3));
            col = Math.max(0, Math.min(col, 3));

            digiPin += GRID[row][col];
            if (level === 3 || level === 6) digiPin += '-';

            maxLat = minLat + latDiv * (4 - row);
            minLat = minLat + latDiv * (3 - row);
            minLon = minLon + lonDiv * col;
            maxLon = minLon + lonDiv;
        }

        return digiPin;
    }

    /**
     * Decode a DigiPin to its center coordinates and bounding box
     * @param {string} digiPin - 10-character DigiPin (with or without dashes)
     * @returns {object} { lat, lng, bounds: {south, north, west, east} }
     */
    function decode(digiPin) {
        const pin = digiPin.replace(/-/g, '').toUpperCase();
        if (pin.length !== 10) throw new Error('Invalid DIGIPIN: must be 10 characters');

        let minLat = BOUNDS.minLat, maxLat = BOUNDS.maxLat;
        let minLon = BOUNDS.minLon, maxLon = BOUNDS.maxLon;

        for (let i = 0; i < 10; i++) {
            const ch = pin[i];
            const pos = CHAR_TO_POS[ch];
            if (!pos) throw new Error(`Invalid character '${ch}' in DIGIPIN`);

            const latDiv = (maxLat - minLat) / 4;
            const lonDiv = (maxLon - minLon) / 4;

            const lat1 = maxLat - latDiv * (pos.row + 1);
            const lat2 = maxLat - latDiv * pos.row;
            const lon1 = minLon + lonDiv * pos.col;
            const lon2 = minLon + lonDiv * (pos.col + 1);

            minLat = lat1;
            maxLat = lat2;
            minLon = lon1;
            maxLon = lon2;
        }

        return {
            lat: (minLat + maxLat) / 2,
            lng: (minLon + maxLon) / 2,
            bounds: {
                south: minLat,
                north: maxLat,
                west: minLon,
                east: maxLon
            }
        };
    }

    /**
     * Decode a partial DigiPin (fewer than 10 chars)
     */
    function decodePartial(pin) {
        pin = pin.replace(/-/g, '').toUpperCase();

        let minLat = BOUNDS.minLat, maxLat = BOUNDS.maxLat;
        let minLon = BOUNDS.minLon, maxLon = BOUNDS.maxLon;

        for (let i = 0; i < pin.length; i++) {
            const ch = pin[i];
            const pos = CHAR_TO_POS[ch];
            if (!pos) throw new Error(`Invalid character '${ch}'`);

            const latDiv = (maxLat - minLat) / 4;
            const lonDiv = (maxLon - minLon) / 4;

            minLat = maxLat - latDiv * (pos.row + 1);
            maxLat = maxLat - latDiv * pos.row;
            const newMinLon = minLon + lonDiv * pos.col;
            maxLon = newMinLon + lonDiv;
            minLon = newMinLon;
        }

        return {
            lat: (minLat + maxLat) / 2,
            lng: (minLon + maxLon) / 2,
            bounds: { south: minLat, north: maxLat, west: minLon, east: maxLon }
        };
    }

    /**
     * Format a DigiPin code with standard dashes
     */
    function format(code) {
        const clean = code.replace(/-/g, '');
        if (clean.length <= 3) return clean;
        if (clean.length <= 6) return clean.substring(0, 3) + '-' + clean.substring(3);
        return clean.substring(0, 3) + '-' + clean.substring(3, 6) + '-' + clean.substring(6);
    }

    // ── Hierarchy: levels, parents, children, neighbours ───────────────────
    //
    // DIGIPIN is a strict 4×4 quadtree over the 36°×36° India box, so a level-L
    // cell is one square of a uniform 4^L × 4^L grid. Each cell therefore has
    // an exact integer address (row from the south, col from the west), and
    // every hierarchy operation below is integer maths on that address: no
    // float stepping, so no missed or doubled edge cells.

    const ALPHABET = '23456789CFJKLMPT';
    const MAX_LEVEL = 10;
    const SPAN = BOUNDS.maxLat - BOUNDS.minLat;   // 36°, same for lon
    const M_PER_DEG = 111320;                       // mean metres per degree of latitude

    /** Cell edge in degrees at a level (36 / 4^L, exact in binary floating point). */
    function cellDegrees(level) {
        return SPAN / Math.pow(4, level);
    }

    /**
     * Cell size at a level: { level, deg, mNS, mEW, approxM }. mEW shrinks with
     * cos(lat) (default lat = 22°, central India). approxM is the N–S edge,
     * rounded, which is what docs and legends quote.
     */
    function cellSize(level, lat = 22) {
        const deg = cellDegrees(level);
        const mNS = deg * M_PER_DEG;
        const mEW = mNS * Math.cos(lat * Math.PI / 180);
        const approxM = mNS >= 10000 ? Math.round(mNS / 100) * 100 : mNS >= 10 ? Math.round(mNS) : Math.round(mNS * 10) / 10;
        return { level, deg, mNS, mEW, approxM };
    }

    /** Human label for a level's edge, e.g. "~978 m", "~15.6 km", "~3.8 m". */
    function sizeLabel(level, lat) {
        const m = cellSize(level, lat).mNS;
        if (m >= 1000) return `~${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km`;
        return `~${m >= 100 ? Math.round(m) : m.toFixed(1)} m`;
    }

    /** True when `code` is a well-formed DIGIPIN prefix (1–10 symbols, dashes optional). */
    function isValid(code) {
        if (typeof code !== 'string') return false;
        const c = code.replace(/-/g, '').trim().toUpperCase();
        return c.length >= 1 && c.length <= MAX_LEVEL && [...c].every(ch => ALPHABET.includes(ch));
    }

    /** Dash-less upper-case code; throws on an invalid code. */
    function normalize(code) {
        if (!isValid(code)) throw new Error(`Invalid DIGIPIN '${code}'`);
        return code.replace(/-/g, '').trim().toUpperCase();
    }

    /** The level (number of symbols) of a code. */
    function levelOf(code) {
        return normalize(code).length;
    }

    /** Code → { level, row, col }: integer cell address, row 0 = southernmost. */
    function toIndex(code) {
        const c = normalize(code);
        let row = 0, col = 0;
        for (const ch of c) {
            const pos = CHAR_TO_POS[ch];
            row = row * 4 + (3 - pos.row);
            col = col * 4 + pos.col;
        }
        return { level: c.length, row, col };
    }

    /** Integer address → dash-less code, or null when outside the grid. */
    function fromIndex(level, row, col) {
        const n = Math.pow(4, level);
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= n || col >= n) return null;
        let out = '';
        for (let i = level - 1; i >= 0; i--) {
            const p = Math.pow(4, i);
            const r = Math.floor(row / p) % 4;
            const c = Math.floor(col / p) % 4;
            out += GRID[3 - r][c];
        }
        return out;
    }

    /** Dash-less code of the level-`level` cell containing a point. */
    function encodeLevel(lat, lng, level = MAX_LEVEL) {
        if (!(level >= 1 && level <= MAX_LEVEL)) throw new Error(`Level ${level} out of range [1, ${MAX_LEVEL}]`);
        return encode(lat, lng).replace(/-/g, '').slice(0, level);
    }

    /** Exact bounds + centre of any-level code: { level, lat, lng, bounds }. */
    function cellBounds(code) {
        const { level, row, col } = toIndex(code);
        const d = cellDegrees(level);
        const south = BOUNDS.minLat + row * d, west = BOUNDS.minLon + col * d;
        return {
            level,
            lat: south + d / 2,
            lng: west + d / 2,
            bounds: { south, north: south + d, west, east: west + d },
        };
    }

    /** Ancestor at `level` (default: one level up). null for a level-1 code's parent. */
    function parent(code, level) {
        const c = normalize(code);
        const L = level == null ? c.length - 1 : level;
        if (L < 1 || L > c.length) return null;
        return c.slice(0, L);
    }

    /** Every ancestor from level 1 down to the code itself: ['3', '34', …]. */
    function ancestors(code) {
        const c = normalize(code);
        return [...c].map((_, i) => c.slice(0, i + 1));
    }

    /** The 16 children one level down, in grid order (north-west first). */
    function children(code) {
        const c = normalize(code);
        if (c.length >= MAX_LEVEL) return [];
        const out = [];
        for (const row of GRID) for (const ch of row) out.push(c + ch);
        return out;
    }

    /** All descendants at `level` (≤ 4^(level-L) codes). */
    function descendants(code, level) {
        let out = [normalize(code)];
        if (level > MAX_LEVEL) throw new Error(`Level ${level} out of range`);
        while (out.length && out[0].length < level) out = out.flatMap(children);
        return out;
    }

    const DIRS = {
        n: [1, 0], ne: [1, 1], e: [0, 1], se: [-1, 1],
        s: [-1, 0], sw: [-1, -1], w: [0, -1], nw: [1, -1],
        up: [1, 0], down: [-1, 0], right: [0, 1], left: [0, -1],
    };

    /** Same-level cell one step in a direction (n/ne/e/…/up/down/left/right), or null off-grid. */
    function neighbor(code, dir) {
        const step = DIRS[dir];
        if (!step) return null;
        const { level, row, col } = toIndex(code);
        return fromIndex(level, row + step[0], col + step[1]);
    }

    /** The 8 surrounding cells: { n, ne, e, se, s, sw, w, nw }, null where off-grid. */
    function neighbors(code) {
        const out = {};
        for (const d of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) out[d] = neighbor(code, d);
        return out;
    }

    /** Codes of every cell within `k` steps (Chebyshev ring disk), including the cell. */
    function disk(code, k = 1) {
        const { level, row, col } = toIndex(code);
        const out = [];
        for (let dr = k; dr >= -k; dr--) {
            for (let dc = -k; dc <= k; dc++) {
                const c = fromIndex(level, row + dr, col + dc);
                if (c) out.push(c);
            }
        }
        return out;
    }

    /**
     * Dash-less codes of every level-`level` cell intersecting `bbox`
     * ({south,north,west,east}), north-west first. Returns null when the count
     * would exceed `maxCells`, [] for an empty / out-of-India box.
     */
    function cover(bbox, level, maxCells = Infinity) {
        const n = Math.pow(4, level);
        const d = cellDegrees(level);
        const south = Math.max(bbox.south, BOUNDS.minLat), north = Math.min(bbox.north, BOUNDS.maxLat);
        const west = Math.max(bbox.west, BOUNDS.minLon), east = Math.min(bbox.east, BOUNDS.maxLon);
        if (!(south < north) || !(west < east)) return [];
        const clamp = (v) => Math.max(0, Math.min(n - 1, v));
        const r0 = clamp(Math.floor((south - BOUNDS.minLat) / d));
        const r1 = clamp(Math.ceil((north - BOUNDS.minLat) / d) - 1);
        const c0 = clamp(Math.floor((west - BOUNDS.minLon) / d));
        const c1 = clamp(Math.ceil((east - BOUNDS.minLon) / d) - 1);
        if ((r1 - r0 + 1) * (c1 - c0 + 1) > maxCells) return null;
        const out = [];
        for (let r = r1; r >= r0; r--) for (let c = c0; c <= c1; c++) out.push(fromIndex(level, r, c));
        return out;
    }

    // ── Level of detail ─────────────────────────────────────────────────────
    //
    // A level-L cell is 25.6 · 2^(zoom − 2L) px wide on a web-mercator map at
    // ~22°N (111 320 m/° × 36° ÷ 156 543 m/px at z0, × cos 22°). levelForZoom
    // picks the finest level whose cells are still ≥ ~40 px across, so the grid
    // steps one level per two zoom levels: z13–14 → L6, z15–16 → L7, z17–18 → L8.

    function levelForZoom(zoom, minPx = 40) {
        const L = Math.floor((zoom - Math.log2(minPx / 25.6)) / 2);
        return Math.max(1, Math.min(MAX_LEVEL, L));
    }

    /** A zoom at which `level` is the grid level (inverse of levelForZoom). */
    function zoomForLevel(level) {
        return Math.min(22, 2 * level + 1);
    }

    /**
     * Grid cells for the current view: the level comes from the zoom, and steps
     * coarser until the view needs ≤ maxCells cells. opts: { level, maxCells }.
     * Returns [{ code (dashed), level, bounds, center }].
     */
    function getGridCells(mapBounds, zoom, opts = {}) {
        const maxCells = opts.maxCells || 2500;
        let level = opts.level || levelForZoom(zoom);
        let codes = cover(mapBounds, level, maxCells);
        while (codes === null && level > 1 && !opts.level) codes = cover(mapBounds, --level, maxCells);
        if (!codes) return [];
        return codes.map(c => {
            const b = cellBounds(c);
            return { code: format(c), level, bounds: b.bounds, center: { lat: b.lat, lng: b.lng } };
        });
    }

    return {
        encode, decode, decodePartial, getGridCells, format, BOUNDS,
        ALPHABET, MAX_LEVEL, cellDegrees, cellSize, sizeLabel,
        isValid, normalize, levelOf, toIndex, fromIndex, encodeLevel, cellBounds,
        parent, ancestors, children, descendants, neighbor, neighbors, disk, cover,
        levelForZoom, zoomForLevel,
    };
})();
