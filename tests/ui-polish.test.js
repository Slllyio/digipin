import { describe, it, expect } from 'vitest';

const U = globalThis.UIPolish;

describe('UIPolish.icon()', () => {
    it('renders a currentColor stroke SVG, hidden from assistive tech', () => {
        const svg = U.icon('search', 20);
        expect(svg).toMatch(/^<svg class="ui-icon" width="20" height="20"/);
        expect(svg).toContain('stroke="currentColor"');
        expect(svg).toContain('aria-hidden="true"');
    });
    it('returns empty markup for unknown icons', () => {
        expect(U.icon('nope')).toBe('');
    });
    it('has an icon for every mapped toolbar button', () => {
        for (const name of Object.values(U.TOOLBAR)) expect(U.PATHS[name], name).toBeTruthy();
    });
});

describe('UIPolish.hazeOpacity()', () => {
    it('is zero for flat and gently tilted maps', () => {
        expect(U.hazeOpacity(0)).toBe(0);
        expect(U.hazeOpacity(35)).toBe(0);
        expect(U.hazeOpacity(NaN)).toBe(0);
    });
    it('ramps monotonically and saturates at 1', () => {
        expect(U.hazeOpacity(50)).toBeGreaterThan(0);
        expect(U.hazeOpacity(60)).toBeGreaterThan(U.hazeOpacity(50));
        expect(U.hazeOpacity(70)).toBe(1);
        expect(U.hazeOpacity(85)).toBe(1);
    });
});

describe('UIPolish.applyIcons()', () => {
    it('swaps toolbar and top-bar glyphs for SVG while keeping labels', () => {
        document.body.innerHTML = `
            <div id="top-bar"><button id="search-btn">🔍</button><button id="share-btn">🔗</button><button id="theme-toggle-btn">☀️</button></div>
            <div id="toolbar"><button id="btn-pitch"><span class="tb-icon">📷</span><span class="tb-label">Pitch</span></button></div>
            <nav id="sidebar"><button id="sidebar-toggle">←</button><div class="sidebar-title">🧠 Urban Queries</div></nav>`;
        const n = U.applyIcons(document);
        expect(n).toBe(1);
        expect(document.querySelector('#btn-pitch .tb-icon svg')).not.toBeNull();
        expect(document.querySelector('#btn-pitch .tb-label').textContent).toBe('Pitch');
        expect(document.querySelector('#search-btn svg')).not.toBeNull();
        expect(document.querySelector('.sidebar-title').textContent.trim()).toBe('Urban Queries');
        expect(document.querySelector('.sidebar-title svg')).not.toBeNull();
    });
});
