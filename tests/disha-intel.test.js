import { describe, it, expect } from 'vitest';

// DishaIntel is exposed by tests/setup.js.
const D = globalThis.DishaIntel;
const CITIES = [
    { name: 'indore_pilot', label: 'Indore' }, { name: 'pune', label: 'Pune' },
    { name: 'delhi', label: 'Delhi' }, { name: 'bengaluru', label: 'Bengaluru' },
];

describe('DishaIntel.match()', () => {
    it('routes notable-here questions to insights', () => {
        expect(D.match("What's notable here?", CITIES)).toEqual({ type: 'insights' });
        expect(D.match('Any hotspots or anomalies in this area?', CITIES)).toEqual({ type: 'insights' });
    });
    it('routes what-if questions with their parameters', () => {
        expect(D.match('What if we add a park here?', CITIES)).toEqual({ type: 'whatif', scenario: 'park' });
        expect(D.match('What happens if we double the density?', CITIES)).toEqual({ type: 'whatif', scenario: 'density', factor: 2 });
        expect(D.match('simulate 3x population here', CITIES)).toEqual({ type: 'whatif', scenario: 'density', factor: 3 });
        expect(D.match('what if an extreme flood hits', CITIES)).toEqual({ type: 'whatif', scenario: 'flood', level: 'extreme' });
    });
    it('routes city comparisons and rankings', () => {
        expect(D.match('Compare Pune with Indore', CITIES)).toEqual({ type: 'compare', a: { city: 'pune' }, b: { city: 'indore_pilot' } });
        expect(D.match('Bangalore vs Delhi for families', CITIES)).toEqual({ type: 'compare', a: { city: 'bengaluru' }, b: { city: 'delhi' } });
        expect(D.match('Which city is best to live in?', CITIES)).toEqual({ type: 'dashboard' });
    });
    it('leaves ordinary questions to the model', () => {
        expect(D.match('Is this safe to live?', CITIES)).toBeNull();
        expect(D.match('Where should I open a restaurant?', CITIES)).toBeNull();
    });
});

describe('DishaIntel citations', () => {
    it('lists distinct tags in order', () => {
        expect(D.citeTags('flood [C2] and heat [C1], again [C2]')).toEqual(['C2', 'C1']);
    });
    it('turns tags into chips and lists what was cited', () => {
        const el = document.createElement('div');
        el.innerHTML = '<div>Flood risk is high [C1] and NO2 is rising [C9].</div>';
        const used = D.decorate(el, [{ tag: 'C1', id: 'scores', title: 'Intelligence scores', source: 'pipeline' }]);
        expect(used.map(c => c.tag)).toEqual(['C1']);
        expect(el.querySelectorAll('.disha-cite')).toHaveLength(1);
        expect(el.textContent).toContain('[C9]');   // unknown tags stay as text
        expect(el.querySelector('.disha-cite-sources').textContent).toMatch(/Intelligence scores/);
    });
});

