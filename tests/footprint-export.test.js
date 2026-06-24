import { describe, it, expect } from 'vitest';

const FEATURES = [
    {
        geometry: { type: 'Polygon', coordinates: [[[75.80, 22.70], [75.81, 22.70], [75.81, 22.71], [75.80, 22.71], [75.80, 22.70]]] },
        height: 24.5, num_floors: 7, class: 'residential',
    },
    {
        geometry: { type: 'Polygon', coordinates: [[[75.82, 22.72], [75.83, 22.72], [75.83, 22.73], [75.82, 22.73], [75.82, 22.72]]] },
        height: 0, num_floors: null, class: 'commercial',
    },
];
const CELL = { code: '39J-49L-L8T4', bounds: { south: 22.70, north: 22.71, west: 75.80, east: 75.81 } };

describe('FootprintExport.toGeoJSON', () => {
    it('emits a FeatureCollection of footprints plus the DIGIPIN cell', () => {
        const fc = FootprintExport.toGeoJSON(FEATURES, CELL);
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(3); // 2 buildings + 1 cell
        const b0 = fc.features[0];
        expect(b0.properties.layer).toBe('buildings');
        expect(b0.properties.height_m).toBe(24.5);
        const cell = fc.features[fc.features.length - 1];
        expect(cell.properties.layer).toBe('digipin');
        expect(cell.properties.code).toBe('39J-49L-L8T4');
        expect(cell.geometry.coordinates[0]).toHaveLength(5); // closed ring
    });

    it('omits the cell feature when bounds are missing', () => {
        const fc = FootprintExport.toGeoJSON(FEATURES, { code: 'x' });
        expect(fc.features).toHaveLength(2);
    });

    it('handles an empty feature list', () => {
        const fc = FootprintExport.toGeoJSON([], CELL);
        expect(fc.features).toHaveLength(1); // just the cell
    });
});

describe('FootprintExport.toDXF', () => {
    it('produces a structurally valid ENTITIES drawing', () => {
        const dxf = FootprintExport.toDXF(FEATURES, CELL);
        expect(dxf.startsWith('0\nSECTION\n2\nENTITIES')).toBe(true);
        expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
        // One LWPOLYLINE per building + one for the cell.
        const polylines = (dxf.match(/LWPOLYLINE/g) || []).length;
        expect(polylines).toBe(3);
        // Buildings + cell land on the right layers.
        expect(dxf).toContain('BUILDINGS');
        expect(dxf).toContain('DIGIPIN');
        // Height becomes extrusion thickness (group code 39) for the tall building.
        expect(dxf).toContain('\n39\n24.5\n');
    });

    it('writes vertex group codes (10/20) for each ring point', () => {
        const dxf = FootprintExport.toDXF([FEATURES[0]], null);
        expect((dxf.match(/\n10\n/g) || []).length).toBe(5); // 5 ring vertices
        expect((dxf.match(/\n20\n/g) || []).length).toBe(5);
    });
});

describe('FootprintExport.filename', () => {
    it('builds geojson/dxf names from the code', () => {
        expect(FootprintExport.filename('geojson', '39J-49L')).toBe('digipin_footprints_39J49L.geojson');
        expect(FootprintExport.filename('dxf', '39J-49L')).toBe('digipin_footprints_39J49L.dxf');
        expect(FootprintExport.filename('dxf', null)).toBe('digipin_footprints_cell.dxf');
    });
});
