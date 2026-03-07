/**
 * DIGIPIN Encoder and Decoder Library
 * Based on Official India Post / INDIAPOST-gov/digipin GitHub repo
 * 
 * 10-character alphanumeric code for ~4x4m grid cells
 * Uses 16-symbol alphabet in a 4x4 grid pattern
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
     * Get grid cells visible at a given zoom level within map bounds
     * Returns DigiPin codes at an appropriate resolution level
     * @param {object} mapBounds - { south, north, west, east }
     * @param {number} zoom - Map zoom level
     * @returns {Array} Array of { code, bounds }
     */
    function getGridCells(mapBounds, zoom) {
        // Determine how many characters of DigiPin to use based on zoom
        let level;
        if (zoom >= 18) level = 8;
        else if (zoom >= 16) level = 7;
        else if (zoom >= 14) level = 6;
        else if (zoom >= 12) level = 5;
        else if (zoom >= 10) level = 4;
        else if (zoom >= 8) level = 3;
        else return []; // too zoomed out

        const cells = [];
        const seen = new Set();
        const latStep = (BOUNDS.maxLat - BOUNDS.minLat) / Math.pow(4, level);
        const lonStep = (BOUNDS.maxLon - BOUNDS.minLon) / Math.pow(4, level);

        // Clamp to India bounds
        const south = Math.max(mapBounds.south, BOUNDS.minLat);
        const north = Math.min(mapBounds.north, BOUNDS.maxLat);
        const west = Math.max(mapBounds.west, BOUNDS.minLon);
        const east = Math.min(mapBounds.east, BOUNDS.maxLon);

        if (south >= north || west >= east) return [];

        // Limit maximum cells to prevent performance issues
        const maxCells = 500;
        const latCells = Math.ceil((north - south) / latStep);
        const lonCells = Math.ceil((east - west) / lonStep);

        if (latCells * lonCells > maxCells) return [];

        for (let lat = south + latStep / 2; lat < north; lat += latStep) {
            for (let lon = west + lonStep / 2; lon < east; lon += lonStep) {
                try {
                    const fullCode = encode(lat, lon);
                    const code = fullCode.replace(/-/g, '').substring(0, level);

                    // Format with dashes
                    let formatted = code;
                    if (code.length >= 3) formatted = code.substring(0, 3) + '-' + code.substring(3);
                    if (code.length >= 6) formatted = code.substring(0, 3) + '-' + code.substring(3, 6) + '-' + code.substring(6);

                    // Avoid duplicates
                    if (!seen.has(formatted)) {
                        seen.add(formatted);
                        const decoded = decodePartial(code);
                        cells.push({
                            code: formatted,
                            fullCode: fullCode,
                            bounds: decoded.bounds,
                            center: { lat: decoded.lat, lng: decoded.lng }
                        });
                    }
                } catch (e) {
                    // Skip out-of-bounds cells
                }
            }
        }

        return cells;
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

    return { encode, decode, decodePartial, getGridCells, format, BOUNDS };
})();
