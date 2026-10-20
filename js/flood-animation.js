/**
 * FloodAnimation — Canvas-based 7-day discharge sparkline that draws itself.
 *
 * Visual:
 *   ┌──────────────────────────────────────────┐
 *   │   Flood forecast — 7 days  ┌──────────┐  │
 *   │                            │ELEVATED  │  │
 *   │   ╭─╮      ╭─╮               └──────────┘ │
 *   │  ╱   ╲    ╱   ╲___                       │
 *   │ ●─────●──●─────●─────●─────●─────●       │
 *   │ Sun  Mon Tue  Wed  Thu  Fri  Sat        │
 *   │                                          │
 *   │ Baseline 0.59 m³/s · Peak 1.28 m³/s (×2.2)│
 *   └──────────────────────────────────────────┘
 *
 * Animation phases (~2 seconds total):
 *   1. 0.0–1.2s — discharge line draws left-to-right (easeOutQuad)
 *   2. 1.2–1.5s — min/max band fades in
 *   3. 1.5–2.0s — day markers pulse one-by-one, colored by risk level
 *
 * The animation uses requestAnimationFrame, never blocks the main thread,
 * and is idempotent — calling attachTo() a second time on the same
 * container replaces the previous widget cleanly.
 */

const FloodAnimation = (() => {
    const W = 280, H = 110;
    const PAD = { top: 20, right: 12, bottom: 24, left: 12 };
    const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    function _easeOutQuad(t) { return t * (2 - t); }

    function attachTo(containerEl, forecast, cell) {
        if (!containerEl || !forecast || !forecast.days?.length) return;

        // Remove any previous widget in this container (idempotent).
        containerEl.querySelectorAll('[data-flood-widget]').forEach(el => el.remove());

        const wrap = document.createElement('div');
        wrap.setAttribute('data-flood-widget', '');
        wrap.className = 'flood-widget';
        wrap.innerHTML = `
            <div class="flood-widget__header">
                <span class="flood-widget__title">Flood forecast · 7 days</span>
                <span class="flood-widget__badge"
                      style="background:${forecast.overall_risk.color};">
                    ${forecast.overall_risk.level.toUpperCase()}
                </span>
            </div>
            <canvas width="${W}" height="${H}" style="width:100%;max-width:${W}px;"></canvas>
            <div class="flood-widget__caption">
                Baseline ${forecast.baseline_m3s.toFixed(2)} m³/s · Peak
                ${forecast.peak_day.max.toFixed(2)} m³/s
                (×${forecast.peak_ratio.toFixed(1)})
            </div>
            <div class="flood-widget__actions">
                <button type="button" class="flood-widget__btn" data-flood-action="toggle-map">
                    Show inundation on map
                </button>
            </div>
            <div class="flood-widget__sim" data-flood-sim hidden>
                <label class="flood-widget__sim-label">
                    What-if extra rainfall:
                    <span class="flood-widget__sim-value" data-flood-rain>+0 mm/day</span>
                </label>
                <input type="range" class="flood-widget__sim-range" data-flood-rain-input
                       min="0" max="200" step="5" value="0">
                <div class="flood-widget__sim-readout" data-flood-rain-readout>
                    SCS Curve Number (CN=80): runoff 0 mm · extra depth 0.00 m
                </div>
            </div>
            <div class="flood-widget__source">Source: ${forecast.source}</div>
            <div class="flood-widget__disclaimer">
                Inundation uses AWS Terrarium DEM (~9 m/px). What-if simulation uses
                SCS Curve Number for rainfall→runoff; depth-of-flood is a transparent
                linear scale (0.02 m per mm runoff), not a full hydraulic model.
            </div>
        `;
        containerEl.appendChild(wrap);

        const mapBtn = wrap.querySelector('[data-flood-action="toggle-map"]');
        const simBlock = wrap.querySelector('[data-flood-sim]');
        const rangeEl  = wrap.querySelector('[data-flood-rain-input]');
        const valueEl  = wrap.querySelector('[data-flood-rain]');
        const readoutEl = wrap.querySelector('[data-flood-rain-readout]');

        // Coalesce the expensive on-map frame rebuild to one per animation
        // frame: 'input' fires dozens of times per second during a slider drag,
        // and each perturb() rebuilds every animation frame. The cheap text
        // readout still updates on every event so the UI stays responsive.
        let perturbRaf = null;
        let pendingDepth = 0;

        function updateSim(rainfallMm) {
            if (!valueEl || !readoutEl) return;
            valueEl.textContent = `+${rainfallMm} mm/day`;
            let extraDepth = 0;
            if (typeof FloodSCS !== 'undefined') {
                const result = FloodSCS.rainfallToExtraDepth(rainfallMm);
                extraDepth = result.extra_depth_m;
                readoutEl.textContent =
                    `SCS Curve Number (CN=${result.cn}): ` +
                    `runoff ${result.runoff_mm.toFixed(1)} mm · ` +
                    `extra depth ${extraDepth.toFixed(2)} m`;
            }
            if (typeof FloodInundation !== 'undefined') {
                pendingDepth = extraDepth;
                if (perturbRaf == null) {
                    const raf = (typeof requestAnimationFrame !== 'undefined')
                        ? requestAnimationFrame
                        : (cb) => setTimeout(cb, 16);
                    perturbRaf = raf(() => {
                        perturbRaf = null;
                        FloodInundation.perturb(pendingDepth);
                    });
                }
            }
        }

        if (rangeEl) {
            rangeEl.addEventListener('input', (e) => {
                updateSim(parseFloat(e.target.value) || 0);
            });
        }

        if (mapBtn && typeof FloodInundation !== 'undefined') {
            let isShowing = false;
            mapBtn.addEventListener('click', () => {
                isShowing = !isShowing;
                if (isShowing) {
                    mapBtn.textContent = 'Hide inundation on map';
                    mapBtn.classList.add('flood-widget__btn--active');
                    if (simBlock) simBlock.hidden = false;
                    const cellForMap = cell || {
                        code: `temp:${forecast.location.lat},${forecast.location.lng}`,
                        center: forecast.location,
                    };
                    FloodInundation.attach(cellForMap, forecast).then(() => {
                        // Apply current slider value once tile loads.
                        if (rangeEl) updateSim(parseFloat(rangeEl.value) || 0);
                    });
                } else {
                    mapBtn.textContent = 'Show inundation on map';
                    mapBtn.classList.remove('flood-widget__btn--active');
                    if (simBlock) simBlock.hidden = true;
                    FloodInundation.detach();
                }
            });
        }

        const canvas = wrap.querySelector('canvas');
        const ctx = canvas.getContext('2d');

        // Geometry calculations (do once)
        const innerW = W - PAD.left - PAD.right;
        const innerH = H - PAD.top - PAD.bottom;
        const n = forecast.days.length;
        const xs = forecast.days.map((_, i) => PAD.left + (innerW * i) / (n - 1));

        const allValues = forecast.days.flatMap(d => [d.min, d.max, d.discharge]);
        const yMin = Math.min(...allValues);
        const yMax = Math.max(...allValues);
        const range = Math.max(yMax - yMin, 0.0001);

        const yFor = (v) => PAD.top + innerH - ((v - yMin) / range) * innerH;

        const start = performance.now();
        const DURATION_LINE = 1200;
        const DURATION_BAND = 300;
        const DURATION_DOTS = 500;

        function draw(now) {
            ctx.clearRect(0, 0, W, H);

            const t = now - start;
            const lineProgress = Math.min(1, t / DURATION_LINE);
            const bandProgress = Math.min(1, Math.max(0, (t - DURATION_LINE) / DURATION_BAND));
            const dotsProgress = Math.min(1, Math.max(0, (t - DURATION_LINE - DURATION_BAND) / DURATION_DOTS));

            // 1. min/max band (drawn underneath line, fading in)
            if (bandProgress > 0) {
                ctx.globalAlpha = bandProgress * 0.18;
                ctx.fillStyle = '#3b82f6';
                ctx.beginPath();
                xs.forEach((x, i) => i === 0 ? ctx.moveTo(x, yFor(forecast.days[i].max))
                                              : ctx.lineTo(x, yFor(forecast.days[i].max)));
                for (let i = xs.length - 1; i >= 0; i--) {
                    ctx.lineTo(xs[i], yFor(forecast.days[i].min));
                }
                ctx.closePath();
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // 2. zero/baseline horizontal grid line
            ctx.strokeStyle = (typeof Theme !== 'undefined') ? Theme.fg(0.18) : 'rgba(148,163,184,0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            const ybase = yFor(forecast.baseline_m3s);
            ctx.moveTo(PAD.left, ybase);
            ctx.lineTo(W - PAD.right, ybase);
            ctx.stroke();

            // 3. main discharge line — animated draw from left to right
            const drawnPoints = Math.ceil(lineProgress * (n - 1));
            const partialT = (lineProgress * (n - 1)) - drawnPoints;

            ctx.strokeStyle = forecast.overall_risk.color;
            ctx.lineWidth = 2.2;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            for (let i = 0; i <= drawnPoints; i++) {
                const x = xs[i];
                const y = yFor(forecast.days[i].discharge);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            // partial segment to next point for smooth animation
            if (drawnPoints < n - 1 && partialT > 0) {
                const x0 = xs[drawnPoints], x1 = xs[drawnPoints + 1];
                const y0 = yFor(forecast.days[drawnPoints].discharge);
                const y1 = yFor(forecast.days[drawnPoints + 1].discharge);
                ctx.lineTo(x0 + (x1 - x0) * partialT, y0 + (y1 - y0) * partialT);
            }
            ctx.stroke();

            // 4. day markers (dots) — pulse one-by-one
            if (dotsProgress > 0) {
                const dotCount = Math.ceil(dotsProgress * n);
                for (let i = 0; i < dotCount; i++) {
                    const x = xs[i];
                    const y = yFor(forecast.days[i].discharge);
                    const day = forecast.days[i];
                    // pulse: dot scales from 0 to 1 over 100ms within its slot
                    const dotT = Math.min(1, dotsProgress * n - i);
                    const radius = 3.2 * _easeOutQuad(dotT);
                    ctx.fillStyle = day.risk_color;
                    ctx.beginPath();
                    ctx.arc(x, y, radius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // 5. weekday labels (fade in with line)
            ctx.globalAlpha = lineProgress;
            ctx.fillStyle = (typeof Theme !== 'undefined') ? Theme.fg(0.6) : 'rgba(100,116,139,0.85)';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            forecast.days.forEach((d, i) => {
                const wday = new Date(d.date + 'T00:00:00').getDay();
                ctx.fillText(DAY_LABELS[wday] || '?', xs[i], H - 8);
            });
            ctx.globalAlpha = 1;

            if (t < DURATION_LINE + DURATION_BAND + DURATION_DOTS) {
                requestAnimationFrame(draw);
            }
        }
        requestAnimationFrame(draw);
    }

    return { attachTo };
})();

if (typeof window !== 'undefined') {
    window.FloodAnimation = FloodAnimation;
}
