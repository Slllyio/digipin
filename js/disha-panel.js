/**
 * DISHA Chat Panel — Urban Intelligence UI Controller
 * Manages the interactive chat interface with multi-provider support,
 * settings configuration, intent routing, city scanning, and streaming responses
 */

const DISHAPanel = (() => {
    let _currentCell = null;
    let _currentData = null;
    let _currentContext = '';
    let _isStreaming = false;
    let _isCityScanning = false;
    let _settingsOpen = false;

    // ===== INIT =====
    async function init() {
        const inputEl = document.getElementById('disha-input');

        const result = await DISHA.checkConnection();

        updateStatusBadge(result);

        inputEl.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });

        // `/layer` + `@score` pick-list while typing (js/disha-mentions.js).
        if (typeof DishaMentions !== 'undefined') DishaMentions.attachAutocomplete(inputEl);

        // Settings gear click
        const gearBtn = document.getElementById('disha-settings-btn');
        if (gearBtn) {
            gearBtn.addEventListener('click', toggleSettings);
        }

        // Prune expired cache entries on startup
        if (typeof DISHACache !== 'undefined') {
            DISHACache.prune();
        }
    }

    /** Render the connection status badge (LIVE/cloud/OFF) from a checkConnection result. */
    function updateStatusBadge(result) {
        const statusEl = document.getElementById('disha-status');
        statusEl.classList.remove('connected', 'offline', 'cloud');

        if (result.connected) {
            const isCloud = result.providerId && result.providerId !== 'ollama';
            statusEl.textContent = isCloud ? result.providerId.toUpperCase() : 'LIVE';
            statusEl.classList.add(isCloud ? 'cloud' : 'connected');
            statusEl.title = `${result.provider} — ${result.reason}`;
        } else {
            statusEl.textContent = 'OFF';
            statusEl.classList.add('offline');
            statusEl.title = result.reason;
        }
    }

    // ===== SETTINGS =====
    function toggleSettings() {
        _settingsOpen = !_settingsOpen;
        let settingsEl = document.getElementById('disha-settings');

        if (_settingsOpen) {
            if (!settingsEl) {
                settingsEl = buildSettingsUI();
                const body = document.querySelector('.disha-body');
                body.insertBefore(settingsEl, body.firstChild);
            }
            settingsEl.style.display = '';
            populateSettings();
        } else if (settingsEl) {
            settingsEl.style.display = 'none';
        }
    }

    // Build settings UI with safe DOM methods (no innerHTML)
    function buildSettingsUI() {
        const div = document.createElement('div');
        div.id = 'disha-settings';
        div.className = 'disha-settings';

        // Title
        const title = document.createElement('div');
        title.className = 'disha-settings-title';
        title.textContent = 'AI Provider Settings';
        div.appendChild(title);

        // Provider select row
        div.appendChild(buildSelectRow(
            'disha-provider-select', 'Provider',
            [
                { value: 'auto', label: 'Auto-detect' },
                { value: 'ollama', label: 'Ollama (Local)' },
                { value: 'groq', label: 'Groq Cloud (Free)' },
                { value: 'custom', label: 'Custom API' }
            ]
        ));

        // API Key row (hidden by default)
        const keyRow = buildInputRow('disha-api-key', 'API Key', 'Enter API key...', 'password');
        keyRow.id = 'disha-key-row';
        keyRow.className = 'disha-settings-row disha-key-row';
        keyRow.style.display = 'none';
        div.appendChild(keyRow);

        // Custom URL row (hidden by default)
        const urlRow = buildInputRow('disha-custom-url', 'Endpoint URL', 'https://api.example.com/v1', 'text');
        urlRow.id = 'disha-custom-url-row';
        urlRow.className = 'disha-settings-row disha-custom-row';
        urlRow.style.display = 'none';
        div.appendChild(urlRow);

        // Custom Model row (hidden by default)
        const modelRow = buildInputRow('disha-custom-model', 'Model', 'e.g. llama-3.3-70b', 'text');
        modelRow.id = 'disha-custom-model-row';
        modelRow.className = 'disha-settings-row disha-custom-row';
        modelRow.style.display = 'none';
        div.appendChild(modelRow);

        // Actions row
        const actions = document.createElement('div');
        actions.className = 'disha-settings-actions';

        const testBtn = document.createElement('button');
        testBtn.id = 'disha-test-btn';
        testBtn.className = 'disha-settings-btn-action';
        testBtn.textContent = 'Test';
        testBtn.addEventListener('click', testProvider);
        actions.appendChild(testBtn);

        const saveBtn = document.createElement('button');
        saveBtn.id = 'disha-save-btn';
        saveBtn.className = 'disha-settings-btn-action disha-save';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', saveSettings);
        actions.appendChild(saveBtn);

        const statusSpan = document.createElement('span');
        statusSpan.id = 'disha-settings-status';
        statusSpan.className = 'disha-settings-status';
        actions.appendChild(statusSpan);

        div.appendChild(actions);

        // Provider select change listener
        const selectEl = div.querySelector('#disha-provider-select');
        selectEl.addEventListener('change', () => updateSettingsVisibility(selectEl.value));

        return div;
    }

    /** Build a labelled <select> settings row from an array of {value,label} options. */
    function buildSelectRow(id, labelText, options) {
        const row = document.createElement('div');
        row.className = 'disha-settings-row';

        const label = document.createElement('label');
        label.setAttribute('for', id);
        label.textContent = labelText;
        row.appendChild(label);

        const select = document.createElement('select');
        select.id = id;
        options.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            select.appendChild(option);
        });
        row.appendChild(select);

        return row;
    }

    /** Build a labelled <input> settings row of the given type and placeholder. */
    function buildInputRow(id, labelText, placeholder, type) {
        const row = document.createElement('div');
        row.className = 'disha-settings-row';

        const label = document.createElement('label');
        label.setAttribute('for', id);
        label.textContent = labelText;
        row.appendChild(label);

        const input = document.createElement('input');
        input.type = type;
        input.id = id;
        input.placeholder = placeholder;
        input.autocomplete = 'off';
        row.appendChild(input);

        return row;
    }

    /** Fill the settings form fields from the saved provider config. */
    function populateSettings() {
        const config = DISHAProviders.getConfig();
        const selectEl = document.getElementById('disha-provider-select');
        const keyEl = document.getElementById('disha-api-key');
        const urlEl = document.getElementById('disha-custom-url');
        const modelEl = document.getElementById('disha-custom-model');

        selectEl.value = config.preferred || 'auto';

        const activeId = selectEl.value === 'groq' ? 'groq' : 'custom';
        keyEl.value = config.keys[activeId] || '';

        urlEl.value = config.custom?.baseUrl || '';
        modelEl.value = config.custom?.model || '';

        updateSettingsVisibility(selectEl.value);

        document.getElementById('disha-settings-status').textContent = '';
    }

    /** Show/hide the API key, URL, and model rows based on the selected provider. */
    function updateSettingsVisibility(provider) {
        const keyRow = document.getElementById('disha-key-row');
        const customUrlRow = document.getElementById('disha-custom-url-row');
        const customModelRow = document.getElementById('disha-custom-model-row');

        const needsKey = provider === 'groq' || provider === 'custom';
        const isCustom = provider === 'custom';

        keyRow.style.display = needsKey ? '' : 'none';
        customUrlRow.style.display = isCustom ? '' : 'none';
        customModelRow.style.display = isCustom ? '' : 'none';
    }

    /** Probe connectivity for the currently selected provider and report the result in the status line. */
    async function testProvider() {
        const statusEl = document.getElementById('disha-settings-status');
        statusEl.textContent = 'Testing...';
        statusEl.className = 'disha-settings-status';

        const selectEl = document.getElementById('disha-provider-select');
        const provider = selectEl.value;

        if (provider === 'auto' || provider === 'ollama') {
            const check = await DISHAProviders.checkOllama();
            statusEl.textContent = check.ok ? 'Ollama connected!' : check.reason;
            statusEl.classList.add(check.ok ? 'status-ok' : 'status-err');
            return;
        }

        const keyEl = document.getElementById('disha-api-key');
        const key = keyEl.value.trim();
        if (!key) {
            statusEl.textContent = 'Enter an API key first';
            statusEl.classList.add('status-err');
            return;
        }

        const baseUrl = provider === 'groq'
            ? 'https://api.groq.com/openai/v1'
            : document.getElementById('disha-custom-url').value.trim();

        if (!baseUrl) {
            statusEl.textContent = 'Enter an endpoint URL';
            statusEl.classList.add('status-err');
            return;
        }

        const check = await DISHAProviders.checkOpenAI(baseUrl, key);
        statusEl.textContent = check.ok ? 'Connected!' : check.reason;
        statusEl.classList.add(check.ok ? 'status-ok' : 'status-err');
    }

    /** Persist the settings form to provider config, re-detect the provider, and auto-close the panel. */
    async function saveSettings() {
        const selectEl = document.getElementById('disha-provider-select');
        const keyEl = document.getElementById('disha-api-key');
        const urlEl = document.getElementById('disha-custom-url');
        const modelEl = document.getElementById('disha-custom-model');
        const statusEl = document.getElementById('disha-settings-status');

        const provider = selectEl.value;
        const config = DISHAProviders.getConfig();

        config.preferred = provider;

        if (provider === 'groq') {
            config.keys.groq = keyEl.value.trim();
        } else if (provider === 'custom') {
            config.keys.custom = keyEl.value.trim();
            config.custom = {
                baseUrl: urlEl.value.trim().replace(/\/+$/, ''),
                model: modelEl.value.trim()
            };
        }

        DISHAProviders.saveConfig(config);

        // Re-detect provider with new config
        const result = await DISHA.checkConnection();
        updateStatusBadge(result);

        statusEl.textContent = 'Saved!';
        statusEl.className = 'disha-settings-status status-ok';

        setTimeout(() => {
            _settingsOpen = false;
            const settingsEl = document.getElementById('disha-settings');
            if (settingsEl) settingsEl.style.display = 'none';
        }, 1000);
    }

    // ===== OPEN =====
    function open(cell, data) {
        const panelEl = document.getElementById('disha-panel');
        const messagesEl = document.getElementById('disha-messages');
        const inputEl = document.getElementById('disha-input');
        const sendBtn = document.getElementById('disha-send');

        // Guard: opening without a cell is a UX path (e.g. user clicked
        // a DISHA-launcher button before clicking the map). Show a
        // friendly empty state instead of crashing on cell.code below.
        if (!cell || !cell.code) {
            panelEl.classList.add('open');
            if (typeof FloatingDialogs !== 'undefined' && FloatingDialogs.focusInto) FloatingDialogs.focusInto(panelEl);
            while (messagesEl.firstChild) messagesEl.removeChild(messagesEl.firstChild);
            inputEl.disabled = true;
            sendBtn.disabled = true;
            inputEl.placeholder = 'Click a DigiPin cell on the map first…';
            const hint = document.createElement('div');
            hint.className = 'disha-message disha-system';
            hint.textContent = 'Click any DIGIPIN cell to load India-native location intelligence — then ask in plain English. ' +
                'City-wide questions ("family-friendly area near good schools, low flood risk") rank DIGIPIN cells instantly. Free and auditable.';
            messagesEl.appendChild(hint);
            return;
        }

        _currentCell = cell;
        _currentData = data;
        _currentContext = DISHA.buildContext(cell, data);

        panelEl.classList.add('open');
        if (typeof FloatingDialogs !== 'undefined' && FloatingDialogs.focusInto) FloatingDialogs.focusInto(panelEl);
        while (messagesEl.firstChild) messagesEl.removeChild(messagesEl.firstChild);
        inputEl.disabled = false;
        sendBtn.disabled = false;

        DISHA.clearHistory();

        // Count data sources loaded
        const dataSources = [];
        if (_currentData.environment?.temperature != null) dataSources.push('Weather');
        if (_currentData.environment?.aqi != null) dataSources.push('AQI');
        if (_currentData.environment?.solar) dataSources.push('Solar');
        if (_currentData.buildingIntel) dataSources.push('Buildings');
        if (_currentData.context?.iudx) dataSources.push('IUDX');
        if (_currentData.context?.iudxCatalogue) dataSources.push('IUDX Catalogue');
        if (_currentData.context?.cepi) dataSources.push('CEPI');
        if (_currentData.context?.postOffices) dataSources.push('Post Offices');
        if (_currentData.context?.healthFacilities) dataSources.push('Health');
        if (_currentData.context?.wikipedia) dataSources.push('Wikipedia');
        if (_currentData.environment?.populationDensity) dataSources.push('Population');
        if (_currentData.environment?.elevation) dataSources.push('Elevation');

        const featureCount = _currentData.raw?.featureTypesFound || 0;
        const scoreCount = Object.values(_currentData.scores || {}).filter(s => s && s.value > 0).length;

        const provider = DISHAProviders.getActive();
        const providerLabel = provider ? provider.name : 'Offline';

        addMessage('disha', `Urban Intelligence loaded for DigiPin **${cell.code}**\n\n` +
            `${dataSources.length} data sources active: ${dataSources.join(', ')}\n` +
            `${featureCount} feature types | ${scoreCount} intelligence scores\n` +
            `AI: ${providerLabel}\n\n` +
            `Ask me anything — from "Is this safe to live?" to "Where should I open a restaurant?"\n` +
            `Ask a plain-English question and I'll rank DIGIPIN cells across the city for it — India-native, free, and auditable.`
        );

        const suggestions = DISHA.getSuggestions(data);
        renderSuggestions(suggestions);

        inputEl.focus();
    }

    /** Render the suggestion/follow-up chips (clears + rebuilds the row). */
    function renderSuggestions(list) {
        const el = document.getElementById('disha-suggestions');
        if (!el) return;
        while (el.firstChild) el.removeChild(el.firstChild);
        if (!Array.isArray(list) || list.length === 0) { el.style.display = 'none'; return; }
        el.style.display = '';
        list.forEach(s => {
            const btn = document.createElement('button');
            btn.className = 'disha-suggestion';
            btn.textContent = s;
            btn.addEventListener('click', () => askSuggestion(s));
            el.appendChild(btn);
        });
    }

    /** Close the chat panel, abort any in-flight request, and reset streaming/scanning flags. */
    function close() {
        const panelEl = document.getElementById('disha-panel');
        panelEl.classList.remove('open');
        if (typeof FloatingDialogs !== 'undefined' && FloatingDialogs.restoreFocus) FloatingDialogs.restoreFocus(panelEl);
        DISHA.cancel();
        _isStreaming = false;
        _isCityScanning = false;
    }

    // ===== SEND =====
    async function send() {
        const inputEl = document.getElementById('disha-input');
        const question = inputEl.value.trim();
        if (!question || _isStreaming || _isCityScanning) return;

        inputEl.value = '';
        addMessage('user', question);

        document.getElementById('disha-suggestions').style.display = 'none';

        // "find open data for flooding" is answered from the catalog, no model needed.
        if (typeof OpenDataFinder !== 'undefined' && OpenDataFinder.isQuery(question)) {
            await handleDataSearch(OpenDataFinder.isQuery(question).query);
            return;
        }

        // `/layer` turns layers on; `@score` pins scores into the ranking.
        const mentions = await _applyMentions(question);
        if (mentions.done) return;
        const pins = mentions.pins;
        const modelQuestion = mentions.question;

        if (!DISHA.isConnected()) {
            const summary = DISHA.offlineSummary(_currentCell, _currentData);
            addMessage('disha', summary);
            return;
        }

        // Agent mode: multi-step planning questions run the Urban Analyst Agent
        // (a tool-using ReAct loop) instead of the single-shot answer.
        if (typeof DISHAAgent !== 'undefined' && DISHA.isAgentQuestion(question) && _currentCell) {
            await handleAgent(DISHA.stripAgentPrefix(question));
            return;
        }

        // Smart context: filter by question type instead of sending everything
        _currentContext = DISHA.buildFilteredContext(_currentCell, _currentData, modelQuestion);

        // A pinned @score only means something to a ranking, so it implies one.
        const intent = pins.length ? 'city_scan' : DISHA.detectIntent(modelQuestion);

        if (intent === 'city_scan') {
            await handleCityScan(modelQuestion, pins, question);
        } else {
            await streamResponse(modelQuestion);
        }
    }

    /** Answer "find open data for X" with catalog cards (offline-safe). */
    async function handleDataSearch(query) {
        const msg = addMessage('disha', '');
        const content = msg.querySelector('.disha-msg-content');
        content.textContent = '';
        if (!query) {
            content.textContent = 'Tell me the theme, e.g. “find open data for flooding” or “datasets on population”.';
            return;
        }
        try {
            const catalog = await OpenDataFinder.load();
            const candidates = (typeof DishaMentions !== 'undefined') ? DishaMentions.layerCandidates() : [];
            OpenDataFinder.renderResults(content, OpenDataFinder.search(query, catalog), query, {
                candidates,
                showLayer: (c) => DishaMentions.showLayer(c),
            });
        } catch {
            content.textContent = 'The dataset catalog could not be loaded (offline?). Try again when you are connected.';
        }
        scrollToBottom();
    }

    /**
     * Resolve `/layer` and `@score` tokens in a question: turn the layers on,
     * report each token as a ✓/✗ chip, and return the question rewritten for
     * the model plus the pinned score ids. `done` = nothing left to answer.
     */
    async function _applyMentions(question) {
        const none = { question, pins: [], done: false };
        if (typeof DishaMentions === 'undefined') return none;
        const tok = DishaMentions.extract(question);
        if (!tok.layers.length && !tok.scores.length) return none;

        const L = DishaMentions.resolve(tok.layers, DishaMentions.layerCandidates());
        const S = DishaMentions.resolve(tok.scores, DishaMentions.scoreCandidates());
        const chips = [];
        for (const c of L.matched) {
            let ok = false;
            try { ok = await DishaMentions.showLayer(c); } catch { ok = false; }
            chips.push({ ok, label: `${c.name} on`, type: '/' + c.token, error: 'couldn’t turn it on here' });
        }
        S.matched.forEach(c => chips.push({ ok: true, label: `Pinned ${c.name}` }));
        const miss = (sigil) => (u) => chips.push({
            ok: false, type: sigil + u.token,
            error: u.suggestions.length ? `not found, try ${u.suggestions.join(', ')}` : 'not found',
        });
        L.unknown.forEach(miss('/'));
        S.unknown.forEach(miss('@'));

        const msg = addMessage('disha', '');
        const content = msg.querySelector('.disha-msg-content');
        content.textContent = '';
        _renderActionChips(content, chips);

        const rewritten = DishaMentions.rewrite(question, S.matched);
        return { question: rewritten, pins: S.matched.map(m => m.id), done: !rewritten && !S.matched.length };
    }

    // ===== PLAN BEFORE RUN =====
    const SKIP_PLANS_KEY = 'digipin_skip_plans';

    function _skipPlans() {
        try { return localStorage.getItem(SKIP_PLANS_KEY) === '1'; } catch { return false; }
    }

    function _providerName() {
        if (typeof DISHAProviders === 'undefined' || !DISHAProviders.isConnected()) return null;
        const a = DISHAProviders.getActive && DISHAProviders.getActive();
        return (a && a.name) || null;
    }

    function _gridReady() {
        return typeof PrecomputedScores !== 'undefined' && PrecomputedScores.isEnabled && PrecomputedScores.isEnabled();
    }

    /** A plan is worth showing for multi-score rankings, unless the user opted out. */
    function _shouldShowPlan(parsed) {
        return !!parsed && Object.keys(parsed.weights || {}).length >= 2 && !_skipPlans();
    }

    /**
     * Show the ranking's steps and wait for the user. Resolves to the (possibly
     * trimmed) parsed weighting on Run, or null on Edit / Cancel.
     */
    function _confirmPlan(parsed, originalQuestion) {
        return new Promise(resolve => {
            let current = { ...parsed, weights: { ...parsed.weights } };
            const messagesEl = document.getElementById('disha-messages');
            const card = document.createElement('div');
            card.className = 'disha-msg disha-msg-disha';
            const content = document.createElement('div');
            content.className = 'disha-msg-content disha-plan';
            card.appendChild(content);

            const header = document.createElement('div');
            header.className = 'disha-scan-header';
            header.textContent = 'Plan';
            const intro = document.createElement('div');
            intro.className = 'disha-plan-intro';
            intro.textContent = 'Here’s what I’ll do. Remove any score you don’t want, then run it.';
            const list = document.createElement('ol');
            list.className = 'disha-plan-steps';
            const actions = document.createElement('div');
            actions.className = 'disha-plan-actions';

            const btn = (label, cls) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'disha-plan-btn ' + cls;
                b.textContent = label;
                return b;
            };
            const run = btn('Run', 'primary');
            const edit = btn('Edit question', '');
            const cancel = btn('Cancel', '');
            const skipLbl = document.createElement('label');
            skipLbl.className = 'disha-plan-skip';
            const skip = document.createElement('input');
            skip.type = 'checkbox';
            skipLbl.appendChild(skip);
            skipLbl.appendChild(document.createTextNode(' Run without asking next time'));

            const render = () => {
                list.textContent = '';
                const steps = Text2Map.plan(current, { gridReady: _gridReady(), provider: _providerName() });
                steps.forEach((st, i) => {
                    const li = document.createElement('li');
                    const t = document.createElement('div');
                    t.className = 'disha-plan-title';
                    t.textContent = st.title;
                    li.appendChild(t);
                    if (i === 0) {
                        // Weights as removable chips instead of a line of text.
                        const chips = document.createElement('div');
                        chips.className = 'disha-plan-weights';
                        Object.entries(current.weights).forEach(([id, w]) => {
                            const chip = document.createElement('span');
                            chip.className = 'disha-plan-weight' + (w < 0 ? ' neg' : '');
                            const pin = (current.pinned || []).includes(id) ? ' (pinned)' : '';
                            chip.textContent = `${Text2Map.scoreLabel(id)} ${w > 0 ? '+' : '−'}${Math.abs(w).toFixed(1)}${pin}`;
                            const x = document.createElement('button');
                            x.type = 'button';
                            x.textContent = '×';
                            x.setAttribute('aria-label', 'Remove ' + Text2Map.scoreLabel(id));
                            x.addEventListener('click', () => {
                                delete current.weights[id];
                                render();
                            });
                            chip.appendChild(x);
                            chips.appendChild(chip);
                        });
                        li.appendChild(chips);
                    } else {
                        const d = document.createElement('div');
                        d.className = 'disha-plan-detail';
                        d.textContent = st.detail;
                        li.appendChild(d);
                    }
                    const src = document.createElement('div');
                    src.className = 'disha-plan-source';
                    src.textContent = st.source;
                    li.appendChild(src);
                    list.appendChild(li);
                });
                run.disabled = Object.keys(current.weights).length === 0;
            };

            const finish = (value) => {
                [run, edit, cancel, skip].forEach(el => { el.disabled = true; });
                card.classList.add('disha-plan-done');
                resolve(value);
            };
            run.addEventListener('click', () => {
                if (skip.checked) {
                    try { localStorage.setItem(SKIP_PLANS_KEY, '1'); } catch { /* storage blocked */ }
                }
                const ids = Object.keys(current.weights);
                if (current.primaryScore && current.weights[current.primaryScore] == null) {
                    current.primaryScore = ids.reduce((a, b) => (Math.abs(current.weights[b]) > Math.abs(current.weights[a]) ? b : a));
                }
                finish(current);
            });
            edit.addEventListener('click', () => {
                const inputEl = document.getElementById('disha-input');
                finish(null);
                if (inputEl) { inputEl.disabled = false; inputEl.value = originalQuestion; inputEl.focus(); }
            });
            cancel.addEventListener('click', () => finish(null));

            actions.appendChild(run);
            actions.appendChild(edit);
            actions.appendChild(cancel);
            content.appendChild(header);
            content.appendChild(intro);
            content.appendChild(list);
            content.appendChild(actions);
            content.appendChild(skipLbl);
            render();
            messagesEl.appendChild(card);
            scrollToBottom();
            run.focus();
        });
    }

    /** Populate the input with a suggestion chip's text and submit it. */
    function askSuggestion(question) {
        document.getElementById('disha-input').value = question;
        send();
    }

    // ===== CITY SCAN FLOW =====
    // Current map viewport as a plain {south,west,north,east} for Text2Map's
    // precomputed-grid lookup. Empty object if the map isn't ready (Text2Map
    // then degrades to the live sampler).
    function _cityScanBounds() {
        if (typeof MapModule === 'undefined' || !MapModule.getMap) return {};
        const map = MapModule.getMap();
        if (!map || !map.getBounds) return {};
        const b = map.getBounds();
        return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    }

    /** Run the city-wide scan flow: rank DIGIPIN cells for the question, render results, then stream an AI summary. */
    async function handleCityScan(question, pins = [], originalQuestion = question) {
        _isCityScanning = true;
        // Drop any previous answer's highlight before this scan starts.
        if (typeof Text2MapResultsLayer !== 'undefined') {
            try { Text2MapResultsLayer.clear(); } catch { /* nothing to clear */ }
        }
        const sendBtn = document.getElementById('disha-send');
        const inputEl = document.getElementById('disha-input');
        sendBtn.style.display = 'none';
        inputEl.disabled = true;

        const statusMsg = addMessage('disha', '');
        const statusContent = statusMsg.querySelector('.disha-msg-content');

        const scanIndicator = document.createElement('div');
        scanIndicator.className = 'disha-scan-status';
        const spinner = document.createElement('span');
        spinner.className = 'disha-scan-spinner';
        spinner.textContent = '\u25CE';
        const scanText = document.createElement('span');
        scanText.textContent = 'Initiating city scan...';
        scanIndicator.appendChild(spinner);
        scanIndicator.appendChild(scanText);
        statusContent.appendChild(scanIndicator);

        try {
            // Text2Map: parse the question into a weighting (LLM-required, with a
            // keyword fallback) and rank the precomputed DIGIPIN grid instantly.
            // Falls back internally to the live sampler when the viewport isn't
            // covered. Older path (DISHA.cityScan) kept if Text2Map is absent.
            let results, label = null, out = null;
            if (typeof Text2Map !== 'undefined') {
                scanText.textContent = 'Understanding your question...';
                const bounds = _cityScanBounds();
                let parsed = await Text2Map.parse(question);
                if (pins.length && typeof DishaMentions !== 'undefined') {
                    parsed = DishaMentions.applyPins(
                        parsed || { weights: {}, primaryScore: pins[0], label: 'Pinned scores', source: 'keyword' }, pins);
                }
                // Plan before run: show the steps + weights and wait for a go-ahead.
                if (_shouldShowPlan(parsed)) {
                    scanText.textContent = 'Waiting for you to confirm the plan...';
                    parsed = await _confirmPlan(parsed, originalQuestion);
                    if (!parsed) {
                        statusMsg.remove();
                        resetInputState();
                        _isCityScanning = false;
                        return;
                    }
                    scanText.textContent = 'Ranking...';
                }
                out = parsed ? await Text2Map.rank(parsed, question, bounds, (status) => {
                    scanText.textContent = status;
                }) : null;
                results = out ? out.results : null;
                label = out?.parsed?.label || null;
                if (out && out.mode === 'precomputed') {
                    scanText.textContent = 'Ranking the live grid...';
                }
            } else {
                results = await DISHA.cityScan(question, (status) => {
                    scanText.textContent = status;
                });
            }

            if (!results || results.length === 0) {
                applyFormattedResponse(statusContent, 'City scan returned no results. Try zooming into a city area first.');
                resetInputState();
                _isCityScanning = false;
                return;
            }

            scanText.textContent = `Found top ${results.length}${label ? ' for "' + label + '"' : ''}. Analyzing with AI...`;

            const cityScanContext = DISHA.buildCityScanContext(results, question);

            statusMsg.remove();
            _isCityScanning = false;

            addScanResultsCard(results, question, out);

            // Close the "ask → map" loop: paint the ranked cells on the map and
            // frame them, so the answer is a map, not just a list.
            if (typeof Text2MapResultsLayer !== 'undefined') {
                try { Text2MapResultsLayer.show(results); } catch { /* map-highlight is best-effort */ }
            }

            await streamResponse(question, cityScanContext);
        } catch (err) {
            applyFormattedResponse(statusContent, `Scan error: ${err.message}`);
            resetInputState();
            _isCityScanning = false;
        }
    }

    /** Append a chat card listing ranked scan results with score bars, fly-to clicks, and GeoJSON export. */
    function addScanResultsCard(results, question, out) {
        const messagesEl = document.getElementById('disha-messages');
        const card = document.createElement('div');
        card.className = 'disha-msg disha-msg-disha';

        const content = document.createElement('div');
        content.className = 'disha-msg-content';

        const header = document.createElement('div');
        header.className = 'disha-scan-header';
        header.textContent = 'City Scan Results';
        content.appendChild(header);

        results.forEach((r, i) => {
            const row = document.createElement('div');
            row.className = 'disha-scan-row';
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => {
                if (typeof MapModule !== 'undefined') {
                    MapModule.flyTo(r.lat, r.lng, 17);
                }
            });

            const rank = document.createElement('span');
            rank.className = 'disha-scan-rank';
            rank.textContent = `#${i + 1}`;

            const info = document.createElement('span');
            info.className = 'disha-scan-info';

            const name = document.createElement('div');
            name.className = 'disha-scan-name';
            name.textContent = `${r.code} ${r.area ? '(' + r.area + ')' : ''}`;

            const score = document.createElement('div');
            score.className = 'disha-scan-score';

            const bar = document.createElement('div');
            bar.className = 'disha-scan-bar';
            const fill = document.createElement('div');
            fill.className = 'disha-scan-bar-fill';
            fill.style.width = Math.min(100, r.score) + '%';
            fill.style.background = r.score > 70 ? 'var(--accent-green, #00ff88)' :
                                    r.score > 40 ? 'var(--accent-cyan, #00f5ff)' :
                                    'var(--accent-orange, #ff9500)';
            bar.appendChild(fill);

            const scoreText = document.createElement('span');
            scoreText.textContent = r.score.toFixed(1);
            score.appendChild(bar);
            score.appendChild(scoreText);

            info.appendChild(name);
            info.appendChild(score);

            row.appendChild(rank);
            row.appendChild(info);
            content.appendChild(row);
        });

        const hint = document.createElement('div');
        hint.className = 'disha-scan-hint';
        hint.textContent = 'Click a result to fly to that location on the map';
        content.appendChild(hint);

        // Where these numbers came from (source card, js/provenance.js).
        if (out && out.parsed && typeof Provenance !== 'undefined') {
            const meta = Provenance.forRanking(out.parsed, out.mode, { provider: _providerName() });
            const el = Provenance.renderCard(meta);
            if (el) content.appendChild(el);
        }

        // Export the ranked cells as GeoJSON (QGIS / geojson.io / gov workflows).
        if (typeof DataFetcher !== 'undefined' && DataFetcher.exportRankedToGeoJSON) {
            const geo = document.createElement('button');
            geo.className = 'disha-scan-export';
            geo.textContent = 'Download GeoJSON';
            geo.title = 'Export these ranked DIGIPIN cells as GeoJSON';
            geo.addEventListener('click', () => DataFetcher.exportRankedToGeoJSON(results, 'digipin_ranked.geojson'));
            content.appendChild(geo);
        }

        // Keep this answer as its own layer (source scores are never changed).
        if (typeof CellIngest !== 'undefined' && typeof CellLayers !== 'undefined') {
            const keep = document.createElement('button');
            keep.className = 'disha-scan-export';
            keep.textContent = 'Save as layer';
            keep.title = 'Add these ranked cells to the Layers panel as a layer you can restyle, extrude or share';
            keep.addEventListener('click', async () => {
                keep.disabled = true;
                try {
                    const spec = CellIngest.saveRanking(results, question);
                    await CellLayers.show(spec.id, { field: 'score', extrude: true });
                    keep.textContent = `Saved as “${spec.title}”`;
                } catch (e) {
                    keep.textContent = e && e.message ? e.message : 'Could not save';
                    keep.disabled = false;
                }
            });
            content.appendChild(keep);
        }

        card.appendChild(content);
        messagesEl.appendChild(card);
        scrollToBottom();
    }

    /** Append ✓/✗ chips confirming the map actions DISHA triggered. */
    function _renderActionChips(parent, results) {
        if (!results || !results.length) return;
        const wrap = document.createElement('div');
        wrap.className = 'disha-action-chips';
        results.forEach(r => {
            const chip = document.createElement('span');
            chip.className = 'disha-action-chip ' + (r.ok ? 'ok' : 'fail');
            chip.textContent = (r.ok ? '✓ ' : '✗ ') + (r.ok ? r.label : `${r.type}: ${r.error}`);
            wrap.appendChild(chip);
        });
        parent.appendChild(wrap);
    }

    // ===== STREAM RESPONSE =====
    async function streamResponse(question, cityScanContext) {
        _isStreaming = true;
        const sendBtn = document.getElementById('disha-send');
        const stopBtn = document.getElementById('disha-stop');
        const inputEl = document.getElementById('disha-input');

        sendBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        inputEl.disabled = true;

        const messageEl = addMessage('disha', '');
        const contentEl = messageEl.querySelector('.disha-msg-content');
        contentEl.classList.add('disha-streaming');   // shows a blinking caret
        contentEl.textContent = '…';                  // "thinking" until first token
        let fullResponse = '';
        let lastFmt = 0;

        await DISHA.ask(
            _currentContext,
            question,
            (token) => {
                fullResponse += token;
                // Format live, but throttle (~8 fps) so we don't re-parse the
                // whole reply on every token (O(n²)); onDone does the final pass.
                const now = Date.now();
                if (now - lastFmt > 120) {
                    lastFmt = now;
                    applyFormattedResponse(contentEl, fullResponse);
                    contentEl.classList.add('disha-streaming');
                }
                scrollToBottom();
            },
            (meta) => {
                _isStreaming = false;
                contentEl.classList.remove('disha-streaming');
                // Strip any [ACTION] directives from the text shown to the user,
                // then execute them and confirm with chips.
                const hasActions = typeof DISHAActions !== 'undefined';
                const shown = hasActions ? DISHAActions.stripActions(fullResponse) : fullResponse;
                applyFormattedResponse(contentEl, shown);
                // Show cached indicator if response was from cache
                if (meta && meta.cached) {
                    const badge = document.createElement('span');
                    badge.className = 'disha-cached-badge';
                    badge.textContent = 'cached';
                    badge.title = 'This response was served from cache';
                    contentEl.appendChild(badge);
                }
                if (hasActions) {
                    const acts = DISHAActions.parseActions(fullResponse);
                    if (acts.length) _renderActionChips(contentEl, DISHAActions.executeActions(acts));
                }
                // Conversation-aware follow-up chips derived from this reply.
                if (fullResponse.trim()) {
                    renderSuggestions(DISHA.getSuggestions(_currentData || {}, shown));
                }
                resetInputState();
            },
            (err) => {
                _isStreaming = false;
                contentEl.classList.remove('disha-streaming');
                contentEl.textContent = `Error: ${err.message}`;
                contentEl.classList.add('disha-error');
                resetInputState();
            },
            cityScanContext || null
        );
    }

    // ===== AGENT FLOW =====
    /** Run the multi-step Urban Analyst Agent, rendering its per-step reasoning and action chips live. */
    async function handleAgent(question) {
        _isStreaming = true;
        const sendBtn = document.getElementById('disha-send');
        const stopBtn = document.getElementById('disha-stop');
        const inputEl = document.getElementById('disha-input');
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        inputEl.disabled = true;

        // A "thinking" bubble until the first reasoning/step renders.
        const thinkingEl = addMessage('disha', '');
        let thinkingCleared = false;
        const clearThinking = () => { if (!thinkingCleared) { thinkingCleared = true; thinkingEl.remove(); } };

        const ground = {
            cell: _currentCell,
            data: _currentData,
            context: _currentCell ? DISHA.buildFilteredContext(_currentCell, _currentData, question) : '',
            bounds: _cityScanBounds(),
        };

        const hooks = {
            onAssistant: (text, meta) => {
                clearThinking();
                const el = addMessage('disha', '');
                const content = el.querySelector('.disha-msg-content');
                applyFormattedResponse(content, text);   // clears then renders
                if (!meta.final) content.classList.add('disha-agent-step');
                scrollToBottom();
            },
            onChips: (results) => {
                if (!results || !results.length) return;
                clearThinking();
                const el = addMessage('disha', '');
                const content = el.querySelector('.disha-msg-content');
                while (content.firstChild) content.removeChild(content.firstChild);
                _renderActionChips(content, results);
                scrollToBottom();
            },
        };

        try {
            const finalText = await DISHAAgent.run(question, ground, hooks);
            clearThinking();
            if (!finalText || !finalText.trim()) {
                addMessage('disha', 'No answer produced. Try rephrasing, or check the AI provider in Settings.');
            } else {
                renderSuggestions(DISHA.getSuggestions(_currentData || {}, finalText));
            }
        } catch (err) {
            clearThinking();
            // Stop button → DISHA.cancel() → AbortError. Treat as cancellation:
            // leave whatever already rendered, show no error.
            if (!(err && err.name === 'AbortError')) {
                const el = addMessage('disha', '');
                const content = el.querySelector('.disha-msg-content');
                content.textContent = `Agent error: ${err.message}`;
                content.classList.add('disha-error');
            }
        } finally {
            if (typeof DISHAActions !== 'undefined' && DISHAActions._resetAgentState) DISHAActions._resetAgentState();
            _isStreaming = false;
            resetInputState();
        }
    }

    /** Restore the input row to its idle state after a response or scan finishes. */
    function resetInputState() {
        const sendBtn = document.getElementById('disha-send');
        const stopBtn = document.getElementById('disha-stop');
        const inputEl = document.getElementById('disha-input');

        sendBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'none';
        inputEl.disabled = false;
        inputEl.focus();
    }

    // ===== MESSAGE RENDERING =====
    function addMessage(role, text) {
        const messagesEl = document.getElementById('disha-messages');
        const div = document.createElement('div');
        div.className = `disha-msg disha-msg-${role}`;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'disha-msg-content';

        if (role === 'user') {
            contentDiv.textContent = text;
        } else {
            applyFormattedResponse(contentDiv, text);
        }

        div.appendChild(contentDiv);
        messagesEl.appendChild(div);
        scrollToBottom();
        return div;
    }

    /** Scroll the messages container to the latest message. */
    function scrollToBottom() {
        const el = document.getElementById('disha-messages');
        el.scrollTop = el.scrollHeight;
    }

    /**
     * Format LLM response into styled DOM elements.
     * Handles: **bold**, bullets, score citations, verdicts, tables
     */
    function applyFormattedResponse(el, text) {
        while (el.firstChild) el.removeChild(el.firstChild);

        if (!text) {
            const thinking = document.createElement('span');
            thinking.className = 'disha-thinking';
            thinking.textContent = 'Thinking...';
            el.appendChild(thinking);
            return;
        }

        const lines = text.split('\n');

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) {
                el.appendChild(document.createElement('br'));
                return;
            }

            // Verdict line
            const verdictMatch = trimmed.match(/^\*?\*?Verdict:?\*?\*?\s*(.+)/i);
            if (verdictMatch) {
                const verdict = verdictMatch[1].trim().replace(/\*+/g, '');
                const span = document.createElement('span');
                span.className = 'disha-verdict ' + getVerdictClass(verdict);
                span.textContent = verdict;
                el.appendChild(span);
                el.appendChild(document.createElement('br'));
                return;
            }

            const scorePattern = /(\w+)=(\d+)(?:\/100)?/g;

            // Bullet lines
            if (trimmed.startsWith('-') || trimmed.startsWith('*') || trimmed.startsWith('\u2022')) {
                const bullet = document.createElement('div');
                bullet.className = 'disha-bullet';

                const icon = document.createElement('span');
                icon.className = 'disha-bullet-icon';
                icon.textContent = '\u25B8';
                bullet.appendChild(icon);

                const content = document.createElement('span');
                const bulletText = trimmed.replace(/^[-*\u2022]\s*/, '');
                appendRichText(content, bulletText, scorePattern);
                bullet.appendChild(content);

                el.appendChild(bullet);
                return;
            }

            // Numbered list
            const numMatch = trimmed.match(/^(?:(\d+)\.|#(\d+))\s+(.+)/);
            if (numMatch) {
                const bullet = document.createElement('div');
                bullet.className = 'disha-bullet disha-numbered';

                const icon = document.createElement('span');
                icon.className = 'disha-bullet-icon disha-num-icon';
                icon.textContent = (numMatch[1] || numMatch[2]);
                bullet.appendChild(icon);

                const content = document.createElement('span');
                appendRichText(content, numMatch[3], scorePattern);
                bullet.appendChild(content);

                el.appendChild(bullet);
                return;
            }

            // Table row
            if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
                const cells = trimmed.split('|').filter(c => c.trim());
                if (cells.every(c => /^[\s-:]+$/.test(c))) return;

                const row = document.createElement('div');
                row.className = 'disha-table-row';
                cells.forEach(cellText => {
                    const cell = document.createElement('span');
                    cell.className = 'disha-table-cell';
                    appendRichText(cell, cellText.trim(), scorePattern);
                    row.appendChild(cell);
                });
                el.appendChild(row);
                return;
            }

            // Regular line
            const p = document.createElement('div');
            p.style.marginTop = '3px';
            appendRichText(p, trimmed, scorePattern);
            el.appendChild(p);
        });
    }

    /** Append inline-formatted text (bold, score badges, clickable DigiPin codes) to a parent element. */
    function appendRichText(parent, text, _scorePattern) {
        const parts = text.split(/(\*\*[^*]+\*\*)/g);
        parts.forEach(part => {
            if (part.startsWith('**') && part.endsWith('**')) {
                const strong = document.createElement('strong');
                strong.textContent = part.slice(2, -2);
                parent.appendChild(strong);
            } else if (part) {
                const scoreParts = part.split(/(\w+=\d+(?:\/100)?)/g);
                scoreParts.forEach(sp => {
                    const scoreMatch = sp.match(/^(\w+)=(\d+)(\/100)?$/);
                    if (scoreMatch) {
                        const badge = document.createElement('span');
                        const val = parseInt(scoreMatch[2]);
                        badge.className = 'disha-score-badge ' +
                            (val >= 70 ? 'badge-good' : val >= 40 ? 'badge-moderate' : 'badge-poor');
                        badge.textContent = sp;
                        badge.title = `${scoreMatch[1]}: ${val}/100`;
                        parent.appendChild(badge);
                    } else if (sp) {
                        const dpParts = sp.split(/([23456789CFJKLMPT]{10})/g);
                        dpParts.forEach(dp => {
                            const validChars = new Set('23456789CFJKLMPT'.split(''));
                            if (dp.length === 10 && [...dp].every(c => validChars.has(c))) {
                                const link = document.createElement('span');
                                link.className = 'disha-digipin-link';
                                link.textContent = dp;
                                link.title = 'Click to navigate';
                                link.style.cursor = 'pointer';
                                link.addEventListener('click', () => {
                                    try {
                                        const decoded = DigiPin.decode(dp);
                                        MapModule.flyTo(decoded.lat, decoded.lng, 17);
                                    } catch { /* ignore invalid */ }
                                });
                                parent.appendChild(link);
                            } else if (dp) {
                                parent.appendChild(document.createTextNode(dp));
                            }
                        });
                    }
                });
            }
        });
    }

    /** Map a verdict string to its CSS class (good/moderate/poor). */
    function getVerdictClass(verdict) {
        const v = verdict.toLowerCase();
        if (v.includes('excellent') || v.includes('good') || v.includes('outstanding')) return 'disha-verdict-good';
        if (v.includes('moderate') || v.includes('acceptable') || v.includes('average')) return 'disha-verdict-moderate';
        return 'disha-verdict-poor';
    }

    return { init, open, close, send, askSuggestion };
})();
