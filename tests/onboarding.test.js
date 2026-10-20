import { describe, it, expect, beforeEach } from 'vitest';

// Onboarding is exposed on globalThis by tests/setup.js. These lock the
// once-per-visitor gate (the whole point — it must never nag on return visits),
// the step copy, and that render()/dismiss() set the flag and clean up the DOM.
const O = globalThis.Onboarding;

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
});

describe('Onboarding gating', () => {
    it('shows on a fresh visit', () => {
        expect(O.shouldShow()).toBe(true);
    });

    it('does not show once marked seen', () => {
        O.markSeen();
        expect(O.shouldShow()).toBe(false);
        expect(localStorage.getItem(O.STORAGE_KEY)).toBe('done');
    });

    it('init() renders the modal only on first run', () => {
        O.init();
        expect(document.getElementById('onboarding-backdrop')).not.toBeNull();
        O.dismiss();

        // Second init (return visit) is a no-op.
        O.init();
        expect(document.getElementById('onboarding-backdrop')).toBeNull();
    });
});

describe('Onboarding content', () => {
    it('is a multi-step flow covering the headline features', () => {
        expect(O.STEPS.length).toBeGreaterThanOrEqual(2);
        expect(O.STEPS[0].title).toMatch(/cell/i);
        expect(O.STEPS[1].body).toMatch(/text2map/i);
        for (const s of O.STEPS) {
            expect(s.title).toBeTruthy();
            expect(s.body).toBeTruthy();
            expect(s.icon).toBeTruthy();
        }
    });
});

describe('Onboarding render / dismiss', () => {
    it('dismiss() removes the modal and records it as seen', () => {
        O.render();
        expect(document.getElementById('onboarding-backdrop')).not.toBeNull();
        O.dismiss();
        expect(document.getElementById('onboarding-backdrop')).toBeNull();
        expect(O.shouldShow()).toBe(false);
    });

    it('the primary button uses readable ink-on-primary contrast', () => {
        O.render();
        const next = document.querySelector('.onboarding-next');
        expect(next).not.toBeNull();
        // Dark theme: dark ink (#0a0e27) on cyan — never an invalid colour.
        expect(next.style.color).toBeTruthy();
        expect(next.style.color).not.toContain('white');
        expect(next.style.background).toBeTruthy();
        O.dismiss();
    });

    it('does not stack a second backdrop if render() is called twice', () => {
        O.render();
        O.render();
        expect(document.querySelectorAll('#onboarding-backdrop')).toHaveLength(1);
        O.dismiss();
    });
});
