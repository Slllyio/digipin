/**
 * Comparative Analysis — Pin up to 3 cells and compare side-by-side
 */
const Compare = (() => {
    const MAX_PINS = 3;
    // Pin colours follow the active theme (a theme switch reloads, so resolving
    // once at module load is enough): neon on dark, ink-coral on paper.
    const COLORS = (typeof Theme !== 'undefined' && Theme.get && Theme.get() === 'light')
        ? ['#c2410c', '#7c3aed', '#be185d']
        : ['#00f5ff', '#a855f7', '#ec4899'];
    let _pinned = []; // { cell, data, marker }

    function pin(cell, data) {
        if (_pinned.length >= MAX_PINS) {
            App.showToast('Compare Full', `Max ${MAX_PINS} pins. Remove one first.`, 'warning');
            return;
        }
        if (_pinned.some(p => p.cell.code === cell.code)) {
            App.showToast('Already Pinned', `${cell.code} is already in compare`, 'warning');
            return;
        }

        const color = COLORS[_pinned.length];
        const el = document.createElement('div');
        el.style.width = '20px';
        el.style.height = '20px';
        el.style.backgroundColor = color;
        el.style.border = `3px solid ${color}`;
        el.style.borderWidth = '3px';
        el.style.opacity = '0.6';
        el.style.borderRadius = '50%';

        const popupDiv = document.createElement('div');
        popupDiv.style.fontFamily = 'Inter, sans-serif';
        popupDiv.textContent = `Pin ${_pinned.length + 1}: ${cell.code}`;
        
        const popup = new maplibregl.Popup({ offset: 15 }).setDOMContent(popupDiv);

        const marker = new maplibregl.Marker({ element: el })
            .setLngLat([cell.center.lng, cell.center.lat])
            .setPopup(popup)
            .addTo(MapModule.getMap());

        _pinned.push({ cell, data, marker });
        updateBadge();
        App.showToast('Cell Pinned', `${cell.code} added to compare (${_pinned.length}/${MAX_PINS})`, 'success');
    }

    /** Remove a pinned cell (by code), drop its marker and refresh the badge. */
    function unpin(code) {
        const idx = _pinned.findIndex(p => p.cell.code === code);
        if (idx === -1) return;
        _pinned[idx].marker.remove();
        _pinned.splice(idx, 1);
        updateBadge();
    }

    /** Remove all pins and markers and close the compare panel. */
    function clearAll() {
        _pinned.forEach(p => p.marker.remove());
        _pinned = [];
        updateBadge();
        closePanel();
    }

    /** Sync the toolbar badge count and muted/accent state to the pin count. */
    function updateBadge() {
        const badge = document.getElementById('compare-badge');
        if (badge) {
            badge.textContent = String(_pinned.length);
            // Always visible — muted at 0 (advertises Compare), accent when pinned.
            badge.classList.toggle('toolbar-badge--empty', _pinned.length === 0);
        }
    }

    /** Get the array of pinned entries ({ cell, data, marker }). */
    function getPinned() { return _pinned; }

    /** CSV-escape a field (quote when it contains a comma, quote or newline). Pure. */
    function _csvEscape(s) {
        const v = String(s == null ? '' : s);
        return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }

    /** Build a comparison CSV string from pinned entries (Metric × cells). Pure. */
    function buildCSV(pinned) {
        const rows = [];
        rows.push(['Metric', ...pinned.map(p => p.cell.code)]);
        rows.push(['Address', ...pinned.map(p => {
            const a = p.data.address || {};
            return [a.area, a.city].filter(Boolean).join(', ') || 'Unknown';
        })]);
        rows.push(['Latitude', ...pinned.map(p => p.cell.center ? p.cell.center.lat : '')]);
        rows.push(['Longitude', ...pinned.map(p => p.cell.center ? p.cell.center.lng : '')]);
        const keys = new Set();
        pinned.forEach(p => Object.keys(p.data.scores || {}).forEach(k => keys.add(k)));
        [...keys].forEach(k => {
            const label = (pinned.find(p => p.data.scores && p.data.scores[k])
                || { data: { scores: {} } }).data.scores[k]?.label || k;
            rows.push([label, ...pinned.map(p => {
                const v = p.data.scores && p.data.scores[k] ? p.data.scores[k].value : null;
                return v == null ? '' : v;
            })]);
        });
        return rows.map(r => r.map(_csvEscape).join(',')).join('\n');
    }

    /** Download the current comparison as a CSV file. */
    function exportCSV() {
        if (_pinned.length < 2) {
            App.showToast('Need 2+ Pins', 'Pin at least 2 cells to export', 'warning');
            return;
        }
        const csv = buildCSV(_pinned);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `digipin-compare-${_pinned.map(p => p.cell.code).join('_')}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Open the compare panel and render it (requires 2+ pins). */
    function openPanel() {
        if (_pinned.length < 2) {
            App.showToast('Need 2+ Pins', 'Pin at least 2 cells to compare', 'warning');
            return;
        }
        const panel = document.getElementById('compare-panel');
        if (!panel) return;
        panel.classList.add('open');
        renderComparison();
    }

    /** Close the compare panel. */
    function closePanel() {
        const panel = document.getElementById('compare-panel');
        if (panel) panel.classList.remove('open');
    }

    /** Rebuild the compare table (verdict rows, per-score rows, overlay radar). */
    function renderComparison() {
        const container = document.getElementById('compare-content');
        if (!container) return;
        while (container.firstChild) container.removeChild(container.firstChild);

        // Header row
        const headerRow = document.createElement('div');
        headerRow.className = 'compare-row compare-header-row';
        const emptyCell = document.createElement('div');
        emptyCell.className = 'compare-label';
        emptyCell.textContent = 'Score';
        headerRow.appendChild(emptyCell);

        _pinned.forEach((p, i) => {
            const cellHeader = document.createElement('div');
            cellHeader.className = 'compare-cell-header';
            cellHeader.style.borderColor = COLORS[i];

            const codeEl = document.createElement('div');
            codeEl.className = 'compare-code';
            codeEl.textContent = p.cell.code;
            codeEl.style.color = COLORS[i];

            const addrEl = document.createElement('div');
            addrEl.className = 'compare-addr';
            const addr = p.data.address || {};
            addrEl.textContent = [addr.area, addr.city].filter(Boolean).join(', ') || 'Unknown';

            const removeBtn = document.createElement('button');
            removeBtn.className = 'compare-remove-btn';
            removeBtn.textContent = '\u2715';
            removeBtn.addEventListener('click', () => { unpin(p.cell.code); renderComparison(); });

            cellHeader.appendChild(codeEl);
            cellHeader.appendChild(addrEl);
            cellHeader.appendChild(removeBtn);
            headerRow.appendChild(cellHeader);
        });
        container.appendChild(headerRow);

        // Actions bar — export the comparison.
        const actions = document.createElement('div');
        actions.className = 'compare-actions';
        const exportBtn = document.createElement('button');
        exportBtn.className = 'compare-export-btn';
        exportBtn.type = 'button';
        exportBtn.textContent = '↓ Export CSV';
        exportBtn.addEventListener('click', exportCSV);
        actions.appendChild(exportBtn);
        container.appendChild(actions);

        // Property Intelligence verdict rows (answer-first): each cell's growth
        // score, outlook label and appreciation band, best score highlighted.
        _appendVerdictRows(container);

        // Score rows — collect all score keys
        const allKeys = new Set();
        _pinned.forEach(p => {
            Object.keys(p.data.scores || {}).forEach(k => allKeys.add(k));
        });

        [...allKeys].forEach(key => {
            const row = document.createElement('div');
            row.className = 'compare-row';

            const label = document.createElement('div');
            label.className = 'compare-label';
            const firstScore = _pinned.find(p => p.data.scores?.[key])?.data.scores[key];
            label.textContent = firstScore?.label || key;
            row.appendChild(label);

            // Find best value for highlighting
            const values = _pinned.map(p => p.data.scores?.[key]?.value ?? null);
            const validValues = values.filter(v => v !== null);
            const maxVal = Math.max(...validValues);

            _pinned.forEach((p, i) => {
                const val = p.data.scores?.[key]?.value;
                const cell = document.createElement('div');
                cell.className = 'compare-value';

                if (val != null) {
                    cell.textContent = String(val);
                    cell.style.color = (typeof Theme !== 'undefined' && Theme.scoreColor) ? Theme.scoreColor(val) : (val >= 70 ? '#22c55e' : val >= 40 ? '#eab308' : '#ef4444');
                    if (val === maxVal && validValues.length > 1) {
                        cell.classList.add('compare-best');
                    }
                } else {
                    cell.textContent = '-';
                    cell.style.color = (typeof Theme !== 'undefined' && Theme.palette) ? Theme.palette().sub : '#64748b';
                }
                row.appendChild(cell);
            });

            container.appendChild(row);
        });

        // Overlay radar chart
        renderOverlayRadar();
    }

    /** Top verdict block: growth score / outlook / appreciation per pinned cell. */
    function _appendVerdictRows(container) {
        if (typeof RealEstateModel === 'undefined') return;
        const outlooks = _pinned.map(p => RealEstateModel.outlook(p.data));
        const sub = (typeof Theme !== 'undefined' && Theme.palette) ? Theme.palette().sub : '#64748b';

        /** Append one labelled verdict row, rendering a cell per pinned outlook. */
        const addRow = (label, render, opts = {}) => {
            const row = document.createElement('div');
            row.className = 'compare-row' + (opts.headerish ? ' compare-verdict-row' : '');
            const lab = document.createElement('div');
            lab.className = 'compare-label';
            lab.textContent = label;
            row.appendChild(lab);
            outlooks.forEach((o, i) => {
                const c = document.createElement('div');
                c.className = 'compare-value';
                render(c, o, i);
                row.appendChild(c);
            });
            container.appendChild(row);
        };

        // Growth score (highlight the best among >1 valid)
        const scores = outlooks.map(o => (o && o.score != null) ? o.score : null);
        const valid = scores.filter(v => v != null);
        const best = valid.length ? Math.max(...valid) : null;
        addRow('Growth score', (c, o) => {
            if (o.score == null) { c.textContent = '-'; c.style.color = sub; return; }
            c.textContent = String(o.score);
            c.style.color = (typeof Theme !== 'undefined' && Theme.scoreColor) ? Theme.scoreColor(o.score)
                : (o.score >= 70 ? '#22c55e' : o.score >= 40 ? '#eab308' : '#ef4444');
            if (o.score === best && valid.length > 1) c.classList.add('compare-best');
        }, { headerish: true });

        addRow('Outlook', (c, o) => {
            c.textContent = o.label || '-';
            c.style.color = sub;
            c.style.fontSize = '11px';
        });

        addRow('Est. appreciation', (c, o) => {
            c.textContent = o.appreciation ? `${o.appreciation.midPct}%/yr` : '-';
            c.style.color = sub;
        });

        // Structural traffic (from the per-cell traffic grid), when present.
        const traffics = _pinned.map(p => p && p.data && p.data.realtime && p.data.realtime.traffic);
        if (traffics.some(t => t)) {
            addRow('Congestion (LOS)', (c, o, i) => {
                const t = traffics[i];
                if (!t || t.los_grade == null) { c.textContent = '-'; c.style.color = sub; return; }
                c.textContent = `${t.los_grade}${t.congestion_risk != null ? ' · ' + t.congestion_risk : ''}`;
                c.style.color = sub;
            });
            addRow('Transit access', (c, o, i) => {
                const t = traffics[i];
                const a = t && t.transit && t.transit.access_score;
                c.textContent = (a != null) ? `${a}/100` : '-';
                c.style.color = sub;
            });
        }
    }

    /** Draw the overlaid radar chart of common scores for all pinned cells. */
    function renderOverlayRadar() {
        const canvas = document.getElementById('compare-radar');
        if (!canvas || _pinned.length < 2) return;

        const dpr = window.devicePixelRatio || 1;
        const cssW = 350, cssH = 350;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, cssW, cssH);

        const cx = cssW / 2, cy = cssH / 2, r = Math.min(cx, cy) - 40;

        // Collect common score keys
        const allKeys = new Set();
        _pinned.forEach(p => Object.keys(p.data.scores || {}).forEach(k => allKeys.add(k)));
        const keys = [...allKeys].filter(k => _pinned.every(p => p.data.scores?.[k]?.value !== undefined));
        const n = keys.length;
        if (n < 3) return;

        // Rings
        for (let i = 1; i <= 4; i++) {
            ctx.beginPath();
            const rr = (r * i) / 4;
            for (let j = 0; j <= n; j++) {
                const angle = (Math.PI * 2 * j) / n - Math.PI / 2;
                j === 0 ? ctx.moveTo(cx + rr * Math.cos(angle), cy + rr * Math.sin(angle))
                        : ctx.lineTo(cx + rr * Math.cos(angle), cy + rr * Math.sin(angle));
            }
            ctx.closePath();
            ctx.strokeStyle = (typeof Theme !== 'undefined') ? Theme.fg(0.06) : 'rgba(255,255,255,0.06)';
            ctx.stroke();
        }

        // Labels
        keys.forEach((k, i) => {
            const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
            const lx = cx + (r + 22) * Math.cos(angle);
            const ly = cy + (r + 22) * Math.sin(angle);
            ctx.fillStyle = (typeof Theme !== 'undefined') ? Theme.fg(0.4) : 'rgba(255,255,255,0.4)';
            ctx.font = '8px Inter';
            ctx.textAlign = Math.abs(Math.cos(angle)) < 0.3 ? 'center' : Math.cos(angle) > 0 ? 'left' : 'right';
            const label = _pinned[0].data.scores[k]?.label || k;
            ctx.fillText(label.length > 10 ? label.substring(0, 9) + '.' : label, lx, ly + 3);
        });

        // Draw each pinned cell's polygon
        _pinned.forEach((p, pIdx) => {
            ctx.beginPath();
            keys.forEach((k, i) => {
                const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
                const val = (p.data.scores[k].value / 100) * r;
                const x = cx + val * Math.cos(angle);
                const y = cy + val * Math.sin(angle);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.closePath();
            const hex = COLORS[pIdx];
            ctx.fillStyle = hex + '30';
            ctx.fill();
            ctx.strokeStyle = hex;
            ctx.lineWidth = 2;
            ctx.stroke();
        });
    }

    return { pin, unpin, clearAll, openPanel, closePanel, getPinned, buildCSV, exportCSV };
})();
