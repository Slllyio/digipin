/**
 * Setup file for Vitest with jsdom.
 *
 * DigiPin and DataFetcher are IIFE modules assigned to globals.
 * We load them via vm.runInNewContext() to execute them in a jsdom-like context,
 * allowing them to attach to window/global as they normally would in the browser.
 *
 * Alternative: Read source, append `module.exports = ...`, and evaluate.
 * Current approach: Use vm to execute in jsdom window scope (cleaner for existing code).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);

// Load and execute digipin.js in jsdom context
const digipinCode = readFileSync(path.join(rootDir, 'js', 'digipin.js'), 'utf-8');
const digipinContext = { window: globalThis, global: globalThis };
vm.runInNewContext(digipinCode, digipinContext, { filename: 'digipin.js' });

// Load and execute data-fetcher.js in jsdom context
const dataFetcherCode = readFileSync(path.join(rootDir, 'js', 'data-fetcher.js'), 'utf-8');
const dataFetcherContext = { window: globalThis, global: globalThis, DataFetcher: digipinContext.DataFetcher };
vm.runInNewContext(dataFetcherCode, dataFetcherContext, { filename: 'data-fetcher.js' });

// Make modules globally available in tests
globalThis.DigiPin = digipinContext.DigiPin;
globalThis.DataFetcher = dataFetcherContext.DataFetcher;
