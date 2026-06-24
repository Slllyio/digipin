/**
 * Floating Dialogs — drag-to-move + resize for independent dialog windows.
 *
 * Any element with class `floating-dialog` becomes draggable + resizable:
 * - `.dialog-titlebar[data-dialog]` = drag handle
 * - `.dialog-resize-handle[data-dialog]` = bottom-right resize grip
 * - pointerdown on a dialog brings it to front (z-index management)
 *
 * Uses **Pointer Events** so mouse, touch and pen share one code path (phones
 * never worked with the old mouse-only handlers). Position/size are clamped to
 * the viewport so a dialog can't be dragged off-screen or stretched larger than
 * the window. The clamp maths are pure helpers (clampPosition/clampSize) so
 * they're unit-testable.
 */
const FloatingDialogs = (() => {
    let _topZ = 1200;            // start above all fixed panels
    const KEEP_VISIBLE = 80;     // px of the dialog that must stay on-screen
    const TITLEBAR = 40;         // px of titlebar kept reachable at the top
    const MIN_W = 280, MIN_H = 200;

    /** Keep the titlebar reachable and ≥KEEP_VISIBLE px of the dialog on-screen. */
    function clampPosition(left, top, w, h, vw, vh) {
        const minLeft = KEEP_VISIBLE - w;          // allow most of the dialog off the left
        const maxLeft = vw - KEEP_VISIBLE;
        const maxTop = vh - TITLEBAR;
        return {
            left: Math.max(minLeft, Math.min(maxLeft, left)),
            top: Math.max(0, Math.min(maxTop, top)),
        };
    }

    /** Floor at the usable minimum, cap at the viewport (never larger than screen). */
    function clampSize(w, h, vw, vh) {
        return {
            width: Math.max(MIN_W, Math.min(w, Math.round(vw * 0.98))),
            height: Math.max(MIN_H, Math.min(h, Math.round(vh * 0.95))),
        };
    }

    function bringToFront(dialog) {
        _topZ++;
        dialog.style.zIndex = _topZ;
    }

    // ── Focus management ──────────────────────────────────────────────────────
    // Move focus into a dialog on open (so keyboard/screen-reader users land on
    // the new content) and restore it to the opener on close (so they don't lose
    // their place). The opener is stashed per-dialog. Panel does this inline; the
    // other dialogs call these helpers.
    const _focusReturn = new WeakMap();
    function focusInto(dialog) {
        if (!dialog || typeof document === 'undefined') return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== dialog && !dialog.contains(active)) {
            _focusReturn.set(dialog, active);
        }
        if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
        try { dialog.focus({ preventScroll: true }); } catch { /* older browsers */ }
    }
    function restoreFocus(dialog) {
        if (!dialog) return;
        const el = _focusReturn.get(dialog);
        _focusReturn.delete(dialog);
        if (el && typeof document !== 'undefined' && document.contains(el)) {
            try { el.focus({ preventScroll: true }); } catch { /* noop */ }
        }
    }

    // ── Escape-to-close registry ────────────────────────────────────────────
    // Components register a closable descriptor { isOpen, close, priority }.
    // Escape closes exactly ONE open surface — the highest-priority one — so a
    // user peels back layers (dropdown → dialog → panel) one press at a time.
    // We call each component's own close() so its `.open` state stays
    // consistent; we never poke at inline styles.
    const _closables = [];

    function registerClosable(c) {
        if (c && typeof c.isOpen === 'function' && typeof c.close === 'function') {
            _closables.push({ isOpen: c.isOpen, close: c.close, priority: c.priority || 0 });
        }
    }

    /** Close the top-most open registered surface. Returns true if one closed. */
    function closeTopmost() {
        const open = _closables.filter(c => { try { return c.isOpen(); } catch { return false; } });
        if (!open.length) return false;
        open.sort((a, b) => b.priority - a.priority);
        try { open[0].close(); } catch { /* a component's close threw — ignore */ }
        return true;
    }

    function attachDrag(handle, dialog) {
        let dragging = false, startX, startY, startLeft, startTop, pointerId;

        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;   // titlebar buttons aren't drag handles
            dragging = true;
            pointerId = e.pointerId;
            bringToFront(dialog);
            const rect = dialog.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            try { handle.setPointerCapture(pointerId); } catch { /* capture unsupported */ }
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        handle.addEventListener('pointermove', (e) => {
            if (!dragging || e.pointerId !== pointerId) return;
            const { left, top } = clampPosition(
                startLeft + (e.clientX - startX), startTop + (e.clientY - startY),
                dialog.offsetWidth, dialog.offsetHeight, window.innerWidth, window.innerHeight);
            dialog.style.left = left + 'px';
            dialog.style.top = top + 'px';
            dialog.style.right = 'auto';
            dialog.style.bottom = 'auto';
        });

        const end = (e) => {
            if (!dragging || (e && e.pointerId !== pointerId)) return;
            dragging = false;
            try { handle.releasePointerCapture(pointerId); } catch { /* noop */ }
            document.body.style.userSelect = '';
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    function attachResize(grip, dialog) {
        let resizing = false, startX, startY, startW, startH, pointerId;

        grip.addEventListener('pointerdown', (e) => {
            resizing = true;
            pointerId = e.pointerId;
            bringToFront(dialog);
            startX = e.clientX; startY = e.clientY;
            startW = dialog.offsetWidth; startH = dialog.offsetHeight;
            try { grip.setPointerCapture(pointerId); } catch { /* noop */ }
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();
        });

        grip.addEventListener('pointermove', (e) => {
            if (!resizing || e.pointerId !== pointerId) return;
            const { width, height } = clampSize(
                startW + (e.clientX - startX), startH + (e.clientY - startY),
                window.innerWidth, window.innerHeight);
            dialog.style.width = width + 'px';
            dialog.style.height = height + 'px';
        });

        const end = (e) => {
            if (!resizing || (e && e.pointerId !== pointerId)) return;
            resizing = false;
            try { grip.releasePointerCapture(pointerId); } catch { /* noop */ }
            document.body.style.userSelect = '';
        };
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    }

    function init() {
        document.querySelectorAll('.dialog-titlebar[data-dialog]').forEach(bar => {
            const dialog = document.getElementById(bar.getAttribute('data-dialog'));
            if (dialog) attachDrag(bar, dialog);
        });
        document.querySelectorAll('.dialog-resize-handle[data-dialog]').forEach(grip => {
            const dialog = document.getElementById(grip.getAttribute('data-dialog'));
            if (dialog) attachResize(grip, dialog);
        });
        document.querySelectorAll('.floating-dialog').forEach(dialog => {
            dialog.addEventListener('pointerdown', () => bringToFront(dialog));
        });

        // One global Escape handler peels back the top-most open surface.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && closeTopmost()) e.preventDefault();
        });
    }

    return { init, bringToFront, focusInto, restoreFocus, clampPosition, clampSize, registerClosable, closeTopmost };
})();

if (typeof window !== 'undefined') {
    window.FloatingDialogs = FloatingDialogs;
}
