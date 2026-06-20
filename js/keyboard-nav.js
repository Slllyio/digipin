/**
 * KeyboardNav — arrow-key navigation across the DIGIPIN grid.
 *
 * When a cell is selected, ←/↑/→/↓ move the selection to the adjacent cell and
 * Enter/the existing click flow opens it. A genuine accessibility win: keyboard
 * users can explore the grid without a mouse. `neighborCode()` is pure (uses
 * DigiPin.decode/encode) and unit-tested; `init()` wires a global keydown that
 * stays out of the way of text inputs.
 */
const KeyboardNav = (() => {
    const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

    /** Adjacent cell's DIGIPIN code in a direction (up/down/left/right), or null
     *  if it would fall outside the DIGIPIN grid bounds or the code is invalid. Pure. */
    function neighborCode(code, dir) {
        if (typeof DigiPin === 'undefined') return null;
        let d;
        try { d = DigiPin.decode(code); } catch { return null; }
        const latSpan = d.bounds.north - d.bounds.south;
        const lngSpan = d.bounds.east - d.bounds.west;
        let lat = d.lat, lng = d.lng;
        if (dir === 'up') lat += latSpan;
        else if (dir === 'down') lat -= latSpan;
        else if (dir === 'right') lng += lngSpan;
        else if (dir === 'left') lng -= lngSpan;
        else return null;
        try { return DigiPin.encode(lat, lng); } catch { return null; }   // off-grid
    }

    /** Global keydown: arrow-step the selection when a cell is active. */
    function _onKey(e) {
        const dir = DIRS[e.key];
        if (!dir) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (typeof MapModule === 'undefined' || !MapModule.getSelectedCode || !MapModule.selectByCode) return;
        const code = MapModule.getSelectedCode();
        if (!code) return;                 // only drive when a cell is already selected
        const next = neighborCode(code, dir);
        if (!next) return;
        e.preventDefault();                // don't also pan the map
        MapModule.selectByCode(next);
    }

    /** Attach the global arrow-key handler. */
    function init() {
        if (typeof document !== 'undefined') document.addEventListener('keydown', _onKey);
    }

    return { init, neighborCode };
})();

if (typeof window !== 'undefined') window.KeyboardNav = KeyboardNav;
