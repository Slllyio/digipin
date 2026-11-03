import { describe, it, expect } from 'vitest';

const CH = globalThis.CellHierarchy;
const D = globalThis.DigiPin;

describe('CellHierarchy.html', () => {
    const c6 = D.encodeLevel(22.7196, 75.8577, 6);

    it('shows the level, size and every ancestor as a selectable chip', () => {
        const div = document.createElement('div');
        div.innerHTML = CH.html(D.format(c6));
        expect(div.querySelector('.digipin-hier-size').textContent).toBe('Level 6 · ~978 m cell');
        const chips = [...div.querySelectorAll('[data-hier-code]')].map(b => b.dataset.hierCode);
        expect(chips).toEqual(D.ancestors(c6).slice(0, 5));
        expect(div.querySelector('.current').textContent).toBe('L6');
        expect(div.querySelector('[data-hier-finer]').textContent).toContain('L7');
    });

    it('no finer chip at level 10; empty for an invalid code', () => {
        const div = document.createElement('div');
        div.innerHTML = CH.html(D.encode(22.7, 75.8));
        expect(div.querySelector('[data-hier-finer]')).toBeNull();
        expect(CH.html('nope')).toBe('');
    });
});

describe('CellHierarchy.centreChild', () => {
    it('is a child of the cell', () => {
        const c = D.encodeLevel(22.7196, 75.8577, 5);
        const k = CH.centreChild(c);
        expect(k).toHaveLength(6);
        expect(D.parent(k)).toBe(c);
        expect(CH.centreChild(D.encode(22.7, 75.8))).toBeNull();
    });
});

