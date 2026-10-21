/**
 * UrbanLenses — established urban-analytics methods that combine several
 * cell-store datasets into one interpretable reading per cell, a city summary
 * in people, an equity reading and a hotspot test. docs/ROADMAP_INSIGHTS.md.
 *
 *   frame(city)   every needed dataset aligned onto the population L7 grid
 *                 (coarser datasets broadcast from their parent cell, monthly
 *                 series read as the trailing-12 mean, like UrbanInsights)
 *   run(city)     every lens over that frame → { lenses[], layer }
 *   hotspots()    Getis-Ord Gi*, Local Moran's I (permutation test), Moran's I
 *   gini/lorenz   population-weighted inequality of any lens
 *
 * Pure apart from reading the store; runs in the browser, no build.
 * Depends on DigiPin and UrbanInsights (scalarColumn, cellsInRegion, cityLabel).
 */
const UrbanLenses = (() => {
    const SCHEMA = 'digipin.lenses/1';
    const LEVEL = 7;
    const BASE = 'population';
    const CELL_DEG = 36 / Math.pow(4, LEVEL);    // DIGIPIN spans 36°; 4×4 per level
    const KM_LAT = 110.57, KM_LNG = 111.32;
    const WALK_KM = 1.2;      // 15 min at 4.8 km/h
    const MIX_KM = 0.5;
    const CATCH_KM = 2;       // E2SFCA catchment
    const BAND_KM = 0.5;      // hotspot distance band (~12 neighbours at L7)
    const ESSENTIALS = ['food', 'shopping', 'healthcare', 'education', 'transport', 'leisure', 'finance'];
    const PM25_NAAQS = 40, PM25_WHO = 5;
    // NASA POWER all-sky surface shortwave (GHI) climatology 2001–2020, annual
    // mean kWh/m²/day at each city's grid centre (fetched 2026-10-21).
    const GHI = { ahmedabad: 5.53, bengaluru: 5.48, bhopal: 5.22, chennai: 5.22, delhi: 4.89, guna: 5.26, hyderabad: 5.36,
        indore_pilot: 5.25, jaipur: 5.44, kolkata: 4.57, lucknow: 4.88, mumbai: 5.29, pune: 5.13 };
    const ROOF_USABLE = 0.3;      // share of roof area usable for PV (tanks, stairs, shade, setbacks)
    const M2_PER_KWP = 10;        // MNRE rule of thumb: ~10 m² shade-free roof per kWp
    const PERF_RATIO = 0.75;
    const KWH_PER_CAPITA = 1395;  // CEA per-capita electricity consumption, 2023-24 (all sectors)
    const URBAN_PCT = 15;     // a cell counts as urban for the LEI at ≥ 15% built-up
    const SHED_KM = 1;
    const FLOOD_WADE_M = 0.3;   // floodwater above ~0.3 m knocks pedestrians over at modest velocity
    const FLOOD_SHARE = 50;     // % of the cell in the floodplain to treat it as impassable
    const FLOOD_DETOUR_M = 250;
    const WATERLOG_BLOCK = 65;  // waterlogging_index "Very high" class
    const WLOG_HIGH = 45, WLOG_VERY = 65;   // waterlogging index cut-offs for High / Very high (pipeline/cells/ee_layers.py)
    const ROAD_KM = 0.25, JAM_VC = 0.9;     // residents within 250 m (own or next cell) of an arterial at LOS E/F
    const CUTOFF_DOMAIN = ['Cut off from care', 'Longer walk to care', 'Flooded', 'Unaffected', 'No care in reach anyway'];
    const CUTOFF_COLORS = { 'Cut off from care': '#c0392b', 'Longer walk to care': '#f39c12', Flooded: '#2e86c1', Unaffected: '#cfd8dc', 'No care in reach anyway': '#8e8e8e' };
    const STOP_KM = 0.5, RAPID_KM = 1;   // SDG 11.2.1: 500 m to a bus stop, 1 km to rail / BRT / terminal
    const TRANSIT = 'osm_transit';       // vector points (data/vectors/osm_transit_<city>.geojson), binned per cell
    const RAPID_KINDS = new Set(['station', 'bus_station', 'subway_entrance', 'halt', 'tram_stop']);        // pedestrian-shed radius for route directness
    const WALK_LINKS = 'osm_walk.links';
    // Walk-link mask bit i = neighbour DIRS[i] as [dRow, dCol] (pipeline/cells/osm_layers.py).
    const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const LEED_JX = 54;       // LEED-ND connectivity bar: 140 intersections / sq mi ≈ 54 / km²

    // ── catalogue of lenses ─────────────────────────────────────────────────

    const LENSES = [
        { id: 'heat', equity: true, title: 'Heat vulnerability', icon: '🌡',
            question: 'Who suffers most in a heatwave?',
            field: { key: 'hvi', label: 'Heat vulnerability', unit: '0-100', higherIs: 'worse', ramp: 'reds' },
            needs: ['surface_heat.lst_day_c', 'surface_heat.modis_night_c', 'population.density_km2', 'built_up.built_pct',
                'vegetation.tree_canopy_pct', 'vegetation.ndvi', 'accessibility.healthcare_min', 'wealth.rwi',
                'demographics.under5', 'demographics.elderly_60plus', 'humid_heat.hot_days_40c', 'humid_heat.humid_heat_days'],
            method: 'HVI = exposure × sensitivity × (1 − adaptive capacity), each a within-city percentile rank. Exposure: day and night land-surface temperature. Sensitivity: population density and built-up share. Adaptive capacity: tree canopy, NDVI, travel time to healthcare (inverted) and household wealth (Meta Relative Wealth Index, ~2.4 km). Reported as a city percentile. Children under 5 and people 60+ in the worst tenth come from WorldPop; air-temperature heat days from ERA5-Land.',
            refs: 'IPCC AR5 vulnerability framing; Reid et al. 2009; Wolf & McGregor 2013; Chi et al. 2022 (RWI)' },
        { id: 'flood', title: 'Flood exposure', icon: '🌊',
            question: 'How many people live in the floodplain?',
            field: { key: 'flood_people', label: 'People in the 100-yr floodplain', unit: 'people', higherIs: 'worse', ramp: 'blues' },
            extra: [{ key: 'flood_hazard', label: 'Flood hazard', unit: '0-100', higherIs: 'worse', ramp: 'blues' }],
            needs: ['water.flood_rp100_pct', 'water.flood_rp100_depth_m', 'water.flood_rp10_pct', 'terrain.hand_m', 'built_up.built_pct', 'waterlogging.waterlogging_index'],
            method: 'Risk = hazard × exposure. Hazard: share of the cell in the GloFAS 100-year floodplain, scaled by depth (1 m or more counts fully), or, for rain that pools away from rivers, half the waterlogging susceptibility (Rain waterlogging layer; height above nearest drainage under 5 m where it is not baked). People exposed = residents × floodplain share.',
            refs: 'UNDRR Sendai risk framing; Nobre et al. 2011 (HAND)' },
        { id: 'cutoff', title: 'Cut off by floods', icon: '🛶',
            question: 'Who loses walking access to healthcare when the 100-year flood comes?',
            field: { key: 'flood_access', label: 'Healthcare access in a 100-year flood', type: 'category' },
            extra: [{ key: 'flood_detour_m', label: 'Extra walk to care in a flood', unit: 'm', higherIs: 'worse', ramp: 'reds' }],
            needs: ['water.flood_rp100_pct', 'water.flood_rp100_depth_m', 'waterlogging.waterlogging_index', 'osm_amenities.healthcare', WALK_LINKS],
            method: `Nearest mapped healthcare place within ${CATCH_KM} km on the walking network, today and with the 100-year flood: cells at least half inside the GloFAS 100-year floodplain with water at least ${FLOOD_WADE_M} m deep (too deep to wade safely), and cells whose monsoon waterlogging index is ${WATERLOG_BLOCK} or more (very high: hollows that pond after heavy rain), are removed from the graph, and their facilities with them. Residents are then “cut off” (care in reach today, none in a flood), “longer walk” (care still reachable, at least ${FLOOD_DETOUR_M} m further), “flooded” (their own cell is under water) or unaffected.`,
            refs: 'GloFAS / JRC flood hazard maps (Baugh et al. 2024); Russo et al. 2008 & Xia et al. 2014 on pedestrian stability in floodwater; Coles et al. 2017 (flood impacts on emergency service accessibility)' },
        { id: 'waterlog', equity: true, title: 'Rain waterlogging', icon: '🌧',
            question: 'Who lives where heavy rain pools?',
            field: { key: 'waterlog_people', label: 'Residents where rain pools', unit: 'people', higherIs: 'worse', ramp: 'blues' },
            extra: [{ key: 'waterlog_index', label: 'Waterlogging susceptibility', unit: '0-100', higherIs: 'worse', ramp: 'blues' }],
            equityKey: 'waterlog_index',
            needs: ['waterlogging.waterlogging_index', 'waterlogging.monsoon_water_pct', 'demographics.under5', 'demographics.elderly_60plus', 'wealth.rwi'],
            method: `Residents of cells whose waterlogging susceptibility is High (≥ ${WLOG_HIGH}) or Very high (≥ ${WLOG_VERY}). The index blends height above drainage, Sentinel-1 radar passes that saw standing water in the wet seasons 2021–2025, the topographic wetness index, hollows below the surrounding 300 m and sealed surface. Drains and pumps are not modelled. The poorest-fifth share uses the Meta Relative Wealth Index, population-weighted within the city.`,
            refs: 'Beven & Kirkby 1979 (TWI); Nobre et al. 2011 (HAND); Tiwari et al. 2020 (Sentinel-1 urban flood mapping); Chi et al. 2022 (RWI)' },
        { id: 'traffic', equity: true, title: 'Traffic load', icon: '🚦',
            question: 'Who lives next to roads that jam in the morning peak?',
            field: { key: 'traffic_vc', label: 'Worst peak-hour V/C within 250 m', unit: 'ratio', higherIs: 'worse', ramp: 'heat' },
            extra: [{ key: 'traffic_speed', label: 'Peak-hour arterial speed nearby', unit: 'km/h', higherIs: 'better', ramp: 'heat' }],
            needs: ['traffic_load.peak_vc', 'traffic_load.peak_speed_kmh', 'traffic_load.delay_pct', 'traffic_load.daily_vkm'],
            method: `Morning peak hour from the demand model (pipeline/traffic/demand_model.py): residents make motorised trips to jobs and activity floor space, distributed by a gravity model and routed on the OpenStreetMap arterials with BPR congestion feedback. For each home cell, the worst volume/capacity ratio on any arterial within ${ROAD_KM * 1000} m (its own or a neighbouring cell); at or above ${JAM_VC} is Level of Service E/F (at or over capacity). Speeds and delay are vehicle-km weighted. A strategic model with stated assumptions, not traffic counts.`,
            refs: 'Ortúzar & Willumsen, Modelling Transport (4-step model); BPR (1964) link performance; IRC 106-1990 urban road capacities; HCM LOS' },
        { id: 'fifteen', equity: true, title: '15-minute completeness', icon: '🚶',
            question: 'Can people reach daily needs on foot?',
            field: { key: 'fifteen_min', label: '15-minute completeness', unit: '0-100', higherIs: 'better', ramp: 'greens' },
            extra: [{ key: 'mix', label: 'Land-use mix (entropy)', unit: '0-100', higherIs: 'better', ramp: 'viridis' }],
            needs: [...ESSENTIALS.map(c => `osm_amenities.${c}`), WALK_LINKS],
            method: `Share of seven essentials (${ESSENTIALS.join(', ')}) with at least one place within ${WALK_KM} km (a 15-minute walk) along the OpenStreetMap walking network: Dijkstra over cell-to-cell street and footpath links, straight line only where no walking graph is baked. Land-use mix is the normalised Shannon entropy of the same categories within ${MIX_KM * 1000} m.`,
            refs: 'Moreno et al. 2021; Frank et al. 2006 (entropy mix)' },
        { id: 'health', equity: true, title: 'Healthcare access', icon: '🏥',
            question: 'Where is care scarce for the people who need it?',
            field: { key: 'health_access', label: 'Healthcare places per 10k in reach', unit: 'per 10k', higherIs: 'better', ramp: 'greens' },
            needs: ['osm_amenities.healthcare', WALK_LINKS],
            method: `Enhanced two-step floating catchment (E2SFCA): each facility’s supply is shared among the residents within ${CATCH_KM} km walking distance on the OpenStreetMap street and footpath network (straight line where no walking graph is baked) with Gaussian distance decay, then each cell sums the ratios it can reach. Facilities per 10 000 residents in reach.`,
            refs: 'Luo & Wang 2003; Luo & Qi 2009; Dai 2010' },
        { id: 'transit', equity: true, title: 'Public transport access', icon: '🚌',
            question: 'How many people can walk to a bus stop or station?',
            field: { key: 'transit_m', label: 'Walk to the nearest stop', unit: 'm', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'rapid_m', label: 'Walk to the nearest station or terminal', unit: 'm', higherIs: 'worse', ramp: 'reds' }],
            needs: [`${TRANSIT}.stops`, `${TRANSIT}.rapid`, WALK_LINKS],
            method: `UN SDG indicator 11.2.1: a resident has convenient access when a bus stop is within ${STOP_KM * 1000} m, or a rail, metro or BRT station or bus terminal within ${RAPID_KM} km, walking along the OpenStreetMap network (Dijkstra over the walking-graph cells; straight line where none is baked). Stops and stations are OpenStreetMap points. Distances are cell centre to cell centre, so anything in the same ~244 m cell counts as 0. Service frequency is not known without GTFS, so this measures coverage, not service quality.`,
            refs: 'UN-Habitat SDG 11.2.1 metadata (2018); TfL PTAL methodology (2015) for the 640 m / 960 m walk bands' },
        { id: 'air', title: 'Air pollution exposure', icon: '🌫',
            question: 'How many people breathe air above the standard?',
            field: { key: 'pm25', label: 'PM2.5 where people live', unit: 'µg/m³', higherIs: 'worse', ramp: 'heat' },
            needs: ['air_quality.pm25_ugm3', 'air_quality.no2_umol_m2'],
            method: `Population-weighted mean PM2.5 (the GBD/WHO exposure metric) and residents above India’s annual NAAQS (${PM25_NAAQS} µg/m³) and the WHO 2021 guideline (${PM25_WHO} µg/m³). Satellite/model data at ~1–10 km.`,
            refs: 'WHO AQG 2021; CPCB NAAQS 2009' },
        { id: 'lights', title: 'Night lights vs people', icon: '💡',
            question: 'Where is activity above or below what residents explain?',
            field: { key: 'ntl_resid', label: 'Lights vs residents (z)', unit: 'z', higherIs: null, ramp: 'diverging' },
            needs: ['nightlights.radiance'],
            method: 'OLS of ln(radiance + 0.1) on ln(population + 1) over populated cells; the standardised residual. Above +1: lit beyond its residents (commerce, industry, hubs). Below −1 in dense cells: under-lit for its population, a flag worth checking (energy poverty, informal housing), not a label.',
            refs: 'Henderson, Storeygard & Weil 2012; Chen & Nordhaus 2011' },
        { id: 'walk', title: 'Walkability index', icon: '👣', equity: true,
            question: 'Is the street fabric walkable, beyond counting shops?',
            field: { key: 'walk_index', label: 'Walkability index', unit: '0-100', higherIs: 'better', ramp: 'greens' },
            needs: ['osm_roads.junctions_km2', 'scores.walkability', WALK_LINKS],
            after: ['fifteen'],
            method: 'Frank et al. walkability index: 2 × z(connectivity) + z(residential density) + z(land-use mix), over the city’s populated cells, reported as a city percentile. Connectivity is intersection density, averaged with the pedestrian-shed ratio (area reachable within 1 km on the walking network ÷ the 1 km circle) where the OpenStreetMap walking graph is baked. Retail floor-area ratio, the fourth term, has no open data here. The correlation with the OSM-based walkability score says whether the two agree.',
            refs: 'Frank et al. 2010 (Br J Sports Med); Frank et al. 2006; Dill 2004 and Porta & Renne 2005 (pedestrian shed ratio)' },
        { id: 'sprawl', title: 'Sprawl and compactness', icon: '🏙',
            question: 'Is the city growing by infill, at its edge, or by leapfrogging?',
            field: { key: 'lei', label: 'Landscape expansion index (new built-up)', unit: '0-100', higherIs: null, ramp: 'viridis' },
            needs: ['growth.built_2016_pct', 'growth.built_2023_pct', 'nightlights.radiance'],
            method: `Landscape expansion index for every cell that gained ≥ 5 points of built-up cover 2016→2023: the share of the cells within 500 m that were already urban (≥ ${URBAN_PCT}% built-up) in 2016. ≥ 50 is infill, 2–50 edge expansion, below 2 outlying (leapfrog). Plus Clark’s density gradient (slope of ln density on distance from the night-lights peak, the CBD) and population-weighted density.`,
            refs: 'Liu et al. 2010 (LEI); Clark 1951; Craig 1984; Bertaud & Malpezzi 2003' },
        { id: 'types', title: 'Neighbourhood archetypes', icon: '🧩',
            question: 'What kinds of places make up this city?',
            field: { key: 'archetype', label: 'Neighbourhood archetype', type: 'category' },
            needs: ['built_up.built_pct', 'built_up.avg_height_m', 'vegetation.tree_canopy_pct', 'nightlights.radiance',
                'growth.built_2016_pct', 'growth.built_2023_pct', 'osm_roads.junctions_km2'],
            after: ['fifteen'],
            method: 'k-means (k-means++ seeding, fixed seed) on the urban fabric (cells at ≥ 1 500 people/km², the DEGURBA urban-centre density): standardised log density, built-up share, building height, land-use mix, tree canopy, log night lights, log junction density and 2016–2023 built-up gain ; k = 4–7 chosen by the mean silhouette of a sample. Each cluster is named from its centroid.',
            refs: 'MacQueen 1967; Arthur & Vassilvitskii 2007; Rousseeuw 1987; Stewart & Oke 2012 (Local Climate Zones, the climate analogue)' },
        { id: 'green', title: '3-30-300 green rule', icon: '🌳', equity: true,
            question: 'Does each neighbourhood meet the 3-30-300 rule?',
            field: { key: 'green_rules', label: '3-30-300 rules met (30 and 300)', unit: 'of 2', higherIs: 'better', ramp: 'greens' },
            extra: [{ key: 'canopy_500m', label: 'Tree canopy within 500 m', unit: '%', higherIs: 'better', ramp: 'greens' }],
            equityKey: 'canopy_500m',
            needs: ['vegetation.tree_canopy_pct', 'land_cover.tree_pct', 'land_cover.grass_pct', 'osm_amenities.leisure'],
            method: 'Konijnendijk’s 3-30-300 rule. 30: tree canopy averaged over 500 m around home is at least 30%. 300: a green space within 300 m (a cell at least 40% trees or grass, or a mapped leisure place). The "3 trees visible from home" part needs street-level imagery and is not measured.',
            refs: 'Konijnendijk 2021 (3-30-300); Browning et al. 2024' },
        { id: 'solar', title: 'Rooftop solar potential', icon: '☀',
            question: 'How much power could the city’s roofs make?',
            field: { key: 'solar_mwh', label: 'Rooftop solar potential', unit: 'MWh/yr', higherIs: 'better', ramp: 'heat' },
            needs: ['building_stock.cover_2023_pct', 'osm_roads.building_cover_pct'],
            method: `Roof area = building cover (Open Buildings 2023, else OSM) × cell area; ${ROOF_USABLE * 100}% usable; ${M2_PER_KWP} m² per kWp (MNRE); yield = kWp × NASA POWER annual irradiance × 365 × performance ratio ${PERF_RATIO}. Compared with ${KWH_PER_CAPITA.toLocaleString('en-IN')} kWh per resident per year (CEA 2023-24). Shading, roof slope and structure are ignored; the per-building sun-hours tool refines a site.`,
            refs: 'Gagnon et al. 2016 (NREL rooftop PV); MNRE rooftop guidelines; NASA POWER; CEA General Review 2024' },
        { id: 'confidence', title: 'Data confidence', icon: '🔎',
            question: 'How far can I trust the lenses here?',
            field: { key: 'confidence', label: 'Data confidence', unit: '0-100', higherIs: 'better', ramp: 'viridis' },
            extra: [{ key: 'osm_complete', label: 'OSM building completeness', unit: '%', higherIs: 'better', ramp: 'greens' }],
            needs: ['osm_roads.buildings', 'building_stock.buildings_2023'],
            method: 'Half OSM completeness (OSM buildings ÷ Open Buildings 2023 buildings in the cell, capped at 100%; amenity-based lenses inherit OSM’s gaps), half input coverage (share of the lens inputs with a value in the cell). Low confidence means read the 15-minute, healthcare and walkability lenses there as lower bounds.',
            refs: 'Barrington-Leigh & Millard-Ball 2017 (OSM completeness); Herfort et al. 2023' },
        { id: 'seasons', title: 'Seasonal exposure', icon: '📅',
            question: 'How many months a year are residents exposed?',
            field: { key: 'hot_months', label: 'Months with mean day surface ≥ 40 °C (last 12)', unit: 'months', higherIs: 'worse', ramp: 'reds' },
            extra: [{ key: 'pm_months', label: 'Months with PM2.5 > 60 µg/m³ (last 12)', unit: 'months', higherIs: 'worse', ramp: 'heat' }],
            needs: ['lst_monthly.lst_day_c@series', 'lst_monthly.lst_night_c@series', 'pm25_monthly.pm25_ugm3@series'],
            method: 'Monthly series per cell (MODIS land-surface temperature, CAMS PM2.5). For the last 12 months: months whose mean daytime surface temperature is ≥ 40 °C, and months whose mean PM2.5 exceeds 60 µg/m³ (India’s 24-hour standard, used as a monthly bar). Population-weighted city series give the worst month; warming compares the last 12 months with the 12 before, so seasons cancel.',
            refs: 'CPCB NAAQS 2009; Wan 2014 (MODIS LST); CAMS global reanalysis' },
        { id: 'burden', title: 'Compound risk', icon: '⚠',
            question: 'Where do heat, flood and dirty air stack up?',
            field: { key: 'burden', label: 'Hazards in the worst fifth', unit: 'of 3', higherIs: 'worse', ramp: 'reds' },
            needs: [],
            after: ['heat', 'flood', 'air'],
            method: 'Count of hazards (heat vulnerability, flood hazard, PM2.5) for which the cell is in its city’s worst 20%, among populated cells.',
            refs: 'Multi-hazard exposure (Cutter et al. 2003 hazards-of-place)' },
    ];
    const BY_ID = new Map(LENSES.map(l => [l.id, l]));

    // ── small maths ─────────────────────────────────────────────────────────

    const _fin = (x) => typeof x === 'number' && Number.isFinite(x);
    const _round = (x, d = 1) => (_fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
    const _num = (v) => (v == null || typeof v === 'boolean' || v === '' ? NaN : Number(v));

    /** Percentile rank 0..1 of each finite value among `idx` (ties averaged); NaN elsewhere. */
    function prank(values, idx) {
        const out = new Float64Array(values.length).fill(NaN);
        const xs = idx.filter(i => _fin(values[i])).sort((a, b) => values[a] - values[b]);
        const n = xs.length;
        if (!n) return out;
        for (let s = 0; s < n;) {
            let e = s;
            while (e + 1 < n && values[xs[e + 1]] === values[xs[s]]) e++;
            const r = n === 1 ? 0.5 : ((s + e) / 2) / (n - 1);
            for (let k = s; k <= e; k++) out[xs[k]] = r;
            s = e + 1;
        }
        return out;
    }

    function _meanOf(arrs, i) {
        let s = 0, n = 0;
        for (const a of arrs) if (a && _fin(a[i])) { s += a[i]; n++; }
        return n ? s / n : NaN;
    }

    /** Weighted mean of values over idx (NaNs skipped). */
    function wmean(values, weights, idx) {
        let s = 0, w = 0;
        for (const i of idx) {
            const v = values[i], wi = weights ? weights[i] : 1;
            if (!_fin(v) || !_fin(wi) || wi <= 0) continue;
            s += v * wi; w += wi;
        }
        return w ? s / w : null;
    }

    /** Weighted quantile (q in 0..1). */
    function wquantile(values, weights, idx, q) {
        const xs = idx.filter(i => _fin(values[i]) && (!weights || weights[i] > 0)).sort((a, b) => values[a] - values[b]);
        if (!xs.length) return null;
        const tot = xs.reduce((a, i) => a + (weights ? weights[i] : 1), 0);
        let cum = 0;
        for (const i of xs) {
            cum += weights ? weights[i] : 1;
            if (cum >= q * tot) return values[i];
        }
        return values[xs[xs.length - 1]];
    }

    /**
     * Population-weighted Gini (0 = equal, 1 = one cell has everything) via
     * the Lorenz trapezoid. Negative values are shifted to 0.
     */
    function gini(values, weights, idx) {
        const pts = lorenz(values, weights, idx, 0);
        if (!pts) return null;
        let area = 0;
        for (let k = 1; k < pts.length; k++) area += (pts[k][0] - pts[k - 1][0]) * (pts[k][1] + pts[k - 1][1]) / 2;
        return Math.max(0, Math.min(1, 1 - 2 * area));
    }

    /**
     * Lorenz curve: [[population share, value share]] from poorest to richest.
     * `n` > 0 samples it at n+1 even population steps (for sparklines).
     */
    function lorenz(values, weights, idx, n = 10) {
        const xs = (idx || values.map((_, i) => i)).filter(i => _fin(values[i]) && (!weights || weights[i] > 0))
            .sort((a, b) => values[a] - values[b]);
        if (xs.length < 2) return null;
        let W = 0, X = 0;
        for (const i of xs) { const w = weights ? weights[i] : 1; W += w; X += Math.max(0, values[i]) * w; }
        if (!(W > 0) || !(X > 0)) return null;
        const pts = [[0, 0]];
        let cw = 0, cx = 0;
        for (const i of xs) {
            const w = weights ? weights[i] : 1;
            cw += w; cx += Math.max(0, values[i]) * w;
            pts.push([cw / W, cx / X]);
        }
        if (!n) return pts;
        const out = [];
        for (let k = 0, j = 0; k <= n; k++) {
            const p = k / n;
            while (j < pts.length - 1 && pts[j + 1][0] < p) j++;
            const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
            const t = b[0] > a[0] ? (p - a[0]) / (b[0] - a[0]) : 0;
            out.push([_round(p, 2), _round(a[1] + Math.max(0, Math.min(1, t)) * (b[1] - a[1]), 3)]);
        }
        return out;
    }

    /** Palma-style ratio: weighted mean of the top 10% ÷ bottom 40%. */
    function palma(values, weights, idx) {
        const q40 = wquantile(values, weights, idx, 0.4), q90 = wquantile(values, weights, idx, 0.9);
        if (q40 == null || q90 == null) return null;
        const lo = wmean(values, weights, idx.filter(i => values[i] <= q40));
        const hi = wmean(values, weights, idx.filter(i => values[i] >= q90));
        return lo && lo > 0 ? hi / lo : null;
    }

    function _breathe() {
        return new Promise(res => {
            if (typeof scheduler !== 'undefined' && scheduler.yield) scheduler.yield().then(res, res);
            else setTimeout(res, 0);
        });
    }

    function _rng(seed) {
        let s = seed >>> 0 || 1;
        return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    }

    // ── the city frame ──────────────────────────────────────────────────────

    /**
     * A grid over `codes` (L7): row/col on the DIGIPIN lattice, km per step,
     * and an offsets-within-radius helper. Exported for tests.
     */
    function grid(codes) {
        const n = codes.length;
        const row = new Int32Array(n), col = new Int32Array(n), lat = new Float64Array(n), lng = new Float64Array(n);
        const at = new Map();
        let latSum = 0;
        for (let i = 0; i < n; i++) {
            const c = DigiPin.decodePartial(codes[i]);
            lat[i] = c.lat; lng[i] = c.lng; latSum += c.lat;
            row[i] = Math.floor((c.lat - 2.5) / CELL_DEG);
            col[i] = Math.floor((c.lng - 63.5) / CELL_DEG);
            at.set(row[i] * 1e6 + col[i], i);
        }
        const lat0 = n ? latSum / n : 20;
        const dy = CELL_DEG * KM_LAT, dx = CELL_DEG * KM_LNG * Math.cos(lat0 * Math.PI / 180);
        const _off = new Map();
        /** [[dRow, dCol, km]] within `km` (self included, at 0). */
        function offsets(km) {
            if (_off.has(km)) return _off.get(km);
            const out = [];
            const rr = Math.ceil(km / dy), rc = Math.ceil(km / dx);
            for (let a = -rr; a <= rr; a++) {
                for (let b = -rc; b <= rc; b++) {
                    const d = Math.hypot(a * dy, b * dx);
                    if (d <= km + 1e-9) out.push([a, b, d]);
                }
            }
            _off.set(km, out);
            return out;
        }
        /** Index of the cell at row+a, col+b, or -1. */
        function cellAt(i, a, b) {
            const j = at.get((row[i] + a) * 1e6 + (col[i] + b));
            return j == null ? -1 : j;
        }
        return { n, codes, row, col, lat, lng, dx, dy, cellKm2: dx * dy, offsets, cellAt };
    }

    /**
     * Walking distances on the cell graph. `links` is the per-cell 8-direction
     * mask from osm_walk; reach(i, km) runs Dijkstra from cell i (step cost =
     * the centre-to-centre distance) and returns { js, ds, len, net } with
     * buffers reused between calls. Cells without links fall back to the
     * straight-line disk (net = false). `blocked` cells (e.g. flooded) are
     * never entered; reach(i, km, stop) halts at the first cell where
     * stop(j) is true, so ds of the last entry is the nearest such cell.
     * Exported for tests.
     */
    function walkNet(g, links, blocked = null) {
        const has = !!links && links.some(v => v > 0);
        const step = DIRS.map(([a, b]) => Math.hypot(a * g.dy, b * g.dx));
        const dist = new Float64Array(g.n).fill(Infinity);
        let js = new Int32Array(64), ds = new Float64Array(64);
        let hd = new Float64Array(64), hj = new Int32Array(64);
        let tch = new Int32Array(64), tn = 0;   // cells whose dist was set, to reset after a search
        const touch = (k) => {
            if (tn === tch.length) { const t2 = new Int32Array(tn * 2); t2.set(tch); tch = t2; }
            tch[tn++] = k;
        };
        const euc = new Map();
        function euclid(i, km) {
            if (!euc.has(km)) euc.set(km, g.offsets(km));
            let len = 0;
            const off = euc.get(km);
            if (js.length < off.length) { js = new Int32Array(off.length * 2); ds = new Float64Array(off.length * 2); }
            for (const [a, b, d] of off) {
                const j = g.cellAt(i, a, b);
                if (j >= 0 && !(blocked && blocked[j] && j !== i)) { js[len] = j; ds[len++] = d; }
            }
            return { js, ds, len, net: false };
        }
        function reach(i, km, stop = null) {
            if (!has || !(links[i] > 0)) {
                const r = euclid(i, km);
                if (stop) {
                    // Offsets are not sorted by distance: keep only the nearest hit.
                    let best = -1;
                    for (let t = 0; t < r.len; t++) if (stop(r.js[t]) && (best < 0 || r.ds[t] < r.ds[best])) best = t;
                    if (best >= 0) { r.js[0] = r.js[best]; r.ds[0] = r.ds[best]; r.len = 1; } else r.len = 0;
                    r.hit = best >= 0;
                }
                return r;
            }
            let hn = 0, len = 0;
            const push = (d, j) => {
                if (hn === hd.length) {
                    const d2 = new Float64Array(hn * 2), j2 = new Int32Array(hn * 2);
                    d2.set(hd); j2.set(hj); hd = d2; hj = j2;
                }
                let k = hn++;
                while (k > 0) {
                    const p = (k - 1) >> 1;
                    if (hd[p] <= d) break;
                    hd[k] = hd[p]; hj[k] = hj[p]; k = p;
                }
                hd[k] = d; hj[k] = j;
            };
            const pop = () => {
                const d = hd[0], j = hj[0], ld = hd[--hn], lj = hj[hn];
                let k = 0;
                for (;;) {
                    let c = 2 * k + 1;
                    if (c >= hn) break;
                    if (c + 1 < hn && hd[c + 1] < hd[c]) c++;
                    if (hd[c] >= ld) break;
                    hd[k] = hd[c]; hj[k] = hj[c]; k = c;
                }
                hd[k] = ld; hj[k] = lj;
                return [d, j];
            };
            tn = 0;
            dist[i] = 0; touch(i); push(0, i);
            while (hn) {
                const [d, j] = pop();
                if (d > dist[j]) continue;
                if (len === js.length) {
                    const a2 = new Int32Array(len * 2), b2 = new Float64Array(len * 2);
                    a2.set(js); b2.set(ds); js = a2; ds = b2;
                }
                js[len] = j; ds[len++] = d;
                if (stop && stop(j)) { hn = 0; break; }
                const m = links[j];
                if (!(m > 0)) continue;
                for (let b = 0; b < 8; b++) {
                    if (!((m >> b) & 1)) continue;
                    const k = g.cellAt(j, DIRS[b][0], DIRS[b][1]);
                    if (k < 0 || (blocked && blocked[k])) continue;
                    const nd = d + step[b];
                    if (nd <= km + 1e-9 && nd < dist[k]) { if (dist[k] === Infinity) touch(k); dist[k] = nd; push(nd, k); }
                }
            }
            // Clear every touched cell (queued ones too, if the search stopped early).
            for (let q = 0; q < tn; q++) dist[tch[q]] = Infinity;
            const hit = !!stop && len > 0 && stop(js[len - 1]);
            return { js, ds, len, net: true, hit };
        }
        return { reach, has };
    }

    function _net(fr) {
        if (!fr._net) Object.defineProperty(fr, '_net', { value: walkNet(fr.grid, fr.cols[WALK_LINKS]), enumerable: false });
        return fr._net;
    }

    /** A frame from in-memory columns (tests, ingested data). */
    function frameFrom(codes, columns, opts = {}) {
        const g = grid(codes);
        const cols = {};
        for (const [k, v] of Object.entries(columns)) cols[k] = Float64Array.from(v, _num);
        return { city: opts.city || null, level: LEVEL, grid: g, cols, sources: opts.sources || [], missing: [] };
    }

    const _frames = new Map();   // `${city}|${needs}` -> Promise<frame>

    function _store(store) { return store || (typeof CellStore !== 'undefined' ? CellStore : null); }
    function _loadView(store, id, bbox) { return (bbox && store.loadView) ? store.loadView(id, bbox) : store.load(id); }

    function allNeeds(ids) {
        const set = new Set(['population.population', 'population.density_km2', ...SITING_NEEDS]);
        for (const id of ids) for (const k of (BY_ID.get(id) || {}).needs || []) set.add(k);
        return [...set];
    }

    /**
     * Every `needs` field ("dataset.field") for a city, on the population L7
     * cells. A coarser dataset reads its parent cell; counts ('sum' fields)
     * missing from a dataset that covers the city are 0, other gaps NaN.
     */
    async function frame(city, store, needs) {
        store = _store(store);
        if (!store) throw new Error('The cell store is not available.');
        needs = needs || allNeeds(LENSES.map(l => l.id));
        const key = `${city}|${needs.slice().sort().join(',')}`;
        if (_frames.has(key)) return _frames.get(key);
        const p = (async () => {
            const popSpec = store.get(BASE);
            const region = popSpec && (popSpec.regions || []).find(r => r.name === city);
            if (!region) throw new Error(`No population grid for ${UrbanInsights.cityLabel(city)}.`);
            const bbox = region.bbox;
            const popT = await _loadView(store, BASE, bbox);
            if (!popT) throw new Error('The population grid did not load.');
            const idx = UrbanInsights.cellsInRegion(popSpec, popT, city);
            const codes = idx.map(i => String(popT.cells[i]).replace(/-/g, '')).filter(c => c.length === LEVEL);
            const g = grid(codes);
            const cols = {}, sources = [], missing = [], steps = {};
            const byDs = new Map();
            for (const nd of needs) {
                const [ds, f] = nd.split('.');
                if (!byDs.has(ds)) byDs.set(ds, []);
                byDs.get(ds).push(f);
            }
            for (const [ds, fields] of byDs) {
                if (ds === TRANSIT) {
                    const t = await _transitCols(city, g);
                    if (!t) { fields.forEach(f => missing.push(`${ds}.${f}`)); continue; }
                    for (const f of fields) cols[`${ds}.${f}`] = t[f];
                    sources.push({ id: TRANSIT, title: 'Transit stops and stations (OpenStreetMap)', source: `data/vectors/osm_transit_${city}.geojson`,
                        license: 'ODbL (© OpenStreetMap contributors)', level: null, approxCellM: null, generated: null, period: null, local: false });
                    continue;
                }
                const spec = store.get(ds);
                const covers = spec && (spec.regions || []).some(r => r.name === city || (r.bbox && bbox && r.bbox.west <= bbox.east && r.bbox.east >= bbox.west && r.bbox.south <= bbox.north && r.bbox.north >= bbox.south));
                const table = covers ? await _loadView(store, ds, bbox).catch(() => null) : null;
                if (!spec || !table || !table.cells || !table.cells.length || table.level > LEVEL) {
                    fields.forEach(f => missing.push(`${ds}.${f}`));
                    continue;
                }
                if (!table.index) { table.index = new Map(); table.cells.forEach((c, i) => table.index.set(c, i)); }
                const lv = table.level;
                const rowOf = new Int32Array(g.n);
                for (let i = 0; i < g.n; i++) {
                    const j = table.index.get(codes[i].slice(0, lv));
                    rowOf[i] = j == null ? -1 : j;
                }
                let used = false;
                for (const f of fields) {
                    // 'field@series' keeps a temporal field's per-cell arrays.
                    if (f.endsWith('@series')) {
                        const k = f.slice(0, -7);
                        const col = table.columns && table.columns[k];
                        if (!col || !spec.time) { missing.push(`${ds}.${f}`); continue; }
                        const out = new Array(g.n);
                        let any = 0;
                        for (let i = 0; i < g.n; i++) {
                            const a = rowOf[i] < 0 ? null : col[rowOf[i]];
                            out[i] = Array.isArray(a) ? a : null;
                            if (out[i]) any++;
                        }
                        if (!any) { missing.push(`${ds}.${f}`); continue; }
                        cols[`${ds}.${f}`] = out;
                        steps[ds] = spec.time.steps;
                        used = true;
                        continue;
                    }
                    const meta = spec.fields.find(x => x.key === f);
                    if (!meta) { missing.push(`${ds}.${f}`); continue; }
                    const src = UrbanInsights.scalarColumn(spec, table, f);
                    const zero = meta.agg === 'sum' || meta.agg === 'count';
                    const out = new Float64Array(g.n);
                    let any = 0;
                    for (let i = 0; i < g.n; i++) {
                        const v = rowOf[i] < 0 ? NaN : _num(src[rowOf[i]]);
                        out[i] = _fin(v) ? v : (zero ? 0 : NaN);
                        if (_fin(v)) any++;
                    }
                    if (!any) { missing.push(`${ds}.${f}`); continue; }
                    cols[`${ds}.${f}`] = out;
                    used = true;
                }
                if (used) sources.push(UrbanInsights.sourceOf(spec, store));
            }
            return { city, level: LEVEL, grid: g, cols, steps, sources, missing };
        })();
        _frames.set(key, p);
        p.catch(() => _frames.delete(key));
        if (_frames.size > 6) _frames.delete(_frames.keys().next().value);
        return p;
    }

    /** Bus stops / rapid-transit points per frame cell from the city's OSM transit vector, or null. */
    async function _transitCols(city, g) {
        if (typeof fetch !== 'function') return null;
        let gj;
        try {
            const r = await fetch(`data/vectors/osm_transit_${city}.geojson`);
            if (!r.ok) return null;
            gj = await r.json();
        } catch { return null; }
        const stops = new Float64Array(g.n), rapid = new Float64Array(g.n);
        const at = new Map();
        for (let i = 0; i < g.n; i++) at.set(g.row[i] * 1e6 + g.col[i], i);
        let any = 0;
        for (const f of (gj && gj.features) || []) {
            const c = f.geometry && f.geometry.type === 'Point' && f.geometry.coordinates;
            if (!c) continue;
            const i = at.get(Math.floor((c[1] - 2.5) / CELL_DEG) * 1e6 + Math.floor((c[0] - 63.5) / CELL_DEG));
            if (i == null) continue;
            if (RAPID_KINDS.has((f.properties || {}).kind)) rapid[i]++; else stops[i]++;
            any++;
        }
        return any ? { stops, rapid } : null;
    }

    function _residents(fr) {
        const pop = fr.cols['population.population'];
        const idx = [];
        for (let i = 0; i < fr.grid.n; i++) if (pop && pop[i] >= 1) idx.push(i);
        return idx;
    }

    function _people(n) {
        if (!_fin(n)) return '–';
        if (n >= 1e7) return `${_round(n / 1e7, 1)} crore`;
        if (n >= 1e5) return `${_round(n / 1e5, 1)} lakh`;
        return Math.round(n).toLocaleString('en-IN');
    }

    function _sumOver(values, idx, pred) {
        let s = 0;
        for (const i of idx) if (pred(i)) s += values[i];
        return s;
    }

    // ── the lenses ──────────────────────────────────────────────────────────

    function heat(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const R = (k, invert) => {
            if (!c[k]) return null;
            const v = invert ? c[k].map(x => -x) : c[k];
            return prank(v, idx);
        };
        const E = [R('surface_heat.lst_day_c'), R('surface_heat.modis_night_c')];
        const S = [R('population.density_km2'), R('built_up.built_pct')];
        const A = [R('vegetation.tree_canopy_pct'), R('vegetation.ndvi'), R('accessibility.healthcare_min', true), R('wealth.rwi')];
        if (!E.some(Boolean) || !S.some(Boolean)) return null;
        const raw = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            const e = _meanOf(E, i), s = _meanOf(S, i);
            let a = _meanOf(A, i);
            if (!_fin(e) || !_fin(s)) continue;
            if (!_fin(a)) a = 0.5;
            raw[i] = e * s * (1 - a);
        }
        const hvi = prank(raw, idx).map(x => (_fin(x) ? x * 100 : NaN));
        const pop = c['population.population'];
        const total = _sumOver(pop, idx, () => true);
        const top = idx.filter(i => hvi[i] >= 90);
        const topPeople = _sumOver(pop, top, () => true);
        const day = c['surface_heat.lst_day_c'], canopy = c['vegetation.tree_canopy_pct'];
        const dayTop = day ? wmean(day, pop, top) : null, dayAll = day ? wmean(day, pop, idx) : null;
        const canTop = canopy ? wmean(canopy, pop, top) : null, canAll = canopy ? wmean(canopy, pop, idx) : null;
        const stats = [
            { label: 'People in the most vulnerable tenth', value: _people(topPeople), raw: Math.round(topPeople) },
            { label: 'Daytime surface temp there vs city', value: dayTop != null ? `${_round(dayTop)} vs ${_round(dayAll)} °C` : '–' },
            { label: 'Tree canopy there vs city', value: canTop != null ? `${_round(canTop)}% vs ${_round(canAll)}%` : '–' },
        ];
        const u5 = c['demographics.under5'], old = c['demographics.elderly_60plus'];
        if (u5 && old) {
            stats.push({ label: 'Children under 5 / people 60+ in that tenth (WorldPop)',
                value: `${_people(_sumOver(u5, top, () => true))} / ${_people(_sumOver(old, top, () => true))}` });
        }
        const hot40 = c['humid_heat.hot_days_40c'], humid = c['humid_heat.humid_heat_days'];
        if (hot40) {
            const hd = wmean(hot40, pop, idx), hu = humid ? wmean(humid, pop, idx) : null;
            stats.push({ label: 'Air-temperature days ≥ 40 °C per resident (ERA5-Land)',
                value: `${_round(hd, 0)}${hu != null ? ` · humid-heat days ${_round(hu, 0)}` : ''}` });
        }
        return {
            columns: { hvi }, idx,
            metric: { label: 'Daytime surface temperature per resident', value: _round(dayAll), unit: '°C', higherIs: 'worse' },
            headline: `${_people(topPeople)} people (${_round(100 * topPeople / (total || 1))}% of residents) live in the city’s most heat-vulnerable tenth of neighbourhoods`
                + (dayTop != null ? `, where surfaces run ${_round(Math.abs(dayTop - dayAll))} °C ${dayTop >= dayAll ? 'hotter' : 'cooler'} by day` : '')
                + (canTop != null ? ` and tree canopy is ${_round(canTop)}% against ${_round(canAll)}% city-wide.` : '.'),
            stats,
        };
    }

    function flood(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const rp100 = c['water.flood_rp100_pct'], depth = c['water.flood_rp100_depth_m'], rp10 = c['water.flood_rp10_pct'];
        const hand = c['terrain.hand_m'], built = c['built_up.built_pct'], pop = c['population.population'];
        const wlog = c['waterlogging.waterlogging_index'];
        if (!rp100 && !hand && !wlog) return null;
        const hazard = new Float64Array(n).fill(NaN), people = new Float64Array(n).fill(NaN);
        let p100 = 0, p10 = 0, builtKm2 = 0;
        for (let i = 0; i < n; i++) {
            const share = rp100 && _fin(rp100[i]) ? Math.max(0, Math.min(1, rp100[i] / 100)) : 0;
            const d = depth && _fin(depth[i]) ? Math.min(1, Math.max(0.25, depth[i])) : 1;
            const fluvial = share * d;
            const pluvial = wlog && _fin(wlog[i]) ? 0.5 * Math.min(1, Math.max(0, wlog[i]) / 100)
                : hand && _fin(hand[i]) && hand[i] < 5 ? 0.5 * (1 - Math.max(0, hand[i]) / 5) : 0;
            hazard[i] = 100 * Math.max(fluvial, pluvial);
            const pp = pop && pop[i] > 0 ? pop[i] : 0;
            people[i] = pp * share;
            p100 += pp * share;
            if (rp10 && _fin(rp10[i])) p10 += pp * Math.max(0, Math.min(1, rp10[i] / 100));
            if (built && _fin(built[i])) builtKm2 += (built[i] / 100) * share * fr.grid.cellKm2;
        }
        const total = _sumOver(pop, idx, () => true);
        const ponding = hand ? _sumOver(pop, idx, i => hand[i] < 2) : null;
        const pooled = wlog ? _sumOver(pop, idx, i => wlog[i] >= WLOG_HIGH) : null;
        return {
            columns: { flood_people: people, flood_hazard: hazard }, idx, weightKey: 'flood_hazard',
            metric: { label: 'Residents in the 100-year floodplain', value: _round(100 * p100 / (total || 1)), unit: '%', higherIs: 'worse' },
            headline: `${_people(p100)} people (${_round(100 * p100 / (total || 1))}% of residents) live in the 100-year floodplain`
                + (rp10 ? `, ${_people(p10)} of them where floods come about once a decade` : '') + '.',
            stats: [
                { label: 'People in the 100-year floodplain', value: _people(p100), raw: Math.round(p100) },
                { label: 'People in the 10-year floodplain', value: rp10 ? _people(p10) : '–', raw: Math.round(p10) },
                { label: 'Built-up land in the floodplain', value: `${_round(builtKm2, 2)} km²` },
                { label: 'People near drainage level (HAND < 2 m, waterlogging-prone)', value: ponding != null ? _people(ponding) : '–' },
                ...(pooled != null ? [{ label: 'People where rain pools (waterlogging High or Very high)', value: _people(pooled), raw: Math.round(pooled) }] : []),
            ],
        };
    }

    function waterlog(fr) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const wl = c['waterlogging.waterlogging_index'], seen = c['waterlogging.monsoon_water_pct'];
        const pop = c['population.population'];
        if (!wl) return null;
        const people = new Float64Array(n).fill(NaN), index = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            if (!_fin(wl[i])) continue;
            index[i] = wl[i];
            people[i] = wl[i] >= WLOG_HIGH ? pop[i] : 0;
        }
        const total = _sumOver(pop, idx, () => true) || 1;
        const high = idx.filter(i => wl[i] >= WLOG_HIGH), very = idx.filter(i => wl[i] >= WLOG_VERY);
        const pHigh = _sumOver(pop, high, () => true), pVery = _sumOver(pop, very, () => true);
        const stats = [
            { label: 'Residents where rain pools (High or Very high)', value: `${_people(pHigh)} (${_round(100 * pHigh / total)}%)`, raw: Math.round(pHigh) },
            { label: 'Of them in Very high cells', value: _people(pVery), raw: Math.round(pVery) },
        ];
        if (seen) {
            const sHigh = wmean(seen, pop, high), sAll = wmean(seen, pop, idx);
            if (sHigh != null) stats.push({ label: 'Radar passes that saw standing water there vs city', value: `${_round(sHigh)}% vs ${_round(sAll)}%` });
        }
        const u5 = c['demographics.under5'], old = c['demographics.elderly_60plus'];
        if (u5 && old) stats.push({ label: 'Children under 5 / people 60+ there (WorldPop)', value: `${_people(_sumOver(u5, high, () => true))} / ${_people(_sumOver(old, high, () => true))}` });
        let poorShare = null;
        const rwi = c['wealth.rwi'];
        if (rwi && pHigh > 0) {
            const q20 = wquantile(rwi, pop, idx, 0.2);
            if (q20 != null) {
                poorShare = 100 * _sumOver(pop, high, i => rwi[i] <= q20) / pHigh;
                stats.push({ label: 'Share of them in the poorest fifth (RWI; 20% if even)', value: `${_round(poorShare)}%` });
            }
        }
        return {
            columns: { waterlog_people: people, waterlog_index: index }, idx, weightKey: 'waterlog_index',
            metric: { label: 'Residents where rain pools', value: _round(100 * pHigh / total), unit: '%', higherIs: 'worse' },
            headline: `${_people(pHigh)} people (${_round(100 * pHigh / total)}% of residents) live where heavy rain is likely to pool`
                + (pVery ? `, ${_people(pVery)} of them in the most waterlogging-prone cells` : '')
                + (poorShare != null ? `; ${_round(poorShare)}% of them are in the city’s poorest fifth of neighbourhoods.` : '.'),
            stats,
        };
    }

    function traffic(fr) {
        const c = fr.cols, g = fr.grid, idx = _residents(fr), n = g.n;
        const vc = c['traffic_load.peak_vc'], sp = c['traffic_load.peak_speed_kmh'];
        const delay = c['traffic_load.delay_pct'], vkm = c['traffic_load.daily_vkm'];
        const pop = c['population.population'];
        if (!vc) return null;
        const near = new Float64Array(n).fill(NaN), speed = new Float64Array(n).fill(NaN);
        const off = g.offsets(ROAD_KM);
        for (const i of idx) {
            let worst = -1, sSum = 0, sW = 0;
            for (const [a, b] of off) {
                const j = g.cellAt(i, a, b);
                if (j < 0 || !_fin(vc[j])) continue;
                if (vc[j] > worst) worst = vc[j];
                if (sp && _fin(sp[j])) { const w = vkm && vkm[j] > 0 ? vkm[j] : 1; sSum += sp[j] * w; sW += w; }
            }
            if (worst >= 0) near[i] = worst;
            if (sW) speed[i] = sSum / sW;
        }
        const total = _sumOver(pop, idx, () => true) || 1;
        const jam = _sumOver(pop, idx, i => near[i] >= JAM_VC);
        const nearRoad = _sumOver(pop, idx, i => _fin(near[i]));
        const all = [];
        for (let i = 0; i < n; i++) if (_fin(vc[i])) all.push(i);
        const vSpeed = sp ? wmean(sp, vkm, all) : null, vDelay = delay ? wmean(delay, vkm, all) : null;
        let km = 0;
        if (vkm) for (const i of all) km += vkm[i] > 0 ? vkm[i] : 0;
        const stats = [
            { label: 'Residents within 250 m of an arterial at LOS E/F', value: `${_people(jam)} (${_round(100 * jam / total)}%)`, raw: Math.round(jam) },
            { label: 'Residents within 250 m of any modelled arterial', value: `${_people(nearRoad)} (${_round(100 * nearRoad / total)}%)` },
        ];
        if (vSpeed != null) stats.push({ label: 'Average peak-hour arterial speed (per vehicle-km)', value: `${_round(vSpeed)} km/h` });
        if (vDelay != null) stats.push({ label: 'Peak-hour delay over free flow (per vehicle-km)', value: `+${_round(vDelay)}% (${_round(1 + vDelay / 100, 1)}× the time)` });
        if (km) stats.push({ label: 'Vehicle-km on arterials per day (PCU)', value: `${_people(km)} km` });
        return {
            columns: { traffic_vc: near, traffic_speed: speed }, idx, weightKey: 'traffic_vc',
            metric: { label: 'Residents beside a jammed arterial', value: _round(100 * jam / total), unit: '%', higherIs: 'worse' },
            headline: `${_people(jam)} people (${_round(100 * jam / total)}% of residents) live within 250 m of an arterial that runs at or over capacity in the morning peak`
                + (vSpeed != null ? `; arterial traffic averages ${_round(vSpeed)} km/h` : '')
                + (vDelay != null ? ` and a peak trip on them takes ${_round(1 + vDelay / 100, 1)}× its free-flow time.` : '.'),
            stats,
        };
    }

    function cutoff(fr) {
        const c = fr.cols, g = fr.grid, idx = _residents(fr), n = g.n;
        const rp = c['water.flood_rp100_pct'], depth = c['water.flood_rp100_depth_m'], care = c['osm_amenities.healthcare'];
        const pop = c['population.population'], wl = c['waterlogging.waterlogging_index'];
        if ((!rp && !wl) || !care) return null;
        const wet = new Uint8Array(n);
        let nWet = 0, nLog = 0, wetCare = 0, allCare = 0;
        for (let i = 0; i < n; i++) {
            const deep = !depth || !_fin(depth[i]) || depth[i] >= FLOOD_WADE_M;
            const river = !!rp && _fin(rp[i]) && rp[i] >= FLOOD_SHARE && deep;
            const ponds = !!wl && _fin(wl[i]) && wl[i] >= WATERLOG_BLOCK;
            if (river || ponds) { wet[i] = 1; nWet++; if (!river) nLog++; if (care[i] > 0) wetCare += care[i]; }
            if (care[i] > 0) allCare += care[i];
        }
        if (!nWet) return null;
        const links = c[WALK_LINKS];
        const dry = _net(fr), flooded = walkNet(g, links, wet);
        const hasCare = j => care[j] > 0, hasDryCare = j => care[j] > 0 && !wet[j];
        const cls = new Float64Array(n).fill(NaN), detour = new Float64Array(n).fill(NaN);
        const sum = new Float64Array(CUTOFF_DOMAIN.length);
        for (const i of idx) {
            const a = dry.reach(i, CATCH_KM, hasCare);
            const d0 = a.hit ? a.ds[a.len - 1] : Infinity;
            let k;
            if (wet[i]) k = 2;
            else if (!_fin(d0)) k = 4;
            else {
                const b = flooded.reach(i, CATCH_KM, hasDryCare);
                const d1 = b.hit ? b.ds[b.len - 1] : Infinity;
                if (!_fin(d1)) k = 0;
                else {
                    detour[i] = 1000 * (d1 - d0);
                    k = detour[i] >= FLOOD_DETOUR_M - 1e-6 ? 1 : 3;
                }
            }
            cls[i] = k;
            sum[k] += pop[i];
        }
        const total = _sumOver(pop, idx, () => true);
        const pct = v => _round(100 * v / (total || 1), 1);
        return {
            columns: { flood_access: cls, flood_detour_m: detour }, idx, weightKey: 'flood_detour_m',
            categories: { flood_access: { domain: CUTOFF_DOMAIN, colors: CUTOFF_COLORS } },
            metric: { label: 'Residents cut off from healthcare in a 100-year flood', value: pct(sum[0]), unit: '%', higherIs: 'worse' },
            headline: `In a 100-year flood ${_people(sum[0])} people (${pct(sum[0])}%) would lose walking access to every mapped healthcare place within ${CATCH_KM} km, `
                + `${_people(sum[1])} more face a longer walk, and ${_people(sum[2])} live where the water itself is too deep to wade; `
                + `${Math.round(wetCare)} of ${Math.round(allCare)} healthcare places sit in deep floodwater.`,
            stats: [
                { label: 'Cut off from care', value: _people(sum[0]), raw: Math.round(sum[0]) },
                { label: `Longer walk to care (≥ ${FLOOD_DETOUR_M} m more)`, value: _people(sum[1]), raw: Math.round(sum[1]) },
                { label: 'Living in deep floodwater', value: _people(sum[2]), raw: Math.round(sum[2]) },
                { label: 'Healthcare places in deep floodwater', value: `${Math.round(wetCare)} of ${Math.round(allCare)}` },
                { label: 'Impassable cells (of which waterlogging only)', value: `${nWet.toLocaleString('en-IN')} (${_round(nWet * g.cellKm2, 1)} km²; ${nLog.toLocaleString('en-IN')} waterlogging)` },
            ],
        };
    }

    function fifteen(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr);
        const cats = ESSENTIALS.filter(k => c[`osm_amenities.${k}`]);
        if (cats.length < 3) return null;
        const has = cats.map(k => c[`osm_amenities.${k}`]);
        const near = g.offsets(MIX_KM), net = _net(fr);
        let onNet = 0;
        const score = new Float64Array(n), mix = new Float64Array(n);
        const missCount = new Float64Array(cats.length);
        const pop = c['population.population'];
        const isRes = new Uint8Array(n);
        for (const i of idx) isRes[i] = 1;
        const cnt = new Float64Array(cats.length);
        for (let i = 0; i < n; i++) {
            let k = 0;
            const r = net.reach(i, WALK_KM);
            if (r.net && isRes[i]) onNet += pop[i];
            for (let q = 0; q < cats.length; q++) {
                let found = false;
                for (let t = 0; t < r.len; t++) if (has[q][r.js[t]] > 0) { found = true; break; }
                if (found) k++;
                else if (isRes[i]) missCount[q] += pop[i];
            }
            score[i] = 100 * k / cats.length;
            cnt.fill(0);
            let tot = 0;
            for (const [a, b] of near) {
                const j = g.cellAt(i, a, b);
                if (j < 0) continue;
                for (let q = 0; q < cats.length; q++) { cnt[q] += has[q][j]; tot += has[q][j]; }
            }
            if (tot < 2) { mix[i] = tot ? 0 : NaN; continue; }
            let h = 0;
            for (let q = 0; q < cats.length; q++) if (cnt[q] > 0) { const p = cnt[q] / tot; h -= p * Math.log(p); }
            mix[i] = 100 * h / Math.log(cats.length);
        }
        const total = _sumOver(pop, idx, () => true);
        const complete = _sumOver(pop, idx, i => score[i] >= 100 * (cats.length - 1) / cats.length - 1e-9);
        const none = _sumOver(pop, idx, i => score[i] === 0);
        const worstQ = [...missCount.keys()].sort((a, b) => missCount[b] - missCount[a])[0];
        return {
            columns: { fifteen_min: score, mix }, idx,
            metric: { label: 'Residents with 6+ of 7 essentials on foot', value: _round(100 * complete / (total || 1)), unit: '%', higherIs: 'better' },
            headline: `${_round(100 * complete / (total || 1))}% of residents can walk to at least ${cats.length - 1} of ${cats.length} daily essentials within 15 minutes; `
                + `${cats[worstQ]} is the one most often out of reach (${_people(missCount[worstQ])} people).`,
            stats: [
                { label: 'Mean completeness (per resident)', value: `${_round(wmean(score, pop, idx))} / 100` },
                { label: `Residents with ≥ ${cats.length - 1} of ${cats.length}`, value: _people(complete), raw: Math.round(complete) },
                { label: 'Residents with none in reach', value: _people(none), raw: Math.round(none) },
                { label: 'Most-missing essential', value: cats[worstQ] },
                _distStat(onNet, total),
            ],
        };
    }

    /**
     * E2SFCA accessibility. `supply`, `demand` per cell; returns A per cell
     * (supply per person in reach). Gaussian decay, catchment d0 km.
     */
    function e2sfca(g, supply, demand, d0 = CATCH_KM, net = null) {
        net = net || walkNet(g, null);
        const e = Math.exp(-0.5);
        const G = d => (Math.exp(-0.5 * (d / d0) ** 2) - e) / (1 - e);
        const A = new Float64Array(g.n);
        for (let j = 0; j < g.n; j++) {
            const s = supply[j];
            if (!(s > 0)) continue;
            // Walking distance is symmetric, so one search from the facility serves both steps.
            const r = net.reach(j, d0);
            let den = 0;
            for (let t = 0; t < r.len; t++) { const k = r.js[t]; if (demand[k] > 0) den += G(r.ds[t]) * demand[k]; }
            if (!(den > 0)) continue;
            const R = s / den;
            for (let t = 0; t < r.len; t++) A[r.js[t]] += G(r.ds[t]) * R;
        }
        return A;
    }

    /** Pedestrian-shed ratio per cell: cells reachable within km on foot ÷ cells in the km circle. */
    function pedShed(fr, km = SHED_KM) {
        const g = fr.grid, net = _net(fr), out = new Float64Array(g.n).fill(NaN);
        if (!net.has) return null;
        const links = fr.cols[WALK_LINKS];
        const disk = g.offsets(km);
        for (let i = 0; i < g.n; i++) {
            if (!(links[i] > 0)) continue;
            let all = 0;
            for (const [a, b] of disk) if (g.cellAt(i, a, b) >= 0) all++;
            out[i] = all ? net.reach(i, km).len / all : NaN;
        }
        return out;
    }

    function _distStat(onNet, total) {
        return { label: 'Distances measured', value: onNet > 0 ? `on the walking network for ${_round(100 * onNet / (total || 1))}% of residents` : 'straight line (no walking graph baked)' };
    }

    function health(fr) {
        const c = fr.cols, idx = _residents(fr);
        const sup = c['osm_amenities.healthcare'], pop = c['population.population'];
        if (!sup || !pop) return null;
        const net = _net(fr);
        const A = e2sfca(fr.grid, sup, pop, CATCH_KM, net).map(x => x * 1e4);
        const links = fr.cols[WALK_LINKS];
        const total = _sumOver(pop, idx, () => true);
        const med = wquantile(A, pop, idx, 0.5);
        const desert = _sumOver(pop, idx, i => A[i] === 0);
        const low = med ? _sumOver(pop, idx, i => A[i] < med * 0.25) : null;
        return {
            columns: { health_access: A }, idx,
            metric: { label: 'Residents with no healthcare within 2 km', value: _round(100 * desert / (total || 1)), unit: '%', higherIs: 'worse' },
            headline: `${_people(desert)} people (${_round(100 * desert / (total || 1))}% of residents) have no mapped healthcare within ${CATCH_KM} km; `
                + `the typical resident shares each nearby facility with ${med ? _people(1e4 / med) : '–'} others.`,
            stats: [
                { label: 'Median places per 10k residents in reach', value: med != null ? String(_round(med, 2)) : '–' },
                { label: `No healthcare within ${CATCH_KM} km`, value: _people(desert), raw: Math.round(desert) },
                { label: 'Below a quarter of the median', value: low != null ? _people(low) : '–' },
                _distStat(net.has ? _sumOver(pop, idx, i => links[i] > 0) : 0, total),
            ],
        };
    }

    function transit(fr) {
        const c = fr.cols, g = fr.grid, idx = _residents(fr);
        const stops = c[`${TRANSIT}.stops`], rapid = c[`${TRANSIT}.rapid`], pop = c['population.population'];
        if (!stops || !rapid) return null;
        const net = _net(fr);
        const near = new Float64Array(g.n).fill(NaN), nearRapid = new Float64Array(g.n).fill(NaN);
        let onNet = 0;
        for (const i of idx) {
            const r = net.reach(i, RAPID_KM);
            if (r.net) onNet += pop[i];
            let ds = Infinity, dr = Infinity;
            for (let t = 0; t < r.len; t++) {
                const j = r.js[t], d = r.ds[t];
                if (stops[j] > 0 || rapid[j] > 0) ds = Math.min(ds, d);
                if (rapid[j] > 0) dr = Math.min(dr, d);
            }
            // Beyond the search radius: report "over 1 km" as the radius plus one cell.
            const cap = RAPID_KM + Math.max(g.dx, g.dy);
            near[i] = 1000 * Math.min(ds, cap);
            nearRapid[i] = 1000 * Math.min(dr, cap);
        }
        const ok = i => near[i] <= STOP_KM * 1000 + 1e-6 || nearRapid[i] <= RAPID_KM * 1000 + 1e-6;
        const total = _sumOver(pop, idx, () => true);
        const covered = _sumOver(pop, idx, ok);
        const rapidOk = _sumOver(pop, idx, i => nearRapid[i] <= RAPID_KM * 1000 + 1e-6);
        let nStops = 0, nRapid = 0;
        for (let i = 0; i < g.n; i++) { nStops += stops[i]; nRapid += rapid[i]; }
        const pct = _round(100 * covered / (total || 1));
        return {
            columns: { transit_m: near, rapid_m: nearRapid }, idx,
            metric: { label: 'Residents with convenient public transport (SDG 11.2.1)', value: pct, unit: '%', higherIs: 'better' },
            headline: `${pct}% of residents can walk to a bus stop within ${STOP_KM * 1000} m or a station within ${RAPID_KM} km (UN SDG 11.2.1); `
                + `${_people(total - covered)} people cannot, and ${_round(100 * rapidOk / (total || 1))}% live within ${RAPID_KM} km of rapid transit.`,
            stats: [
                { label: 'Residents without convenient access', value: _people(total - covered), raw: Math.round(total - covered) },
                { label: `Within ${RAPID_KM} km walk of a station or terminal`, value: _people(rapidOk), raw: Math.round(rapidOk) },
                { label: 'Median walk to the nearest stop', value: `${_round(wquantile(near, pop, idx, 0.5))} m` },
                { label: 'Mapped stops / stations per 10k residents', value: `${_round(1e4 * nStops / (total || 1), 1)} / ${_round(1e4 * nRapid / (total || 1), 2)}` },
                _distStat(onNet, total),
            ],
        };
    }

    function air(fr) {
        const c = fr.cols, idx = _residents(fr);
        const pm = c['air_quality.pm25_ugm3'], pop = c['population.population'];
        if (!pm) return null;
        const total = _sumOver(pop, idx, () => true);
        const pw = wmean(pm, pop, idx);
        const above = _sumOver(pop, idx, i => pm[i] > PM25_NAAQS);
        const aboveWho = _sumOver(pop, idx, i => pm[i] > PM25_WHO);
        const no2 = c['air_quality.no2_umol_m2'];
        return {
            columns: { pm25: Float64Array.from(pm) }, idx,
            metric: { label: 'PM2.5 per resident', value: _round(pw), unit: 'µg/m³', higherIs: 'worse' },
            headline: `The average resident breathes ${_round(pw)} µg/m³ of PM2.5 (${_round(pw / PM25_WHO, 1)}× the WHO guideline); `
                + `${_people(above)} people (${_round(100 * above / (total || 1))}%) live above India’s annual standard of ${PM25_NAAQS}.`,
            stats: [
                { label: 'Population-weighted PM2.5', value: `${_round(pw)} µg/m³` },
                { label: `Above NAAQS (${PM25_NAAQS})`, value: _people(above), raw: Math.round(above) },
                { label: `Above WHO (${PM25_WHO})`, value: _people(aboveWho), raw: Math.round(aboveWho) },
                { label: 'Population-weighted NO₂ column', value: no2 ? `${_round(wmean(no2, pop, idx))} µmol/m²` : '–' },
            ],
        };
    }

    /** OLS y = a + b x over idx. */
    function ols(x, y, idx) {
        let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const i of idx) {
            if (!_fin(x[i]) || !_fin(y[i])) continue;
            n++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i];
        }
        const den = n * sxx - sx * sx;
        if (n < 3 || !den) return null;
        const b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n;
        let ss = 0, st = 0;
        const my = sy / n;
        for (const i of idx) {
            if (!_fin(x[i]) || !_fin(y[i])) continue;
            ss += (y[i] - a - b * x[i]) ** 2; st += (y[i] - my) ** 2;
        }
        return { a, b, n, sd: Math.sqrt(ss / Math.max(1, n - 2)), r2: st ? 1 - ss / st : 0 };
    }

    function lights(fr) {
        const c = fr.cols, n = fr.grid.n;
        const rad = c['nightlights.radiance'], pop = c['population.population'];
        if (!rad || !pop) return null;
        const idx = _residents(fr).filter(i => pop[i] >= 10 && _fin(rad[i]));
        const x = new Float64Array(n).fill(NaN), y = new Float64Array(n).fill(NaN);
        for (const i of idx) { x[i] = Math.log(pop[i] + 1); y[i] = Math.log(Math.max(0, rad[i]) + 0.1); }
        const fit = ols(x, y, idx);
        if (!fit || !(fit.sd > 0)) return null;
        const z = new Float64Array(n).fill(NaN);
        for (const i of idx) z[i] = (y[i] - fit.a - fit.b * x[i]) / fit.sd;
        const dense = wquantile(c['population.density_km2'] || pop, null, idx, 0.75);
        const dens = c['population.density_km2'] || pop;
        const over = idx.filter(i => z[i] > 1).length;
        const underIdx = idx.filter(i => z[i] < -1 && dens[i] >= dense);
        const underPeople = _sumOver(pop, underIdx, () => true);
        return {
            columns: { ntl_resid: z }, idx, diverging: true,
            headline: `Night lights rise ${_round(fit.b, 2)}% for each 1% more residents (R² ${_round(fit.r2, 2)}). `
                + `${over} cells glow well above their residents (activity hubs); ${underIdx.length} dense cells with ${_people(underPeople)} people are under-lit for their size.`,
            stats: [
                { label: 'Light–population elasticity', value: String(_round(fit.b, 2)) },
                { label: 'Cells lit above residents (z > 1)', value: String(over) },
                { label: 'Dense, under-lit cells (z < −1)', value: `${underIdx.length} (${_people(underPeople)} people)` },
                { label: 'Fit R²', value: String(_round(fit.r2, 2)) },
            ],
            fit: { a: _round(fit.a, 3), b: _round(fit.b, 3), r2: _round(fit.r2, 3), n: fit.n },
        };
    }

    function burden(fr, done) {
        const parts = [['heat', 'hvi'], ['flood', 'flood_hazard'], ['air', 'pm25']].map(([id, k]) => done[id] && done[id].columns[k]).filter(Boolean);
        if (parts.length < 2) return null;
        const idx = _residents(fr), n = fr.grid.n, pop = fr.cols['population.population'];
        // Percentile ranks with ties averaged, so a coarse field (PM2.5 at
        // ~1 km) cannot put a whole tied block into the worst fifth.
        const ranks = parts.map(v => prank(v, idx));
        const out = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            let k = 0;
            parts.forEach((v, p) => { if (ranks[p][i] >= 0.8 && v[i] > 0) k++; });
            out[i] = k;
        }
        const two = _sumOver(pop, idx, i => out[i] >= 2), all = _sumOver(pop, idx, i => out[i] >= parts.length);
        const total = _sumOver(pop, idx, () => true);
        return {
            columns: { burden: out }, idx,
            headline: `${_people(two)} people (${_round(100 * two / (total || 1))}%) carry two or more of the city’s worst heat, flood and air burdens; ${_people(all)} carry all ${parts.length}.`,
            stats: [
                { label: 'Residents with ≥ 2 burdens', value: _people(two), raw: Math.round(two) },
                { label: `Residents with all ${parts.length}`, value: _people(all), raw: Math.round(all) },
            ],
        };
    }

    /** Pearson correlation over idx. */
    function pearson(x, y, idx) {
        const f = ols(x, y, idx);
        if (!f) return null;
        return Math.sign(f.b) * Math.sqrt(Math.max(0, f.r2));
    }

    function _z(values, idx) {
        let n = 0, s = 0, q = 0;
        for (const i of idx) if (_fin(values[i])) { n++; s += values[i]; q += values[i] * values[i]; }
        const m = n ? s / n : 0, sd = n ? Math.sqrt(Math.max(0, q / n - m * m)) : 0;
        return Float64Array.from(values, v => (_fin(v) && sd > 0 ? (v - m) / sd : NaN));
    }

    function walk(fr, done) {
        const c = fr.cols, idx = _residents(fr), n = fr.grid.n;
        const jx = c['osm_roads.junctions_km2'], dens = c['population.density_km2'];
        const mix = done.fifteen && done.fifteen.columns.mix;
        if (!jx || !dens) return null;
        const shed = pedShed(fr);
        const zj0 = _z(jx, idx), zs = shed ? _z(shed, idx) : null;
        const zj = zs ? zj0.map((v, i) => (_fin(zs[i]) && _fin(v) ? (v + zs[i]) / 2 : v)) : zj0;
        const zd = _z(dens.map(v => Math.log1p(Math.max(0, v))), idx), zm = mix ? _z(mix.map(v => (_fin(v) ? v : 0)), idx) : null;
        const raw = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            if (!_fin(zj[i]) || !_fin(zd[i])) continue;
            raw[i] = 2 * zj[i] + zd[i] + (zm && _fin(zm[i]) ? zm[i] : 0);
        }
        const out = prank(raw, idx).map(x => (_fin(x) ? x * 100 : NaN));
        const pop = c['population.population'];
        const total = _sumOver(pop, idx, () => true);
        const sparse = _sumOver(pop, idx, i => _fin(jx[i]) && jx[i] < LEED_JX);
        const low = sparse;
        const osm = c['scores.walkability'];
        const r = osm ? pearson(out, osm, idx.filter(i => _fin(out[i]) && _fin(osm[i]) && osm[i] > 0)) : null;
        const jTop = wmean(jx, pop, idx.filter(i => out[i] >= 80)), jLow = wmean(jx, pop, idx.filter(i => out[i] < 20));
        return {
            columns: { walk_index: out }, idx,
            metric: { label: `Residents below ${LEED_JX} junctions/km²`, value: _round(100 * low / (total || 1)), unit: '%', higherIs: 'worse' },
            headline: `${_people(low)} people (${_round(100 * low / (total || 1))}%) live where streets have fewer than ${LEED_JX} junctions per km² (the LEED-ND connectivity bar); `
                + `the most walkable fifth of cells has ${_round(jTop)} per km², the least ${_round(jLow)}.`
                + (r != null ? ` The index ${Math.abs(r) >= 0.5 ? 'agrees with' : Math.abs(r) >= 0.25 ? 'partly agrees with' : 'differs from'} the OSM walkability score (r = ${_round(r, 2)}).` : ''),
            stats: [
                { label: `Residents below ${LEED_JX} junctions / km²`, value: _people(low), raw: Math.round(low) },
                { label: 'Mean index per resident', value: `${_round(wmean(out, pop, idx))} / 100` },
                { label: 'Junctions / km²: top vs bottom fifth', value: `${_round(jTop)} vs ${_round(jLow)}` },
                { label: 'Correlation with OSM walkability score', value: r != null ? String(_round(r, 2)) : '–' },
                ...(shed ? [{ label: `Pedestrian-shed ratio (${SHED_KM} km on foot ÷ circle), per resident`, value: String(_round(wmean(shed, pop, idx.filter(i => _fin(shed[i]))), 2)) }] : []),
            ],
        };
    }

    function sprawl(fr) {
        const c = fr.cols, g = fr.grid, n = g.n;
        const b16 = c['growth.built_2016_pct'], b23 = c['growth.built_2023_pct'];
        if (!b16 || !b23) return null;
        const ring = g.offsets(0.5).filter(([a, b]) => a || b);
        const lei = new Float64Array(n).fill(NaN);
        let infill = 0, edge = 0, out = 0;
        const grew = [];
        for (let i = 0; i < n; i++) {
            const gain = b23[i] - b16[i];
            if (!(gain >= 5)) continue;
            // LEI on the cell lattice: the share of ring cells that were
            // already urban (≥ URBAN_PCT built) in 2016, as Liu et al. do with
            // urban-patch pixels in a buffer.
            let s = 0, k = 0;
            for (const [a, b] of ring) {
                const j = g.cellAt(i, a, b);
                if (j < 0 || !_fin(b16[j])) continue;
                if (b16[j] >= URBAN_PCT) s++;
                k++;
            }
            if (!k) continue;
            lei[i] = 100 * s / k;
            grew.push(i);
            const area = gain / 100 * g.cellKm2;
            if (lei[i] >= 50) infill += area; else if (lei[i] >= 2) edge += area; else out += area;
        }
        const tot = infill + edge + out;
        // Clark (1951): ln D(x) = ln D0 − b·x, x = km from the night-lights peak.
        const idx = _residents(fr), pop = c['population.population'], dens = c['population.density_km2'];
        const rad = c['nightlights.radiance'];
        let cbd = -1, best = -Infinity;
        if (rad) {
            const near = g.offsets(1);
            for (const i of idx) {
                let s = 0;
                for (const [a, b] of near) { const j = g.cellAt(i, a, b); if (j >= 0 && _fin(rad[j])) s += rad[j]; }
                if (s > best) { best = s; cbd = i; }
            }
        }
        let fit = null;
        if (cbd >= 0 && dens) {
            const x = new Float64Array(n).fill(NaN), y = new Float64Array(n).fill(NaN);
            const use = idx.filter(i => dens[i] > 50);
            for (const i of use) {
                x[i] = Math.hypot((g.row[i] - g.row[cbd]) * g.dy, (g.col[i] - g.col[cbd]) * g.dx);
                y[i] = Math.log(dens[i]);
            }
            fit = ols(x, y, use);
        }
        const pwd = dens ? wmean(dens, pop, idx) : null;
        const total = _sumOver(pop, idx, () => true);
        const gross = total / ((idx.length || 1) * g.cellKm2);
        const share = (v) => (tot ? _round(100 * v / tot) : null);
        const verdict = !tot ? 'little measurable growth' : share(infill) >= 50 ? 'mostly infill (compact)' : share(out) >= 25 ? 'leapfrogging (sprawling)' : 'mostly edge expansion';
        return {
            columns: { lei }, idx: grew.length >= 10 ? grew : idx, diverging: false,
            metric: tot ? { label: 'New built-up land that is infill', value: share(infill), unit: '%', higherIs: 'better' } : null,
            headline: tot
                ? `${_round(tot, 1)} km² of land was newly built 2016–2023, ${verdict}: ${share(infill)}% infill, ${share(edge)}% at the edge, ${share(out)}% leapfrog.`
                    + (fit ? ` Density falls ${_round(100 * (1 - Math.exp(fit.b)))}% per km from the centre (Clark gradient ${_round(-fit.b, 3)}/km).` : '')
                : 'Too little new built-up land 2016–2023 to classify growth.',
            stats: [
                { label: 'Newly built 2016–2023', value: `${_round(tot, 2)} km²` },
                { label: 'Infill / edge / leapfrog', value: tot ? `${share(infill)} / ${share(edge)} / ${share(out)}%` : '–' },
                { label: 'Clark density gradient', value: fit ? `${_round(-fit.b, 3)} per km (R² ${_round(fit.r2, 2)})` : '–' },
                { label: 'Population-weighted vs gross density', value: pwd != null ? `${Math.round(pwd).toLocaleString('en-IN')} vs ${Math.round(gross).toLocaleString('en-IN')} /km²` : '–' },
            ],
            fit: fit ? { gradient: _round(-fit.b, 4), r2: _round(fit.r2, 3), centre: g.codes[cbd] } : null,
            noHotspots: grew.length < 10,
        };
    }

    /**
     * k-means with k-means++ seeding on rows of `X` (arrays of equal length).
     * Deterministic for a seed. Returns { labels, centroids, inertia }.
     */
    function kmeans(X, k, opts = {}) {
        const n = X.length, d = n ? X[0].length : 0, rnd = _rng(opts.seed || 7);
        if (n < k) return null;
        const dist2 = (a, b) => { let s = 0; for (let t = 0; t < d; t++) { const u = a[t] - b[t]; s += u * u; } return s; };
        const C = [X[Math.floor(rnd() * n)].slice()];
        const D = new Float64Array(n).fill(Infinity);
        while (C.length < k) {
            let tot = 0;
            for (let i = 0; i < n; i++) { D[i] = Math.min(D[i], dist2(X[i], C[C.length - 1])); tot += D[i]; }
            let r = rnd() * tot, pick = n - 1;
            for (let i = 0; i < n; i++) { r -= D[i]; if (r <= 0) { pick = i; break; } }
            C.push(X[pick].slice());
        }
        const lab = new Int32Array(n);
        let inertia = 0;
        for (let it = 0; it < (opts.iterations || 40); it++) {
            let moved = 0;
            inertia = 0;
            for (let i = 0; i < n; i++) {
                let best = 0, bd = Infinity;
                for (let c = 0; c < k; c++) { const v = dist2(X[i], C[c]); if (v < bd) { bd = v; best = c; } }
                if (lab[i] !== best) { lab[i] = best; moved++; }
                inertia += bd;
            }
            const sum = Array.from({ length: k }, () => new Float64Array(d)), cnt = new Int32Array(k);
            for (let i = 0; i < n; i++) { cnt[lab[i]]++; for (let t = 0; t < d; t++) sum[lab[i]][t] += X[i][t]; }
            for (let c = 0; c < k; c++) if (cnt[c]) for (let t = 0; t < d; t++) C[c][t] = sum[c][t] / cnt[c];
            if (!moved && it) break;
        }
        return { labels: lab, centroids: C, inertia };
    }

    /** Mean silhouette of a labelled sample (Rousseeuw 1987). */
    function silhouette(X, labels, k) {
        const n = X.length;
        if (n < 3) return null;
        const dist = (a, b) => { let s = 0; for (let t = 0; t < a.length; t++) { const u = a[t] - b[t]; s += u * u; } return Math.sqrt(s); };
        let tot = 0;
        for (let i = 0; i < n; i++) {
            const sum = new Float64Array(k), cnt = new Int32Array(k);
            for (let j = 0; j < n; j++) if (j !== i) { sum[labels[j]] += dist(X[i], X[j]); cnt[labels[j]]++; }
            const a = cnt[labels[i]] ? sum[labels[i]] / cnt[labels[i]] : 0;
            let b = Infinity;
            for (let c = 0; c < k; c++) if (c !== labels[i] && cnt[c]) b = Math.min(b, sum[c] / cnt[c]);
            tot += (b === Infinity || Math.max(a, b) === 0) ? 0 : (b - a) / Math.max(a, b);
        }
        return tot / n;
    }

    const TRAITS = {
        dens: ['sparser', 'denser'], built: ['less built-up', 'more built-up'], height: ['low-rise', 'taller'], mix: ['single-use', 'mixed-use'],
        canopy: ['bare', 'greener'], lights: ['darker', 'brighter'], jx: ['fewer junctions', 'finer street grid'], growth: ['settled', 'fast-growing'],
    };
    const URBAN_DENSITY = 1500;   // DEGURBA urban-centre density (Dijkstra et al. 2021)
    const RURAL_TYPE = 'Below urban density';
    const TYPE_COLORS = ['#7f0000', '#d7301f', '#fc8d59', '#fdcc8a', '#41ab5d', '#2c7fb8', '#807dba', '#bdbdbd'];

    /** A plain name for a cluster centroid (z-scores by feature). */
    function archetypeName(cz) {
        if (cz.dens < -0.8 && cz.built < -0.6) return 'Urban fringe';
        if (cz.growth > 0.8) return 'New growth edge';
        if (cz.height > 1) return cz.dens > 0.3 ? 'High-rise core' : 'High-rise district';
        if (cz.dens > 0.6 && cz.jx > 0.4 && cz.mix > 0.2) return 'Dense mixed core';
        if (cz.lights > 0.8 && cz.dens < 0.4) return 'Activity hub (commerce / industry)';
        if (cz.canopy > 0.8) return 'Leafy neighbourhood';
        if (cz.dens > 0.4) return 'Dense residential';
        if (cz.dens > -0.4) return 'Mid-density residential';
        return 'Low-density suburb';
    }

    function types(fr, done) {
        const c = fr.cols, res = _residents(fr);
        const densAll = c['population.density_km2'];
        // Cluster the urban fabric only (DEGURBA's urban-centre density,
        // 1 500 /km²); the rest is one fixed class, else urban vs rural
        // swamps every other difference.
        const idx = densAll ? res.filter(i => densAll[i] >= URBAN_DENSITY) : res;
        const rural = densAll ? res.filter(i => densAll[i] < URBAN_DENSITY) : [];
        const b16 = c['growth.built_2016_pct'], b23 = c['growth.built_2023_pct'];
        const mix = done.fifteen && done.fifteen.columns.mix;
        const feats = {
            dens: c['population.density_km2'] && c['population.density_km2'].map(v => Math.log1p(Math.max(0, v))),
            built: c['built_up.built_pct'], height: c['built_up.avg_height_m'], mix,
            canopy: c['vegetation.tree_canopy_pct'],
            lights: c['nightlights.radiance'] && c['nightlights.radiance'].map(v => Math.log1p(Math.max(0, v))),
            jx: c['osm_roads.junctions_km2'] && c['osm_roads.junctions_km2'].map(v => Math.log1p(Math.max(0, v))),
            growth: b16 && b23 ? b23.map((v, i) => v - b16[i]) : null,
        };
        const keys = Object.keys(feats).filter(k => feats[k]);
        if (keys.length < 4 || idx.length < 50) return null;
        const Z = keys.map(k => _z(feats[k], idx));
        const X = idx.map(i => Z.map(z => (_fin(z[i]) ? Math.max(-4, Math.min(4, z[i])) : 0)));
        // Pick k by silhouette on a fixed sample.
        const rnd = _rng(99), S = Math.min(700, X.length);
        const sample = Array.from({ length: S }, () => Math.floor(rnd() * X.length));
        let best = null;
        for (let k = 4; k <= 7; k++) {
            const km = kmeans(X, k, { seed: 11 });
            if (!km) continue;
            const sil = silhouette(sample.map(i => X[i]), sample.map(i => km.labels[i]), k);
            if (!best || sil > best.sil) best = { k, km, sil };
        }
        if (!best) return null;
        const pop = c['population.population'];
        const groups = best.km.centroids.map((cen, g) => {
            const cz = {};
            keys.forEach((k, t) => { cz[k] = cen[t]; });
            for (const k of Object.keys(TRAITS)) if (cz[k] == null) cz[k] = 0;
            return { g, cz, name: archetypeName(cz), people: 0, cells: 0 };
        });
        idx.forEach((i, p) => { const gr = groups[best.km.labels[p]]; gr.people += pop[i]; gr.cells++; });
        const ruralPeople = _sumOver(pop, rural, () => true);
        // Same name twice: add each one's most distinctive other trait.
        const seen = new Map();
        for (const gr of groups) seen.set(gr.name, (seen.get(gr.name) || 0) + 1);
        for (const gr of groups) {
            if (seen.get(gr.name) < 2) continue;
            const k = keys.filter(x => x !== 'dens').sort((a, b) => Math.abs(gr.cz[b]) - Math.abs(gr.cz[a]))[0];
            gr.name = `${gr.name}, ${TRAITS[k][gr.cz[k] >= 0 ? 1 : 0]}`;
        }
        groups.sort((a, b) => b.people - a.people);
        const order = new Map(groups.map((gr, r) => [gr.g, r]));
        const lab = new Float64Array(fr.grid.n).fill(NaN);
        idx.forEach((i, p) => { lab[i] = order.get(best.km.labels[p]); });
        const total = (groups.reduce((a, g2) => a + g2.people, 0) + ruralPeople) || 1;
        const domain = groups.map(g2 => g2.name);
        if (rural.length) {
            domain.push(RURAL_TYPE);
            for (const i of rural) lab[i] = domain.length - 1;
        }
        const colors = {};
        domain.forEach((nm, r) => { colors[nm] = nm === RURAL_TYPE ? '#d9d9d9' : TYPE_COLORS[r % TYPE_COLORS.length]; });
        const describe = (gr) => keys.filter(k => Math.abs(gr.cz[k]) >= 0.5).sort((a, b) => Math.abs(gr.cz[b]) - Math.abs(gr.cz[a])).slice(0, 3)
            .map(k => TRAITS[k][gr.cz[k] >= 0 ? 1 : 0]).join(', ') || 'close to the city average';
        return {
            columns: { archetype: lab }, idx: res, noHotspots: true,
            categories: { archetype: { domain, colors } },
            headline: `The urban fabric (${idx.length.toLocaleString('en-IN')} cells at ≥ ${URBAN_DENSITY.toLocaleString('en-IN')} people/km²) sorts into ${best.k} kinds of place; `
                + `the most lived-in are “${groups[0].name}” (${_round(100 * groups[0].people / total)}% of residents)`
                + (groups[1] ? ` and “${groups[1].name}” (${_round(100 * groups[1].people / total)}%).` : '.'),
            stats: [
                ...groups.map(gr => ({ label: `${gr.name}: ${describe(gr)}`, value: `${_round(100 * gr.people / total)}% of residents · ${gr.cells} cells` })),
                ...(rural.length ? [{ label: `${RURAL_TYPE} (not clustered)`, value: `${_round(100 * ruralPeople / total)}% of residents · ${rural.length} cells` }] : []),
            ],
            fit: { k: best.k, silhouette: _round(best.sil, 3), features: keys },
        };
    }

    /** Sum (or mean) of `values` within `km` of each cell. */
    function within(g, values, km, mean = false) {
        const off = g.offsets(km), out = new Float64Array(g.n);
        for (let i = 0; i < g.n; i++) {
            let s = 0, k = 0;
            for (const [a, b] of off) {
                const j = g.cellAt(i, a, b);
                if (j < 0 || !_fin(values[j])) continue;
                s += values[j]; k++;
            }
            out[i] = mean ? (k ? s / k : NaN) : s;
        }
        return out;
    }

    function green(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr);
        const can = c['vegetation.tree_canopy_pct'];
        if (!can) return null;
        const tree = c['land_cover.tree_pct'], grass = c['land_cover.grass_pct'], leis = c['osm_amenities.leisure'];
        const isGreen = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const lc = (tree && _fin(tree[i]) ? tree[i] : 0) + (grass && _fin(grass[i]) ? grass[i] : 0);
            isGreen[i] = lc >= 40 || (leis && leis[i] > 0) ? 1 : 0;
        }
        const can500 = within(g, can, 0.5, true);
        const near = within(g, isGreen, 0.3);
        const rules = new Float64Array(n).fill(NaN);
        for (const i of idx) rules[i] = (can500[i] >= 30 ? 1 : 0) + (near[i] > 0 ? 1 : 0);
        const pop = c['population.population'];
        const total = _sumOver(pop, idx, () => true) || 1;
        const r30 = _sumOver(pop, idx, i => can500[i] >= 30), r300 = _sumOver(pop, idx, i => near[i] > 0);
        const both = _sumOver(pop, idx, i => rules[i] === 2), none = _sumOver(pop, idx, i => rules[i] === 0);
        return {
            columns: { green_rules: rules, canopy_500m: can500 }, idx, weightKey: 'canopy_500m',
            metric: { label: 'Residents with green space within 300 m', value: _round(100 * r300 / total), unit: '%', higherIs: 'better' },
            headline: `${_round(100 * r30 / total)}% of residents have 30% tree canopy around home and ${_round(100 * r300 / total)}% have green space within 300 m; `
                + `${_people(none)} people (${_round(100 * none / total)}%) meet neither.`,
            stats: [
                { label: '30% canopy within 500 m', value: `${_people(r30)} (${_round(100 * r30 / total)}%)`, raw: Math.round(r30) },
                { label: 'Green space within 300 m', value: `${_people(r300)} (${_round(100 * r300 / total)}%)`, raw: Math.round(r300) },
                { label: 'Both', value: _people(both), raw: Math.round(both) },
                { label: 'Canopy around the average home', value: `${_round(wmean(can500, pop, idx))}%` },
            ],
        };
    }

    function solar(fr) {
        const c = fr.cols, g = fr.grid, n = g.n, idx = _residents(fr);
        const cover = c['building_stock.cover_2023_pct'] || c['osm_roads.building_cover_pct'];
        const ghi = GHI[fr.city];
        if (!cover || !ghi) return null;
        const yieldKwh = ghi * 365 * PERF_RATIO;             // per kWp per year
        const mwh = new Float64Array(n).fill(NaN);
        let kwp = 0, energy = 0, roofKm2 = 0;
        for (let i = 0; i < n; i++) {
            if (!_fin(cover[i]) || cover[i] <= 0) continue;
            const roof = (cover[i] / 100) * g.cellKm2 * 1e6;  // m²
            const cap = roof * ROOF_USABLE / M2_PER_KWP;
            mwh[i] = cap * yieldKwh / 1000;
            kwp += cap; energy += mwh[i]; roofKm2 += roof / 1e6;
        }
        if (!energy) return null;
        const pop = c['population.population'];
        const total = _sumOver(pop, idx, () => true);
        const demandMwh = total * KWH_PER_CAPITA / 1000;
        const selfSuff = idx.filter(i => _fin(mwh[i]) && pop[i] > 0 && mwh[i] * 1000 >= pop[i] * KWH_PER_CAPITA);
        const ssPeople = _sumOver(pop, selfSuff, () => true);
        const use = [];
        for (let i = 0; i < n; i++) if (_fin(mwh[i])) use.push(i);
        return {
            columns: { solar_mwh: mwh }, idx: use,
            metric: { label: 'Rooftop solar vs residents’ use', value: _round(100 * energy / (demandMwh || 1)), unit: '%', higherIs: 'better' },
            headline: `Roofs covering ${_round(roofKm2, 1)} km² could host about ${_round(kwp / 1e6, 2)} GW of solar and make ${_round(energy / 1e3, 0).toLocaleString('en-IN')} GWh a year, `
                + `${_round(100 * energy / (demandMwh || 1))}% of what the city’s residents use (at ${KWH_PER_CAPITA.toLocaleString('en-IN')} kWh each).`,
            stats: [
                { label: 'Potential capacity', value: `${_round(kwp / 1e6, 2)} GW` },
                { label: 'Annual generation', value: `${Math.round(energy / 1e3).toLocaleString('en-IN')} GWh` },
                { label: 'Share of residents’ consumption', value: `${_round(100 * energy / (demandMwh || 1))}%` },
                { label: 'Residents in cells whose roofs out-produce them', value: _people(ssPeople), raw: Math.round(ssPeople) },
                { label: 'Irradiance (NASA POWER)', value: `${ghi} kWh/m²/day · ${Math.round(yieldKwh)} kWh/kWp/yr` },
            ],
        };
    }

    function confidence(fr) {
        const c = fr.cols, n = fr.grid.n, idx = _residents(fr);
        const osm = c['osm_roads.buildings'], ob = c['building_stock.buildings_2023'];
        const inputs = Object.keys(c).filter(k => !k.startsWith('population.'));
        if (!inputs.length) return null;
        const comp = new Float64Array(n).fill(NaN), conf = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            let have = 0;
            for (const k of inputs) if (_fin(c[k][i])) have++;
            const cov = have / inputs.length;
            if (osm && ob && ob[i] > 0) comp[i] = 100 * Math.min(1, (osm[i] || 0) / ob[i]);
            conf[i] = _fin(comp[i]) ? 50 * cov + 0.5 * comp[i] : 100 * cov;
        }
        const pop = c['population.population'];
        const total = _sumOver(pop, idx, () => true) || 1;
        const low = _sumOver(pop, idx, i => _fin(comp[i]) && comp[i] < 50);
        const mc = wmean(comp, pop, idx);
        return {
            columns: { confidence: conf, osm_complete: comp }, idx,
            metric: { label: 'OSM building completeness per resident', value: _round(mc), unit: '%', higherIs: 'better' },
            headline: `OpenStreetMap maps about ${_round(mc)}% of the buildings Open Buildings sees where the average resident lives; `
                + `${_people(low)} people (${_round(100 * low / total)}%) live where it maps under half, so amenity-based lenses there are lower bounds.`,
            stats: [
                { label: 'OSM building completeness (per resident)', value: `${_round(mc)}%` },
                { label: 'Residents where OSM maps < 50%', value: _people(low), raw: Math.round(low) },
                { label: 'Mean confidence (per resident)', value: `${_round(wmean(conf, pop, idx))} / 100` },
                { label: 'Inputs missing for this city', value: fr.missing.length ? fr.missing.join(', ') : 'none' },
            ],
        };
    }

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const _month = (step) => { const m = /^(\d{4})-(\d{2})/.exec(step || ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(step); };

    /** Population-weighted mean of each step of a series column over idx. */
    function _pwSeries(col, pop, idx) {
        let len = 0;
        for (const i of idx) if (col[i]) { len = Math.max(len, col[i].length); }
        const out = [];
        for (let t = 0; t < len; t++) {
            let s = 0, w = 0;
            for (const i of idx) {
                const v = col[i] && col[i][t];
                if (v == null || !Number.isFinite(Number(v)) || !(pop[i] > 0)) continue;
                s += Number(v) * pop[i]; w += pop[i];
            }
            out.push(w ? s / w : null);
        }
        return out;
    }

    function seasons(fr) {
        const c = fr.cols, n = fr.grid.n, idx = _residents(fr), pop = c['population.population'];
        const day = c['lst_monthly.lst_day_c@series'], night = c['lst_monthly.lst_night_c@series'], pm = c['pm25_monthly.pm25_ugm3@series'];
        if (!day && !pm) return null;
        const last12 = (a) => (a ? a.slice(-12) : []);
        const count = (a, thr) => { let k = 0, seen = 0; for (const v of last12(a)) if (v != null && Number.isFinite(Number(v))) { seen++; if (Number(v) >= thr) k++; } return seen ? k : NaN; };
        const hot = new Float64Array(n).fill(NaN), pmm = new Float64Array(n).fill(NaN);
        for (const i of idx) {
            if (day) hot[i] = count(day[i], 40);
            if (pm) pmm[i] = count(pm[i], 60.0001);
        }
        const total = _sumOver(pop, idx, () => true) || 1;
        const series = {};
        const stats = [];
        let head = '';
        if (pm) {
            const sPm = _pwSeries(pm, pop, idx), st = fr.steps.pm25_monthly || [];
            const tail = sPm.slice(-12), off = sPm.length - tail.length;
            const worst = tail.reduce((b, v, t) => (v != null && (b < 0 || v > tail[b]) ? t : b), -1);
            const perRes = wmean(pmm, pop, idx);
            series.pm25 = { label: 'PM2.5 per resident (µg/m³)', values: sPm.map(v => _round(v, 1)), steps: st };
            stats.push({ label: 'Months a year above 60 µg/m³ (per resident)', value: String(_round(perRes, 1)) });
            if (worst >= 0) stats.push({ label: 'Worst month for PM2.5', value: `${_month(st[off + worst])}: ${_round(tail[worst])} µg/m³` });
            head += `The average resident lives through ${_round(perRes, 1)} month(s) a year when PM2.5 averages over 60 µg/m³`
                + (worst >= 0 ? ` (worst ${_month(st[off + worst])}, ${_round(tail[worst])} µg/m³)` : '') + '. ';
        }
        if (day) {
            const sD = _pwSeries(day, pop, idx), st = fr.steps.lst_monthly || [];
            const hotPeople = _sumOver(pop, idx, i => hot[i] >= 3);
            series.lst = { label: 'Daytime surface °C per resident', values: sD.map(v => _round(v, 1)), steps: st };
            stats.push({ label: 'Residents with ≥ 3 months of ≥ 40 °C surfaces', value: _people(hotPeople), raw: Math.round(hotPeople) });
            const warm = (s) => {
                const a = s.slice(-12).filter(v => v != null), b = s.slice(-24, -12).filter(v => v != null);
                return a.length >= 6 && b.length >= 6 ? a.reduce((x, y) => x + y, 0) / a.length - b.reduce((x, y) => x + y, 0) / b.length : null;
            };
            const dD = warm(sD), dN = night ? warm(_pwSeries(night, pop, idx)) : null;
            if (dD != null) stats.push({ label: 'Day surface change, last 12 vs previous 12 months', value: `${dD >= 0 ? '+' : ''}${_round(dD, 2)} °C` });
            if (dN != null) stats.push({ label: 'Night surface change, last 12 vs previous 12 months', value: `${dN >= 0 ? '+' : ''}${_round(dN, 2)} °C` });
            head += `${_people(hotPeople)} people (${_round(100 * hotPeople / total)}%) live where the month-average daytime surface tops 40 °C in three or more months`
                + (dN != null ? `; nights ran ${_round(Math.abs(dN), 2)} °C ${dN >= 0 ? 'warmer' : 'cooler'} than the year before.` : '.');
        }
        const pmRes = pm ? wmean(pmm, pop, idx) : null;
        return { columns: { hot_months: hot, pm_months: pmm }, idx, weightKey: day ? 'hot_months' : 'pm_months', headline: head.trim(), stats, series,
            metric: pmRes != null ? { label: 'Months a year above 60 µg/m³ PM2.5', value: _round(pmRes, 1), unit: 'months', higherIs: 'worse' } : null };
    }

    const RUN = { heat, flood, waterlog, traffic, cutoff, fifteen, health, transit, air, lights, walk, sprawl, types, green, solar, confidence, seasons, burden };

    // ── siting suitability (MCDA with AHP weights) ──────────────────────────

    const SITING_NEEDS = ['osm_amenities.education', 'osm_amenities.leisure', 'osm_amenities.healthcare', 'osm_roads.junctions_km2',
        'osm_roads.major_km_km2', 'building_stock.cover_2023_pct', 'nightlights.radiance', 'vegetation.tree_canopy_pct'];

    /**
     * AHP weights from a reciprocal pairwise matrix (Saaty 1980): principal
     * eigenvector by power iteration, and the consistency ratio (≤ 0.1 is
     * acceptable).
     */
    function ahp(M) {
        const n = M.length;
        let w = new Array(n).fill(1 / n);
        for (let it = 0; it < 100; it++) {
            const v = M.map(row => row.reduce((a, x, j) => a + x * w[j], 0));
            const s = v.reduce((a, x) => a + x, 0);
            w = v.map(x => x / s);
        }
        const lam = M.reduce((a, row, i) => a + row.reduce((b, x, j) => b + x * w[j], 0) / w[i], 0) / n;
        const RI = [0, 0, 0, 0.58, 0.9, 1.12, 1.24, 1.32][n] || 1.41;
        const ci = n > 2 ? (lam - n) / (n - 1) : 0;
        return { weights: w, lambda: lam, cr: RI ? ci / RI : 0 };
    }

    // Criteria read from the frame (`c`) and the lens results (`d`), with the
    // direction that makes a site better. Pairwise matrices rows/cols follow
    // the criteria order.
    const PRESETS = {
        clinic: { title: 'New clinic', icon: '🏥', serveKm: CATCH_KM,
            why: 'many people, little healthcare in reach, good road access, out of the floodplain',
            criteria: [
                { label: 'residents per km²', get: (c) => c['population.density_km2'], dir: 1 },
                { label: 'healthcare places per 10k in reach', get: (c, d) => d.health && d.health.columns.health_access, dir: -1 },
                { label: 'junctions per km²', get: (c) => c['osm_roads.junctions_km2'], dir: 1 },
                { label: 'flood hazard', get: (c, d) => d.flood && d.flood.columns.flood_hazard, dir: -1 },
            ],
            pairwise: [[1, 1 / 2, 3, 2], [2, 1, 4, 3], [1 / 3, 1 / 4, 1, 1 / 2], [1 / 2, 1 / 3, 2, 1]],
            exclude: (c, d, i) => d.flood && d.flood.columns.flood_hazard[i] >= 60 },
        school: { title: 'New school', icon: '🏫', serveKm: WALK_KM,
            why: 'dense, few schools within a walk, walkable streets, out of the floodplain',
            criteria: [
                { label: 'residents per km²', get: (c) => c['population.density_km2'], dir: 1 },
                { label: 'schools within 1.2 km', get: (c, d, g) => c['osm_amenities.education'] && within(g, c['osm_amenities.education'], WALK_KM), dir: -1 },
                { label: 'walkability index', get: (c, d) => d.walk && d.walk.columns.walk_index, dir: 1 },
                { label: 'flood hazard', get: (c, d) => d.flood && d.flood.columns.flood_hazard, dir: -1 },
            ],
            pairwise: [[1, 1 / 2, 2, 2], [2, 1, 3, 3], [1 / 2, 1 / 3, 1, 1], [1 / 2, 1 / 3, 1, 1]],
            exclude: (c, d, i) => d.flood && d.flood.columns.flood_hazard[i] >= 60 },
        park: { title: 'New park', icon: '🌳', serveKm: 0.5,
            why: 'heat-vulnerable, few trees, dense, no leisure space nearby',
            criteria: [
                { label: 'heat vulnerability', get: (c, d) => d.heat && d.heat.columns.hvi, dir: 1 },
                { label: 'tree canopy %', get: (c) => c['vegetation.tree_canopy_pct'], dir: -1 },
                { label: 'residents per km²', get: (c) => c['population.density_km2'], dir: 1 },
                { label: 'leisure places within 1.2 km', get: (c, d, g) => c['osm_amenities.leisure'] && within(g, c['osm_amenities.leisure'], WALK_KM), dir: -1 },
            ],
            pairwise: [[1, 2, 2, 3], [1 / 2, 1, 1, 2], [1 / 2, 1, 1, 2], [1 / 3, 1 / 2, 1 / 2, 1]] },
        cool_roofs: { title: 'Cool-roof programme', icon: '🏠', serveKm: 0,
            why: 'heat-vulnerable, roof-dense, many residents',
            criteria: [
                { label: 'heat vulnerability', get: (c, d) => d.heat && d.heat.columns.hvi, dir: 1 },
                { label: 'building cover %', get: (c) => c['building_stock.cover_2023_pct'], dir: 1 },
                { label: 'residents per km²', get: (c) => c['population.density_km2'], dir: 1 },
            ],
            pairwise: [[1, 2, 3], [1 / 2, 1, 2], [1 / 3, 1 / 2, 1]] },
        ev_charging: { title: 'EV charging hub', icon: '🔌', serveKm: 1,
            why: 'busy (bright at night), on major roads, many residents',
            criteria: [
                { label: 'night-time lights', get: (c) => c['nightlights.radiance'], dir: 1 },
                { label: 'major road km per km²', get: (c) => c['osm_roads.major_km_km2'], dir: 1 },
                { label: 'residents per km²', get: (c) => c['population.density_km2'], dir: 1 },
            ],
            pairwise: [[1, 1, 2], [1, 1, 2], [1 / 2, 1 / 2, 1]] },
    };

    /**
     * Rank every populated cell for a facility (weighted-overlay MCDA, AHP
     * weights) from a run's frame and lens results, and pick up to `sites`
     * candidates at least `spacingKm` apart. Returns a lens-shaped object with
     * its own layer ({ spec, table }).
     */
    function site(result, presetId = 'clinic', opts = {}) {
        const w = result && result._work, P = PRESETS[presetId];
        if (!w || !P) return null;
        const fr = w.frame, c = fr.cols, g = fr.grid, d = w.done, idx = _residents(fr);
        const crit = P.criteria.map(cr => ({ ...cr, values: cr.get(c, d, g) })).filter(cr => cr.values);
        if (crit.length < 2) return null;
        const keep = P.criteria.map(cr => crit.some(x => x.label === cr.label));
        const M = P.pairwise.filter((_, i) => keep[i]).map(row => row.filter((_, j) => keep[j]));
        const { weights, cr } = ahp(M);
        const ranks = crit.map(x => prank(x.dir > 0 ? x.values : Float64Array.from(x.values, v => -v), idx));
        const score = new Float64Array(g.n).fill(NaN);
        for (const i of idx) {
            if (P.exclude && P.exclude(c, d, i)) continue;
            let s = 0, ws = 0;
            ranks.forEach((r, k) => { if (_fin(r[i])) { s += weights[k] * r[i]; ws += weights[k]; } });
            if (ws > 0.5) score[i] = 100 * s / ws;
        }
        const order = idx.filter(i => _fin(score[i])).sort((a, b) => score[b] - score[a]);
        const spacing = opts.spacingKm || 1.5, want = opts.sites || 8;
        const picks = [];
        for (const i of order) {
            if (picks.length >= want) break;
            if (picks.some(j => Math.hypot((g.row[i] - g.row[j]) * g.dy, (g.col[i] - g.col[j]) * g.dx) < spacing)) continue;
            picks.push(i);
        }
        const pop = c['population.population'];
        const served = new Uint8Array(g.n);
        if (P.serveKm) for (const i of picks) for (const [a, b] of g.offsets(P.serveKm)) { const j = g.cellAt(i, a, b); if (j >= 0) served[j] = 1; }
        else for (const i of picks) served[i] = 1;
        const reach = _sumOver(pop, idx, i => served[i] === 1);
        const sites = picks.map((i, r) => {
            const parts = crit.map((x, k) => ({ label: x.label, value: x.values[i], part: weights[k] * (ranks[k][i] || 0) }))
                .sort((a, b) => b.part - a.part).slice(0, 2);
            return { rank: r + 1, code: g.codes[i], score: _round(score[i]), people: Math.round(pop[i] || 0),
                why: parts.map(p => `${p.label} ${_fin(p.value) ? _round(p.value, 1) : '–'}`).join('; ') };
        });
        const key = `suit_${presetId}`;
        const field = { key, label: `${P.title} suitability`, unit: '0-100', higherIs: 'better', ramp: 'viridis' };
        const lay = { level: fr.level, cells: [], columns: { [key]: [] } };
        idx.filter(i => _fin(score[i])).sort((a, b) => (g.codes[a] < g.codes[b] ? -1 : 1)).forEach(i => { lay.cells.push(g.codes[i]); lay.columns[key].push(_round(score[i], 1)); });
        const srcIds = new Set(['population', ...SITING_NEEDS.map(k => k.split('.')[0])]);
        return {
            id: 'siting', preset: presetId, title: `Siting: ${P.title}`, icon: P.icon, question: `Where should the next ${P.title.toLowerCase().replace(/^new /, '')} go?`,
            fields: [field], sites,
            weights: crit.map((x, k) => ({ label: x.label, weight: _round(weights[k], 3), direction: x.dir > 0 ? 'higher is better' : 'lower is better' })),
            consistency: _round(cr, 3),
            headline: picks.length
                ? `The ${picks.length} best-placed sites (≥ ${spacing} km apart) favour ${P.why}; `
                    + (P.serveKm ? `together they would sit within ${P.serveKm} km of ${_people(reach)} residents.` : `their cells hold ${_people(reach)} residents.`)
                : 'No cell passes the constraints.',
            stats: [
                ...crit.map((x, k) => ({ label: `Weight: ${x.label} (${x.dir > 0 ? '↑' : '↓'})`, value: `${Math.round(100 * weights[k])}%` })),
                { label: 'AHP consistency ratio', value: `${_round(cr, 3)} ${cr <= 0.1 ? '(consistent)' : '(review weights)'}` },
            ],
            method: `Weighted-overlay multi-criteria decision analysis: each criterion is a within-city percentile rank (direction-corrected), weighted by AHP from a pairwise comparison matrix (consistency ratio ${_round(cr, 3)}); flood-prone cells (hazard ≥ 60) are excluded where it matters. Candidate sites are the top-scoring cells at least ${spacing} km apart.`,
            refs: 'Saaty 1980 (AHP); Malczewski 2006 (GIS-MCDA); Luo & Qi 2009 for the access term',
            sources: result.sources.filter(x => srcIds.has(x.id)).map(x => x.id),
            equity: null, hotspots: null, missing: [],
            layer: {
                spec: { id: opts.layerId || 'siting', title: `Siting: ${P.title} · ${result.cityLabel}`, description: P.why, source: 'js/urban-lenses.js',
                    license: 'Derived from the cell store', group: 'Urban lenses', level: fr.level,
                    fields: [{ key, label: field.label, type: 'number', agg: 'max', unit: '0-100', ramp: 'viridis', higherIs: 'better' }],
                    default: { field: key, extrude: true, heightM: 600 } },
                table: lay,
            },
        };
    }

    // ── spatial statistics ──────────────────────────────────────────────────

    /**
     * Hotspot statistics of `values` over `idx` on grid `g`, binary weights
     * within `km`. Returns global Moran's I (normal approximation), Gi* z per
     * cell and LISA classes (1 HH, 2 LL, 3 HL, 4 LH, 0 not significant) from
     * a seeded conditional permutation test.
     */
    function hotspots(g, values, idx, opts = {}) {
        const km = opts.km || BAND_KM, perms = opts.permutations ?? 0, alpha = opts.alpha || 0.05;
        const off = g.offsets(km).filter(([a, b]) => a || b);
        const use = idx.filter(i => _fin(values[i]));
        const n = use.length;
        const empty = { n, moranI: null, z: null, reading: 'Not enough data', gi: null, lisa: null, hot: [], cold: [] };
        if (n < 10) return empty;
        const pos = new Int32Array(g.n).fill(-1);
        use.forEach((i, p) => { pos[i] = p; });
        let mean = 0;
        for (const i of use) mean += values[i];
        mean /= n;
        let m2 = 0;
        for (const i of use) m2 += (values[i] - mean) ** 2;
        const sd = Math.sqrt(m2 / n);
        if (!(sd > 0)) return { ...empty, reading: 'No variation' };
        const z = new Float64Array(n);
        use.forEach((i, p) => { z[p] = (values[i] - mean) / sd; });
        const nb = use.map(i => {
            const out = [];
            for (const [a, b] of off) {
                const j = g.cellAt(i, a, b);
                if (j >= 0 && pos[j] >= 0) out.push(pos[j]);
            }
            return out;
        });
        // Global Moran's I, row-standardised weights (as PySAL's default), so
        // I sits in about [-1, 1]; normal-approximation z.
        let num = 0;
        for (let p = 0; p < n; p++) {
            const k = nb[p].length;
            if (!k) continue;
            let lag = 0;
            for (const q of nb[p]) lag += z[q];
            num += z[p] * lag / k;
        }
        const S0 = nb.reduce((a, x) => a + (x.length ? 1 : 0), 0);
        const I = S0 ? num / S0 : null;   // Σz² = n; (n/S0)·Σwzz/Σz²
        let zI = null;
        if (S0 > 2) {
            let S1 = 0, S2 = 0;
            for (let p = 0; p < n; p++) {
                const k = nb[p].length;
                let col = 0;
                for (const q of nb[p]) {
                    const w = 1 / k + 1 / (nb[q].length || 1);
                    S1 += w * w / 2;
                    col += 1 / (nb[q].length || 1);
                }
                S2 += ((k ? 1 : 0) + col) ** 2;
            }
            const E = -1 / (n - 1);
            const v = (n * n * S1 - n * S2 + 3 * S0 * S0) / ((n * n - 1) * S0 * S0) - E * E;
            zI = v > 0 ? (I - E) / Math.sqrt(v) : null;
        }
        // Gi* (self included).
        const gi = new Float64Array(g.n).fill(NaN);
        const hot = [], cold = [];
        for (let p = 0; p < n; p++) {
            const W = nb[p].length + 1;
            let s = values[use[p]];
            for (const q of nb[p]) s += values[use[q]];
            const den = sd * Math.sqrt((n * W - W * W) / (n - 1));
            const gz = den > 0 ? (s - mean * W) / den : 0;
            gi[use[p]] = gz;
            if (gz >= 1.96) hot.push(use[p]); else if (gz <= -1.96) cold.push(use[p]);
        }
        // LISA with conditional permutations.
        const lisa = new Int8Array(g.n);
        if (perms > 0) {
            const rnd = _rng(opts.seed || 12345);
            for (let p = 0; p < n; p++) {
                const k = nb[p].length;
                if (!k) continue;
                let lag = 0;
                for (const q of nb[p]) lag += z[q];
                lag /= k;
                const Ii = z[p] * lag;
                let extreme = 0;
                for (let r = 0; r < perms; r++) {
                    let s = 0;
                    for (let t = 0; t < k; t++) {
                        let q = Math.floor(rnd() * (n - 1));
                        if (q >= p) q++;
                        s += z[q];
                    }
                    const Ir = z[p] * s / k;
                    if (Ii >= 0 ? Ir >= Ii : Ir <= Ii) extreme++;
                }
                if ((extreme + 1) / (perms + 1) > alpha) continue;
                lisa[use[p]] = z[p] >= 0 ? (lag >= 0 ? 1 : 3) : (lag < 0 ? 2 : 4);
            }
        }
        const reading = zI == null ? 'Not enough neighbours'
            : zI > 2.58 ? (I > 0.5 ? 'Strongly clustered' : 'Clustered')
                : zI > 1.96 ? 'Mildly clustered'
                    : zI < -1.96 ? 'Dispersed (checkerboard)' : 'No significant clustering';
        const counts = { HH: 0, LL: 0, HL: 0, LH: 0 };
        for (const i of use) { const L = lisa[i]; if (L) counts[['', 'HH', 'LL', 'HL', 'LH'][L]]++; }
        return { n, moranI: _round(I, 3), z: _round(zI, 2), reading, gi, lisa, hot, cold, lisaCounts: counts, km };
    }

    // ── run ─────────────────────────────────────────────────────────────────

    /**
     * Run lenses for a city. opts: { only: [ids], hotspots: true, permutations (LISA; 0 = Gi* and Moran only) }.
     * Returns { schema, city, cityLabel, lenses: [...], layer, sources, missing }.
     */
    async function run(city, store, opts = {}) {
        const ids = (opts.only && opts.only.length ? opts.only : LENSES.map(l => l.id));
        const want = new Set(ids);
        for (const id of ids) for (const a of (BY_ID.get(id) || {}).after || []) want.add(a);
        const order = LENSES.filter(l => want.has(l.id));
        const fr = opts.frame || await frame(city, store, allNeeds(order.map(l => l.id)));
        const done = {};
        const out = [];
        const layerCols = {};
        const pop = fr.cols['population.population'];
        for (const L of order) {
            // One lens per task: the whole run is ~1 s of maths on a big city.
            if (L !== order[0]) await _breathe();
            const r = RUN[L.id](fr, done);
            if (!r) continue;
            done[L.id] = r;
            if (!ids.includes(L.id)) continue;
            const key = L.equityKey || L.field.key, v = r.columns[key];
            const eqIdx = r.idx.filter(i => _fin(v[i]));
            const equity = !L.equity ? null : {
                gini: _round(gini(v, pop, eqIdx), 3),
                lorenz: lorenz(v, pop, eqIdx, 10),
                palma: _round(palma(v, pop, eqIdx), 2),
                mean: _round(wmean(v, pop, eqIdx), 2),
            };
            const hsKey = r.weightKey || key;
            const hs = opts.hotspots === false || r.noHotspots ? null : hotspots(fr.grid, r.columns[hsKey], r.idx, { permutations: opts.permutations ?? 0 });
            const fields = [L.field, ...(L.extra || [])].map(f => (r.categories && r.categories[f.key] ? { ...f, ...r.categories[f.key] } : f));
            for (const f of fields) if (r.columns[f.key]) layerCols[f.key] = r.columns[f.key];
            const srcIds = new Set(L.needs.map(k => k.split('.')[0]).concat(L.after ? L.after.flatMap(a => BY_ID.get(a).needs.map(k => k.split('.')[0])) : []).concat(['population']));
            out.push({
                id: L.id, title: L.title, icon: L.icon, question: L.question, method: L.method, refs: L.refs,
                fields, headline: r.headline, stats: r.stats, equity, fit: r.fit || null, series: r.series || null, metric: r.metric || null,
                hotspots: hs ? { field: hsKey, moranI: hs.moranI, z: hs.z, reading: hs.reading, km: hs.km,
                    hot: hs.hot.map(i => fr.grid.codes[i]), cold: hs.cold.map(i => fr.grid.codes[i]), lisa: hs.lisaCounts } : null,
                sources: fr.sources.filter(s => srcIds.has(s.id)).map(s => s.id),
                missing: fr.missing.filter(k => L.needs.includes(k)),
            });
        }
        // The layer: residents' cells only, so farmland stays unpainted.
        const res = _residents(fr);
        const layer = { level: fr.level, cells: res.map(i => fr.grid.codes[i]), columns: {} };
        for (const [k, v] of Object.entries(layerCols)) layer.columns[k] = res.map(i => (_fin(v[i]) ? _round(v[i], 3) : null));
        const result = {
            schema: SCHEMA, kind: 'lenses', city: fr.city, cityLabel: UrbanInsights.cityLabel(fr.city),
            ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            residents: Math.round(_sumOver(pop, res, () => true)), cells: res.length,
            lenses: out, layer, sources: fr.sources, missing: fr.missing,
        };
        Object.defineProperty(result, '_work', { value: { frame: fr, done }, enumerable: false });
        return result;
    }

    /**
     * Local Moran's I clusters for one lens of a run, with a seeded
     * permutation test (99 draws): { HH, LL, HL, LH } → [codes].
     */
    function clusters(result, lensId, opts = {}) {
        const w = result && result._work;
        const lens = result && result.lenses.find(l => l.id === lensId);
        if (!w || !lens || !w.done[lensId]) return null;
        const r = w.done[lensId];
        const key = (lens.hotspots && lens.hotspots.field) || lens.fields[0].key;
        const hs = hotspots(w.frame.grid, r.columns[key], r.idx, { permutations: opts.permutations ?? 99, seed: opts.seed });
        const out = { field: key, moranI: hs.moranI, z: hs.z, reading: hs.reading, HH: [], LL: [], HL: [], LH: [] };
        const names = ['', 'HH', 'LL', 'HL', 'LH'];
        if (hs.lisa) for (const i of r.idx) if (hs.lisa[i]) out[names[hs.lisa[i]]].push(w.frame.grid.codes[i]);
        return out;
    }

    /** The runtime cell-store dataset for a run (id 'lenses'). */
    function toLayer(result, id = 'lenses', only = null) {
        if (!result || !result.layer || !result.layer.cells.length) return null;
        const fields = [];
        for (const l of result.lenses.filter(x => !only || only.includes(x.id))) for (const f of l.fields) {
            if (!result.layer.columns[f.key] || fields.some(x => x.key === f.key)) continue;
            if (f.type === 'category') {
                fields.push({ key: f.key, label: f.label, type: 'category', agg: 'mode', domain: f.domain.slice().sort(), colors: f.colors });
                continue;
            }
            fields.push({ key: f.key, label: f.label, type: 'number', agg: f.unit === 'people' ? 'sum' : 'mean', unit: f.unit,
                ramp: f.ramp, higherIs: f.higherIs || undefined });
        }
        if (!fields.length) return null;
        const order = result.layer.cells.map((c, i) => i).sort((a, b) => (result.layer.cells[a] < result.layer.cells[b] ? -1 : 1));
        const columns = {};
        for (const f of fields) {
            const src = result.layer.columns[f.key];
            const names = f.type === 'category' ? result.lenses.flatMap(l => l.fields).find(x => x.key === f.key).domain : null;
            columns[f.key] = order.map(i => (names ? (src[i] == null ? null : names[src[i]]) : src[i]));
        }
        return {
            spec: { id, title: `Urban lenses: ${result.cityLabel}`, description: 'Heat vulnerability, flood exposure, 15-minute access, healthcare access, air exposure, night lights and compound risk, computed in the browser.',
                source: 'js/urban-lenses.js', license: 'Derived from the cell store', group: 'Urban lenses', level: result.layer.level,
                fields, default: { field: fields[0].key, extrude: true, heightM: 600 } },
            table: { level: result.layer.level, cells: order.map(i => result.layer.cells[i]), columns },
        };
    }

    /** Plain-text summary (DISHA, copy). */
    function toText(result, ids) {
        const ls = result.lenses.filter(l => !ids || ids.includes(l.id));
        return [`Urban lenses for ${result.cityLabel} (${_people(result.residents)} residents):`,
            ...ls.map(l => `- ${l.title}: ${l.headline}${l.equity && l.equity.gini != null ? ` Gini ${l.equity.gini}.` : ''}${l.hotspots && l.hotspots.moranI != null ? ` ${l.hotspots.reading} (Moran’s I ${l.hotspots.moranI}).` : ''}`)].join('\n');
    }

    /**
     * Every lens read for one area (a DIGIPIN prefix, e.g. the ~1 km cell of
     * a selection) against its city: population-weighted area value, city
     * value, the share of the city's residents doing better, and residents
     * in the area. Rows: [{ id, title, key, label, unit, higherIs, area,
     * city, betterThan, worseThan, people }].
     */
    function areaProfile(result, prefix) {
        const w = result && result._work;
        if (!w || !prefix) return null;
        const p = String(prefix).replace(/-/g, '').toUpperCase();
        const fr = w.frame, g = fr.grid, pop = fr.cols['population.population'];
        const res = _residents(fr);
        const inA = res.filter(i => g.codes[i].startsWith(p));
        if (!inA.length) return { prefix: p, people: 0, rows: [] };
        const rows = [];
        for (const l of result.lenses) {
            const f = l.fields[0];
            if (f.type === 'category' || !w.done[l.id]) continue;
            const v = w.done[l.id].columns[f.key];
            const a = wmean(v, pop, inA), cty = wmean(v, pop, res);
            if (a == null || cty == null) continue;
            let lo = 0, hi = 0, tot = 0;
            for (const i of res) {
                if (!_fin(v[i]) || !(pop[i] > 0)) continue;
                tot += pop[i];
                if (v[i] < a) lo += pop[i]; else if (v[i] > a) hi += pop[i];
            }
            const better = f.higherIs === 'worse' ? lo : f.higherIs === 'better' ? hi : null;
            rows.push({ id: l.id, title: l.title, icon: l.icon, key: f.key, label: f.label, unit: f.unit, higherIs: f.higherIs || null,
                area: _round(a, 2), city: _round(cty, 2), betterThan: better == null || !tot ? null : _round(100 * (1 - better / tot)),
                people: Math.round(_sumOver(pop, inA, () => true)) });
        }
        return { prefix: p, cells: inA.length, people: Math.round(_sumOver(pop, inA, () => true)), rows };
    }

    /**
     * Rank a city on every lens metric in a league file
     * (data/lenses/league.json, scripts/build_lens_league.js). Rank 1 is
     * best. Returns [{ id, label, value, unit, higherIs, rank, of, best, worst }].
     */
    function leagueFor(league, city) {
        const me = league && league.cities && league.cities[city];
        if (!me) return [];
        const out = [];
        for (const [id, m] of Object.entries(me.metrics)) {
            const rows = Object.entries(league.cities).map(([name, c]) => ({ name, label: c.label, v: c.metrics[id] && c.metrics[id].value }))
                .filter(x => _fin(x.v));
            if (rows.length < 2) continue;
            const sign = m.higherIs === 'worse' ? 1 : -1;
            rows.sort((x, y) => sign * (x.v - y.v));
            const rank = rows.findIndex(x => x.name === city) + 1;
            out.push({ id, label: m.label, value: m.value, unit: m.unit, higherIs: m.higherIs, rank, of: rows.length,
                best: { city: rows[0].label, value: rows[0].v }, worst: { city: rows[rows.length - 1].label, value: rows[rows.length - 1].v } });
        }
        return out;
    }

    // ── stable entry points (agents, DISHA, other modules) ──────────────────

    /** The lens catalogue: [{ id, title, question, method, refs, fields, params }]. */
    function catalog() {
        return [
            ...LENSES.map(l => ({ id: l.id, title: l.title, icon: l.icon, question: l.question, method: l.method, refs: l.refs,
                fields: [l.field, ...(l.extra || [])].map(f => f.key), params: {} })),
            { id: 'siting', title: 'Siting suitability', icon: '📍', question: 'Where should the next facility go?',
                method: 'Weighted-overlay MCDA with AHP weights; see siting presets.', refs: 'Saaty 1980; Malczewski 2006',
                fields: Object.keys(PRESETS).map(k => `suit_${k}`),
                params: { preset: Object.keys(PRESETS), sites: 'number (default 8)', spacingKm: 'number (default 1.5)' } },
        ];
    }

    const LENS_SCHEMA = 'digipin.lens/1';

    /**
     * Run one lens for a city: the contract other modules wrap.
     *   await UrbanLenses.lens('heat', 'delhi')
     *   await UrbanLenses.lens('siting', 'pune', null, { preset: 'clinic' })
     * Returns { schema, id, title, question, city, cityLabel, ranAt, headline,
     * findings: [{ label, value }], stats, equity, hotspots, sites?, weights?,
     * method, refs, sources: [source cards], layer: { spec, table }, text }.
     */
    async function lens(id, city, store, opts = {}) {
        store = _store(store);
        if (id === 'siting') {
            const base = opts.base || await run(city, store, { only: ['heat', 'flood', 'health', 'fifteen', 'walk'], hotspots: false, now: opts.now });
            const st = site(base, opts.preset || 'clinic', opts);
            if (!st) throw new Error(`Unknown or empty siting preset: ${opts.preset}`);
            return _report(base, st, st.layer, opts);
        }
        if (!BY_ID.has(id)) throw new Error(`Unknown lens: ${id}`);
        const r = opts.base || await run(city, store, { only: [id], now: opts.now });
        const l = r.lenses.find(x => x.id === id);
        if (!l) throw new Error(`${BY_ID.get(id).title} needs data ${UrbanInsights.cityLabel(city)} does not have.`);
        return _report(r, l, toLayer(r, opts.layerId || `lens_${id}`, [id]), opts);
    }

    function _report(r, l, layer, opts) {
        const findings = l.stats.map(s => ({ label: s.label, value: s.value }));
        if (l.equity && l.equity.gini != null) findings.push({ label: 'Gini across residents', value: String(l.equity.gini) });
        if (l.hotspots && l.hotspots.moranI != null) findings.push({ label: 'Spatial pattern', value: `${l.hotspots.reading} (Moran’s I ${l.hotspots.moranI})` });
        if (l.sites) l.sites.forEach(x => findings.push({ label: `Site ${x.rank}: ${x.code}`, value: `score ${x.score}; ${x.why}` }));
        const sources = r.sources.filter(x => l.sources.includes(x.id));
        return {
            schema: LENS_SCHEMA, id: l.id, preset: l.preset || null, title: l.title, question: l.question,
            city: r.city, cityLabel: r.cityLabel, ranAt: (opts.now ? opts.now() : new Date()).toISOString(),
            headline: l.headline, findings, stats: l.stats, equity: l.equity || null, hotspots: l.hotspots || null,
            sites: l.sites || null, weights: l.weights || null, consistency: l.consistency ?? null,
            method: l.method, refs: l.refs, sources, layer,
            text: `${l.title} — ${r.cityLabel}: ${l.headline}\n${findings.map(f => `- ${f.label}: ${f.value}`).join('\n')}\nMethod: ${l.method}`,
        };
    }

    return {
        SCHEMA, LENS_SCHEMA, LENSES, PRESETS, ESSENTIALS, CELL_DEG, GHI,
        catalog, lens, site, areaProfile, leagueFor, ahp, within,
        prank, wmean, wquantile, gini, lorenz, palma, ols, pearson, grid, frameFrom, frame, allNeeds,
        e2sfca, walkNet, pedShed, DIRS, kmeans, silhouette, archetypeName, hotspots, run, clusters, toLayer, toText,
        _lenses: RUN,
    };
})();

if (typeof window !== 'undefined') {
    window.UrbanLenses = UrbanLenses;
}
