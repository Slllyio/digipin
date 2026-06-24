/**
 * GrowthWidget — DOM widget that renders result.realtime.growth in the cell panel.
 *
 * Spec §7.1 — three-horizon toggle, composite + confidence band, driver
 * attribution, collapsible Methods · Limitations.
 */
const GrowthWidget = (() => {
    const HORIZONS = [
        { key: 'nowcast', label: 'Now' },
        { key: 'year_2',  label: '1–2 yr' },
        { key: 'year_5',  label: '5 yr' },
    ];
    let _activeHorizon = 'nowcast';  // sticky across cell clicks

    function _badgeColor(composite) {
        if (composite == null) return '#9ca3af';
        if (composite >= 75) return '#dc2626';
        if (composite >= 60) return '#f97316';
        if (composite >= 45) return '#dbab09';
        return '#2dba4e';
    }

    function _badgeLabel(composite) {
        if (composite == null) return 'NO DATA';
        if (composite >= 75) return 'HIGH GROWTH';
        if (composite >= 60) return 'GROWING';
        if (composite >= 45) return 'MODERATE';
        return 'STABLE';
    }

    function attachTo(containerEl, growth, cell) {
        if (!containerEl) return;
        containerEl.querySelectorAll('[data-growth-widget]').forEach(e => e.remove());

        if (!growth) {
            const empty = document.createElement('div');
            empty.setAttribute('data-growth-widget', '');
            empty.className = 'growth-widget growth-widget--unavailable';
            empty.innerHTML = `
                <div class="growth-widget__title">📈 Growth Forecast</div>
                <div class="growth-widget__msg">Growth data unavailable for this cell.
                    <a href="#" data-growth-retry>Try again</a>
                </div>`;
            containerEl.appendChild(empty);
            empty.querySelector('[data-growth-retry]')?.addEventListener('click', (ev) => {
                ev.preventDefault();
                if (typeof Panel !== 'undefined' && cell) Panel.show(cell);
            });
            return;
        }

        const h = growth.horizons[_activeHorizon] || growth.horizons.nowcast;
        const composite = h.composite;

        const wrap = document.createElement('div');
        wrap.setAttribute('data-growth-widget', '');
        wrap.className = 'growth-widget';
        wrap.innerHTML = `
            <div class="growth-widget__header">
                <div class="growth-widget__title">📈 Growth Forecast</div>
                <span class="growth-widget__badge" style="background:${_badgeColor(composite)};">
                    ${_badgeLabel(composite)}
                </span>
            </div>
            <div class="growth-widget__horizons" data-horizon-toggle>
                ${HORIZONS.map(x => `
                    <button type="button" data-h="${x.key}"
                            class="growth-widget__h ${x.key === _activeHorizon ? 'is-active' : ''}">
                        ${x.label}
                    </button>`).join('')}
            </div>
            <div class="growth-widget__composite">
                Composite: <strong>${composite ?? '—'}</strong>
                <span class="growth-widget__conf">(±${h.confidence_band} confidence)</span>
            </div>
            <div class="growth-widget__why">
                <div class="growth-widget__why-title">Why this cell:</div>
                ${['bue', 'den', 'cap'].map(dim => {
                    const s = h.sub_scores[dim];
                    const label = { bue: 'Built-up', den: 'Densify', cap: 'Capital' }[dim];
                    return `<div class="growth-widget__row">
                        <span class="growth-widget__dim">${label}</span>
                        <span class="growth-widget__dir">${s.direction}</span>
                        <span class="growth-widget__val">${s.value ?? '—'}</span>
                    </div>`;
                }).join('')}
            </div>
            <details class="growth-widget__methods">
                <summary>ⓘ Methods · Limitations</summary>
                <div class="growth-widget__methods-body">
                    <p>Sources: Google Open Buildings Temporal V1 (4m, 2016-2023), GHSL Pop Grid,
                    VIIRS night lights, OSM construction signals, MP RERA pipeline.</p>
                    <p>Nowcast describes observed change. 1-2 year anchors on approved RERA projects.
                    5-year is linear-trend extrapolation, not a real forecast — wide confidence band
                    reflects this.</p>
                </div>
            </details>
        `;
        containerEl.appendChild(wrap);

        wrap.querySelectorAll('[data-h]').forEach(btn => {
            btn.addEventListener('click', () => {
                _activeHorizon = btn.dataset.h;
                growth.active_horizon = _activeHorizon;
                attachTo(containerEl, growth, cell);   // re-render
            });
        });
    }

    return { attachTo };
})();

if (typeof window !== 'undefined') window.GrowthWidget = GrowthWidget;
