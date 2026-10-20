"""Shared I/O helpers for the pipeline download / extract scripts.

Every ``download_*`` script repeated the same stdout-logging setup and the same
``data/<subdir>`` creation. These two helpers centralise that.

Importable two ways, matching the repo's existing split:
  - top-level scripts run from ``pipeline/``:        ``from _lib.io import ...``
  - package modules / tests run from the repo root:  ``from pipeline._lib.io import ...``
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

# Repo-root ``data/`` directory. io.py -> _lib -> pipeline -> <repo>
_DATA_ROOT = Path(__file__).resolve().parents[2] / "data"

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"


def setup_logging(name: str, fmt: str = LOG_FORMAT) -> logging.Logger:
    """Configure stdout logging (idempotent) and return a named logger."""
    logging.basicConfig(
        level=logging.INFO,
        format=fmt,
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    return logging.getLogger(name)


def data_dir(*parts: str) -> Path:
    """Return ``<repo>/data/<parts...>``, creating it if needed."""
    d = _DATA_ROOT.joinpath(*parts)
    d.mkdir(parents=True, exist_ok=True)
    return d
