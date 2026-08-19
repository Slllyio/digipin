import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// DISHAAgent is exposed on globalThis by tests/setup.js. The loop (`run`) is
// impure; the pure loop-state helpers are tested directly and the loop itself
// is driven end-to-end with a scripted DISHA.complete at the bottom.
const AG = globalThis.DISHAAgent;

describe('DISHAAgent.buildObservation', () => {
    it('renders ok results (observation preferred) and failures', () => {
        const obs = AG.buildObservation([
            { type: 'getcelldata', ok: true, observation: 'getCellData 39J: safety=72' },
            { type: 'rankcells', ok: true, label: 'Ranked 5 cells' },
            { type: 'flyto', ok: false, error: 'bad coords' },
        ]);
        expect(obs).toMatch(/^\[OBSERVATION\]/);
        expect(obs).toContain('safety=72');
        expect(obs).toContain('rankcells ok — Ranked 5 cells');
        expect(obs).toContain('flyto failed — bad coords');
    });

    it('marks an empty result set', () => {
        expect(AG.buildObservation([])).toContain('(no tools ran)');
    });
});

describe('DISHAAgent.isFinal', () => {
    it('is final when there are no actionable directives', () => {
        expect(AG.isFinal('Here is my answer.', [])).toBe(true);
    });
    it('is final on a [DONE] marker even with actions present', () => {
        expect(AG.isFinal('Answer [DONE]', [{ type: 'flyto' }])).toBe(true);
    });
    it('is final on an explicit finish directive', () => {
        expect(AG.isFinal('thinking', [{ type: 'finish' }])).toBe(true);
    });
    it('is NOT final while the turn still calls tools', () => {
        expect(AG.isFinal('let me check', [{ type: 'rankcells' }])).toBe(false);
    });
});

describe('DISHAAgent.nextMessages', () => {
    it('appends the assistant turn and the observation as a user turn', () => {
        const out = AG.nextMessages([{ role: 'user', content: 'q' }], 'turn text', '[OBSERVATION]\nx');
        expect(out).toHaveLength(3);
        expect(out[1]).toEqual({ role: 'assistant', content: 'turn text' });
        expect(out[2]).toEqual({ role: 'user', content: '[OBSERVATION]\nx' });
    });
});

describe('DISHAAgent.cleanProse', () => {
    it('strips [ACTION] directives and the [DONE] marker from shown text', () => {
        const out = AG.cleanProse('Findings.\n[ACTION] flyTo lat:1 lng:2\nDone here. [DONE]');
        expect(out).toBe('Findings.\nDone here.');
        expect(out).not.toMatch(/\[ACTION\]|\[DONE\]/);
    });
});

describe('DISHAAgent.initState / buildSystemPrompt', () => {
    it('seeds the first user message with the cell context and task', () => {
        const st = AG.initState('Where should a clinic go?', { context: 'CELL-CONTEXT-BLOB' });
        expect(st.iter).toBe(0);
        expect(st.calls).toBe(0);
        expect(st.counters.mutations).toBe(0);
        expect(st.messages).toHaveLength(1);
        expect(st.messages[0].role).toBe('user');
        expect(st.messages[0].content).toContain('CELL-CONTEXT-BLOB');
        expect(st.messages[0].content).toContain('Where should a clinic go?');
    });

    it('builds a system prompt that advertises the agent tools + loop protocol', () => {
        const sys = AG.buildSystemPrompt();
        expect(sys).toMatch(/rankCells/);
        expect(sys).toMatch(/OBSERVATION/);
        expect(sys).toMatch(/step by step/i);
    });
});

