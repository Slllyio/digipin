/**
 * Tests for HeatWidget — DOM widget rendered in the cell panel.
 *
 * The widget module is loaded into globalThis by tests/setup.js via
 * loadGlobalScript. The vitest environment is jsdom (see vitest.config.js),
 * so document/window are already available — no fresh JSDOM instance needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';

describe('HeatWidget.attachTo()', () => {
    let container;
    beforeEach(() => {
        document.body.innerHTML = '';
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('renders the "unavailable" state when heat is null', () => {
        globalThis.HeatWidget.attachTo(container, null, { code: 'X1' });
        expect(container.innerHTML).toContain('Heat data unavailable');
    });

    it('renders the composite score and breakdown when heat is present', () => {
        const heat = {
            uhi_score: 72,
            anomaly_c: 4.0,
            night_lst_c: 26.5,
            day_lst_c: 41.2,
            diurnal_range_c: 14.7,
            trend: { slope_c_per_yr: 0.12, r_squared: 0.85 },
            sources: { modis_lst: 'ok' },
        };
        globalThis.HeatWidget.attachTo(container, heat, { code: 'X1' });
        expect(container.textContent).toContain('72');
        expect(container.textContent).toContain('26.5');
        expect(container.textContent).toContain('41.2');
        expect(container.textContent).toContain('14.7');
        expect(container.textContent).toContain('+0.12');
    });

    it('is idempotent — calling twice replaces, not duplicates', () => {
        const heat = {
            uhi_score: 50,
            anomaly_c: 2.0,
            night_lst_c: 25,
            day_lst_c: 38,
            diurnal_range_c: 13,
            trend: { slope_c_per_yr: 0.05, r_squared: 0.5 },
            sources: { modis_lst: 'ok' },
        };
        globalThis.HeatWidget.attachTo(container, heat, { code: 'X1' });
        globalThis.HeatWidget.attachTo(container, heat, { code: 'X1' });
        expect(container.querySelectorAll('[data-heat-widget]').length).toBe(1);
    });
});
