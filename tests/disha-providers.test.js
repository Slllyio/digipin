import { describe, it, expect } from 'vitest';

// DISHAProviders is exposed on globalThis by tests/setup.js.
const DP = globalThis.DISHAProviders;
const DEFAULTS = { preferred: 'auto', keys: {}, custom: { baseUrl: '', model: '' } };

// loadConfig() memoises _config and has no reset, so this must be the first
// getConfig() call in the file — it is (the suites below only hit
// normalizeConfig). A fresh module load per test file keeps _config null here.
describe('DISHAProviders.loadConfig() default-provider seeding', () => {
    it('seeds the provider from DIGIPIN_CONFIG.aiProvider when nothing is saved', () => {
        // No real key is committed anywhere; an operator injects one at deploy
        // time via window.DIGIPIN_CONFIG.aiProvider. Seeding must surface it.
        window.DIGIPIN_CONFIG = { aiProvider: { preferred: 'groq', keys: { groq: 'gsk_injected' } } };
        const cfg = DP.getConfig();
        expect(cfg.preferred).toBe('groq');
        expect(cfg.keys.groq).toBe('gsk_injected');
        // Normalised shape is preserved (custom block backfilled).
        expect(cfg.custom).toEqual({ baseUrl: '', model: '' });
        delete window.DIGIPIN_CONFIG;
    });
});

describe('DISHAProviders.normalizeConfig()', () => {
    it('returns defaults for corrupt or wrong-type payloads', () => {
        for (const bad of [null, undefined, 42, 'str', true, [], [1, 2]]) {
            expect(DP.normalizeConfig(bad), JSON.stringify(bad)).toEqual(DEFAULTS);
        }
    });

    it('fills in missing fields on a partial object', () => {
        expect(DP.normalizeConfig({})).toEqual(DEFAULTS);
        expect(DP.normalizeConfig({ preferred: 'ollama' }))
            .toEqual({ preferred: 'ollama', keys: {}, custom: { baseUrl: '', model: '' } });
    });

    it('preserves a well-formed config', () => {
        const cfg = { preferred: 'groq', keys: { groq: 'gsk_x' }, custom: { baseUrl: 'http://h', model: 'm' } };
        expect(DP.normalizeConfig(cfg)).toEqual(cfg);
    });

    it('rejects wrong-typed sub-fields (keys/custom/preferred)', () => {
        expect(DP.normalizeConfig({ preferred: 123 }).preferred).toBe('auto');
        expect(DP.normalizeConfig({ keys: [] }).keys).toEqual({});
        expect(DP.normalizeConfig({ keys: 'nope' }).keys).toEqual({});
        expect(DP.normalizeConfig({ custom: 'bad' }).custom).toEqual({ baseUrl: '', model: '' });
    });

    it('backfills a partial custom block', () => {
        expect(DP.normalizeConfig({ custom: { baseUrl: 'http://x' } }).custom)
            .toEqual({ baseUrl: 'http://x', model: '' });
    });

    it('always yields keys and custom that are safe to index', () => {
        // The bug this guards: provider resolution reads cfg.keys[x] and
        // cfg.custom.baseUrl; both must exist for any input.
        for (const bad of [42, '{}', [], { keys: 5 }, { custom: 9 }]) {
            const c = DP.normalizeConfig(bad);
            expect(typeof c.keys).toBe('object');
            expect(typeof c.custom.baseUrl).toBe('string');
        }
    });
});
