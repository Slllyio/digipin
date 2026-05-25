/**
 * DigiPin encode/decode smoke tests
 *
 * Validates core functionality: encoding lat/lng to 10-char code,
 * decoding back with acceptable tolerance, round-trip accuracy.
 */

import { describe, it, expect } from 'vitest';

describe('DigiPin.encode()', () => {
  it('encodes Indore coordinates to a 10-char pin with dashes', () => {
    const pin = globalThis.DigiPin.encode(22.7196, 75.8577);
    expect(pin).toBeDefined();
    expect(pin.replace(/-/g, '')).toHaveLength(10);
    expect(pin).toMatch(/^[A-Z0-9-]+$/);
  });

  it('encodes different locations to different pins', () => {
    const indorePin = globalThis.DigiPin.encode(22.7196, 75.8577);
    const delhiPin = globalThis.DigiPin.encode(28.6139, 77.2090);
    expect(indorePin).not.toBe(delhiPin);
  });

  it('rejects coordinates outside India bounding box', () => {
    expect(() => globalThis.DigiPin.encode(2.0, 75.0)).toThrow();
    expect(() => globalThis.DigiPin.encode(39.0, 75.0)).toThrow();
    expect(() => globalThis.DigiPin.encode(22.0, 60.0)).toThrow();
    expect(() => globalThis.DigiPin.encode(22.0, 100.0)).toThrow();
  });
});

describe('DigiPin.decode()', () => {
  it('decodes pin to lat/lng object with bounds', () => {
    const pin = globalThis.DigiPin.encode(22.7196, 75.8577);
    const decoded = globalThis.DigiPin.decode(pin);

    expect(decoded.lat).toBeDefined();
    expect(decoded.lng).toBeDefined();
    expect(decoded.bounds).toBeDefined();
    expect(typeof decoded.lat).toBe('number');
    expect(typeof decoded.lng).toBe('number');
  });

  it('rejects invalid pins', () => {
    expect(() => globalThis.DigiPin.decode('ABC')).toThrow();
    expect(() => globalThis.DigiPin.decode('ABCDEFGHIJ')).toThrow();
  });
});

describe('DigiPin round-trip encode → decode', () => {
  const testCoords = [
    { lat: 22.7196, lng: 75.8577, name: 'Indore' },
    { lat: 28.6139, lng: 77.2090, name: 'Delhi' },
    { lat: 19.0760, lng: 72.8777, name: 'Mumbai' },
  ];

  testCoords.forEach(({ lat, lng, name }) => {
    it(`${name} round-trips within tolerance`, () => {
      const pin = globalThis.DigiPin.encode(lat, lng);
      const decoded = globalThis.DigiPin.decode(pin);

      expect(Math.abs(decoded.lat - lat)).toBeLessThan(0.01);
      expect(Math.abs(decoded.lng - lng)).toBeLessThan(0.01);
    });
  });
});
