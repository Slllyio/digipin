/**
 * PDF/Report Export — Generates a printable HTML report in a new window
 * Uses browser print dialog (no external dependencies)
 */
const Report = (() => {
    function generate(cell, data) {
        if (!cell || !data) {
            App.showToast('No Data', 'Select a cell first to generate report', 'warning');
            return;
        }

        const addr = data.address || {};
        const env = data.environment || {};
        const scores = data.scores || {};
        const location = [addr.area, addr.city, addr.district, addr.state].filter(Boolean).join(', ');

        const sortedScores = Object.entries(scores)
            .filter(([, s]) => s && s.value !== undefined)
            .sort((a, b) => b[1].value - a[1].value);

        const top3 = sortedScores.slice(0, 3);
        const bottom3 = sortedScores.slice(-3);

        const catSummary = Object.entries(data.categories || {}).map(([, cat]) => {
            const total = Object.values(cat.features || {}).reduce((s, f) => s + (f.count || 0), 0);
            return { name: cat.name, icon: cat.icon, total };
        });

        const date = new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });

        const win = window.open('', '_blank');
        if (!win) {
            App.showToast('Popup Blocked', 'Allow popups for this site to generate reports', 'error');
            return;
        }

        const doc = win.document;

        // Style
        const style = doc.createElement('style');
        style.textContent = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;color:#1e293b;max-width:800px;margin:0 auto;padding:40px 30px;line-height:1.6}
h2{font-size:16px;color:#334155;margin:24px 0 8px;padding-bottom:4px;border-bottom:2px solid #e2e8f0}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0f172a;padding-bottom:16px;margin-bottom:20px}
.digipin{font-family:'Courier New',monospace;font-size:28px;font-weight:bold;color:#7c3aed;letter-spacing:2px}
.coords{font-size:11px;color:#94a3b8;margin-top:2px}
.branding{text-align:right;font-size:11px;color:#94a3b8}
.meta-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:12px 0}
.meta-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;text-align:center}
.meta-val{font-size:22px;font-weight:700;color:#0f172a}
.meta-label{font-size:10px;color:#64748b;text-transform:uppercase}
.score-row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px}
.score-label{width:140px;color:#475569}
.score-bar-bg{flex:1;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden}
.score-bar{height:100%;border-radius:4px}
.score-val{width:30px;text-align:right;font-weight:600;font-family:monospace}
.cat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:8px 0}
.cat-item{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;text-align:center;font-size:12px}
.cat-count{font-size:18px;font-weight:700;color:#7c3aed}
.strengths{color:#16a34a;font-weight:600} .weaknesses{color:#dc2626;font-weight:600}
.footer{margin-top:30px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8;text-align:center}
@media print{body{padding:20px}h2{break-after:avoid}}`;
        doc.head.appendChild(style);
        doc.title = `DigiPin Report - ${cell.code}`;

        // Header
        const header = mk(doc, 'div', 'header');
        const left = mk(doc, 'div');
        left.appendChild(txt(doc, 'div', cell.code, 'digipin'));
        left.appendChild(txt(doc, 'div', `${cell.center.lat.toFixed(6)}\u00b0N, ${cell.center.lng.toFixed(6)}\u00b0E`, 'coords'));
        if (location) left.appendChild(txt(doc, 'div', location, '', 'font-size:13px;color:#475569;margin-top:4px'));
        header.appendChild(left);

        const right = mk(doc, 'div', 'branding');
        const b = doc.createElement('strong');
        b.textContent = 'DigiPin Urban Intelligence';
        right.appendChild(b);
        right.appendChild(doc.createElement('br'));
        right.appendChild(doc.createTextNode('Location Analysis Report'));
        right.appendChild(doc.createElement('br'));
        right.appendChild(doc.createTextNode(date));
        header.appendChild(right);
        doc.body.appendChild(header);

        // Environment
        if (env.temperature != null) {
            doc.body.appendChild(txt(doc, 'h2', 'Environment'));
            const metaGrid = mk(doc, 'div', 'meta-grid');
            if (env.temperature != null) metaGrid.appendChild(metaCard(doc, `${env.temperature}\u00b0C`, 'Temperature'));
            if (env.humidity != null) metaGrid.appendChild(metaCard(doc, `${env.humidity}%`, 'Humidity'));
            if (env.aqi != null) metaGrid.appendChild(metaCard(doc, String(env.aqi), 'AQI'));
            doc.body.appendChild(metaGrid);
        }

        // Scores
        doc.body.appendChild(txt(doc, 'h2', `Intelligence Scores (${sortedScores.length})`));

        const topLine = mk(doc, 'div', '', 'margin:4px 0');
        topLine.appendChild(txt(doc, 'span', 'Top: ', 'strengths'));
        topLine.appendChild(doc.createTextNode(top3.map(([,s]) => `${s.label} (${s.value})`).join(', ')));
        doc.body.appendChild(topLine);

        const bottomLine = mk(doc, 'div', '', 'margin:4px 0 12px');
        bottomLine.appendChild(txt(doc, 'span', 'Gaps: ', 'weaknesses'));
        bottomLine.appendChild(doc.createTextNode(bottom3.map(([,s]) => `${s.label} (${s.value})`).join(', ')));
        doc.body.appendChild(bottomLine);

        sortedScores.forEach(([, s]) => {
            const row = mk(doc, 'div', 'score-row');
            row.appendChild(txt(doc, 'div', s.label, 'score-label'));
            const barBg = mk(doc, 'div', 'score-bar-bg');
            const bar = mk(doc, 'div', 'score-bar');
            bar.style.width = s.value + '%';
            bar.style.background = s.value >= 70 ? '#22c55e' : s.value >= 40 ? '#eab308' : '#ef4444';
            barBg.appendChild(bar);
            row.appendChild(barBg);
            row.appendChild(txt(doc, 'div', String(s.value), 'score-val'));
            doc.body.appendChild(row);
        });

        // Categories
        doc.body.appendChild(txt(doc, 'h2', 'Feature Categories'));
        const catGrid = mk(doc, 'div', 'cat-grid');
        catSummary.forEach(c => {
            const item = mk(doc, 'div', 'cat-item');
            item.appendChild(txt(doc, 'div', String(c.total), 'cat-count'));
            item.appendChild(doc.createTextNode(`${c.icon} ${c.name}`));
            catGrid.appendChild(item);
        });
        doc.body.appendChild(catGrid);

        // Footer
        doc.body.appendChild(txt(doc, 'div',
            `Generated by DigiPin Urban Intelligence Portal \u2022 Data: OpenStreetMap, Open-Meteo, CPCB \u2022 ${date}`,
            'footer'));

        setTimeout(() => win.print(), 500);
        App.showToast('Report Ready', 'Print dialog opened in new window', 'success');
    }

    function mk(doc, tag, className, style) {
        const e = doc.createElement(tag);
        if (className) e.className = className;
        if (style) e.style.cssText = style;
        return e;
    }

    function txt(doc, tag, text, className, style) {
        const e = mk(doc, tag, className, style);
        e.textContent = text;
        return e;
    }

    function metaCard(doc, val, label) {
        const card = mk(doc, 'div', 'meta-card');
        card.appendChild(txt(doc, 'div', val, 'meta-val'));
        card.appendChild(txt(doc, 'div', label, 'meta-label'));
        return card;
    }

    return { generate };
})();
