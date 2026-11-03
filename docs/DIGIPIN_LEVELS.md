# DIGIPIN as a multi-resolution index

DIGIPIN splits the 36° × 36° India box (lat 2.5–38.5° N, lng 63.5–99.5° E)
into a 4 × 4 grid, then splits every cell 4 × 4 again, ten times. A code's
first L symbols name a **level-L cell**: one square of a uniform 4^L × 4^L
grid. So the code is a quadtree path, and every hierarchy operation is
integer maths on the cell's (row, col) address.

## Exact cell sizes

Edge = 36° ÷ 4^L (exact in binary floating point). Metres use 111 320 m per
degree; the east–west edge is shown at 22.7° N (Indore) and shrinks with
cos(latitude).

| Level | Example (Indore) | Edge (°) | N–S edge | E–W edge @ 22.7° N | Cells in India box | Typical use |
|---:|---|---:|---:|---:|---:|---|
| 1 | `3` | 9 | ~1 002 km | ~924 km | 16 | country quadrant |
| 2 | `3M` | 2.25 | ~250 km | ~231 km | 256 | state / region |
| 3 | `3MC` | 0.5625 | ~62.6 km | ~57.8 km | 4 096 | metro region |
| 4 | `3MC-8` | 0.140625 | ~15.7 km | ~14.4 km | 65 536 | district / city |
| 5 | `3MC-88` | 0.03515625 | ~3.9 km | ~3.6 km | 1.05 M | city zone |
| 6 | `3MC-88P` | 0.0087890625 | **~978 m** | ~903 m | 16.8 M | city-wide scores (`scores`) |
| 7 | `3MC-88P-J` | 0.002197265625 | **~245 m** | ~226 m | 268 M | roads, traffic, mobility |
| 8 | `3MC-88P-JL` | 0.00054931640625 | ~61 m | ~56 m | 4.3 B | block, building heights |
| 9 | `3MC-88P-JL2` | 0.0001373291015625 | ~15.3 m | ~14.1 m | 68.7 B | plot |
| 10 | `3MC-88P-JL2J` | 0.000034332275390625 | ~3.8 m | ~3.5 m | 1.1 T | a full DIGIPIN address |

Older docs said "level 6 ≈ 244 m". That was off by one level: 244 m is L7.

## Library (`js/digipin.js`, mirrored in `pipeline/_lib/digipin.py`)

```js
DigiPin.encode(lat, lng)            // '3MC-88P-JL2J' (India Post reference algorithm)
DigiPin.encodeLevel(lat, lng, 7)    // '3MC88PJ'
DigiPin.cellBounds('3MC88P')        // { level, lat, lng, bounds:{south,north,west,east} }, exact
DigiPin.cellSize(6, lat)            // { deg, mNS, mEW, approxM: 978 }
DigiPin.sizeLabel(6)                // '~978 m'
DigiPin.isValid(code) / normalize(code) / levelOf(code)
DigiPin.toIndex(code) / fromIndex(level, row, col)   // integer address, row 0 = south
DigiPin.parent(code[, level]) / ancestors(code) / children(code) / descendants(code, level)
DigiPin.neighbor(code, 'n'|'ne'|…|'up'|'left') / neighbors(code) / disk(code, k)
DigiPin.cover(bbox, level[, maxCells])  // every cell intersecting a bbox
DigiPin.levelForZoom(zoom) / zoomForLevel(level)
```

Neighbours step across parent boundaries correctly (they move the integer
address, not the last symbol) and return `null` at the edge of the India box.
`encode` reproduces the India Post test vector (Dak Bhawan, 28.622788 N,
77.213033 E → `39J-49L-L8T4`). The Python port is pinned to the JS by the
golden file `pipeline/scores/golden/digipin.json` (`npm run golden:scores`).

## Level of detail in the app

- **Grid.** A level-L cell is about 25.6 · 2^(zoom − 2L) px wide on the map,
  so `levelForZoom` picks the finest level whose cells are ≥ 40 px: z13–14 →
  L6, z15–16 → L7, z17–18 → L8, z19–20 → L9. The grid coarsens further if the
  view would need more than 2 500 cells. Clicking selects a cell of the level
  you see.
- **Data layers.** Each cell-store dataset draws one level finer than the grid,
  capped at its native level (`CellLayers.targetLevel`). When that is coarser
  than the data, `CellStore.loadAt(id, level)` rolls the table up by code
  prefix with each field's `agg`: `mean` → mean of child cells (equal area, so
  area-weighted), `sum`/`count` → sum, `min`/`max`/`mode`/`any` carry over.
  Sum and count legends are re-ranged for the rolled-up values. The legend's
  **Detail** picker pins a level instead of following the zoom.
- **Selected cell.** The panel shows the level and size, a breadcrumb of
  every ancestor (click one to select that coarser cell), an `L+1 ›` button
  for the child at the centre. `CellStore.rowAt(id, lat, lng, level)` gives
  any dataset's value for a coarser cell, rolled up from the shards under it.
- **Pointer readout.** The chip at the bottom of the map shows the code under
  the pointer at the grid level, its size and the full 10-symbol code. Click
  copies it.
- **Search.** Any 3–10-symbol code (dashes or spaces optional) flies to the
  zoom for its level, outlines the cell and opens it.
- **Keyboard.** Arrow keys step to the same-level neighbour.
