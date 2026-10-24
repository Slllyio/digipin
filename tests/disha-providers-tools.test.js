import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// End-to-end check of streamOpenAI's native function-calling against a mocked
// SSE response. Kept in its own file because it switches the active provider
// (module state) to Groq.
const DP = globalThis.DISHAProviders;

function sse(chunks) {
    const enc = new TextEncoder();
    const body = chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
    return new Response(new ReadableStream({
        start(ctrl) { ctrl.enqueue(enc.encode(body)); ctrl.close(); },
    }), { status: 200 });
}

describe('DISHAProviders.stream with native tools', () => {
    beforeAll(async () => {
        DP.saveConfig({ preferred: 'groq', keys: { groq: 'test-key' }, custom: { baseUrl: '', model: '' } });
        await DP.detectProvider();
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('sends tools + tool_choice and reports stitched tool calls', async () => {
        let sent = null;
        vi.stubGlobal('fetch', async (_url, init) => {
            sent = JSON.parse(init.body);
            return sse([
                { choices: [{ delta: { content: 'Checking. ' } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'getCellData', arguments: '{"code":' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"39J"}' } }] } }] },
                '[DONE]',
            ]);
        });
        let calls = null;
        const tools = [{ type: 'function', function: { name: 'getCellData', parameters: { type: 'object', properties: {} } } }];
        const text = await DP.stream({ system: 's', messages: [], onToken: () => {}, tools, onToolCalls: (c) => { calls = c; } });
        expect(DP.getProviderType()).toBe('openai');
        expect(sent.tools).toEqual(tools);
        expect(sent.tool_choice).toBe('auto');
        expect(text).toBe('Checking. ');
        expect(calls).toEqual([{ id: 'call_1', name: 'getCellData', arguments: '{"code":"39J"}' }]);
    });

    it('omits tools from the request when none are given', async () => {
        let sent = null;
        vi.stubGlobal('fetch', async (_url, init) => {
            sent = JSON.parse(init.body);
            return sse([{ choices: [{ delta: { content: 'hi' } }] }, '[DONE]']);
        });
        const onToolCalls = vi.fn();
        expect(await DP.stream({ system: 's', messages: [], onToken: () => {}, onToolCalls })).toBe('hi');
        expect(sent.tools).toBeUndefined();
        expect(sent.tool_choice).toBeUndefined();
        expect(onToolCalls).not.toHaveBeenCalled();
    });
});
