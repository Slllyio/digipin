/**
 * PresentMode — paper-model "Stakeholder" presentation view.
 *
 * A distraction-free, read-only mode for showing a site to non-technical
 * viewers: it hides the editing chrome (top bar, toolbar, sidebar) and shows a
 * slim Present bar (exit · open Site Brief · export Pitch Map). It can be entered
 * from a toolbar button, or directly via a shareable `?present=1` deep link
 * (URLState carries the flag), so a stakeholder opens straight into it.
 *
 * Builds on the existing `?embed` chrome-hide (js/app.js) and reuses
 * Panel.getCurrentData / SiteBrief.open / PitchMap.open. parseFlag() is pure and
 * unit-tested; enter()/exit() are DOM.
 */
const PresentMode = (() => {
    let _active = false;

    /** True when the query string requests presentation mode (?present=1). Pure. */
    function parseFlag(search) {
        const raw = search != null ? search
            : (typeof window !== 'undefined' ? window.location.search : '');
        const p = new URLSearchParams(raw);
        return p.get('present') === '1' || (p.has('present') && p.get('present') !== '0');
    }

    /** Create (once) the slim Present bar with Brief / export / exit actions. */
    function _bar() {
        let bar = document.getElementById('present-bar');
        if (bar) return bar;
        bar = document.createElement('div');
        bar.id = 'present-bar';
        bar.className = 'present-bar';
        bar.innerHTML = `
            <span class="present-brand">DigiPin · Presentation</span>
            <span class="present-spacer"></span>
            <button class="present-btn" data-act="brief">Site Brief</button>
            <button class="present-btn" data-act="pitch">Export view</button>
            <button class="present-btn present-exit" data-act="exit">Exit ✕</button>`;
        bar.addEventListener('click', (e) => {
            const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
            if (act === 'exit') exit();
            else if (act === 'pitch' && typeof PitchMap !== 'undefined') PitchMap.open();
            else if (act === 'brief' && typeof SiteBrief !== 'undefined' && typeof Panel !== 'undefined') {
                const data = Panel.getCurrentData && Panel.getCurrentData();
                const cell = Panel.getCurrentCell && Panel.getCurrentCell();
                if (data) SiteBrief.open(data, cell);
                else if (typeof App !== 'undefined') App.showToast('Presentation', 'Select a cell first to show its brief.', 'info');
            }
        });
        document.body.appendChild(bar);
        return bar;
    }

    /** Keep the toolbar button's aria-pressed in sync with the mode. */
    function _syncBtn(on) {
        const btn = document.getElementById('btn-present');
        if (btn) btn.setAttribute('aria-pressed', String(!!on));
    }

    /** Enter presentation mode (hide chrome, show the Present bar). */
    function enter() {
        if (typeof document === 'undefined') return false;
        _active = true;
        document.body.classList.add('presenting');
        _bar();
        _syncBtn(true);
        return true;
    }

    /** Exit presentation mode (restore chrome, remove the Present bar). */
    function exit() {
        if (typeof document === 'undefined') return false;
        _active = false;
        document.body.classList.remove('presenting');
        document.getElementById('present-bar')?.remove();
        _syncBtn(false);
        return false;
    }

    /** Toggle presentation mode. */
    function toggle() { return _active ? exit() : enter(); }
    /** True while presentation mode is active. */
    function isActive() { return _active; }

    /** Auto-enter when the URL asks for it. */
    function init() {
        if (parseFlag()) enter();
        if (typeof document !== 'undefined') {
            const btn = document.getElementById('btn-present');
            if (btn) btn.addEventListener('click', () => { toggle(); });
        }
    }

    return { init, enter, exit, toggle, isActive, parseFlag };
})();

if (typeof window !== 'undefined') window.PresentMode = PresentMode;
