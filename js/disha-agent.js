/**
 * DISHAAgent — the Urban Analyst Agent: a closed ReAct loop over DISHA's tools.
 *
 * Where single-shot DISHA (js/disha.js `ask`) answers in one turn and executes
 * any `[ACTION]` directives *after* the reply, the agent runs a loop:
 *
 *   plan → act → observe → continue
 *
 * Each turn the model may emit tool directives; the app executes them
 * (js/disha-actions.js `executeAgentActions`, async, allowlist-validated), and
 * their results are fed back as an `[OBSERVATION]` user turn so the model can
 * reason over real evidence and take the next step. It stops when the model
 * gives a final answer (no tools / `[DONE]` / a `finish` directive) or when the
 * iteration/tool budget is spent.
 *
 * On OpenAI-type providers (Groq, OpenAI, any compatible API) the loop uses
 * native function-calling instead: the tool schema goes out as a `tools`
 * array (DISHATools.toOpenAI), calls come back as structured `tool_calls`, and
 * each result is returned as a `role:"tool"` message. Text `[ACTION]` lines
 * are still honoured as a fallback, and if the provider rejects `tools` on the
 * first turn the run drops back to the text protocol. Ollama always uses text.
 *
 * The pure helpers (initState, buildSystemPrompt, buildObservation, isFinal,
 * nextMessages, toolCallsToActions, nextMessagesNative, cleanProse) are
 * side-effect-free and unit-tested; `run` is the only impure entry point and
 * it delegates all side effects to DISHAActions.
 */
