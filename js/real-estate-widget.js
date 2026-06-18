/**
 * RealEstateWidget — renders RealEstateModel.outlook() in the cell panel.
 *
 * Complements the (satellite-dependent) Growth Forecast: this one always works
 * because it runs on the live OSM/score/flood data the cell already has. Shows
 * the growth-potential score, an estimated annual-appreciation band, and the
 * ranked drivers (what lifts the outlook vs what drags it). Themed via CSS
 * variables so it follows the Aino light / dark themes without extra CSS.
 */
const RealEstateWidget = (() => {
    const BAND_COLOR = {
        strong: '#1a9850', above: '#5f8a5a', stable: '#a3781f',
        soft: '#e8765a', weak: '#b3392f', unknown: '#9ca3af',
    };

    function _row(d, sign) {
        const color = sign > 0 ? 'var(--accent-green, #1a9850)' : 'var(--accent-red, #b3392f)';
        const mark = sign > 0 ? '▲' : '▼';
        return `<div style="display:flex;justify-content:space-between;gap:8px;margin:2px 0;font-size:12px;">
            <span style="color:var(--text-secondary,#5c6166);">${mark} ${d.label}</span>
            <span style="color:${color};font-weight:600;">${d.value}</span>
        </div>`;
    }

    function attachTo(containerEl, data, cell) {
        if (!containerEl) return;
        containerEl.querySelectorAll('[data-re-widget]').forEach(e => e.remove());
        if (typeof RealEstateModel === 'undefined') return;

        const o = RealEstateModel.outlook(data);
        const wrap = document.createElement('div');
        wrap.setAttribute('data-re-widget', '');
        wrap.className = 're-widget';
        wrap.style.cssText = 'margin:12px 0;padding:12px;border:1px solid var(--border-color,rgba(40,44,48,.12));'
            + 'border-radius:10px;background:var(--bg-card,rgba(255,255,255,.04));';

        if (o.score == null) {
            wrap.innerHTML = `<div style="font-weight:600;color:var(--accent-cyan,#dd6b4a);">🏠 Real Estate Outlook</div>
                <div style="font-size:12px;color:var(--text-secondary,#5c6166);margin-top:6px;">
                    Not enough live data for this cell to model growth.</div>`;
            containerEl.appendChild(wrap);
            return;
        }

        const color = BAND_COLOR[o.band] || BAND_COLOR.unknown;
        const a = o.appreciation;
        const titleFont = (typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light')
            ? "'Newsreader',Georgia,serif" : 'inherit';

        wrap.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;">
                <div style="font-family:${titleFont};font-weight:600;font-size:15px;color:var(--accent-cyan,#dd6b4a);">
                    🏠 Real Estate Outlook</div>
                <span style="background:${color};color:#fff;font-size:11px;font-weight:600;
                    padding:2px 8px;border-radius:10px;">${o.label}</span>
            </div>
            <div style="display:flex;gap:18px;align-items:baseline;margin:10px 0 4px;">
                <div><span style="font-size:26px;font-weight:700;color:var(--text-primary,#26282b);">${o.score}</span>
                    <span style="font-size:12px;color:var(--text-secondary,#5c6166);">/100 growth potential</span></div>
            </div>
            <div style="font-size:12px;color:var(--text-secondary,#5c6166);margin-bottom:8px;">
                Est. appreciation: <strong style="color:var(--text-primary,#26282b);">${a.midPct}%/yr</strong>
                <span>(${a.lowPct}–${a.highPct}%)</span></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted,#9aa0a6);margin-bottom:2px;">Drivers</div>
                    ${o.topPositives.map(d => _row(d, 1)).join('') || '<div style="font-size:12px;color:var(--text-muted,#9aa0a6);">—</div>'}</div>
                <div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted,#9aa0a6);margin-bottom:2px;">Drags</div>
                    ${o.topNegatives.map(d => _row(d, -1)).join('') || '<div style="font-size:12px;color:var(--text-muted,#9aa0a6);">—</div>'}</div>
            </div>
            <details style="margin-top:8px;">
                <summary style="font-size:11px;color:var(--text-muted,#9aa0a6);cursor:pointer;">ⓘ Methods · ${o.confidence} confidence (${o.factorsUsed} factors)</summary>
                <div style="font-size:11px;color:var(--text-muted,#9aa0a6);margin-top:4px;line-height:1.4;">
                    Transparent hedonic-style model over live data: accessibility, walkability, jobs,
                    green, schools &amp; healthcare (demand); development potential, construction pipeline &amp;
                    redevelopment (supply); flood, air &amp; noise (risk). Weights reflect the hedonic
                    property-value literature. A <em>relative</em> signal, not a price quote.</div>
            </details>`;
        containerEl.appendChild(wrap);
    }

    return { attachTo };
})();

if (typeof window !== 'undefined') window.RealEstateWidget = RealEstateWidget;
