import { describe, it, expect } from 'vitest';

// KeyboardNav + DigiPin are exposed on globalThis by tests/setup.js.
// neighborCode() is pure (decode → shift one cell → encode).
const KN = globalThis.KeyboardNav;
const DigiPin = globalThis.DigiPin;

describe('KeyboardNav.neighborCode', () => {
    const code = DigiPin.encode(22.72, 75.86);   // a cell near central Indore
    const here = DigiPin.decode(code);

    it('moves north (up) — neighbour centre is further north', () => {
        const up = KN.neighborCode(code, 'up');
        expect(up).toBeTruthy();
        expect(DigiPin.decode(up).lat).toBeGreaterThan(here.lat);
    });

    it('moves south/east/west in the right direction', () => {
        expect(DigiPin.decode(KN.neighborCode(code, 'down')).lat).toBeLessThan(here.lat);
        expect(DigiPin.decode(KN.neighborCode(code, 'right')).lng).toBeGreaterThan(here.lng);
        expect(DigiPin.decode(KN.neighborCode(code, 'left')).lng).toBeLessThan(here.lng);
    });

    it('returns a valid adjacent 10-char code', () => {
        const up = KN.neighborCode(code, 'up').replace(/-/g, '');
        expect(up).toHaveLength(10);
    });

    it('returns null for an unknown direction or bad code', () => {
        expect(KN.neighborCode(code, 'sideways')).toBeNull();
        expect(KN.neighborCode('not-a-code', 'up')).toBeNull();
    });
});
