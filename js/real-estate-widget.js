/**
 * RealEstateWidget — the unified "Property Intelligence" card in the cell panel.
 *
 * Answer-first: it fuses the three previously-scattered real-estate signals into
 * one section with a top-line verdict —
 *   - RealEstateModel.outlook()  → score, appreciation, drivers (always works)
 *   - BuildingIntelligence       → built-form summary + link to the full dialog
 *   - Growth Forecast            → folded in as a "Trajectory" sub-section when
 *                                  the satellite data exists; otherwise it
 *                                  degrades to the live model instead of showing
 *                                  an "unavailable" dead card.
 *
 * A Live / Invest / Build intent toggle re-weights the model (RealEstateModel
 * INTENT_PROFILES) and re-renders. Themed via CSS variables for light/dark.
 */
const RealEstateWidget = (() => {
    const INTENTS = [
        { key: 'live', label: 'Live', hint: 'Homebuyer: safety, schools, green, quiet, flood-safe' },
        { key: 'invest', label: 'Invest', hint: 'Investor: appreciation, jobs, pipeline, access' },
        { key: 'build', label: 'Build', hint: 'Developer: FSI headroom, redevelopment, pipeline' },
    ];
    let _intent = 'invest';   // sticky across cell clicks

    const BAND_COLOR = {
        strong: '#1a9850', above: '#5f8a5a', stable: '#a3781f',
        soft: '#e8765a', weak: '#b3392f', unknown: '#9ca3af',
    };

    /** Escape for safe innerHTML interpolation (defense-in-depth: the fields are
     *  model/constant-derived today, but built-form text traces back to OSM tags). */
    function _esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Insert the card just below the panel header (answer-first), else append. */
    function _place(containerEl, wrap) {
        const header = containerEl.querySelector('.panel-header');
        if (header && header.parentNode === containerEl) header.insertAdjacentElement('afterend', wrap);
        else containerEl.appendChild(wrap);
    }

    /** Render one driver/drag row (▲ green for positive sign, ▼ red for negative). */
    function _driverRow(d, sign) {
        const color = sign > 0 ? 'var(--accent-green,#1a9850)' : 'var(--accent-red,#b3392f)';
        const mark = sign > 0 ? '▲' : '▼';
        return `<div style="display:flex;justify-content:space-between;gap:8px;margin:2px 0;font-size:12px;">
            <span style="color:var(--text-secondary,#5c6166);">${mark} ${_esc(d.label)}</span>
            <span style="color:${color};font-weight:600;">${_esc(d.value)}</span></div>`;
    }

    /** Render (idempotently) the Property Intelligence card into the cell panel. */
    function attachTo(containerEl, data, cell) {
        if (!containerEl) return;
        containerEl.querySelectorAll('[data-re-widget]').forEach(e => e.remove());
        if (typeof RealEstateModel === 'undefined') return;

        const o = RealEstateModel.outlook(data, { intent: _intent });
        const wrap = document.createElement('div');
        wrap.setAttribute('data-re-widget', '');
        wrap.className = 're-widget';
        wrap.style.cssText = 'margin:12px 0;padding:12px;border:1px solid var(--border-color,rgba(40,44,48,.12));'
            + 'border-radius:10px;background:var(--bg-card,rgba(255,255,255,.04));';

        const isLight = (typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light');
        const titleFont = isLight ? "'Newsreader',Georgia,serif" : 'inherit';

        if (o.score == null) {
            wrap.innerHTML = `<div style="font-family:${titleFont};font-weight:600;color:var(--accent-cyan,#dd6b4a);">🏠 Property Intelligence</div>
                <div style="font-size:12px;color:var(--text-secondary,#5c6166);margin-top:6px;">
                    Not enough live data for this cell to model growth.</div>`;
            _place(containerEl, wrap);
            return;
        }

        const color = BAND_COLOR[o.band] || BAND_COLOR.unknown;
        const a = o.appreciation;
        const intentBtns = INTENTS.map(it => `
            <button type="button" data-intent="${it.key}" title="${it.hint}"
                style="flex:1;padding:4px 6px;font-size:11px;font-weight:600;cursor:pointer;border:none;
                background:${it.key === _intent ? 'var(--accent-cyan,#dd6b4a)' : 'transparent'};
                color:${it.key === _intent ? '#fff' : 'var(--text-secondary,#5c6166)'};">${it.label}</button>`).join('');

        const bf = o.builtForm && o.builtForm.text;
        const hasGrowth = !!(data && data.realtime && data.realtime.growth);

        wrap.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <div style="font-family:${titleFont};font-weight:600;font-size:15px;color:var(--accent-cyan,#dd6b4a);">🏠 Property Intelligence</div>
                <span style="background:${color};color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;white-space:nowrap;">${_esc(o.label)}</span>
            </div>
            <div style="display:flex;border:1px solid var(--border-color,rgba(40,44,48,.12));border-radius:6px;overflow:hidden;margin:8px 0;" data-intent-toggle>${intentBtns}</div>
            <div style="display:flex;gap:16px;align-items:baseline;">
                <div><span style="font-size:26px;font-weight:700;color:var(--text-primary,#26282b);">${o.score}</span>
                    <span style="font-size:12px;color:var(--text-secondary,#5c6166);">/100</span></div>
                <div style="font-size:12px;color:var(--text-secondary,#5c6166);">
                    <strong style="color:var(--text-primary,#26282b);">${a.midPct}%/yr</strong> (${a.lowPct}–${a.highPct}%)</div>
            </div>
            <div style="font-size:12px;color:var(--text-primary,#26282b);margin:8px 0;line-height:1.45;">${_esc(o.verdict)}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted,#9aa0a6);margin-bottom:2px;">Drivers</div>
                    ${o.topPositives.map(d => _driverRow(d, 1)).join('') || '<div style="font-size:12px;color:var(--text-muted,#9aa0a6);">—</div>'}</div>
                <div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted,#9aa0a6);margin-bottom:2px;">Drags</div>
                    ${o.topNegatives.map(d => _driverRow(d, -1)).join('') || '<div style="font-size:12px;color:var(--text-muted,#9aa0a6);">—</div>'}</div>
            </div>
            ${bf ? `<div style="margin-top:10px;font-size:12px;color:var(--text-secondary,#5c6166);">
                🏗️ Built form: ${_esc(bf)}
                ${(typeof BuildingIntelDialog !== 'undefined' && data.buildingIntel) ? '<a href="#" data-bi-open style="color:var(--accent-cyan,#dd6b4a);text-decoration:none;margin-left:6px;">details ↗</a>' : ''}</div>` : ''}
            <div data-re-trajectory style="margin-top:10px;"></div>
            <details style="margin-top:8px;">
                <summary style="font-size:11px;color:var(--text-muted,#9aa0a6);cursor:pointer;">ⓘ Methods · ${_esc(o.confidence)} confidence (${_esc(o.factorsUsed)} factors)</summary>
                <div style="font-size:11px;color:var(--text-muted,#9aa0a6);margin-top:4px;line-height:1.4;">
                    Transparent hedonic-style model over live data, retuned by intent. A <em>relative</em>
                    signal, not a price quote. See docs/REAL_ESTATE_MODEL.md.</div>
            </details>`;
        _place(containerEl, wrap);

        // Trajectory: fold the satellite Growth Forecast in when present, else note.
        const traj = wrap.querySelector('[data-re-trajectory]');
        if (hasGrowth && typeof GrowthWidget !== 'undefined') {
            GrowthWidget.attachTo(traj, data.realtime.growth, cell);
        } else {
            traj.innerHTML = `<div style="font-size:11px;color:var(--text-muted,#9aa0a6);">
                📈 Trajectory: live model only — satellite growth history not available for this cell.</div>`;
        }

        // Intent toggle → re-weight + re-render in place.
        wrap.querySelectorAll('[data-intent]').forEach(btn => {
            btn.addEventListener('click', () => {
                _intent = btn.dataset.intent;
                attachTo(containerEl, data, cell);
            });
        });
        wrap.querySelector('[data-bi-open]')?.addEventListener('click', (ev) => {
            ev.preventDefault();
            if (typeof BuildingIntelDialog !== 'undefined' && data.buildingIntel) {
                BuildingIntelDialog.open(data.buildingIntel, cell);
            }
        });
    }

    return { attachTo };
})();

if (typeof window !== 'undefined') window.RealEstateWidget = RealEstateWidget;
