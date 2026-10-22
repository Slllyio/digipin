import { describe, it, expect } from 'vitest';

// MobilityOverlay is exposed on globalThis by tests/setup.js. The render path
// needs a live map; these lock the pure colour/legend pieces.
const O = globalThis.MobilityOverlay;

describe('MobilityOverlay.colorFor', () => {
    it('gives each chokepoint kind a colour, grey for unknown', () => {
        expect(O.colorFor('level_crossing')).toBe('#b30000');
        expect(O.colorFor('critical_link')).toBe('#000000');
        expect(O.colorFor('mystery')).toBe('#9ca3af');
    });
});

describe('MobilityOverlay.radiusFor', () => {
    it('draws high-severity chokepoints larger', () => {
        expect(O.radiusFor('high')).toBeGreaterThan(O.radiusFor('medium'));
    });
});

describe('MobilityOverlay.KINDS — legend', () => {
    it('covers points and lines with labels', () => {
        const kinds = O.KINDS.map(k => k.kind);
        expect(kinds).toContain('level_crossing');
        expect(kinds).toContain('seal_link');
        expect(O.KINDS.some(k => k.type === 'line')).toBe(true);
        expect(O.KINDS.some(k => k.type === 'point')).toBe(true);
        for (const k of O.KINDS) expect(k.label).toBeTruthy();
    });
});

describe('MobilityOverlay.dataUrl — follows the selected city', () => {
    it('loads the selected city region and falls back to Indore', () => {
        const CS = globalThis.CitySelector;
        const prev = CS.currentArea;
        try {
            CS.currentArea = () => ({ region: 'delhi' });
            expect(O.region()).toBe('delhi');
            expect(O.dataUrl()).toBe('./data/safety/delhi/chokepoints.geojson');
            CS.currentArea = () => null;
            expect(O.region()).toBe('indore_pilot');
            expect(O.dataUrl('pune')).toBe('./data/safety/pune/chokepoints.geojson');
        } finally { CS.currentArea = prev; }
    });
});