const DISHAAgent = (() => {
    const MAX_ITERS = 4;          // hard cap on model turns
    const ACTIONS_PER_STEP = 3;   // directives executed per turn (matches single-shot cap)
    const AGENT_BUDGET = 8;       // total tool calls across the whole run
    const MAP_MUTATION_CAP = 2;   // state-changing (camera/overlay) tools per run

    const AGENT_PROTOCOL =
        'You are operating as an autonomous analyst. Think step by step: call tools to '
        + 'gather evidence, read each [OBSERVATION] that comes back, then decide the next '
        + 'step. When you have enough to answer, write the final answer in plain language '
        + 'and end with [DONE] (or emit [ACTION] finish). Prefer read tools (getCellData, '
        + 'compareCells, generateSiteBrief) to justify claims; use rankCells to find '
        + 'candidates first. Do not repeat a tool call you have already made.';

    const NATIVE_PROTOCOL =
        'You are operating as an autonomous analyst. Think step by step: call the provided '
        + 'tools to gather evidence, read each tool result, then decide the next step. When '
        + 'you have enough to answer, reply with the final answer in plain language and call '
        + 'no more tools. Prefer read tools (getCellData, compareCells, generateSiteBrief) to '
        + 'justify claims; use rankCells to find candidates first. Do not repeat a tool call '
        + 'you have already made.';

    /** Base role text without the single-shot map-action block (the agent adds the full tool list). */
    function _baseRole() {
        const raw = (typeof DISHA !== 'undefined' && DISHA.SYSTEM_PROMPT) ? DISHA.SYSTEM_PROMPT : '';
        return raw.split(/\nMAP ACTIONS/)[0].trim();
    }

    /**
     * Assemble the agent's system prompt: role + loop protocol + tool catalog +
     * language. In native mode the catalog travels as the `tools` array, so the
     * text `[ACTION]` block is left out. Pure-ish (reads globals).
     */
    function buildSystemPrompt(opts = {}) {
        const native = !!opts.native;
        const tools = (!native && typeof DISHATools !== 'undefined') ? DISHATools.renderSystemPrompt({ agent: true }) : '';
        const lang = (typeof DISHA !== 'undefined' && DISHA.languageDirective) ? DISHA.languageDirective() : '';
        return [_baseRole(), native ? NATIVE_PROTOCOL : AGENT_PROTOCOL, tools].filter(Boolean).join('\n\n') + lang;
    }

    /** True when this run should use native function-calling (OpenAI-type provider). Reads globals. */
    function nativeAvailable() {
        return typeof DISHAProviders !== 'undefined' && DISHAProviders.getProviderType
            && DISHAProviders.getProviderType() === 'openai'
            && typeof DISHA !== 'undefined' && typeof DISHA.completeTurn === 'function'
            && typeof DISHATools !== 'undefined' && typeof DISHATools.toOpenAI === 'function';
    }

    /** The opening user turn: selected-cell context (if any) + the task. Pure. */
    function buildFirstUserMessage(question, ground) {
        let m = '';
        if (ground && ground.context) m += `[SELECTED CELL DATA]\n${ground.context}\n\n`;
        m += `[TASK]\n${question}`;
        return m;
    }

    /** Fresh run state. Pure. */
    function initState(question, ground, opts = {}) {
        const native = !!opts.native;
        return {
            question,
            native,
            tools: native && typeof DISHATools !== 'undefined' ? DISHATools.toOpenAI({ agent: true }) : null,
            system: buildSystemPrompt({ native }),
            messages: [{ role: 'user', content: buildFirstUserMessage(question, ground) }],
            iter: 0,
            calls: 0,
            counters: { mutations: 0 },
        };
    }

    /** One tool result as a line of observation text. Pure. */
    function _observationLine(r) {
        if (r.ok) return r.observation ? r.observation : `${r.type} ok — ${r.label}`;
        return `${r.type} failed — ${r.error}`;
    }

    /** Render tool results into an [OBSERVATION] block the model reads next turn. Pure. */
    function buildObservation(results) {
        const lines = ['[OBSERVATION]'];
        for (const r of (results || [])) lines.push(_observationLine(r));
        if (lines.length === 1) lines.push('(no tools ran)');
        return lines.join('\n');
    }

    /** True when the turn is a final answer: a finish directive, a [DONE] marker, or no actionable tools. Pure. */
    function isFinal(turn, acts) {
        const list = acts || [];
        if (list.some(a => a.type === 'finish')) return true;
        if (/\[DONE\]/i.test(String(turn || ''))) return true;
        return list.filter(a => a.type !== 'finish').length === 0;
    }

    /** Append the model turn and the observation as the next pair of messages. Pure. */
    function nextMessages(messages, turn, obs) {
        return [...messages, { role: 'assistant', content: turn }, { role: 'user', content: obs }];
    }

    /**
     * Native tool calls → the agent's action shape. Tool names map back to the
     * registry `type` via DISHATools; ids are kept (or synthesized) so each result
     * can answer its call. Arguments that are not a JSON object are flagged with
     * `badArgs` and never executed. Pure.
     */
    function toolCallsToActions(calls, iter = 0) {
        return (calls || []).map((c, i) => {
            const tool = (typeof DISHATools !== 'undefined') ? DISHATools.getTool(c.name) : null;
            const a = {
                type: tool ? tool.type : String(c.name || '').toLowerCase(),
                name: c.name,
                id: c.id || `call_${iter}_${i}`,
                args: c.arguments || '',
                params: {},
            };
            if (a.args.trim()) {
                try {
                    const p = JSON.parse(a.args);
                    if (p && typeof p === 'object' && !Array.isArray(p)) a.params = p;
                    else a.badArgs = true;
                } catch { a.badArgs = true; }
            }
            return a;
        });
    }

    /**
     * Append a native turn: the assistant message carrying its `tool_calls`,
     * then one `role:"tool"` message per call. A call past the per-step cap gets
     * a "not run" result, because the API expects every call to be answered. Pure.
     */
    function nextMessagesNative(messages, turn, acts, results) {
        const out = [...messages, {
            role: 'assistant',
            content: turn || null,
            tool_calls: acts.map(a => ({ id: a.id, type: 'function', function: { name: a.name, arguments: a.args || '{}' } })),
        }];
        acts.forEach((a, i) => {
            const r = results[i];
            out.push({ role: 'tool', tool_call_id: a.id, content: r ? _observationLine(r) : `${a.type} not run — per-step tool limit reached` });
        });
        return out;
    }

    /** Strip directives and the [DONE] marker from text shown to the user. Pure. */
    function cleanProse(turn) {
        const stripped = (typeof DISHAActions !== 'undefined') ? DISHAActions.stripActions(turn) : String(turn || '');
        return stripped.replace(/\[DONE\]/ig, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    /**
     * One model turn → `{ text, toolCalls }`. Native runs go through
     * DISHA.completeTurn with the tools array; text runs through DISHA.complete.
     */
    async function _turn(state, toolChoice) {
        if (state.native) {
            const r = await DISHA.completeTurn({ system: state.system, messages: state.messages, tools: state.tools, toolChoice });
            return { text: r.text || '', toolCalls: r.toolCalls || [] };
        }
        return { text: await DISHA.complete({ system: state.system, messages: state.messages }), toolCalls: [] };
    }

    /**
     * Ask the model for a final plain-language answer from the messages gathered
     * so far, with tools off. Used when tools/iterations are exhausted, and when
     * a final *signal* (a bare `[ACTION] finish` / `[DONE]`) arrives with no
     * prose — so "I'm done" never terminates the run with an empty answer.
     */
    async function finalize(state, extra, onAssistant) {
        const msgs = [
            ...state.messages,
            ...extra,
            { role: 'user', content: 'Provide your final answer now, based on the observations gathered so far, in plain language and with no [ACTION] directives.' },
        ];
        const { text: raw } = await _turn({ ...state, messages: msgs }, 'none');
        const text = cleanProse(raw);
        if (text) onAssistant(text, { final: true });
        return text;
    }

    /** Execute a turn's actions within the run budget; malformed native args fail without running. */
    async function _execute(state, actionable) {
        if (!actionable.length || state.calls >= AGENT_BUDGET) return [];
        const cap = Math.min(ACTIONS_PER_STEP, AGENT_BUDGET - state.calls);
        const results = [];
        for (const a of actionable.slice(0, cap)) {
            if (a.badArgs) { results.push({ type: a.type, ok: false, error: 'arguments were not a valid JSON object' }); continue; }
            const [r] = await DISHAActions.executeAgentActions([a], {
                max: 1, mapMutationCap: MAP_MUTATION_CAP, counters: state.counters,
            });
            if (r) results.push(r);
        }
        state.calls += results.length;
        return results;
    }

    /**
     * Run the agent loop.
     * @param {string} question
     * @param {{cell?,data?,context?,bounds?}} ground  selected-cell grounding
     * @param {{onAssistant?,onChips?,native?}} hooks  UI callbacks (per iteration);
     *        `native` forces function-calling on/off (default: auto-detect)
     * @returns {Promise<string>} the final answer text
     */
    async function run(question, ground, hooks = {}) {
        if (typeof DISHA === 'undefined' || !DISHA.complete) throw new Error('DISHA.complete unavailable');
        const onAssistant = hooks.onAssistant || (() => {});
        const onChips = hooks.onChips || (() => {});
        const native = hooks.native !== undefined ? !!hooks.native : nativeAvailable();

        let state = initState(question, ground, { native });

        while (state.iter < MAX_ITERS) {
            let turnOut;
            try {
                turnOut = await _turn(state);
            } catch (err) {
                // A provider that rejects `tools` fails on the very first turn;
                // drop to the text protocol for the rest of the run.
                if (err && err.name !== 'AbortError' && state.native && state.iter === 0) {
                    state = initState(question, ground, { native: false });
                    continue;
                }
                throw err;
            }
            const turn = turnOut.text;
            const nativeActs = state.native ? toolCallsToActions(turnOut.toolCalls, state.iter) : [];
            const textActs = (typeof DISHAActions !== 'undefined') ? DISHAActions.parseActions(turn) : [];
            // Structured calls win; text directives are the fallback for models
            // that ignore the tools array and write [ACTION] lines anyway.
            const acts = nativeActs.length ? nativeActs : textActs;
            const prose = cleanProse(turn);
            const actionable = acts.filter(a => a.type !== 'finish');
            const final = isFinal(turn, acts) || state.calls >= AGENT_BUDGET;

            // Run this turn's tool directives FIRST — even on a final turn — so a
            // closing "generateSiteBrief + selectCell + [DONE]" still executes and
            // renders chips instead of being silently dropped.
            const results = await _execute(state, actionable);
            if (results.length) onChips(results);

            // How this turn and its results go back to the model.
            const append = (msgs) => (nativeActs.length
                ? nextMessagesNative(msgs, turn, nativeActs, results)
                : nextMessages(msgs, turn, buildObservation(results)));

            if (final) {
                if (prose) { onAssistant(prose, { final: true }); return prose; }
                // Final signal (bare finish/[DONE]) with no prose → synthesize the
                // answer from this turn plus any observations it just produced.
                let extra;
                if (nativeActs.length) extra = nextMessagesNative([], turn, nativeActs, results);
                else {
                    extra = [{ role: 'assistant', content: turn }];
                    if (results.length) extra.push({ role: 'user', content: buildObservation(results) });
                }
                return await finalize(state, extra, onAssistant);
            }

            // Not final: narrate this step, feed observations back, continue.
            if (prose) onAssistant(prose, { final: false });
            state.messages = append(state.messages);
            state.iter++;

            if (state.iter >= MAX_ITERS || state.calls >= AGENT_BUDGET) {
                return await finalize(state, [], onAssistant);
            }
        }

        return '';
    }

    return {
        run,
        // pure helpers (exported for tests)
        initState, buildSystemPrompt, buildFirstUserMessage, nativeAvailable,
        buildObservation, isFinal, nextMessages, toolCallsToActions, nextMessagesNative, cleanProse,
        MAX_ITERS, ACTIONS_PER_STEP, AGENT_BUDGET, MAP_MUTATION_CAP,
    };
})();

if (typeof window !== 'undefined') window.DISHAAgent = DISHAAgent;
