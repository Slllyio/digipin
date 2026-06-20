import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// DISHAActions is exposed on globalThis by tests/setup.js. parse/strip/_parseParams
// are pure; executeActions dispatches against app globals (stubbed below).
const DA = globalThis.DISHAActions;

describe('DISHAActions.parseActions / _parseParams', () => {
    it('parses one action per [ACTION] line with typed params', () => {
        const text = 'Here is the analysis.\n[ACTION] flyTo lat:22.72 lng:75.86 zoom:15\nMore text.';
        const acts = DA.parseActions(text);
        expect(acts).toHaveLength(1);
        expect(acts[0]).toEqual({ type: 'flyto', params: { lat: 22.72, lng: 75.86, zoom: 15 } });
    });

    it('keeps non-numeric values (e.g. DIGIPIN codes, ids) as strings', () => {
        const acts = DA.parseActions('[ACTION] selectCell code:39J-49L-L8T4\n[ACTION] query id:best_residential');
        expect(acts[0].params.code).toBe('39J-49L-L8T4');
        expect(acts[1].params.id).toBe('best_residential');
    });

    it('returns [] when there are no directives', () => {
        expect(DA.parseActions('just a normal answer')).toEqual([]);
    });
});

describe('DISHAActions.stripActions', () => {
    it('removes [ACTION] lines from the shown text', () => {
        const out = DA.stripActions('Answer line 1.\n[ACTION] overlay name:heat\nAnswer line 2.');
        expect(out).toBe('Answer line 1.\nAnswer line 2.');
        expect(out).not.toMatch(/\[ACTION\]/);
    });
});

describe('DISHAActions.executeActions', () => {
    let calls;
    beforeEach(() => {
        calls = [];
        globalThis.MapModule = {
            flyTo: (lat, lng, zoom) => calls.push(['flyTo', lat, lng, zoom]),
            selectByCode: (code) => calls.push(['selectByCode', code]),
        };
        globalThis.HeatOverlay = { toggle: () => calls.push(['HeatOverlay.toggle']) };
    });
    afterEach(() => {
        delete globalThis.MapModule;
        delete globalThis.HeatOverlay;
    });

    it('dispatches valid actions and reports ok with a label', () => {
        const res = DA.executeActions([
            { type: 'flyto', params: { lat: 22.7, lng: 75.8, zoom: 14 } },
            { type: 'overlay', params: { name: 'heat' } },
        ]);
        expect(res[0]).toMatchObject({ type: 'flyto', ok: true });
        expect(res[1]).toMatchObject({ type: 'overlay', ok: true });
        expect(calls).toContainEqual(['flyTo', 22.7, 75.8, 14]);
        expect(calls).toContainEqual(['HeatOverlay.toggle']);
    });

    it('reports ok:false for unknown actions and bad params (without throwing)', () => {
        const res = DA.executeActions([
            { type: 'nope', params: {} },
            { type: 'flyto', params: { lat: 'x' } },
            { type: 'overlay', params: { name: 'does-not-exist' } },
        ]);
        expect(res[0]).toMatchObject({ ok: false, error: 'unknown action' });
        expect(res[1].ok).toBe(false);
        expect(res[2].ok).toBe(false);
    });

    it('caps the number of actions executed', () => {
        const many = Array.from({ length: 6 }, () => ({ type: 'overlay', params: { name: 'heat' } }));
        expect(DA.executeActions(many, 3)).toHaveLength(3);
    });
});
