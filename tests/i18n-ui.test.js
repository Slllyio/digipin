import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

// Phrase-level translation of the rendered analysis dialogs (I18nUI + I18n.translateTree).
const I = globalThis.I18n;

beforeAll(() => {
    globalThis.I18nUI.register('hi', JSON.parse(readFileSync('data/i18n/hi-ui.json', 'utf8')));
});

describe('I18n.phrase', () => {
    it('translates exact phrases and keeps surrounding whitespace', () => {
        expect(I.phrase('Lenses', 'hi')).toBe('लेंस');
        expect(I.phrase('  Run agent ', 'hi')).toBe('  एजेंट चलाएँ ');
    });

    it('leaves unknown strings, city names and English mode alone', () => {
        expect(I.phrase('Indore', 'hi')).toBe('Indore');
        expect(I.phrase('BKJ-82M-4P2', 'hi')).toBe('BKJ-82M-4P2');
        expect(I.phrase('Lenses', 'en')).toBe('Lenses');
    });

    it('handles numbered and composed patterns', () => {
        expect(I.phrase('#12 of 13 cities', 'hi')).toBe('13 शहरों में #12');
        expect(I.phrase('Sources: Population (GHSL) · Night lights (VIIRS)', 'hi'))
            .toBe('स्रोत: जनसंख्या (GHSL) · रात की रोशनी (VIIRS)');
        expect(I.phrase('Show Green Index on the map', 'hi')).toBe('हरियाली सूचकांक मानचित्र पर दिखाएँ');
        expect(I.phrase('Leafy neighbourhood: greener, less built-up', 'hi')).toBe('हरा-भरा मोहल्ला: अधिक हरा, कम निर्मित');
        expect(I.phrase('Best at flood risk and education index; weakest at connectivity score.', 'hi'))
            .toBe('सबसे अच्छा: बाढ़ जोखिम, शिक्षा सूचकांक; सबसे कमज़ोर: कनेक्टिविटी स्कोर।');
    });

    it('keeps a leading emoji or symbol and trailing punctuation', () => {
        expect(I.phrase('➕ Add to plan', 'hi')).toBe('➕ योजना में जोड़ें');
        expect(I.phrase('Plan:', 'hi')).toBe('योजना:');
    });
});

describe('I18nUI.load', () => {
    it('resolves null when the table cannot be fetched', async () => {
        expect(await globalThis.I18nUI.load('xx')).toBe(null);
    });
});

describe('I18n.translateTree', () => {
    afterEach(() => { document.body.innerHTML = ''; try { localStorage.clear(); } catch { /* */ } });

    function panel() {
        const d = document.createElement('aside');
        d.className = 'ui-dialog';
        d.innerHTML = '<div class="ui-tabs"><button class="ui-tab">City</button><button class="ui-tab" title="Compare">Compare</button></div><p>Indore</p>';
        document.body.appendChild(d);
        return d;
    }

    it('swaps text and attributes to Hindi and back to English', () => {
        const d = panel();
        I.translateTree(d, 'hi');
        const [city, cmp] = d.querySelectorAll('.ui-tab');
        expect(city.textContent).toBe('शहर');
        expect(cmp.getAttribute('title')).toBe('तुलना');
        expect(d.querySelector('p').textContent).toBe('Indore');
        I.translateTree(d, 'en');
        expect(city.textContent).toBe('City');
        expect(cmp.getAttribute('title')).toBe('Compare');
    });

    it('treats a renderer rewrite as new English', () => {
        const d = panel();
        I.translateTree(d, 'hi');
        const tab = d.querySelector('.ui-tab');
        tab.firstChild.nodeValue = 'Here';
        I.translateTree(d, 'hi');
        expect(tab.textContent).toBe('यहाँ');
        I.translateTree(d, 'en');
        expect(tab.textContent).toBe('Here');
    });

    it('set() re-translates open dialogs', () => {
        const d = panel();
        I.set('hi');
        expect(d.querySelector('.ui-tab').textContent).toBe('शहर');
        I.set('en');
        expect(d.querySelector('.ui-tab').textContent).toBe('City');
    });
});

describe('I18n.phrase — lens findings', () => {
    it('translates a multi-sentence finding sentence by sentence', () => {
        const en = 'Night lights rise 0.43% for each 1% more residents (R² 0.4). 1928 cells glow well above their residents (activity hubs); 178 dense cells with 1.4 lakh people are under-lit for their size.';
        const hi = I.phrase(en, 'hi');
        expect(hi).toContain('0.43%');
        expect(hi).toContain('1.4 लाख');
        expect(hi).not.toMatch(/Night lights|cells glow/);
    });

    it('leaves a paragraph in English when any sentence is unknown', () => {
        const en = 'Night lights rise 0.43% for each 1% more residents (R² 0.4). Something nobody has translated yet.';
        expect(I.phrase(en, 'hi')).toBe(en);
    });

    it('translates sidebar queries and catalog field labels', () => {
        expect(I.phrase('Run query: Best Mall Location', 'hi')).toBe('क्वेरी चलाएँ: मॉल के लिए सबसे अच्छी जगह');
        expect(I.phrase('PM2.5, annual mean (2022)', 'hi')).toBe('PM2.5, वार्षिक औसत (2022)');
    });
});
