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

    /** Build the download filename for a format + DIGIPIN code. */
    function filename(format, code) {
        const clean = (code || 'cell').replace(/-/g, '');
        // CAD footprint tabs export the visible buildings, not the cell-data object.
        if (format === 'footgeo') return `digipin_footprints_${clean}.geojson`;
        if (format === 'footdxf') return `digipin_footprints_${clean}.dxf`;
        const ext = format === 'csv' ? 'csv' : format === 'geojson' ? 'geojson' : 'json';
        const suffix = format === 'dtdl' ? '_twin' : '';
        return `digipin_${clean}${suffix}.${ext}`;
    }

    /** Live count of exportable building footprints (0 when none visible). */
    function _footprintCount() {
        return (typeof FootprintExport !== 'undefined' && FootprintExport.count)
            ? FootprintExport.count() : 0;
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
        {
            id: 'dtdl', label: 'Digital Twin',
            desc: 'DTDL / RealEstateCore twin graph — imports into Azure Digital Twins Explorer',
            items: (s, cell, data) => {
                if (typeof DTDLExport === 'undefined') return ['DTDL exporter unavailable'];
                const d = DTDLExport.summarize(cell, data);
                return [
                    `${d.twins} twins · ${d.buildings} buildings, ${d.levels} levels`,
                    `${d.capabilities} capabilities, ${d.assets} assets`,
                    `${d.relationships} relationships (hasPart / hasCapability / hasAsset)`,
                    `${d.models} DTDL models, RealEstateCore-aligned`,
                ];
            },
            link: () => (typeof DTDLExport !== 'undefined')
                ? { href: DTDLExport.ADT_EXPLORER_URL, label: 'Open Azure Digital Twins Explorer ↗ — then Import Graph → this file' }
                : null,
        },
        {
            id: 'footgeo', label: 'CAD GeoJSON',
            desc: 'Visible 3D building footprints (+ heights) + the cell — for QGIS / Rhino / AutoCAD',
            items: (s, cell) => {
                const n = _footprintCount();
                return n > 0
                    ? [`${n.toLocaleString()} building footprints (with heights)`, `1 DIGIPIN cell polygon (${cell.code})`]
                    : ['0 building footprints visible', 'Enable the Buildings overlay and zoom in first'];
            },
        },
        {
            id: 'footdxf', label: 'CAD DXF',
            desc: 'Same footprints as a DXF drawing (thickness = height) — opens directly in AutoCAD / Rhino',
            items: (s, cell) => {
                const n = _footprintCount();
                return n > 0
                    ? [`${n.toLocaleString()} closed polylines on layer BUILDINGS`, `1 cell polyline on layer DIGIPIN (${cell.code})`]
                    : ['0 building footprints visible', 'Enable the Buildings overlay and zoom in first'];
            },
        },
    ];

    /** Dispatch the chosen format to the matching DataFetcher/DTDLExport writer. */
    function _doExport(format, cell, data) {
        const name = filename(format, cell.code);
        if (format === 'footgeo' || format === 'footdxf') {
            if (typeof FootprintExport === 'undefined') {
                if (typeof App !== 'undefined') App.showToast('Export', 'Footprint exporter unavailable', 'error');
                return;
            }
            FootprintExport.exportFormat(format === 'footdxf' ? 'dxf' : 'geojson', cell);
            return;
        }
        if (format === 'geojson') {
            DataFetcher.exportToGeoJSON({ code: cell.code, scores: data.scores }, name);
        } else if (format === 'csv') {
            DataFetcher.exportToCSV(data, name);
        } else if (format === 'dtdl') {
            // Never silently fall back to plain JSON under a _twin filename.
            if (typeof DTDLExport === 'undefined') {
                if (typeof App !== 'undefined') App.showToast('Export', 'Digital Twin exporter unavailable', 'error');
                return;
            }
            DTDLExport.download(cell, data, name);
        } else {
            DataFetcher.exportToJSON(data, name);
        }
    }

    /** Remove the export dialog from the DOM if open. */
    function close() {
        document.getElementById('export-dialog-backdrop')?.remove();
    }

    /** Build and show the export dialog (tabs, summary, filename, Export button). */
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

        /** Re-render the body for the active format tab (desc, items, link, filename). */
        function render() {
            const fmt = FORMATS.find(f => f.id === active);
            tabs.querySelectorAll('.ed-tab').forEach(t =>
                t.classList.toggle('active', t.dataset.fmt === active));
            while (body.firstChild) body.removeChild(body.firstChild);
            const desc = document.createElement('div');
            desc.className = 'ed-desc';
            desc.textContent = fmt.desc;
            body.appendChild(desc);
            fmt.items(summary, cell, data).forEach(line => {
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
            // Optional per-format external link (e.g. open ADT Explorer).
            const link = typeof fmt.link === 'function' ? fmt.link() : null;
            if (link && link.href) {
                const a = document.createElement('a');
                a.className = 'ed-link';
                a.href = link.href;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = link.label || link.href;
                body.appendChild(a);
            }
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
