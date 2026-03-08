"""
DigiPin Digital Twin — Pipeline Configuration
==============================================
Indore bounding box and shared constants for all download scripts.
"""

from pathlib import Path

# Indore city center
CENTER_LAT = 22.7196
CENTER_LON = 75.8577

# Bounding box (wide — covers full metro area)
BBOX = {
    "west": 75.5, "south": 22.5,
    "east": 76.2, "north": 23.0,
}

# Tight city boundary bbox (from KML polygon)
BBOX_CITY = {
    "west": 75.7569, "south": 22.6246,
    "east": 76.0003, "north": 22.9060,
}

# City boundary polygon (from Google Earth KML — "Untitled map.kml")
# 12 vertices defining Indore municipal limits
INDORE_BOUNDARY = [
    (75.79962, 22.62456), (75.93717, 22.64608), (76.00026, 22.68581),
    (75.95978, 22.72031), (75.96720, 22.85024), (75.98306, 22.89800),
    (75.95646, 22.90590), (75.87929, 22.79589), (75.84642, 22.81872),
    (75.77486, 22.75523), (75.75684, 22.74858), (75.75686, 22.72617),
    (75.79962, 22.62456),  # close ring
]

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

# Indore-specific identifiers
INDORE = {
    "imd_station_id": 42182,
    "imd_district_id": 529,
    "state": "Madhya Pradesh",
    "discom": "MPPKVVCL",
    "smart_city_operator": "ISCDL",
    "sentinel2_mgrs": "44QKD",
    "srtm_tiles": ["N22E075", "N22E076"],
    "modis_tile": "h24v07",
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
