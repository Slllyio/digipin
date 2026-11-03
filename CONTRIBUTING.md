# Contributing

How the repo is laid out, where new things go, and the checks to run before
pushing. The app is a static PWA with no build step: what is in the repo is
what the browser loads.

## Where things live

| Path | What goes there |
|---|---|
| `index.html`, `app.html` | Landing page and the map app shell. Every `js/` module is loaded by a `<script>` tag here |
| `js/` | Browser modules, one feature per file (see naming below) |
| `css/`, `assets/`, `manifest.json`, `sw.js` | Styles, icons, PWA manifest, service worker |
| `data/` | Static data the app fetches at runtime. Written by `pipeline/` and `scrapers/`, never edited by hand |
| `pipeline/` | Offline Python builds that produce `data/` ([pipeline/README.md](pipeline/README.md)) |
| `scrapers/` | Real-time scrapers that commit `data/realtime/*/latest.json` ([scrapers/README.md](scrapers/README.md)) |
| `proxy/` | Cloudflare Worker proxy for keyed APIs |
| `scripts/` | One-off build and CI helper scripts |
| `tests/` | Vitest unit tests (`*.test.js`), pytest smoke tests, Playwright e2e (`tests/playwright/`), manual dev pages (`test-*.html`) |
| `docs/` | Design notes and model write-ups, indexed in [docs/README.md](docs/README.md). Finished handoffs go in `docs/archive/` |
| `training-data/` | DISHA fine-tuning (QLoRA notebook, script, Ollama `Modelfile`) |
| `extras/` | Demo video, slides and promo tooling. Not part of the app |
| `guna-twin-city/` | Separate Guna prototype ([guna-twin-city/README.md](guna-twin-city/README.md)) |
| `.claude/`, `.mcp.json` | Shared Claude Code skills, hooks and agents ([.claude/README.md](.claude/README.md)) |

`.github/workflows/deploy.yml` publishes the repo to GitHub Pages minus the
dev-only folders (`pipeline/`, `scrapers/`, `tests/`, `docs/`, `extras/`,
`training-data/`, `guna-twin-city/`, `proxy/`, `scripts/`). A new top-level
dev folder should be added to that exclude list.

## Conventions

**JS modules.** Plain scripts, no bundler and no `import`. Each file defines
one global (`const Terrain = (() => { ... })();`) named in PascalCase, in a
kebab-case file (`js/terrain.js`). Common suffixes:

- `*-score.js` pure, deterministic score model (no DOM, no fetch)
- `*-overlay.js` / `*-layer(s).js` MapLibre sources and layers
- `*-widget.js` / `*-panel.js` / `*-dialog.js` UI
- `realtime-*.js` loaders for `data/realtime/` snapshots

**Adding a JS module** takes three edits; CI catches the first two if missed:

1. a `<script src="js/<name>.js">` tag in `app.html` (the orphan guard,
   `npm run check:orphans`, fails on an unreferenced module);
2. the same path in `LOCAL_ASSETS` in `sw.js`, and bump `CACHE_NAME`
   (`tests/sw-precache.test.js` fails if they drift);
3. a test in `tests/<name>.test.js`. Load the module with
   `loadGlobalScript` in `tests/setup.js`.

**Moving or renaming a served file** means updating every `<script>`/`<link>`
reference, `sw.js`, `tests/setup.js` and any workflow path filter in the same
commit.

**Python.** Packages under `pipeline/` and `scrapers/` run as modules from the
repo root (`python -m pipeline.cells.build`). Each package has its own
`requirements.txt` and `tests/` folder. Score models are ported from the JS,
which stays the source of truth: after changing a `js/*-score.js`, run
`npm run golden:scores` and commit `pipeline/scores/golden/`.

**Data.** `data/` is git-ignored by default and specific outputs are
whitelisted in `.gitignore`. When a pipeline gains a new output the app reads,
add a `!data/<dir>/...` rule. Do not hand-edit `data/realtime/*/latest.json`;
the scrape cron owns those files.

**Docs.** Cross-cutting notes go in `docs/UPPER_SNAKE_CASE.md` with a row in
`docs/README.md`. Module notes go in a `README.md` inside the module folder.

**Secrets.** The app is keyless and public. Never commit a private key; inject
it at deploy time or put it behind `proxy/`.

## Checks

```sh
npm install
pip install -r requirements-test.txt -r scrapers/requirements.txt \
  -r pipeline/scores/requirements.txt -r pipeline/cells/requirements.txt

npm run check      # eslint + orphan-JS guard + vitest + pytest
npm run test:e2e   # Playwright app-boot smoke (needs the map CDNs reachable)
npm run serve      # http://localhost:8080
```

CI (`.github/workflows/ci.yml`) runs the same checks on pushes and PRs to
`main` and `dev`.

## Branches

Day-to-day work lands on `dev`: pull with rebase, run `npm run check`, and
push small commits, since several people push to `dev` at once. `main` is
updated from `dev` in one batch and is what GitHub Pages deploys.
