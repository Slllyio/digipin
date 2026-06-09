/**
 * DISHA Providers — Multi-provider AI abstraction
 *
 * Supports:
 *   - Ollama (local, NDJSON streaming)
 *   - Groq Cloud (OpenAI-compatible, SSE streaming, free tier)
 *   - Custom OpenAI-compatible endpoint (Together, Fireworks, LMStudio, etc.)
 *
 * Auto-detects the best available provider:
 *   1. Try Ollama (localhost) first — free, no API key
 *   2. Fall back to configured cloud provider
 *   3. Offline mode if nothing available
 */

const DISHAProviders = (() => {
    const STORAGE_KEY = 'disha_provider_config';

    const BUILTIN = {
        ollama: {
            id: 'ollama',
            name: 'Ollama (Local)',
            baseUrl: 'http://localhost:11434',
            model: 'qwen2.5:latest',
            type: 'ollama',
            requiresKey: false,
            maxContext: 8192
        },
        groq: {
            id: 'groq',
            name: 'Groq Cloud',
            baseUrl: 'https://api.groq.com/openai/v1',
            model: 'llama-3.3-70b-versatile',
            type: 'openai',
            requiresKey: true,
            maxContext: 131072
        },
        custom: {
            id: 'custom',
            name: 'Custom API',
            baseUrl: '',
            model: '',
            type: 'openai',
            requiresKey: true,
            maxContext: 128000
        }
    };

    let _activeProvider = null;
    let _config = null;

    // ===== CONFIG =====

    // Coerce any parsed payload into a well-shaped config. A corrupt or legacy
    // localStorage value (a number, array, or object missing keys/custom) must
    // not crash provider resolution, which reads .keys[...] and .custom.baseUrl.
    function normalizeConfig(parsed) {
        const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
        const p = isObj(parsed) ? parsed : {};
        const custom = isObj(p.custom) ? p.custom : {};
        return {
            preferred: typeof p.preferred === 'string' ? p.preferred : 'auto',
            keys: isObj(p.keys) ? p.keys : {},
            custom: { baseUrl: custom.baseUrl || '', model: custom.model || '' },
        };
    }

    function loadConfig() {
        if (_config) return _config;
        let parsed = null;
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) parsed = JSON.parse(saved);
        } catch { /* ignore parse errors */ }

        _config = normalizeConfig(parsed);
        return _config;
    }

    function saveConfig(config) {
        _config = config;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        } catch { /* storage full or blocked */ }
    }

    function getConfig() {
        return loadConfig();
    }

    // ===== HEALTH CHECKS =====

    async function checkOllama() {
        try {
            const resp = await fetch(`${BUILTIN.ollama.baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(3000)
            });
            if (!resp.ok) return { ok: false, reason: 'Ollama not responding' };
            const data = await resp.json();
            const models = (data.models || []).map(m => m.name);
            if (models.length === 0) return { ok: false, reason: 'No models. Run: ollama pull qwen2.5' };
            return { ok: true, models };
        } catch {
            return { ok: false, reason: 'Ollama not running. Start: ollama serve' };
        }
    }

    async function checkOpenAI(baseUrl, apiKey) {
        if (!baseUrl || !apiKey) return { ok: false, reason: 'Missing URL or API key' };
        try {
            const resp = await fetch(`${baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(5000)
            });
            if (!resp.ok) {
                return { ok: false, reason: `API returned ${resp.status}` };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: err.message || 'Connection failed' };
        }
    }

    // ===== PROVIDER DETECTION =====

    async function detectProvider() {
        const config = loadConfig();

        // Explicit choice — skip auto-detection
        if (config.preferred !== 'auto') {
            return await resolveExplicit(config);
        }

        // Auto: try Ollama first (free, local)
        const ollamaCheck = await checkOllama();
        if (ollamaCheck.ok) {
            _activeProvider = {
                ...BUILTIN.ollama,
                status: 'connected',
                detail: `Models: ${ollamaCheck.models.join(', ')}`
            };
            return _activeProvider;
        }

        // Auto: try Groq if key configured
        if (config.keys.groq) {
            _activeProvider = {
                ...BUILTIN.groq,
                status: 'connected',
                detail: 'Groq Cloud (auto-fallback)'
            };
            return _activeProvider;
        }

        // Auto: try Custom if configured
        if (config.keys.custom && config.custom.baseUrl) {
            _activeProvider = {
                ...BUILTIN.custom,
                baseUrl: config.custom.baseUrl,
                model: config.custom.model,
                status: 'connected',
                detail: 'Custom API (auto-fallback)'
            };
            return _activeProvider;
        }

        // Nothing available
        _activeProvider = null;
        return null;
    }

    async function resolveExplicit(config) {
        const id = config.preferred;

        if (id === 'ollama') {
            const check = await checkOllama();
            _activeProvider = {
                ...BUILTIN.ollama,
                status: check.ok ? 'connected' : 'error',
                detail: check.ok ? `Models: ${check.models.join(', ')}` : check.reason
            };
            return _activeProvider;
        }

        if (id === 'groq') {
            const key = config.keys.groq;
            if (!key) {
                _activeProvider = { ...BUILTIN.groq, status: 'error', detail: 'API key not set' };
                return _activeProvider;
            }
            _activeProvider = { ...BUILTIN.groq, status: 'connected', detail: 'Groq Cloud' };
            return _activeProvider;
        }

        if (id === 'custom') {
            const key = config.keys.custom;
            const url = config.custom.baseUrl;
            const model = config.custom.model;
            if (!key || !url || !model) {
                _activeProvider = { ...BUILTIN.custom, status: 'error', detail: 'Incomplete config' };
                return _activeProvider;
            }
            _activeProvider = {
                ...BUILTIN.custom,
                baseUrl: url,
                model: model,
                status: 'connected',
                detail: `Custom: ${model}`
            };
            return _activeProvider;
        }

        _activeProvider = null;
        return null;
    }

    // ===== API KEY =====

    function getApiKey() {
        const config = loadConfig();
        if (!_activeProvider) return null;
        return config.keys[_activeProvider.id] || null;
    }

    // ===== STREAMING: OLLAMA =====

    async function streamOllama(params) {
        const { system, prompt, onToken, onDone, signal } = params;  // onError handled by the stream() wrapper

        const resp = await fetch(`${_activeProvider.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: _activeProvider.model,
                system,
                prompt,
                stream: true,
                options: {
                    temperature: 0.3,
                    num_ctx: _activeProvider.maxContext,
                    top_p: 0.9,
                    repeat_penalty: 1.1
                }
            }),
            signal
        });

        if (!resp.ok) throw new Error(`Ollama returned ${resp.status}`);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullResponse = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.response) {
                        fullResponse += parsed.response;
                        onToken(parsed.response);
                    }
                    if (parsed.done) {
                        if (onDone) onDone(fullResponse);
                        return fullResponse;
                    }
                } catch { /* skip malformed */ }
            }
        }

        if (onDone) onDone(fullResponse);
        return fullResponse;
    }

    // ===== STREAMING: OPENAI-COMPATIBLE (SSE) =====

    async function streamOpenAI(params) {
        const { system, messages, onToken, onDone, signal } = params;  // onError handled by the stream() wrapper
        const apiKey = getApiKey();

        const resp = await fetch(`${_activeProvider.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: _activeProvider.model,
                messages: [
                    { role: 'system', content: system },
                    ...messages
                ],
                stream: true,
                temperature: 0.3,
                top_p: 0.9,
                max_tokens: 4096
            }),
            signal
        });

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`API ${resp.status}: ${body.substring(0, 200)}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullResponse = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;

                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') {
                    if (onDone) onDone(fullResponse);
                    return fullResponse;
                }

                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) {
                        fullResponse += content;
                        onToken(content);
                    }
                } catch { /* skip malformed SSE */ }
            }
        }

        if (onDone) onDone(fullResponse);
        return fullResponse;
    }

    // ===== UNIFIED STREAM =====

    async function stream(params) {
        if (!_activeProvider) throw new Error('No AI provider available');

        try {
            if (_activeProvider.type === 'ollama') {
                return await streamOllama(params);
            }
            return await streamOpenAI(params);
        } catch (err) {
            if (err.name === 'AbortError') return '';
            if (params.onError) params.onError(err);
            throw err;
        }
    }

    // ===== PUBLIC API =====

    function getActive() { return _activeProvider; }

    function isConnected() {
        return _activeProvider && _activeProvider.status === 'connected';
    }

    function getProviderType() {
        return _activeProvider?.type || null;
    }

    function getMaxContext() {
        return _activeProvider?.maxContext || 8192;
    }

    function getBuiltins() {
        return { ...BUILTIN };
    }

    return {
        loadConfig,
        saveConfig,
        getConfig,
        normalizeConfig,
        detectProvider,
        checkOllama,
        checkOpenAI,
        getActive,
        isConnected,
        getProviderType,
        getMaxContext,
        getApiKey,
        getBuiltins,
        stream
    };
})();
