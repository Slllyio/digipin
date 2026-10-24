from pipeline.realestate import stalled


def test_classify_sites():
    assert stalled.classify(40, 40, 20, 22) == 3          # bare a year, barely built: stalled
    assert stalled.classify(40, 20, 20, 35) == 2          # built-up up 15 points: building up
    assert stalled.classify(10, 30, 20, 21) == 1          # newly cleared
    assert stalled.classify(30, 45, 22, 7) == 1           # demolished: built-up fell, bare rose
    assert stalled.classify(40, 42, 22, 12) == 0          # built-up fell alone: a hazy season, not a site
    assert stalled.classify(40, 40, 5, 6) == 0            # no built context: fields or scrub
    assert stalled.classify(None, 40, 20, 20) == 0
