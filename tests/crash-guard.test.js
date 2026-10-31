/**
 * CrashGuard — uncaught errors surface as a persistent notice with Reload.
 * Loaded as a global by tests/setup.js; vitest env is jsdom.
 */
import { describe, it, expect, beforeEach } from 'vitest';

describe('CrashGuard', () => {
    beforeEach(() => { CrashGuard.reset(); DataStatus.reset(); document.body.innerHTML = ''; });

    it('counts a real error, keeps it in the ring buffer and shows the notice', () => {
        expect(CrashGuard.report(new Error('boom'), 'test')).toBe(true);
        expect(CrashGuard.count()).toBe(1);
        expect(CrashGuard.recent()[0]).toMatchObject({ message: 'boom', source: 'test' });
        const row = document.querySelector('#data-status [data-key="crash"]');
        expect(row).not.toBeNull();
        expect(row.className).toContain('ds-warning');
        expect(row.textContent).toContain('Something went wrong');
        expect(row.querySelector('.ds-action').textContent).toBe('Reload');
    });

    it('escalates to error after three and reports the count', () => {
        CrashGuard.report(new Error('a')); CrashGuard.report(new Error('b')); CrashGuard.report(new Error('c'));
        const row = document.querySelector('#data-status [data-key="crash"]');
        expect(row.className).toContain('ds-error');
        expect(row.textContent).toContain('3 errors');
    });

    it('ignores benign noise', () => {
        for (const m of ['ResizeObserver loop limit exceeded', 'Script error.', 'AbortError: The operation was aborted',
            'TypeError: Failed to fetch', 'WebGL: CONTEXT_LOST_WEBGL: context lost']) {
            expect(CrashGuard.report(new Error(m)), m).toBe(false);
        }
        expect(CrashGuard.count()).toBe(0);
        expect(document.getElementById('data-status')).toBeNull();
    });

    it('listens to window error and unhandledrejection once installed', () => {
        CrashGuard.init();
        window.dispatchEvent(new ErrorEvent('error', { error: new Error('late'), message: 'late', filename: 'http://x/js/foo.js' }));
        expect(CrashGuard.recent().at(-1)).toMatchObject({ message: 'late', source: 'foo.js' });
        const ev = new Event('unhandledrejection');
        ev.reason = new Error('rejected');
        window.dispatchEvent(ev);
        expect(CrashGuard.recent().at(-1)).toMatchObject({ message: 'rejected', source: 'promise' });
        expect(CrashGuard.count()).toBe(2);
    });

    it('caps the ring buffer at 20 entries', () => {
        for (let i = 0; i < 30; i++) CrashGuard.report(new Error('e' + i));
        expect(CrashGuard.recent().length).toBe(20);
        expect(CrashGuard.recent()[0].message).toBe('e10');
    });
});