describe('DISHAAgent.run (loop mechanics, scripted model)', () => {
    let origComplete, origDigiPin, origDataFetcher;
    beforeEach(() => {
        globalThis.DISHAActions._resetAgentState();
        origComplete = globalThis.DISHA.complete;
        origDigiPin = globalThis.DigiPin;
        origDataFetcher = globalThis.DataFetcher;
        globalThis.DigiPin = { decode: () => ({ lat: 22.7, lng: 75.8 }) };
        globalThis.DataFetcher = {
            fetchAllFeatures: async () => ({ scores: { safety: { value: 81, label: 'Safety' } } }),
        };
    });
    afterEach(() => {
        globalThis.DISHA.complete = origComplete;
        globalThis.DigiPin = origDigiPin;
        globalThis.DataFetcher = origDataFetcher;
        globalThis.DISHAActions._resetAgentState();
    });

    it('plans → calls a tool → observes → gives a final answer', async () => {
        // Scripted two-turn model: turn 1 calls a read tool, turn 2 concludes.
        const turns = [
            'Let me check that cell.\n[ACTION] getCellData code:39J49LL8T4',
            'Safety there is strong, so it is a good candidate. [DONE]',
        ];
        let i = 0;
        const seen = [];
        globalThis.DISHA.complete = async ({ messages }) => {
            seen.push(messages[messages.length - 1].content);   // remember the latest turn input
            return turns[i++];
        };

        const proseFinal = [];
        let chipResults = null;
        const final = await AG.run('Where should a clinic go, and why?', { context: 'CTX' }, {
            onAssistant: (text, meta) => { if (meta.final) proseFinal.push(text); },
            onChips: (r) => { chipResults = r; },
        });

        // Terminated with the cleaned final answer (no [DONE]).
        expect(final).toContain('good candidate');
        expect(final).not.toMatch(/\[DONE\]/);
        expect(proseFinal).toHaveLength(1);

        // The tool actually ran and produced a chip with a real observation.
        expect(chipResults).toHaveLength(1);
        expect(chipResults[0]).toMatchObject({ type: 'getcelldata', ok: true });

        // Turn 2 saw the observation fed back from turn 1's tool call.
        expect(seen[1]).toContain('[OBSERVATION]');
        expect(seen[1]).toContain('safety=81');

        // Exactly two model turns (no runaway loop).
        expect(i).toBe(2);
    });

    it('synthesizes an answer when the model ends with a bare [ACTION] finish', async () => {
        // Turn 1 gathers data; turn 2 is a *bare* finish directive with no prose;
        // the loop must then force a synthesis turn rather than return empty.
        const turns = [
            'Checking.\n[ACTION] getCellData code:39J49LL8T4',
            '[ACTION] finish',
            'Based on the data, safety is strong here.',
        ];
        let i = 0;
        globalThis.DISHA.complete = async () => turns[i++];

        const finalProse = [];
        const final = await AG.run('Assess this area, then finish.', { context: 'CTX' }, {
            onAssistant: (t, meta) => { if (meta.final) finalProse.push(t); },
            onChips: () => {},
        });

        expect(final).toContain('safety is strong');
        expect(finalProse).toEqual(['Based on the data, safety is strong here.']);
        expect(i).toBe(3);   // gather → bare finish → forced synthesis
    });

    it('executes tool directives on a final [DONE] turn before returning', async () => {
        // One final turn carries both a directive and the answer + [DONE]. The
        // directive must run (chip) rather than being dropped by early return.
        globalThis.DISHA.complete = async () =>
            'Assessment:\n[ACTION] getCellData code:39J49LL8T4\nSafe and central. [DONE]';
        let chips = null;
        const finals = [];
        const final = await AG.run('Assess this cell.', { context: 'CTX' }, {
            onAssistant: (t, m) => { if (m.final) finals.push(t); },
            onChips: (r) => { chips = r; },
        });
        expect(final).toContain('Safe and central');
        expect(finals).toHaveLength(1);
        expect(finals[0]).toContain('Safe and central');
        expect(chips).toHaveLength(1);
        expect(chips[0]).toMatchObject({ type: 'getcelldata', ok: true });
    });
});
