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
        globalThis.MapModule.getMap = () => ({ _map: true });
        let _wardsVisible = false;
        globalThis.WardOverlay = {
            isVisible: () => _wardsVisible,
            show: () => { _wardsVisible = true; calls.push(['WardOverlay.show']); },
            clear: () => { _wardsVisible = false; calls.push(['WardOverlay.clear']); },
        };
        globalThis.OvertureBuildings = { toggle: (map) => calls.push(['OvertureBuildings.toggle', map]) };
    });
    afterEach(() => {
        delete globalThis.MapModule;
        delete globalThis.HeatOverlay;
        delete globalThis.WardOverlay;
        delete globalThis.OvertureBuildings;
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

    it('adapts non-standard overlays: wards is show/clear, buildings gets the map', () => {
        // wards: first toggle shows, second clears (show()/clear() pair).
        DA.executeActions([{ type: 'overlay', params: { name: 'wards' } }]);
        DA.executeActions([{ type: 'overlay', params: { name: 'wards' } }]);
        expect(calls).toContainEqual(['WardOverlay.show']);
        expect(calls).toContainEqual(['WardOverlay.clear']);
        // buildings: toggle receives the map instance from MapModule.getMap().
        const res = DA.executeActions([{ type: 'overlay', params: { name: 'buildings' } }]);
        expect(res[0].ok).toBe(true);
        expect(calls).toContainEqual(['OvertureBuildings.toggle', { _map: true }]);
    });

    it('rejects overlays that cannot be driven by a bare toggle (e.g. heatmap)', () => {
        const res = DA.executeActions([{ type: 'overlay', params: { name: 'heatmap' } }]);
        expect(res[0].ok).toBe(false);
        expect(res[0].error).toMatch(/unknown overlay/);
    });

    it('caps the number of actions executed', () => {
        const many = Array.from({ length: 6 }, () => ({ type: 'overlay', params: { name: 'heat' } }));
        expect(DA.executeActions(many, 3)).toHaveLength(3);
    });
});

describe('DISHAActions.executeAgentActions (agent tools, async)', () => {
    let origDigiPin, origDataFetcher;
    beforeEach(() => {
        DA._resetAgentState();
        origDigiPin = globalThis.DigiPin;
        origDataFetcher = globalThis.DataFetcher;
        // Deterministic stubs for the read-tool data path.
        globalThis.DigiPin = { decode: () => ({ lat: 22.7, lng: 75.8 }) };
        globalThis.DataFetcher = {
            fetchAllFeatures: async () => ({
                scores: {
                    safety: { value: 72, label: 'Safety' },
                    healthcare_access: { value: 18, label: 'Healthcare' },
                    empty: { value: 0, label: 'Empty' },
                },
            }),
        };
    });
    afterEach(() => {
        globalThis.DigiPin = origDigiPin;
        globalThis.DataFetcher = origDataFetcher;
        delete globalThis.MapModule;
        DA._resetAgentState();
    });

    it('getCellData returns a {label, observation} with the non-zero scores', async () => {
        const res = await DA.executeAgentActions([{ type: 'getcelldata', params: { code: '39J49LL8T4' } }]);
        expect(res[0]).toMatchObject({ type: 'getcelldata', ok: true });
        expect(res[0].observation).toContain('safety=72');
        expect(res[0].observation).toContain('healthcare_access=18');
        expect(res[0].observation).not.toContain('empty=0');
    });

    it('rejects a hallucinated DIGIPIN code via validateArgs (no throw)', async () => {
        const res = await DA.executeAgentActions([{ type: 'getcelldata', params: { code: 'not a code!' } }]);
        expect(res[0]).toMatchObject({ ok: false });
        expect(res[0].error).toMatch(/invalid DIGIPIN/);
    });

    it('enforces the per-run map-mutation cap for state-changing tools', async () => {
        globalThis.MapModule = { flyTo: () => {}, getMap: () => ({}) };
        const counters = { mutations: 0 };
        const res = await DA.executeAgentActions([
            { type: 'flyto', params: { lat: 1, lng: 2 } },
            { type: 'flyto', params: { lat: 3, lng: 4 } },
        ], { max: 3, mapMutationCap: 1, counters });
        expect(res[0].ok).toBe(true);
        expect(res[1]).toMatchObject({ ok: false });
        expect(res[1].error).toMatch(/limit/);
    });

    it('reports unknown actions without throwing', async () => {
        const res = await DA.executeAgentActions([{ type: 'teleport', params: {} }]);
        expect(res[0]).toMatchObject({ ok: false, error: 'unknown action' });
    });
});
