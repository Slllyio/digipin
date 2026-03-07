/**
 * Ward Boundary Overlay — Fetches administrative boundaries from Overpass
 */
const WardOverlay = (() => {
    let _layer = null;
    let _loading = false;
    const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

    /**
     * Fetch and display ward boundaries for the current map view
     */
    async function show() {
        if (_loading) return;
        clear();
        _loading = true;

        const map = MapModule.getMap();
        const bounds = map.getBounds();
        const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

        // Query admin boundaries (level 9 = ward, level 8 = sub-district)
        const query = `[out:json][timeout:15];
(
  relation["boundary"="administrative"]["admin_level"~"^(8|9|10)$"](${bbox});
);
out geom;`;

        App.showToast('Loading Wards', 'Fetching administrative boundaries...', 'info');

        try {
            const resp = await fetch(OVERPASS_URL, {
                method: 'POST',
                body: `data=${encodeURIComponent(query)}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            if (!resp.ok) throw new Error(`Overpass returned ${resp.status}`);

            const data = await resp.json();
            _layer = L.layerGroup().addTo(map);

            let count = 0;
            (data.elements || []).forEach(el => {
                if (!el.members) return;

                // Build polygon from outer ways
                const outerWays = el.members
                    .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === ''))
                    .filter(m => m.geometry);

                outerWays.forEach(way => {
                    const coords = way.geometry.map(pt => [pt.lat, pt.lon]);
                    if (coords.length < 3) return;

                    const name = el.tags?.name || el.tags?.['name:en'] || `Ward ${el.id}`;
                    L.polygon(coords, {
                        color: '#a855f7',
                        fillColor: '#a855f7',
                        fillOpacity: 0.05,
                        weight: 2,
                        dashArray: '4 3'
                    }).bindPopup(createPopup(name, el.tags)).addTo(_layer);
                    count++;
                });
            });

            App.showToast('Wards Loaded', `${count} boundary segments displayed`, 'success');
        } catch (err) {
            App.showToast('Ward Fetch Failed', err.message, 'error');
        } finally {
            _loading = false;
        }
    }

    function createPopup(name, tags) {
        const div = document.createElement('div');
        div.style.fontFamily = 'Inter, sans-serif';
        const title = document.createElement('strong');
        title.textContent = name;
        div.appendChild(title);
        if (tags?.['admin_level']) {
            div.appendChild(document.createElement('br'));
            const level = document.createElement('span');
            level.textContent = `Admin Level: ${tags['admin_level']}`;
            level.style.fontSize = '11px';
            div.appendChild(level);
        }
        return div;
    }

    function clear() {
        if (_layer) {
            MapModule.getMap().removeLayer(_layer);
            _layer = null;
        }
    }

    function isVisible() { return !!_layer; }

    return { show, clear, isVisible };
})();
