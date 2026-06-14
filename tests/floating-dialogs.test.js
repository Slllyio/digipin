import { describe, it, expect } from 'vitest';

// FloatingDialogs is exposed on globalThis by tests/setup.js. The drag/resize
// event wiring needs a real pointer device, but the geometry is pure: these
// lock clampPosition (keep the titlebar reachable, most of the dialog on-screen)
// and clampSize (floor at a usable minimum, never larger than the viewport).
const FD = globalThis.FloatingDialogs;
const VW = 1280, VH = 800;

describe('FloatingDialogs.clampPosition()', () => {
    it('passes through a position fully inside the viewport', () => {
        const { left, top } = FD.clampPosition(200, 150, 400, 300, VW, VH);
        expect(left).toBe(200);
        expect(top).toBe(150);
    });

    it('never lets the titlebar leave the top of the screen', () => {
        const { top } = FD.clampPosition(200, -500, 400, 300, VW, VH);
        expect(top).toBe(0);
    });

    it('keeps the titlebar reachable near the bottom edge', () => {
        const { top } = FD.clampPosition(200, 5000, 400, 300, VW, VH);
        expect(top).toBe(VH - 40);          // TITLEBAR kept on-screen
    });

    it('keeps a sliver on-screen when dragged off the right edge', () => {
        const { left } = FD.clampPosition(99999, 100, 400, 300, VW, VH);
        expect(left).toBe(VW - 80);         // KEEP_VISIBLE px stays reachable
    });

    it('keeps a sliver on-screen when dragged off the left edge', () => {
        const { left } = FD.clampPosition(-99999, 100, 400, 300, VW, VH);
        expect(left).toBe(80 - 400);        // KEEP_VISIBLE - width
    });
});

describe('FloatingDialogs.clampSize()', () => {
    it('passes through a size that fits the viewport', () => {
        const { width, height } = FD.clampSize(500, 400, VW, VH);
        expect(width).toBe(500);
        expect(height).toBe(400);
    });

    it('floors at the usable minimum', () => {
        const { width, height } = FD.clampSize(10, 10, VW, VH);
        expect(width).toBe(280);            // MIN_W
        expect(height).toBe(200);           // MIN_H
    });

    it('never grows larger than the viewport', () => {
        const { width, height } = FD.clampSize(99999, 99999, VW, VH);
        expect(width).toBe(Math.round(VW * 0.98));
        expect(height).toBe(Math.round(VH * 0.95));
        expect(width).toBeLessThanOrEqual(VW);
        expect(height).toBeLessThanOrEqual(VH);
    });
});
