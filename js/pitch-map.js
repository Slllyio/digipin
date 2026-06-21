/**
 * PitchMap — Aino-style "Pitch Map" export.
 *
 * Aino's signature deliverable is a *presentation-ready* map: a clean, branded
 * snapshot of the styled view, sized for a slide deck. This module composites
 * the live MapLibre canvas (the 3D Aino massing model + basemap) onto an
 * offscreen 2D canvas, then frames it with a title band (project + DIGIPIN code
 * + city), a north arrow, a scale bar, an optional active-overlay legend, and an
 * attribution footer, and downloads it as a PNG.
 *
 * Requires `preserveDrawingBuffer: true` on the map (set in js/map.js) so the
 * WebGL drawing buffer is still readable at toDataURL() time.
 *
 * The geometry helpers (metersPerPixel / niceScaleBar / filename) are pure and
 * unit-tested; capture()/open() are DOM/canvas.
 */
const PitchMap = (() => {
    // Web-Mercator ground resolution: metres per CSS pixel at a latitude/zoom.
    // 156543.03392 m/px is the equatorial resolution at zoom 0 for 256px tiles.
    function metersPerPixel(lat, zoom) {
        return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    }

    // Pick a "nice" round distance (1/2/5 × 10ⁿ) that is ≤ maxMeters, so the
    // scale bar reads as 100 m / 200 m / 500 m / 1 km rather than 437 m.
    function niceScaleBar(maxMeters) {
        if (!(maxMeters > 0)) return 0;
        const pow = Math.pow(10, Math.floor(Math.log10(maxMeters)));
        for (const mult of [5, 2, 1]) {
            const v = mult * pow;
            if (v <= maxMeters) return v;
        }
        return pow;
    }

    // Human label for a metre distance (m below 1 km, else km).
    function formatDistance(m) {
        return m >= 1000 ? `${(m / 1000).toLocaleString()} km` : `${m.toLocaleString()} m`;
    }

    function filename(code) {
        const clean = (code || 'view').replace(/-/g, '');
        return `digipin_pitch_${clean}.png`;
    }

    /** Colours for the frame chrome, from the active theme (or sane light defaults). */
    function _palette() {
        const p = (typeof Theme !== 'undefined' && Theme.palette) ? Theme.palette() : null;
        return p || {
            surfaceSolid: '#ffffff', ink: '#292929', sub: '#636363',
            border: 'rgba(0,0,0,0.12)', primary: '#0099ff', brand: '#ff673d',
        };
    }

    /** Names of the analytics overlays currently switched on (for the legend). */
    function _activeOverlays() {
        if (typeof LayersPanel === 'undefined' || !LayersPanel.ANALYTICS) return [];
        return LayersPanel.ANALYTICS
            .filter(a => LayersPanel.isActive(a.btnId))
            .map(a => a.name);
    }

    /**
     * Composite the current map view into a branded PNG and download it.
     * @param {object} map  MapLibre map
     * @param {object} opts { code, city, title }
     */
    function capture(map, opts = {}) {
        if (!map || typeof map.getCanvas !== 'function') return null;
        const src = map.getCanvas();
        const dpr = window.devicePixelRatio || 1;
        const W = src.width;                 // device pixels
        const P = _palette();

        // Frame metrics scale with dpr so the export looks crisp on HiDPI.
        const pad = Math.round(24 * dpr);
        const titleH = Math.round(64 * dpr);
        const footH = Math.round(34 * dpr);
        const H = src.height + titleH + footH;

        const out = document.createElement('canvas');
        out.width = W;
        out.height = H;
        const ctx = out.getContext('2d');

        // Background (paper) behind the bands.
        ctx.fillStyle = P.surfaceSolid;
        ctx.fillRect(0, 0, W, H);

        // The map image, below the title band.
        try {
            ctx.drawImage(src, 0, titleH);
        } catch {
            // preserveDrawingBuffer missing or tainted canvas — bail gracefully.
            return null;
        }

        // ---- Title band ----------------------------------------------------
        ctx.fillStyle = P.surfaceSolid;
        ctx.fillRect(0, 0, W, titleH);
        ctx.fillStyle = P.brand || P.primary;
        ctx.fillRect(0, titleH - Math.max(2, Math.round(2 * dpr)), W, Math.max(2, Math.round(2 * dpr)));
        const title = opts.title || 'DigiPin Urban Intelligence';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = P.ink;
        ctx.font = `600 ${Math.round(22 * dpr)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(title, pad, titleH * 0.42);
        ctx.fillStyle = P.sub;
        ctx.font = `500 ${Math.round(13 * dpr)}px Inter, system-ui, sans-serif`;
        const sub = [opts.code ? `DIGIPIN ${opts.code}` : null, opts.city]
            .filter(Boolean).join('  ·  ');
        if (sub) ctx.fillText(sub, pad, titleH * 0.78);

        // ---- Scale bar (bottom-left of the map area) -----------------------
        const lat = map.getCenter ? map.getCenter().lat : 0;
        const zoom = map.getZoom ? map.getZoom() : 14;
        const mpp = metersPerPixel(lat, zoom);          // metres / CSS px
        const maxBarPx = 140;                            // CSS px budget
        const meters = niceScaleBar(mpp * maxBarPx);
        if (meters > 0) {
            const barPx = (meters / mpp) * dpr;
            const bx = pad;
            const by = H - footH - Math.round(18 * dpr);
            ctx.strokeStyle = P.ink;
            ctx.fillStyle = P.ink;
            ctx.lineWidth = Math.max(2, Math.round(2 * dpr));
            ctx.beginPath();
            ctx.moveTo(bx, by - Math.round(6 * dpr));
            ctx.lineTo(bx, by);
            ctx.lineTo(bx + barPx, by);
            ctx.lineTo(bx + barPx, by - Math.round(6 * dpr));
            ctx.stroke();
            ctx.font = `600 ${Math.round(12 * dpr)}px Inter, system-ui, sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(formatDistance(meters), bx, by - Math.round(8 * dpr));
        }

        // ---- North arrow (top-right of the map area, rotated by bearing) ---
        const bearing = map.getBearing ? map.getBearing() : 0;
        const nx = W - pad - Math.round(16 * dpr);
        const ny = titleH + pad + Math.round(18 * dpr);
        const arm = Math.round(16 * dpr);
        ctx.save();
        ctx.translate(nx, ny);
        ctx.rotate(-bearing * Math.PI / 180);
        ctx.fillStyle = P.brand || P.primary;
        ctx.beginPath();
        ctx.moveTo(0, -arm);
        ctx.lineTo(arm * 0.55, arm);
        ctx.lineTo(0, arm * 0.45);
        ctx.lineTo(-arm * 0.55, arm);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = P.ink;
        ctx.font = `700 ${Math.round(12 * dpr)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('N', nx, ny - arm - Math.round(2 * dpr));

        // ---- Legend (active overlays, top-left of the map area) ------------
        const overlays = _activeOverlays();
        if (overlays.length) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            const lx = pad, ly = titleH + pad;
            const lh = Math.round(20 * dpr);
            const boxW = Math.round(220 * dpr);
            const boxH = lh * (overlays.length + 1) + Math.round(8 * dpr);
            ctx.fillStyle = 'rgba(255,255,255,0.86)';
            ctx.fillRect(lx, ly, boxW, boxH);
            ctx.strokeStyle = P.border;
            ctx.lineWidth = Math.max(1, Math.round(dpr));
            ctx.strokeRect(lx, ly, boxW, boxH);
            ctx.fillStyle = P.sub;
            ctx.font = `700 ${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`;
            ctx.fillText('ACTIVE LAYERS', lx + Math.round(10 * dpr), ly + Math.round(8 * dpr));
            ctx.fillStyle = P.ink;
            ctx.font = `500 ${Math.round(12 * dpr)}px Inter, system-ui, sans-serif`;
            overlays.forEach((name, i) => {
                ctx.fillText(`• ${name}`, lx + Math.round(10 * dpr),
                    ly + Math.round(8 * dpr) + lh * (i + 1));
            });
        }

        // ---- Attribution footer --------------------------------------------
        ctx.fillStyle = P.surfaceSolid;
        ctx.fillRect(0, H - footH, W, footH);
        ctx.fillStyle = P.sub;
        ctx.font = `500 ${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('© DigiPin by India Post · © Overture Maps · © CARTO · generated with DigiPin Urban Intelligence',
            pad, H - footH / 2);

        return out;
    }

    /** Capture the current map view and trigger a PNG download. */
    function open() {
        if (typeof MapModule === 'undefined' || !MapModule.getMap) return;
        const map = MapModule.getMap();
        if (!map) {
            if (typeof App !== 'undefined') App.showToast('Pitch map', 'Map not ready yet.', 'warning');
            return;
        }
        const code = MapModule.getSelectedCode ? MapModule.getSelectedCode() : null;
        const city = (typeof CitySelector !== 'undefined' && CitySelector.getCurrent)
            ? (() => { const c = CitySelector.getCurrent(); return c ? `${c.name}, ${c.state}` : null; })()
            : null;

        // The WebGL buffer is only guaranteed populated right after a render —
        // force one, then capture on the next frame.
        map.triggerRepaint && map.triggerRepaint();
        requestAnimationFrame(() => {
            const canvas = capture(map, { code, city });
            if (!canvas) {
                if (typeof App !== 'undefined') {
                    App.showToast('Pitch map', 'Could not read the map image. Try again after the map finishes drawing.', 'error');
                }
                return;
            }
            canvas.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename(code);
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                if (typeof App !== 'undefined') {
                    App.showToast('Pitch map', 'Presentation-ready PNG exported.', 'success');
                }
            }, 'image/png');
        });
    }

    return { open, capture, metersPerPixel, niceScaleBar, formatDistance, filename };
})();

if (typeof window !== 'undefined') {
    window.PitchMap = PitchMap;
}
