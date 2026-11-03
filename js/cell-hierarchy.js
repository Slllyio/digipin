/**
 * CellHierarchy — the selected cell's place in the DIGIPIN hierarchy, shown
 * in the detail panel: its level and exact size, a breadcrumb of every
 * ancestor (L1 → this cell) that re-selects that coarser cell, a "finer"
 * button that drops to the child under the cell centre. (The cell-store rows
 * for the cell are js/cell-profile.js.)
 *
 * html() and centreChild() are pure and unit-tested; wire() attaches the
 * click handlers.
 */
const CellHierarchy = (() => {
    function _esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Header strip for a code: level + size, ancestor breadcrumb, finer button. '' for an invalid code. */
    function html(code) {
        if (typeof DigiPin === 'undefined' || !DigiPin.isValid(code)) return '';
        const c = DigiPin.normalize(code);
        const L = c.length;
        const crumbs = DigiPin.ancestors(c).map((a, i) => {
            const label = `L${i + 1}`;
            if (a === c) return `<span class="digipin-hier-chip current" aria-current="true" title="${_esc(DigiPin.format(a))}">${label}</span>`;
            return `<button type="button" class="digipin-hier-chip" data-hier-code="${_esc(a)}" title="Select ${_esc(DigiPin.format(a))} (${_esc(DigiPin.sizeLabel(i + 1))})">${label}</button>`;
        }).join('');
        const finer = L < DigiPin.MAX_LEVEL
            ? `<button type="button" class="digipin-hier-chip finer" data-hier-finer="1" title="Select the L${L + 1} cell at the centre (${_esc(DigiPin.sizeLabel(L + 1))})">L${L + 1} ›</button>`
            : '';
        return `<div class="digipin-hier" role="group" aria-label="DIGIPIN hierarchy">`
            + `<span class="digipin-hier-size">Level ${L} · ${_esc(DigiPin.sizeLabel(L))} cell</span>`
            + `<span class="digipin-hier-crumbs">${crumbs}${finer}</span></div>`;
    }

    /** Code of the child cell at the parent's centre (for the "finer" button). */
    function centreChild(code) {
        const c = DigiPin.normalize(code);
        if (c.length >= DigiPin.MAX_LEVEL) return null;
        const b = DigiPin.cellBounds(c);
        // The exact centre is a corner of four children; nudge into the NE one.
        const d = DigiPin.cellDegrees(c.length + 1) / 4;
        return DigiPin.encodeLevel(b.lat + d, b.lng + d, c.length + 1);
    }

    /** Attach breadcrumb / finer handlers inside `container` for the cell `code`. */
    function wire(container, code) {
        if (!container || typeof MapModule === 'undefined' || !MapModule.selectByCode) return;
        container.querySelectorAll('[data-hier-code]').forEach(b => {
            b.addEventListener('click', () => MapModule.selectByCode(b.dataset.hierCode));
        });
        const finer = container.querySelector('[data-hier-finer]');
        if (finer) finer.addEventListener('click', () => {
            const child = centreChild(code);
            if (child) MapModule.selectByCode(child);
        });
    }

    return { html, centreChild, wire };
})();

if (typeof window !== 'undefined') window.CellHierarchy = CellHierarchy;
