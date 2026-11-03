import { describe, it, expect } from 'vitest';

const LC = globalThis.LayerCounts;

describe('LayerCounts', () => {
    it('compacts numbers for a menu row', () => {
        expect(LC.compact(7)).toBe('7');
        expect(LC.compact(950)).toBe('950');
        expect(LC.compact(1200)).toBe('1.2k');
        expect(LC.compact(3000)).toBe('3k');
        expect(LC.compact(34567)).toBe('35k');
        expect(LC.compact(1200000)).toBe('1.2M');
        expect(LC.compact(null)).toBe('');
    });

    it('uses registered counters and survives a throwing one', () => {
        LC.register('_test_ok', () => 42);
        LC.register('_test_bad', () => { throw new Error('x'); });
        expect(LC.countFor('_test_ok')).toBe(42);
        expect(LC.countFor('_test_bad')).toBeNull();
        expect(LC.countFor('_nothing')).toBeNull();
    });

    it('paints a badge on rows that are on and removes it when off', () => {
        document.body.innerHTML = '<div class="dt-layer-item" data-layer-key="_test_ok" aria-checked="true"><span class="dt-layer-name">A</span><label class="dt-toggle-switch"></label></div>';
        LC.update();
        const row = document.querySelector('.dt-layer-item');
        expect(row.querySelector('.layer-count').textContent).toBe('42');
        expect(row.lastElementChild.className).toBe('dt-toggle-switch');
        row.setAttribute('aria-checked', 'false');
        LC.update();
        expect(row.querySelector('.layer-count')).toBeNull();
        document.body.innerHTML = '';
    });
});
