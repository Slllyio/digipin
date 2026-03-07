/**
 * Comparative Analysis — Pin up to 3 cells and compare side-by-side
 */
const Compare = (() => {
    const MAX_PINS = 3;
    const COLORS = ['#00f5ff', '#a855f7', '#ec4899'];
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
        const marker = L.circleMarker([cell.center.lat, cell.center.lng], {
            radius: 10, color, fillColor: color, fillOpacity: 0.6, weight: 3
        }).addTo(MapModule.getMap());

        const popupDiv = document.createElement('div');
        popupDiv.textContent = `Pin ${_pinned.length + 1}: ${cell.code}`;
        marker.bindPopup(popupDiv);

        _pinned.push({ cell, data, marker });
        updateBadge();
        App.showToast('Cell Pinned', `${cell.code} added to compare (${_pinned.length}/${MAX_PINS})`, 'success');
    }

    function unpin(code) {
        const idx = _pinned.findIndex(p => p.cell.code === code);
        if (idx === -1) return;
        MapModule.getMap().removeLayer(_pinned[idx].marker);
        _pinned.splice(idx, 1);
        updateBadge();
    }

    function clearAll() {
        _pinned.forEach(p => MapModule.getMap().removeLayer(p.marker));
        _pinned = [];
        updateBadge();
        closePanel();
    }

    function updateBadge() {
        const badge = document.getElementById('compare-badge');
        if (badge) {
            badge.textContent = String(_pinned.length);
            badge.style.display = _pinned.length > 0 ? '' : 'none';
        }
    }

    function getPinned() { return _pinned; }

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

    function closePanel() {
        const panel = document.getElementById('compare-panel');
        if (panel) panel.classList.remove('open');
    }

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
                    cell.style.color = val >= 70 ? '#22c55e' : val >= 40 ? '#eab308' : '#ef4444';
                    if (val === maxVal && validValues.length > 1) {
                        cell.classList.add('compare-best');
                    }
                } else {
                    cell.textContent = '-';
                    cell.style.color = '#64748b';
                }
                row.appendChild(cell);
            });

            container.appendChild(row);
        });

        // Overlay radar chart
        renderOverlayRadar();
    }

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
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.stroke();
        }

        // Labels
        keys.forEach((k, i) => {
            const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
            const lx = cx + (r + 22) * Math.cos(angle);
            const ly = cy + (r + 22) * Math.sin(angle);
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
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

    return { pin, unpin, clearAll, openPanel, closePanel, getPinned };
})();
