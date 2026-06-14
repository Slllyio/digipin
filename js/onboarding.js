/**
 * Onboarding — a once-per-visitor welcome card for /app.html.
 *
 * The headline features (click-a-cell intelligence + plain-English Text2Map)
 * were invisible behind a 3-second toast. This shows a small 2-step modal the
 * first time someone opens the app, then sets a localStorage flag so it never
 * nags again (same gate shape as js/bookmarks.js / js/saved-views.js).
 *
 * Built in JS (not CSS) so the themed surfaces read Theme.palette() at render
 * time — in particular the primary button uses `inkOnPrimary` so its label is
 * readable on both cyan (dark) and coral (light). A theme switch reloads the
 * page, so a render-time colour read is sufficient.
 */
const Onboarding = (() => {
    const STORAGE_KEY = 'digipin_onboarded';

    // Step copy — kept as data so it's unit-testable and easy to tweak.
    const STEPS = [
        {
            icon: '📍', // round pushpin
            title: 'Click any DIGIPIN cell',
            body: 'Every ~3.8 m tile becomes instant, India-native intelligence — flood risk, heat, air quality, schools, transit, buildings. No GIS, no signup.',
        },
        {
            icon: '💬', // speech balloon
            title: 'Ask in plain English',
            body: 'Type a question like "family-friendly area near good schools with low flood risk" and Text2Map ranks DIGIPIN cells across the city. Free and auditable.',
        },
    ];

    /** True when the visitor hasn't dismissed onboarding yet. Pure (storage read). */
    function shouldShow() {
        try { return localStorage.getItem(STORAGE_KEY) !== 'done'; }
        catch { return false; } // storage blocked → don't block the app
    }

    /** Persist the "seen" flag so onboarding never shows again. */
    function markSeen() {
        try { localStorage.setItem(STORAGE_KEY, 'done'); }
        catch { /* storage full or blocked — nothing to persist */ }
    }

    let _backdrop = null;
    let _index = 0;
    let _onKeydown = null;

    /** Resolve themed colours once per render (theme switch reloads the page). */
    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
                 surfaceSolid: '#111638', border: 'rgba(255,255,255,0.12)',
                 inkOnPrimary: '#0a0e27' };
    }

    /** Render (or re-render) the card body for the current step. */
    function _renderStep(card, pal) {
        const step = STEPS[_index];
        const last = _index === STEPS.length - 1;
        while (card.firstChild) card.removeChild(card.firstChild);

        const icon = document.createElement('div');
        icon.className = 'onboarding-icon';
        icon.textContent = step.icon;

        const title = document.createElement('h2');
        title.className = 'onboarding-title';
        title.textContent = step.title;
        title.style.color = pal.ink;

        const body = document.createElement('p');
        body.className = 'onboarding-body';
        body.textContent = step.body;
        body.style.color = pal.sub;

        // Progress dots.
        const dots = document.createElement('div');
        dots.className = 'onboarding-dots';
        STEPS.forEach((_, i) => {
            const dot = document.createElement('span');
            dot.className = 'onboarding-dot' + (i === _index ? ' active' : '');
            dot.style.background = i === _index ? pal.primary : pal.border;
            dots.appendChild(dot);
        });

        const actions = document.createElement('div');
        actions.className = 'onboarding-actions';

        const skip = document.createElement('button');
        skip.className = 'onboarding-skip';
        skip.type = 'button';
        skip.textContent = 'Skip';
        skip.style.color = pal.sub;
        skip.addEventListener('click', dismiss);

        const next = document.createElement('button');
        next.className = 'onboarding-next';
        next.type = 'button';
        next.textContent = last ? 'Start exploring' : 'Next';
        // The review's contrast fix: ink-on-primary (dark ink on cyan, white on coral).
        next.style.background = pal.primary;
        next.style.color = pal.inkOnPrimary;
        next.addEventListener('click', () => {
            if (last) { dismiss(); return; }
            _index++;
            _renderStep(card, pal);
        });

        actions.appendChild(skip);
        actions.appendChild(next);
        card.appendChild(icon);
        card.appendChild(title);
        card.appendChild(body);
        card.appendChild(dots);
        card.appendChild(actions);

        next.focus();
    }

    /** Build + show the modal. */
    function render() {
        if (typeof document === 'undefined' || _backdrop) return;
        const pal = _palette();
        _index = 0;

        _backdrop = document.createElement('div');
        _backdrop.id = 'onboarding-backdrop';
        _backdrop.setAttribute('role', 'dialog');
        _backdrop.setAttribute('aria-modal', 'true');
        _backdrop.setAttribute('aria-label', 'Welcome to DigiPin');

        const card = document.createElement('div');
        card.className = 'onboarding-card';
        card.style.background = pal.surfaceSolid;
        card.style.borderColor = pal.border;

        _renderStep(card, pal);
        _backdrop.appendChild(card);

        // Click outside the card dismisses (counts as "seen").
        _backdrop.addEventListener('click', (e) => { if (e.target === _backdrop) dismiss(); });
        _onKeydown = (e) => { if (e.key === 'Escape') dismiss(); };
        document.addEventListener('keydown', _onKeydown);

        document.body.appendChild(_backdrop);
    }

    /** Close the modal and record that it's been seen. */
    function dismiss() {
        markSeen();
        if (_onKeydown) { document.removeEventListener('keydown', _onKeydown); _onKeydown = null; }
        if (_backdrop && _backdrop.parentNode) _backdrop.parentNode.removeChild(_backdrop);
        _backdrop = null;
    }

    /** Show onboarding once, on first run. */
    function init() {
        if (shouldShow()) render();
    }

    return { init, render, dismiss, shouldShow, markSeen, STEPS, STORAGE_KEY };
})();

if (typeof window !== 'undefined') {
    window.Onboarding = Onboarding;
}
