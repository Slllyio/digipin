/**
 * IntelReport — assembles a ULB-ready intelligence brief for one DigiPin cell
 * from the Feature Store record + composite indices (+ optional live exposure).
 * It is the human-facing summary AND the machine-facing "Intelligence-as-a-Service"
 * payload: build() returns a stable JSON object, toText() a copyable brief.
 *
 * The address always resolves (DigiPin) even when no fused intelligence exists, so
 * the report degrades to an address-only card outside covered regions.
 *
 * Pure + unit-tested.
 *
 *   const rec = await DigiPinIntel.cell(lat, lng);
 *   const report = IntelReport.build(rec);          // IaaS payload
 *   IntelReport.toText(report);                     // copyable brief
 *   IntelReport.toJSON(report);                     // pretty JSON string
 */
const IntelReport = (() => {
    function _features(record) { return (record && record.features) || record || {}; }

    /** Cell area in km² from its bounds (for utility downscaling); undefined → L6 default. */
    function _areaKm2(record) {
        const b = record && record.geometry && record.geometry.bounds;
        if (!b || b.north == null) return undefined;
        const lat = (b.north + b.south) / 2;
        const w = (b.east - b.west) * 111320 * Math.cos(lat * Math.PI / 180);
        const h = (b.north - b.south) * 110540;
        const km2 = (w * h) / 1e6;
        return km2 > 0 ? km2 : undefined;
    }

    /** Derived notable flags from indices + raw fields. Pure. */
    function flags(record, indices) {
        const f = _features(record);
        const ix = indices || (typeof IntelIndices !== 'undefined' ? IntelIndices.all(f) : {});
        const out = [];
        const add = (level, text) => out.push({ level, text });
        const band = id => ix[id] && ix[id].band;
        const val = id => ix[id] && ix[id].value;

        if (band('disasterRisk') === 'High') add('risk', 'High disaster / flood risk');
        if (band('serviceGap') === 'High') add('risk', 'Underserved — thin public services');
        if (val('climateResilience') != null && val('climateResilience') < 40) add('risk', 'Low climate resilience');
        if (band('livability') === 'Strong') add('good', 'Highly livable');
        if (band('investmentPotential') === 'Strong') add('good', 'Strong investment potential');
        if (band('economicVitality') === 'Strong') add('good', 'Vibrant local economy');

        if (+f.flood_risk >= 70) add('risk', 'Flood-prone cell');
        if (+f.green >= 70) add('good', 'Abundant green cover');
        if (+f.noise_estimate >= 70) add('info', 'High ambient noise');
        if (+f.population_proxy >= 70) add('info', 'Densely populated');
        return out;
    }

    /** Assemble the report payload for a Feature Store record. Pure. */
    function build(record, opts = {}) {
        const rec = record || {};
        const features = _features(rec);
        const available = rec.available !== false && features && Object.keys(features).length > 0;
        const indices = opts.indices || (typeof IntelIndices !== 'undefined' ? IntelIndices.all(features) : {});
        const list = Object.values(indices).filter(Boolean);
        const goods = list.filter(i => i.highMeans === 'good' && i.value != null).sort((a, b) => b.value - a.value);
        const risks = list.filter(i => i.highMeans === 'risk' && i.value != null).sort((a, b) => b.value - a.value);
        const head = i => i ? { id: i.id, label: i.label, value: i.value, band: i.band } : null;

        const utilities = (available && typeof UtilityEstimates !== 'undefined')
            ? UtilityEstimates.all(features, { areaKm2: _areaKm2(rec) }) : null;
        const allFlags = flags(rec, indices);
        if (utilities) {
            if (utilities.supplyStress.band === 'High') allFlags.push({ level: 'risk', text: 'High utility supply stress' });
            if (utilities.solarRooftop.offsetPct != null && utilities.solarRooftop.offsetPct >= 60)
                allFlags.push({ level: 'good', text: 'Strong rooftop-solar potential' });
        }

        return {
            schemaVersion: 1,
            generatedBy: 'DigiPin Urban Intelligence',
            digipin: rec.digipin || null,
            location: { center: (rec.geometry && rec.geometry.center) || null, region: rec.region || null },
            available,
            headline: {
                livability: indices.livability ? indices.livability.value : null,
                topStrength: head(goods[0]),
                topRisk: head(risks[0]),
            },
            indices: list.map(i => ({ id: i.id, label: i.label, value: i.value, band: i.band, highMeans: i.highMeans, drivers: i.drivers })),
            flags: allFlags,
            utilities,
            domains: rec.domains || (typeof DigiPinIntel !== 'undefined' ? DigiPinIntel.group(features) : undefined),
            exposure: opts.exposure || null,
        };
    }

    /** Pretty JSON string — the Intelligence-as-a-Service payload. Pure. */
    function toJSON(report) { return JSON.stringify(report, null, 2); }

    /** Compact human brief (copy/print). Pure. */
    function toText(report) {
        if (!report) return '';
        const code = report.digipin ? report.digipin.code : '(unknown cell)';
        const L = [`DigiPin ${code}${report.location && report.location.region ? ' · ' + report.location.region : ''}`];
        if (!report.available) { L.push('Address resolved — no fused intelligence for this cell.'); return L.join('\n'); }
        if (report.headline.livability != null) L.push(`Livability: ${report.headline.livability}`);
        if (report.headline.topStrength) L.push(`Top strength: ${report.headline.topStrength.label} ${report.headline.topStrength.value} (${report.headline.topStrength.band})`);
        if (report.headline.topRisk) L.push(`Top risk: ${report.headline.topRisk.label} ${report.headline.topRisk.value} (${report.headline.topRisk.band})`);
        if (report.exposure && report.exposure.priority) L.push(`Live exposure: ${report.exposure.priority}${report.exposure.exposure != null ? ' (' + report.exposure.exposure + ')' : ''}`);
        if (report.flags && report.flags.length) {
            L.push('Flags:');
            for (const fl of report.flags) L.push(`  - ${fl.text}`);
        }
        if (report.indices && report.indices.length) {
            L.push('Indices: ' + report.indices.filter(i => i.value != null).map(i => `${i.label} ${i.value}`).join(', '));
        }
        if (report.utilities) {
            const u = report.utilities;
            L.push(`Utilities (est): ${u.electricity.kwhPerDay} kWh/day (${u.electricity.carbonKgPerDay} kgCO₂), `
                + `${Math.round(u.water.litresPerDay / 1000)} kL/day water, ${u.waste.kgPerDay} kg/day waste; `
                + `rooftop solar offsets ~${u.solarRooftop.offsetPct}%; supply stress ${u.supplyStress.band}`);
        }
        return L.join('\n');
    }

    /** Convenience: build straight from a lat/lng (async, reads the Feature Store). */
    async function forPoint(lat, lng, opts) {
        if (typeof DigiPinIntel === 'undefined') return null;
        const rec = await DigiPinIntel.cell(lat, lng);
        return build(rec, opts);
    }

    return { flags, build, toJSON, toText, forPoint };
})();

if (typeof window !== 'undefined') window.IntelReport = IntelReport;
