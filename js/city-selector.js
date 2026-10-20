/**
 * Multi-City Support — City selector with pre-configured centers
 */
const CitySelector = (() => {
    const CITIES = [
        { id: 'indore', name: 'Indore', lat: 22.7196, lng: 75.8577, zoom: 13, state: 'MP' },
        { id: 'guna', name: 'Guna', lat: 24.6354, lng: 77.3126, zoom: 13, state: 'MP' },
        { id: 'bhopal', name: 'Bhopal', lat: 23.2599, lng: 77.4126, zoom: 13, state: 'MP' },
        { id: 'pune', name: 'Pune', lat: 18.5204, lng: 73.8567, zoom: 13, state: 'MH' },
        { id: 'jaipur', name: 'Jaipur', lat: 26.9124, lng: 75.7873, zoom: 13, state: 'RJ' },
        { id: 'ahmedabad', name: 'Ahmedabad', lat: 23.0225, lng: 72.5714, zoom: 13, state: 'GJ' },
        { id: 'lucknow', name: 'Lucknow', lat: 26.8467, lng: 80.9462, zoom: 13, state: 'UP' },
        { id: 'chennai', name: 'Chennai', lat: 13.0827, lng: 80.2707, zoom: 13, state: 'TN' },
        { id: 'bengaluru', name: 'Bengaluru', lat: 12.9716, lng: 77.5946, zoom: 13, state: 'KA' },
        { id: 'hyderabad', name: 'Hyderabad', lat: 17.3850, lng: 78.4867, zoom: 13, state: 'TS' },
        { id: 'mumbai', name: 'Mumbai', lat: 19.0760, lng: 72.8777, zoom: 13, state: 'MH' },
        { id: 'delhi', name: 'New Delhi', lat: 28.6139, lng: 77.2090, zoom: 13, state: 'DL' },
        { id: 'kolkata', name: 'Kolkata', lat: 22.5726, lng: 88.3639, zoom: 13, state: 'WB' },
    ];

    // City id -> precomputed-score region name (data/scores/<region>/), where
    // they differ. Every other city's region name is its id.
    const REGION_ALIASES = { indore: 'indore_pilot' };

    let _current = CITIES[0];
    let _scored = new Set();   // city ids with a precomputed score tile

    function regionName(city) { return REGION_ALIASES[city.id] || city.id; }

    function _label(city) {
        // Cities with a precomputed tile render scores instantly; the rest are
        // basemap + live per-click fetches only.
        return _scored.has(city.id)
            ? `${city.name}, ${city.state} · scored`
            : `${city.name}, ${city.state}`;
    }

    /** Re-read precomputed coverage and relabel the options. Safe to call
     *  repeatedly (coverage.json loads async after init). */
    function refreshCoverage() {
        const regions = (typeof PrecomputedScores !== 'undefined' && PrecomputedScores.getRegions)
            ? PrecomputedScores.getRegions() : [];
        const names = new Set(regions.map(r => r.name));
        _scored = new Set(CITIES.filter(c => names.has(regionName(c))).map(c => c.id));
        const select = document.getElementById('city-select');
        if (!select) return;
        for (const opt of select.options) {
            const city = CITIES.find(c => c.id === opt.value);
            if (city) opt.textContent = _label(city);
        }
    }

    function init() {
        const select = document.getElementById('city-select');
        if (!select) return;

        CITIES.forEach(city => {
            const opt = document.createElement('option');
            opt.value = city.id;
            opt.textContent = _label(city);
            if (city.id === _current.id) opt.selected = true;
            select.appendChild(opt);
        });

        select.addEventListener('change', () => {
            const city = CITIES.find(c => c.id === select.value);
            if (city) {
                _current = city;
                MapModule.flyTo(city.lat, city.lng, city.zoom);
                App.showToast('City Changed', _scored.has(city.id)
                    ? `Now viewing ${city.name}, ${city.state} \u2022 precomputed scores available`
                    : `Now viewing ${city.name}, ${city.state}`, 'info');
            }
        });
        refreshCoverage();
    }

    function getCurrent() { return _current; }
    function getCities() { return CITIES; }

    return { init, getCurrent, getCities, refreshCoverage, regionName };
})();
