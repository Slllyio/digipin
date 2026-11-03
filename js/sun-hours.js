/**
 * SunHours — how many hours of direct sun a spot gets, with the surrounding
 * buildings casting shadows. SunStudy lights the 3D model for one instant;
 * this answers the planner's question for a whole day: "how long is this
 * courtyard / plot / window in sun, and when?"
 *
 * Method: step through the day; at each step take the sun's altitude and
 * bearing (SunStudy.solarPosition), cast a ray from the point toward the sun
 * across the building footprints (flat-top prisms of known height) and call
 * the step shadowed when a footprint is hit closer than the ray's rise allows:
 *   building height > distance-to-footprint × tan(altitude).
 * Footprints are projected to local metres around the point, so no geodesy
 * is needed at city scale. Heights come from the same sources as the 3D
 * model (Overture props, baked Open Buildings grid, floors × 3.2 m).
 *
 * Everything but `analyseHere()` is pure and unit-tested.
 */
const SunHours = (() => {
    const RAD = Math.PI / 180;
    const M_PER_DEG_LAT = 111320;
    const STEP_MIN = 10;
    const MAX_RANGE_M = 800;          // a 170 m tower at 12° altitude shades ~800 m
    const MIN_ALT = 1;                // below this the sun is at the horizon, call it dark

    /** lng/lat ring → local metres east/north of (lat0, lng0). */
    function toLocal(ring, lat0, lng0) {
        const mLng = M_PER_DEG_LAT * Math.cos(lat0 * RAD);
        return ring.map(([lng, lat]) => [(lng - lng0) * mLng, (lat - lat0) * M_PER_DEG_LAT]);
    }

    /**
     * Distance along a ray from the origin (direction ux, uy; unit) to the
     * first footprint edge it enters, or null. Rays that start inside a
     * footprint return 0 (the point is under a roof).
     */
    function rayEntry(ring, ux, uy) {
        let inside = false;
        let best = null;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ax, ay] = ring[j], [bx, by] = ring[i];
            // even-odd test for origin (0,0) using a +x ray
            if ((ay > 0) !== (by > 0) && ((bx - ax) * (0 - ay)) / (by - ay) + ax > 0) inside = !inside;
            // ray ∩ segment: origin + t·u = a + s·(b − a)
            const ex = bx - ax, ey = by - ay;
            const den = ux * ey - uy * ex;
            if (Math.abs(den) < 1e-12) continue;
            const t = (ax * ey - ay * ex) / den;
            const s = (ax * uy - ay * ux) / den;
            if (t > 1e-6 && s >= 0 && s <= 1 && (best === null || t < best)) best = t;
        }
        return inside ? 0 : best;
    }

    /**
     * Is the origin in shadow for a sun at altitude/azimuth (deg)?
     * `buildings` = [{ ring:[[x,y]…] (metres), height }].
     */
    function shadowed(buildings, altitude, azimuth) {
        if (altitude <= MIN_ALT) return true;
        const tanAlt = Math.tan(altitude * RAD);
        const ux = Math.sin(azimuth * RAD), uy = Math.cos(azimuth * RAD);   // bearing from north, clockwise
        for (const b of buildings) {
            const d = rayEntry(b.ring, ux, uy);
            if (d === null || d > MAX_RANGE_M) continue;
            if (b.height > d * tanAlt) return true;
        }
        return false;
    }

    /**
     * Sun timeline for one point and day.
     * `buildings` = [{ polygon: lng/lat outer ring, height }].
     * `solar(lat, lng, date)` → { altitude, azimuth } (SunStudy.solarPosition).
     * `dayStart` = the Date of local solar midnight in UTC.
     * Returns { sunHours, daylightHours, shadedHours, steps:[{ h, sunny, altitude }], windows:[[h0,h1]…] }.
     */
    function analyse(lat, lng, buildings, solar, dayStart, stepMin = STEP_MIN) {
        const near = (buildings || [])
            .filter(b => b && b.polygon && b.polygon.length > 2 && b.height > 0)
            .map(b => ({ ring: toLocal(b.polygon, lat, lng), height: b.height }))
            .filter(b => b.ring.some(([x, y]) => Math.hypot(x, y) <= MAX_RANGE_M * 1.5));
        const steps = [];
        for (let m = 0; m < 24 * 60; m += stepMin) {
            const when = new Date(dayStart.getTime() + (m + stepMin / 2) * 60000);
            const { altitude, azimuth } = solar(lat, lng, when);
            const up = altitude > MIN_ALT;
            steps.push({ h: m / 60, altitude, sunny: up && !shadowed(near, altitude, azimuth), up });
        }
        const stepH = stepMin / 60;
        const sunHours = steps.filter(s => s.sunny).length * stepH;
        const daylightHours = steps.filter(s => s.up).length * stepH;
        const windows = [];
        let open = null;
        steps.forEach(s => {
            if (s.sunny && open === null) open = s.h;
            if (!s.sunny && open !== null) { windows.push([open, s.h]); open = null; }
        });
        if (open !== null) windows.push([open, 24]);
        return {
            sunHours: round1(sunHours), daylightHours: round1(daylightHours),
            shadedHours: round1(daylightHours - sunHours), steps, windows,
        };
    }

    function round1(x) { return Math.round(x * 10) / 10; }

    /** Human line: "5.5 h of 11.0 h daylight · sun 07:10–12:20, 14:00–16:30". */
    function summary(r, fmt) {
        const f = fmt || ((h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`);
        if (!r.daylightHours) return 'No daylight on this date at this location.';
        const w = r.windows.map(([a, b]) => `${f(a)}–${f(b)}`).join(', ');
        return `${r.sunHours.toFixed(1)} h direct sun of ${r.daylightHours.toFixed(1)} h daylight` + (w ? ` · sun ${w}` : ' · fully shaded');
    }

    /** Verdict band used for colouring: ≥6 h sunny, 2–6 partial, <2 shaded. */
    function band(sunHours) {
        return sunHours >= 6 ? 'sunny' : sunHours >= 2 ? 'partial' : 'shaded';
    }

    // ── Live app ──────────────────────────────────────────────────

    /** Visible footprints with heights → [{ polygon, height }] using FootprintExport. */
    function _liveBuildings(map) {
        if (typeof FootprintExport === 'undefined') return [];
        return FootprintExport.collect(map)
            .filter(f => f.geometry && f.geometry.type === 'Polygon' && f.height > 0)
            .map(f => ({ polygon: f.geometry.coordinates[0], height: f.height }));
    }

    /**
     * Analyse the map centre (or {lat,lng}) for a date string YYYY-MM-DD.
     * Returns null when SunStudy or the map are not available.
     */
    function analyseHere(dateStr, point) {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (!map || typeof SunStudy === 'undefined') return null;
        const c = point || map.getCenter();
        const [Y, Mo, D] = String(dateStr).split('-').map(Number);
        const tzH = c.lng / 15;                              // same solar-time convention as SunStudy
        const dayStart = new Date(Date.UTC(Y, Mo - 1, D) - tzH * 3600000);
        const result = analyse(c.lat, c.lng, _liveBuildings(map), SunStudy.solarPosition, dayStart);
        result.buildingCount = _liveBuildings(map).length;
        return result;
    }

    return { toLocal, rayEntry, shadowed, analyse, summary, band, analyseHere };
})();

if (typeof window !== 'undefined') {
    window.SunHours = SunHours;
}
