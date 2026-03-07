/**
 * Floating Dialogs — Drag-to-move + resize for independent dialog windows
 *
 * Any element with class `floating-dialog` becomes a draggable, resizable dialog.
 * - `.dialog-titlebar[data-dialog]` = drag handle (moves the dialog)
 * - `.dialog-resize-handle[data-dialog]` = bottom-right resize grip
 * - Clicking a dialog brings it to front (z-index management)
 */

const FloatingDialogs = (() => {
    let _topZ = 1200; // start above all fixed panels

    function init() {
        // Attach drag handlers to all titlebars
        document.querySelectorAll('.dialog-titlebar[data-dialog]').forEach(bar => {
            const dialogId = bar.getAttribute('data-dialog');
            const dialog = document.getElementById(dialogId);
            if (!dialog) return;
            attachDrag(bar, dialog);
        });

        // Attach resize handlers
        document.querySelectorAll('.dialog-resize-handle[data-dialog]').forEach(grip => {
            const dialogId = grip.getAttribute('data-dialog');
            const dialog = document.getElementById(dialogId);
            if (!dialog) return;
            attachResize(grip, dialog);
        });

        // Click anywhere on dialog → bring to front
        document.querySelectorAll('.floating-dialog').forEach(dialog => {
            dialog.addEventListener('mousedown', () => bringToFront(dialog));
        });
    }

    function bringToFront(dialog) {
        _topZ++;
        dialog.style.zIndex = _topZ;
    }

    function attachDrag(handle, dialog) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        handle.addEventListener('mousedown', (e) => {
            // Don't drag if clicking buttons inside titlebar
            if (e.target.closest('button')) return;

            isDragging = true;
            bringToFront(dialog);

            const rect = dialog.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left;
            startTop = rect.top;

            document.body.style.cursor = 'move';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            let newLeft = startLeft + dx;
            let newTop = startTop + dy;

            // Clamp to viewport
            newLeft = Math.max(0, Math.min(window.innerWidth - 100, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));

            dialog.style.left = newLeft + 'px';
            dialog.style.top = newTop + 'px';
            // Clear any right/bottom anchoring when user drags
            dialog.style.right = 'auto';
            dialog.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    function attachResize(grip, dialog) {
        let isResizing = false;
        let startX, startY, startW, startH;

        grip.addEventListener('mousedown', (e) => {
            isResizing = true;
            bringToFront(dialog);

            startX = e.clientX;
            startY = e.clientY;
            startW = dialog.offsetWidth;
            startH = dialog.offsetHeight;

            document.body.style.cursor = 'nwse-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const dw = e.clientX - startX;
            const dh = e.clientY - startY;

            const newW = Math.max(280, startW + dw);
            const newH = Math.max(200, startH + dh);

            dialog.style.width = newW + 'px';
            dialog.style.height = newH + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    return { init, bringToFront };
})();
