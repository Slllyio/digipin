import { describe, it, expect } from 'vitest';

const PN = globalThis.PlacesNearby;

const sample = {
    query: {
        pages: [
            { pageid: 2, title: 'Red Fort', index: 2, description: 'Historic fort in Delhi, India', fullurl: 'https://en.wikipedia.org/wiki/Red_Fort', thumbnail: { source: 'https://upload.wikimedia.org/x.jpg' }, coordinates: [{ lat: 28.6562, lon: 77.241, dist: 5100 }] },
            { pageid: 1, title: 'Connaught Place', index: 1, description: 'Business district in New Delhi', coordinates: [{ lat: 28.6315, lon: 77.2167, dist: 1900 }] },
            { pageid: 3, title: 'No coords', index: 3 },
        ],
    },
};

describe('PlacesNearby', () => {
    it('asks English or Hindi Wikipedia for geotagged pages around the point', () => {
        const u = new URL(PN.apiUrl(28.6139, 77.209));
        expect(u.host).toBe('en.wikipedia.org');
        expect(u.searchParams.get('ggscoord')).toBe('28.61390|77.20900');
        expect(u.searchParams.get('ggsradius')).toBe('10000');
        expect(u.searchParams.get('origin')).toBe('*');
        expect(new URL(PN.apiUrl(28.6, 77.2, 'hi')).host).toBe('hi.wikipedia.org');
    });

    it('parses pages nearest first, each with its DIGIPIN and a kind', () => {
        const p = PN.parse(sample, globalThis.DigiPin.encode);
        expect(p.map(x => x.title)).toEqual(['Connaught Place', 'Red Fort']);
        expect(p[1]).toMatchObject({ kind: 'heritage', thumb: 'https://upload.wikimedia.org/x.jpg', url: 'https://en.wikipedia.org/wiki/Red_Fort' });
        expect(p[1].digipin).toBe(globalThis.DigiPin.encode(28.6562, 77.241));
        expect(PN.parse(null)).toEqual([]);
    });

    it('classifies places by their short description', () => {
        expect(PN.kindOf('Hindu temple in Indore')).toBe('worship');
        expect(PN.kindOf('Urban park in Delhi')).toBe('nature');
        expect(PN.kindOf('Metro station in Bengaluru')).toBe('transport');
        expect(PN.kindOf('Neighbourhood in Mumbai')).toBe('locality');
        expect(PN.kindOf('')).toBe('other');
    });

    it('builds point features with a colour per kind', () => {
        const fc = PN.toGeoJSON(PN.parse(sample, null));
        expect(fc.features).toHaveLength(2);
        expect(fc.features[1].properties).toMatchObject({ title: 'Red Fort', color: PN.KIND_COLORS.heritage, hasPhoto: 1 });
        expect(fc.features[0].geometry.coordinates).toEqual([77.2167, 28.6315]);
    });
});
