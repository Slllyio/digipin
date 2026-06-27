# paper theme — handoff for the next session

Picks up the paper-light theme work. The palette/CSS/3D-building changes are
**already merged to `main`** (PRs #45, #46) and the required egress hosts are
documented (#47). What's left is **live visual verification + fine-tuning**,
which couldn't be done in earlier sessions because the map CDNs were blocked.

## Status
- ✅ Cool light theme — white surfaces, salmon-coral accent (`#dd6b4a`),
  charcoal UI (`#2e3033`), no violet. Tokens in `css/styles.css`
  (`html[data-theme="light"]`) + `js/theme.js` `PALETTE.light`.
- ✅ 3D buildings — white architectural massing model: cool-white ramp
  (`#f3f5f7 → #ccd2d9`), low-rise height curve, directional map light.
  See `js/digital-twin-layers.js` → `google_buildings` `paintLight`.
- ⏳ **Not yet seen rendered live.** Dark theme is intentionally unchanged.

## First, confirm the network is actually unblocked
The egress allowlist applies at **container start**, so this only works in a
session started *after* the hosts were allowlisted:

```sh
for h in https://unpkg.com/maplibre-gl@4.1.3/dist/maplibre-gl.js \
         https://basemaps.cartocdn.com/gl/positron-gl-style/style.json \
         https://example.com/ ; do
  echo "$(curl -so /dev/null -w '%{http_code}' --max-time 15 "$h")  $h"
done
```
All `200` → proceed. Any `403` → the allowlist hasn't taken effect; the hosts
needed are listed in `README.md` → **Network access**. Don't burn time trying
to render until these return `200`.

## Then render + verify
1. Serve the repo: `python serve.py` (or `npx serve .`) → http://localhost:5500
2. Open `app.html` headless (Playwright/Chromium), set
   `localStorage.digipin_theme='light'` + `digipin_onboarded='done'` pre-load.
3. Toggle **Buildings** (→ 3D) and **3D Mode** (pitch 60°) and screenshot.
   - The Buildings layer reads `data/vectors/google_open_buildings_indore.pmtiles`
     — **same-origin but not committed**. If absent, that layer won't draw;
     ask the user to drop the file in, or preview massing with a synthetic
     MapLibre scene.
4. If `the reference design` is reachable, WebFetch it and compare palette/surfaces/fonts.

## Fine-tuning targets (tune against the live render, not from memory)
- **Coral hue** `--accent-cyan` / `PALETTE.light.primary` — currently a soft
  salmon ~`#df6e4d`/`#e07a5e`; deepen/lighten to taste.
- **Building grey ramp** + **height curve** (`5 + sqrt(area)*1.1`) — calmer or
  taller massing.
- **Map light** angle/intensity — `setLight({anchor:'map', position:[1.4,210,38], intensity:0.45})`
  in `_initPMTilesLayer`.
- **Font / basemap** — currently Inter + Positron; swap if the reference design differs.

## Guardrails
- Keep the **dark theme byte-identical** (regression baseline: render dark
  before/after, diff should be empty).
- Run `npx vitest run` (428 tests) + `npx eslint .` before pushing.
- Repo CI is infra-blocked (0-runner, fails in seconds) — verify locally.
