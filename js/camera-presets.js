/**
 * CameraPresets — named 3D camera shots per city: Overview, Bird's eye and
 * Street, the last two framed on each city's best-known centre (Rajwada,
 * Connaught Place, Charminar, …).
 *
 * A small pill bar sits at the bottom of the map while 3D is on. Picking a
 * shot turns 3D on if needed and flies there; like the city overview's
 * fly-in, it waits for the terrain DEM first so the camera doesn't end up
 * under raised ground. Record plays the three shots plus an orbit into a
 * short MP4/WebM for sharing. presetsFor()/placeIn()/pickMime()/fileName()
 * are pure (unit-tested).
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
        record: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
        stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>',
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
    let _rec = null;          // { stop() } while a fly-through is recording

    /** First recordable container the browser supports, or null. Pure given isSupported. */
    function pickMime(isSupported) {
        // H.264 MP4 plays everywhere; Chromium builds without it fall back to WebM
        // rather than VP9-in-MP4, which QuickTime and many phones refuse.
        const prefs = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
        for (const m of prefs) { try { if (isSupported(m)) return m; } catch { /* keep looking */ } }
        return null;
    }

    /** Download file name for a city's fly-through. Pure. */
    function fileName(city, mime) {
        const slug = String((city && (city.id || city.name)) || 'city').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `digipin-${slug || 'city'}-flythrough.${/mp4/.test(mime || '') ? 'mp4' : 'webm'}`;
    }

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

    function _toast(title, msg, kind) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast(title, msg, kind || 'info');
    }

    function _wait(map, ms) {
        return new Promise(res => {
            let done = false;
            const fin = () => { if (!done) { done = true; res(); } };
            map.once('moveend', fin);
            setTimeout(fin, ms);
        });
    }

    /**
     * Record Overview → Bird's eye → Street plus a slow orbit as a video and
     * download it. The map canvas is copied each frame onto a 2D canvas with
     * a caption and the map credits (the credits are DOM, not in the WebGL
     * picture). Resolves { bytes, type, name, ms } or null when unsupported.
     *
     * Other modules record their own sequences through the same recorder:
     * opts.shots = [{ caption, camera?, enter?: async () => camera|void, holdMs? }],
     * opts.orbit = false skips the closing orbit, opts.fileName names the file
     * (js/city-tour.js records its tours and time-lapses this way).
     */
    async function record(opts = {}) {
        const map = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        const city = typeof CitySelector !== 'undefined' ? CitySelector.getCurrent() : null;
        const custom = Array.isArray(opts.shots) && opts.shots.length > 0;
        const shots = custom ? opts.shots : presetsFor(city, _maxPitch());
        const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported ? pickMime(m => MediaRecorder.isTypeSupported(m)) : null;
        const src = map && map.getCanvas ? map.getCanvas() : null;
        if (!map || !shots.length || !mime || !src || typeof document === 'undefined') {
            _toast('Fly-through', 'This browser can’t record video of the map.', 'warning');
            return null;
        }
        const btn3d = document.getElementById('btn-3d');
        if (btn3d && !btn3d.classList.contains('active')) { btn3d.click(); await new Promise(r => setTimeout(r, 1500)); }

        const scale = Math.min(1, 1280 / src.width);
        const out = document.createElement('canvas');
        out.width = Math.round(src.width * scale / 2) * 2;
        out.height = Math.round(src.height * scale / 2) * 2;
        const ctx = out.getContext('2d');
        const light = document.documentElement.getAttribute('data-theme') === 'light';
        let caption = '';
        const draw = () => {
            ctx.drawImage(src, 0, 0, out.width, out.height);
            const bh = Math.max(26, Math.round(out.height * 0.045));
            ctx.fillStyle = light ? 'rgba(255,255,255,0.86)' : 'rgba(8,12,24,0.72)';
            ctx.fillRect(0, out.height - bh, out.width, bh);
            ctx.fillStyle = light ? '#1f1f1f' : '#e6edf6';
            ctx.font = `600 ${Math.round(bh * 0.46)}px system-ui, sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.fillText(`DigiPin · ${city ? city.name : ''}${caption ? ' · ' + caption : ''}`, 12, out.height - bh / 2);
            ctx.font = `${Math.round(bh * 0.36)}px system-ui, sans-serif`;
            ctx.textAlign = 'right';
            ctx.fillText('© OpenStreetMap · Overture Maps · CARTO', out.width - 12, out.height - bh / 2);
            ctx.textAlign = 'left';
        };
        // Copy on 'render' (the WebGL buffer is only valid then) and keep the
        // map repainting through the holds so the video never freezes black.
        map.on('render', draw);
        let raf = 0, live = true;
        const pump = () => { if (!live) return; map.triggerRepaint(); raf = requestAnimationFrame(pump); };
        pump();

        const stream = out.captureStream(30);
        const chunks = [];
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5e6 });
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise(res => { rec.onstop = res; });
        let cancelled = false;
        _rec = { stop: () => { cancelled = true; } };
        _setRecording(true);
        const t0 = Date.now();
        rec.start(500);
        try {
            const fly = opts.flyMs || 3200, hold = opts.holdMs || 1200;
            for (const p of shots) {
                if (cancelled) break;
                caption = p.caption || `${p.label} · ${p.detail}`;
                if (!custom) _mark(p.id);
                let cam = p.camera;
                if (p.enter) { const c = await p.enter(); if (c) cam = c; }
                if (cam) {
                    map.flyTo({ ...cam, duration: fly, curve: 1.4, essential: true });
                    await _wait(map, fly + 800);
                }
                await new Promise(r => setTimeout(r, p.holdMs != null ? p.holdMs : hold));
            }
            if (!cancelled && opts.orbit !== false) {
                caption = 'Orbit';
                map.easeTo({ bearing: map.getBearing() + 90, duration: opts.orbitMs || 5000, easing: t => t, essential: true });
                await _wait(map, (opts.orbitMs || 5000) + 800);
            }
        } finally {
            rec.stop();
            await stopped;
            live = false;
            cancelAnimationFrame(raf);
            map.off('render', draw);
            stream.getTracks().forEach(t => t.stop());
            _rec = null;
            _setRecording(false);
        }
        const blob = new Blob(chunks, { type: mime.split(';')[0] });
        const name = opts.fileName ? `${opts.fileName}.${/mp4/.test(mime) ? 'mp4' : 'webm'}` : fileName(city, mime);
        if (opts.download !== false && blob.size) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        }
        const mb = (blob.size / 1048576).toFixed(1);
        _toast('Fly-through saved', blob.size ? `${name} (${mb} MB)` : 'Nothing was recorded.', blob.size ? 'success' : 'warning');
        return { bytes: blob.size, type: blob.type, name, ms: Date.now() - t0 };
    }

    function _setRecording(on) {
        if (!_bar) return;
        _bar.classList.toggle('is-recording', on);
        const b = _bar.querySelector('.cp-rec');
        if (!b) return;
        b.setAttribute('aria-pressed', String(on));
        b.title = on ? 'Stop recording' : 'Record a fly-through video of these shots';
        b.setAttribute('aria-label', b.title);
        b.innerHTML = `${_icon(on ? 'stop' : 'record')}<span class="cp-label">${on ? 'Stop' : 'Record'}</span>`;
    }

    function _mark(id) {
        if (!_bar) return;
        _bar.querySelectorAll('.cp-btn[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === id)));
    }

    function _render() {
        if (!_bar) return;
        const city = typeof CitySelector !== 'undefined' ? CitySelector.getCurrent() : null;
        _bar.innerHTML = presetsFor(city, _maxPitch()).map(p =>
            `<button type="button" class="cp-btn" data-preset="${p.id}" aria-pressed="false" aria-label="${p.label}: ${p.detail}" title="${p.label}: ${p.detail}">`
            + `${_icon(p.id)}<span class="cp-label">${p.label}</span><span class="cp-detail">${p.detail}</span></button>`).join('')
            + '<span class="cp-sep" aria-hidden="true"></span>'
            + `<button type="button" class="cp-btn cp-rec" data-act="record" aria-pressed="false" aria-label="Record a fly-through video of these shots" title="Record a fly-through video of these shots">${_icon('record')}<span class="cp-label">Record</span></button>`;
        if (typeof NightCity !== 'undefined' && NightCity.mount) NightCity.mount(_bar);
        if (typeof Quality3D !== 'undefined' && Quality3D.mount) Quality3D.mount(_bar);
    }

    function _sync() {
        if (!_bar) return;
        const btn3d = document.getElementById('btn-3d');
        _bar.hidden = !(btn3d && btn3d.classList.contains('active'));
        _layout();
    }

    /**
     * Centre [left, width] for the bar in the free bottom gap between the left
     * rail and the right-hand obstacles (lefts of the detail panel, cell
     * legend, zoom controls), or null when it fits centred anyway. Pure.
     */
    function placeIn(vw, railRight, rights, barW) {
        const right = Math.min(vw, ...rights.filter(x => x > vw / 2));
        const free = right - railRight;
        const centred = (vw - barW) / 2;
        if (centred >= railRight && centred + barW <= right) return null;
        return { left: Math.max(railRight + 8, railRight + (free - barW) / 2), compact: free < barW + 24 };
    }

    function _layout() {
        if (!_bar || _bar.hidden || typeof window === 'undefined') return;
        if (window.innerWidth <= 768) { _bar.style.left = ''; _bar.style.transform = ''; _bar.classList.remove('is-compact'); return; }
        const box = (sel) => {
            const el = document.querySelector(sel);
            const r = el && el.getBoundingClientRect();
            return r && r.width > 0 && r.height > 0 ? r : null;
        };
        const rights = [box('#detail-panel.open'), box('#cell-layer-legend'), box('.maplibregl-ctrl-bottom-right')].filter(Boolean).map(r => r.left);
        const rail = box('#aino-toolbar, #toolbar');
        _bar.classList.remove('is-compact');
        _bar.style.left = ''; _bar.style.transform = '';
        let w = _bar.getBoundingClientRect().width;
        let p = placeIn(window.innerWidth, rail && rail.right < window.innerWidth / 2 ? rail.right : 0, rights, w);
        if (p && p.compact) {
            _bar.classList.add('is-compact');
            w = _bar.getBoundingClientRect().width;
            p = placeIn(window.innerWidth, rail && rail.right < window.innerWidth / 2 ? rail.right : 0, rights, w) || p;
        }
        if (p) { _bar.style.left = `${Math.round(p.left)}px`; _bar.style.transform = 'none'; }
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
            if (!b) return;
            if (b.dataset.act === 'record') { if (_rec) _rec.stop(); else record().catch(() => {}); return; }
            if (!_rec) go(b.dataset.preset);
        });
        if (typeof CitySelector !== 'undefined' && CitySelector.onChange) CitySelector.onChange(() => { _render(); _sync(); });
        const btn3d = document.getElementById('btn-3d');
        if (btn3d && typeof MutationObserver !== 'undefined') {
            new MutationObserver(_sync).observe(btn3d, { attributes: true, attributeFilter: ['class'] });
        }
        // Manual camera moves clear the "current shot" mark.
        const map = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        if (map) map.on('dragstart', () => _mark(null));
        // The detail panel and cell legend come and go on the right: re-fit.
        if (typeof MutationObserver !== 'undefined') {
            let t = 0;
            new MutationObserver(() => { if (!t) t = setTimeout(() => { t = 0; _layout(); }, 120); })
                .observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ['class'] });
            const dp = document.getElementById('detail-panel');
            if (dp) new MutationObserver(() => _layout()).observe(dp, { attributes: true, attributeFilter: ['class'] });
        }
        window.addEventListener('resize', _layout);
        _sync();
    }

    function isRecording() { return !!_rec; }
    function stopRecording() { if (_rec) _rec.stop(); }

    return { init, go, record, isRecording, stopRecording, presetsFor, placeIn, pickMime, fileName, LANDMARKS };
})();

if (typeof window !== 'undefined') {
    window.CameraPresets = CameraPresets;
}
