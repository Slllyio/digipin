/**
 * CameraPresets — named 3D camera shots per city: Overview, Bird's eye and
 * Street, the last two framed on each city's best-known centre (Rajwada,
 * Connaught Place, Charminar, …).
 *
 * A small pill bar sits at the bottom of the map while 3D is on. Picking a
 * shot turns 3D on if needed and flies there; like the city overview's
 * fly-in, it waits for the terrain DEM first so the camera doesn't end up
 * under raised ground. presetsFor() is pure (unit-tested).
 */
const CameraPresets = (() => {
    // Landmark per city: the frame for Bird's eye and Street.
    const LANDMARKS = {
        indore: { name: 'Rajwada', lng: 75.8553, lat: 22.7186 },
        guna: { name: 'Guna centre', lng: 77.3126, lat: 24.6354 },
        bhopal: { name: 'New Market', lng: 77.4006, lat: 23.2337 },
        pune: { name: 'Shaniwar Wada', lng: 73.8553, lat: 18.5195 },
        jaipur: { name: 'Hawa Mahal', lng: 75.8267, lat: 26.9239 },
        ahmedabad: { name: 'Bhadra Fort', lng: 72.5806, lat: 23.0240 },
        lucknow: { name: 'Hazratganj', lng: 80.9466, lat: 26.8505 },
        chennai: { name: 'T. Nagar', lng: 80.2341, lat: 13.0418 },
        bengaluru: { name: 'MG Road', lng: 77.6050, lat: 12.9756 },
        hyderabad: { name: 'Charminar', lng: 78.4747, lat: 17.3616 },
        mumbai: { name: 'Nariman Point', lng: 72.8242, lat: 18.9256 },
        delhi: { name: 'Connaught Place', lng: 77.2167, lat: 28.6315 },
        kolkata: { name: 'BBD Bagh', lng: 88.3502, lat: 22.5697 },
    };

    const ICONS = {
        overview: '<path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/>',
        bird: '<path d="M2 12c3-4 7-4 10 0 3-4 7-4 10 0"/><path d="M12 12v6"/>',
        street: '<path d="M8 21l2-18M16 21l-2-18"/><path d="M12 6v2M12 11v2M12 16v2"/>',
    };

    /** The three shots for a city (falls back to its centre when no landmark is listed). Pure. */
    function presetsFor(city, maxPitch = 70) {
        if (!city) return [];
        const lm = LANDMARKS[city.id] || { name: city.name, lng: city.lng, lat: city.lat };
        return [
            { id: 'overview', label: 'Overview', detail: city.name, camera: { center: [city.lng, city.lat], zoom: 13.3, pitch: 48, bearing: -17 } },
            { id: 'bird', label: 'Bird’s eye', detail: lm.name, camera: { center: [lm.lng, lm.lat], zoom: 16.2, pitch: Math.min(62, maxPitch), bearing: -32 } },
            { id: 'street', label: 'Street', detail: lm.name, camera: { center: [lm.lng, lm.lat], zoom: 17.9, pitch: Math.min(70, maxPitch), bearing: 24 } },
        ];
    }

    let _bar = null;

    function _icon(id) {
        return `<svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id] || ''}</svg>`;
    }

    function _maxPitch() {
        return (typeof UIPolish !== 'undefined' && UIPolish.MAX_PITCH) || 70;
    }

    /** Fly to a named shot for the current city, turning 3D on first if needed. */
    function go(id) {
        const map = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        const city = typeof CitySelector !== 'undefined' ? CitySelector.getCurrent() : null;
        const p = presetsFor(city, _maxPitch()).find(x => x.id === id);
        if (!map || !p) return false;
        const btn3d = document.getElementById('btn-3d');
        const wasOn = !btn3d || btn3d.classList.contains('active');
        if (!wasOn) btn3d.click();
        const reduce = typeof UIPolish !== 'undefined' && UIPolish.prefersReducedMotion && UIPolish.prefersReducedMotion();
        const fly = () => (reduce ? map.jumpTo(p.camera) : map.flyTo({ ...p.camera, duration: 2600, curve: 1.4, essential: false }));
        if (!wasOn && map.getTerrain && map.getTerrain()) {
            let done = false;
            const once = () => { if (!done) { done = true; fly(); } };
            map.once('idle', once);
            setTimeout(once, 1500);
        } else fly();
        _mark(id);
        return true;
    }

    function _mark(id) {
        if (!_bar) return;
        _bar.querySelectorAll('.cp-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === id)));
    }

    function _render() {
        if (!_bar) return;
        const city = typeof CitySelector !== 'undefined' ? CitySelector.getCurrent() : null;
        _bar.innerHTML = presetsFor(city, _maxPitch()).map(p =>
            `<button type="button" class="cp-btn" data-preset="${p.id}" aria-pressed="false" aria-label="${p.label}: ${p.detail}" title="${p.label}: ${p.detail}">`
            + `${_icon(p.id)}<span class="cp-label">${p.label}</span><span class="cp-detail">${p.detail}</span></button>`).join('');
    }

    function _sync() {
        if (!_bar) return;
        const btn3d = document.getElementById('btn-3d');
        _bar.hidden = !(btn3d && btn3d.classList.contains('active'));
    }

    function init() {
        if (typeof document === 'undefined' || _bar) return;
        _bar = document.createElement('div');
        _bar.id = 'camera-presets';
        _bar.setAttribute('role', 'toolbar');
        _bar.setAttribute('aria-label', '3D camera shots');
        _bar.hidden = true;
        document.body.appendChild(_bar);
        _render();
        _bar.addEventListener('click', (e) => {
            const b = e.target.closest('.cp-btn');
            if (b) go(b.dataset.preset);
        });
        if (typeof CitySelector !== 'undefined' && CitySelector.onChange) CitySelector.onChange(() => { _render(); _sync(); });
        const btn3d = document.getElementById('btn-3d');
        if (btn3d && typeof MutationObserver !== 'undefined') {
            new MutationObserver(_sync).observe(btn3d, { attributes: true, attributeFilter: ['class'] });
        }
        // Manual camera moves clear the "current shot" mark.
        const map = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        if (map) map.on('dragstart', () => _mark(null));
        _sync();
    }

    return { init, go, presetsFor, LANDMARKS };
})();

if (typeof window !== 'undefined') {
    window.CameraPresets = CameraPresets;
}
