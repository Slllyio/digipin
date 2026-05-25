"""
DigiPin Digital Twin — Pipeline Configuration
==============================================
Guna city bounding box and shared constants for all download scripts.
Guna is a city in Madhya Pradesh, India (~24.6354°N, 77.3126°E)
"""

from pathlib import Path

# Guna city center
CENTER_LAT = 24.6354
CENTER_LON = 77.3126

# Bounding box (wide — covers full area + buffer)
BBOX = {
    "west": 77.1, "south": 24.4,
    "east": 77.5, "north": 24.9,
}

# Tight city boundary bbox
BBOX_CITY = {
    "west": 77.25, "south": 24.58,
    "east": 77.38, "north": 24.70,
}

# City boundary polygon (approximate Guna municipal limits)
# These are approximate vertices — refine with Google Earth KML if needed
GUNA_BOUNDARY = [
    (77.265, 24.590), (77.320, 24.585), (77.370, 24.600),
    (77.380, 24.640), (77.375, 24.685), (77.350, 24.700),
    (77.310, 24.695), (77.270, 24.680), (77.255, 24.650),
    (77.258, 24.620), (77.265, 24.590),  # close ring
]

# City name (used for file naming)
CITY_NAME = "guna"

# Compact formats
BBOX_TUPLE = (BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"])  # W,S,E,N
BBOX_STR = f"{BBOX['west']},{BBOX['south']},{BBOX['east']},{BBOX['north']}"

# Output directory
DATA_DIR = Path(__file__).parent.parent / "data"

# Sub-directories
RASTER_DIR = DATA_DIR / "rasters"
VECTOR_DIR = DATA_DIR / "vectors"
SENSOR_DIR = DATA_DIR / "sensors"
LOGS_DIR = DATA_DIR / "logs"

# Guna-specific identifiers
GUNA = {
    "imd_station_id": 42267,       # Nearest IMD station (approximate)
    "imd_district_id": 502,        # Guna district
    "state": "Madhya Pradesh",
    "discom": "MPPKVVCL",          # Same as Indore (MP electricity)
    "smart_city_operator": None,    # Guna is not a smart city yet
    "sentinel2_mgrs": "43QGC",     # MGRS tile for Guna
    "srtm_tiles": ["N24E077"],
    "modis_tile": "h24v06",
}

# PROJ fix for Windows
def fix_proj():
    import os
    try:
        import pyproj
        proj_data = str(Path(pyproj.datadir.get_data_dir()))
        os.environ["PROJ_DATA"] = proj_data
        os.environ["PROJ_LIB"] = proj_data
        os.environ.pop("GDAL_DATA", None)
    except Exception:
        pass
