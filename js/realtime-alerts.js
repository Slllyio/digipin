/**
 * RealtimeAlerts — surfaces NDMA SACHET disaster alerts in the portal.
 *
 * Reads data/realtime/ndma_sachet/latest.json (produced by the
 * `python -m scrapers.cli ndma_sachet` job — runs on a cron via
 * .github/workflows/realtime-scrape.yml) and exposes filter helpers.
 *
 * Cache:
 *  - 5-minute in-memory TTL. SACHET publishes new alerts continuously
 *    but a 5-minute reload cadence is more than fast enough for human
 *    consumption and avoids hammering the static file with every cell
 *    click in a single browsing session.
 *
 * No CAP polygon parsing yet — area filtering is substring-based on
 * the headline/description fields the RSS feed exposes. Polygon-based
 * spatial filtering needs a separate scraper pass that follows each
 * alert's CAP-XML link; tracked as a follow-up in scrapers/README.md.
 */

const RealtimeAlerts = (() => {
    const FEED_PATH = 'data/realtime/ndma_sachet/latest.json';
    const TTL_MS = 5 * 60 * 1000;
    const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };

    let _cache = null;
    let _fetchedAt = 0;
    let _inflight = null;

    async function _load() {
        if (_inflight) return _inflight;
        _inflight = (async () => {
            try {
                const resp = await fetch(FEED_PATH, { cache: 'no-store' });
                if (!resp.ok) return [];
                const data = await resp.json();
                _cache = Array.isArray(data.records) ? data.records : [];
                _fetchedAt = Date.now();
                return _cache;
            } catch {
                return [];
            } finally {
                _inflight = null;
            }
        })();
        return _inflight;
    }

    async function getAlerts() {
        if (_cache && Date.now() - _fetchedAt < TTL_MS) return _cache;
        return _load();
    }

    function filterBySeverity(alerts, minLevel = 'Severe') {
        const threshold = SEVERITY_RANK[minLevel] || 3;
        return alerts.filter(a => (SEVERITY_RANK[a.severity] || 0) >= threshold);
    }

    function filterByText(alerts, needle) {
        if (!needle) return alerts;
        const n = String(needle).toLowerCase();
        return alerts.filter(a =>
            (a.area || '').toLowerCase().includes(n) ||
            (a.description || '').toLowerCase().includes(n) ||
            (a.headline || '').toLowerCase().includes(n)
        );
    }

    /** Best-effort: match by state name appearing anywhere in the alert text. */
    async function getForLocation(state, city) {
        const all = await getAlerts();
        if (!state && !city) return [];
        let scoped = all;
        if (state) scoped = filterByText(scoped, state);
        if (city && scoped.length === 0) scoped = filterByText(all, city);
        return scoped;
    }

    function summary(alerts) {
        const byCategory = {};
        const bySeverity = {};
        for (const a of alerts) {
            byCategory[a.category] = (byCategory[a.category] || 0) + 1;
            bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
        }
        return { total: alerts.length, byCategory, bySeverity };
    }

    return { getAlerts, filterBySeverity, filterByText, getForLocation, summary };
})();

if (typeof window !== 'undefined') {
    window.RealtimeAlerts = RealtimeAlerts;
}
