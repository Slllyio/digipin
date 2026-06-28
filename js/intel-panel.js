/**
 * IntelPanel — the demonstrable surface for the urban-intelligence layer. A
 * floating panel that, for the selected DigiPin cell, shows the IntelReport
 * (composite indices with bands + drivers, derived flags, headline) and an
 * agentic query box (DishaAgent), plus copy/export of the Intelligence-as-a-
 * Service payload.
 *
 * Self-contained: it injects its own launcher button + styles, listens for the
 * `digipin:cellselect` event, and degrades quietly if the intelligence modules
 * or a covered region are absent. No build step, no framework.
 */
const IntelPanel = (() => {
    let _root = null, _body = null, _open = false, _report = null, _lastCode = null;

    const BAND_COLOR = {
        Strong: '#2bbf6a', High: '#d9534f', Moderate: '#e0a13a',
        Low: '#2bbf6a', Weak: '#9aa0ab', 'no data': '#6b7280',
    };
    const FLAG_COLOR = { risk: '#d9534f', good: '#2bbf6a', info: '#7c8190' };

    function _has(name) { return typeof window !== 'undefined' && window[name]; }

    function _el(tag, css, html) {
        const e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (html != null) e.innerHTML = html;
        return e;
    }

    function init() {
        if (_root || typeof document === 'undefined') return;
        const launch = _el('button', 'position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:1400;'
            + 'background:#1f6feb;color:#fff;border:none;border-radius:8px 0 0 8px;padding:10px 8px;cursor:pointer;'
            + 'font:600 12px system-ui;writing-mode:vertical-rl;box-shadow:-2px 2px 10px rgba(0,0,0,0.3);', '◧ Intel');
        launch.title = 'Urban Intelligence — per-cell brief & agent';
        launch.onclick = toggle;
        document.body.appendChild(launch);

        _root = _el('div', 'position:fixed;right:14px;top:64px;bottom:14px;width:340px;z-index:1401;display:none;'
            + 'background:rgba(18,22,32,0.96);color:#e8ecf4;border:1px solid #2a3350;border-radius:12px;'
            + 'box-shadow:0 8px 30px rgba(0,0,0,0.45);font:13px/1.4 system-ui;overflow:hidden;flex-direction:column;');
        const head = _el('div', 'display:flex;align-items:center;justify-content:space-between;padding:11px 13px;border-bottom:1px solid #2a3350;');
        head.appendChild(_el('div', 'font-weight:700;font-size:14px;', 'Urban Intelligence'));
        const close = _el('button', 'background:none;border:none;color:#9fb0c8;font-size:18px;cursor:pointer;line-height:1;', '×');
        close.onclick = close_; head.appendChild(close);
        _body = _el('div', 'padding:12px 13px;overflow-y:auto;flex:1;');
        _root.appendChild(head); _root.appendChild(_body);
        document.body.appendChild(_root);

        document.addEventListener('digipin:cellselect', (e) => {
            const cd = e && e.detail;
            if (cd && cd.code) { _lastCode = cd.code; if (_open) _renderByCode(cd.code, cd.center); }
        });
        _body.innerHTML = '<p style="color:#9fb0c8">Select a cell on the map to see its intelligence brief.</p>';
    }

    function open() { init(); if (_root) { _root.style.display = 'flex'; _open = true; const c = _currentCode(); if (c) _renderByCode(c); } }
    function close_() { if (_root) { _root.style.display = 'none'; _open = false; } }
    function toggle() { _open ? close_() : open(); }
    function isOpen() { return _open; }

    function _currentCode() {
        if (_has('MapModule') && window.MapModule.getSelectedCode) {
            const c = window.MapModule.getSelectedCode(); if (c) return c;
        }
        return _lastCode;
    }

    async function _renderByCode(code, center) {
        if (!_has('DigiPinIntel') || !_has('IntelReport')) {
            _body.innerHTML = '<p style="color:#d9534f">Intelligence layer not loaded.</p>'; return;
        }
        _body.innerHTML = '<p style="color:#9fb0c8">Loading…</p>';
        let rec = null;
        try {
            rec = center ? await window.DigiPinIntel.cell(center.lat, center.lng)
                         : await window.DigiPinIntel.cellByCode(code);
        } catch { /* ignore */ }
        if (!rec) { _body.innerHTML = '<p style="color:#d9534f">Could not resolve this cell.</p>'; return; }
        _report = window.IntelReport.build(rec);
        _render(_report);
    }

    function _bar(label, value, color, sub) {
        const v = value == null ? 0 : value;
        return `<div style="margin:7px 0;">
            <div style="display:flex;justify-content:space-between;font-size:12px;">
              <span>${label}</span><span style="color:${color};font-weight:700;">${value == null ? '—' : value}</span></div>
            <div style="height:6px;background:#243049;border-radius:4px;margin-top:3px;overflow:hidden;">
              <div style="height:100%;width:${v}%;background:${color};"></div></div>
            ${sub ? `<div style="font-size:10.5px;color:#8fa0bd;margin-top:2px;">${sub}</div>` : ''}
        </div>`;
    }

    function _render(r) {
        if (!r) return;
        if (!r.available) {
            _body.innerHTML = `<div style="font-weight:700;font-size:15px;">${r.digipin ? r.digipin.code : 'Cell'}</div>
                <p style="color:#9fb0c8;margin-top:8px;">Address resolved — no fused intelligence for this cell (outside a covered region).</p>`;
            _agentBox();
            return;
        }
        const h = r.headline;
        const flags = (r.flags || []).map(f =>
            `<span style="display:inline-block;background:${FLAG_COLOR[f.level] || '#7c8190'};color:#fff;border-radius:10px;padding:2px 8px;font-size:11px;margin:2px 4px 2px 0;">${f.text}</span>`).join('');
        const indices = (r.indices || []).map(i => {
            const color = BAND_COLOR[i.band] || '#7c8190';
            const drv = (i.drivers || []).slice(0, 3).map(d => d.label).join(' · ');
            return _bar(`${i.label} <span style="color:#7c8190;font-size:10.5px;">(${i.band})</span>`, i.value, color, drv);
        }).join('');

        _body.innerHTML = `
            <div style="font-weight:700;font-size:15px;">${r.digipin ? r.digipin.code : ''}</div>
            <div style="color:#9fb0c8;font-size:11.5px;margin-bottom:8px;">${r.location.region || ''} · DigiPin cell</div>
            ${h.livability != null ? `<div style="font-size:12px;margin-bottom:6px;">Livability <b style="color:#fff;">${h.livability}</b>${h.topRisk ? ` · risk: <b style="color:#d9534f;">${h.topRisk.label} ${h.topRisk.value}</b>` : ''}</div>` : ''}
            ${flags ? `<div style="margin:6px 0 10px;">${flags}</div>` : ''}
            <div style="font-weight:600;font-size:12px;color:#9fb0c8;margin-bottom:2px;">Indices</div>
            ${indices}
            ${r.utilities ? `<div style="font-weight:600;font-size:12px;color:#9fb0c8;margin:11px 0 3px;">Utilities — estimated (~${r.utilities.populationEst.toLocaleString()} residents)</div>
              <div style="font-size:12px;line-height:1.7;background:#172033;border-radius:8px;padding:8px 10px;">
                ⚡ Electricity <b>${r.utilities.electricity.kwhPerDay.toLocaleString()}</b> kWh/day <span style="color:#7c8190;">· ${r.utilities.electricity.carbonKgPerDay.toLocaleString()} kgCO₂</span><br>
                💧 Water <b>${Math.round(r.utilities.water.litresPerDay / 1000).toLocaleString()}</b> kL/day &nbsp;&nbsp; 🗑 Waste <b>${r.utilities.waste.kgPerDay.toLocaleString()}</b> kg/day<br>
                ☀ Rooftop solar offsets ~<b>${r.utilities.solarRooftop.offsetPct}%</b> &nbsp;·&nbsp; supply stress <b style="color:${BAND_COLOR[r.utilities.supplyStress.band] || '#9aa0ab'};">${r.utilities.supplyStress.band}</b>
              </div>
              <div style="font-size:10px;color:#6b7280;margin-top:3px;">Indicative — downscaled from population/activity, not metered.</div>` : ''}
            <div style="display:flex;gap:8px;margin-top:12px;">
              <button id="ip-copy" style="flex:1;background:#394257;color:#fff;border:none;border-radius:7px;padding:7px;cursor:pointer;font:600 12px system-ui;">Copy brief</button>
              <button id="ip-json" style="flex:1;background:#394257;color:#fff;border:none;border-radius:7px;padding:7px;cursor:pointer;font:600 12px system-ui;">Copy JSON</button>
            </div>`;
        _agentBox();
        const copy = (txt) => { try { navigator.clipboard.writeText(txt); } catch { /* ignore */ } };
        const cb = _body.querySelector('#ip-copy'); if (cb) cb.onclick = () => copy(window.IntelReport.toText(_report));
        const jb = _body.querySelector('#ip-json'); if (jb) jb.onclick = () => copy(window.IntelReport.toJSON(_report));
    }

    function _agentBox() {
        if (!_has('DishaAgent')) return;
        const wrap = _el('div', 'margin-top:14px;border-top:1px solid #2a3350;padding-top:10px;');
        wrap.appendChild(_el('div', 'font-weight:600;font-size:12px;color:#9fb0c8;margin-bottom:5px;', 'Ask the agent'));
        const row = _el('div', 'display:flex;gap:6px;');
        const inp = _el('input', 'flex:1;background:#0e1320;border:1px solid #2a3350;border-radius:7px;color:#cfe0ff;padding:7px;font:12px system-ui;');
        inp.placeholder = 'e.g. where is flood risk highest?';
        const btn = _el('button', 'background:#1f6feb;color:#fff;border:none;border-radius:7px;padding:7px 11px;cursor:pointer;font:600 12px system-ui;', 'Ask');
        const out = _el('div', 'margin-top:8px;font-size:12px;color:#cfe0ff;min-height:1em;');
        const ask = async () => {
            const q = inp.value.trim(); if (!q) return;
            out.textContent = 'Thinking…';
            try {
                const res = await window.DishaAgent.ask(q, {});
                out.textContent = `[${res.plan.skill}] ${res.summary || ''}`;   // textContent: no HTML injection
                if (_has('DISHAActions') && Array.isArray(res.actions) && res.actions.length) {
                    window.DISHAActions.executeActions(window.DISHAActions.parseActions(res.actions.join('\n')), 8);
                }
            } catch (e) { out.textContent = 'Agent error.'; }
        };
        btn.onclick = ask;
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });
        row.appendChild(inp); row.appendChild(btn);
        wrap.appendChild(row); wrap.appendChild(out);
        _body.appendChild(wrap);
    }

    return { init, open, close: close_, toggle, isOpen };
})();

if (typeof window !== 'undefined') {
    window.IntelPanel = IntelPanel;
    // Self-init the launcher (defer scripts run after DOM parse).
    if (typeof document !== 'undefined') {
        if (document.readyState !== 'loading') IntelPanel.init();
        else document.addEventListener('DOMContentLoaded', () => IntelPanel.init());
    }
}
