/**
 * Tests for GrowthWidget — DOM widget rendered in the cell panel.
 *
 * The widget module is loaded into globalThis by tests/setup.js via the
 * project's standard loadGlobalScript helper (vm.runInThisContext +
 * trailing globalThis.GrowthWidget = GrowthWidget). The vitest environment
 * is jsdom (see vitest.config.js), so document/window are already
 * available — no fresh JSDOM instance needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';

describe('GrowthWidget.attachTo()', () => {
    let container;
    beforeEach(() => {
        // Clear any previous attachments to keep tests isolated
        document.body.innerHTML = '';
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('renders the "unavailable" state when growth is null', () => {
        globalThis.GrowthWidget.attachTo(container, null, { code: 'X1' });
        expect(container.innerHTML).toContain('Growth data unavailable');
    });

    it('renders 3 horizon buttons and a composite when growth is present', () => {
        const growth = {
            active_horizon: 'nowcast',
            horizons: {
                nowcast: {
                    composite: 72, confidence_band: 5,
                    sub_scores: {
                        bue: { value: 80, direction: '▲', driver: '' },
                        den: { value: 60, direction: '▶', driver: '' },
                        cap: { value: 75, direction: '▲', driver: '' },
                    },
                    effective_weights: { bue: 0.4, den: 0.3, cap: 0.3 },
                },
                year_2: {
                    composite: 65, confidence_band: 10,
                    sub_scores: {
                        bue: { value: 80, direction: '▲', driver: '' },
                        den: { value: 60, direction: '▶', driver: '' },
                        cap: { value: 55, direction: '▶', driver: '' },
                    },
                    effective_weights: { bue: 0.2, den: 0.2, cap: 0.6 },
                },
                year_5: {
                    composite: 85, confidence_band: 18,
                    sub_scores: {
                        bue: { value: 80, direction: '▲', driver: '' },
                        den: { value: 60, direction: '▶', driver: '' },
                        cap: { value: 75, direction: '▲', driver: '' },
                    },
                    effective_weights: { bue: 0.4, den: 0.3, cap: 0.3 },
                },
            },
            sources: {}, generated_at_iso: '2026-05-24T12:00:00Z',
        };
        globalThis.GrowthWidget.attachTo(container, growth, { code: 'X1' });
        expect(container.querySelectorAll('[data-h]').length).toBe(3);
        expect(container.textContent).toContain('72');
        expect(container.textContent).toContain('±5');
    });

    it('is idempotent — calling twice replaces, not duplicates', () => {
        const growth = {
            active_horizon: 'nowcast',
            horizons: {
                nowcast: {
                    composite: 50, confidence_band: 5,
                    sub_scores: {
                        bue: { value: 50, direction: '▶', driver: '' },
                        den: { value: 50, direction: '▶', driver: '' },
                        cap: { value: 50, direction: '▶', driver: '' },
                    },
                    effective_weights: { bue: 0.4, den: 0.3, cap: 0.3 },
                },
                year_2: {
                    composite: 50, confidence_band: 10,
                    sub_scores: {
                        bue: { value: 50, direction: '▶', driver: '' },
                        den: { value: 50, direction: '▶', driver: '' },
                        cap: { value: 50, direction: '▶', driver: '' },
                    },
                    effective_weights: { bue: 0.2, den: 0.2, cap: 0.6 },
                },
                year_5: {
                    composite: 50, confidence_band: 25,
                    sub_scores: {
                        bue: { value: 50, direction: '▶', driver: '' },
                        den: { value: 50, direction: '▶', driver: '' },
                        cap: { value: 50, direction: '▶', driver: '' },
                    },
                    effective_weights: { bue: 0.4, den: 0.3, cap: 0.3 },
                },
            },
            sources: {}, generated_at_iso: '',
        };
        globalThis.GrowthWidget.attachTo(container, growth, { code: 'X1' });
        globalThis.GrowthWidget.attachTo(container, growth, { code: 'X1' });
        expect(container.querySelectorAll('[data-growth-widget]').length).toBe(1);
    });
});
