"""Put the guna-twin-city/analysis directory on sys.path.

The analysis package lives under a hyphenated directory (guna-twin-city),
which Python cannot import as a package, so the analysis modules are
imported by bare name (e.g. `import curve_number`). This conftest makes
that resolution work both under pytest and when the scripts run directly.
"""
import sys
from pathlib import Path

ANALYSIS_DIR = Path(__file__).resolve().parent.parent
if str(ANALYSIS_DIR) not in sys.path:
    sys.path.insert(0, str(ANALYSIS_DIR))
