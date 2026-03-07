/**
 * Query & Analytics Engine — Smart Urban Planning Queries
 * Organized into sectors with weighted scoring and parallel execution
 */

const QueryEngine = (() => {
    // ===== QUERY SECTORS =====
    const SECTORS = [
        {
            id: 'commercial',
            name: 'Commercial & Business',
            icon: '🏢',
            queries: [
                { id: 'mall', name: 'Best Mall Location', icon: '🏬', desc: 'High commercial activity, connectivity, foot traffic', weights: { commercial: 3, connectivity: 2, walkability: 2, population_proxy: 2, entertainment_score: 1 } },
                { id: 'restaurant', name: 'Restaurant Hotspot', icon: '🍕', desc: 'Foot traffic, food diversity, entertainment zone', weights: { food_diversity: 3, commercial: 2, walkability: 2, entertainment_score: 2, population_proxy: 1 } },
                { id: 'ithub', name: 'IT Hub Potential', icon: '💻', desc: 'Coworking, IT offices, digital readiness', weights: { digital_readiness: 3, connectivity: 2, commercial: 2, infra_maturity: 2 } },
                { id: 'realestate', name: 'Real Estate Growth', icon: '📈', desc: 'Construction activity, vacant land, rising infra', weights: { real_estate_growth: 3, investment: 3, connectivity: 2, infra_maturity: 2 } },
                { id: 'banking', name: 'Banking Desert', icon: '🏦', desc: 'Low ATM/bank coverage, high population', weights: { population_proxy: 3, commercial: 1, investment: -2 } },
                { id: 'hotel', name: 'Hotel Opportunity', icon: '🏨', desc: 'Tourism demand, low accommodation, connectivity', weights: { tourism: 3, connectivity: 2, entertainment_score: 1, commercial: 1 } },
                { id: 'coworking', name: 'Coworking Space Gap', icon: '🪑', desc: 'IT presence but low coworking supply', weights: { digital_readiness: 3, commercial: 2, connectivity: 2, population_proxy: 1 } },
                { id: 'retail', name: 'Retail Expansion Zone', icon: '🛒', desc: 'High residential, low retail supply', weights: { population_proxy: 3, walkability: 2, commercial: -1, connectivity: 1 } },
            ]
        },
        {
            id: 'residential',
            name: 'Residential & Living',
            icon: '🏠',
            queries: [
                { id: 'best_residential', name: 'Best Residential Area', icon: '🏠', desc: 'Green, healthcare, safety, low noise', weights: { livability: 3, green: 3, healthcare_access: 2, safety: 2, noise_estimate: 2 } },
                { id: 'family', name: 'Family Neighborhood', icon: '👨‍👩‍👧‍👦', desc: 'Schools, parks, safety, healthcare', weights: { education_score: 3, safety: 3, green: 3, healthcare_access: 2, noise_estimate: 2, walkability: 2, food_diversity: 1, flood_risk: -2 } },
                { id: 'senior', name: 'Senior Living', icon: '🏡', desc: 'Healthcare, quiet, green, public services', weights: { healthcare_access: 3, noise_estimate: 3, green: 3, safety: 2, public_service: 2, walkability: 2, connectivity: 1, flood_risk: -2 } },
                { id: 'student', name: 'Student Hub', icon: '🎓', desc: 'Near colleges, affordable food, connectivity', weights: { education_score: 3, food_diversity: 2, connectivity: 2, digital_readiness: 1, walkability: 2 } },
                { id: 'luxury', name: 'Luxury Living', icon: '💎', desc: 'Low density, green, safety, premium amenities', weights: { green: 3, safety: 3, noise_estimate: 3, livability: 2, entertainment_score: 1, commercial: -1 } },
                { id: 'affordable', name: 'Affordable Housing', icon: '🏘️', desc: 'Moderate infra, public transport, services', weights: { connectivity: 3, public_service: 2, walkability: 2, healthcare_access: 1, commercial: -2, livability: 1 } },
            ]
        },
        {
            id: 'infrastructure',
            name: 'Infrastructure & Utilities',
            icon: '🛤️',
            queries: [
                { id: 'ev', name: 'EV Charging Gaps', icon: '⚡', desc: 'High vehicles, low EV infrastructure', weights: { connectivity: 2, commercial: 2, digital_readiness: -1, population_proxy: 2 } },
                { id: 'transit', name: 'Transit Improvement', icon: '🚇', desc: 'High population, low public transport', weights: { population_proxy: 3, connectivity: -2, walkability: -1, commercial: 1 } },
                { id: 'smart_city', name: 'Smart City Readiness', icon: '🌐', desc: 'Digital infra, cell towers, connectivity', weights: { digital_readiness: 3, connectivity: 2, infra_maturity: 2, commercial: 1 } },
                { id: 'road_upgrade', name: 'Road Upgrade Needed', icon: '🚧', desc: 'High traffic, low road quality', weights: { connectivity: -2, population_proxy: 3, commercial: 2, walkability: -1 } },
                { id: 'parking', name: 'Parking Deficit', icon: '🅿️', desc: 'Commercial area with low parking', weights: { commercial: 3, connectivity: 2, population_proxy: 1, walkability: -1 } },
                { id: 'street_light', name: 'Lighting Gaps', icon: '💡', desc: 'Low street lighting in populated areas', weights: { population_proxy: 3, safety: -2, infra_maturity: -1, connectivity: 1 } },
            ]
        },
        {
            id: 'social',
            name: 'Social & Public Services',
            icon: '🏛️',
            queries: [
                { id: 'school', name: 'School Location', icon: '🏫', desc: 'Residential density, safety, parks', weights: { population_proxy: 3, safety: 3, green: 2, noise_estimate: 2, education_score: -1 } },
                { id: 'hospital', name: 'Hospital Needed', icon: '🏥', desc: 'Low healthcare, high population', weights: { population_proxy: 3, healthcare_access: -3, connectivity: 2 } },
                { id: 'green', name: 'Green Space Deficit', icon: '🌿', desc: 'Low green index, high population', weights: { population_proxy: 3, green: -3, livability: -1 } },
                { id: 'community_center', name: 'Community Center Gap', icon: '🏘️', desc: 'Population without community spaces', weights: { population_proxy: 3, public_service: -2, entertainment_score: -1, safety: 1 } },
                { id: 'waste_mgmt', name: 'Waste Management Gap', icon: '♻️', desc: 'Dense areas lacking waste facilities', weights: { population_proxy: 3, commercial: 2, public_service: -2, infra_maturity: -1 } },
                { id: 'fire_coverage', name: 'Fire Station Coverage', icon: '🚒', desc: 'Low fire coverage in dense areas', weights: { population_proxy: 3, safety: -2, commercial: 1, infra_maturity: -1 } },
            ]
        },
        {
            id: 'tourism_culture',
            name: 'Tourism & Culture',
            icon: '✈️',
            queries: [
                { id: 'tourism', name: 'Tourism Development', icon: '✈️', desc: 'Attractions, heritage, accommodation', weights: { tourism: 3, entertainment_score: 2, connectivity: 2, green: 1 } },
                { id: 'cultural', name: 'Cultural District', icon: '🎭', desc: 'Museums, theatres, historical sites', weights: { entertainment_score: 3, tourism: 3, religious_diversity: 2, walkability: 1 } },
                { id: 'heritage_walk', name: 'Heritage Walk Route', icon: '🏛️', desc: 'Walkable paths through historic areas', weights: { tourism: 3, walkability: 3, entertainment_score: 2, safety: 1, green: 1 } },
                { id: 'nightlife', name: 'Nightlife Zone', icon: '🌙', desc: 'Bars, clubs, restaurants, entertainment', weights: { entertainment_score: 3, food_diversity: 2, commercial: 2, safety: 1, connectivity: 1 } },
                { id: 'pilgrimage', name: 'Pilgrimage Corridor', icon: '🕉️', desc: 'Religious sites, accommodation, food', weights: { religious_diversity: 3, tourism: 2, food_diversity: 1, connectivity: 1, walkability: 1 } },
            ]
        },
        {
            id: 'environment',
            name: 'Environment & Safety',
            icon: '🌍',
            queries: [
                { id: 'flood', name: 'Flood Risk Zones', icon: '🌊', desc: 'Low-lying, near water, poor drainage', weights: { flood_risk: 3, green: -1, infra_maturity: -2 } },
                { id: 'noise_hotspot', name: 'Noise Pollution', icon: '🔊', desc: 'High noise from traffic and industry', weights: { noise_estimate: -3, commercial: 1, connectivity: 1, population_proxy: 1 } },
                { id: 'air_quality', name: 'Air Quality Concern', icon: '😷', desc: 'Industrial areas with high population', weights: { population_proxy: 3, commercial: 2, green: -2, infra_maturity: -1 } },
                { id: 'urban_heat', name: 'Urban Heat Island', icon: '🌡️', desc: 'Dense built-up, low green cover', weights: { population_proxy: 2, commercial: 2, green: -3, infra_maturity: 1 } },
                { id: 'safety_concern', name: 'Safety Concern Zone', icon: '🔒', desc: 'Low safety, low lighting', weights: { safety: -3, population_proxy: 2, connectivity: -1, infra_maturity: -1 } },
                { id: 'water_stress', name: 'Water Stress Area', icon: '💧', desc: 'Low water infra, high population', weights: { population_proxy: 3, infra_maturity: -2, green: -1 } },
            ]
        },
        {
            id: 'real_estate',
            name: 'Real Estate & Development',
            icon: '🏗️',
            queries: [
                { id: 're_highrise', name: 'Highrise Potential', icon: '🏙️', desc: 'Low verticality, good connectivity, high demand', weights: { development_potential: 3, connectivity: 2, commercial: 2, vertical_development: -2, fsi_intensity: -2, population_proxy: 1 } },
                { id: 're_redevelop', name: 'Redevelopment Zone', icon: '🔄', desc: 'Old buildings, dense lowrise, poor materials', weights: { redevelopment_index: 3, building_density: 2, vertical_development: -2, modernization: -2, population_proxy: 1 } },
                { id: 're_premium', name: 'Premium Residential', icon: '💎', desc: 'Open midrise, green, safety, material quality', weights: { material_quality: 3, green: 2, safety: 2, urban_compactness: -1, type_mix: 1, noise_estimate: 2 } },
                { id: 're_commercial_hub', name: 'Commercial Hub', icon: '🏢', desc: 'High FSI, building mix, connectivity', weights: { fsi_intensity: 3, type_mix: 2, commercial: 2, connectivity: 2, building_density: 1 } },
                { id: 're_vacant', name: 'Vacant Land Opportunity', icon: '🌱', desc: 'Low density, development potential, near infra', weights: { development_potential: 3, building_density: -3, connectivity: 2, infra_maturity: 1 } },
                { id: 're_warehouse', name: 'Warehouse / Logistics', icon: '📦', desc: 'Industrial zone, large lowrise, connectivity', weights: { building_density: -1, connectivity: 2, commercial: -1, urban_compactness: -2, infra_maturity: 2 } },
                { id: 're_mixed_use', name: 'Mixed-Use Development', icon: '🏘️', desc: 'Balanced building types, moderate density', weights: { type_mix: 3, height_diversity: 2, walkability: 2, commercial: 1, building_density: 1 } },
                { id: 're_affordable', name: 'Affordable Housing Site', icon: '🏠', desc: 'Low land cost signals, transit access, services', weights: { development_potential: 2, connectivity: 3, public_service: 2, building_density: -2, commercial: -1 } },
            ]
        }
    ];

    let isRunning = false;
    const CONCURRENCY = 5;

    async function runQuery(queryId, onProgress) {
        if (isRunning) return;
        isRunning = true;

        const query = findQuery(queryId);
        if (!query) { isRunning = false; return; }

        const map = MapModule.getMap();
        const bounds = map.getBounds();
        const results = [];

        const gridSize = 5;
        const latStep = (bounds.getNorth() - bounds.getSouth()) / gridSize;
        const lngStep = (bounds.getEast() - bounds.getWest()) / gridSize;

        const points = [];
        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                points.push({
                    lat: bounds.getSouth() + latStep * (i + 0.5),
                    lng: bounds.getWest() + lngStep * (j + 0.5)
                });
            }
        }

        const total = points.length;
        let done = 0;

        for (let batch = 0; batch < total; batch += CONCURRENCY) {
            const chunk = points.slice(batch, batch + CONCURRENCY);

            const batchResults = await Promise.allSettled(
                chunk.map(async (pt) => {
                    const code = DigiPin.encode(pt.lat, pt.lng);
                    const data = await DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400);
                    const score = computeQueryScore(data.scores, query.weights);
                    return { lat: pt.lat, lng: pt.lng, code, score, data };
                })
            );

            batchResults.forEach(r => {
                if (r.status === 'fulfilled') results.push(r.value);
                done++;
                if (onProgress) onProgress(done, total);
            });

            if (batch + CONCURRENCY < total) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        results.sort((a, b) => b.score - a.score);
        MapModule.showHeatmap(results.slice(0, 10));

        isRunning = false;
        return results;
    }

    function findQuery(queryId) {
        for (const sector of SECTORS) {
            const q = sector.queries.find(q => q.id === queryId);
            if (q) return q;
        }
        return null;
    }

    function computeQueryScore(scores, weights) {
        let total = 0;
        let weightSum = 0;

        for (const [key, weight] of Object.entries(weights)) {
            const score = scores[key];
            if (score && score.value !== undefined) {
                total += score.value * weight;
                weightSum += Math.abs(weight);
            }
        }

        return weightSum > 0 ? total / weightSum : 0;
    }

    function getSectors() { return SECTORS; }
    function isQueryRunning() { return isRunning; }

    return { runQuery, getSectors, isQueryRunning, computeQueryScore };
})();
