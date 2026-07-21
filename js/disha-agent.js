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
 * The pure helpers (initState, buildSystemPrompt, buildObservation, isFinal,
 * nextMessages, cleanProse) are side-effect-free and unit-tested; `run` is the
 * only impure entry point and it delegates all side effects to DISHAActions.
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

    /** Base role text without the single-shot map-action block (the agent adds the full tool list). */
    function _baseRole() {
        const raw = (typeof DISHA !== 'undefined' && DISHA.SYSTEM_PROMPT) ? DISHA.SYSTEM_PROMPT : '';
        return raw.split(/\nMAP ACTIONS/)[0].trim();
    }

    /** Assemble the agent's system prompt: role + loop protocol + tool catalog + language. Pure-ish (reads globals). */
    function buildSystemPrompt() {
        const tools = (typeof DISHATools !== 'undefined') ? DISHATools.renderSystemPrompt({ agent: true }) : '';
        const lang = (typeof DISHA !== 'undefined' && DISHA.languageDirective) ? DISHA.languageDirective() : '';
        return [_baseRole(), AGENT_PROTOCOL, tools].filter(Boolean).join('\n\n') + lang;
    }

    /** The opening user turn: selected-cell context (if any) + the task. Pure. */
    function buildFirstUserMessage(question, ground) {
        let m = '';
        if (ground && ground.context) m += `[SELECTED CELL DATA]\n${ground.context}\n\n`;
        m += `[TASK]\n${question}`;
        return m;
    }

    /** Fresh run state. Pure. */
    function initState(question, ground) {
        return {
            question,
            system: buildSystemPrompt(),
            messages: [{ role: 'user', content: buildFirstUserMessage(question, ground) }],
            iter: 0,
            calls: 0,
            counters: { mutations: 0 },
        };
    }

    /** Render tool results into an [OBSERVATION] block the model reads next turn. Pure. */
    function buildObservation(results) {
        const lines = ['[OBSERVATION]'];
        for (const r of (results || [])) {
            if (r.ok) lines.push(r.observation ? r.observation : `${r.type} ok — ${r.label}`);
            else lines.push(`${r.type} failed — ${r.error}`);
        }
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

    /** Strip directives and the [DONE] marker from text shown to the user. Pure. */
    function cleanProse(turn) {
        const stripped = (typeof DISHAActions !== 'undefined') ? DISHAActions.stripActions(turn) : String(turn || '');
        return stripped.replace(/\[DONE\]/ig, '').replace(/\n{3,}/g, '\n\n').trim();
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
        const text = cleanProse(await DISHA.complete({ system: state.system, messages: msgs }));
        if (text) onAssistant(text, { final: true });
        return text;
    }

    /**
     * Run the agent loop.
     * @param {string} question
     * @param {{cell?,data?,context?,bounds?}} ground  selected-cell grounding
     * @param {{onAssistant?,onChips?}} hooks          UI callbacks (per iteration)
     * @returns {Promise<string>} the final answer text
     */
    async function run(question, ground, hooks = {}) {
        if (typeof DISHA === 'undefined' || !DISHA.complete) throw new Error('DISHA.complete unavailable');
        const onAssistant = hooks.onAssistant || (() => {});
        const onChips = hooks.onChips || (() => {});

        const state = initState(question, ground);

        while (state.iter < MAX_ITERS) {
            const turn = await DISHA.complete({ system: state.system, messages: state.messages });
            const acts = (typeof DISHAActions !== 'undefined') ? DISHAActions.parseActions(turn) : [];
            const prose = cleanProse(turn);

            // Final answer: model stopped calling tools (or hit the tool budget).
            if (isFinal(turn, acts) || state.calls >= AGENT_BUDGET) {
                if (prose) { onAssistant(prose, { final: true }); return prose; }
                // A final *signal* with no prose — e.g. a bare `[ACTION] finish`
                // or `[DONE]` after gathering observations. Don't stop empty:
                // synthesize the answer from what has been gathered so far.
                return await finalize(state, [{ role: 'assistant', content: turn }], onAssistant);
            }

            // Intermediate reasoning (the agent narrating this step).
            if (prose) onAssistant(prose, { final: false });

            const actionable = acts.filter(a => a.type !== 'finish');
            const cap = Math.min(ACTIONS_PER_STEP, AGENT_BUDGET - state.calls);
            const results = await DISHAActions.executeAgentActions(actionable, {
                max: cap,
                mapMutationCap: MAP_MUTATION_CAP,
                counters: state.counters,
            });
            state.calls += results.length;
            if (results.length) onChips(results);

            state.messages = nextMessages(state.messages, turn, buildObservation(results));
            state.iter++;

            // Budget/iteration exhausted → one forced synthesis turn with tools off.
            if (state.iter >= MAX_ITERS || state.calls >= AGENT_BUDGET) {
                return await finalize(state, [], onAssistant);
            }
        }

        return '';
    }

    return {
        run,
        // pure helpers (exported for tests)
        initState, buildSystemPrompt, buildFirstUserMessage,
        buildObservation, isFinal, nextMessages, cleanProse,
        MAX_ITERS, ACTIONS_PER_STEP, AGENT_BUDGET, MAP_MUTATION_CAP,
    };
})();

if (typeof window !== 'undefined') window.DISHAAgent = DISHAAgent;
