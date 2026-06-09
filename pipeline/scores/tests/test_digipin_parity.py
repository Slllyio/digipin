"""Golden-file parity: the Python DIGIPIN port must match the JS encoder/decoder.

Fixtures in golden/digipin.json are generated *from* js/digipin.js (the source
of truth) by gen_golden.js. Regenerate: ``npm run golden:scores``.
"""
from __future__ import annotations

import pytest

from pipeline._lib import digipin
from pipeline.scores.tests._parity import assert_close, cases, load_golden

GOLDEN = load_golden("digipin")

DISPATCH = {
    "encode": digipin.encode,
    "decode": digipin.decode,
    "decode_partial": digipin.decode_partial,
    "format_pin": digipin.format_pin,
}


@pytest.mark.parametrize("name,args,want", list(cases(GOLDEN)))
def test_python_matches_js_golden(name, args, want):
    assert_close(DISPATCH[name](*args), want)


def test_golden_covers_every_exported_function():
    assert set(GOLDEN) == set(DISPATCH)


def test_encode_rejects_out_of_range_like_js():
    """JS throws for coordinates outside the India bounds; the port raises."""
    with pytest.raises(ValueError):
        digipin.encode(40.0, 75.0)   # lat above 38.5
    with pytest.raises(ValueError):
        digipin.encode(22.0, 100.0)  # lon above 99.5


def test_encode_decode_round_trips_into_its_own_cell():
    """A decoded center must re-encode to the same 10-char code."""
    pin = digipin.encode(22.7196, 75.8577)
    center = digipin.decode(pin)
    assert digipin.encode(center["lat"], center["lng"]) == pin
