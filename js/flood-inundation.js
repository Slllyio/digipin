/**
 * FloodInundation — animated flood-extent polygon on the MapLibre map.
 *
 * Honest scope: this is a *demo-grade* visualization, not a survey
 * flood map. We don't have a full DEM offline. The amoeba shape is
 * physics-motivated (low-lying directions flood first) but the depth
 * model is a simple linear function of discharge ratio.
 *
 * How it works (per cell click):
 *   1. Probe 16 elevation samples in a ~600m ring around the cell
 *      via one Open-Elevation batch POST. Plus the cell centre = 17.
 *   2. For each of the 7 forecast days, compute a flood-depth proxy
 *        depth_m = max(0, (discharge_ratio - 1) × 2.5)
 *      Then deform the ring: directions where elevation is well above
 *      the threshold get pulled toward the centre; directions below
 *      keep their full reach. Result: amoeba shape bulging toward
 *      low-lying terrain.
 *   3. Render as a MapLibre fill+outline layer, color by the day's
 *      risk band (green/amber/orange/red/dark-red).
 *   4. Animate by swapping source data every 350 ms; ~2.5 s per loop,
 *      loops forever until the cell is closed or another cell is
 *      selected.
 *
 * Cleanup: detach() removes both source and layer cleanly. Idempotent.
 */

const FloodInundation = (() => {
    const SOURCE_ID = 'flood-inundation-src';
    const FILL_ID   = 'flood-inundation-fill';
    const LINE_ID   = 'flood-inundation-line';
    const RING_RADIUS_KM = 0.6;
    const RING_POINTS = 16;
    const DEPTH_PER_RATIO = 2.5;         // metres of effective rise per unit ratio above baseline
    const FRAME_MS = 350;
    const PULLBACK_FALLOFF_M = 3.0;      // ring is fully retracted if elevation is 3m+ above threshold

    let _animTimer = null;
    let _attachedCellCode = null;

    async function _fetchElevationRing(lat, lng) {
        const points = [];
        for (let i = 0; i < RING_POINTS; i++) {
            const bearing = (2 * Math.PI * i) / RING_POINTS;
            const dLat = (RING_RADIUS_KM / 111.0) * Math.cos(bearing);
            const dLng = (RING_RADIUS_KM / (111.0 * Math.cos(lat * Math.PI / 180))) * Math.sin(bearing);
            points.push({ latitude: lat + dLat, longitude: lng + dLng });
        }
        points.push({ latitude: lat, longitude: lng });

        const resp = await fetch('https://api.open-elevation.com/api/v1/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations: points }),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const elevations = (data.results || []).map(r => r.elevation);
        if (elevations.length < RING_POINTS + 1) return null;
        return {
            ring: elevations.slice(0, RING_POINTS),
            centerElev: elevations[RING_POINTS],
            ringPoints: points.slice(0, RING_POINTS),
            center: points[RING_POINTS],
        };
    }

    function _polygonForDay(geo, centerElev, depthM, dayColor) {
        const threshold = centerElev + depthM;
        const coords = geo.ringPoints.map((p, i) => {
            const elev = geo.ring[i];
            const aboveBy = Math.max(0, elev - threshold);
            const pullback = Math.min(1, aboveBy / PULLBACK_FALLOFF_M);
            const reach = 1 - pullback;
            return [
                geo.center.longitude + (p.longitude - geo.center.longitude) * reach,
                geo.center.latitude  + (p.latitude  - geo.center.latitude)  * reach,
            ];
        });
        coords.push(coords[0]);
        return {
            type: 'Feature',
            properties: { color: dayColor },
            geometry: { type: 'Polygon', coordinates: [coords] },
        };
    }

    function _buildFrames(forecast, geo) {
        return forecast.days.map(day => {
            const ratio = day.discharge / forecast.baseline_m3s;
            const depth = Math.max(0, (ratio - 1) * DEPTH_PER_RATIO);
            return {
                date: day.date,
                ratio,
                depth,
                feature: _polygonForDay(geo, geo.centerElev, depth, day.risk_color),
            };
        });
    }

    function _ensureLayers(map) {
        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
        }
        if (!map.getLayer(FILL_ID)) {
            map.addLayer({
                id: FILL_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: {
                    'fill-color': ['get', 'color'],
                    'fill-opacity': 0.35,
                    'fill-opacity-transition': { duration: 200 },
                },
            });
        }
        if (!map.getLayer(LINE_ID)) {
            map.addLayer({
                id: LINE_ID,
                type: 'line',
                source: SOURCE_ID,
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': 1.6,
                    'line-opacity': 0.85,
                },
            });
        }
    }

    function _setFrame(map, feature) {
        const src = map.getSource(SOURCE_ID);
        if (!src) return;
        src.setData({ type: 'FeatureCollection', features: feature ? [feature] : [] });
    }

    /** Run the animation for a given cell + forecast. Returns a stop fn. */
    async function attach(cell, forecast) {
        if (!cell || !forecast || !forecast.days?.length) return;
        if (typeof MapModule === 'undefined') return;
        const map = MapModule.getMap();
        if (!map) return;

        detach();
        _attachedCellCode = cell.code;

        const geo = await _fetchElevationRing(cell.center.lat, cell.center.lng);
        if (!geo) return;
        // Another cell may have been selected while we were fetching.
        if (_attachedCellCode !== cell.code) return;

        const frames = _buildFrames(forecast, geo);
        _ensureLayers(map);

        let idx = 0;
        _setFrame(map, frames[0].feature);
        _animTimer = setInterval(() => {
            idx = (idx + 1) % frames.length;
            _setFrame(map, frames[idx].feature);
        }, FRAME_MS);
    }

    function detach() {
        if (_animTimer) {
            clearInterval(_animTimer);
            _animTimer = null;
        }
        _attachedCellCode = null;
        if (typeof MapModule !== 'undefined') {
            const map = MapModule.getMap();
            if (map) {
                if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
                if (map.getLayer(FILL_ID)) map.removeLayer(FILL_ID);
                if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
            }
        }
    }

    return { attach, detach };
})();

if (typeof window !== 'undefined') {
    window.FloodInundation = FloodInundation;
}
