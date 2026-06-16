/**
 * Intelligence Scores Dialog — Independent floating window
 * Opens when user clicks the "Intelligence Scores" button in the detail panel.
 * Displays radar chart + all score meters in its own resizable dialog.
 *
 * Security note: All external string values pass through esc() which escapes
 * &, <, >, " to prevent XSS. Numeric score values come from our own computations
 * and are safe. This follows the same sanitization pattern used in panel.js and
 * building-intel-dialog.js throughout the codebase.
 */

const ScoresDialog = (() => {
    let _dialogEl = null;
    let _contentEl = null;

    function init() {
        _dialogEl = document.getElementById('scores-dialog');
        _contentEl = document.getElementById('scores-dialog-content');
    }

    /**
     * Open the dialog with scores data
     */
    function open(scores, cell) {
        if (!_dialogEl || !_contentEl) init();
        if (!scores) return;

        _contentEl.innerHTML = buildContent(scores, cell);
        _dialogEl.classList.add('open');
        FloatingDialogs.bringToFront(_dialogEl);

        // Position near center if not already positioned by user
        if (!_dialogEl.style.left || _dialogEl.style.left === 'auto') {
            _dialogEl.style.left = '300px';
            _dialogEl.style.top = '60px';
            _dialogEl.style.right = 'auto';
            _dialogEl.style.bottom = 'auto';
        }

        // Draw radar chart after dialog is visible (canvas needs dimensions)
        requestAnimationFrame(() => drawRadarChart(scores));
    }

    function close() {
        if (_dialogEl) _dialogEl.classList.remove('open');
    }

    function isOpen() {
        return _dialogEl && _dialogEl.classList.contains('open');
    }

    function buildContent(scores, cell) {
        let html = '';

        // Cell reference
        if (cell) {
            html += `<div class="sd-cell">${esc(cell.code)} &mdash; Intelligence Scores</div>`;
        }

        // Radar chart canvas
        html += `<canvas id="scores-radar-chart" width="380" height="380"></canvas>`;

        // Scores grid
        html += `<div class="sd-scores-grid">`;
        Object.entries(scores).forEach(([key, s]) => {
            if (s && s.value !== undefined) {
                const color = getScoreColor(s.value);
                html += `<div class="sd-score-item" role="meter" aria-valuenow="${s.value}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(s.label)}">
                    <div class="sd-score-bar-bg"><div class="sd-score-bar" style="width:${s.value}%;background:${color}"></div></div>
                    <div class="sd-score-info"><span class="sd-score-label">${esc(s.label)}</span><span class="sd-score-value">${s.value}</span></div>
                </div>`;
            }
        });
        html += `</div>`;

        // Trust/auditability: India-native framing + link to exact formulas.
        html += `<div class="sd-trust">Computed from Indian civic &amp; OpenStreetMap data on the government DIGIPIN grid — every score is open and auditable.</div>`;
        html += `<a class="sd-methodology" href="docs/METHODOLOGY.md" target="_blank" rel="noopener">How these scores are computed &rarr;</a>`;

        return html;
    }

    function drawRadarChart(scores) {
        const canvas = document.getElementById('scores-radar-chart');
        if (!canvas) return;

        // HiDPI support
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.width;
        const cssH = canvas.height;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const cx = cssW / 2, cy = cssH / 2, r = Math.min(cx, cy) - 45;

        const keys = Object.entries(scores).filter(([, s]) => s && s.value !== undefined);
        const n = keys.length;
        if (n < 3) return;

        // Theme-aware drawing (dark returns the exact prior colours).
        const T = (typeof Theme !== 'undefined') ? Theme : null;
        const ink = (a) => T ? T.fg(a) : `rgba(255,255,255,${a})`;
        const P = T && T.palette ? T.palette() : { primary: '#00f5ff', secondary: '#a855f7' };
        const hexA = (hex, a) => {
            const m = hex.replace('#', '');
            const b = parseInt(m.length === 3 ? m.replace(/(.)/g, '$1$1') : m, 16);
            return `rgba(${(b >> 16) & 255}, ${(b >> 8) & 255}, ${b & 255}, ${a})`;
        };

        ctx.clearRect(0, 0, cssW, cssH);

        // Concentric rings
        for (let i = 1; i <= 4; i++) {
            ctx.beginPath();
            const rr = (r * i) / 4;
            for (let j = 0; j <= n; j++) {
                const angle = (Math.PI * 2 * j) / n - Math.PI / 2;
                const x = cx + rr * Math.cos(angle);
                const y = cy + rr * Math.sin(angle);
                j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.strokeStyle = ink(0.08);
            ctx.stroke();

            ctx.fillStyle = ink(0.2);
            ctx.font = '7px Inter';
            ctx.textAlign = 'left';
            ctx.fillText(String(i * 25), cx + 2, cy - rr + 8);
        }

        // Axes + labels
        keys.forEach(([, s], i) => {
            const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
            ctx.strokeStyle = ink(0.06);
            ctx.stroke();

            const labelR = r + (n > 15 ? 28 : 20);
            const lx = cx + labelR * Math.cos(angle);
            const ly = cy + labelR * Math.sin(angle);
            ctx.fillStyle = ink(0.5);
            ctx.font = n > 15 ? '7px Inter' : '8px Inter';

            if (Math.abs(Math.cos(angle)) < 0.3) ctx.textAlign = 'center';
            else if (Math.cos(angle) > 0) ctx.textAlign = 'left';
            else ctx.textAlign = 'right';

            const maxLen = n > 15 ? 8 : 12;
            const label = s.label.length > maxLen ? s.label.substring(0, maxLen - 1) + '.' : s.label;
            ctx.fillText(label, lx, ly + 3);
        });

        // Data polygon
        ctx.beginPath();
        keys.forEach(([, s], i) => {
            const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
            const val = (s.value / 100) * r;
            const x = cx + val * Math.cos(angle);
            const y = cy + val * Math.sin(angle);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.closePath();
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, hexA(P.secondary, 0.35));
        grad.addColorStop(1, hexA(P.primary, 0.2));
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = P.secondary;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Data points
        keys.forEach(([, s], i) => {
            const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
            const val = (s.value / 100) * r;
            const x = cx + val * Math.cos(angle);
            const y = cy + val * Math.sin(angle);
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fillStyle = T ? T.scoreColor(s.value) : getScoreColor(s.value);
            ctx.fill();
            ctx.strokeStyle = ink(0.3);
            ctx.lineWidth = 1;
            ctx.stroke();
        });
    }

    /** Escape HTML */
    function esc(str) {
        if (str == null) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function getScoreColor(val) {
        if (typeof Theme !== 'undefined' && Theme.scoreColor) return Theme.scoreColor(val);
        if (val >= 70) return '#22c55e';
        if (val >= 40) return '#eab308';
        return '#ef4444';
    }

    return { init, open, close, isOpen };
})();
