/**
 * ExportDialog — one Export action, a proper dialog: format tabs
 * (GeoJSON / JSON / CSV) with a contents summary showing real object counts
 * ("23 feature types · 1,204 features", "24 intelligence scores",
 * "1 DIGIPIN cell polygon") and a filename preview, then a single primary
 * Export button. Replaces the three bare JSON/CSV/GeoJSON buttons in the
 * cell panel; the actual writers stay in DataFetcher (exportToJSON/CSV/
 * exportToGeoJSON) — this is purely the choosing surface.
 *
 * summarize()/filename()/FORMATS are pure (unit-tested); open() is DOM.
 */
const ExportDialog = (() => {
    /** Count what an export would contain, from a fetched cell-data object. */
    function summarize(data) {
        let featureTypes = 0;
        let featureTotal = 0;
        for (const cat of Object.values(data?.categories || {})) {
            for (const f of Object.values(cat.features || {})) {
                if (f && f.count > 0) {
                    featureTypes++;
                    featureTotal += f.count;
                }
            }
        }
        const scores = Object.values(data?.scores || {})
            .filter(s => s && typeof s.value === 'number').length;
        const sources = Object.values(data?.sourceStatus || {})
            .filter(s => s === 'loaded').length;
        return { featureTypes, featureTotal, scores, sources };
    }

    function filename(format, code) {
        const clean = (code || 'cell').replace(/-/g, '');
        const ext = format === 'csv' ? 'csv' : format === 'geojson' ? 'geojson' : 'json';
        return `digipin_${clean}.${ext}`;
    }

    // What each format contains, as human lines built from the summary.
    const FORMATS = [
        {
            id: 'geojson', label: 'GeoJSON',
            desc: 'Cell polygon + scores — opens in QGIS, geojson.io, AutoCAD (import)',
            items: (s, cell) => [
                `1 DIGIPIN cell polygon (${cell.code})`,
                `${s.scores} intelligence scores as properties`,
            ],
        },
        {
            id: 'json', label: 'JSON',
            desc: 'The complete raw data object — every source, feature and score',
            items: (s) => [
                `${s.featureTypes} feature types · ${s.featureTotal.toLocaleString()} features`,
                `${s.scores} intelligence scores`,
                s.sources ? `${s.sources} live data sources` : 'all fetched data sections',
            ],
        },
        {
            id: 'csv', label: 'CSV',
            desc: 'Feature counts as rows — for spreadsheets',
            items: (s) => [
                `${s.featureTypes} feature rows (category, key, name, count)`,
            ],
        },
    ];

    function _doExport(format, cell, data) {
        const name = filename(format, cell.code);
        if (format === 'geojson') {
            DataFetcher.exportToGeoJSON({ code: cell.code, scores: data.scores }, name);
        } else if (format === 'csv') {
            DataFetcher.exportToCSV(data, name);
        } else {
            DataFetcher.exportToJSON(data, name);
        }
    }

    function close() {
        document.getElementById('export-dialog-backdrop')?.remove();
    }

    function open(cell, data) {
        close();
        const summary = summarize(data);
        let active = 'geojson';

        const backdrop = document.createElement('div');
        backdrop.id = 'export-dialog-backdrop';
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

        const card = document.createElement('div');
        card.className = 'export-dialog';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-label', 'Export cell data');

        const title = document.createElement('div');
        title.className = 'ed-title';
        title.textContent = 'Export this cell';
        const sub = document.createElement('div');
        sub.className = 'ed-sub';
        sub.textContent = `DIGIPIN ${cell.code}`;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ed-close';
        closeBtn.setAttribute('aria-label', 'Close export dialog');
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', close);

        const tabs = document.createElement('div');
        tabs.className = 'ed-tabs';
        const body = document.createElement('div');
        body.className = 'ed-body';
        const fileEl = document.createElement('div');
        fileEl.className = 'ed-filename';
        const exportBtn = document.createElement('button');
        exportBtn.className = 'ed-export-btn';

        function render() {
            const fmt = FORMATS.find(f => f.id === active);
            tabs.querySelectorAll('.ed-tab').forEach(t =>
                t.classList.toggle('active', t.dataset.fmt === active));
            while (body.firstChild) body.removeChild(body.firstChild);
            const desc = document.createElement('div');
            desc.className = 'ed-desc';
            desc.textContent = fmt.desc;
            body.appendChild(desc);
            fmt.items(summary, cell).forEach(line => {
                const row = document.createElement('div');
                row.className = 'ed-item';
                const tick = document.createElement('span');
                tick.className = 'ed-tick';
                tick.textContent = '✓';
                const txt = document.createElement('span');
                txt.textContent = line;
                row.appendChild(tick);
                row.appendChild(txt);
                body.appendChild(row);
            });
            fileEl.textContent = filename(active, cell.code);
            exportBtn.textContent = `Export ${fmt.label} ⭳`;
        }

        FORMATS.forEach(fmt => {
            const tab = document.createElement('button');
            tab.className = 'ed-tab';
            tab.dataset.fmt = fmt.id;
            tab.textContent = fmt.label;
            tab.addEventListener('click', () => { active = fmt.id; render(); });
            tabs.appendChild(tab);
        });

        exportBtn.addEventListener('click', () => { _doExport(active, cell, data); close(); });

        card.appendChild(closeBtn);
        card.appendChild(title);
        card.appendChild(sub);
        card.appendChild(tabs);
        card.appendChild(body);
        card.appendChild(fileEl);
        card.appendChild(exportBtn);
        backdrop.appendChild(card);
        document.body.appendChild(backdrop);
        render();
    }

    return { open, close, summarize, filename, FORMATS };
})();

if (typeof window !== 'undefined') {
    window.ExportDialog = ExportDialog;
}
