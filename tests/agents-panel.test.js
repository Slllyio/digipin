import { describe, it, expect, beforeEach } from 'vitest';

// AgentsPanel, UrbanAgents, IntelBrief, URLState and DigiPin are exposed by tests/setup.js.
const P = globalThis.AgentsPanel;

const REPORT = {
    schema: 'digipin.agent-report/1', id: 'site-20261021070000', agent: 'site', title: 'Site suitability', icon: '◎',
    question: 'Where should this go?', ranAt: '2026-10-21T07:00:00.000Z',
    input: { agent: 'site', area: { code: '3MC88', label: 'Neighbourhood 3MC-88' }, params: { use: 'clinic' } },
    area: { kind: 'prefix', label: 'Neighbourhood 3MC-88' }, city: 'indore_pilot', cityLabel: 'Indore',
    summary: 'The best clinic site is 3MC-88C <script>.', metrics: [{ label: 'Cells scored', value: '16' }],
    findings: [{ kind: 'site', title: '#1 3MC-88C: 78.8/100', detail: 'Outside the floodplain.', cells: ['3MC88C'], sources: ['scores'] }],
    layers: [{ id: 'agent_site', title: 'Agent: Clinic suitability', field: 'suitability', unit: '0-100', runtime: true }],
    sources: [{ id: 'scores', title: 'Intelligence scores', license: 'ODbL' }], method: 'Weighted percentiles.', refs: '',
    steps: [{ tool: 'loadData', label: 'Load', status: 'done', result: '2209 cells', ms: 3 }],
};

describe('AgentsPanel share links', () => {
    it('round-trips agent, area and params through link params', () => {
        const kv = P.toParams(REPORT.input);
        expect(kv).toEqual([['ag', 'site'], ['aa', 'p:3MC88'], ['ap', 'use:clinic']]);
        const back = P.parseParams(new URLSearchParams(kv));
        expect(back.agent).toBe('site');
        expect(back.area.code).toBe('3MC88');
        expect(back.params).toEqual({ use: 'clinic' });
    });

    it('carries city and drawn areas, and drops unknown agents and junk params', () => {
        const city = P.parseParams(new URLSearchParams(P.toParams({ agent: 'heat', area: { city: 'indore_pilot' }, params: {} })));
        expect(city.area.city).toBe('indore_pilot');
        expect(P.parseParams(new URLSearchParams('ag=evil&aa=p:3MC88'))).toBeNull();
        const junk = P.parseParams(new URLSearchParams('ag=site&ap=use:clinic,x:<b>,:,bad'));
        expect(junk.params).toEqual({ use: 'clinic' });
    });

    it('travels inside URLState links', () => {
        const qs = globalThis.URLState.stringify({ agent: REPORT.input });
        expect(qs).toContain('ag=site');
        const st = globalThis.URLState.parse(`?${qs}`);
        expect(st.agent.agent).toBe('site');
        expect(st.agent.params.use).toBe('clinic');
    });
});

describe('AgentsPanel saved runs', () => {
    beforeEach(() => localStorage.clear());

    it('reads only well-formed reports and survives bad storage', () => {
        localStorage.setItem('digipin_agent_runs', JSON.stringify([REPORT, { schema: 'other' }, null]));
        expect(P.savedRuns().map(r => r.id)).toEqual([REPORT.id]);
        localStorage.setItem('digipin_agent_runs', '{not json');
        expect(P.savedRuns()).toEqual([]);
    });
});

describe('AgentsPanel printable report', () => {
    it('renders a self-contained, escaped HTML report with sources and the run log', () => {
        const html = P.toHTML(REPORT, 'https://example.org/app.html?ag=site');
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('Site suitability');
        expect(html).toContain('Intelligence scores');
        expect(html).toContain('3MC-88C');
        expect(html).toContain('2209 cells');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('href="https://example.org/app.html?ag=site"');
    });
});
