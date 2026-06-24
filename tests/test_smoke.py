"""Smoke test — confirms pytest is wired up.

Real backend tests will land alongside the pipeline modules from
agents/folder-read-resume-work once that PR merges. Until then this
placeholder keeps `pytest` exiting 0 instead of "no tests collected".
"""


def test_pytest_is_wired_up() -> None:
    assert 1 + 1 == 2
