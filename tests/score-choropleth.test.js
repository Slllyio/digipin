import { describe, it, expect, afterEach } from 'vitest';

// ScoreChoropleth is exposed on globalThis by tests/setup.js. The map-rendering
// (show/toggle) needs MapModule + a live map, so these lock the pure helpers
// that drive the layer: the colour expression and the PMTiles URL builder.
const SC = globalThis.ScoreChoropleth;

afterEach(() => { delete window.DIGIPIN_CONFIG; });

describe('ScoreChoropleth.colorExpr()', () => {
    it('is a MapLibre step expression over the chosen score property', () => {
        const expr = SC.colorExpr('livability');
        expect(expr[0]).toBe('step');
        // reads the score property as a number with a 0 fallback
        expect(JSON.stringify(expr[1])).toContain('livability');
        // 4 colour stops (red/orange/yellow/green) at 20/40/70
        expect(expr).toContain(20);
        expect(expr).toContain(40);
        expect(expr).toContain(70);
        expect(expr.filter(v => typeof v === 'string' && v.startsWith('#')).length).toBe(4);
    });

    it('targets whatever score key is given', () => {
        expect(JSON.stringify(SC.colorExpr('safety'))).toContain('safety');
    });
});

describe('ScoreChoropleth.pmtilesUrl()', () => {
    const region = { name: 'indore_pilot', path: 'data/scores/indore_pilot/' };

    it('builds the default same-origin tile URL', () => {
        expect(SC.pmtilesUrl(region)).toBe('data/scores/indore_pilot/scores.pmtiles');
    });

    it('honours a scoresBase override (e.g. a future R2 bucket)', () => {
        window.DIGIPIN_CONFIG = { scoresBase: 'https://cdn.example.com/scores/' };
        expect(SC.pmtilesUrl(region)).toBe('https://cdn.example.com/scores/indore_pilot/scores.pmtiles');
    });

    it('falls back to the region name when path is absent', () => {
        expect(SC.pmtilesUrl({ name: 'bhopal_pilot' })).toBe('data/scores/bhopal_pilot/scores.pmtiles');
    });
});

describe('ScoreChoropleth lifecycle (no map)', () => {
    it('starts inactive and toggles to a no-op when no map is present', () => {
        expect(SC.isActive()).toBe(false);
        // MapModule is undefined in the unit env -> show() returns false, stays inactive
        expect(SC.toggle()).toBe(false);
        expect(SC.isActive()).toBe(false);
    });
});
