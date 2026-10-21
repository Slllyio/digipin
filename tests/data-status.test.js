/**
 * DataStatus — persistent keyed status strip for degraded data states.
 * Loaded as a global by tests/setup.js; vitest env is jsdom.
 */
import { describe, it, expect, beforeEach } from 'vitest';

describe('DataStatus', () => {
    beforeEach(() => { DataStatus.reset(); document.body.innerHTML = ''; });

    it('creates the strip on first set and removes it when the last entry clears', () => {
        expect(document.getElementById('data-status')).toBeNull();
        DataStatus.set('offline', { text: 'You are offline', kind: 'warning' });
        const host = document.getElementById('data-status');
        expect(host).not.toBeNull();
        expect(host.getAttribute('role')).toBe('status');
        expect(host.textContent).toContain('You are offline');
        expect(host.querySelector('.data-status-row').className).toContain('ds-warning');
        DataStatus.clear('offline');
        expect(document.getElementById('data-status')).toBeNull();
        expect(DataStatus.active()).toEqual([]);
    });

    it('keeps entries independent and reports the active keys', () => {
        DataStatus.set('offline', { text: 'offline' });
        DataStatus.set('cellstore', { text: 'store down', kind: 'error' });
        expect(DataStatus.active().sort()).toEqual(['cellstore', 'offline']);
        DataStatus.clear('offline');
        expect(DataStatus.active()).toEqual(['cellstore']);
        expect(document.querySelectorAll('.data-status-row').length).toBe(1);
        expect(document.querySelector('.data-status-row').dataset.key).toBe('cellstore');
    });

    it('dismiss hides the entry until it is set again with different text', () => {
        DataStatus.set('cellstore', { text: 'store down' });
        document.querySelector('.ds-dismiss').click();
        expect(DataStatus.has('cellstore')).toBe(false);
        expect(document.getElementById('data-status')).toBeNull();
        DataStatus.set('cellstore', { text: 'store down' });          // same text → stays dismissed
        expect(DataStatus.has('cellstore')).toBe(false);
        DataStatus.set('cellstore', { text: 'store still down (2)' }); // new text → shows again
        expect(DataStatus.has('cellstore')).toBe(true);
    });

    it('runs the action and clears the entry when it resolves truthy', async () => {
        let calls = 0;
        DataStatus.set('cellstore', { text: 'down', action: { label: 'Retry', run: async () => { calls++; return calls >= 2; } } });
        const btn = () => document.querySelector('.ds-action');
        expect(btn().textContent).toBe('Retry');
        btn().click();
        await new Promise(r => setTimeout(r, 0));
        expect(calls).toBe(1);
        expect(DataStatus.has('cellstore')).toBe(true);     // first retry failed → still shown
        btn().click();
        await new Promise(r => setTimeout(r, 0));
        expect(calls).toBe(2);
        expect(DataStatus.has('cellstore')).toBe(false);    // second succeeded → cleared
    });

    it('re-setting an unchanged row keeps its DOM (a Retry being clicked is not detached)', async () => {
        let runs = 0;
        DataStatus.set('heights', { text: 'estimates', action: { label: 'Retry', run: async () => { runs++; return false; } } });
        const before = document.querySelector('.data-status-row[data-key="heights"]');
        const btn = before.querySelector('.ds-action');
        DataStatus.set('heights', { text: 'estimates', action: { label: 'Retry', run: async () => { runs += 10; return false; } } });
        expect(document.querySelector('.data-status-row[data-key="heights"]')).toBe(before);
        expect(before.querySelector('.ds-action')).toBe(btn);
        btn.click();
        await new Promise(r => setTimeout(r, 0));
        expect(runs).toBe(10);   // the latest callback runs, through the same button
        DataStatus.set('heights', { text: 'estimates (2)', action: { label: 'Retry', run: async () => false } });
        expect(document.querySelector('.data-status-row[data-key="heights"]')).not.toBe(before);   // new text → re-rendered
    });

    it('never injects text as HTML', () => {
        DataStatus.set('x', { text: '<img src=x onerror=alert(1)>' });
        expect(document.querySelector('#data-status img')).toBeNull();
        expect(document.querySelector('.ds-text').textContent).toContain('<img');
    });
});
