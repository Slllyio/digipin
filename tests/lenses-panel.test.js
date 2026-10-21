import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// LensesPanel, UrbanLenses, CellStore, CellLayers are exposed by tests/setup.js.
const P = globalThis.LensesPanel;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

async function store() {
    globalThis.fetch = async (url) => {
        const f = path.join(ROOT, String(url).split('?')[0]);
        if (!existsSync(f)) return new Response('not found', { status: 404 });
        return new Response(readFileSync(f), { status: 200 });
    };
    await globalThis.CellStore.init();
    return globalThis.CellStore;
}

describe('LensesPanel', () => {
    it('renders a card per lens and paints / outlines from the buttons', async () => {
        const st = await store();
        const body = document.createElement('div');
        const highlight = vi.fn();
        const show = vi.spyOn(globalThis.CellLayers, 'show').mockResolvedValue(true);
        let city = null;
        await P.render(body, {
            store: st, city: 'bhopal', cities: [{ name: 'bhopal', label: 'Bhopal' }, { name: 'pune', label: 'Pune' }],
            isCurrent: () => true, setCity: (c) => { city = c; }, highlight,
            sparkline: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        });
        const cards = body.querySelectorAll('.ui-lens');
        expect(cards.length).toBeGreaterThanOrEqual(6);
        const heat = body.querySelector('[data-lens="heat"]');
        expect(heat.textContent).toMatch(/heat-vulnerable tenth/);
        expect(heat.textContent).toMatch(/Gini/);
        heat.querySelector('.ui-actions button').click();
        await new Promise(r => setTimeout(r, 0));
        expect(globalThis.CellStore.isLocal('lenses')).toBe(true);
        expect(show).toHaveBeenCalledWith('lenses', { field: 'hvi', extrude: true });
        const hot = [...heat.querySelectorAll('button')].find(b => b.textContent.includes('Hot spots'));
        hot.click();
        expect(highlight).toHaveBeenCalled();
        expect(highlight.mock.calls[0][0][0].kind).toBe('concern');
        [...body.querySelectorAll('.ui-citypick button')].find(b => b.textContent === 'Pune').click();
        expect(city).toBe('pune');
        const siting = body.querySelector('[data-lens="siting"]');
        expect(siting.querySelectorAll('.ui-lens-sites li').length).toBeGreaterThan(0);
        [...siting.querySelectorAll('button')].find(b => b.textContent.includes('New school')).click();
        expect(body.querySelector('[data-lens="siting"] .ui-headline').textContent).toMatch(/schools within a walk/);
        P.clear();
        expect(globalThis.CellStore.isLocal('lenses')).toBe(false);
        show.mockRestore();
    }, 60000);
});
