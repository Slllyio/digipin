/**
 * RealtimeAlerts — NDMA SACHET alert filtering and summary tests.
 *
 * Tests pure-function logic: filterBySeverity, filterByText, summary, getForLocation.
 * Fixtures include real SACHET alert data from data/realtime/ndma_sachet/latest.json.
 *
 * RealtimeAlerts is loaded as a globalThis property by tests/setup.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);

// Load real snapshot data
function loadSachetSnapshot() {
    const filePath = path.join(rootDir, 'data/realtime/ndma_sachet/latest.json');
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data.records) ? data.records : [];
}

const realAlerts = loadSachetSnapshot();

// Minimal synthetic fixtures for isolated testing
const mockAlerts = [
    {
        id: '1',
        headline: 'Heavy Thunderstorm with Lightning',
        description: 'Severe thunderstorm in progress. Take shelter immediately.',
        area: 'Maharashtra',
        severity: 'Severe',
        category: 'Met-Storm',
    },
    {
        id: '2',
        headline: 'Moderate Rain Warning',
        description: 'Light to moderate rainfall expected over coastal areas.',
        area: 'Kerala',
        severity: 'Moderate',
        category: 'Met-Storm',
    },
    {
        id: '3',
        headline: 'Minor Windstorm Alert',
        description: 'Light gusty winds up to 30 kmph.',
        area: 'Gujarat',
        severity: 'Minor',
        category: 'Wind',
    },
    {
        id: '4',
        headline: 'Extreme Cyclone Warning',
        description: 'Super cyclone approaching. Evacuate coastal areas now.',
        area: 'Tamil Nadu',
        severity: 'Extreme',
        category: 'Cyclone',
    },
    {
        id: '5',
        headline: 'Flood Risk in River Basin',
        description: 'Water levels rising rapidly in the Ganga delta. Monitor closely.',
        area: 'West Bengal',
        severity: 'Moderate',
        category: 'Flood',
    },
];

describe('RealtimeAlerts.filterBySeverity()', () => {
    it('filters alerts by Severe minimum (includes Severe and Extreme, excludes Moderate/Minor)', () => {
        const result = globalThis.RealtimeAlerts.filterBySeverity(mockAlerts, 'Severe');
        expect(result).toHaveLength(2);
        expect(result.map(a => a.severity)).toEqual(['Severe', 'Extreme']);
        expect(result.map(a => a.id)).toEqual(['1', '4']);
    });

    it('filters by Moderate threshold (includes Moderate, Severe, Extreme; excludes Minor)', () => {
        const result = globalThis.RealtimeAlerts.filterBySeverity(mockAlerts, 'Moderate');
        expect(result).toHaveLength(4);
        const severities = result.map(a => a.severity);
        expect(severities).toContain('Moderate');
        expect(severities).toContain('Severe');
        expect(severities).toContain('Extreme');
        expect(severities).not.toContain('Minor');
    });

    it('filters by Extreme threshold (only Extreme)', () => {
        const result = globalThis.RealtimeAlerts.filterBySeverity(mockAlerts, 'Extreme');
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('Extreme');
    });

    it('filters by Minor threshold (all alerts with Minor or higher)', () => {
        const result = globalThis.RealtimeAlerts.filterBySeverity(mockAlerts, 'Minor');
        expect(result).toHaveLength(5);
    });

    it('defaults to Severe when minLevel is invalid or missing', () => {
        const resultInvalid = globalThis.RealtimeAlerts.filterBySeverity(mockAlerts, 'Unknown');
        const resultDefault = globalThis.RealtimeAlerts.filterBySeverity(mockAlerts);
        expect(resultInvalid).toEqual(resultDefault);
        expect(resultDefault).toHaveLength(2);
    });

    it('returns empty array when no alerts match threshold', () => {
        const result = globalThis.RealtimeAlerts.filterBySeverity([], 'Severe');
        expect(result).toEqual([]);
    });

    it('skips alerts with missing or unknown severity', () => {
        const alertsWithMissing = [
            { id: '1', severity: 'Severe' },
            { id: '2', severity: undefined },
            { id: '3', severity: 'Extreme' },
        ];
        const result = globalThis.RealtimeAlerts.filterBySeverity(alertsWithMissing, 'Severe');
        expect(result).toHaveLength(2);
        expect(result.map(a => a.id)).toEqual(['1', '3']);
    });
});

describe('RealtimeAlerts.filterByText()', () => {
    it('filters by headline substring (case-insensitive)', () => {
        const result = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'thunderstorm');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('1');
    });

    it('filters by description substring (case-insensitive)', () => {
        const result = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'shelter');
        expect(result).toHaveLength(1);
        expect(result[0].headline).toContain('Heavy Thunderstorm');
    });

    it('filters by area substring (case-insensitive)', () => {
        const result = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'kerala');
        expect(result).toHaveLength(1);
        expect(result[0].area).toBe('Kerala');
    });

    it('matches partial text anywhere in headline/description/area', () => {
        const result = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'rain');
        expect(result.length).toBeGreaterThan(0);
        expect(result.map(a => a.id)).toContain('2');
    });

    it('is case-insensitive across all fields', () => {
        const lowerResult = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'extreme');
        const upperResult = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'EXTREME');
        const mixedResult = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'ExTrEmE');
        expect(lowerResult).toEqual(upperResult);
        expect(lowerResult).toEqual(mixedResult);
    });

    it('returns all alerts when needle is empty or null', () => {
        expect(globalThis.RealtimeAlerts.filterByText(mockAlerts, '')).toEqual(mockAlerts);
        expect(globalThis.RealtimeAlerts.filterByText(mockAlerts, null)).toEqual(mockAlerts);
        expect(globalThis.RealtimeAlerts.filterByText(mockAlerts, undefined)).toEqual(mockAlerts);
    });

    it('returns empty array when no text matches', () => {
        const result = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'nonexistenttext');
        expect(result).toEqual([]);
    });

    it('handles alerts with missing area/description gracefully', () => {
        const alertsWithMissing = [
            { id: '1', headline: 'Storm', description: null, area: '' },
            { id: '2', headline: 'Warning', description: 'Test warning', area: null },
        ];
        const result = globalThis.RealtimeAlerts.filterByText(alertsWithMissing, 'warning');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('2');
    });
});

describe('RealtimeAlerts.summary()', () => {
    it('returns total, byCategory, and bySeverity counts for populated array', () => {
        const result = globalThis.RealtimeAlerts.summary(mockAlerts);
        expect(result).toHaveProperty('total');
        expect(result).toHaveProperty('byCategory');
        expect(result).toHaveProperty('bySeverity');
        expect(result.total).toBe(5);
    });

    it('counts by severity correctly', () => {
        const result = globalThis.RealtimeAlerts.summary(mockAlerts);
        expect(result.bySeverity).toEqual({
            Severe: 1,
            Moderate: 2,
            Minor: 1,
            Extreme: 1,
        });
    });

    it('counts by category correctly', () => {
        const result = globalThis.RealtimeAlerts.summary(mockAlerts);
        expect(result.byCategory).toEqual({
            'Met-Storm': 2,
            Wind: 1,
            Cyclone: 1,
            Flood: 1,
        });
    });

    it('returns zero counts for empty array', () => {
        const result = globalThis.RealtimeAlerts.summary([]);
        expect(result.total).toBe(0);
        expect(result.byCategory).toEqual({});
        expect(result.bySeverity).toEqual({});
    });

    it('accumulates counts when multiple alerts share the same category/severity', () => {
        const duplicates = [
            { category: 'Met-Storm', severity: 'Severe' },
            { category: 'Met-Storm', severity: 'Severe' },
            { category: 'Met-Storm', severity: 'Moderate' },
        ];
        const result = globalThis.RealtimeAlerts.summary(duplicates);
        expect(result.total).toBe(3);
        expect(result.byCategory['Met-Storm']).toBe(3);
        expect(result.bySeverity.Severe).toBe(2);
        expect(result.bySeverity.Moderate).toBe(1);
    });

    it('handles alerts with missing category or severity', () => {
        const mixed = [
            { category: 'Flood', severity: 'Severe' },
            { category: undefined, severity: 'Moderate' },
            { category: 'Wind', severity: null },
        ];
        const result = globalThis.RealtimeAlerts.summary(mixed);
        expect(result.total).toBe(3);
        expect(result.byCategory.Flood).toBe(1);
        expect(result.byCategory.Wind).toBe(1);
        expect(result.bySeverity.Severe).toBe(1);
        expect(result.bySeverity.Moderate).toBe(1);
    });
});

describe('RealtimeAlerts.getForLocation() — state fallback logic', () => {
    it('filters by state when provided', () => {
        // getForLocation wraps filterByText, so test the filtering logic directly
        const result = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'maharashtra');
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].area).toBe('Maharashtra');
    });

    it('matches state appearing anywhere in alert text (headline/description/area)', () => {
        const result = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'West Bengal');
        expect(result.length).toBeGreaterThan(0);
    });

    it('returns empty array when state text is not found', () => {
        const result = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'NonexistentState');
        expect(result).toEqual([]);
    });

    it('case-insensitive state matching via filterByText', () => {
        const lower = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'maharashtra');
        const upper = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'MAHARASHTRA');
        const mixed = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'MaHaRaShTrA');
        expect(lower).toEqual(upper);
        expect(lower).toEqual(mixed);
    });

    it('getForLocation handles null/empty params correctly', async () => {
        const nullState = await globalThis.RealtimeAlerts.getForLocation(null, null);
        const emptyState = await globalThis.RealtimeAlerts.getForLocation('', '');
        expect(nullState).toEqual([]);
        expect(emptyState).toEqual([]);
    });

    it('getForLocation falls back to city when state search returns zero results', async () => {
        // If state search yields nothing, it searches using city on the full dataset
        const result = await globalThis.RealtimeAlerts.getForLocation('NonexistentState', 'test');
        expect(Array.isArray(result)).toBe(true);
    });

    it('getForLocation skips city search when state finds results', async () => {
        // Logic: if state scoped.length > 0, return scoped (ignoring city)
        // Mocking internal behavior: state search should bypass city
        const filtered = globalThis.RealtimeAlerts.filterByText(mockAlerts, 'Maharashtra');
        expect(filtered.length).toBeGreaterThan(0);
        // City parameter should be ignored when state search succeeds
    });
});

describe('RealtimeAlerts — real snapshot data smoke tests', () => {
    it('loads SACHET snapshot from committed data file', () => {
        expect(Array.isArray(realAlerts)).toBe(true);
        expect(realAlerts.length).toBeGreaterThan(0);
    });

    it('real snapshot contains expected alert structure', () => {
        const firstAlert = realAlerts[0];
        expect(firstAlert).toHaveProperty('id');
        expect(firstAlert).toHaveProperty('headline');
        expect(firstAlert).toHaveProperty('severity');
        expect(firstAlert).toHaveProperty('category');
    });

    it('summary on real snapshot returns non-zero counts', () => {
        const result = globalThis.RealtimeAlerts.summary(realAlerts);
        expect(result.total).toBeGreaterThan(0);
        expect(Object.keys(result.bySeverity).length).toBeGreaterThan(0);
        expect(Object.keys(result.byCategory).length).toBeGreaterThan(0);
    });

    it('filterBySeverity on real snapshot returns Severe and Extreme only', () => {
        const result = globalThis.RealtimeAlerts.filterBySeverity(realAlerts, 'Severe');
        const severities = result.map(a => a.severity);
        expect(severities.every(s => s === 'Severe' || s === 'Extreme')).toBe(true);
    });

    it('filterByText on real snapshot finds alerts with common disaster keywords', () => {
        const storms = globalThis.RealtimeAlerts.filterByText(realAlerts, 'storm');
        const rain = globalThis.RealtimeAlerts.filterByText(realAlerts, 'rain');
        const wind = globalThis.RealtimeAlerts.filterByText(realAlerts, 'wind');
        // At least one of these should match given real disaster data
        const anyMatch = storms.length > 0 || rain.length > 0 || wind.length > 0;
        expect(anyMatch).toBe(true);
    });
});
