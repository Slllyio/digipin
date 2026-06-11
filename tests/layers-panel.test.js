import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// LayersPanel is exposed on globalThis by tests/setup.js.
const LP = globalThis.LayersPanel;

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexHtml = readFileSync(path.join(rootDir, 'index.html'), 'utf-8');

afterEach(() => { document.body.innerHTML = ''; });

describe('LayersPanel registry contract', () => {
    it('every registered button id exists in index.html', () => {
        // The panel drives hidden toolbar buttons — if one is renamed or
        // removed from the markup, the row silently dies. Pin the contract.
        for (const a of LP.ANALYTICS) {
            expect(indexHtml, `missing #${a.btnId} in index.html`)
                .toContain(`id="${a.btnId}"`);
        }
    });

    it('entries() emits panel-renderable rows with unique keys', () => {
        const es = LP.entries();
        expect(es.length).toBe(LP.ANALYTICS.length);
        const keys = new Set(es.map(e => e.key));
        expect(keys.size).toBe(es.length);
        for (const e of es) {
            expect(e.group).toBe(LP.GROUP);
            expect(e.name).toBeTruthy();
            expect(e.icon).toBeTruthy();
            expect(e._btnId.startsWith('btn-')).toBe(true);
        }
    });

    it('marks the multi-state cycles (roads, buildings) as stateful', () => {
        const stateful = LP.entries().filter(e => e._stateful).map(e => e._btnId).sort();
        expect(stateful).toEqual(['btn-buildings', 'btn-roads']);
    });
});

describe('LayersPanel.filterMatch()', () => {
    it('empty query matches everything', () => {
        expect(LP.filterMatch('NDVI Vegetation', '')).toBe(true);
        expect(LP.filterMatch('NDVI Vegetation', '   ')).toBe(true);
    });
    it('is case-insensitive substring match', () => {
        expect(LP.filterMatch('Urban Heat Island', 'heat')).toBe(true);
        expect(LP.filterMatch('Urban Heat Island', 'HEAT')).toBe(true);
        expect(LP.filterMatch('Urban Heat Island', 'flood')).toBe(false);
    });
    it('AND-matches every whitespace token', () => {
        expect(LP.filterMatch('Score Grid (instant)', 'score grid')).toBe(true);
        expect(LP.filterMatch('Score Grid (instant)', 'score map')).toBe(false);
    });
    it('tolerates null/undefined name', () => {
        expect(LP.filterMatch(null, 'x')).toBe(false);
        expect(LP.filterMatch(undefined, '')).toBe(true);
    });
});

describe('LayersPanel.drive()/isActive()/stateLabel()', () => {
    function fakeButton(id) {
        const btn = document.createElement('button');
        btn.id = id;
        const lbl = document.createElement('span');
        lbl.className = 'tb-label';
        lbl.textContent = 'Roads';
        btn.appendChild(lbl);
        // Mimic the app's toggle handlers: click flips .active.
        btn.addEventListener('click', () => btn.classList.toggle('active'));
        document.body.appendChild(btn);
        return btn;
    }

    it('drives the hidden button and reports the resulting state', () => {
        fakeButton('btn-roads');
        expect(LP.isActive('btn-roads')).toBe(false);
        expect(LP.drive('btn-roads')).toBe(true);   // handler flipped it on
        expect(LP.isActive('btn-roads')).toBe(true);
        expect(LP.drive('btn-roads')).toBe(false);  // …and off again
    });

    it('reads the current mode label', () => {
        fakeButton('btn-roads');
        expect(LP.stateLabel('btn-roads')).toBe('Roads');
    });

    it('is a no-op for a missing button', () => {
        expect(LP.drive('btn-not-real')).toBe(false);
        expect(LP.isActive('btn-not-real')).toBe(false);
        expect(LP.stateLabel('btn-not-real')).toBeNull();
    });

    it('drives with a NON-bubbling click — the document never sees it', () => {
        // Regression: a bubbled synthetic click reaches the dropdown's
        // document-level outside-click handler and closes the Layers panel
        // mid-toggle (caught by e2e-smoke in CI).
        fakeButton('btn-roads');
        let reachedDocument = false;
        const spy = () => { reachedDocument = true; };
        document.addEventListener('click', spy);
        try {
            expect(LP.drive('btn-roads')).toBe(true); // handler still fires
            expect(reachedDocument).toBe(false);      // …but never bubbles up
        } finally {
            document.removeEventListener('click', spy);
        }
    });
});
