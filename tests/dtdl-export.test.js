/**
 * DTDLExport — building a RealEstateCore-aligned Digital Twins graph from a
 * fetched DIGIPIN cell. Validates DTDL model shape, twin mapping, relationships,
 * and the dialog summary. build()/summarize() are pure.
 */
import { describe, it, expect } from 'vitest';

const DTDLExport = globalThis.DTDLExport;

const CELL = { code: '4FK-J7M-2T9P', center: { lat: 22.7196, lng: 75.8577 }, areaSqm: 1444 };
const DATA = {
    scores: {
        livability: { label: 'Livability', value: 72 },
        flood_risk: { label: 'Flood Risk', value: 30 },
        bogus: { label: 'No Value' },           // skipped (no numeric value)
    },
    categories: {
        health: { features: {
            hospitals: { name: 'Hospitals', count: 3 },
            clinics: { name: 'Clinics', count: 0 },   // skipped (count 0)
        } },
    },
    realtime: {
        aqi: { aqi: 142 },
        weather: { temp: 31.4 },
        flood: { peak_ratio: 2.236, baseline_m3s: 0.6 },
    },
    buildingIntel: {
        buildings: { count: 88, avgLevels: 2.4 },
        metrics: { fsi: 1.3, gcr: 0.42, urbanForm: 'Open Midrise' },
        lcz: { name: 'Open Midrise' },
    },
};

describe('DTDLExport.models()', () => {
    it('emits valid self-contained DTDL interfaces under dtmi:digipin', () => {
        const models = DTDLExport.models();
        const ids = models.map(m => m['@id']);
        expect(ids).toContain('dtmi:digipin:Space;1');
        expect(ids).toContain('dtmi:digipin:Building;1');
        expect(ids).toContain('dtmi:digipin:Asset;1');
        expect(ids).toContain('dtmi:digipin:Capability;1');
        for (const m of models) {
            expect(m['@type']).toBe('Interface');
            expect(m['@context']).toBe('dtmi:dtdl:context;2');
            expect(Array.isArray(m.contents)).toBe(true);
        }
        // Building extends Space (RealEstateCore-style inheritance)
        expect(models.find(m => m['@id'] === 'dtmi:digipin:Building;1').extends)
            .toBe('dtmi:digipin:Space;1');
    });
});

describe('DTDLExport.build()', () => {
    const g = DTDLExport.build(CELL, DATA);
    const twins = g.digitalTwinsGraph.digitalTwins;
    const rels = g.digitalTwinsGraph.relationships;

    it('wraps the cell as a Space twin with centroid + code', () => {
        const root = twins.find(t => t.$metadata.$model === 'dtmi:digipin:Space;1'
            && t.digipinCode === '4FK-J7M-2T9P');
        expect(root).toBeTruthy();
        expect(root.latitude).toBeCloseTo(22.7196, 4);
        expect(root.areaSqm).toBe(1444);
        expect(root.$dtId).toMatch(/^digipin_[A-Za-z0-9]+$/);   // sanitised id
    });

    it('maps building morphology to a Building twin, hasPart the cell', () => {
        const b = twins.find(t => t.$metadata.$model === 'dtmi:digipin:Building;1');
        expect(b.buildingCount).toBe(88);
        expect(b.avgLevels).toBe(2.4);
        expect(b.floorSpaceIndex).toBe(1.3);
        expect(b.localClimateZone).toBe('Open Midrise');
        expect(rels.some(r => r.$relationshipName === 'hasPart' && r.$targetId === b.$dtId)).toBe(true);
    });

    it('makes a Capability per numeric score and skips valueless ones', () => {
        const caps = twins.filter(t => t.$metadata.$model === 'dtmi:digipin:Capability;1');
        const labels = caps.map(c => c.label);
        expect(labels).toContain('Livability');
        expect(labels).toContain('Flood Risk');
        expect(labels).not.toContain('No Value');     // had no numeric value
        const liv = caps.find(c => c.label === 'Livability');
        expect(liv.kind).toBe('Parameter');
        expect(liv.value).toBe(72);
    });

    it('adds Sensor/Forecast capabilities from live sources', () => {
        const caps = twins.filter(t => t.$metadata.$model === 'dtmi:digipin:Capability;1');
        expect(caps.find(c => c.unit === 'AQI').value).toBe(142);
        expect(caps.find(c => c.label === 'Temperature').value).toBeCloseTo(31.4, 5);
        expect(caps.find(c => c.kind === 'Forecast').value).toBe(2.24);   // rounded peak ratio
    });

    it('creates an Asset per amenity with count>0 and a locatedIn edge', () => {
        const assets = twins.filter(t => t.$metadata.$model === 'dtmi:digipin:Asset;1');
        expect(assets).toHaveLength(1);                 // hospitals only (clinics=0 skipped)
        expect(assets[0].category).toBe('Hospitals');
        expect(assets[0].count).toBe(3);
        expect(rels.some(r => r.$relationshipName === 'locatedIn'
            && r.$sourceId === assets[0].$dtId)).toBe(true);
    });

    it('every relationship references existing twins (valid graph)', () => {
        const ids = new Set(twins.map(t => t.$dtId));
        for (const r of rels) {
            expect(ids.has(r.$sourceId)).toBe(true);
            expect(ids.has(r.$targetId)).toBe(true);
        }
    });

    it('is valid JSON via toJSON()', () => {
        const parsed = JSON.parse(DTDLExport.toJSON(CELL, DATA));
        expect(parsed.digitalTwinsModels.length).toBe(4);
        expect(parsed.digitalTwinsGraph.digitalTwins.length).toBe(twins.length);
    });
});

describe('DTDLExport.summarize()', () => {
    it('counts models, twins, capabilities and assets for the dialog', () => {
        const s = DTDLExport.summarize(CELL, DATA);
        expect(s.models).toBe(4);
        expect(s.capabilities).toBe(5);   // 2 scores + AQI + temp + flood
        expect(s.assets).toBe(1);
        expect(s.twins).toBe(s.capabilities + s.assets + 2);  // + Space + Building
        expect(s.relationships).toBeGreaterThan(0);
    });

    it('is robust to an empty cell/data', () => {
        const s = DTDLExport.summarize({}, {});
        expect(s.twins).toBe(1);          // just the Space
        expect(s.models).toBe(4);
    });
});
