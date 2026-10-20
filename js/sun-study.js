/**
 * SunStudy — solar position + shadow study for the 3D building massing model.
 *
 * Aino-style environmental/site analysis: drive the map's directional light from
 * the *real* sun position for the selected location, so the white 3D massing
 * model (js/overture-buildings.js) casts a believable lit/shadow side. A
 * date + time-of-day slider lets a planner sweep the day; ▶ play animates the
 * sun arc.
 *
 * The light is the single global MapLibre map light shared with
 * overture-buildings.js / digital-twin-layers.js — SunStudy is just another
 * writer of it (set-only; never reset), so the overlays don't fight.
 *
 * solarPosition()/lightFor() are pure (NOAA algorithm, no deps, unit-tested);
 * the control + animation are DOM.
 */
const SunStudy = (() => {
    const RAD = Math.PI / 180, DEG = 180 / Math.PI;

    /** Julian Day from a JS Date (uses its UTC instant). */
    function toJulian(date) {
        return date.getTime() / 86400000 + 2440587.5;
    }

    /**
     * Solar altitude + azimuth (degrees) for a lat/lng at a given instant,
     * via the NOAA solar-position algorithm. Azimuth is measured clockwise
     * from due north; altitude is degrees above the horizon (negative = night).
     */
    function solarPosition(lat, lng, date) {
        const jd = toJulian(date);
        const t = (jd - 2451545.0) / 36525;                 // Julian centuries (J2000)

        let L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
        if (L0 < 0) L0 += 360;
        const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
        const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
        const C = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
            + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t)
            + Math.sin(3 * M * RAD) * 0.000289;
        const trueLong = L0 + C;
        const omega = 125.04 - 1934.136 * t;
        const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
        const seconds = 21.448 - t * (46.8150 + t * (0.00059 - t * 0.001813));
        const eps0 = 23 + (26 + seconds / 60) / 60;
        const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
        const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;

        const y = Math.tan(eps / 2 * RAD) ** 2;
        const Eq = 4 * DEG * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
            + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
            - 0.5 * y * y * Math.sin(4 * L0 * RAD)
            - 1.25 * e * e * Math.sin(2 * M * RAD));     // equation of time (minutes)

        const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
        let tst = (utcMin + Eq + 4 * lng) % 1440;            // true solar time (minutes)
        if (tst < 0) tst += 1440;
        let ha = tst / 4 - 180;                              // hour angle (deg)
        if (ha < -180) ha += 360;

        const cosZen = Math.sin(lat * RAD) * Math.sin(decl * RAD)
            + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(ha * RAD);
        const zenith = Math.acos(Math.max(-1, Math.min(1, cosZen))) * DEG;
        const altitude = 90 - zenith;

        let az;
        const denom = Math.cos(lat * RAD) * Math.sin(zenith * RAD);
        if (Math.abs(denom) > 1e-9) {
            let cosAz = (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(decl * RAD)) / denom;
            cosAz = Math.max(-1, Math.min(1, cosAz));
            az = Math.acos(cosAz) * DEG;
            az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
        } else {
            az = lat > 0 ? 180 : 0;
        }
        return { altitude, azimuth: az };
    }

    /**
     * Map a solar altitude/azimuth to a MapLibre `setLight` option object.
     * position = [radial, azimuthal(from N, clockwise), polar(from straight up)].
     * Below the horizon → a dim, low dusk light (so night isn't pitch black).
     */
    function lightFor(altitude, azimuth) {
        const above = altitude > 0;
        const polar = above ? Math.max(2, 90 - altitude) : 88;
        // Intensity: brightest near noon, fading to a low ambient at/under horizon.
        const intensity = above
            ? Math.min(0.6, 0.18 + 0.42 * Math.sin(altitude * RAD))
            : 0.12;
        return {
            anchor: 'map',
            position: [1.5, azimuth, polar],
            color: above ? '#fff8ec' : '#9fb0c8',
            intensity,
        };
    }

    /** Solar declination (degrees) for a date — the slow-varying NOAA series. */
    function _declination(date) {
        const t = (toJulian(date) - 2451545.0) / 36525;
        let L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
        if (L0 < 0) L0 += 360;
        const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
        const C = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
            + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t)
            + Math.sin(3 * M * RAD) * 0.000289;
        const omega = 125.04 - 1934.136 * t;
        const lambda = (L0 + C) - 0.00569 - 0.00478 * Math.sin(omega * RAD);
        const seconds = 21.448 - t * (46.8150 + t * (0.00059 - t * 0.001813));
        const eps = 23 + (26 + seconds / 60) / 60 + 0.00256 * Math.cos(omega * RAD);
        return Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
    }

    /**
     * Sunrise/sunset (in **apparent solar time**, hours) and total daylight hours
     * for a latitude on a date. Solar noon is 12:00 by definition, so this is
     * timezone-free. Returns `polar: 'day'|'night'` (with null times) when the sun
     * never sets / never rises. lng is accepted for signature symmetry.
     */
    function sunTimes(lat, lng, date) {
        const decl = _declination(date);
        const latR = lat * RAD, declR = decl * RAD;
        const cosH0 = (Math.sin(-0.833 * RAD) - Math.sin(latR) * Math.sin(declR))
            / (Math.cos(latR) * Math.cos(declR));
        if (cosH0 <= -1) return { daylightHours: 24, sunriseH: null, sunsetH: null, polar: 'day' };
        if (cosH0 >= 1) return { daylightHours: 0, sunriseH: null, sunsetH: null, polar: 'night' };
        const haH = Math.acos(cosH0) * DEG / 15;     // half-day length in hours
        return { daylightHours: 2 * haH, sunriseH: 12 - haH, sunsetH: 12 + haH, polar: null };
    }

    /**
     * Solar altitude (deg) sampled across the day in apparent solar time —
     * `[{ h, altitude }]` from 00:00 to 24:00. Drives the sun-path chart. Pure;
     * lng is accepted for signature symmetry with sunTimes.
     */
    function dayAltitudes(lat, lng, date, stepMin = 15) {
        const declR = _declination(date) * RAD, latR = lat * RAD;
        const out = [];
        for (let m = 0; m <= 1440; m += stepMin) {
            const t = m / 60;                          // solar hours
            const H = (t - 12) * 15 * RAD;             // hour angle
            const sinAlt = Math.sin(latR) * Math.sin(declR)
                + Math.cos(latR) * Math.cos(declR) * Math.cos(H);
            out.push({ h: t, altitude: Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG });
        }
        return out;
    }
    /** Peak altitude (deg) across a day-altitude sample array. Pure. */
    function peakAltitude(samples) {
        return (samples || []).reduce((mx, s) => (s.altitude > mx ? s.altitude : mx), -90);
    }

    /** Decimal hours → "HH:MM" (24h), wrapping into [0,24). */
    function formatHM(hours) {
        if (hours == null || !Number.isFinite(hours)) return '—';
        let h = ((hours % 24) + 24) % 24;
        let m = Math.round((h - Math.floor(h)) * 60);
        h = Math.floor(h);
        if (m === 60) { m = 0; h = (h + 1) % 24; }
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    let _map = null, _panel = null, _date = null, _playing = false, _raf = 0;

    /** Current lat/lng to compute the sun for — the map centre (Indore fallback). */
    function _latlng() {
        if (_map && _map.getCenter) {
            const c = _map.getCenter();
            return { lat: c.lat, lng: c.lng };
        }
        return { lat: 22.7196, lng: 75.8577 };   // Indore fallback
    }

    /** Push the light for the current _date to the map (no-op if setLight absent). */
    function applyToMap() {
        if (!_map || typeof _map.setLight !== 'function' || !_date) return false;
        const { lat, lng } = _latlng();
        const { altitude, azimuth } = solarPosition(lat, lng, _date);
        try { _map.setLight(lightFor(altitude, azimuth)); } catch { return false; }
        _updateReadout(altitude, azimuth);
        _updateAccess();
        _drawChart();
        return true;
    }

    /** Refresh the sunrise/sunset/daylight readout for the current date+location. */
    function _updateAccess() {
        if (!_panel || !_date) return;
        const out = _panel.querySelector('.sun-access');
        if (!out) return;
        const { lat, lng } = _latlng();
        const st = sunTimes(lat, lng, _date);
        if (st.polar === 'day') out.textContent = '☀ Polar day — sun never sets';
        else if (st.polar === 'night') out.textContent = '🌑 Polar night — sun never rises';
        else out.textContent = `↑ ${formatHM(st.sunriseH)} · ↓ ${formatHM(st.sunsetH)} · ${st.daylightHours.toFixed(1)} h daylight`;
    }

    /** Draw the day's solar-altitude curve with a marker at the current time. */
    function _drawChart() {
        if (!_panel || !_date) return;
        const canvas = _panel.querySelector('.sun-chart');
        if (!canvas || !canvas.getContext) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const W = canvas.width, H = canvas.height;
        const { lat, lng } = _latlng();
        const samples = dayAltitudes(lat, lng, _date);
        const pal = (typeof Theme !== 'undefined' && Theme.palette) ? Theme.palette()
            : { primary: '#0099ff', sub: '#636363', border: 'rgba(0,0,0,0.12)' };
        const MIN = -15, MAX = 90;                       // altitude window (deg)
        const y = (alt) => H - ((alt - MIN) / (MAX - MIN)) * H;
        const x = (h) => (h / 24) * W;
        ctx.clearRect(0, 0, W, H);
        // horizon line (altitude 0)
        ctx.strokeStyle = pal.border;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0)); ctx.stroke();
        // altitude curve
        ctx.strokeStyle = pal.primary;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        samples.forEach((s, i) => { const px = x(s.h), py = y(s.altitude); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.stroke();
        // current-time marker — altitude at the current solar hour (same model
        // as dayAltitudes, computed directly for this one instant).
        const utcMin = _date.getUTCHours() * 60 + _date.getUTCMinutes();
        let tH = ((utcMin + 4 * lng) / 60) % 24; if (tH < 0) tH += 24;
        const declR = _declination(_date) * RAD, latR = lat * RAD;
        const Hh = (tH - 12) * 15 * RAD;
        const sinAlt = Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(Hh);
        const curAlt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
        ctx.fillStyle = (typeof Theme !== 'undefined' && Theme.palette) ? (Theme.palette().brand || pal.primary) : '#ff673d';
        ctx.beginPath(); ctx.arc(x(tH), y(curAlt), 3, 0, 2 * Math.PI); ctx.fill();
    }

    /** Write the altitude/azimuth (or "below horizon") line into the panel. */
    function _updateReadout(altitude, azimuth) {
        if (!_panel) return;
        const out = _panel.querySelector('.sun-readout');
        if (!out) return;
        const above = altitude > 0;
        out.textContent = above
            ? `☀ ${altitude.toFixed(0)}° above · bearing ${azimuth.toFixed(0)}°`
            : `🌙 sun below horizon (${altitude.toFixed(0)}°)`;
    }

    // Local time helpers: the slider is "minutes past local midnight"; we apply
    // it relative to the location's longitude (approx local solar offset) so the
    // shadows match local clock intuition without a timezone database.
    /** Set _date from the date input + minutes-past-local-midnight slider value. */
    function _setFromSlider(dateStr, minutes) {
        const [Y, Mo, D] = dateStr.split('-').map(Number);
        const tzOffsetHours = _latlng().lng / 15;        // approx solar timezone
        const utcMs = Date.UTC(Y, Mo - 1, D, 0, 0, 0) + (minutes - tzOffsetHours * 60) * 60000;
        _date = new Date(utcMs);
    }

    /** Stop the sun-arc animation. */
    function _stop() {
        _playing = false;
        if (_raf) cancelAnimationFrame(_raf);
        _raf = 0;
        const btn = _panel && _panel.querySelector('.sun-play');
        if (btn) btn.textContent = '▶';
    }

    /** Animate the time slider across daylight hours (rAF, throttled). */
    function _play() {
        if (!_panel) return;
        const slider = _panel.querySelector('.sun-time');
        const dateEl = _panel.querySelector('.sun-date');
        const btn = _panel.querySelector('.sun-play');
        _playing = true;
        if (btn) btn.textContent = '⏸';
        let last = 0;
        const step = (ts) => {
            if (!_playing) return;
            if (ts - last > 60) {                          // throttle ~16 fps
                last = ts;
                let v = Number(slider.value) + 6;          // 6 sim-minutes / frame
                if (v > 1080) v = 300;                      // loop 05:00 → 18:00
                slider.value = String(v);
                _setFromSlider(dateEl.value, v);
                applyToMap();
            }
            _raf = requestAnimationFrame(step);
        };
        _raf = requestAnimationFrame(step);
    }

    /** Build and wire the floating sun-study control panel. */
    function _buildPanel() {
        const el = document.createElement('div');
        el.id = 'sun-study-panel';
        el.className = 'sun-study-panel';
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        el.innerHTML = `
            <div class="sun-head">
                <span class="sun-title">☀ Sun &amp; shadow study</span>
                <button class="sun-close" aria-label="Close sun study">✕</button>
            </div>
            <label class="sun-row">Date
                <input type="date" class="sun-date" value="${today}">
            </label>
            <label class="sun-row">Time
                <input type="range" class="sun-time" min="0" max="1439" value="720" step="5">
            </label>
            <div class="sun-controls">
                <button class="sun-play" aria-label="Play sun arc">▶</button>
                <span class="sun-readout">—</span>
            </div>
            <div class="sun-access">—</div>
            <canvas class="sun-chart" width="222" height="64" aria-label="Sun-path altitude chart"></canvas>
            <div class="sun-hint">Enable <b>3D Mode</b> / Buildings to see the cast shadows.</div>`;
        el.querySelector('.sun-close').addEventListener('click', () => toggle());
        const dateEl = el.querySelector('.sun-date');
        const slider = el.querySelector('.sun-time');
        const onInput = () => { _stop(); _setFromSlider(dateEl.value, Number(slider.value)); applyToMap(); };
        dateEl.addEventListener('change', onInput);
        slider.addEventListener('input', onInput);
        el.querySelector('.sun-play').addEventListener('click', () => (_playing ? _stop() : _play()));
        document.body.appendChild(el);
        _setFromSlider(dateEl.value, Number(slider.value));
        return el;
    }

    /** Toggle the control. Returns the new visible state. */
    function toggle() {
        _map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (_panel) {
            _stop();
            _panel.remove();
            _panel = null;
            return false;
        }
        if (_map && typeof _map.setLight !== 'function') {
            if (typeof App !== 'undefined') {
                App.showToast('Sun study', 'This map build does not support dynamic lighting.', 'warning');
            }
            return false;
        }
        _panel = _buildPanel();
        applyToMap();
        return true;
    }

    function isActive() { return !!_panel; }

    return { toggle, isActive, applyToMap, solarPosition, lightFor, toJulian, sunTimes, formatHM,
        dayAltitudes, peakAltitude };
})();

if (typeof window !== 'undefined') {
    window.SunStudy = SunStudy;
}
