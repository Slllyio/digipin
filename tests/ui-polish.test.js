import { describe, it, expect } from 'vitest';

const U = globalThis.UIPolish;

describe('UIPolish.icon()', () => {
    it('renders a currentColor stroke SVG, hidden from assistive tech', () => {
        const svg = U.icon('search', 20);
        expect(svg).toMatch(/^<svg class="ui-icon" width="20" height="20"/);
        expect(svg).toContain('stroke="currentColor"');
        expect(svg).toContain('aria-hidden="true"');
    });
    it('returns empty markup for unknown icons', () => {
        expect(U.icon('nope')).toBe('');
    });
    it('has an icon for every mapped toolbar button', () => {
        for (const name of Object.values(U.TOOLBAR)) expect(U.PATHS[name], name).toBeTruthy();
    });
});

describe('UIPolish.hazeOpacity()', () => {
    it('is zero for flat and gently tilted maps', () => {
        expect(U.hazeOpacity(0)).toBe(0);
        expect(U.hazeOpacity(35)).toBe(0);
        expect(U.hazeOpacity(NaN)).toBe(0);
    });
    it('ramps monotonically and saturates at 1', () => {
        expect(U.hazeOpacity(50)).toBeGreaterThan(0);
        expect(U.hazeOpacity(60)).toBeGreaterThan(U.hazeOpacity(50));
        expect(U.hazeOpacity(70)).toBe(1);
        expect(U.hazeOpacity(85)).toBe(1);
    });
});

describe('UIPolish.applyIcons()', () => {
    it('swaps toolbar and top-bar glyphs for SVG while keeping labels', () => {
        document.body.innerHTML = `
            <div id="top-bar"><button id="search-btn">🔍</button><button id="share-btn">🔗</button><button id="theme-toggle-btn">☀️</button></div>
            <div id="toolbar"><button id="btn-pitch"><span class="tb-icon">📷</span><span class="tb-label">Pitch</span></button></div>
            <nav id="sidebar"><button id="sidebar-toggle">←</button><div class="sidebar-title">🧠 Urban Queries</div></nav>`;
        const n = U.applyIcons(document);
        expect(n).toBe(1);
        expect(document.querySelector('#btn-pitch .tb-icon svg')).not.toBeNull();
        expect(document.querySelector('#btn-pitch .tb-label').textContent).toBe('Pitch');
        expect(document.querySelector('#search-btn svg')).not.toBeNull();
        expect(document.querySelector('.sidebar-title').textContent.trim()).toBe('Urban Queries');
        expect(document.querySelector('.sidebar-title svg')).not.toBeNull();
    });
});

describe('UIPolish.skySpec()', () => {
    it('gives each theme its own sky and fog colours', () => {
        const d = U.skySpec('dark'), l = U.skySpec('light');
        expect(d['sky-color']).not.toBe(l['sky-color']);
        expect(d['fog-color']).toBeTruthy();
        expect(U.skySpec('unknown')).toEqual(l);
    });
    it('returns a copy callers can mutate safely', () => {
        const a = U.skySpec('dark'); a['sky-color'] = '#000';
        expect(U.skySpec('dark')['sky-color']).not.toBe('#000');
    });
});

describe('Terrain.elevationWithFallback()', () => {
    const T = globalThis.Terrain;
    it('clamps the lookup zoom to the DEM maxzoom', () => {
        const seen = [];
        const v = T.elevationWithFallback((ll, z) => { seen.push(z); return 550; }, {}, 16.7, 15);
        expect(v).toBe(550);
        expect(seen).toEqual([15]);
    });
    it('steps to coarser zooms while the tile has no data yet', () => {
        const v = T.elevationWithFallback((ll, z) => (z <= 12 ? 820 : 0), {}, 15.8, 15);
        expect(v).toBe(820);
    });
    it('gives up at 0 after eight levels (sea-level or nothing loaded)', () => {
        const seen = [];
        expect(T.elevationWithFallback((ll, z) => { seen.push(z); return 0; }, {}, 15, 15)).toBe(0);
        expect(seen).toHaveLength(9);
    });
});

describe('UIPolish Aino light basemap + AI orb', () => {
    it('maps Positron layer ids to the Aino palette by type', () => {
        const out = UIPolish.ainoPaint([
            { id: 'background', type: 'background' },
            { id: 'park_national_park', type: 'fill' },
            { id: 'landuse_residential', type: 'fill' },
            { id: 'water', type: 'fill' },
            { id: 'road_minor_fill', type: 'line' },
            { id: 'road_minor_case', type: 'line' },
            { id: 'place_city', type: 'symbol' },
        ]);
        const byId = Object.fromEntries(out.map(([id, prop, c]) => [id, [prop, c]]));
        expect(byId.background).toEqual(['background-color', '#f3f3f1']);
        expect(byId.park_national_park[0]).toBe('fill-color');
        expect(byId.landuse_residential[1]).toBe('rgba(0,0,0,0)');
        expect(byId.road_minor_fill).toEqual(['line-color', '#ffffff']);
        expect(byId.road_minor_case[0]).toBe('line-color');
        expect(byId.place_city).toBeUndefined();
        expect(UIPolish.ainoPaint(undefined)).toEqual([]);
    });

    it('adds one AI orb before the toolbar', () => {
        document.body.innerHTML = '<div id="toolbar"></div>';
        const b = UIPolish.addAiOrb(document);
        expect(b.id).toBe('ai-orb');
        expect(b.nextElementSibling.id).toBe('toolbar');
        expect(b.querySelector('svg')).toBeTruthy();
        expect(UIPolish.addAiOrb(document)).toBeNull();
    });
});

describe('UIPolish Aino layer rows', () => {
    it('splits the level off a layer title', () => {
        expect(UIPolish.splitLevel('Travel time to services · L6')).toEqual({ name: 'Travel time to services', level: 'L6' });
        expect(UIPolish.splitLevel('Wards')).toEqual({ name: 'Wards', level: '' });
    });

    it('shortens a source to its first clause', () => {
        expect(UIPolish.shortSource('Google Earth Engine — MODIS MOD11A2; 1 km')).toBe('Google Earth Engine');
        expect(UIPolish.shortSource('')).toBe('');
        expect(UIPolish.shortSource('x'.repeat(60)).length).toBeLessThanOrEqual(43);
    });

    it('wraps the name with a source line and sets a dot colour, once', () => {
        document.body.innerHTML = '<div class="dt-layer-item" data-layer-key="_cell_x"><span class="dt-layer-icon">▦</span><span class="dt-layer-name">LST · L6</span><label class="dt-toggle-switch"></label></div>';
        const item = document.querySelector('.dt-layer-item');
        UIPolish.decorateLayerRow(item);
        UIPolish.decorateLayerRow(item);
        expect(item.querySelectorAll('.dt-layer-text')).toHaveLength(1);
        expect(item.querySelector('.dt-layer-name').textContent).toBe('LST');
        expect(item.querySelector('.dt-layer-src').textContent).toContain('L6');
        expect(item.style.getPropertyValue('--dot')).toMatch(/^#/);
    });
});

describe('UIPolish emoji split', () => {
    it('splits leading emoji from a sector label', () => {
        expect(UIPolish.splitEmoji('🏢 Commercial & Business')).toEqual({ emoji: '🏢', text: 'Commercial & Business' });
        expect(UIPolish.splitEmoji('Residential')).toEqual({ emoji: '', text: 'Residential' });
    });
});
