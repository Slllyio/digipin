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

describe('DISHAAgent native function-calling helpers', () => {
    it('maps native tool calls to registry actions, keeping or synthesizing ids', () => {
        const acts = AG.toolCallsToActions([
            { id: 'c1', name: 'getCellData', arguments: '{"code":"39J49LL8T4"}' },
            { name: 'rankCells', arguments: '' },
        ], 2);
        expect(acts[0]).toMatchObject({ type: 'getcelldata', id: 'c1', params: { code: '39J49LL8T4' } });
        expect(acts[1]).toMatchObject({ type: 'rankcells', id: 'call_2_1', params: {} });
        expect(acts[1].badArgs).toBeUndefined();
    });

    it('flags arguments that are not a JSON object', () => {
        const acts = AG.toolCallsToActions([
            { id: 'a', name: 'getCellData', arguments: '{oops' },
            { id: 'b', name: 'getCellData', arguments: '[1,2]' },
        ]);
        expect(acts.every(a => a.badArgs)).toBe(true);
    });

    it('answers every call with a tool message, including calls past the cap', () => {
        const acts = AG.toolCallsToActions([
            { id: 'x', name: 'getCellData', arguments: '{"code":"39J"}' },
            { id: 'y', name: 'rankCells', arguments: '{}' },
        ]);
        const out = AG.nextMessagesNative([{ role: 'user', content: 'q' }], '', acts,
            [{ type: 'getcelldata', ok: true, observation: 'safety=81' }]);
        expect(out).toHaveLength(4);
        expect(out[1]).toMatchObject({ role: 'assistant', content: null });
        expect(out[1].tool_calls.map(c => c.id)).toEqual(['x', 'y']);
        expect(out[1].tool_calls[1].function).toEqual({ name: 'rankCells', arguments: '{}' });
        expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'x', content: 'safety=81' });
        expect(out[3]).toMatchObject({ role: 'tool', tool_call_id: 'y' });
        expect(out[3].content).toContain('not run');
    });

    it('leaves the [ACTION] catalog out of the native system prompt', () => {
        const text = AG.buildSystemPrompt();
        const native = AG.buildSystemPrompt({ native: true });
        expect(text).toContain('[ACTION]');
        expect(native).not.toContain('[ACTION] getCellData');
        expect(native).toContain('call the provided tools');
    });

    it('carries the OpenAI tools array in native run state', () => {
        const st = AG.initState('q', null, { native: true });
        expect(st.native).toBe(true);
        expect(st.tools.map(t => t.function.name)).toContain('getCellData');
        expect(AG.initState('q', null).tools).toBeNull();
    });
});

describe('DISHAAgent.run (native function-calling, scripted model)', () => {
    let origComplete, origCompleteTurn, origDigiPin, origDataFetcher;
    beforeEach(() => {
        globalThis.DISHAActions._resetAgentState();
        origComplete = globalThis.DISHA.complete;
        origCompleteTurn = globalThis.DISHA.completeTurn;
        origDigiPin = globalThis.DigiPin;
        origDataFetcher = globalThis.DataFetcher;
        globalThis.DigiPin = { decode: () => ({ lat: 22.7, lng: 75.8 }) };
        globalThis.DataFetcher = {
            fetchAllFeatures: async () => ({ scores: { safety: { value: 81, label: 'Safety' } } }),
        };
    });
    afterEach(() => {
        globalThis.DISHA.complete = origComplete;
        globalThis.DISHA.completeTurn = origCompleteTurn;
        globalThis.DigiPin = origDigiPin;
        globalThis.DataFetcher = origDataFetcher;
        globalThis.DISHAActions._resetAgentState();
    });

    it('sends tools, runs structured calls, and returns results as tool messages', async () => {
        const turns = [
            { text: 'Checking the cell.', toolCalls: [{ id: 'call_a', name: 'getCellData', arguments: '{"code":"39J49LL8T4"}' }] },
            { text: 'Safety is strong, so it is a good candidate.', toolCalls: [] },
        ];
        const seen = [];
        let i = 0;
        globalThis.DISHA.completeTurn = async (req) => { seen.push(req); return turns[i++]; };
        globalThis.DISHA.complete = async () => { throw new Error('text path should not be used'); };

        let chips = null;
        const final = await AG.run('Where should a clinic go?', { context: 'CTX' }, {
            native: true, onChips: (r) => { chips = r; },
        });

        expect(final).toContain('good candidate');
        expect(i).toBe(2);
        expect(seen[0].tools.length).toBeGreaterThan(0);
        expect(seen[0].system).not.toContain('[ACTION] getCellData');
        expect(chips[0]).toMatchObject({ type: 'getcelldata', ok: true });
        const msgs = seen[1].messages;
        expect(msgs[msgs.length - 2].tool_calls[0].id).toBe('call_a');
        expect(msgs[msgs.length - 1]).toMatchObject({ role: 'tool', tool_call_id: 'call_a' });
        expect(msgs[msgs.length - 1].content).toContain('safety=81');
    });

    it('reports malformed arguments back to the model without executing', async () => {
        const turns = [
            { text: '', toolCalls: [{ id: 'bad', name: 'getCellData', arguments: '{not json' }] },
            { text: 'I could not read that cell.', toolCalls: [] },
        ];
        let i = 0;
        let second = null;
        globalThis.DISHA.completeTurn = async (req) => { if (i === 1) second = req; return turns[i++]; };
        let chips = null;
        await AG.run('Assess.', null, { native: true, onChips: (r) => { chips = r; } });
        expect(chips[0]).toMatchObject({ type: 'getcelldata', ok: false });
        expect(second.messages[second.messages.length - 1].content).toContain('not a valid JSON object');
    });

    it('falls back to the text protocol when the provider rejects tools', async () => {
        globalThis.DISHA.completeTurn = async () => { throw new Error('API 400: tools not supported'); };
        let textCalls = 0;
        globalThis.DISHA.complete = async ({ system }) => {
            textCalls++;
            expect(system).toContain('[ACTION]');
            return 'Here is the answer.';
        };
        const final = await AG.run('Assess.', null, { native: true });
        expect(final).toBe('Here is the answer.');
        expect(textCalls).toBe(1);
    });

    it('synthesizes with tools off when the budget runs out', async () => {
        const call = (n) => ({ text: '', toolCalls: [{ id: `c${n}`, name: 'getCellData', arguments: '{"code":"39J49LL8T4"}' }] });
        let i = 0;
        let last = null;
        globalThis.DISHA.completeTurn = async (req) => {
            last = req;
            i++;
            return req.toolChoice === 'none' ? { text: 'Final synthesis.', toolCalls: [] } : call(i);
        };
        const final = await AG.run('Keep digging.', null, { native: true });
        expect(final).toBe('Final synthesis.');
        expect(last.toolChoice).toBe('none');
        expect(i).toBe(AG.MAX_ITERS + 1);
    });
});
