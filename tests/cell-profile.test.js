import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// CellProfile + CellStore + DigiPin are exposed by tests/setup.js.
const CP = globalThis.CellProfile;
const CS = globalThis.CellStore;

const LAT = 22.7196, LNG = 75.8577;
const C7 = CS.cellCode(7, LAT, LNG);
const C6 = C7.slice(0, 6);

const TRAFFIC = {
    id: 'traffic', title: 'Traffic', level: 7, group: 'Cell Data',
    fields: [
        { key: 'risk', label: 'Congestion risk', type: 'number', agg: 'max', unit: '0-100', higherIs: 'worse' },
        { key: 'los', label: 'LOS', type: 'category', agg: 'max' },
        { key: 'crit', label: 'Critical link', type: 'boolean', agg: 'any' },
    ],
    regions: [{ name: 'indore_pilot', bbox: { south: 22.5, west: 75.6, north: 22.9, east: 76.0 }, json: 'traffic/indore_pilot.json' }],
};
const SCORES = {
    id: 'scores', title: 'Scores', level: 6, group: 'Cell Data',
    fields: [{ key: 'walk', label: 'Walkability', type: 'number', agg: 'mean', higherIs: 'better' }],
    regions: [{ name: 'indore_pilot', bbox: { south: 22.5, west: 75.6, north: 22.9, east: 76.0 }, json: 'scores/indore_pilot.json' }],
};
const ELSEWHERE = { ...SCORES, id: 'pune_only', title: 'Pune', regions: [{ name: 'pune', bbox: { south: 18.4, west: 73.7, north: 18.7, east: 74.0 }, json: 'p/pune.json' }] };

function routes() {
    const docs = {
        'catalog.json': { version: 1, datasets: [TRAFFIC, SCORES, ELSEWHERE] },
        'traffic/indore_pilot.json': { level: 7, cells: [C7, C6 + 'C', C6 + 'F'], columns: { risk: [80, 10, 40], los: ['E', 'A', 'C'], crit: [true, false, null] } },
        'scores/indore_pilot.json': { level: 6, cells: [C6], columns: { walk: [55.25] } },
    };
    return vi.fn(async (url) => {
        for (const [frag, body] of Object.entries(docs)) {
            if (String(url).endsWith(frag)) return new Response(JSON.stringify(body), { status: 200 });
        }
        return new Response('nf', { status: 404 });
    });
}

beforeEach(async () => { globalThis.fetch = routes(); await CS.init(); CP.reset(); });
afterEach(() => vi.restoreAllMocks());

describe('CellProfile.formatValue()', () => {
    it('rounds by magnitude, keeps real units, drops range units', () => {
        expect(CP.formatValue({ type: 'number', unit: 'm' }, 1234.5)).toBe('1,235 m');
        expect(CP.formatValue({ type: 'number', unit: '0-100' }, 55.25)).toBe('55.3');
        expect(CP.formatValue({ type: 'number' }, 0.1234)).toBe('0.12');
        expect(CP.formatValue({ type: 'boolean' }, false)).toBe('no');
        expect(CP.formatValue({ type: 'category' }, 'E')).toBe('E');
        expect(CP.formatValue({ type: 'number' }, null)).toBe('—');
    });
});

describe('CellProfile.rankOf() / rankLabel()', () => {
    it('is the mid-rank share of values below v (ties count half)', () => {
        expect(CP.rankOf([1, 2, 3, 4], 3)).toBe(0.625);
        expect(CP.rankOf([1, 2, 3, 4], 0)).toBe(0);
        expect(CP.rankOf([0, 0, 0, 0, 5], 0)).toBe(0.4);   // shared zero is mid-pack, not "top"
        expect(CP.rankOf([], 3)).toBeNull();
        expect(CP.rankLabel({}, 0.95)).toBe('top 5%');
        expect(CP.rankLabel({}, 0.1)).toBe('bottom 10%');
    });
});

describe('CellProfile.profile()', () => {
    it('lists every dataset covering the cell, skipping ones that do not', async () => {
        const p = await CP.profile(LAT, LNG, { rank: true });
        expect(p.map(s => s.id)).toEqual(['traffic', 'scores']);
        const t = p[0];
        expect(t.level).toBe(7);
        expect(t.fields.map(f => [f.key, f.text])).toEqual([['risk', '80'], ['los', 'E'], ['crit', 'yes']]);
        expect(t.fields[0].rank).toBeCloseTo(5 / 6);    // highest risk of the three cells
        expect(t.fields[0].rankText).toBe('top 17%');
        expect(p[1].fields[0].text).toBe('55.3');
    });

    it('includes runtime (dropped-file) datasets with no extra code', async () => {
        const fields = [{ key: 'count', label: 'Count', type: 'number', agg: 'count' }];
        CS.register({ id: 'user_x', title: 'Dropped', level: 8, fields },
            CS.binRecords([{ lat: LAT, lng: LNG }, { lat: LAT, lng: LNG }], 8, fields));
        const p = await CP.profile(LAT, LNG);
        expect(p.find(s => s.id === 'user_x').fields[0].value).toBe(2);
        CS.unregister('user_x');
    });

    it('is empty outside every dataset', async () => {
        expect(await CP.profile(12.97, 77.59)).toEqual([]);
    });
});

describe('CellProfile.attachTo()', () => {
    it('renders one card ahead of the other cards and replaces it on re-attach', async () => {
        const el = document.createElement('div');
        el.innerHTML = '<div class="growth-widget" id="other"></div>';
        document.body.appendChild(el);
        const cell = { code: DigiPin.format(C7), center: { lat: LAT, lng: LNG } };
        await CP.attachTo(el, cell);
        await CP.attachTo(el, cell);
        const cards = el.querySelectorAll('[data-cell-profile]');
        expect(cards).toHaveLength(1);
        expect(el.firstElementChild.hasAttribute('data-cell-profile')).toBe(true);
        expect(cards[0].textContent).toContain('Congestion risk');
        expect(cards[0].textContent).toContain('2 layers');
        expect(cards[0].querySelectorAll('.cell-profile__show')).toHaveLength(2);
        el.remove();
    });

    it('drops a stale result when a newer cell was clicked meanwhile', async () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        const a = CP.attachTo(el, { code: 'a', center: { lat: LAT, lng: LNG } });
        const b = CP.attachTo(el, { code: 'b', center: { lat: 12.97, lng: 77.59 } });
        expect(await a).toBeNull();
        expect(await b).toEqual([]);
        expect(el.textContent).toContain('No cell-store dataset');
        el.remove();
    });
});
