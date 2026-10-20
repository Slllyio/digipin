import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// CitySelector is exposed on globalThis by tests/setup.js. These lock the
// coverage-driven labelling: a city is flagged "scored" exactly when
// data/scores/coverage.json lists its region.
const CS = globalThis.CitySelector;

function optionText(id) {
    return [...document.getElementById('city-select').options].find(o => o.value === id).textContent;
}

describe('CitySelector coverage labels', () => {
    beforeEach(() => {
        document.body.innerHTML = '<select id="city-select"></select>';
    });
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('maps Indore to the indore_pilot region and others to their id', () => {
        const byId = Object.fromEntries(CS.getCities().map(c => [c.id, c]));
        expect(CS.regionName(byId.indore)).toBe('indore_pilot');
        expect(CS.regionName(byId.delhi)).toBe('delhi');
    });

    it('flags only cities whose region has a precomputed tile', () => {
        vi.spyOn(globalThis.PrecomputedScores, 'getRegions')
            .mockReturnValue([{ name: 'indore_pilot' }, { name: 'mumbai' }]);
        CS.init();
        expect(optionText('indore')).toContain('· scored');
        expect(optionText('mumbai')).toContain('· scored');
        expect(optionText('delhi')).not.toContain('· scored');
    });

    it('relabels when coverage arrives after init', () => {
        const spy = vi.spyOn(globalThis.PrecomputedScores, 'getRegions').mockReturnValue([]);
        CS.init();
        expect(optionText('delhi')).not.toContain('· scored');
        spy.mockReturnValue([{ name: 'delhi' }]);
        CS.refreshCoverage();
        expect(optionText('delhi')).toContain('· scored');
    });
});

describe('CitySelector city changes', () => {
    beforeEach(() => { document.body.innerHTML = '<select id="city-select"></select>'; });
    afterEach(() => { document.body.innerHTML = ''; });

    it('describes the current city as a cell-store area and notifies listeners', () => {
        globalThis.MapModule = globalThis.MapModule || {};
        globalThis.MapModule.flyTo = vi.fn();
        globalThis.App = globalThis.App || {};
        globalThis.App.showToast = vi.fn();
        CS.init();
        const seen = [];
        const off = CS.onChange(c => seen.push(c.id));
        const select = document.getElementById('city-select');
        select.value = 'pune';
        select.dispatchEvent(new Event('change'));
        expect(seen).toEqual(['pune']);
        expect(CS.currentArea()).toMatchObject({ id: 'pune', region: 'pune', lat: 18.5204 });
        off();
        select.value = 'indore';
        select.dispatchEvent(new Event('change'));
        expect(seen).toEqual(['pune']);
        expect(CS.currentArea().region).toBe('indore_pilot');
    });
});
