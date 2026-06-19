/**
 * MobilityWidget — renders result.realtime.mobility in the cell panel: the
 * cell's law-and-order access resilience (how easily authorities / emergency
 * vehicles can move/reach it, and whether it can be sealed off). Mirrors
 * TrafficWidget; honest defensive framing in Methods.
 */
const MobilityWidget = (() => {
    /** Map an access class to its badge colour + label, with a neutral fallback. */
    function _info(cls) {
        if (typeof MobilityScore !== 'undefined') {
            const c = MobilityScore.CLASSES.find(x => x.key === cls);
            if (c) return { color: c.color, label: c.key };
        }
        return { color: '#9ca3af', label: cls || 'Unknown' };
    }
    /** HTML-escape a value for safe interpolation into widget markup. */
    function _esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Render the mobility (law-and-order access) card into `containerEl`, or an unavailable note. */
    function attachTo(containerEl, mobility, cell) {
        if (!containerEl) return;
        containerEl.querySelectorAll('[data-mobility-widget]').forEach(e => e.remove());

        if (!mobility) {
            const empty = document.createElement('div');
            empty.setAttribute('data-mobility-widget', '');
            empty.className = 'growth-widget growth-widget--unavailable';
            empty.innerHTML = `
                <div class="growth-widget__title">🛡️ Law &amp; Order Mobility</div>
                <div class="growth-widget__msg">No access-resilience data for this cell.</div>`;
            containerEl.appendChild(empty);
            return;
        }

        const info = _info(mobility.access_class);
        const pol = (mobility.nearest_police_km != null)
            ? `${mobility.nearest_police_km} km to nearest police` : 'Police distance unknown';

        const wrap = document.createElement('div');
        wrap.setAttribute('data-mobility-widget', '');
        wrap.className = 'growth-widget';
        wrap.innerHTML = `
            <div class="growth-widget__header">
                <div class="growth-widget__title">🛡️ Law &amp; Order Mobility</div>
                <span class="growth-widget__badge" style="background:${info.color};">
                    ${_esc(info.label)}
                </span>
            </div>
            <div class="growth-widget__composite">
                Restriction risk: <strong>${mobility.mobility_risk != null ? _esc(mobility.mobility_risk) + '/100' : '—'}</strong>
                ${mobility.sealable ? '<span class="growth-widget__conf">⚠ sealable pocket</span>' : ''}
            </div>
            <div class="growth-widget__why">
                <div class="growth-widget__row">
                    <span class="growth-widget__dim">Police reach</span>
                    <span class="growth-widget__val">${_esc(pol)}</span>
                </div>
                <div class="growth-widget__row">
                    <span class="growth-widget__dim">Chokepoint on access</span>
                    <span class="growth-widget__val">${mobility.on_chokepoint ? 'Yes — rail/gate nearby' : 'None mapped'}</span>
                </div>
            </div>
            <details class="growth-widget__methods">
                <summary>ⓘ Methods · Limitations</summary>
                <div class="growth-widget__methods-body">
                    <p>Access resilience from the OSM road graph: sole-connector links &amp;
                    sealable pockets (2-edge-connected analysis), rail level crossings / gates as
                    chokepoints, and straight-line reach to the nearest police station.</p>
                    <p><strong>Defensive planning aid</strong> — flags where force/ambulance movement
                    can be choked or sealed so access can be kept open. Structural &amp; OSM-derived
                    (arterial network); not a live operational feed.</p>
                </div>
            </details>`;
        containerEl.appendChild(wrap);
    }

    return { attachTo, _info };
})();

if (typeof window !== 'undefined') window.MobilityWidget = MobilityWidget;
