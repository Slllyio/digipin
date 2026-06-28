/**
 * UtilityEstimates — per-DigiPin-cell estimates of utility demand: electricity,
 * water, solid waste, rooftop-solar potential, and a supply-stress signal.
 *
 * Metered utility data isn't public at cell granularity, so these are TRANSPARENT
 * estimates downscaled from the Feature Store's population/activity proxies using
 * standard Indian urban per-capita norms. They are indicative planning figures —
 * NOT meter readings — and the calibration (proxy→population) is disclosed in the
 * `basis` block so a ULB can tune it to local census/consumption data.
 *
 * Norm sources: CPHEEO 135 LPCD water; CPCB ~0.45 kg/capita/day MSW; CEA urban
 * per-capita electricity & grid emission factor; ~5 kWh/m²/day India insolation.
 * If a `night_lights` field (VIIRS, 0-100) is present it nudges the electricity
 * estimate toward observed radiance — the path to satellite-grounded demand.
 *
 * Pure + unit-tested.
 *
 *   UtilityEstimates.all(record.features, { areaKm2 })
 */
const UtilityEstimates = (() => {
    const NORMS = {
        elecKwhPerCapita: 1.2,    // urban residential ~1.2 kWh/person/day (CEA-derived)
        waterLpcd: 135,           // CPHEEO 135 L/capita/day (cities with sewerage)
        wasteKgPerCapita: 0.45,   // CPCB urban MSW ~0.45 kg/capita/day
        gridCO2PerKwh: 0.71,      // India grid emission factor ~0.71 kgCO₂/kWh (CEA)
        solarInsolation: 5.0,     // kWh/m²/day (India average)
        pvPerformance: 0.15,      // module efficiency × performance ratio
        rooftopUsable: 0.22,      // usable fraction of built footprint for PV (after access/tanks/shading)
        commElecUplift: 0.6,      // commercial activity adds up to +60% electricity load
        commWaterUplift: 0.4,
        commWasteUplift: 0.35,
    };
    // Calibration: population_proxy=100 ≈ a dense Indian urban cell (~25k persons/km²).
    const DEFAULTS = { areaKm2: 0.88, maxDensity: 25000 };   // 0.88 km² ≈ a DigiPin L6 cell (~880 m); callers pass real bounds area

    function _n(v, d) { return v == null || !Number.isFinite(+v) ? d : +v; }
    function _band(v) { return v >= 66 ? 'High' : v >= 33 ? 'Moderate' : 'Low'; }

    /** Estimated resident population of the cell from the density proxy. Pure. */
    function population(features, opts = {}) {
        const area = opts.areaKm2 || DEFAULTS.areaKm2;
        const maxD = opts.maxDensity || DEFAULTS.maxDensity;
        return Math.round((_n(features && features.population_proxy, 0) / 100) * maxD * area);
    }

    /** All utility estimates for a feature map. Pure. */
    function all(features, opts = {}) {
        const f = features || {};
        const area = opts.areaKm2 || DEFAULTS.areaKm2;
        const pop = population(f, opts);
        const comm = _n(f.commercial, 0) / 100;
        const nl = f.night_lights != null ? _n(f.night_lights, 50) / 100 : null;   // optional satellite grounding

        const elecMult = Math.max(0.4, 1 + NORMS.commElecUplift * comm + (nl != null ? 0.4 * (nl - 0.5) : 0));
        const elecKwh = Math.round(pop * NORMS.elecKwhPerCapita * elecMult);
        const waterL = Math.round(pop * NORMS.waterLpcd * (1 + NORMS.commWaterUplift * comm));
        const wasteKg = Math.round(pop * NORMS.wasteKgPerCapita * (1 + NORMS.commWasteUplift * comm));

        // relative demand intensity (0-100, independent of the absolute calibration)
        const demandIntensity = Math.round(Math.max(0, Math.min(100,
            0.65 * _n(f.population_proxy, 0) + 0.35 * _n(f.commercial, 0))));

        // building-footprint fraction of the cell, capped at 0.45 (a cell is never all roof)
        const footprintFrac = Math.max(0, Math.min(0.45, (0.6 * _n(f.population_proxy, 0) + 0.4 * _n(f.commercial, 0)) / 100));
        const rooftopM2 = footprintFrac * area * 1e6 * NORMS.rooftopUsable;
        const solarKwh = Math.round(rooftopM2 * NORMS.solarInsolation * NORMS.pvPerformance);

        const carbonKg = Math.round(elecKwh * NORMS.gridCO2PerKwh);
        const supplyStress = Math.round(Math.max(0, Math.min(100,
            0.55 * demandIntensity + 0.45 * (100 - _n(f.infra_maturity, 50)))));

        return {
            populationEst: pop,
            electricity: { kwhPerDay: elecKwh, carbonKgPerDay: carbonKg, relative: demandIntensity, band: _band(demandIntensity), grounded: nl != null },
            water: { litresPerDay: waterL, relative: demandIntensity, band: _band(demandIntensity) },
            waste: { kgPerDay: wasteKg, relative: demandIntensity, band: _band(demandIntensity) },
            solarRooftop: { kwhPerDayPotential: solarKwh, offsetPct: elecKwh ? Math.round(100 * solarKwh / elecKwh) : null },
            demandIntensity,
            supplyStress: { value: supplyStress, band: _band(supplyStress) },
            basis: {
                areaKm2: area, maxDensity: opts.maxDensity || DEFAULTS.maxDensity, norms: NORMS,
                note: 'Indicative estimates downscaled from population/activity proxies using Indian per-capita norms — not metered utility data.',
            },
        };
    }

    return { all, population, NORMS, DEFAULTS };
})();

if (typeof window !== 'undefined') window.UtilityEstimates = UtilityEstimates;
