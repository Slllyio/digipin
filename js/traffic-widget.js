/**
 * TrafficWidget — renders result.realtime.traffic in the cell panel.
 *
 * Mirrors GrowthWidget/HeatWidget: a compact card with the cell's structural
 * congestion grade, dominant road class, critical-link flag, and transit access,
 * plus a collapsible Methods · Limitations with honest framing. Pure DOM; drops
 * to an "unavailable" note when there's no traffic signal for the cell.
 */
const TrafficWidget = (() => {
    // LOS grade → colour + plain label (matches TrafficOverlay BANDS).
    const LOS = {
        A: { color: '#31a354', label: 'Free-flow' },
        B: { color: '#74c476', label: 'Stable' },
        C: { color: '#fc8d59', label: 'Busy' },
        D: { color: '#ef6548', label: 'Congested' },
        E: { color: '#d7301f', label: 'At capacity' },
        F: { color: '#7f0000', label: 'Breakdown' },
    };

    function _losInfo(grade) { return LOS[grade] || { color: '#9ca3af', label: 'Unknown' }; }

    function _esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function attachTo(containerEl, traffic, cell) {
        if (!containerEl) return;
        containerEl.querySelectorAll('[data-traffic-widget]').forEach(e => e.remove());

        if (!traffic) {
            const empty = document.createElement('div');
            empty.setAttribute('data-traffic-widget', '');
            empty.className = 'growth-widget growth-widget--unavailable';
            empty.innerHTML = `
                <div class="growth-widget__title">🚦 Traffic</div>
                <div class="growth-widget__msg">No structural traffic data for this cell.</div>`;
            containerEl.appendChild(empty);
            return;
        }

        const grade = traffic.los_grade;
        const info = _losInfo(grade);
        const t = traffic.transit;
        const transitLine = (t && t.stops)
            ? `${t.stops} stop${t.stops === 1 ? '' : 's'}`
                + (t.headway_min != null ? ` · ~${Math.round(t.headway_min)} min headway` : '')
                + (t.access_score != null ? ` · access ${t.access_score}/100` : '')
            : 'No transit stops in cell';

        const wrap = document.createElement('div');
        wrap.setAttribute('data-traffic-widget', '');
        wrap.className = 'growth-widget';
        wrap.innerHTML = `
            <div class="growth-widget__header">
                <div class="growth-widget__title">🚦 Traffic</div>
                <span class="growth-widget__badge" style="background:${info.color};">
                    LOS ${_esc(grade || '—')} · ${_esc(info.label)}
                </span>
            </div>
            <div class="growth-widget__composite">
                Congestion risk: <strong>${traffic.congestion_risk != null ? _esc(traffic.congestion_risk) + '/100' : '—'}</strong>
                ${traffic.has_critical_link ? '<span class="growth-widget__conf">⚠ critical link</span>' : ''}
            </div>
            <div class="growth-widget__why">
                <div class="growth-widget__row">
                    <span class="growth-widget__dim">Main road</span>
                    <span class="growth-widget__val">${_esc(traffic.dominant_road_class || '—')}</span>
                </div>
                <div class="growth-widget__row">
                    <span class="growth-widget__dim">Transit</span>
                    <span class="growth-widget__val">${_esc(transitLine)}</span>
                </div>
            </div>
            <details class="growth-widget__methods">
                <summary>ⓘ Methods · Limitations</summary>
                <div class="growth-widget__methods-body">
                    <p>Structural congestion from the OSM road graph: betweenness centrality
                    (through-traffic load proxy) ÷ road-class capacity → Level of Service (A–F).
                    Transit access from GTFS stop density &amp; frequency.</p>
                    <p><strong>Not real-time.</strong> This shows where load concentrates by network
                    design — bottlenecks &amp; transit gaps — not current delays. For live traffic use
                    a routing app.</p>
                </div>
            </details>`;
        containerEl.appendChild(wrap);
    }

    return { attachTo, _losInfo };
})();

if (typeof window !== 'undefined') window.TrafficWidget = TrafficWidget;
