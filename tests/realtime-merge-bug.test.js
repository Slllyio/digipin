/**
 * Regression test for the result.realtime overwrite bug.
 *
 * Before the fix, js/data-fetcher.js had:
 *
 *   result.realtime.growth = ...
 *   result.realtime.heat   = ...
 *   result.realtime = {}                 // <- BUG: erases growth+heat
 *   result.realtime.sachet = ...
 *
 * The pattern this test enforces is the "merge, don't replace" pattern:
 * any code that mutates `result.realtime.*` must use
 * `result.realtime = result.realtime || {}` so prior writers' keys survive.
 *
 * We don't load all of data-fetcher.js (1830 lines + window globals it
 * expects) — we just grep the source for any unconditional reset of
 * `result.realtime = {}`. The grep approach catches this bug class
 * statically; a behavioural test would require mocking 16 fetch sources.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

describe('result.realtime never gets unconditionally reset', () => {
    it('data-fetcher.js does not reassign result.realtime to a fresh {}', () => {
        const src = readFileSync(path.join(process.cwd(), 'js/data-fetcher.js'), 'utf-8');
        // Match lines that assign a literal empty object — even after whitespace.
        // We allow `result.realtime = result.realtime || {}` (the safe pattern).
        const lines = src.split('\n');
        const offenders = [];
        lines.forEach((line, i) => {
            // strip line comments before matching
            const code = line.replace(/\/\/.*/, '');
            if (/result\.realtime\s*=\s*\{\s*\}\s*;?\s*$/.test(code)) {
                offenders.push(`line ${i + 1}: ${line.trim()}`);
            }
        });
        expect(offenders, `unconditional reset of result.realtime would erase growth/heat scores:\n${offenders.join('\n')}`).toEqual([]);
    });
});
