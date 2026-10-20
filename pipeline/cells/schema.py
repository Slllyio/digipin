"""Dataset + field specs for the cell store (schema v1, docs/CELL_STORE.md).

A *dataset* is one table keyed by DIGIPIN cell code at a single *level* (code
length 1..10). Every row is a cell; every *field* is a column. The spec is what
lands in ``data/cells/catalog.json`` — the layer registry the frontend reads to
render any dataset without hand-written layer code.

Pure stdlib; validated on write so a malformed spec fails in the pipeline, not
in the browser.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

SCHEMA_VERSION = 1

FIELD_TYPES = ("number", "category", "boolean")
AGGS = ("mean", "sum", "min", "max", "count", "mode", "any", "first")
# Sequential ramps the frontend knows (js/cell-layers.js RAMPS). "diverging"
# is centred on the domain midpoint.
RAMPS = ("viridis", "reds", "greens", "blues", "heat", "diverging")

_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
# Approximate DIGIPIN cell edge per level (India span 36 deg / 4**level).
LEVEL_APPROX_METRES = {1: 1_000_000, 2: 250_000, 3: 62_500, 4: 15_600, 5: 3_900,
                       6: 975, 7: 244, 8: 61, 9: 15, 10: 4}


@dataclass
class FieldSpec:
    """One column of a dataset.

    key        column name (snake_case), unique within the dataset
    label      human label for the legend / popup
    type       "number" | "category" | "boolean"
    agg        how point/grid samples falling in one cell are combined
    unit       free-text unit shown in the legend ("0-100", "m", "count")
    domain     [min, max] for numbers — filled from the data when omitted
    ramp       colour ramp name (numbers); categories may give `colors`
    colors     {category: "#hex"} for category fields (optional)
    higher_is  "better" | "worse" | None — flips the ramp so red always = bad
    """
    key: str
    label: str
    type: str = "number"
    agg: str = "mean"
    unit: str = ""
    domain: Optional[list] = None
    ramp: str = "viridis"
    colors: Optional[dict] = None
    higher_is: Optional[str] = None

    def to_json(self) -> dict:
        d = {"key": self.key, "label": self.label, "type": self.type, "agg": self.agg}
        if self.unit:
            d["unit"] = self.unit
        if self.domain is not None:
            d["domain"] = self.domain
        if self.type == "number":
            d["ramp"] = self.ramp
        if self.colors:
            d["colors"] = self.colors
        if self.higher_is:
            d["higherIs"] = self.higher_is
        return d


TIME_UNITS = ("year", "month", "day")
_STEP_RE = {"year": re.compile(r"^\d{4}$"), "month": re.compile(r"^\d{4}-\d{2}$"),
            "day": re.compile(r"^\d{4}-\d{2}-\d{2}$")}


@dataclass
class TimeSpec:
    """Time axis of a temporal dataset: every field holds one value per step.

    unit       "year" | "month" | "day"
    steps      ISO labels, ascending ("2025-01", …) — the slider's ticks
    default    step shown first (latest by default)
    """
    unit: str
    steps: list
    default: Optional[str] = None

    def to_json(self) -> dict:
        return {"unit": self.unit, "steps": list(self.steps),
                "default": self.default or self.steps[-1]}


@dataclass
class DatasetSpec:
    """One registry entry (one layer family in the frontend)."""
    id: str
    title: str
    level: int
    fields: list
    description: str = ""
    source: str = ""
    license: str = ""
    group: str = "Cell Data"
    default_field: Optional[str] = None
    extrude: bool = False           # render as 3D extruded cells by default
    height_m: float = 400.0         # extrusion height at the top of the domain
    time: Optional[TimeSpec] = None  # set → every column is a per-cell series

    def field_keys(self) -> list:
        return [f.key for f in self.fields]

    def to_json(self) -> dict:
        d = {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "source": self.source,
            "license": self.license,
            "group": self.group,
            "level": self.level,
            "approxCellM": LEVEL_APPROX_METRES.get(self.level),
            "fields": [f.to_json() for f in self.fields],
            "default": {
                "field": self.default_field or self.fields[0].key,
                "extrude": self.extrude,
                "heightM": self.height_m,
            },
        }
        if self.time is not None:
            d["time"] = self.time.to_json()
        return d


def validate(spec: DatasetSpec) -> None:
    """Raise ValueError on a spec the frontend could not render."""
    if not _ID_RE.match(spec.id):
        raise ValueError(f"dataset id {spec.id!r} must match {_ID_RE.pattern}")
    if not (1 <= spec.level <= 10):
        raise ValueError(f"level must be in [1, 10], got {spec.level}")
    if not spec.fields:
        raise ValueError(f"dataset {spec.id!r} has no fields")
    seen = set()
    for f in spec.fields:
        if not _ID_RE.match(f.key):
            raise ValueError(f"field key {f.key!r} must match {_ID_RE.pattern}")
        if f.key in seen:
            raise ValueError(f"duplicate field key {f.key!r}")
        if f.key in ("digipin", "level", "lat", "lng", "geometry", "bbox"):
            raise ValueError(f"field key {f.key!r} is reserved")
        seen.add(f.key)
        if f.type not in FIELD_TYPES:
            raise ValueError(f"field {f.key!r}: type must be one of {FIELD_TYPES}")
        if f.agg not in AGGS:
            raise ValueError(f"field {f.key!r}: agg must be one of {AGGS}")
        if f.type == "number" and f.ramp not in RAMPS:
            raise ValueError(f"field {f.key!r}: ramp must be one of {RAMPS}")
        if f.higher_is not in (None, "better", "worse"):
            raise ValueError(f"field {f.key!r}: higher_is must be 'better', 'worse' or None")
    if spec.default_field and spec.default_field not in seen:
        raise ValueError(f"default_field {spec.default_field!r} is not a field")
    if spec.time is not None:
        t = spec.time
        if t.unit not in TIME_UNITS:
            raise ValueError(f"time unit must be one of {TIME_UNITS}")
        if not t.steps:
            raise ValueError("time.steps is empty")
        if any(not _STEP_RE[t.unit].match(str(x)) for x in t.steps):
            raise ValueError(f"time.steps must be ISO {t.unit} labels")
        if list(t.steps) != sorted(set(t.steps)):
            raise ValueError("time.steps must be unique and ascending")
        if t.default is not None and t.default not in t.steps:
            raise ValueError(f"time.default {t.default!r} is not a step")
        if any(f.type != "number" for f in spec.fields):
            raise ValueError("temporal datasets support number fields only")