describe('DishaIntel.match() → urban lenses', () => {
    const C = [{ name: 'pune', label: 'Pune' }, { name: 'delhi', label: 'Delhi' }];
    const M = (q) => globalThis.DishaIntel.match(q, C);
    it('routes combined-dataset questions to a lens', () => {
        expect(M('Who is most heat vulnerable in Delhi?')).toEqual({ type: 'lens', lens: 'heat', city: 'delhi' });
        expect(M('How many people live in the floodplain?')).toEqual({ type: 'lens', lens: 'flood' });
        expect(M('Is Pune a 15-minute city?')).toEqual({ type: 'lens', lens: 'fifteen', city: 'pune' });
        expect(M('Where are the healthcare deserts?')).toEqual({ type: 'lens', lens: 'health' });
        expect(M('Who gets cut off from hospitals in a flood?')).toEqual({ type: 'lens', lens: 'cutoff' });
        expect(M('Where does rainwater pool in Pune?')).toEqual({ type: 'lens', lens: 'waterlog', city: 'pune' });
        expect(M('which areas face waterlogging')).toEqual({ type: 'lens', lens: 'waterlog' });
        expect(M('How many people in Delhi live with road noise above the WHO limit?')).toEqual({ type: 'lens', lens: 'noise', city: 'delhi' });
        expect(M('which neighbourhoods are the noisiest')).toEqual({ type: 'lens', lens: 'noise' });
        expect(M('How long does it take to reach a hospital at rush hour in Delhi?')).toEqual({ type: 'lens', lens: 'ambulance', city: 'delhi' });
        expect(M('can an ambulance get through at 9 am')).toEqual({ type: 'lens', lens: 'ambulance' });
        expect(M('which schools sit beside jammed roads')).toEqual({ type: 'lens', lens: 'ambulance' });
        expect(M('where is healthcare access poor')).toEqual({ type: 'lens', lens: 'health' });
        expect(M('how many people in Delhi live within walking distance of a metro station')).toEqual({ type: 'lens', lens: 'metro', city: 'delhi' });
        expect(M('what happens to traffic in Delhi when it rains heavily in the evening?')).toEqual({ type: 'monsoonroads', level: 'severe', period: 'pm', city: 'delhi' });
        expect(M('which roads jam when the Yamuna floods')).toEqual({ type: 'monsoonroads', level: 'extreme', period: 'am' });
        expect(M('how many people live in the flood zone')).not.toEqual(expect.objectContaining({ type: 'monsoonroads' }));
        expect(M('is the walk to the metro shaded in Delhi?')).toEqual({ type: 'lens', lens: 'shade', city: 'delhi' });
        expect(M('which walking routes to school have no shade')).toEqual({ type: 'lens', lens: 'shade' });
        expect(M('which busy corridors have no frequent bus')).toEqual({ type: 'lens', lens: 'busgap' });
        expect(M('mobility scorecard')).toEqual({ type: 'mobilityscore' });
        expect(M('how much exhaust do children breathe on the walk to school')).toEqual({ type: 'lens', lens: 'cleanwalk' });
        expect(M('how many jobs can people reach within 45 minutes by metro')).toEqual({ type: 'lens', lens: 'jobaccess' });
        expect(M('job accessibility by public transport in Delhi')).toEqual({ type: 'lens', lens: 'jobaccess', city: 'delhi' });
        expect(M('which bus stops have no shade in the summer heat')).toEqual({ type: 'lens', lens: 'busheat' });
        expect(M('where should we add bus shelters')).toEqual({ type: 'lens', lens: 'busheat' });
        expect(M('where is last mile connectivity to the metro worst')).toEqual({ type: 'lens', lens: 'feeder' });
        expect(M('which neighbourhoods have the highest commuting carbon footprint')).toEqual({ type: 'lens', lens: 'commute' });
        expect(M('how many hours are lost to traffic jams every day')).toEqual({ type: 'lens', lens: 'jamcost' });
        expect(M('where should we densify around metro stations')).toEqual({ type: 'lens', lens: 'tod' });
        expect(M('which schools have traffic jams at drop-off time')).toEqual({ type: 'lens', lens: 'schoolrun' });
        expect(M('show school street candidates')).toEqual({ type: 'lens', lens: 'schoolrun' });
        expect(M('where is parking worst near markets')).toEqual({ type: 'lens', lens: 'parking' });
        expect(M('what are land values like in Delhi')).toEqual({ type: 'lens', lens: 'landvalue', city: 'delhi' });
        expect(M('which are the most expensive neighbourhoods')).toEqual({ type: 'lens', lens: 'landvalue' });
        expect(M('where is construction activity highest in Pune')).toEqual({ type: 'lens', lens: 'buildhot', city: 'pune' });
        expect(M('how much vacant land is there')).toEqual({ type: 'lens', lens: 'vacant' });
        expect(M('where is rental demand strongest')).toEqual({ type: 'lens', lens: 'rentdemand' });
        expect(M('who is at risk of displacement in Delhi')).toEqual({ type: 'lens', lens: 'affordability', city: 'delhi' });
        expect(M('which areas are undervalued')).toEqual({ type: 'lens', lens: 'undervalued' });
        expect(M('where should I invest in Delhi')).toEqual({ type: 'lens', lens: 'undervalued', city: 'delhi' });
        expect(M('where do trucks run through neighbourhoods in Pune')).toEqual({ type: 'lens', lens: 'freight', city: 'pune' });
        expect(M('what if 20% of car trips moved to the metro in Delhi')).toEqual({ type: 'modeshift', pct: 20, scope: 'stations', period: 'am', city: 'delhi' });
        expect(M('what if people take the bus instead of driving')).toEqual({ type: 'modeshift', pct: 10, scope: 'all', period: 'am' });
        expect(M('what if we add a bus lane on Outer Ring Road in Delhi')).toEqual({ type: 'buslane', road: 'Outer Ring Road', pct: 10, period: 'am', city: 'delhi' });
        expect(M('bus lane along MG Road with 20% switching')).toEqual({ type: 'buslane', road: 'MG Road', pct: 20, period: 'am' });
        expect(M('give Ring Road a bus lane')).toEqual({ type: 'buslane', road: 'Ring Road', pct: 10, period: 'am' });
        expect(M('where are pedestrian crossings missing in Delhi')).toEqual({ type: 'lens', lens: 'crossing', city: 'delhi' });
        expect(M('how far do people walk to cross the main road')).toEqual({ type: 'lens', lens: 'crossing' });
        expect(M('is the walk to the metro safe for women at night')).toEqual({ type: 'lens', lens: 'nightwalk' });
        expect(M('where do we need more street lights in Delhi')).toEqual({ type: 'lens', lens: 'nightwalk', city: 'delhi' });
        expect(M('can children cycle to school safely in Pune')).toEqual({ type: 'lens', lens: 'cycling', city: 'pune' });
        expect(M('where are the gaps in the bike lane network')).toEqual({ type: 'lens', lens: 'cycling' });
        expect(M('which city has the best public transport')).toEqual({ type: 'mobilityscore' });
        expect(M('how does Delhi rank on traffic across cities')).toEqual({ type: 'mobilityscore', city: 'delhi' });
        expect(M('rank the cities')).toEqual({ type: 'dashboard' });
        expect(M('which children have to cross busy roads to walk to school')).toEqual({ type: 'lens', lens: 'roadsafety' });
        expect(M('pedestrian safety near schools in Delhi')).toEqual({ type: 'lens', lens: 'roadsafety', city: 'delhi' });
        expect(M('how much tree shade is there on the walk to school')).toEqual({ type: 'lens', lens: 'shade' });
        expect(M('where should we add more buses in Delhi')).toEqual({ type: 'lens', lens: 'busgap', city: 'delhi' });
        expect(M('how is EV charging coverage in Delhi?')).toEqual({ type: 'lens', lens: 'ev', city: 'delhi' });
        expect(M('where should EV chargers go')).toEqual({ type: 'lens', lens: 'siting', preset: 'ev_charging' });
        expect(M('what if a new metro station opened here?')).toEqual({ type: 'stationwhatif', here: true });
        expect(M('where should the next metro station go in Pune')).toEqual({ type: 'stationwhatif', here: false, city: 'pune' });
        expect(M('how far is the nearest bus stop to walk to')).toEqual({ type: 'lens', lens: 'transit' });
        // Named-road what-ifs go to the road model; generic closures stay cell scenarios.
        expect(M('What if MG Road closes at 6 pm in Pune?')).toEqual({ type: 'roadwhatif', action: 'close', road: 'MG Road', period: 'pm', city: 'pune' });
        expect(M('close AB Road')).toEqual({ type: 'roadwhatif', action: 'close', road: 'AB Road', period: 'am' });
        expect(M('what happens if we widen the Outer Ring Road')).toEqual({ type: 'roadwhatif', action: 'widen', road: 'Outer Ring Road', period: 'am' });
        expect(M('what if we close a road here')).toEqual({ type: 'whatif', scenario: 'closure' });
        expect(M('Where are the traffic jams in Delhi?')).toEqual({ type: 'lens', lens: 'traffic', city: 'delhi' });
        expect(M('which roads are the worst bottlenecks at rush hour')).toEqual({ type: 'lens', lens: 'traffic' });
        expect(M('How many people can walk to a bus stop?')).toEqual({ type: 'lens', lens: 'transit' });
        expect(M('public transport access in Delhi')).toMatchObject({ type: 'lens', lens: 'transit' });
        expect(M('How many people breathe PM2.5 above the standard?')).toEqual({ type: 'lens', lens: 'air' });
        expect(M('What do night lights say about the economy?')).toEqual({ type: 'lens', lens: 'lights' });
        expect(M('Show me compound risk')).toEqual({ type: 'lens', lens: 'burden' });
        expect(M('Is Pune sprawling or growing by infill?')).toEqual({ type: 'lens', lens: 'sprawl', city: 'pune' });
        expect(M('How walkable is Delhi?')).toEqual({ type: 'lens', lens: 'walk', city: 'delhi' });
        expect(M('What kinds of neighbourhoods does Pune have?')).toEqual({ type: 'lens', lens: 'types', city: 'pune' });
        expect(M('Where should a new clinic go in Delhi?')).toEqual({ type: 'lens', lens: 'siting', preset: 'clinic', city: 'delhi' });
        expect(M('Where should we build a new park?')).toEqual({ type: 'lens', lens: 'siting', preset: 'park' });
        expect(M('Best locations for EV charging')).toEqual({ type: 'lens', lens: 'siting', preset: 'ev_charging' });
        expect(M('What is the rooftop solar potential of Pune?')).toEqual({ type: 'lens', lens: 'solar', city: 'pune' });
        expect(M('Does Delhi meet the 3-30-300 rule?')).toEqual({ type: 'lens', lens: 'green', city: 'delhi' });
        expect(M('How unequal is Delhi?')).toEqual({ type: 'lens', lens: null, city: 'delhi' });
    });
    it('leaves what-if floods and notable questions alone', () => {
        expect(M('What if a severe flood hits?').type).toBe('whatif');
        expect(M("What's notable here?")).toEqual({ type: 'insights' });
    });
});
