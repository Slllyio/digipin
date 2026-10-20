# pipeline/scores — server-side score models

Phase 0 of [`PRECOMPUTE_PLAN.md`](../../docs/PRECOMPUTE_PLAN.md): to precompute
national coverage, the pipeline must compute the **same** scores server-side
that the browser computes per click. These modules are faithful Python ports of
the `js/*-score.js` models.

## The parity pattern (the deliverable, not just one port)

Porting score math by hand risks silent drift from the JS. We prevent that with
golden-file parity tests, so the JS stays the single source of truth:

```
js/growth-score.js ──(gen_golden.js)──▶ golden/growth.json ──(pytest)──▶ growth.py
   source of truth        Node, reuses        committed fixtures   must reproduce
                       the Vitest loader                            exactly
```

1. **`gen_golden.js`** loads the browser IIFE module exactly as the Vitest suite
   does (`vm.runInThisContext` + global exposure), runs it over a fixed set of
   input cases, and writes the JS output to `golden/<model>.json`.
2. **`<model>.py`** re-implements the math. Watch for the two JS-porting traps,
   both handled in `growth.py`:
   - `js_round()` replicates `Math.round` (half toward +Infinity ≠ Python's
     banker's rounding);
   - `None` covers both `null` and `undefined`; dict access uses `.get`.
3. **`tests/test_<model>_parity.py`** asserts the Python output matches the
   committed golden case-by-case (float tolerance `1e-9`), and guards that every
   exported function has coverage.

## Regenerating fixtures

After changing a `js/*-score.js` model, regenerate and re-run:

```sh
npm run golden:scores      # rewrites golden/growth.json from the JS
pytest pipeline/scores      # confirms the Python port still matches
```

## Ported so far

| Model | JS source | Python | Parity cases |
|---|---|---|---|
| Growth forecast | `js/growth-score.js` | `growth.py` | 43 |
| Urban heat island | `js/heat-score.js` | `heat.py` | 14 |
| Composite intelligence (~24 scores) | `js/data-fetcher.js` (`computeScores`) | `composite.py` | 4 fixtures |
| SCS curve-number flood | `js/flood-scs.js` | `flood_scs.py` | 14 |

The **DIGIPIN addressing scheme** is also ported, via the same harness:
`js/digipin.js` → `pipeline/_lib/digipin.py` (encode / decode / decode_partial /
format), pinned by `golden/digipin.json`. This is the cell-enumeration
primitive the analysis grid is built from.

The OSM-derived, growth, heat, and SCS-flood score models plus the addressing
scheme are now ported. The next
step is **Phase 0 step 1**: enumerate the Indore analysis grid (truncated DIGIPIN
cells over the pilot bbox) and run these scorers over a bulk OSM extract — no
per-click Overpass calls. The `composite.py` input shape is exactly what a local
`osmium`/DuckDB feature-count query needs to produce per cell.
