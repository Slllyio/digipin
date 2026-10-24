import { describe, it, expect } from 'vitest';

const LS = globalThis.LiveSearch;

const items = [
    { kind: 'aircraft', label: 'IGO6673', keys: ['IGO6673', 'VT-NHX', '8018a8'], id: '8018a8' },
    { kind: 'place', label: 'Red Fort', keys: ['Red Fort'], id: 1 },
    { kind: 'place', label: 'Fort Road', keys: ['Fort Road'], id: 2 },
    { kind: 'correlation', label: 'Heavy rain Sat: 92 mm', keys: ['Heavy rain Sat: 92 mm'] },
];

describe('LiveSearch.match()', () => {
    it('finds flights by callsign or registration, ignoring dashes and case', () => {
        expect(LS.match('igo6673', items).id).toBe('8018a8');
        expect(LS.match('VTNHX', items).id).toBe('8018a8');
        expect(LS.match('vt nhx', items).id).toBe('8018a8');
        expect(LS.match('vt-nhx', items).id).toBe('8018a8');
    });
    it('prefers exact, then prefix, then word prefix', () => {
        expect(LS.match('red fort', items).id).toBe(1);
        expect(LS.match('fort', items).id).toBe(2);       // prefix of "Fort Road" beats word in "Red Fort"
        expect(LS.match('rain', items).kind).toBe('correlation');
    });
    it('ignores one-letter queries and misses', () => {
        expect(LS.match('r', items)).toBeNull();
        expect(LS.match('qutub', items)).toBeNull();
        expect(LS.find('red fort')).toBeNull();          // no live layer is on in tests
    });
});
