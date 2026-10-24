/**
 * KeyboardNav — arrow-key navigation across the DIGIPIN grid.
 *
 * When a cell is selected, ←/↑/→/↓ move the selection to the adjacent cell and
 * Enter/the existing click flow opens it. A genuine accessibility win: keyboard
 * users can explore the grid without a mouse. `neighborCode()` is pure (uses
 * DigiPin.neighbor) and unit-tested; `init()` wires a global keydown that
 * stays out of the way of text inputs.
 */
const KeyboardNav = (() => {
    const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

    /** Adjacent same-level cell's DIGIPIN code in a direction (up/down/left/right),
     *  or null if it would fall outside the DIGIPIN grid or the code is invalid.
     *  Works at any level (a ~1 km L6 grid cell steps to the next L6 cell). Pure. */
    function neighborCode(code, dir) {
        if (typeof DigiPin === 'undefined' || !['up', 'down', 'left', 'right'].includes(dir)) return null;
        try {
            const next = DigiPin.neighbor(code, dir);
            return next ? DigiPin.format(next) : null;
        } catch {
            return null;
        }
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
