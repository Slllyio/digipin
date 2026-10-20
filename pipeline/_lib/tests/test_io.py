"""Unit tests for the shared pipeline I/O helpers (used by download_* scripts,
which pytest does not collect — so this is their only safety net)."""
from __future__ import annotations

import logging

from pipeline._lib import io


def test_data_dir_creates_and_returns_nested_path(tmp_path, monkeypatch):
    monkeypatch.setattr(io, "_DATA_ROOT", tmp_path)
    d = io.data_dir("rasters", "sub")
    assert d == tmp_path / "rasters" / "sub"
    assert d.is_dir()


def test_data_dir_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(io, "_DATA_ROOT", tmp_path)
    first = io.data_dir("vectors")
    second = io.data_dir("vectors")  # already exists, must not raise
    assert first == second
    assert first.is_dir()


def test_data_dir_no_parts_returns_root(tmp_path, monkeypatch):
    monkeypatch.setattr(io, "_DATA_ROOT", tmp_path)
    assert io.data_dir() == tmp_path


def test_setup_logging_returns_named_logger():
    log = io.setup_logging("pipeline.test.io")
    assert isinstance(log, logging.Logger)
    assert log.name == "pipeline.test.io"


def test_log_format_has_expected_fields():
    assert "%(asctime)s" in io.LOG_FORMAT
    assert "%(levelname)s" in io.LOG_FORMAT
    assert "%(message)s" in io.LOG_FORMAT
