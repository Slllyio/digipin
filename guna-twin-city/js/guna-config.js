/**
 * Guna City Configuration Override
 * Loaded BEFORE map.js to set city-specific defaults.
 * Patches the MapModule init to center on Guna instead of Indore.
 */
const GUNA_CONFIG = {
    city: 'guna',
    name: 'Guna',
    state: 'Madhya Pradesh',
    lat: 24.6354,
    lng: 77.3126,
    zoom: 13,
};

// Feed the data-driven flood Curve Number (analysis/output/flood_cn_guna.json)
// into the rainfall->inundation what-if slider, and label rainfall as a 12-hour
// event. Both are read by js/flood-animation.js when present.
if (typeof window !== 'undefined') {
    window.DIGIPIN_FLOOD_RAIN_UNIT = 'mm/12h';
    window.DIGIPIN_FLOOD_3D = true;               // pitch + 3D buildings when inundation shown
    window.DIGIPIN_FLOOD_WATER_COLOR = '#2e8bff'; // render inundation as blue water
    window.DIGIPIN_FLOOD_HALF_LAT = 0.018;        // ~4 km flood coverage (roam the core)
    window.DIGIPIN_FLOOD_GRID = 20;               // elevation grid 20x20 = 400 pts (4 batches, throttled)
    fetch('analysis/output/flood_cn_guna.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j && j.weighted_cn) window.DIGIPIN_FLOOD_CN = j.weighted_cn.amc_ii; })
        .catch(() => {});
}
