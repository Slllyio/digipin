import { describe, it, expect } from 'vitest';

// DISHATools is exposed on globalThis by tests/setup.js. All functions are pure.
const DT = globalThis.DISHATools;

describe('DISHATools.getTool', () => {
    it('resolves by emitted name or lowercase dispatch type', () => {
        expect(DT.getTool('flyTo').type).toBe('flyto');
        expect(DT.getTool('rankcells').name).toBe('rankCells');
        expect(DT.getTool('nope')).toBeNull();
    });
});

describe('DISHATools.validateArgs', () => {
    it('coerces numeric args and drops unknown keys (allowlist)', () => {
        const v = DT.validateArgs('flyTo', { lat: '22.7', lng: '75.8', zoom: '15', evil: 'x' });
        expect(v.ok).toBe(true);
        expect(v.args).toEqual({ lat: 22.7, lng: 75.8, zoom: 15 });
        expect(v.args).not.toHaveProperty('evil');
    });

    it('rejects a missing required arg', () => {
        const v = DT.validateArgs('getCellData', {});
        expect(v.ok).toBe(false);
        expect(v.error).toMatch(/requires/);
    });

    it('rejects a non-finite number', () => {
        expect(DT.validateArgs('flyTo', { lat: 'abc', lng: 1 }).ok).toBe(false);
    });

    it('validates the overlay enum', () => {
        expect(DT.validateArgs('overlay', { name: 'heat' })).toMatchObject({ ok: true, args: { name: 'heat' } });
        expect(DT.validateArgs('overlay', { name: 'lasers' }).ok).toBe(false);
    });

    it('accepts a valid DIGIPIN code and rejects a hallucinated one', () => {
        expect(DT.validateArgs('getCellData', { code: '39J-49L-L8T4' }).ok).toBe(true);
        expect(DT.validateArgs('getCellData', { code: 'not a code!' }).ok).toBe(false);
    });

    it('splits and validates a DIGIPIN list, rejecting a bad member', () => {
        const v = DT.validateArgs('compareCells', { codes: '39J-49L-L8T4, 39J49LM2K5' });
        expect(v.ok).toBe(true);
        expect(v.args.codes).toBe('39J-49L-L8T4,39J49LM2K5');
        expect(DT.validateArgs('compareCells', { codes: '39J49LL8T4, zzz!' }).ok).toBe(false);
    });

    it('rejects an unknown tool', () => {
        expect(DT.validateArgs('teleport', {}).ok).toBe(false);
    });
});

describe('DISHATools.renderSystemPrompt', () => {
    it('omits agent-only tools in chat mode but lists the four map actions', () => {
        const chat = DT.renderSystemPrompt({ agent: false });
        expect(chat).toMatch(/flyTo/);
        expect(chat).toMatch(/overlay/);
        expect(chat).not.toMatch(/rankCells/);
        expect(chat).not.toMatch(/getCellData/);
    });

    it('includes the analysis tools in agent mode', () => {
        const agent = DT.renderSystemPrompt({ agent: true });
        expect(agent).toMatch(/rankCells/);
        expect(agent).toMatch(/compareCells/);
        expect(agent).toMatch(/OBSERVATION/);
    });
});

describe('overlay allowlist ↔ dispatch table', () => {
    it('the overlay enum stays in sync with DISHAActions.OVERLAYS keys', () => {
        // Guards against drift: validateArgs must accept exactly the overlays the
        // dispatch table can actually toggle (see js/disha-actions.js OVERLAYS).
        const enumVals = DT.getTool('overlay').args.name.values.slice().sort();
        const dispatchKeys = Object.keys(globalThis.DISHAActions.OVERLAYS).sort();
        expect(enumVals).toEqual(dispatchKeys);
    });
});

describe('DISHATools.toOpenAI', () => {
    it('emits function specs and omits the finish sentinel', () => {
        const tools = DT.toOpenAI({ agent: true });
        const names = tools.map(t => t.function.name);
        expect(names).toContain('rankCells');
        expect(names).not.toContain('finish');
        const fly = tools.find(t => t.function.name === 'flyTo');
        expect(fly.function.parameters.required).toContain('lat');
    });
});
