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
