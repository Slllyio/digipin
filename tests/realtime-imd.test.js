import { describe, it, expect } from 'vitest';

// RealtimeIMD is exposed on globalThis by tests/setup.js.
const IMD = globalThis.RealtimeIMD;

describe('RealtimeIMD.worstColor()', () => {
    it('returns null for no warnings', () => {
        expect(IMD.worstColor(null)).toBeNull();
        expect(IMD.worstColor([])).toBeNull();
    });

    it('picks the highest-severity colour (red > orange > yellow > green)', () => {
        expect(IMD.worstColor([{ color: 'yellow' }, { color: 'red' }, { color: 'green' }])).toBe('red');
        expect(IMD.worstColor([{ color: 'green' }, { color: 'orange' }, { color: 'yellow' }])).toBe('orange');
        expect(IMD.worstColor([{ color: 'green' }, { color: 'yellow' }])).toBe('yellow');
        expect(IMD.worstColor([{ color: 'green' }])).toBe('green');
    });

    it('is order-independent', () => {
        const set = [{ color: 'orange' }, { color: 'red' }, { color: 'yellow' }];
        expect(IMD.worstColor(set)).toBe('red');
        expect(IMD.worstColor([...set].reverse())).toBe('red');
    });

    it('floors unrecognised colours to green (never above a known severity)', () => {
        // unknown ranks below green, so they never win; green is the floor.
        expect(IMD.worstColor([{ color: 'magenta' }])).toBe('green');
        expect(IMD.worstColor([{ color: 'magenta' }, { color: 'orange' }])).toBe('orange');
    });
});
