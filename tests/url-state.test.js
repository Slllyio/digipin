import { describe, it, expect, afterEach, vi } from 'vitest';

// URLState is exposed on globalThis by tests/setup.js. parse/stringify/buildUrl
// are pure; capture/apply are exercised against stubbed app globals.
//
// ScoreChoropleth and PrecomputedScores are loaded by setup.js as lexical
// `const`s, so url-state.js binds the real objects — we stub their METHODS and
// restore them. MapModule isn't loaded, so it's a plain globalThis override.
const U = globalThis.URLState;

const realSC = {
    isActive: ScoreChoropleth.isActive, getScoreKey: ScoreChoropleth.getScoreKey,
    setScore: ScoreChoropleth.setScore, show: ScoreChoropleth.show,
};
const realEnabled = PrecomputedScores.isEnabled;

afterEach(() => {
    Object.assign(ScoreChoropleth, realSC);
    PrecomputedScores.isEnabled = realEnabled;
    delete globalThis.MapModule;
});

describe('URLState.parse()', () => {
    it('reads every supported param', () => {
        const s = U.parse('?cell=4P3-JK8-39LM&q=safe%20area&score=safety&z=14.5&ll=22.71,75.85');
        expect(s.cell).toBe('4P3-JK8-39LM');
        expect(s.q).toBe('safe area');
        expect(s.score).toBe('safety');
        expect(s.z).toBe(14.5);
        expect(s.ll).toEqual({ lat: 22.71, lng: 75.85 });
    });

    it('omits missing / malformed params', () => {
        const s = U.parse('?z=notanumber&ll=onlyone');
        expect(s).toEqual({});
    });
});

describe('URLState.stringify()', () => {
    it('round-trips with parse and rounds numbers', () => {
        const state = { cell: '4P3JK8', q: 'good schools', score: 'education_score', z: 13.12345, ll: { lat: 22.719634, lng: 75.857727 } };
        const back = U.parse('?' + U.stringify(state));
        expect(back.cell).toBe('4P3JK8');
        expect(back.q).toBe('good schools');
        expect(back.score).toBe('education_score');
        expect(back.z).toBe(13.12);            // 2dp
        expect(back.ll).toEqual({ lat: 22.71963, lng: 75.85773 }); // 5dp
    });

    it('omits empty fields', () => {
        expect(U.stringify({})).toBe('');
        expect(U.stringify({ cell: '' })).toBe('');
    });
});

describe('URLState.buildUrl()', () => {
    it('roots the query at origin + pathname', () => {
        const url = U.buildUrl({ cell: '4P3JK8' });
        expect(url).toContain('?cell=4P3JK8');
        expect(url.startsWith('http')).toBe(true);
    });
});

describe('URLState.capture()', () => {
    it('snapshots map centre, zoom, selected cell, and active score', () => {
        globalThis.MapModule = {
            getMap: () => ({ getCenter: () => ({ lat: 22.7, lng: 75.8 }), getZoom: () => 12 }),
            getSelectedCode: () => '4P3-JK8-39LM',
        };
        ScoreChoropleth.isActive = () => true;
        ScoreChoropleth.getScoreKey = () => 'green';
        const s = U.capture();
        expect(s.ll).toEqual({ lat: 22.7, lng: 75.8 });
        expect(s.z).toBe(12);
        expect(s.cell).toBe('4P3-JK8-39LM');
        expect(s.score).toBe('green');
    });

    it('omits score when the choropleth is inactive', () => {
        globalThis.MapModule = { getMap: () => null, getSelectedCode: () => null };
        ScoreChoropleth.isActive = () => false;
        expect(U.capture().score).toBeUndefined();
    });
});

describe('URLState.apply()', () => {
    it('deep-links a cell via selectByCode and sets the score', () => {
        const selectByCode = vi.fn();
        globalThis.MapModule = { selectByCode, flyTo: vi.fn() };
        ScoreChoropleth.setScore = vi.fn();
        ScoreChoropleth.isActive = () => false;
        ScoreChoropleth.show = vi.fn();
        PrecomputedScores.isEnabled = () => true;

        U.apply({ cell: '4P3JK8', score: 'safety' });
        expect(ScoreChoropleth.setScore).toHaveBeenCalledWith('safety');
        expect(ScoreChoropleth.show).toHaveBeenCalledWith('safety'); // grid enabled + inactive → show
        expect(selectByCode).toHaveBeenCalledWith('4P3JK8');
    });

    it('flies to ll when no cell is given', () => {
        const flyTo = vi.fn();
        globalThis.MapModule = { flyTo, selectByCode: vi.fn() };
        U.apply({ ll: { lat: 1, lng: 2 }, z: 16 });
        expect(flyTo).toHaveBeenCalledWith(1, 2, 16);
    });

    it('does not call show() when the precomputed grid is unavailable', () => {
        ScoreChoropleth.setScore = vi.fn();
        ScoreChoropleth.isActive = () => false;
        ScoreChoropleth.show = vi.fn();
        PrecomputedScores.isEnabled = () => false;
        U.apply({ score: 'safety' });
        expect(ScoreChoropleth.show).not.toHaveBeenCalled();
    });

    it('round-trips the presentation flag', () => {
        expect(U.stringify({ present: true, cell: 'X' })).toContain('present=1');
        expect(U.parse('?present=1').present).toBe(true);
        expect(U.parse('?cell=X').present).toBeUndefined();
        // a falsey present is omitted from the URL
        expect(U.stringify({ cell: 'X' })).not.toContain('present');
    });

    it('round-trips annotations through the share URL', () => {
        const annotations = [{ lat: 22.7, lng: 75.8, text: 'gate', color: '#ff673d' }];
        const qs = U.stringify({ annotations });
        expect(qs).toContain('an=');
        const back = U.parse('?' + qs).annotations;
        expect(back).toHaveLength(1);
        expect(back[0]).toMatchObject({ lat: 22.7, lng: 75.8, text: 'gate' });
        // empty / absent → omitted
        expect(U.stringify({ annotations: [] })).not.toContain('an=');
        expect(U.parse('?cell=X').annotations).toBeUndefined();
        // malformed-but-valid JSON (no real coordinates) is ignored, so it
        // can't sanitise to [] and wipe stored notes
        expect(U.parse('?an=' + encodeURIComponent('[{}]')).annotations).toBeUndefined();
        expect(U.parse('?an=' + encodeURIComponent('not json')).annotations).toBeUndefined();
    });
});
