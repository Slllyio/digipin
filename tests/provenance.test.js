import { describe, it, expect } from 'vitest';

// Provenance is exposed on globalThis by tests/setup.js. forKey/card/forRanking
// are pure; lookups take injected spec/generated values so no catalog is needed.
const P = globalThis.Provenance;

const SCORES_SPEC = {
    id: 'scores', title: 'Scores', level: 6, approxCellM: 244,
    source: 'pipeline/scores/build_tile.py', license: 'ODbL (OpenStreetMap)',
    regions: [{ name: 'indore_pilot' }],
};

describe('Provenance.forKey()', () => {
    it('returns the registry entry for a Digital-Twin layer key', () => {
        const m = P.forKey('overture_places');
        expect(m.source).toMatch(/Overture/);
        expect(m.license).toBe('CDLA Permissive 2.0');
    });

    it('covers every toolbar overlay in the Layers panel', () => {
        const missing = globalThis.LayersPanel.ANALYTICS
            .map(a => '_btn_' + a.btnId)
            .filter(k => !P.forKey(k));
        expect(missing).toEqual([]);
    });

    it('covers every Digital-Twin layer', () => {
        const missing = Object.keys(globalThis.DigitalTwinLayers.LAYER_DEFS).filter(k => !P.forKey(k));
        expect(missing).toEqual([]);
    });

    it('reads a cell-store dataset from the catalog spec', () => {
        const m = P.forKey('_cell_scores', () => SCORES_SPEC, '2026-10-20T18:38:46Z');
        expect(m).toEqual({
            source: 'pipeline/scores/build_tile.py',
            method: 'DIGIPIN level 6, ~244 m cells',
            coverage: 'indore_pilot',
            license: 'ODbL (OpenStreetMap)',
            asOf: '2026-10-20T18:38:46Z',
        });
    });

    it('shares one entry across heatmap rows and returns null for unknown keys', () => {
        expect(P.forKey('_heat_safety').source).toMatch(/cell scores/);
        expect(P.forKey('nope')).toBeNull();
        expect(P.forKey('')).toBeNull();
        expect(P.forKey('_cell_missing', () => null, null)).toBeNull();
    });
});

describe('Provenance.card()', () => {
    it('orders rows and drops empty fields', () => {
        const rows = P.card({ license: 'ODbL', source: 'OSM', method: '', asOf: null });
        expect(rows).toEqual([
            { label: 'Source', value: 'OSM' },
            { label: 'Licence', value: 'ODbL' },
        ]);
        expect(P.card(null)).toEqual([]);
    });
});

describe('Provenance.forRanking()', () => {
    const parsed = { weights: { safety: 0.9, flood_risk: -0.8 }, source: 'llm', label: 'Safe' };

    it('describes a precomputed ranking from the scores catalog entry', () => {
        const m = P.forRanking(parsed, 'precomputed', {
            provider: 'Groq Cloud', scoresSpec: SCORES_SPEC, generated: '2026-10-20',
        });
        expect(m.ai).toBe(true);
        expect(m.source).toBe('Precomputed DIGIPIN score grid (pipeline/scores/build_tile.py)');
        expect(m.method).toBe('Question read by Language model (Groq Cloud); weighted sum of 2 scores');
        expect(m.coverage).toBe('indore_pilot');
        expect(m.asOf).toBe('2026-10-20');
    });

    it('flags live sampling and offline parsers as not AI-derived', () => {
        const m = P.forRanking({ ...parsed, source: 'lexicon' }, 'live', { scoresSpec: null, generated: null });
        expect(m.ai).toBe(false);
        expect(m.source).toMatch(/Live public-API sampling/);
        expect(m.coverage).toBe('Current map view');
        expect(m.license).toBeNull();
        expect(P.forRanking(null, 'live')).toBeNull();
    });
});

describe('Provenance.decorateRow()', () => {
    it('adds one ⓘ button that toggles the card without toggling the row', () => {
        const item = document.createElement('div');
        item.className = 'dt-layer-item';
        item.dataset.layerKey = 'sensor_aqi';
        item.innerHTML = '<span class="dt-layer-name">Air Quality</span><label class="dt-toggle-switch"></label>';
        const parent = document.createElement('div');
        parent.appendChild(item);
        let rowClicks = 0;
        item.addEventListener('click', () => { rowClicks++; });

        P.decorateRow(item);
        P.decorateRow(item);    // idempotent
        const btns = item.querySelectorAll('.dt-source-btn');
        expect(btns.length).toBe(1);

        btns[0].click();
        expect(item.nextElementSibling.classList.contains('source-card')).toBe(true);
        expect(item.nextElementSibling.textContent).toMatch(/Open-Meteo/);
        expect(btns[0].getAttribute('aria-expanded')).toBe('true');
        btns[0].click();
        expect(item.nextElementSibling).toBeNull();
        expect(rowClicks).toBe(0);
    });

    it('skips the "plot a file" action row', () => {
        const item = document.createElement('div');
        item.dataset.layerKey = '_cell_ingest';
        P.decorateRow(item);
        expect(item.querySelector('.dt-source-btn')).toBeNull();
    });
});
