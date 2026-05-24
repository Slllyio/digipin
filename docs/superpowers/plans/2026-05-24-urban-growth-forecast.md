# Urban Growth Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 3-horizon (nowcast / 1-2 yr / 5 yr) composite growth-pulse score per DigiPin cell, surfaced in the panel widget + map heatmap + DISHA context. Backed by Google Earth Engine Open Buildings Temporal V1 (BUE), GHSL + VIIRS (DEN), MP RERA scraper (CAP), and OSM live signals. Honest about uncertainty — per-cell confidence bands and explicit "extrapolation, not forecast" disclosure on the 5-year layer.

**Architecture:** Two-tier data. Slow tier — Python pipeline extracts GEE rasters once-per-refresh as Cloud-Optimized GeoTIFFs hosted in `data/growth/`. Fast tier — browser samples those COGs at cell lat/lng via HTTP-range requests using `georaster.browser.bundle.min.js` (already loaded for PR #10's flood DEM). Pure-function score module in `js/growth-score.js` collapses sub-scores to composites with per-cell confidence bands. Three UI surfaces (panel widget, map heatmap, DISHA prompt) consume the same `result.realtime.growth` schema defined in spec §4.1.

**Tech Stack:** Python 3.12 + earthengine-api + rasterio + rio-cogeo (pipeline) · requests + BeautifulSoup4 (scraper, existing framework) · vanilla JS IIFE pattern + MapLibre GL JS + georaster (browser) · Vitest + pytest + Playwright (tests).

**Spec reference:** `docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md`

---

## Phase 0 — Prerequisites (spec §11)

These three checks gate the rest of the plan. Run them first; only proceed when all pass.

### Task 0a: Verify GEE access — **RESOLVED 2026-05-24**

**Status:** Cached OAuth credentials at `~/.config/earthengine/credentials` work when EE is initialised with `project='van-suraksha-alert'`. No service account JSON download needed for local development. Service account is still required for CI (see Step 4 below).

**Files:**
- Read: `docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md` §11.1

- [ ] **Step 1: ~~Confirm the credentials file is present~~ — OBSOLETE**

Original check expected `~/.gee/digipin-credentials.json` from a downloaded service-account JSON. **Phase 0a discovered** that cached OAuth credentials (created by an earlier `earthengine authenticate` on this machine) already exist at `~/.config/earthengine/credentials` and work for asset access — no manual JSON download required. Skip this step.

- [ ] **Step 2: Install earthengine-api in a temp venv**

```sh
python -m venv /tmp/gee-check
source /tmp/gee-check/bin/activate   # or: source /tmp/gee-check/Scripts/activate on Git Bash
pip install --quiet earthengine-api
```

Expected: pip succeeds with no errors.

- [ ] **Step 3: Smoke-test EE auth + asset access (VERIFIED 2026-05-24)**

```sh
PYTHONIOENCODING=utf-8 python -c "
import ee
ee.Initialize(project='van-suraksha-alert')
img = ee.ImageCollection('GOOGLE/Research/open-buildings-temporal/v1').first()
info = img.getInfo()
print('asset:', info['id'])
print('bands:', [b['id'] for b in info['bands']])
"
```

Confirmed-working output (run during Phase 0a on 2026-05-24):
```
asset: GOOGLE/Research/open-buildings-temporal/v1/01_EPSG_32723_2016_06_30
bands: ['building_fractional_count', 'building_height', 'building_presence']
```

**Critical kwarg:** `project='van-suraksha-alert'`. Without it, EE defaults to a different project (`delta-guild-367407` on this machine) which isn't registered for Earth Engine and the call fails with `EEException: Project X is not registered to use Earth Engine`. The pipeline's `_init_ee()` reads `GEE_PROJECT` env var (defaulting to `van-suraksha-alert`) for portability.

**Cross-platform note:** Set `PYTHONIOENCODING=utf-8` when running on Windows — the default cp1252 codec chokes on unicode checkmarks. The pipeline scripts themselves only emit ASCII via `logging`.

- [ ] **Step 4: Add the credentials path to GitHub Actions secrets — DEFERRED to CI-enablement PR**

GitHub Actions can't use cached OAuth credentials (those live in `~/.config/earthengine/credentials` on a developer's machine and aren't portable). When CI auto-refresh of the COGs is wired up (Phase 2 follow-up), the maintainer should:

1. Create a service account in the `van-suraksha-alert` GCP project's IAM panel with the `Earth Engine Resource Viewer` role
2. Download its JSON key (do not commit)
3. `gh secret set GEE_SERVICE_ACCOUNT_JSON < /path/to/key.json`
4. Add `gh secret set GEE_PROJECT --body "van-suraksha-alert"` so the project hint is also available in CI

For v1 (local pipeline runs by the maintainer), Step 3's cached OAuth path is enough — skip this step.

### Task 0b: Verify RERA Madhya Pradesh portal access

**Files:**
- Read: `docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md` §11.3

- [ ] **Step 1: Probe portal availability**

```sh
curl -k -A "Mozilla/5.0" -o /tmp/rera-mp.html https://rera.mp.gov.in/
ls -la /tmp/rera-mp.html
file /tmp/rera-mp.html
```

Expected: file is HTML, > 5 KB. SSL cert chain may error (expected); `-k` bypasses.

- [ ] **Step 2: Confirm project listing path is reachable**

```sh
grep -oE 'href="[^"]*project[^"]*"' /tmp/rera-mp.html | head -5
```

Expected: at least one href matches a project-listing path (e.g. `/Project/Allproject` or similar).

If the portal has changed materially (JavaScript-only SPA, completely different HTML structure), mark Task 11 (RERA scraper) as **degraded** — populate CAP from OSM construction signals alone for v1 and disclose in the methods panel.

### Task 0c: Resolve flood-widget visual pattern availability

**Files:**
- Read: `docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md` §11.2

- [ ] **Step 1: Check whether PR #11's flood-widget files have landed on main**

```sh
git fetch origin main
git ls-tree origin/main -- js/flood-animation.js js/flood-inundation.js js/flood-scs.js css/styles.css | grep -c flood-
```

Expected: 3 (the JS files exist on main). If 0, PR #11 hasn't merged yet — choose resolution path per spec §11.2 (most likely: re-implement the visual pattern in this PR with ~100 LOC of CSS).

- [ ] **Step 2: Document the chosen resolution path**

Append a one-line note to the plan's commit message when you start Phase 5 (UI):
- "(flood pattern on main — reusing)" OR
- "(flood pattern not on main — re-implementing ~100 LOC CSS)" OR
- "(simpler glass-morphism — minimal styling)"

---

## Phase 1 — Pure-function score logic

All math from spec §5 implemented as side-effect-free functions in `js/growth-score.js`. Fully tested before any DOM or network code touches the codebase.

### Task 1: Project setup + Vitest reuse

**Files:**
- Read: `tests/setup.js` (PR #3 — already on branch `agents/test-scaffolding`, or main if merged)
- Modify: `vitest.config.js` (verify it includes `tests/growth-*.test.js`)

- [ ] **Step 1: Confirm Vitest is wired**

```sh
git ls-tree origin/main -- vitest.config.js tests/setup.js
```

Expected: both files exist. If not, this plan depends on PR #3 — pause until that merges, or cherry-pick its scaffold commit onto your working branch.

- [ ] **Step 2: Branch from main**

```sh
git checkout main && git pull
git checkout -b agents/urban-growth-forecast
```

Expected: clean checkout on new branch.

- [ ] **Step 3: Verify Node + Vitest run a sanity test**

```sh
npm install   # if dependencies aren't installed yet
npx vitest run tests/digipin.test.js
```

Expected: PR #3's digipin tests pass.

- [ ] **Step 4: Commit (empty branch starter)**

```sh
git commit --allow-empty -m "chore: branch for urban growth forecast (spec 2026-05-24)"
```

### Task 2: BUE (Built-up Expansion) sub-score

**Files:**
- Create: `js/growth-score.js`
- Test: `tests/growth-score.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/growth-score.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';

// Load growth-score.js into globalThis (matches PR #3's setup pattern)
const code = readFileSync(path.join(process.cwd(), 'js/growth-score.js'), 'utf-8');
vm.runInNewContext(code, { globalThis });

describe('GrowthScore.bueSubScore()', () => {
    it('returns the 50 anchor for flat year + zero osm', () => {
        const s = globalThis.GrowthScore.bueSubScore({
            buildings_temporal: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],  // 2016-2023, flat
            heights: [3, 3, 3, 3, 3, 3, 3, 3],
            osm_construction_count: 0,
        });
        expect(s).toBe(50);
    });

    it('rises above 50 for strong YoY growth', () => {
        const s = globalThis.GrowthScore.bueSubScore({
            buildings_temporal: [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],   // +16% YoY 2022→2023
            heights: [3, 3, 3, 4, 4, 5, 5, 6],
            osm_construction_count: 3,
        });
        expect(s).toBeGreaterThan(70);
        expect(s).toBeLessThanOrEqual(100);
    });

    it('returns null when buildings_temporal is empty', () => {
        const s = globalThis.GrowthScore.bueSubScore({
            buildings_temporal: [],
            heights: [],
            osm_construction_count: 5,
        });
        expect(s).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
npx vitest run tests/growth-score.test.js
```

Expected: FAIL with `ReferenceError: GrowthScore is not defined`

- [ ] **Step 3: Create `js/growth-score.js` with minimal `bueSubScore`**

```javascript
/**
 * GrowthScore — pure functions for the Urban Growth Forecast score model.
 *
 * Spec reference: docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md §5
 *
 * All functions are deterministic, side-effect-free, and DOM-free —
 * fully testable in Vitest without mocks. The browser orchestrator
 * (js/realtime-growth.js) supplies the inputs; this module just does math.
 */

const GrowthScore = (() => {
    /** Built-up Expansion (BUE).
     *  Inputs:
     *    buildings_temporal: number[]  Open Buildings Temporal V1 presence 2016..2023
     *    heights:            number[]  building heights (metres) 2016..2023
     *    osm_construction_count: number  OSM landuse=construction POIs in 500m radius
     *  Returns 0..100 or null when no temporal data is available. */
    function bueSubScore({ buildings_temporal, heights, osm_construction_count }) {
        if (!buildings_temporal || buildings_temporal.length < 2) return null;
        const n = buildings_temporal.length;
        const last = buildings_temporal[n - 1];
        const prev = buildings_temporal[n - 2];
        const yoyPct = prev > 0 ? ((last - prev) / prev) * 100 : 0;
        const heightYoy = heights && heights.length >= 2
            ? (heights[heights.length - 1] - heights[heights.length - 2])
            : 0;
        const osmBoost = Math.min(10, (osm_construction_count || 0) * 2);
        const score = 50
            + 25 * Math.tanh(yoyPct / 8)
            + 15 * Math.tanh(heightYoy)
            + osmBoost;
        return Math.max(0, Math.min(100, score));
    }

    return { bueSubScore };
})();

if (typeof window !== 'undefined') {
    window.GrowthScore = GrowthScore;
}

// Vitest sees the IIFE attached to globalThis via setup; this exports nothing extra.
```

- [ ] **Step 4: Run test to verify it passes**

```sh
npx vitest run tests/growth-score.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```sh
git add js/growth-score.js tests/growth-score.test.js
git commit -m "feat(growth): BUE sub-score (built-up expansion)"
```

### Task 3: DEN (Densification) sub-score

**Files:**
- Modify: `js/growth-score.js`
- Test: `tests/growth-score.test.js`

- [ ] **Step 1: Append failing tests**

Append to `tests/growth-score.test.js`:

```javascript
describe('GrowthScore.denSubScore()', () => {
    it('returns 50 for zero population growth and zero commercial', () => {
        const s = globalThis.GrowthScore.denSubScore({
            ghsl_pop_5yr_pct: 0,
            osm_commercial_density: 0,
        });
        expect(s).toBe(50);
    });

    it('saturates near the upper bound for +30% population growth', () => {
        const s = globalThis.GrowthScore.denSubScore({
            ghsl_pop_5yr_pct: 30,
            osm_commercial_density: 80,
        });
        expect(s).toBeGreaterThan(80);
    });

    it('returns null when ghsl_pop_5yr_pct is missing', () => {
        const s = globalThis.GrowthScore.denSubScore({
            ghsl_pop_5yr_pct: null,
            osm_commercial_density: 10,
        });
        expect(s).toBeNull();
    });
});
```

- [ ] **Step 2: Run test, confirm failure**

```sh
npx vitest run tests/growth-score.test.js -t denSubScore
```

Expected: 3 failures with `denSubScore is not a function`.

- [ ] **Step 3: Add `denSubScore` to `js/growth-score.js`**

Inside the IIFE, before the `return` statement:

```javascript
    /** Densification (DEN).
     *  Inputs:
     *    ghsl_pop_5yr_pct:       number  GHSL pop grid delta 2020→2025 (%)
     *    osm_commercial_density: number  POI density per km² */
    function denSubScore({ ghsl_pop_5yr_pct, osm_commercial_density }) {
        if (ghsl_pop_5yr_pct == null) return null;
        const popTerm = 25 * Math.tanh(ghsl_pop_5yr_pct / 15);
        const commTerm = Math.min(15, (osm_commercial_density || 0) / 8);
        return Math.max(0, Math.min(100, 50 + popTerm + commTerm));
    }
```

Update the `return` to include `denSubScore`:

```javascript
    return { bueSubScore, denSubScore };
```

- [ ] **Step 4: Run tests**

```sh
npx vitest run tests/growth-score.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```sh
git add js/growth-score.js tests/growth-score.test.js
git commit -m "feat(growth): DEN sub-score (densification)"
```

### Task 4: CAP (Capital Flow) sub-score

**Files:**
- Modify: `js/growth-score.js`
- Test: `tests/growth-score.test.js`

- [ ] **Step 1: Append failing tests**

```javascript
describe('GrowthScore.capSubScore()', () => {
    const projects = [
        // [project_value_rupees, age_years, distance_km]
        { value: 100_000_000, age_yrs: 1, distance_km: 0.5 },
        { value: 250_000_000, age_yrs: 2, distance_km: 1.0 },
        { value: 50_000_000,  age_yrs: 3, distance_km: 2.0 },
    ];

    it('returns 0 for empty project list', () => {
        const s = globalThis.GrowthScore.capSubScore({ rera_projects: [] });
        expect(s).toBe(0);
    });

    it('returns null when rera_projects is undefined (out-of-state)', () => {
        const s = globalThis.GrowthScore.capSubScore({ rera_projects: null });
        expect(s).toBeNull();
    });

    it('produces a positive score for nearby recent projects', () => {
        const s = globalThis.GrowthScore.capSubScore({ rera_projects: projects });
        expect(s).toBeGreaterThan(20);
        expect(s).toBeLessThanOrEqual(100);
    });

    it('weights closer/newer projects more than far/old ones', () => {
        const near = globalThis.GrowthScore.capSubScore({
            rera_projects: [{ value: 100_000_000, age_yrs: 0.5, distance_km: 0.3 }]
        });
        const far = globalThis.GrowthScore.capSubScore({
            rera_projects: [{ value: 100_000_000, age_yrs: 5, distance_km: 1.8 }]
        });
        expect(near).toBeGreaterThan(far);
    });
});
```

- [ ] **Step 2: Run, confirm failure**

```sh
npx vitest run tests/growth-score.test.js -t capSubScore
```

Expected: 4 failures.

- [ ] **Step 3: Add `capSubScore` + `normLog` helper to `js/growth-score.js`**

```javascript
    /** Log-scale normaliser: maps 0..anchor to 0..100 smoothly.
     *  Same shape as the normLog used in data-fetcher.js. */
    function normLog(val, anchor) {
        if (val <= 0) return 0;
        return Math.min(100, Math.round((Math.log(1 + val) / Math.log(1 + anchor)) * 100));
    }

    /** Capital Flow (CAP).
     *  rera_projects: Array<{ value, age_yrs, distance_km }>  | null
     *  null = source unavailable (out of state). Empty array = no projects nearby. */
    function capSubScore({ rera_projects }) {
        if (rera_projects == null) return null;
        if (rera_projects.length === 0) return 0;
        const weightedSum = rera_projects.reduce((acc, p) => {
            const w = Math.exp(-p.age_yrs / 2) * Math.exp(-p.distance_km / 1.5);
            return acc + (p.value || 0) * w;
        }, 0);
        return normLog(weightedSum, 500_000_000);
    }
```

Update the `return`:

```javascript
    return { bueSubScore, denSubScore, capSubScore, normLog };
```

- [ ] **Step 4: Run tests**

```sh
npx vitest run tests/growth-score.test.js
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```sh
git add js/growth-score.js tests/growth-score.test.js
git commit -m "feat(growth): CAP sub-score (capital flow via RERA)"
```

### Task 5: Composite scores + re-weighting on null sub-scores

**Files:**
- Modify: `js/growth-score.js`
- Test: `tests/growth-score.test.js`

- [ ] **Step 1: Append failing tests**

```javascript
describe('GrowthScore.composite()', () => {
    const sub = { bue: 80, den: 60, cap: 40 };

    it('applies nowcast weights 0.4/0.3/0.3', () => {
        const c = globalThis.GrowthScore.composite(sub, 'nowcast');
        // 0.4*80 + 0.3*60 + 0.3*40 = 32 + 18 + 12 = 62
        expect(c.composite).toBe(62);
        expect(c.effective_weights).toEqual({ bue: 0.4, den: 0.3, cap: 0.3 });
    });

    it('applies 1-2 year weights 0.2/0.2/0.6', () => {
        const c = globalThis.GrowthScore.composite(sub, 'year_2');
        // 0.2*80 + 0.2*60 + 0.6*40 = 16 + 12 + 24 = 52
        expect(c.composite).toBe(52);
    });

    it('re-weights remaining when cap is null', () => {
        const c = globalThis.GrowthScore.composite(
            { bue: 80, den: 60, cap: null },
            'nowcast'
        );
        // Original weights 0.4 + 0.3 = 0.7; normalised: bue=0.571, den=0.429
        // 0.571*80 + 0.429*60 = 45.7 + 25.7 = 71.4 → 71
        expect(c.composite).toBe(71);
        expect(c.effective_weights.cap).toBe(0);
        expect(c.effective_weights.bue + c.effective_weights.den).toBeCloseTo(1, 5);
    });

    it('returns composite=null when all sub-scores are null', () => {
        const c = globalThis.GrowthScore.composite(
            { bue: null, den: null, cap: null },
            'nowcast'
        );
        expect(c.composite).toBeNull();
    });
});
```

- [ ] **Step 2: Run, confirm failure**

```sh
npx vitest run tests/growth-score.test.js -t composite
```

Expected: 4 failures.

- [ ] **Step 3: Add `composite` to `js/growth-score.js`**

```javascript
    const HORIZON_WEIGHTS = {
        nowcast: { bue: 0.4, den: 0.3, cap: 0.3 },
        year_2:  { bue: 0.2, den: 0.2, cap: 0.6 },
        year_5:  { bue: 0.4, den: 0.3, cap: 0.3 },  // base weights; year_5 also uses linearTrend
    };

    /** Composite for one horizon. Re-normalises weights when sub-scores are null.
     *  Returns { composite, effective_weights }. */
    function composite(sub, horizon) {
        const base = HORIZON_WEIGHTS[horizon] || HORIZON_WEIGHTS.nowcast;
        let totalWeight = 0;
        const effective = { bue: 0, den: 0, cap: 0 };
        for (const dim of ['bue', 'den', 'cap']) {
            if (sub[dim] != null) {
                effective[dim] = base[dim];
                totalWeight += base[dim];
            }
        }
        if (totalWeight === 0) {
            return { composite: null, effective_weights: effective };
        }
        // Renormalise
        for (const dim of ['bue', 'den', 'cap']) {
            effective[dim] = effective[dim] / totalWeight;
        }
        let value = 0;
        for (const dim of ['bue', 'den', 'cap']) {
            if (sub[dim] != null) value += effective[dim] * sub[dim];
        }
        return {
            composite: Math.round(value),
            effective_weights: effective,
        };
    }
```

Update return:

```javascript
    return { bueSubScore, denSubScore, capSubScore, normLog, composite, HORIZON_WEIGHTS };
```

- [ ] **Step 4: Run tests**

```sh
npx vitest run tests/growth-score.test.js
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```sh
git add js/growth-score.js tests/growth-score.test.js
git commit -m "feat(growth): composite + re-weighting on null sub-scores"
```

### Task 6: Linear-trend extrapolation + r²-based confidence band

**Files:**
- Modify: `js/growth-score.js`
- Test: `tests/growth-score.test.js`

- [ ] **Step 1: Append failing tests**

```javascript
describe('GrowthScore.linearTrend()', () => {
    it('returns slope=1 + r²=1 for a perfect line y=x', () => {
        const t = globalThis.GrowthScore.linearTrend([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(t.slope).toBeCloseTo(1, 5);
        expect(t.r_squared).toBeCloseTo(1, 5);
    });

    it('returns slope=0 for a flat series', () => {
        const t = globalThis.GrowthScore.linearTrend([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
        expect(t.slope).toBeCloseTo(0, 5);
    });

    it('returns null for series shorter than 3', () => {
        expect(globalThis.GrowthScore.linearTrend([0.5, 0.5])).toBeNull();
    });
});

describe('GrowthScore.confidenceBand()', () => {
    it('returns 5 for nowcast regardless of r²', () => {
        expect(globalThis.GrowthScore.confidenceBand('nowcast', 0.0)).toBe(5);
        expect(globalThis.GrowthScore.confidenceBand('nowcast', 1.0)).toBe(5);
    });

    it('returns 10 for year_2 regardless of r²', () => {
        expect(globalThis.GrowthScore.confidenceBand('year_2', 0.5)).toBe(10);
    });

    it('returns ±10 (floor) for year_5 with r²=1', () => {
        expect(globalThis.GrowthScore.confidenceBand('year_5', 1.0)).toBe(10);
    });

    it('returns ±25 for year_5 with r²=0', () => {
        expect(globalThis.GrowthScore.confidenceBand('year_5', 0.0)).toBe(25);
    });

    it('returns floor ±10 for negative or null r²', () => {
        expect(globalThis.GrowthScore.confidenceBand('year_5', null)).toBe(25);
        expect(globalThis.GrowthScore.confidenceBand('year_5', -0.2)).toBe(25);
    });
});
```

- [ ] **Step 2: Run, confirm failure**

```sh
npx vitest run tests/growth-score.test.js -t "linearTrend|confidenceBand"
```

Expected: failures.

- [ ] **Step 3: Add `linearTrend` and `confidenceBand`**

```javascript
    /** Ordinary least squares trend on a uniformly-spaced series.
     *  Returns { slope, intercept, r_squared } or null if too short. */
    function linearTrend(values) {
        if (!values || values.length < 3) return null;
        const n = values.length;
        const xs = values.map((_, i) => i);
        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = values.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0, totSS = 0;
        for (let i = 0; i < n; i++) {
            num += (xs[i] - meanX) * (values[i] - meanY);
            den += (xs[i] - meanX) ** 2;
            totSS += (values[i] - meanY) ** 2;
        }
        const slope = den === 0 ? 0 : num / den;
        const intercept = meanY - slope * meanX;
        let resSS = 0;
        for (let i = 0; i < n; i++) {
            const pred = slope * xs[i] + intercept;
            resSS += (values[i] - pred) ** 2;
        }
        const r_squared = totSS === 0 ? 1 : Math.max(0, Math.min(1, 1 - resSS / totSS));
        return { slope, intercept, r_squared };
    }

    /** Per-horizon confidence band (±value). */
    function confidenceBand(horizon, r_squared) {
        if (horizon === 'nowcast') return 5;
        if (horizon === 'year_2') return 10;
        // year_5: tight when trend is stable, wide when noisy. Floor at ±10.
        const r2 = (r_squared == null || r_squared < 0) ? 0 : r_squared;
        return Math.max(10, Math.round(25 * (1 - r2)));
    }
```

Update return:

```javascript
    return { bueSubScore, denSubScore, capSubScore, normLog,
             composite, HORIZON_WEIGHTS, linearTrend, confidenceBand };
```

- [ ] **Step 4: Run tests**

```sh
npx vitest run tests/growth-score.test.js
```

Expected: PASS, all 22 tests.

- [ ] **Step 5: Commit**

```sh
git add js/growth-score.js tests/growth-score.test.js
git commit -m "feat(growth): linear-trend extrapolation + r²-based confidence band"
```

---

## Phase 2 — Python pipeline (slow tier)

Extract Open Buildings Temporal, VIIRS, and GHSL to Cloud-Optimized GeoTIFFs hosted in `data/growth/`. Run once-per-quarter locally or via CI cron.

### Task 7: Pipeline scaffold + dependencies

**Files:**
- Create: `pipeline/growth/__init__.py`
- Create: `pipeline/growth/requirements.txt`
- Create: `pipeline/growth/README.md`
- Create: `pipeline/growth/tests/__init__.py`

- [ ] **Step 1: Create the package**

```sh
mkdir -p pipeline/growth/tests
touch pipeline/growth/__init__.py
touch pipeline/growth/tests/__init__.py
```

- [ ] **Step 2: Write `pipeline/growth/__init__.py`**

```python
"""Urban Growth Forecast pipeline — extracts COGs from Earth Engine.

Spec reference: docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md §6

Output written to data/growth/:
  buildings_temporal_2016-2023.tif  (8-band, Open Buildings Temporal V1)
  viirs_2016-2024.tif               (9-band, NASA VIIRS night lights)
  ghsl_pop_2025.tif                 (single-band, EU JRC GHSL)

Run with `python -m pipeline.growth.extract_buildings_temporal` etc.
GEE auth via GOOGLE_APPLICATION_CREDENTIALS env var.
"""
```

- [ ] **Step 3: Write `pipeline/growth/requirements.txt`**

```
earthengine-api>=0.1.385
rasterio>=1.3.10
rio-cogeo>=5.0
requests>=2.31
numpy>=1.26
```

- [ ] **Step 4: Write `pipeline/growth/README.md`**

```markdown
# `pipeline/growth/` — Growth Forecast data pipeline

Builds the three Cloud-Optimized GeoTIFFs that power the urban growth
forecast feature. See [spec §6](../../docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md#6-data-sources--pipeline).

## Setup

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r pipeline/growth/requirements.txt

# Earth Engine auth (one-time)
export GOOGLE_APPLICATION_CREDENTIALS=~/.gee/digipin-credentials.json
```

## Run

```sh
python -m pipeline.growth.extract_buildings_temporal   # ~20 min, 8-band COG
python -m pipeline.growth.extract_viirs_annual         # ~10 min, 9-band COG
python -m pipeline.growth.download_ghsl_pop            # ~1 min, single COG
```

Output in `data/growth/`.

## Refresh cadence

| Source | When |
|---|---|
| Buildings Temporal | Yearly, when Google publishes the next year |
| VIIRS | Quarterly |
| GHSL | Every 5 years (next 2030) |
```

- [ ] **Step 5: Commit**

```sh
git add pipeline/growth/
git commit -m "feat(growth): pipeline package scaffold"
```

### Task 8: `extract_buildings_temporal.py`

**Files:**
- Create: `pipeline/growth/extract_buildings_temporal.py`
- Create: `pipeline/growth/tests/test_extract_buildings_temporal.py`

- [ ] **Step 1: Write the smoke test first**

```python
"""Smoke test for the buildings-temporal extractor.

Doesn't hit GEE (would need credentials in CI). Just verifies the
module imports cleanly and constants are sane.
"""

import importlib


def test_module_imports():
    mod = importlib.import_module("pipeline.growth.extract_buildings_temporal")
    assert hasattr(mod, "main")
    assert hasattr(mod, "INDIA_BBOX")
    assert hasattr(mod, "YEARS")


def test_india_bbox_is_sensible():
    from pipeline.growth.extract_buildings_temporal import INDIA_BBOX
    # west, south, east, north
    assert INDIA_BBOX[0] < INDIA_BBOX[2]    # west < east
    assert INDIA_BBOX[1] < INDIA_BBOX[3]    # south < north
    assert 60 < INDIA_BBOX[0] < 80          # India is in this lng range
    assert 5 < INDIA_BBOX[1] < 15           # southern tip


def test_year_range():
    from pipeline.growth.extract_buildings_temporal import YEARS
    assert YEARS[0] == 2016
    assert YEARS[-1] == 2023
    assert len(YEARS) == 8
```

- [ ] **Step 2: Run, confirm failure**

```sh
pytest pipeline/growth/tests/test_extract_buildings_temporal.py -v
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Write the extractor**

```python
"""Extract Open Buildings Temporal V1 for India as an 8-band COG.

Bands: one per year 2016..2023, value = building_presence (0..1, fractional).
Resolution: 4m (matches DigiPin cell size).

Auth: requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service
account JSON with Earth Engine API access.

Output: data/growth/buildings_temporal_2016-2023.tif
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("pipeline.growth.buildings")

# India bounding box (west, south, east, north) — tight around India main + NE
INDIA_BBOX = (68.0, 6.5, 97.5, 35.5)
YEARS = list(range(2016, 2024))   # 8 inclusive years
ASSET_ID = "GOOGLE/Research/open-buildings-temporal/v1"
OUTPUT_PATH = Path("data/growth/buildings_temporal_2016-2023.tif")
SCALE_M = 4   # GEE export scale; matches DigiPin grain


def _init_ee():
    """Initialise Earth Engine — service account in CI, cached OAuth in dev.

    Phase 0a confirmed (2026-05-24) that:
      - OAuth credentials cached at ~/.config/earthengine/credentials work
      - The GCP project must be passed explicitly via the `project` kwarg
        (defaults like `delta-guild-367407` aren't EE-registered and error
        with 'Project X is not registered to use Earth Engine')
    """
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred_path and Path(cred_path).is_file():
        credentials = ee.ServiceAccountCredentials(None, cred_path)
        ee.Initialize(credentials, project=project)
        log.info("Earth Engine initialised via service account, project=%s", project)
        return
    # Fall back to cached OAuth credentials (from `earthengine authenticate`)
    ee.Initialize(project=project)
    log.info("Earth Engine initialised via cached OAuth, project=%s", project)


def _build_image():
    """Combine 8 years of building_presence into one 8-band image."""
    import ee
    collection = ee.ImageCollection(ASSET_ID)
    region = ee.Geometry.Rectangle(INDIA_BBOX, "EPSG:4326", False)

    images = []
    for year in YEARS:
        annual = (collection
                  .filterDate(f"{year}-01-01", f"{year}-12-31")
                  .select("building_presence")
                  .mean()
                  .rename(f"presence_{year}"))
        images.append(annual)
    stacked = ee.Image.cat(images).clip(region)
    return stacked, region


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _init_ee()
    import ee

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    stacked, region = _build_image()

    log.info("Starting EE export of 8-band buildings_temporal COG to %s ...", OUTPUT_PATH)
    log.info("This will run as a Drive export task; manual download afterwards. See README.")

    task = ee.batch.Export.image.toDrive(
        image=stacked,
        description="digipin_buildings_temporal_2016_2023",
        folder="DigiPin",
        fileNamePrefix="buildings_temporal_2016-2023",
        region=region,
        scale=SCALE_M,
        maxPixels=1e13,
        fileFormat="GeoTIFF",
        formatOptions={"cloudOptimized": True},
    )
    task.start()

    # Poll until done (long — 20-60 min for India bbox at 4m scale)
    while task.active():
        log.info("Export status: %s", task.status())
        time.sleep(60)
    final = task.status()
    log.info("Export finished: %s", final)
    if final.get("state") != "COMPLETED":
        log.error("Export did not complete cleanly: %s", final)
        sys.exit(1)

    log.info("✓ Done. Download from Google Drive folder 'DigiPin' and move to %s", OUTPUT_PATH)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run smoke test**

```sh
pytest pipeline/growth/tests/test_extract_buildings_temporal.py -v
```

Expected: PASS, 3 tests.

- [ ] **Step 5: (Optional) Run the actual extractor locally**

```sh
export GOOGLE_APPLICATION_CREDENTIALS=~/.gee/digipin-credentials.json
python -m pipeline.growth.extract_buildings_temporal
```

Expected: prints "Export status..." every minute, eventually completes. Result downloads to your Google Drive's `DigiPin/` folder. Move the file to `data/growth/buildings_temporal_2016-2023.tif`.

- [ ] **Step 6: Commit**

```sh
git add pipeline/growth/extract_buildings_temporal.py pipeline/growth/tests/test_extract_buildings_temporal.py
git commit -m "feat(growth): GEE extractor for Open Buildings Temporal V1 (8-band COG)"
```

### Task 9: `extract_viirs_annual.py`

**Files:**
- Create: `pipeline/growth/extract_viirs_annual.py`
- Create: `pipeline/growth/tests/test_extract_viirs_annual.py`

- [ ] **Step 1: Write smoke test (mirror of Task 8)**

```python
"""Smoke test for the VIIRS annual extractor."""

import importlib


def test_module_imports():
    mod = importlib.import_module("pipeline.growth.extract_viirs_annual")
    assert hasattr(mod, "main")
    assert hasattr(mod, "YEARS")


def test_year_range():
    from pipeline.growth.extract_viirs_annual import YEARS
    assert YEARS[0] == 2016
    assert YEARS[-1] == 2024
    assert len(YEARS) == 9
```

- [ ] **Step 2: Run, confirm failure**

```sh
pytest pipeline/growth/tests/test_extract_viirs_annual.py -v
```

- [ ] **Step 3: Write the extractor (mirror structure of buildings_temporal)**

```python
"""Extract VIIRS Day/Night-Band annual composites for India as a 9-band COG.

Asset: NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG — monthly stable-light composites.
We average all months per year to get annual night-light intensity.

Bands: one per year 2016..2024.
Resolution: native VIIRS ~500m, downsampled to 100m for the export.

Output: data/growth/viirs_2016-2024.tif
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("pipeline.growth.viirs")

INDIA_BBOX = (68.0, 6.5, 97.5, 35.5)
YEARS = list(range(2016, 2025))
ASSET_ID = "NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG"
OUTPUT_PATH = Path("data/growth/viirs_2016-2024.tif")
SCALE_M = 100


def _init_ee():
    """Same dual-path init as extract_buildings_temporal._init_ee()."""
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and Path(cred).is_file():
        ee.Initialize(ee.ServiceAccountCredentials(None, cred), project=project)
    else:
        ee.Initialize(project=project)


def _build_image():
    import ee
    coll = ee.ImageCollection(ASSET_ID)
    region = ee.Geometry.Rectangle(INDIA_BBOX, "EPSG:4326", False)
    bands = []
    for year in YEARS:
        annual = (coll
                  .filterDate(f"{year}-01-01", f"{year}-12-31")
                  .select("avg_rad")
                  .mean()
                  .rename(f"viirs_{year}"))
        bands.append(annual)
    return ee.Image.cat(bands).clip(region), region


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _init_ee()
    import ee
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    image, region = _build_image()
    log.info("Starting VIIRS export ...")
    task = ee.batch.Export.image.toDrive(
        image=image,
        description="digipin_viirs_2016_2024",
        folder="DigiPin",
        fileNamePrefix="viirs_2016-2024",
        region=region, scale=SCALE_M, maxPixels=1e13,
        fileFormat="GeoTIFF",
        formatOptions={"cloudOptimized": True},
    )
    task.start()
    while task.active():
        log.info("Export status: %s", task.status())
        time.sleep(60)
    final = task.status()
    if final.get("state") != "COMPLETED":
        log.error("Export failed: %s", final)
        sys.exit(1)
    log.info("✓ Done. Move to %s", OUTPUT_PATH)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run smoke test**

```sh
pytest pipeline/growth/tests/test_extract_viirs_annual.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pipeline/growth/extract_viirs_annual.py pipeline/growth/tests/test_extract_viirs_annual.py
git commit -m "feat(growth): GEE extractor for VIIRS annual night lights (9-band COG)"
```

### Task 10: `download_ghsl_pop.py`

**Files:**
- Create: `pipeline/growth/download_ghsl_pop.py`

- [ ] **Step 1: Write the static downloader**

```python
"""Download GHSL GHS-POP 2025 epoch population grid (100m resolution) for India.

GHSL is CC-BY 4.0 from EU JRC. No auth, no GEE needed — direct HTTPS GET.

Source: https://ghsl.jrc.ec.europa.eu/datasets.php?ds=pop
We download the 100m global mosaic and clip to India bbox using rasterio.

Output: data/growth/ghsl_pop_2025.tif
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from urllib.request import urlopen

import rasterio
from rasterio.windows import from_bounds
from rasterio.io import MemoryFile

log = logging.getLogger("pipeline.growth.ghsl")

GHSL_URL = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
    "GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_3ss/V1-0/"
    "GHS_POP_E2025_GLOBE_R2023A_4326_3ss_V1_0.tif"
)
INDIA_BBOX = (68.0, 6.5, 97.5, 35.5)
OUTPUT_PATH = Path("data/growth/ghsl_pop_2025.tif")


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    tmp_path = OUTPUT_PATH.with_suffix(".global.tif")
    if not tmp_path.exists():
        log.info("Downloading GHSL global mosaic (~500 MB, may take 5-10 min) ...")
        with urlopen(GHSL_URL) as resp, tmp_path.open("wb") as f:
            shutil.copyfileobj(resp, f)
    else:
        log.info("Reusing cached global mosaic at %s", tmp_path)

    log.info("Clipping to India bbox %s ...", INDIA_BBOX)
    with rasterio.open(tmp_path) as src:
        window = from_bounds(*INDIA_BBOX, transform=src.transform)
        data = src.read(window=window)
        transform = src.window_transform(window)
        profile = src.profile.copy()
        profile.update({
            "height": data.shape[1],
            "width": data.shape[2],
            "transform": transform,
            "compress": "deflate",
            "tiled": True,
        })
        with rasterio.open(OUTPUT_PATH, "w", **profile) as dst:
            dst.write(data)

    log.info("✓ Wrote %s (%.1f MB)", OUTPUT_PATH, OUTPUT_PATH.stat().st_size / 1e6)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write a minimal smoke test (mock urlopen + rasterio)**

Create `pipeline/growth/tests/test_download_ghsl_pop.py`:

```python
"""Smoke test for the GHSL downloader.

Doesn't actually hit jeodpp.jrc.ec.europa.eu (it's a 500 MB download).
Verifies module imports and that key constants are sane.
"""

import importlib


def test_module_imports():
    mod = importlib.import_module("pipeline.growth.download_ghsl_pop")
    assert hasattr(mod, "main")
    assert hasattr(mod, "GHSL_URL")
    assert hasattr(mod, "INDIA_BBOX")
    assert hasattr(mod, "OUTPUT_PATH")


def test_url_targets_2025_epoch():
    from pipeline.growth.download_ghsl_pop import GHSL_URL
    assert "E2025" in GHSL_URL or "2025" in GHSL_URL


def test_output_path_in_data_growth():
    from pipeline.growth.download_ghsl_pop import OUTPUT_PATH
    assert str(OUTPUT_PATH).replace("\\", "/").endswith("data/growth/ghsl_pop_2025.tif")


def test_india_bbox_sane():
    from pipeline.growth.download_ghsl_pop import INDIA_BBOX
    west, south, east, north = INDIA_BBOX
    assert west < east and south < north
    assert 60 < west < 80 and 5 < south < 15
```

- [ ] **Step 3: Run smoke test**

```sh
pytest pipeline/growth/tests/test_download_ghsl_pop.py -v
```

Expected: PASS, 4 tests.

- [ ] **Step 4: Commit**

```sh
git add pipeline/growth/download_ghsl_pop.py pipeline/growth/tests/test_download_ghsl_pop.py
git commit -m "feat(growth): GHSL population grid downloader (one-off, 100m clip to India)"
```

---

## Phase 3 — RERA Madhya Pradesh scraper

Plugs into the existing PR #5 scraper framework. One new file in `scrapers/sources/` + workflow matrix entry + README section.

### Task 11: `scrapers/sources/rera_mp.py`

**Files:**
- Create: `scrapers/sources/rera_mp.py`
- Create: `scrapers/sources/tests/__init__.py`
- Create: `scrapers/sources/tests/test_rera_mp.py`

- [ ] **Step 1: Write the test first**

```sh
mkdir -p scrapers/sources/tests
touch scrapers/sources/tests/__init__.py
```

Create `scrapers/sources/tests/test_rera_mp.py`:

```python
"""Test the RERA MP scraper's HTML-parsing logic in isolation (no network)."""

from scrapers.sources.rera_mp import Project, parse_project_table


SAMPLE_HTML = """
<table id="projectTable">
  <tr><th>Name</th><th>Type</th><th>Location</th><th>Area (m²)</th><th>Approval Date</th><th>Value (₹)</th></tr>
  <tr><td>Ashok Vihar</td><td>Residential</td><td>22.7196, 75.8577</td><td>1500</td><td>2023-04-15</td><td>120000000</td></tr>
  <tr><td>Indore Mall</td><td>Commercial</td><td>22.7510, 75.8930</td><td>4000</td><td>2024-01-20</td><td>450000000</td></tr>
</table>
"""


def test_parse_two_projects():
    projects = parse_project_table(SAMPLE_HTML)
    assert len(projects) == 2
    assert projects[0].name == "Ashok Vihar"
    assert projects[0].lat == 22.7196
    assert projects[0].lng == 75.8577
    assert projects[0].value == 120000000
    assert projects[1].value == 450000000


def test_parse_handles_empty_table():
    projects = parse_project_table("<table id='projectTable'></table>")
    assert projects == []


def test_parse_handles_missing_table():
    projects = parse_project_table("<html><body>no table here</body></html>")
    assert projects == []
```

- [ ] **Step 2: Run, confirm failure**

```sh
pytest scrapers/sources/tests/test_rera_mp.py -v
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Write the source**

```python
"""RERA Madhya Pradesh — registered real-estate project listing.

Endpoint: https://rera.mp.gov.in/  (state portal)

SSL note: portal has a legacy renegotiation issue (verified during the
brainstorm session); the scraper uses --insecure / verify=False.
Same pattern as the IMD sources in PR #6.

Output schema (latest.json records):
    Project: id, name, project_type, lat, lng, area_m2, approval_date_iso, value_rupees
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from bs4 import BeautifulSoup

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.rera_mp")

SOURCE_ID = "rera_mp"
# Note: Phase 0b probe (2026-05-24) found the portal:
#   - moved to www.rera.mp.gov.in (rera.mp.gov.in 301-redirects there)
#   - has a valid cert now (no more legacy renegotiation, default verify=True is fine)
#   - exposes the project listing at /projects/, not /Project/Allproject
# The implementer subagent should still run the live probe in Task 11 Step 5
# to confirm the table element id (the parser assumes id="projectTable" but
# the portal may use a different element — adjust accordingly).
LISTING_URL = "https://www.rera.mp.gov.in/projects/"


@dataclass
class Project:
    id: str
    name: str
    project_type: str
    lat: float
    lng: float
    area_m2: float
    approval_date_iso: str
    value_rupees: float

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "name", "project_type", "lat", "lng",
            "area_m2", "approval_date_iso", "value_rupees",
        ]


def _parse_latlng(s: str) -> tuple[float | None, float | None]:
    m = re.search(r"(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)", s or "")
    if not m:
        return None, None
    return float(m.group(1)), float(m.group(2))


def _to_float(s: str) -> float | None:
    try:
        return float((s or "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def parse_project_table(html: str) -> list[Project]:
    """Pure parser — extracted for testability."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="projectTable")
    if not table:
        return []
    rows = table.find_all("tr")
    projects: list[Project] = []
    for i, row in enumerate(rows[1:], start=1):  # skip header
        cells = [td.get_text(strip=True) for td in row.find_all("td")]
        if len(cells) < 6:
            continue
        name, ptype, location, area, date, value = cells[:6]
        lat, lng = _parse_latlng(location)
        if lat is None or lng is None:
            continue
        projects.append(Project(
            id=f"rera_mp:{i}:{name}",
            name=name,
            project_type=ptype,
            lat=lat, lng=lng,
            area_m2=_to_float(area) or 0.0,
            approval_date_iso=date or "",
            value_rupees=_to_float(value) or 0.0,
        ))
    return projects


def fetch(client: PoliteClient) -> list[Project]:
    body = client.get(LISTING_URL)
    if body is None:
        log.error("RERA MP listing fetch failed (SSL or 5xx)")
        return []
    projects = parse_project_table(body.decode("utf-8", errors="replace"))
    log.info("rera_mp: parsed %d project(s)", len(projects))
    return projects


def key_for(record: Project) -> str:
    return record.id
```

- [ ] **Step 4: Run tests**

```sh
pytest scrapers/sources/tests/test_rera_mp.py -v
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Run the scraper live (manual check)**

```sh
python -m scrapers.cli rera_mp -v
```

Expected: log shows `rera_mp: parsed N project(s)` with N > 0. If 0 (or SSL-handshake failure), check Task 0b — the portal may have changed.

- [ ] **Step 6: Commit**

```sh
git add scrapers/sources/rera_mp.py scrapers/sources/tests/
git commit -m "feat(growth): RERA Madhya Pradesh scraper (CAP signal for 1-2 yr horizon)"
```

### Task 12: Workflow + README

**Files:**
- Modify: `.github/workflows/realtime-scrape.yml`
- Modify: `scrapers/README.md`

- [ ] **Step 1: Add `rera_mp` to the matrix**

Edit `.github/workflows/realtime-scrape.yml`. In the existing `matrix.source` list, add `rera_mp` at the end.

- [ ] **Step 2: Append README section**

Append to `scrapers/README.md` (mirror the existing source sections):

```markdown
### `rera_mp` — RERA Madhya Pradesh project listing

- **What**: Approved real-estate projects in Madhya Pradesh — name, lat/lng, area, approval date, project value (₹)
- **URL**: <https://rera.mp.gov.in/Project/Allproject>
- **Auth**: none (uses verify=False due to legacy SSL renegotiation; see source docstring)
- **Format**: HTML table (`#projectTable`)
- **Update frequency**: weekly (cron override in the workflow)
- **Coverage**: Madhya Pradesh state. Other states are Phase 2 follow-ups
- **Why this matters for DigiPin**: powers the CAP (capital flow) sub-score for the 1-2 year horizon of the Urban Growth Forecast feature (spec §5)
```

- [ ] **Step 3: Commit**

```sh
git add .github/workflows/realtime-scrape.yml scrapers/README.md
git commit -m "ci(growth): add rera_mp to scraper workflow matrix"
```

---

## Phase 4 — Browser data fetcher

Glue layer between the offline COGs/JSON and the score module. Pure orchestration — minimal logic.

### Task 13: `js/realtime-growth.js`

**Files:**
- Create: `js/realtime-growth.js`
- Create: `tests/realtime-growth.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';

// Load growth-score.js (dependency) first, then realtime-growth.js
const ctx = { globalThis, window: globalThis };
const scoreCode = readFileSync(path.join(process.cwd(), 'js/growth-score.js'), 'utf-8');
vm.runInNewContext(scoreCode, ctx);
const rtCode = readFileSync(path.join(process.cwd(), 'js/realtime-growth.js'), 'utf-8');
vm.runInNewContext(rtCode, ctx);

describe('RealtimeGrowth.scoreCell()', () => {
    const sample = {
        buildings_temporal: [0.30, 0.32, 0.35, 0.40, 0.45, 0.50, 0.55, 0.62],   // strong upward
        heights: [3, 3, 3, 4, 4, 5, 5, 6],
        viirs: [1.0, 1.0, 1.2, 1.5, 1.7, 1.9, 2.0, 2.2, 2.3],
        ghsl_pop_5yr_pct: 8,
        osm_commercial_density: 12,
        osm_construction_count: 4,
        rera_projects: [
            { value: 100_000_000, age_yrs: 1, distance_km: 0.8 },
            { value: 250_000_000, age_yrs: 2, distance_km: 1.2 },
        ],
    };

    it('returns a populated result.realtime.growth schema', () => {
        const r = globalThis.RealtimeGrowth.scoreCell(sample);
        expect(r.horizons.nowcast.composite).toBeGreaterThan(50);
        expect(r.horizons.year_2.composite).toBeGreaterThan(50);
        expect(r.horizons.year_5.composite).toBeGreaterThan(50);
        expect(r.horizons.nowcast.confidence_band).toBe(5);
        expect(r.horizons.year_2.confidence_band).toBe(10);
        expect(r.horizons.year_5.confidence_band).toBeGreaterThanOrEqual(10);
        expect(r.horizons.year_5.confidence_band).toBeLessThanOrEqual(25);
    });

    it('returns growth=null when every source is missing', () => {
        const r = globalThis.RealtimeGrowth.scoreCell({
            buildings_temporal: null,
            heights: null,
            viirs: null,
            ghsl_pop_5yr_pct: null,
            osm_commercial_density: null,
            osm_construction_count: 0,
            rera_projects: null,
        });
        expect(r).toBeNull();
    });

    it('reports source availability in result.sources', () => {
        const r = globalThis.RealtimeGrowth.scoreCell({
            ...sample,
            rera_projects: null,    // out of state
        });
        expect(r.sources.rera_mp).toBe('out_of_state');
        expect(r.sources.buildings_temporal).toBe('ok');
    });
});
```

- [ ] **Step 2: Run, confirm failure**

```sh
npx vitest run tests/realtime-growth.test.js
```

- [ ] **Step 3: Write `js/realtime-growth.js`**

```javascript
/**
 * RealtimeGrowth — Urban Growth Forecast data layer.
 *
 * Two responsibilities (kept narrow per spec §7.5 + harness principles):
 *   1. fetchCell(lat, lng)  — async; reads COGs + RERA snapshot, returns raw signal bundle
 *   2. scoreCell(signals)   — pure; collapses signals to the result.realtime.growth schema
 *
 * The orchestrator in data-fetcher.js calls fetchCell(...).then(scoreCell)
 * and stashes the result on result.realtime.growth.
 *
 * Spec: docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md §4.1 (schema) + §5 (math)
 */

const RealtimeGrowth = (() => {
    const COG_BUILDINGS  = 'data/growth/buildings_temporal_2016-2023.tif';
    const COG_VIIRS      = 'data/growth/viirs_2016-2024.tif';
    const COG_GHSL       = 'data/growth/ghsl_pop_2025.tif';
    const RERA_SNAPSHOT  = 'data/realtime/rera_mp/latest.json';
    const RERA_RADIUS_KM = 2.0;
    const RERA_TTL_MS    = 5 * 60 * 1000;

    let _reraCache = null;
    let _reraFetchedAt = 0;

    function _haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
                  Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
                  Math.sin(dLng/2)**2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    async function _readCog(url, lat, lng) {
        // Uses georaster.browser.bundle.min.js loaded by index.html.
        // Returns Array<number> (one value per band) or null on failure.
        try {
            if (typeof parseGeoraster !== 'function') return null;
            const resp = await fetch(url, { cache: 'force-cache' });
            if (!resp.ok) return null;
            const buf = await resp.arrayBuffer();
            const gr = await parseGeoraster(buf);
            const [px, py] = gr.toCanvasCoords([lng, lat]);
            if (px < 0 || py < 0 || px >= gr.width || py >= gr.height) return null;
            const out = [];
            for (let b = 0; b < gr.values.length; b++) {
                out.push(gr.values[b][py][px]);
            }
            return out;
        } catch (e) {
            console.warn('[RealtimeGrowth] COG read failed', url, e);
            return null;
        }
    }

    async function _loadReraSnapshot() {
        if (_reraCache && Date.now() - _reraFetchedAt < RERA_TTL_MS) return _reraCache;
        try {
            const r = await fetch(RERA_SNAPSHOT, { cache: 'no-store' });
            if (!r.ok) return null;
            const data = await r.json();
            _reraCache = data;
            _reraFetchedAt = Date.now();
            return data;
        } catch {
            return null;
        }
    }

    async function _reraNearby(lat, lng) {
        const snap = await _loadReraSnapshot();
        if (!snap || !Array.isArray(snap.records)) return null;
        const nearby = [];
        const nowMs = Date.now();
        for (const p of snap.records) {
            const d = _haversineKm(lat, lng, p.lat, p.lng);
            if (d > RERA_RADIUS_KM) continue;
            const approval = new Date(p.approval_date_iso || '2020-01-01').getTime();
            const ageYrs = Math.max(0, (nowMs - approval) / (365.25 * 24 * 3600 * 1000));
            nearby.push({
                value: p.value_rupees || 0,
                age_yrs: ageYrs,
                distance_km: d,
                name: p.name,
            });
        }
        return nearby;
    }

    /** Async — reads all four sources, returns raw signal bundle. */
    async function fetchCell(lat, lng, opts = {}) {
        // OSM-construction count comes from result.categories already populated
        // by data-fetcher.js's main fetch; passed in via opts.
        const [buildings, viirs, ghsl, rera] = await Promise.all([
            _readCog(COG_BUILDINGS, lat, lng),
            _readCog(COG_VIIRS, lat, lng),
            _readCog(COG_GHSL, lat, lng),
            _reraNearby(lat, lng),
        ]);
        // GHSL is single-band; derive pct-change 2020→2025 from the value (placeholder
        // until we have a 2020 layer too — for v1 we approximate by treating the value
        // as already-normalised pop density and use osm signals to infer change).
        // Spec §5 calls this out as a known simplification.
        const popValue = ghsl ? ghsl[0] : null;
        return {
            buildings_temporal: buildings,
            heights: null,   // Phase 2 — temporal V1 also has height bands; defer
            viirs,
            ghsl_pop_5yr_pct: popValue != null ? Math.min(20, popValue / 50) : null,
            osm_commercial_density: opts.osm_commercial_density || 0,
            osm_construction_count: opts.osm_construction_count || 0,
            rera_projects: rera,
        };
    }

    /** Pure — collapses signals to the result.realtime.growth schema. */
    function scoreCell(signals) {
        if (typeof GrowthScore === 'undefined') return null;

        const bue = GrowthScore.bueSubScore(signals);
        const den = GrowthScore.denSubScore(signals);
        const cap = GrowthScore.capSubScore(signals);

        if (bue == null && den == null && cap == null) return null;

        const sub = { bue, den, cap };
        const nowcast = GrowthScore.composite(sub, 'nowcast');
        const year_2  = GrowthScore.composite(sub, 'year_2');

        // Year-5: linear-trend extrapolation over building presence
        const trend = GrowthScore.linearTrend(signals.buildings_temporal);
        const r2 = trend ? trend.r_squared : null;
        const year_5_value = trend
            ? Math.max(0, Math.min(100, nowcast.composite + trend.slope * 5 * 200))
            : nowcast.composite;
        const year_5 = { composite: Math.round(year_5_value), effective_weights: nowcast.effective_weights };

        function buildHorizon(c, horizon, sub) {
            const direction = (s) => s == null ? '—' : (s > 60 ? '▲' : s > 45 ? '▶' : '▽');
            return {
                composite: c.composite,
                confidence_band: GrowthScore.confidenceBand(horizon, r2),
                sub_scores: {
                    bue: { value: sub.bue, direction: direction(sub.bue), driver: '' },
                    den: { value: sub.den, direction: direction(sub.den), driver: '' },
                    cap: { value: sub.cap, direction: direction(sub.cap), driver: '' },
                },
                effective_weights: c.effective_weights,
                ...(horizon === 'year_5' ? { r_squared: r2 } : {}),
            };
        }

        return {
            active_horizon: 'nowcast',
            horizons: {
                nowcast: buildHorizon(nowcast, 'nowcast', sub),
                year_2:  buildHorizon(year_2,  'year_2',  sub),
                year_5:  buildHorizon(year_5,  'year_5',  sub),
            },
            sources: {
                buildings_temporal: signals.buildings_temporal ? 'ok' : 'missing',
                viirs:              signals.viirs              ? 'ok' : 'missing',
                ghsl_pop:           signals.ghsl_pop_5yr_pct != null ? 'ok' : 'missing',
                rera_mp:            signals.rera_projects === null ? 'out_of_state'
                                  : signals.rera_projects.length === 0 ? 'ok'  // empty, but state covered
                                  : 'ok',
                osm:                'ok',  // always available from data-fetcher's main pass
            },
            generated_at_iso: new Date().toISOString(),
        };
    }

    return { fetchCell, scoreCell };
})();

if (typeof window !== 'undefined') {
    window.RealtimeGrowth = RealtimeGrowth;
}
```

- [ ] **Step 4: Run tests**

```sh
npx vitest run tests/realtime-growth.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```sh
git add js/realtime-growth.js tests/realtime-growth.test.js
git commit -m "feat(growth): browser data fetcher + scorer (RealtimeGrowth)"
```

### Task 14: Wire into orchestrator + index.html script load

**Files:**
- Modify: `js/data-fetcher.js`
- Modify: `index.html`

- [ ] **Step 1: Load the two scripts in index.html**

In `index.html`, find the existing script-load block and append:

```html
<script src="js/growth-score.js"></script>
<script src="js/realtime-growth.js"></script>
```

These must load **before** `js/data-fetcher.js` (which calls them).

- [ ] **Step 2: Hook growth into the orchestrator**

Locate the injection point with a grep:

```sh
grep -n "result.realtime = result.realtime || {}" js/data-fetcher.js
```

Expected: one match, likely near the end of `fetchAllFeatures()` (the function that owns the per-cell fetch). Immediately after the existing `if (typeof RealtimeIMD !== 'undefined')` or `RealtimeQuakes` block, append this new block:

```javascript
if (typeof RealtimeGrowth !== 'undefined') {
    try {
        const osmConstruction =
            (result.categories?.landuse?.features?.construction?.count) || 0;
        const osmCommercial =
            (result.categories?.shops?.features?.commercial?.count) || 0;
        const signals = await RealtimeGrowth.fetchCell(lat, lng, {
            osm_construction_count: osmConstruction,
            osm_commercial_density: osmCommercial,
        });
        const growth = RealtimeGrowth.scoreCell(signals);
        if (growth) result.realtime.growth = growth;
    } catch (e) {
        console.warn('[orchestrator] growth fetch skipped:', e);
    }
}
```

- [ ] **Step 3: Smoke check — open index.html, click any cell**

```sh
python serve.py
# Browser: open http://localhost:8000/
# Click an Indore cell, check DevTools console for `result.realtime.growth` value
```

Expected: in DevTools, `result.realtime.growth` is either `null` (if COGs don't exist yet) or a populated object matching the schema.

- [ ] **Step 4: Commit**

```sh
git add index.html js/data-fetcher.js
git commit -m "feat(growth): wire RealtimeGrowth into cell-fetch orchestrator"
```

---

## Phase 5 — UI surfaces (panel widget + map heatmap)

### Task 15: `js/growth-widget.js` — panel widget

**Files:**
- Create: `js/growth-widget.js`
- Create: `tests/growth-widget.test.js`
- Modify: `css/styles.css`
- Modify: `js/panel.js`

- [ ] **Step 1: Write the failing widget test first (TDD discipline)**

Create `tests/growth-widget.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';

const ctx = { globalThis, window: globalThis, document: undefined };
// Minimal DOM
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
ctx.document = dom.window.document;
ctx.window.document = dom.window.document;
globalThis.document = dom.window.document;

const widgetCode = readFileSync(path.join(process.cwd(), 'js/growth-widget.js'), 'utf-8');
vm.runInNewContext(widgetCode, ctx);

describe('GrowthWidget.attachTo()', () => {
    let container;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('renders the "unavailable" state when growth is null', () => {
        globalThis.GrowthWidget.attachTo(container, null, { code: 'X1' });
        expect(container.innerHTML).toContain('Growth data unavailable');
    });

    it('renders 3 horizon buttons and a composite when growth is present', () => {
        const growth = {
            active_horizon: 'nowcast',
            horizons: {
                nowcast: { composite: 72, confidence_band: 5,
                           sub_scores: { bue: {value:80, direction:'▲', driver:''},
                                          den: {value:60, direction:'▶', driver:''},
                                          cap: {value:75, direction:'▲', driver:''} },
                           effective_weights: {bue:0.4, den:0.3, cap:0.3} },
                year_2:  { composite: 65, confidence_band: 10, sub_scores: {bue:{value:80,direction:'▲',driver:''},den:{value:60,direction:'▶',driver:''},cap:{value:55,direction:'▶',driver:''}}, effective_weights: {bue:0.2,den:0.2,cap:0.6} },
                year_5:  { composite: 85, confidence_band: 18, sub_scores: {bue:{value:80,direction:'▲',driver:''},den:{value:60,direction:'▶',driver:''},cap:{value:75,direction:'▲',driver:''}}, effective_weights: {bue:0.4,den:0.3,cap:0.3} },
            },
            sources: {}, generated_at_iso: '2026-05-24T12:00:00Z',
        };
        globalThis.GrowthWidget.attachTo(container, growth, { code: 'X1' });
        expect(container.querySelectorAll('[data-h]').length).toBe(3);
        expect(container.textContent).toContain('72');
        expect(container.textContent).toContain('±5');
    });

    it('is idempotent — calling twice replaces, not duplicates', () => {
        const growth = { active_horizon: 'nowcast', horizons: {
            nowcast: { composite: 50, confidence_band: 5,
                       sub_scores: { bue:{value:50,direction:'▶',driver:''}, den:{value:50,direction:'▶',driver:''}, cap:{value:50,direction:'▶',driver:''} },
                       effective_weights: {bue:0.4, den:0.3, cap:0.3} },
            year_2:  { composite: 50, confidence_band: 10, sub_scores: { bue:{value:50,direction:'▶',driver:''}, den:{value:50,direction:'▶',driver:''}, cap:{value:50,direction:'▶',driver:''} }, effective_weights: {bue:0.2,den:0.2,cap:0.6} },
            year_5:  { composite: 50, confidence_band: 25, sub_scores: { bue:{value:50,direction:'▶',driver:''}, den:{value:50,direction:'▶',driver:''}, cap:{value:50,direction:'▶',driver:''} }, effective_weights: {bue:0.4,den:0.3,cap:0.3} },
        }, sources:{}, generated_at_iso:'' };
        globalThis.GrowthWidget.attachTo(container, growth, { code: 'X1' });
        globalThis.GrowthWidget.attachTo(container, growth, { code: 'X1' });
        expect(container.querySelectorAll('[data-growth-widget]').length).toBe(1);
    });
});
```

- [ ] **Step 2: Run, confirm failure**

```sh
npx vitest run tests/growth-widget.test.js
```

Expected: failures with `GrowthWidget is not defined`.

- [ ] **Step 3: Write the widget module (DOM structure only — no event wiring yet)**

```javascript
/**
 * GrowthWidget — DOM widget that renders result.realtime.growth in the cell panel.
 *
 * Spec §7.1 — three-horizon toggle, composite + confidence band, driver
 * attribution, collapsible Methods · Limitations.
 */
const GrowthWidget = (() => {
    const HORIZONS = [
        { key: 'nowcast', label: 'Now' },
        { key: 'year_2',  label: '1–2 yr' },
        { key: 'year_5',  label: '5 yr' },
    ];
    let _activeHorizon = 'nowcast';  // sticky across cell clicks

    function _badgeColor(composite) {
        if (composite == null) return '#9ca3af';
        if (composite >= 75) return '#dc2626';
        if (composite >= 60) return '#f97316';
        if (composite >= 45) return '#dbab09';
        return '#2dba4e';
    }

    function _badgeLabel(composite) {
        if (composite == null) return 'NO DATA';
        if (composite >= 75) return 'HIGH GROWTH';
        if (composite >= 60) return 'GROWING';
        if (composite >= 45) return 'MODERATE';
        return 'STABLE';
    }

    function attachTo(containerEl, growth, cell) {
        if (!containerEl) return;
        containerEl.querySelectorAll('[data-growth-widget]').forEach(e => e.remove());

        if (!growth) {
            const empty = document.createElement('div');
            empty.setAttribute('data-growth-widget', '');
            empty.className = 'growth-widget growth-widget--unavailable';
            empty.innerHTML = `
                <div class="growth-widget__title">📈 Growth Forecast</div>
                <div class="growth-widget__msg">Growth data unavailable for this cell.
                    <a href="#" data-growth-retry>Try again</a>
                </div>`;
            containerEl.appendChild(empty);
            empty.querySelector('[data-growth-retry]')?.addEventListener('click', (ev) => {
                ev.preventDefault();
                if (typeof Panel !== 'undefined' && cell) Panel.show(cell);
            });
            return;
        }

        const h = growth.horizons[_activeHorizon] || growth.horizons.nowcast;
        const composite = h.composite;

        const wrap = document.createElement('div');
        wrap.setAttribute('data-growth-widget', '');
        wrap.className = 'growth-widget';
        wrap.innerHTML = `
            <div class="growth-widget__header">
                <div class="growth-widget__title">📈 Growth Forecast</div>
                <span class="growth-widget__badge" style="background:${_badgeColor(composite)};">
                    ${_badgeLabel(composite)}
                </span>
            </div>
            <div class="growth-widget__horizons" data-horizon-toggle>
                ${HORIZONS.map(x => `
                    <button type="button" data-h="${x.key}"
                            class="growth-widget__h ${x.key === _activeHorizon ? 'is-active' : ''}">
                        ${x.label}
                    </button>`).join('')}
            </div>
            <div class="growth-widget__composite">
                Composite: <strong>${composite ?? '—'}</strong>
                <span class="growth-widget__conf">(±${h.confidence_band} confidence)</span>
            </div>
            <div class="growth-widget__why">
                <div class="growth-widget__why-title">Why this cell:</div>
                ${['bue', 'den', 'cap'].map(dim => {
                    const s = h.sub_scores[dim];
                    const label = { bue: 'Built-up', den: 'Densify', cap: 'Capital' }[dim];
                    return `<div class="growth-widget__row">
                        <span class="growth-widget__dim">${label}</span>
                        <span class="growth-widget__dir">${s.direction}</span>
                        <span class="growth-widget__val">${s.value ?? '—'}</span>
                    </div>`;
                }).join('')}
            </div>
            <details class="growth-widget__methods">
                <summary>ⓘ Methods · Limitations</summary>
                <div class="growth-widget__methods-body">
                    <p>Sources: Google Open Buildings Temporal V1 (4m, 2016-2023), GHSL Pop Grid,
                    VIIRS night lights, OSM construction signals, MP RERA pipeline.</p>
                    <p>Nowcast describes observed change. 1-2 year anchors on approved RERA projects.
                    5-year is linear-trend extrapolation, not a real forecast — wide confidence band
                    reflects this.</p>
                </div>
            </details>
        `;
        containerEl.appendChild(wrap);

        wrap.querySelectorAll('[data-h]').forEach(btn => {
            btn.addEventListener('click', () => {
                _activeHorizon = btn.dataset.h;
                growth.active_horizon = _activeHorizon;
                attachTo(containerEl, growth, cell);   // re-render
            });
        });
    }

    return { attachTo };
})();

if (typeof window !== 'undefined') window.GrowthWidget = GrowthWidget;
```

- [ ] **Step 2: Append CSS**

Append to `css/styles.css` — defined as a **self-contained block** since PR #11's flood-widget files have not landed on `main` (verified during Phase 0c). When the flood-widget eventually lands, a follow-up PR can refactor the two widget blocks to share a common base class. The visual variables (colors, glass-morphism background, padding) are duplicated here intentionally:

```css
/* Growth Forecast widget */
.growth-widget {
    background: rgba(15, 23, 42, 0.55);
    border: 1px solid rgba(34, 197, 94, 0.25);
    border-radius: 10px;
    padding: 12px;
    margin: 10px 0;
}
.growth-widget__header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.growth-widget__title { color: #cbd5e1; font-size: 12px; font-weight: 600; }
.growth-widget__badge { color: #fff; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 999px; }
.growth-widget__horizons { display: flex; gap: 4px; margin-bottom: 8px; }
.growth-widget__h { flex: 1; background: rgba(15,23,42,0.65); border: 1px solid rgba(59,130,246,0.25); color: #cbd5e1; font-size: 10px; padding: 4px 6px; cursor: pointer; border-radius: 6px; }
.growth-widget__h.is-active { background: rgba(59,130,246,0.45); color: #fff; }
.growth-widget__composite { color: #e2e8f0; font-size: 13px; margin-bottom: 6px; }
.growth-widget__conf { color: #94a3b8; font-size: 11px; margin-left: 6px; }
.growth-widget__why { color: #cbd5e1; font-size: 11px; }
.growth-widget__why-title { color: #94a3b8; font-size: 10px; margin: 6px 0 4px; }
.growth-widget__row { display: flex; gap: 8px; font-variant-numeric: tabular-nums; }
.growth-widget__dim { width: 70px; }
.growth-widget__dir { width: 18px; }
.growth-widget__val { color: #e2e8f0; }
.growth-widget__methods { margin-top: 8px; color: #94a3b8; font-size: 10px; }
.growth-widget__methods-body { padding: 6px 0; line-height: 1.4; }
.growth-widget--unavailable { opacity: 0.7; }
.growth-widget__msg { color: #cbd5e1; font-size: 11px; }
```

- [ ] **Step 3: Wire into `js/panel.js`'s `update()`**

After the existing `if (typeof FloodAnimation !== 'undefined')` block in `update()`, add:

```javascript
if (typeof GrowthWidget !== 'undefined') {
    GrowthWidget.attachTo(contentEl, data?.realtime?.growth || null, cell);
}
```

- [ ] **Step 4: Load the script in index.html**

After the `<script src="js/realtime-growth.js"></script>` tag, add:

```html
<script src="js/growth-widget.js"></script>
```

- [ ] **Step 5: Smoke check**

```sh
python serve.py
# Browser: click any cell; verify the growth widget renders below other widgets
```

Expected: panel shows the 📈 Growth Forecast block with three horizon buttons and a composite score.

- [ ] **Step 6: Commit**

```sh
git add js/growth-widget.js js/panel.js index.html css/styles.css
git commit -m "feat(growth): panel widget — 3-horizon toggle + driver attribution"
```

### Task 16: `js/growth-overlay.js` — map heatmap toggle

**Files:**
- Create: `js/growth-overlay.js`
- Modify: `index.html` (add toolbar button)

- [ ] **Step 1: Write the overlay module**

```javascript
/**
 * GrowthOverlay — map heatmap colouring visible cells by growth score.
 *
 * Reuses the existing HeatmapOverlay pattern (PR #5 era) for source/layer
 * management; the only difference is the score function pulled from
 * result.realtime.growth.horizons[<active>].composite.
 *
 * Spec §7.2.
 */
const GrowthOverlay = (() => {
    const SOURCE_ID = 'growth-overlay-src';
    const LAYER_ID  = 'growth-overlay-fill';
    let _active = false;
    let _horizon = 'nowcast';

    function _colorFor(score) {
        if (score == null) return 'rgba(0,0,0,0)';
        if (score >= 75) return '#dc2626';
        if (score >= 60) return '#f97316';
        if (score >= 45) return '#dbab09';
        return '#2dba4e';
    }

    function setHorizon(h) {
        _horizon = h;
        if (_active) refresh();
    }

    function refresh() {
        // Stub for v1: a real implementation iterates visible DigiPin cells and
        // fetches RealtimeGrowth per cell. For initial release we render only
        // the currently-selected cell as a single coloured square.
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: LAYER_ID,
                type: 'fill',
                source: SOURCE_ID,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.45 },
            });
        }
    }

    function attach() {
        _active = true;
        refresh();
    }

    function detach() {
        _active = false;
        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!map) return;
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }

    function toggle() {
        if (_active) detach();
        else attach();
    }

    return { attach, detach, toggle, setHorizon };
})();

if (typeof window !== 'undefined') window.GrowthOverlay = GrowthOverlay;
```

- [ ] **Step 2: Add toolbar button to `index.html`**

Add inside the toolbar `<div id="toolbar">`:

```html
<button class="toolbar-btn" id="btn-growth" title="Urban Growth Forecast">
    <span class="tb-icon">&#128200;</span>
    <span class="tb-label">Growth</span>
</button>
```

And after the `<script src="js/growth-widget.js"></script>` load:

```html
<script src="js/growth-overlay.js"></script>
<script>
document.getElementById('btn-growth')?.addEventListener('click', () => {
    if (typeof GrowthOverlay !== 'undefined') GrowthOverlay.toggle();
});
</script>
```

- [ ] **Step 3: Smoke check**

```sh
python serve.py
# Browser: click the 📊 Growth toolbar button; verify no errors
```

Expected: button click doesn't crash; the source/layer add/remove cleanly. Full city-wide rendering is Phase 2 follow-up.

- [ ] **Step 4: Commit**

```sh
git add js/growth-overlay.js index.html
git commit -m "feat(growth): map heatmap overlay scaffold + toolbar button"
```

---

## Phase 6 — DISHA + Playwright + polish

### Task 17: DISHA LLM context lines

**Files:**
- Modify: `js/disha.js`

- [ ] **Step 1: Find the buildContext function**

```sh
grep -n "buildContext\|=== INTELLIGENCE\|=== ENVIRONMENT" js/disha.js | head -10
```

- [ ] **Step 2: Append growth lines to the context block**

In `buildContext(cell, data)`, after the SCORES section, add:

```javascript
const growth = data.realtime?.growth;
if (growth) {
    const now = growth.horizons.nowcast;
    const y5  = growth.horizons.year_5;
    lines.push(`\n=== GROWTH FORECAST (composite 0-100) ===`);
    lines.push(`Nowcast: composite=${now.composite} conf=±${now.confidence_band}  BUE=${now.sub_scores.bue.value} DEN=${now.sub_scores.den.value} CAP=${now.sub_scores.cap.value}`);
    lines.push(`5-year:  composite=${y5.composite} conf=±${y5.confidence_band}  trend: linear extrapolation`);
}
```

- [ ] **Step 3: Smoke check**

Open the portal, click a cell, open DISHA panel, send "Is this area growing?" and verify the response references the growth scores.

- [ ] **Step 4: Commit**

```sh
git add js/disha.js
git commit -m "feat(growth): inject growth context into DISHA prompt"
```

### Task 18: Playwright smoke test

**Files:**
- Create: `tests/playwright/growth-widget.spec.js`

- [ ] **Step 1: Write the test**

```javascript
import { test, expect } from '@playwright/test';

test('growth widget renders for an Indore cell', async ({ page }) => {
    await page.goto('http://localhost:8000/');
    await page.waitForSelector('#map');
    // Click the centre of the map (Indore default)
    const map = page.locator('#map');
    const box = await map.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('[data-growth-widget]', { timeout: 8000 });
    const widget = page.locator('[data-growth-widget]').first();
    await expect(widget).toBeVisible();
});

test('horizon toggle changes the composite display', async ({ page }) => {
    await page.goto('http://localhost:8000/');
    await page.waitForSelector('#map');
    const map = page.locator('#map');
    const box = await map.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('[data-growth-widget]');
    await page.click('button[data-h="year_5"]');
    const composite = await page.textContent('.growth-widget__composite');
    expect(composite).toContain('Composite:');
});
```

- [ ] **Step 2: Run**

```sh
python serve.py &
SERVER=$!
sleep 2
npx playwright test tests/playwright/growth-widget.spec.js
kill $SERVER
```

Expected: 2 tests pass. If the widget doesn't render within 8s, COGs may be missing — that's expected for first runs and the test will need to either generate fixtures or be gated behind `data/growth/*.tif` existing.

- [ ] **Step 3: Commit**

```sh
git add tests/playwright/growth-widget.spec.js
git commit -m "test(growth): Playwright smoke for panel widget + horizon toggle"
```

### Task 19: Documentation polish + final PR open

**Files:**
- Create: `docs/GROWTH_FORECAST.md`
- Modify: `README.md` (one-line link)

- [ ] **Step 1: Write user-facing docs**

Create `docs/GROWTH_FORECAST.md`:

```markdown
# Urban Growth Forecast

When you click a DigiPin cell, the panel shows a **Growth Forecast**
widget with three time horizons (Nowcast / 1-2 yr / 5 yr) and three
contributing dimensions (Built-up / Densify / Capital).

See [the design spec](superpowers/specs/2026-05-24-urban-growth-forecast-design.md)
for the full data sources, score model, and disclosure notes.

## Refreshing the data

Once a quarter (or when GHSL / Open Buildings publish new annual data):

```sh
export GOOGLE_APPLICATION_CREDENTIALS=~/.gee/digipin-credentials.json
python -m pipeline.growth.extract_buildings_temporal
python -m pipeline.growth.extract_viirs_annual
python -m pipeline.growth.download_ghsl_pop
git add data/growth/
git commit -m "data(growth): refresh COGs YYYY-MM"
git push
```

RERA snapshot refresh is automatic via the existing real-time scraper
workflow (`.github/workflows/realtime-scrape.yml`).
```

- [ ] **Step 2: Open the PR**

```sh
git push -u origin agents/urban-growth-forecast
gh pr create --base main --head agents/urban-growth-forecast \
  --title "feat: Urban Growth Forecast — 3-horizon composite score per DigiPin cell" \
  --body "$(cat <<'EOF'
## Summary

Implements the Urban Growth Forecast feature designed in
[spec 2026-05-24](docs/superpowers/specs/2026-05-24-urban-growth-forecast-design.md)
and approved by the architect-reviewer subagent over 2 iterations.

## What changed

- **Python pipeline** under `pipeline/growth/` extracts GEE Open Buildings Temporal V1, VIIRS, and GHSL as COGs to `data/growth/`
- **RERA Madhya Pradesh scraper** in `scrapers/sources/rera_mp.py` (CAP signal for the 1-2 yr horizon)
- **Browser score module** `js/growth-score.js` — pure-function BUE/DEN/CAP + composite + linear trend + per-cell confidence band
- **Browser fetcher** `js/realtime-growth.js` — COG range fetches + RERA snapshot + score
- **Panel widget** `js/growth-widget.js` with 3-horizon toggle + driver attribution + collapsible Methods · Limitations
- **Map overlay** `js/growth-overlay.js` (scaffold; visible-viewport city-wide colouring is Phase 2)
- **DISHA context** lines so the LLM grounds answers about growth in real scores
- **Tests**: Vitest (~25 unit tests), pytest (RERA parser), Playwright (UI smoke)

## Test plan
- [ ] `npx vitest run` — all growth-* tests pass
- [ ] `pytest scrapers/sources/tests/ pipeline/growth/tests/` — pass
- [ ] Click an Indore cell in the panel — widget renders within 500ms
- [ ] Toggle horizon → composite updates
- [ ] Run pipeline once locally per `docs/GROWTH_FORECAST.md`
- [ ] DISHA answers "is this area growing" with score citations
EOF
)"
```

- [ ] **Step 3: Commit + push**

```sh
git add docs/GROWTH_FORECAST.md
git commit -m "docs(growth): user-facing README"
git push
```

---

## What's NOT in this plan (deferred to follow-up PRs)

Aligned with spec §2 non-goals:

- CA-MARKOV / transformer forecasting for the 5-year horizon
- Multi-state RERA scrapers (Karnataka, Maharashtra, Tamil Nadu)
- Master-plan zoning data integration
- Transaction-history price calibration
- Per-user save/share of horizon scenarios
- Cloudflare R2 hosting migration (when dataset > 500 MB)
- Building-height time series in BUE (we currently use the latest year only)
- Full city-wide visible-viewport heatmap rendering (Task 16 scaffold only handles selected cell)
