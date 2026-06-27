/**
 * SiteBrief — paper-model "automated site research" card.
 *
 * Paper turns a location into a presentation-ready site brief in one glance. This
 * module rolls the cell's already-computed intelligence scores (+ a little
 * context) into a structured brief model, then renders it as a printable /
 * copyable floating card: a verdict-banded scores grid, a one-line auto-narrative
 * per metric, and source attribution. Print uses the browser print dialog against
 * a print-only stylesheet (see css/styles.css); Copy puts a plain-text brief on
 * the clipboard.
 *
 * build()/text() are pure (unit-tested); open() is DOM.
 */
const SiteBrief = (() => {
    // Banding mirrors Theme.scoreColor (≥70 good / ≥40 fair / else poor) and is
    // self-contained so build() stays pure even without the Theme module.
    function _band(value) {
        if (value >= 70) return { band: 'Strong', tone: 'good' };
        if (value >= 40) return { band: 'Moderate', tone: 'fair' };
        return { band: 'Weak', tone: 'poor' };
    }

    /** Verdict colour for a score value (Theme.scoreColor, with a fallback). */
    function _color(value, tone) {
        if (typeof Theme !== 'undefined' && Theme.scoreColor) return Theme.scoreColor(value);
        return tone === 'good' ? '#5f8a5a' : tone === 'fair' ? '#a3781f' : '#b3392f';
    }

    // A short, plain-language read for each metric/band — the "narrative" line.
    function _note(label, band) {
        const l = String(label || 'This factor');
        if (band === 'Strong') return `${l}: favourable for this location.`;
        if (band === 'Moderate') return `${l}: mixed — worth a closer look.`;
        return `${l}: a constraint to plan around here.`;
    }

    /**
     * Build the brief model from a fetched cell-data object. Pure.
     * @returns {{code,city,generatedAt,metrics:Array,population:?number}}
     */
    function build(cellData, cell) {
        const data = cellData || {};
        const metrics = [];
        const scores = data.scores || {};
        for (const [key, s] of Object.entries(scores)) {
            if (!s || !Number.isFinite(s.value)) continue;
            const value = Math.round(s.value);
            const { band, tone } = _band(value);
            metrics.push({
                key,
                label: s.label || key,
                value,
                band,
                tone,
                color: _color(value, tone),
                note: _note(s.label || key, band),
            });
        }
        // Headline metrics first (highest then lowest are most "presentation-worthy"),
        // but keep a stable order: by value descending.
        metrics.sort((a, b) => b.value - a.value);

        // A little context, defensively pulled if present.
        let population = null;
        const pop = data.population || (data.categories && data.categories.population);
        if (pop && Number.isFinite(pop.total)) population = Math.round(pop.total);

        return {
            code: (cell && cell.code) || data.code || null,
            city: (typeof CitySelector !== 'undefined' && CitySelector.getCurrent)
                ? (() => { const c = CitySelector.getCurrent(); return c ? `${c.name}, ${c.state}` : null; })()
                : null,
            generatedAt: new Date().toISOString().slice(0, 10),
            metrics,
            population,
        };
    }

    /** Plain-text rendering of a brief model — for the clipboard. Pure. */
    function text(model) {
        if (!model) return '';
        const lines = [];
        lines.push('DigiPin Site Brief');
        if (model.code) lines.push(`DIGIPIN: ${model.code}`);
        if (model.city) lines.push(`Location: ${model.city}`);
        if (model.population != null) lines.push(`Population (cell est.): ${model.population.toLocaleString()}`);
        lines.push(`Generated: ${model.generatedAt}`);
        lines.push('');
        for (const m of model.metrics) {
            lines.push(`- ${m.label}: ${m.value}/100 (${m.band}) — ${m.note}`);
        }
        lines.push('');
        lines.push('Computed from Indian civic & OpenStreetMap data on the government DIGIPIN grid — open and auditable.');
        return lines.join('\n');
    }

    /** Comma-list a set of metric labels with an Oxford-style "and". */
    function _listLabels(metrics) {
        const names = metrics.map(m => m.label);
        if (names.length <= 1) return names[0] || '';
        if (names.length === 2) return `${names[0]} and ${names[1]}`;
        return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
    }

    /**
     * A plain-language summary paragraph derived from the brief model — the
     * default narrative, used when no AI provider elaborates it. Pure.
     */
    function narrative(model) {
        if (!model || !model.metrics || !model.metrics.length) {
            return 'No intelligence scores are available for this site yet — select a cell and let its data load.';
        }
        const loc = model.code ? `DIGIPIN ${model.code}` : 'This site';
        const strong = model.metrics.filter(m => m.band === 'Strong');
        const weak = model.metrics.filter(m => m.band === 'Weak');
        let s = strong.length
            ? `${loc} scores strongly on ${_listLabels(strong)}`
            : `${loc} shows no standout strengths in the current scores`;
        if (weak.length) s += `, and is most constrained by ${_listLabels(weak)}`;
        s += '.';
        if (model.population != null) {
            s += ` Estimated cell population is about ${model.population.toLocaleString()}.`;
        }
        return s;
    }

    /** HTML-escape a value for safe interpolation into the dialog markup. */
    function _esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Close the brief dialog and restore focus to the opener. */
    function close() {
        document.getElementById('site-brief-backdrop')?.remove();
        if (close._restoreFocus && typeof close._restoreFocus.focus === 'function') {
            try { close._restoreFocus.focus({ preventScroll: true }); } catch { /* element gone */ }
            close._restoreFocus = null;
        }
    }

    /** Build + show the printable/copyable brief dialog. */
    function open(cellData, cell) {
        close();
        close._restoreFocus = (typeof document !== 'undefined') ? document.activeElement : null;
        const model = build(cellData, cell);

        const backdrop = document.createElement('div');
        backdrop.id = 'site-brief-backdrop';
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

        const card = document.createElement('div');
        card.className = 'site-brief';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', 'Site brief');

        const metricRows = model.metrics.map(m => `
            <div class="sb-metric">
                <div class="sb-metric-head">
                    <span class="sb-metric-label">${_esc(m.label)}</span>
                    <span class="sb-metric-value" style="color:${_esc(m.color)}">${m.value}<span class="sb-metric-band"> · ${_esc(m.band)}</span></span>
                </div>
                <div class="sb-bar-bg"><div class="sb-bar" style="width:${m.value}%;background:${_esc(m.color)}"></div></div>
                <div class="sb-note">${_esc(m.note)}</div>
            </div>`).join('');

        card.innerHTML = `
            <button class="sb-close" aria-label="Close site brief">✕</button>
            <div class="sb-header">
                <div class="sb-title">Site Brief</div>
                <div class="sb-sub">${model.code ? `DIGIPIN ${_esc(model.code)}` : ''}${model.city ? `  ·  ${_esc(model.city)}` : ''}</div>
            </div>
            <p class="sb-narrative">${_esc(narrative(model))}</p>
            ${model.population != null ? `<div class="sb-context">Population (cell est.): <b>${model.population.toLocaleString()}</b></div>` : ''}
            <div class="sb-metrics">${metricRows || '<div class="sb-empty">No scores computed yet for this cell.</div>'}</div>
            <div class="sb-foot">Computed from Indian civic &amp; OpenStreetMap data on the government DIGIPIN grid — open and auditable. Generated ${_esc(model.generatedAt)}.</div>
            <div class="sb-actions">
                ${(typeof DISHAPanel !== 'undefined' && typeof DISHAPanel.open === 'function') ? '<button class="sb-btn sb-ai">✨ Ask DISHA</button>' : ''}
                <button class="sb-btn sb-copy">Copy summary</button>
                <button class="sb-btn sb-print">Print / PDF</button>
            </div>`;

        const aiBtn = card.querySelector('.sb-ai');
        if (aiBtn) aiBtn.addEventListener('click', () => {
            if (typeof DISHAPanel !== 'undefined' && cell && cellData) {
                DISHAPanel.open(cell, cellData);   // grounds DISHA on this cell's data
                const input = document.getElementById('disha-input');
                if (input) input.value = 'Summarise this site for a stakeholder in 3 sentences, highlighting its strengths and constraints.';
            } else if (typeof App !== 'undefined') {
                App.showToast('Site brief', 'AI assistant is unavailable.', 'info');
            }
        });

        card.querySelector('.sb-close').addEventListener('click', close);
        card.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
        card.querySelector('.sb-print').addEventListener('click', () => {
            document.body.classList.add('printing-brief');
            const cleanup = () => { document.body.classList.remove('printing-brief'); window.removeEventListener('afterprint', cleanup); };
            window.addEventListener('afterprint', cleanup);
            window.print();
        });
        card.querySelector('.sb-copy').addEventListener('click', async () => {
            const txt = text(model);
            try {
                await navigator.clipboard.writeText(txt);
                if (typeof App !== 'undefined') App.showToast('Site brief', 'Summary copied to clipboard.', 'success');
            } catch {
                if (typeof App !== 'undefined') App.showToast('Site brief', 'Copy failed — your browser blocked clipboard access.', 'warning');
            }
        });

        backdrop.appendChild(card);
        document.body.appendChild(backdrop);
        card.querySelector('.sb-close')?.focus();
    }

    return { build, text, narrative, open, close };
})();

if (typeof window !== 'undefined') {
    window.SiteBrief = SiteBrief;
}
