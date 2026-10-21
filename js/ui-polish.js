/**
 * UIPolish — the visual-finish layer over the app chrome.
 *
 *  - Icons: swaps the mixed emoji glyphs in the top bar, toolbar and sidebar
 *    for one coherent stroke-icon set (inline SVG, currentColor, so both
 *    themes and hover/active states colour them from CSS). Labels, titles and
 *    i18n attributes are untouched; only the .tb-icon / button glyph changes.
 *  - Atmosphere: a theme-tuned sky + distance fog (MapLibre 5 setSky) so a
 *    tilted 3D city recedes into a horizon instead of a hard tile edge.
 *    Without setSky (older MapLibre) a CSS horizon haze stands in, its
 *    opacity driven by hazeOpacity(pitch). The paper-light basemap's
 *    building fill is also lifted a shade so dense cores read airy.
 *  - Loading: a branded splash that lifts once the map style has loaded.
 *  - Reduced motion: exposes prefersReducedMotion() for camera code.
 *
 * No data of its own; safe to load last. Every DOM step is guarded so a
 * missing element (other app shells, tests) is a no-op.
 */
const UIPolish = (() => {
    // 24×24 stroke paths (Lucide-style geometry, drawn for this app).
    const PATHS = {
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
        moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
        camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
        present: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/>',
        layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
        compare: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/>',
        star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z"/>',
        folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
        clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
        heatmap: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
        wards: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6z"/><path d="M9 3v15M15 6v15"/>',
        city: '<path d="M3 21h18M5 21V9l5-3v15M10 21V4l6 3v14M16 21v-8l3 2v6"/>',
        building: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
        cube: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
        mountain: '<path d="m3 20 6-11 4 6 3-4 5 9H3z"/>',
        ruler: '<path d="M3 17 17 3l4 4L7 21l-4-4z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
        pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
        globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
        road: '<path d="M8 3 4 21M16 3l4 18M12 4v3M12 11v3M12 18v2"/>',
        trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
        sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
        send: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
        traffic: '<rect x="8" y="2" width="8" height="20" rx="3"/><circle cx="12" cy="7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="17" r="1.5"/>',
        shield: '<path d="M12 3 5 6v6c0 4.4 3 7.9 7 9 4-1.1 7-4.6 7-9V6l-7-3z"/>',
        siren: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 21h14v-3H5zM12 3v2M4.2 6.2l1.4 1.4M19.8 6.2l-1.4 1.4"/>',
        thermo: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
        leaf: '<path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15z"/><path d="M5 19 13 11"/>',
        palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 21a3 3 0 0 1 0-6h2"/>',
        eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
        flame: '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8a7 7 0 0 0 7 7z"/>',
        walk: '<circle cx="13" cy="4" r="2"/><path d="m9 21 3-7 3 3v4M7 12l3-4 4 1 3 3M12 14l-1-5"/>',
        grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
        area: '<path d="M4 4h4M12 4h2M18 4h2v2M20 10v2M20 16v4h-2M12 20h2M4 20h2M4 14v-2M4 6v2" />',
        brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
        chevronLeft: '<path d="m15 6-6 6 6 6"/>',
        chevronRight: '<path d="m9 6 6 6-6 6"/>',
        play: '<path d="M7 4v16l13-8L7 4z"/>',
        close: '<path d="M6 6l12 12M18 6 6 18"/>',
        radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12 18.5 5.5"/><circle cx="12" cy="12" r="1"/>',
        droplet: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    };

    // toolbar button id → icon key
    const TOOLBAR = {
        'btn-heatmap': 'heatmap', 'btn-wards': 'wards', 'btn-lcz': 'city',
        'btn-buildings': 'building', 'btn-3d': 'cube', 'btn-terrain': 'mountain',
        'btn-sun': 'sun', 'btn-pitch': 'camera', 'btn-measure': 'ruler',
        'btn-present': 'present', 'btn-annotate': 'pin', 'btn-lulc': 'globe',
        'btn-roads': 'road', 'btn-dt-layers': 'layers', 'btn-compare': 'compare',
        'btn-bookmarks': 'star', 'btn-saved-views': 'folder', 'btn-analyses': 'clipboard',
        'btn-growth': 'trend', 'btn-ca-growth': 'sparkle', 'btn-scenario': 'target',
        'btn-traffic': 'traffic', 'btn-mobility': 'shield', 'btn-emergency': 'siren',
        'btn-heat': 'thermo', 'btn-ndvi': 'leaf', 'btn-bivariate': 'palette',
        'btn-viewshed': 'eye', 'btn-kde': 'flame', 'btn-access': 'walk',
        'btn-choropleth': 'grid', 'btn-area': 'area',
        'btn-insights': 'radar', 'btn-hydrology': 'droplet', 'btn-agents': 'sparkle',
    };

    /** Inline SVG markup for an icon key ('' for unknown keys). */
    function icon(name, size = 18) {
        const p = PATHS[name];
        if (!p) return '';
        return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
            + 'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" '
            + `aria-hidden="true" focusable="false">${p}</svg>`;
    }

    /**
     * Horizon-haze opacity for a camera pitch (degrees). Flat maps get none;
     * it ramps in from 35° and saturates at 70° (the sky shows past ~60°).
     */
    function hazeOpacity(pitch) {
        const p = Number(pitch);
        if (!Number.isFinite(p) || p <= 35) return 0;
        return Math.min(1, (p - 35) / 35);
    }

    // MapLibre caps pitch at 60° by default; 75° lets the cinematic camera
    // reach the horizon (the haze then stands in for a sky).
    const MAX_PITCH = 75;

    function prefersReducedMotion() {
        try {
            return typeof window !== 'undefined' && !!window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch { return false; }
    }

    function _setIcon(el, name) {
        if (!el || !PATHS[name]) return;
        el.innerHTML = icon(name);
        el.classList.add('has-ui-icon');
    }

    function applyIcons(doc = (typeof document !== 'undefined' ? document : null)) {
        if (!doc) return 0;
        let n = 0;
        for (const [id, name] of Object.entries(TOOLBAR)) {
            const ic = doc.querySelector(`#${id} .tb-icon`);
            if (ic) { _setIcon(ic, name); n++; }
        }
        _setIcon(doc.getElementById('search-btn'), 'search');
        _setIcon(doc.getElementById('share-btn'), 'link');
        const theme = doc.getElementById('theme-toggle-btn');
        if (theme) {
            const light = doc.documentElement.getAttribute('data-theme') === 'light';
            _setIcon(theme, light ? 'moon' : 'sun');
        }
        // Sidebar collapse arrow: app.js swaps its textContent on click, so
        // re-draw ours after each toggle.
        const tog = doc.getElementById('sidebar-toggle');
        // Phones open with the query sheet folded into its corner button.
        const side = doc.getElementById('sidebar');
        if (tog && side && typeof window !== 'undefined' && window.matchMedia
            && window.matchMedia('(max-width: 768px)').matches && !side.classList.contains('collapsed')) {
            side.classList.add('collapsed');
            tog.setAttribute('aria-expanded', 'false');
        }
        if (tog) {
            const draw = () => {
                const collapsed = doc.getElementById('sidebar')?.classList.contains('collapsed');
                _setIcon(tog, collapsed ? 'chevronRight' : 'chevronLeft');
            };
            draw();
            tog.addEventListener('click', () => setTimeout(draw, 0));
        }
        const title = doc.querySelector('#sidebar .sidebar-title');
        if (title && !title.querySelector('.ui-icon')) {
            title.textContent = title.textContent.replace(/^\s*\S+\s+/u, '');
            title.insertAdjacentHTML('afterbegin', icon('sparkle', 16));
        }
        return n;
    }

    // ── Atmosphere ──────────────────────────────────────────────────────────
    const SKY = {
        dark: {
            'sky-color': '#050c22', 'horizon-color': '#1d3b6b', 'fog-color': '#0a1430',
            'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.55,
            'atmosphere-blend': 0,
        },
        light: {
            // Aino: the city fades into warm paper at the horizon, no blue sky.
            'sky-color': '#efeeea', 'horizon-color': '#f5f4f2', 'fog-color': '#f3f3f1',
            'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.75, 'fog-ground-blend': 0.6,
            'atmosphere-blend': 0,
        },
    };
    // Positron's building fills (#dfdfdf / #ededed) turn a dense Indian core
    // into a grey slab; one shade lighter keeps the paper look.
    const LIGHT_BASEMAP = { building: '#e9ebee', 'building-top': '#f3f4f6' };
    // Aino's map palette: warm paper ground, sage parks, blue-grey water and
    // white streets. Matched by Positron layer id, so a missing layer is a no-op.
    const AINO_PAINT = [
        [/^background$/, 'background-color', '#f3f3f1'],
        [/^(landcover|park)/, 'fill-color', '#dfe8d6'],
        [/^landuse$/, 'fill-color', '#ecebe7'],
        [/^landuse_residential$/, 'fill-color', 'rgba(0,0,0,0)'],
        [/^water/, 'fill-color', '#cfd9e2'],
        [/^waterway/, 'line-color', '#cfd9e2'],
        [/^(road|tunnel|bridge|highway).*_fill$/, 'line-color', '#ffffff'],
        [/^(road|tunnel|bridge|highway).*_case$/, 'line-color', '#e6e5e1'],
    ];

    function ainoPaint(layers) {
        const out = [];
        for (const l of layers || []) {
            for (const [re, prop, color] of AINO_PAINT) {
                if (re.test(l.id) && prop.split('-')[0] === l.type) { out.push([l.id, prop, color]); break; }
            }
        }
        return out;
    }

    function _theme() {
        return (typeof Theme !== 'undefined' && Theme.get) ? Theme.get() : 'light';
    }

    function skySpec(theme) { return { ...SKY[theme === 'dark' ? 'dark' : 'light'] }; }

    function _styleAtmosphere(map) {
        const theme = _theme();
        try { if (typeof map.setSky === 'function') map.setSky(skySpec(theme)); } catch { /* style not ready */ }
        if (theme !== 'light') {
            // The neon grid at 0.4 turned a zoomed-out city into graph paper;
            // keep hover/selected states as they were, quieten the rest.
            try {
                if (map.getLayer('digipin-grid-line')) {
                    map.setPaintProperty('digipin-grid-line', 'line-opacity', [
                        'case',
                        ['boolean', ['feature-state', 'selected'], false], 1.0,
                        ['boolean', ['feature-state', 'hover'], false], 0.8,
                        0.22,
                    ]);
                }
            } catch { /* grid not built yet */ }
            return;
        }
        try {
            for (const [id, prop, color] of ainoPaint(map.getStyle().layers)) map.setPaintProperty(id, prop, color);
            if (map.getLayer('digipin-grid-line')) {
                map.setPaintProperty('digipin-grid-line', 'line-opacity', [
                    'case',
                    ['boolean', ['feature-state', 'selected'], false], 1.0,
                    ['boolean', ['feature-state', 'hover'], false], 0.8,
                    0.16,
                ]);
                map.setPaintProperty('digipin-grid-line', 'line-width', [
                    'case',
                    ['boolean', ['feature-state', 'selected'], false], 2.5,
                    ['boolean', ['feature-state', 'hover'], false], 1.5,
                    0.6,
                ]);
            }
        } catch { /* style not ready */ }
        for (const [id, color] of Object.entries(LIGHT_BASEMAP)) {
            try {
                if (map.getLayer(id)) {
                    map.setPaintProperty(id, 'fill-color', color);
                    if (id === 'building-top') map.setPaintProperty(id, 'fill-outline-color', '#e4e7ea');
                }
            } catch { /* layer shape differs */ }
        }
    }

    let _haze = null;
    function _syncHaze(map) {
        if (!_haze || _haze === true || !map) return;
        const o = hazeOpacity(map.getPitch());
        _haze.style.opacity = String(o);
        // Lower the horizon band as the camera tilts up towards it.
        _haze.style.setProperty('--haze-depth', `${Math.round(18 + 22 * o)}%`);
    }

    function attachAtmosphere(map) {
        if (!map || typeof document === 'undefined' || _haze) return;
        const container = map.getContainer ? map.getContainer() : document.getElementById('map');
        if (!container) return;
        try { if (map.getMaxPitch && map.getMaxPitch() < MAX_PITCH) map.setMaxPitch(MAX_PITCH); } catch { /* older MapLibre */ }
        if (typeof map.setSky === 'function') {
            // Re-apply on every style (re)load; the sky lives in the style.
            if (map.isStyleLoaded && map.isStyleLoaded()) _styleAtmosphere(map);
            map.on('style.load', () => _styleAtmosphere(map));
            map.once('load', () => _styleAtmosphere(map));
            _haze = true;
            return;
        }
        _haze = document.createElement('div');
        _haze.className = 'map-horizon-haze';
        _haze.setAttribute('aria-hidden', 'true');
        container.appendChild(_haze);
        map.on('pitch', () => _syncHaze(map));
        _syncHaze(map);
    }

    // ── Loading splash ──────────────────────────────────────────────────────
    function showSplash() {
        if (typeof document === 'undefined' || document.getElementById('app-splash')) return;
        const s = document.createElement('div');
        s.id = 'app-splash';
        s.setAttribute('role', 'status');
        s.setAttribute('aria-live', 'polite');
        s.innerHTML = '<div class="splash-mark" aria-hidden="true">DP</div>'
            + '<div class="splash-title">DigiPin Intelligence</div>'
            + '<div class="splash-sub">Loading the city grid…</div>'
            + '<div class="splash-bar" aria-hidden="true"><span></span></div>';
        document.body.appendChild(s);
    }
    function hideSplash() {
        const s = typeof document !== 'undefined' && document.getElementById('app-splash');
        if (!s) return;
        s.classList.add('is-done');
        setTimeout(() => s.remove(), prefersReducedMotion() ? 0 : 600);
    }

    // ── Aino layer rows ─────────────────────────────────────────────────────
    // Aino lists layers as: colour dot · friendly name over a grey source line ·
    // eye toggle. Rows are built in app.js / cell-layers.js; this only adds the
    // dot colour and the source line (CSS draws the dot and the eye, light only).
    const DOTS = ['#3f3f3f', '#ef9a80', '#a9a9a6', '#8f9f86', '#c9b79c', '#7f95a8', '#d98f7a', '#b6c2a6'];

    function shortSource(src) {
        if (!src) return '';
        const s = String(src).split(/\s+[—–(]\s*|;\s*|,\s+via\s+/)[0].trim();
        return s.length > 44 ? s.slice(0, 42).trimEnd() + '…' : s;
    }

    /** Split "Title · L6" into { name: "Title", level: "L6" }. Pure. */
    function splitLevel(name) {
        const m = /^(.*?)\s*·\s*(L\d+)$/.exec(String(name || '').trim());
        return m ? { name: m[1], level: m[2] } : { name: String(name || '').trim(), level: '' };
    }

    function decorateLayerRow(item) {
        if (!item || item.dataset.aino === '1') return;
        const nameEl = item.querySelector('.dt-layer-name');
        if (!nameEl) return;
        item.dataset.aino = '1';
        const key = item.dataset.layerKey || nameEl.textContent;
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
        item.style.setProperty('--dot', DOTS[Math.abs(h) % DOTS.length]);
        const { name, level } = splitLevel(nameEl.textContent);
        const meta = (typeof Provenance !== 'undefined' && Provenance.forKey) ? Provenance.forKey(item.dataset.layerKey) : null;
        const src = [shortSource(meta && meta.source), level].filter(Boolean).join(' · ');
        const text = document.createElement('span');
        text.className = 'dt-layer-text';
        nameEl.replaceWith(text);
        nameEl.textContent = name;
        text.appendChild(nameEl);
        if (src) {
            const sub = document.createElement('span');
            sub.className = 'dt-layer-src';
            sub.textContent = src;
            text.appendChild(sub);
        }
    }

    function watchLayerRows(doc) {
        doc = doc || document;
        const drop = doc.getElementById('dt-layers-dropdown');
        if (!drop) return;
        drop.querySelectorAll('.dt-layer-item').forEach(decorateLayerRow);
        if (typeof MutationObserver === 'undefined') return;
        new MutationObserver(() => drop.querySelectorAll('.dt-layer-item:not([data-aino])').forEach(decorateLayerRow))
            .observe(drop, { childList: true, subtree: true });
    }

    // ── Aino "AI assistant" header + emoji-free query list (light) ─────────
    function ainoAssistant(doc) {
        doc = doc || document;
        if (_theme() !== 'light') return;
        const title = doc.querySelector('#disha-panel .disha-title');
        if (title && !title.dataset.aino) {
            title.dataset.aino = '1';
            const logo = title.querySelector('.disha-logo');
            if (logo) logo.innerHTML = icon('sparkle', 16);
            const name = [...title.querySelectorAll('span')].find(sp => !sp.className && /DISHA/.test(sp.textContent));
            if (name) { name.textContent = 'AI assistant'; name.className = 'disha-name'; }
        }
        const send = doc.getElementById('disha-send');
        if (send && !send.querySelector('svg')) send.innerHTML = icon('send', 16);
    }

    /** Leading emoji / symbols of a label, split from its text. Pure. */
    function splitEmoji(label) {
        const m = /^([^\p{L}\p{N}]+)\s*(.*)$/u.exec(String(label || ''));
        return m ? { emoji: m[1].trim(), text: m[2] } : { emoji: '', text: String(label || '') };
    }

    function stripSectorEmoji(doc) {
        doc = doc || document;
        doc.querySelectorAll('.sector-header-left:not([data-aino])').forEach(el => {
            el.dataset.aino = '1';
            const { emoji, text } = splitEmoji(el.textContent);
            if (!emoji) return;
            el.textContent = '';
            const e = doc.createElement('span');
            e.className = 'sector-emoji';
            e.setAttribute('aria-hidden', 'true');
            e.textContent = emoji + ' ';
            el.append(e, text);
        });
    }

    function watchSidebar(doc) {
        doc = doc || document;
        const sb = doc.getElementById('sidebar');
        stripSectorEmoji(doc);
        if (!sb || typeof MutationObserver === 'undefined') return;
        new MutationObserver(() => stripSectorEmoji(doc)).observe(sb, { childList: true, subtree: true });
    }

    // ── DigiPin grid toggle (map control under the zoom buttons) ───────────
    const GRID_KEY = 'digipin_grid_hidden';
    const GRID_LAYERS = ['digipin-grid-line', 'digipin-grid-fill'];

    function _gridHidden() { try { return localStorage.getItem(GRID_KEY) === '1'; } catch { return false; } }

    function setGridVisible(map, on) {
        for (const id of GRID_LAYERS) {
            try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); } catch { /* style reloading */ }
        }
        try { localStorage.setItem(GRID_KEY, on ? '0' : '1'); } catch { /* private mode */ }
        const b = document.getElementById('grid-toggle');
        if (b) { b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Hide the DigiPin grid (g)' : 'Show the DigiPin grid (g)'; }
    }

    function addGridToggle(map) {
        if (!map || typeof document === 'undefined' || document.getElementById('grid-toggle') || typeof map.addControl !== 'function') return;
        const ctl = {
            onAdd() {
                const box = document.createElement('div');
                box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
                const b = document.createElement('button');
                b.id = 'grid-toggle';
                b.type = 'button';
                b.setAttribute('aria-label', 'Toggle the DigiPin grid');
                b.innerHTML = icon('grid', 16);
                b.addEventListener('click', () => setGridVisible(map, b.getAttribute('aria-pressed') !== 'true'));
                box.appendChild(b);
                return box;
            },
            onRemove() {},
        };
        try { map.addControl(ctl, 'bottom-right'); } catch { return; }
        const apply = () => setGridVisible(map, !_gridHidden());
        map.on('style.load', apply);
        if (map.isStyleLoaded && map.isStyleLoaded()) apply(); else map.once('load', apply);
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'g' || e.metaKey || e.ctrlKey || e.altKey) return;
            const t = e.target;
            if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
            const b = document.getElementById('grid-toggle');
            if (b) b.click();
        });
    }

    // ── AI orb ──────────────────────────────────────────────────────────────
    // Aino opens every session from a round sparkle button above the tool
    // rail. Ours opens DISHA on the selected cell (or its empty state).
    function addAiOrb(doc) {
        doc = doc || document;
        const bar = doc.getElementById('toolbar');
        if (!bar || doc.getElementById('ai-orb')) return null;
        const b = doc.createElement('button');
        b.id = 'ai-orb';
        b.type = 'button';
        b.title = 'Ask DISHA, the AI urban analyst';
        b.setAttribute('aria-label', 'Ask DISHA, the AI urban analyst');
        b.innerHTML = icon('sparkle', 20);
        b.addEventListener('click', () => {
            if (typeof DISHAPanel === 'undefined' || !DISHAPanel.open) return;
            const P = typeof Panel !== 'undefined' ? Panel : null;
            DISHAPanel.open(P && P.getCurrentCell ? P.getCurrentCell() : null, P && P.getCurrentData ? P.getCurrentData() : null);
        });
        bar.parentNode.insertBefore(b, bar);
        return b;
    }

    function init() {
        if (typeof document === 'undefined') return;
        document.documentElement.classList.add('ui-polish');
        applyIcons();
        addAiOrb();
        watchLayerRows();
        watchSidebar();
        ainoAssistant();
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (!map) { hideSplash(); return; }
        attachAtmosphere(map);
        addGridToggle(map);
        if (map.loaded && map.loaded()) hideSplash();
        else {
            map.once('load', hideSplash);
            setTimeout(hideSplash, 8000);   // never trap the UI behind a slow style
        }
    }

    return { init, icon, applyIcons, hazeOpacity, skySpec, MAX_PITCH, prefersReducedMotion, attachAtmosphere,
        showSplash, hideSplash, ainoPaint, addAiOrb, splitLevel, shortSource, decorateLayerRow, splitEmoji, ainoAssistant, TOOLBAR, PATHS };
})();

if (typeof window !== 'undefined') {
    window.UIPolish = UIPolish;
    if (typeof document !== 'undefined' && document.body && document.readyState !== 'complete') UIPolish.showSplash();
    document.addEventListener('DOMContentLoaded', () => UIPolish.init());
}
