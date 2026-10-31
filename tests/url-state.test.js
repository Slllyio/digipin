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

describe('URLState layers param', () => {
    it('parses, validates and de-duplicates layer tokens', () => {
        expect(U.parseLayers('heat,dt:overture_roads,cell:traffic,heat')).toEqual(['heat', 'dt:overture_roads', 'cell:traffic']);
        expect(U.parseLayers('heat,<script>,x:y,,ndvi')).toEqual(['heat', 'ndvi']);
        expect(U.parseLayers(Array(30).fill(0).map((_, i) => 'l' + i).join(','))).toHaveLength(20);
        expect(U.parseLayers(null)).toEqual([]);
    });

    it('round-trips through stringify/parse', () => {
        const qs = U.stringify({ cell: 'X', layers: ['ndvi', 'dt:osm_roads'] });
        expect(qs).toContain('layers=ndvi%2Cdt%3Aosm_roads');
        expect(U.parse('?' + qs).layers).toEqual(['ndvi', 'dt:osm_roads']);
        expect(U.stringify({ cell: 'X', layers: [] })).not.toContain('layers');
    });

    it('captures active overlays but not interactive tools', () => {
        const ids = ['btn-ndvi', 'btn-measure', 'btn-choropleth'];
        ids.forEach(id => {
            const b = document.createElement('button');
            b.id = id;
            b.className = 'active';
            document.body.appendChild(b);
        });
        try {
            expect(U.activeLayers()).toEqual(['ndvi']);
        } finally {
            ids.forEach(id => document.getElementById(id).remove());
        }
    });

    it('drives only known, inactive overlays on apply', () => {
        const btn = document.createElement('button');
        btn.id = 'btn-heat';
        const clicks = vi.fn(() => btn.classList.add('active'));
        btn.addEventListener('click', clicks);
        document.body.appendChild(btn);
        try {
            U.applyLayers(['heat', 'heat', 'measure', 'bogus']);
            expect(clicks).toHaveBeenCalledTimes(1);   // second 'heat' sees it already active
        } finally {
            btn.remove();
        }
    });

    it('toggles Digital-Twin layers that exist and are off', () => {
        const real = { toggle: DigitalTwinLayers.toggle, isVisible: DigitalTwinLayers.isVisible };
        DigitalTwinLayers.toggle = vi.fn(() => Promise.resolve(true));
        DigitalTwinLayers.isVisible = () => false;
        try {
            U.applyLayers(['dt:overture_roads', 'dt:not_a_layer']);
            expect(DigitalTwinLayers.toggle).toHaveBeenCalledTimes(1);
            expect(DigitalTwinLayers.toggle.mock.calls[0][0]).toBe('overture_roads');
        } finally {
            Object.assign(DigitalTwinLayers, real);
        }
    });
});

describe('URLState time-slider step (t=)', () => {
    it('round-trips ISO steps and drops malformed ones', () => {
        expect(U.parse('?t=2025-04').t).toBe('2025-04');
        expect(U.parse('?t=2025-04-09').t).toBe('2025-04-09');
        expect(U.parse('?t=2025').t).toBe('2025');
        expect(U.parse('?t=April').t).toBeUndefined();
        expect(U.parse('?t=2025-4').t).toBeUndefined();
        expect(U.stringify({ t: '2025-04', layers: ['cell:lst_monthly'] })).toBe('layers=cell%3Alst_monthly&t=2025-04');
        expect(U.stringify({ t: 'bad' })).toBe('');
    });

    it('apply() hands the step to TimeSlider before the layers load', () => {
        const want = vi.spyOn(TimeSlider, 'want');
        U.apply({ t: '2025-04' });
        expect(want).toHaveBeenCalledWith('2025-04');
    });
});
