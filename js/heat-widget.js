/**
 * HeatWidget — DOM widget that renders result.realtime.heat in the cell panel.
 *
 * Single-section design (no horizon toggle — UHI is a single-dimensional
 * intensity score). Mirrors the GrowthWidget shape: composite badge,
 * "why this cell" breakdown, idempotent attach, and a collapsible
 * Methods · Limitations disclosure.
 */
const HeatWidget = (() => {
    function _badgeColor(score) {
        if (score == null) return '#9ca3af';
        if (score >= 80) return '#7f1d1d';   // dark red — extreme UHI
        if (score >= 60) return '#dc2626';   // red       — strong UHI
        if (score >= 45) return '#f97316';   // orange    — moderate UHI
        if (score >= 25) return '#dbab09';   // yellow    — mild
        return '#2dba4e';                    // green     — cool / no UHI
    }

    function _badgeLabel(score) {
        if (score == null) return 'NO DATA';
        if (score >= 80) return 'EXTREME HEAT';
        if (score >= 60) return 'STRONG UHI';
        if (score >= 45) return 'MODERATE UHI';
        if (score >= 25) return 'MILD UHI';
        return 'NO HEAT ISLAND';
    }

    function _fmtC(v, digits = 1) {
        if (v == null || Number.isNaN(v)) return '—';
        return `${v.toFixed(digits)}°C`;
    }

    function _fmtSlope(s) {
        if (s == null || Number.isNaN(s)) return '—';
        const sign = s >= 0 ? '+' : '';
        return `${sign}${s.toFixed(2)}°C/yr`;
    }

    function attachTo(containerEl, heat, cell) {
        if (!containerEl) return;
        containerEl.querySelectorAll('[data-heat-widget]').forEach(e => e.remove());

        if (!heat) {
            const empty = document.createElement('div');
            empty.setAttribute('data-heat-widget', '');
            empty.className = 'heat-widget heat-widget--unavailable';
            empty.innerHTML = `
                <div class="heat-widget__title">🌡️ Urban Heat Index</div>
                <div class="heat-widget__msg">Heat data unavailable for this cell.
                    <a href="#" data-heat-retry>Try again</a>
                </div>`;
            containerEl.appendChild(empty);
            empty.querySelector('[data-heat-retry]')?.addEventListener('click', (ev) => {
                ev.preventDefault();
                if (typeof Panel !== 'undefined' && cell) Panel.show(cell);
            });
            return;
        }

        const score = heat.uhi_score;
        const trend = heat.trend || null;
        const slope = trend ? trend.slope_c_per_yr : null;

        const wrap = document.createElement('div');
        wrap.setAttribute('data-heat-widget', '');
        wrap.className = 'heat-widget';
        wrap.innerHTML = `
            <div class="heat-widget__header">
                <div class="heat-widget__title">🌡️ Urban Heat Index</div>
                <span class="heat-widget__badge" style="background:${_badgeColor(score)};">
                    ${_badgeLabel(score)}
                </span>
            </div>
            <div class="heat-widget__composite">
                UHI score: <strong>${score ?? '—'}</strong>
                <span class="heat-widget__conf">(anomaly ${_fmtC(heat.anomaly_c)} vs surroundings)</span>
            </div>
            <div class="heat-widget__why">
                <div class="heat-widget__why-title">Why this cell:</div>
                <div class="heat-widget__row">
                    <span class="heat-widget__dim">Night LST</span>
                    <span class="heat-widget__val">${_fmtC(heat.night_lst_c)}</span>
                </div>
                <div class="heat-widget__row">
                    <span class="heat-widget__dim">Day LST</span>
                    <span class="heat-widget__val">${_fmtC(heat.day_lst_c)}</span>
                </div>
                <div class="heat-widget__row">
                    <span class="heat-widget__dim">Diurnal Δ</span>
                    <span class="heat-widget__val">${_fmtC(heat.diurnal_range_c)}</span>
                </div>
                <div class="heat-widget__row">
                    <span class="heat-widget__dim">YoY trend</span>
                    <span class="heat-widget__val">${_fmtSlope(slope)}</span>
                </div>
            </div>
            <details class="heat-widget__methods">
                <summary>ⓘ Methods · Limitations</summary>
                <div class="heat-widget__methods-body">
                    <p>Source: MODIS/061/MOD11A1 daily 1km Land Surface Temperature,
                    averaged per year for both Day and Night passes across 2016-2024.
                    Night LST is the canonical Urban Heat Island signal — cities cool
                    several degrees less than rural surroundings due to concrete + asphalt
                    heat retention.</p>
                    <p>UHI score is the night-LST anomaly vs surrounding cells, linearly
                    mapped so 0°C → 24, +2°C → 48, +4°C → 72, +6°C → 96. The trend line
                    is OLS over the 9 annual night composites; large slope indicates
                    persistent warming of this specific cell beyond regional drift.</p>
                    <p>Limitations: 1km resolution coarser than a single DigiPin cell, so
                    score reflects the surrounding ~1 km² neighbourhood. Cloudy years may
                    bias the annual mean.</p>
                </div>
            </details>
        `;
        containerEl.appendChild(wrap);
    }

    return { attachTo };
})();

if (typeof window !== 'undefined') window.HeatWidget = HeatWidget;
