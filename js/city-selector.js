/**
 * Multi-City Support — City selector with pre-configured centers
 */
const CitySelector = (() => {
    const CITIES = [
        { id: 'indore', name: 'Indore', lat: 22.7196, lng: 75.8577, zoom: 13, state: 'MP' },
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

    let _current = CITIES[0];

    function init() {
        const select = document.getElementById('city-select');
        if (!select) return;

        CITIES.forEach(city => {
            const opt = document.createElement('option');
            opt.value = city.id;
            opt.textContent = `${city.name}, ${city.state}`;
            if (city.id === _current.id) opt.selected = true;
            select.appendChild(opt);
        });

        select.addEventListener('change', () => {
            const city = CITIES.find(c => c.id === select.value);
            if (city) {
                _current = city;
                MapModule.flyTo(city.lat, city.lng, city.zoom);
                App.showToast('City Changed', `Now viewing ${city.name}, ${city.state}`, 'info');
            }
        });
    }

    function getCurrent() { return _current; }
    function getCities() { return CITIES; }

    return { init, getCurrent, getCities };
})();
