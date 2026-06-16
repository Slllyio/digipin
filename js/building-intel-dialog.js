/**
 * Building Intelligence Dialog — Independent floating window
 * Opens when user clicks the Building Intel button in the detail panel.
 * Displays all building metrics, LCZ, Overture stats in its own resizable dialog.
 *
 * Security note: All external string values pass through esc() which escapes
 * &, <, >, " to prevent XSS. Numeric values from our own computations are safe.
 * This follows the same sanitization pattern used in panel.js throughout the codebase.
 */

const BuildingIntelDialog = (() => {
    let _dialogEl = null;
    let _contentEl = null;
    let _currentData = null;

    function init() {
        _dialogEl = document.getElementById('building-intel-dialog');
        _contentEl = document.getElementById('building-intel-content');
    }

    /**
     * Open the dialog with building intelligence data
     */
    function open(bi, cell) {
        if (!_dialogEl || !_contentEl) init();
        if (!bi) return;

        _currentData = bi;
        _contentEl.innerHTML = buildContent(bi, cell);
        _dialogEl.classList.add('open');
        FloatingDialogs.bringToFront(_dialogEl);

        // Position near center-left if not already positioned by user
        if (!_dialogEl.style.left || _dialogEl.style.left === 'auto') {
            _dialogEl.style.left = '260px';
            _dialogEl.style.top = '80px';
            _dialogEl.style.right = 'auto';
            _dialogEl.style.bottom = 'auto';
        }
    }

    function close() {
        if (_dialogEl) _dialogEl.classList.remove('open');
    }

    function isOpen() {
        return _dialogEl && _dialogEl.classList.contains('open');
    }

    function buildContent(bi, cell) {
        const b = bi.buildings || {};
        const m = bi.metrics || {};
        const lcz = bi.lcz;

        let html = '';

        // Cell reference
        if (cell) {
            html += `<div class="bi-dialog-cell">${esc(cell.code)} &mdash; ${cell.center.lat.toFixed(4)}&deg;N, ${cell.center.lng.toFixed(4)}&deg;E</div>`;
        }

        // LCZ Classification badge
        // CSS sanitization: esc() only HTML-encodes — it does NOT prevent
        // CSS injection if a malicious lcz.color contains `;` or `}`.
        // Allowlist 3- or 6-digit hex; fall back to a safe default.
        const safeColor = /^#[0-9a-f]{3,6}$/i.test(String(lcz?.color || '')) ? lcz.color : '#94a3b8';
        if (lcz && lcz.className) {
            html += `<div class="lcz-badge" style="border-left: 4px solid ${safeColor}">
                <div class="lcz-class">${esc(lcz.className)}</div>
                <div class="lcz-detail">${esc(lcz.type === 'built' ? 'Built-up' : 'Natural')}${lcz.density ? ' &bull; ' + esc(lcz.density) + ' density' : ''}${lcz.height ? ' &bull; ' + esc(lcz.height) + '-rise' : ''}</div>
            </div>`;
        }

        // Urban form
        if (m.urbanForm) {
            html += `<div class="bi-form-tag">${esc(m.urbanForm)}</div>`;
        }

        // Key metrics grid
        html += `<div class="bi-metrics">`;
        html += metricItem('Buildings', b.totalCount || 0, '');
        html += metricItem('Avg Height', b.avgHeight || 0, 'm');
        html += metricItem('Max Height', b.maxHeight || 0, 'm');
        html += metricItem('Avg Floors', b.avgLevels || 0, '');
        html += metricItem('Density', m.buildingDensity || 0, '/ha');
        html += metricItem('FSI/FAR', m.fsi || 0, '');
        html += metricItem('Coverage', ((m.gcr || 0) * 100).toFixed(0), '%');
        html += metricItem('Floor Area', formatArea(m.estTotalFloorArea), '');
        html += `</div>`;

        // Height distribution bar
        if (b.totalCount > 0 && (b.heightBands.low + b.heightBands.mid + b.heightBands.high + b.heightBands.vhigh) > 0) {
            const total = b.heightBands.low + b.heightBands.mid + b.heightBands.high + b.heightBands.vhigh;
            html += `<div class="bi-height-dist">
                <div class="bi-dist-label">Height Distribution</div>
                <div class="bi-dist-bar">
                    ${b.heightBands.low > 0 ? `<div class="bi-dist-seg seg-low" style="width:${(b.heightBands.low / total * 100).toFixed(1)}%" title="&lt;3m: ${b.heightBands.low}"></div>` : ''}
                    ${b.heightBands.mid > 0 ? `<div class="bi-dist-seg seg-mid" style="width:${(b.heightBands.mid / total * 100).toFixed(1)}%" title="3-12m: ${b.heightBands.mid}"></div>` : ''}
                    ${b.heightBands.high > 0 ? `<div class="bi-dist-seg seg-high" style="width:${(b.heightBands.high / total * 100).toFixed(1)}%" title="12-40m: ${b.heightBands.high}"></div>` : ''}
                    ${b.heightBands.vhigh > 0 ? `<div class="bi-dist-seg seg-vhigh" style="width:${(b.heightBands.vhigh / total * 100).toFixed(1)}%" title="40m+: ${b.heightBands.vhigh}"></div>` : ''}
                </div>
                <div class="bi-dist-legend"><span class="seg-low">&lt;3m</span><span class="seg-mid">3-12m</span><span class="seg-high">12-40m</span><span class="seg-vhigh">40m+</span></div>
            </div>`;
        }

        // Building types breakdown
        if (Object.keys(b.types).length > 0) {
            const sorted = Object.entries(b.types).sort((a, b) => b[1] - a[1]);
            html += `<div class="bi-types"><div class="bi-dist-label">Building Types</div>`;
            sorted.slice(0, 6).forEach(([type, count]) => {
                const pct = (count / b.totalCount * 100).toFixed(0);
                html += `<div class="bi-type-row">
                    <span class="bi-type-name">${esc(type)}</span>
                    <div class="bi-type-bar-bg"><div class="bi-type-bar" style="width:${pct}%"></div></div>
                    <span class="bi-type-val">${count} (${pct}%)</span>
                </div>`;
            });
            html += `</div>`;
        }

        // Materials
        if (Object.keys(b.materials).length > 0) {
            const mats = Object.entries(b.materials).sort((a, b) => b[1] - a[1]);
            html += `<div class="bi-materials"><div class="bi-dist-label">Materials</div><div class="bi-mat-chips">`;
            mats.slice(0, 8).forEach(([mat, count]) => {
                html += `<span class="bi-mat-chip">${esc(mat)} <small>${count}</small></span>`;
            });
            html += `</div></div>`;
        }

        // Scores
        const scores = bi.scores;
        if (scores) {
            html += `<div class="bi-scores-section"><div class="bi-dist-label">Intelligence Scores</div>`;
            Object.entries(scores).forEach(([key, s]) => {
                if (s && s.value !== undefined) {
                    const color = (typeof Theme !== 'undefined' && Theme.scoreColor) ? Theme.scoreColor(s.value) : (s.value >= 70 ? '#00f5a0' : s.value >= 40 ? '#f5c542' : '#f56b6b');
                    html += `<div class="bi-score-row">
                        <span class="bi-score-label">${esc(s.label)}</span>
                        <div class="bi-score-bar-bg"><div class="bi-score-bar" style="width:${s.value}%;background:${color}"></div></div>
                        <span class="bi-score-val">${s.value}</span>
                    </div>`;
                }
            });
            html += `</div>`;
        }

        // Overture Maps stats
        const os = bi.overtureStats;
        if (os && os.totalBuildings > 0) {
            html += `<div class="overture-stats-card">
                <div class="overture-stats-title">&#127970; Overture Maps Footprints</div>
                <div class="overture-stats-grid">
                    ${overtureStatItem(os.totalBuildings.toLocaleString(), 'Footprints')}
                    ${overtureStatItem(os.avgHeight ? os.avgHeight + 'm' : '--', 'Avg Height')}
                    ${overtureStatItem(os.withHeight, 'With Height')}
                    ${overtureStatItem(os.withFloors, 'With Floors')}
                </div>
                <div class="overture-height-legend">
                    <span>Low</span>
                    <div class="legend-bar"></div>
                    <span>High</span>
                </div>
            </div>`;
        }

        return html;
    }

    /** Escape HTML — prevents XSS from any external string data */
    function esc(str) {
        if (str == null) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function metricItem(label, value, unit) {
        return `<div class="bi-metric"><div class="bi-metric-val">${value}${unit ? '<small>' + esc(unit) + '</small>' : ''}</div><div class="bi-metric-label">${esc(label)}</div></div>`;
    }

    function formatArea(m2) {
        if (!m2 || m2 === 0) return '0';
        if (m2 >= 1000000) return (m2 / 1000000).toFixed(1) + 'M m\u00B2';
        if (m2 >= 1000) return (m2 / 1000).toFixed(0) + 'K m\u00B2';
        return m2 + ' m\u00B2';
    }

    function overtureStatItem(val, label) {
        return `<div class="overture-stat"><div class="stat-val">${val}</div><div class="stat-lbl">${label}</div></div>`;
    }

    return { init, open, close, isOpen };
})();
