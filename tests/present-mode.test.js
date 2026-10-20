import { describe, it, expect } from 'vitest';

describe('PresentMode.parseFlag', () => {
    it('detects ?present=1', () => {
        expect(PresentMode.parseFlag('?present=1')).toBe(true);
    });
    it('treats a bare ?present as on, ?present=0 as off', () => {
        expect(PresentMode.parseFlag('?present')).toBe(true);
        expect(PresentMode.parseFlag('?present=0')).toBe(false);
    });
    it('is false when the flag is absent', () => {
        expect(PresentMode.parseFlag('')).toBe(false);
        expect(PresentMode.parseFlag('?cell=39J')).toBe(false);
    });
});
