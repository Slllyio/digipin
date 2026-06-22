import { describe, it, expect } from 'vitest';

describe('Annotations list operations (pure)', () => {
    it('addNote appends an immutable copy with an id', () => {
        const a = [];
        const b = Annotations.addNote(a, { lat: 22.7, lng: 75.8, text: 'gate' });
        expect(a).toHaveLength(0);          // original untouched
        expect(b).toHaveLength(1);
        expect(b[0].id).toBeTruthy();
        expect(b[0].text).toBe('gate');
        expect(b[0].color).toBe('#ff673d'); // default
    });

    it('addNote rejects notes without finite coordinates', () => {
        expect(Annotations.addNote([], { text: 'x' })).toHaveLength(0);
        expect(Annotations.addNote([], { lat: 'a', lng: 1 })).toHaveLength(0);
    });

    it('addNote clamps text to 140 chars', () => {
        const b = Annotations.addNote([], { lat: 0, lng: 0, text: 'x'.repeat(200) });
        expect(b[0].text).toHaveLength(140);
    });

    it('removeNote drops by id', () => {
        const a = Annotations.addNote([], { lat: 1, lng: 1, id: 'keep', text: 'a' });
        const b = Annotations.addNote(a, { lat: 2, lng: 2, id: 'drop', text: 'b' });
        const c = Annotations.removeNote(b, 'drop');
        expect(c.map(n => n.id)).toEqual(['keep']);
    });
});

describe('Annotations serialize/parse round-trip', () => {
    it('round-trips a clean list', () => {
        const list = Annotations.addNote([], { lat: 22.7, lng: 75.8, id: 'n1', text: 'hi', color: '#0099ff' });
        const back = Annotations.parse(Annotations.serialize(list));
        expect(back).toEqual(list);
    });

    it('parse is robust to garbage and bad shapes', () => {
        expect(Annotations.parse('not json')).toEqual([]);
        expect(Annotations.parse('{"a":1}')).toEqual([]);   // not an array
        expect(Annotations.parse('[{"text":"no coords"}]')).toEqual([]); // dropped
    });
});

describe('Annotations.toGeoJSON', () => {
    it('emits Point features with text + color properties', () => {
        const list = Annotations.addNote([], { lat: 22.7, lng: 75.8, text: 'site entry', color: '#ff673d' });
        const fc = Annotations.toGeoJSON(list);
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [75.8, 22.7] });
        expect(fc.features[0].properties).toMatchObject({ layer: 'annotation', text: 'site entry' });
    });

    it('handles an empty/invalid list', () => {
        expect(Annotations.toGeoJSON([]).features).toEqual([]);
        expect(Annotations.toGeoJSON(null).features).toEqual([]);
    });
});
