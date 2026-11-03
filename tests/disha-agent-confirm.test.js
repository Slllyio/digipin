import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// The confirmation gate: DISHATools `confirm` tools wait for hooks.confirm
// before DISHAAgent dispatches them; read tools never ask.
const AG = globalThis.DISHAAgent;
const T = globalThis.DISHATools;

describe('DISHATools confirm metadata', () => {
    it('flags the slow / heavy tools and leaves read tools alone', () => {
        expect(T.needsConfirm('runAgent')).toBe(true);
        expect(T.needsConfirm('runisochrone')).toBe(true);
        expect(T.needsConfirm('colorBuildings')).toBe(true);
        expect(T.needsConfirm('getCellData')).toBe(false);
        expect(T.needsConfirm('flyTo')).toBe(false);
        expect(T.needsConfirm('nope')).toBe(false);
    });

    it('describes a call in one plain sentence', () => {
        expect(T.describeCall('runagent', { agent: 'site', use: 'clinic' })).toBe('Run the site (clinic) agent and paint its result layer');
        expect(T.describeCall('runagent', { agent: 'compare', vs: 'pune' })).toContain('vs pune');
        expect(T.describeCall('runIsochrone', { code: '39J-49L-L8T4' })).toBe('Compute 5/10/15-minute walking zones around 39J-49L-L8T4');
        expect(T.describeCall('colorbuildings', { color: 'scores:flood_risk' })).toContain('scores:flood_risk');
        expect(T.describeCall('getcelldata', {})).not.toMatch(/\.$/);
    });
});

describe('DISHAAgent confirmation gate', () => {
    let origComplete, origExec;
    let executed;
    beforeEach(() => {
        origComplete = globalThis.DISHA.complete;
        origExec = globalThis.DISHAActions.executeAgentActions;
        executed = [];
        globalThis.DISHAActions.executeAgentActions = async (acts) => {
            executed.push(acts[0].type);
            return [{ type: acts[0].type, ok: true, label: `ran ${acts[0].type}` }];
        };
    });
    afterEach(() => {
        globalThis.DISHA.complete = origComplete;
        globalThis.DISHAActions.executeAgentActions = origExec;
    });

    const script = (turns) => { let i = 0; globalThis.DISHA.complete = async () => turns[i++]; };

    it('skips a confirm tool the user declines and tells the model', async () => {
        const seen = [];
        let i = 0;
        const turns = ['Mapping walk zones.\n[ACTION] runIsochrone code:39J49LL8T4', 'Answer without the zones. [DONE]'];
        globalThis.DISHA.complete = async ({ messages }) => { seen.push(messages[messages.length - 1].content); return turns[i++]; };
        const asked = [];
        let chips = null;
        const final = await AG.run('Walkability here?', { context: 'CTX' }, {
            native: false,
            confirm: async (step) => { asked.push(step); return false; },
            onChips: (r) => { chips = r; },
        });
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ type: 'runisochrone' });
        expect(asked[0].text).toContain('walking zones');
        expect(executed).toEqual([]);
        expect(chips[0]).toMatchObject({ type: 'runisochrone', ok: false, skipped: true });
        expect(seen[1]).toContain('the user skipped this step');
        expect(final).toContain('Answer without the zones');
    });

    it('runs read tools without asking and confirm tools once approved', async () => {
        script(['Checking.\n[ACTION] getCellData code:39J49LL8T4\n[ACTION] runIsochrone code:39J49LL8T4', 'Done. [DONE]']);
        const asked = [];
        await AG.run('Q', { context: 'CTX' }, { native: false, confirm: async (s) => { asked.push(s.type); return true; } });
        expect(asked).toEqual(['runisochrone']);
        expect(executed).toEqual(['getcelldata', 'runisochrone']);
    });

    it("'always' approves that tool for the rest of the run", async () => {
        script([
            '[ACTION] runIsochrone code:39J49LL8T4',
            '[ACTION] runIsochrone code:39J49LL8T5',
            'Both mapped. [DONE]',
        ]);
        let asks = 0;
        await AG.run('Q', { context: 'CTX' }, { native: false, confirm: async () => { asks++; return 'always'; } });
        expect(asks).toBe(1);
        expect(executed).toEqual(['runisochrone', 'runisochrone']);
    });

    it('a Stop during the prompt ends the run with an AbortError', async () => {
        script(['[ACTION] runAgent agent:flood', 'never reached [DONE]']);
        const stop = () => { const e = new Error('stopped'); e.name = 'AbortError'; throw e; };
        await expect(AG.run('Q', { context: 'CTX' }, { native: false, confirm: async () => stop() })).rejects.toMatchObject({ name: 'AbortError' });
        expect(executed).toEqual([]);
    });

    it('without a confirm hook, behaves as before (runs without asking)', async () => {
        script(['[ACTION] runIsochrone code:39J49LL8T4', 'ok [DONE]']);
        await AG.run('Q', { context: 'CTX' }, { native: false });
        expect(executed).toEqual(['runisochrone']);
    });
});
