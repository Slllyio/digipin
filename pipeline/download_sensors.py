"""
DigiPin Digital Twin — Real-Time Sensor Data Collection
=======================================================
Fetches current AQI, weather, traffic, and flood data for Indore
from multiple free APIs.

Usage:
    python download_sensors.py                   # fetch all streams
    python download_sensors.py --stream weather  # fetch specific stream
    python download_sensors.py --list            # list available streams

No-auth sources: Open-Meteo (weather + AQI), IMD, CPCB
Auth sources: WAQI (free token), TomTom (free key), OpenAQ (free key)
"""

import argparse
import json
import logging
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from config import CENTER_LAT, CENTER_LON, BBOX

OUT_DIR = Path(__file__).parent.parent / "data" / "sensors"
OUT_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("sensors")


@dataclass
class SensorReading:
    source: str
    sensor_type: str
    timestamp: str
    latitude: float
    longitude: float
    metrics: dict[str, Any]


def _save_reading(reading: SensorReading, filename: str) -> Path:
    """Save sensor reading as JSON."""
    out_path = OUT_DIR / filename
    with open(out_path, "w") as f:
        json.dump(asdict(reading), f, indent=2, default=str)
    log.info("Saved: %s", filename)
    return out_path


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


# ─── Stream Fetchers ─────────────────────────────────────────────


def fetch_weather() -> SensorReading:
    """Open-Meteo current weather (no auth)."""
    params = {
        "latitude": CENTER_LAT,
        "longitude": CENTER_LON,
        "current": ",".join([
            "temperature_2m", "relative_humidity_2m", "apparent_temperature",
            "precipitation", "weather_code", "cloud_cover",
            "pressure_msl", "wind_speed_10m", "wind_direction_10m",
        ]),
        "timezone": "Asia/Kolkata",
    }
    resp = requests.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=20)
    resp.raise_for_status()
    c = resp.json()["current"]
    return SensorReading(
        source="open_meteo",
        sensor_type="weather",
        timestamp=_now_iso(),
        latitude=CENTER_LAT,
        longitude=CENTER_LON,
        metrics={
            "temperature_c": c.get("temperature_2m"),
            "humidity_pct": c.get("relative_humidity_2m"),
            "feels_like_c": c.get("apparent_temperature"),
            "precipitation_mm": c.get("precipitation"),
            "weather_code": c.get("weather_code"),
            "cloud_cover_pct": c.get("cloud_cover"),
            "pressure_hpa": c.get("pressure_msl"),
            "wind_speed_kmh": c.get("wind_speed_10m"),
            "wind_direction_deg": c.get("wind_direction_10m"),
        },
    )


def fetch_air_quality() -> SensorReading:
    """Open-Meteo air quality (no auth)."""
    params = {
        "latitude": CENTER_LAT,
        "longitude": CENTER_LON,
        "current": ",".join([
            "pm2_5", "pm10", "ozone", "nitrogen_dioxide",
            "sulphur_dioxide", "carbon_monoxide", "european_aqi", "uv_index",
        ]),
        "timezone": "Asia/Kolkata",
    }
    resp = requests.get(
        "https://air-quality-api.open-meteo.com/v1/air-quality",
        params=params, timeout=20,
    )
    resp.raise_for_status()
    c = resp.json().get("current", {})
    return SensorReading(
        source="open_meteo_aqi",
        sensor_type="air_quality",
        timestamp=_now_iso(),
        latitude=CENTER_LAT,
        longitude=CENTER_LON,
        metrics={
            "pm2_5_ugm3": c.get("pm2_5"),
            "pm10_ugm3": c.get("pm10"),
            "o3_ugm3": c.get("ozone"),
            "no2_ugm3": c.get("nitrogen_dioxide"),
            "so2_ugm3": c.get("sulphur_dioxide"),
            "co_ugm3": c.get("carbon_monoxide"),
            "european_aqi": c.get("european_aqi"),
            "uv_index": c.get("uv_index"),
        },
    )


def fetch_solar() -> SensorReading:
    """Open-Meteo solar irradiance (no auth)."""
    params = {
        "latitude": CENTER_LAT,
        "longitude": CENTER_LON,
        "current": ",".join([
            "shortwave_radiation", "direct_radiation",
            "diffuse_radiation", "direct_normal_irradiance",
        ]),
        "timezone": "Asia/Kolkata",
    }
    resp = requests.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=20)
    resp.raise_for_status()
    c = resp.json()["current"]
    return SensorReading(
        source="open_meteo_solar",
        sensor_type="solar",
        timestamp=_now_iso(),
        latitude=CENTER_LAT,
        longitude=CENTER_LON,
        metrics={
            "ghi_wm2": c.get("shortwave_radiation"),
            "direct_wm2": c.get("direct_radiation"),
            "diffuse_wm2": c.get("diffuse_radiation"),
            "dni_wm2": c.get("direct_normal_irradiance"),
        },
    )


def fetch_waqi(token: str = "") -> SensorReading:
    """WAQI air quality (requires free token from aqicn.org)."""
    if not token:
        log.warning("WAQI: Provide token via --waqi-token (free at aqicn.org/data-platform/token/)")
        return SensorReading("waqi", "air_quality", _now_iso(), CENTER_LAT, CENTER_LON, {})
    resp = requests.get(
        f"https://api.waqi.info/feed/Indore/",
        params={"token": token}, timeout=15,
    )
    resp.raise_for_status()
    d = resp.json().get("data", {})
    iaqi = d.get("iaqi", {})
    return SensorReading(
        source="waqi",
        sensor_type="air_quality",
        timestamp=_now_iso(),
        latitude=d.get("city", {}).get("geo", [CENTER_LAT])[0],
        longitude=d.get("city", {}).get("geo", [CENTER_LAT, CENTER_LON])[1],
        metrics={
            "aqi": d.get("aqi"),
            "dominant_pollutant": d.get("dominentpol"),
            "pm25": iaqi.get("pm25", {}).get("v"),
            "pm10": iaqi.get("pm10", {}).get("v"),
            "no2": iaqi.get("no2", {}).get("v"),
            "co": iaqi.get("co", {}).get("v"),
        },
    )


def fetch_iudx_catalogue() -> SensorReading:
    """IUDX catalogue search for Indore datasets (no auth)."""
    url = "https://api.catalogue.iudx.org.in/iudx/cat/v1/search"
    params = {"property": "tags", "value": "[Indore]", "limit": 100}
    try:
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results", [])
        datasets = [
            {"id": r.get("id", ""), "description": r.get("description", "")[:120]}
            for r in results
        ]
        return SensorReading(
            source="iudx_catalogue",
            sensor_type="catalogue",
            timestamp=_now_iso(),
            latitude=CENTER_LAT,
            longitude=CENTER_LON,
            metrics={"dataset_count": len(datasets), "datasets": datasets},
        )
    except Exception as e:
        log.warning("IUDX catalogue: %s", e)
        return SensorReading("iudx_catalogue", "catalogue", _now_iso(), CENTER_LAT, CENTER_LON, {"error": str(e)})


# ─── Stream Registry ────────────────────────────────────────────

STREAMS = {
    "weather": ("Open-Meteo Weather (no auth)", fetch_weather, {}),
    "aqi": ("Open-Meteo Air Quality (no auth)", fetch_air_quality, {}),
    "solar": ("Open-Meteo Solar Irradiance (no auth)", fetch_solar, {}),
    "waqi": ("WAQI Air Quality (needs token)", fetch_waqi, {"needs_token": "waqi_token"}),
    "iudx": ("IUDX Catalogue Discovery (no auth)", fetch_iudx_catalogue, {}),
}


def main():
    parser = argparse.ArgumentParser(description="Fetch real-time sensor data for Indore")
    parser.add_argument("--stream", help="Fetch specific stream (see --list)")
    parser.add_argument("--list", action="store_true", help="List available streams")
    parser.add_argument("--all", action="store_true", help="Fetch all streams")
    parser.add_argument("--waqi-token", default="", help="WAQI API token (free)")
    args = parser.parse_args()

    if args.list:
        print("\nAvailable sensor streams:")
        for key, (name, _, _) in STREAMS.items():
            print(f"  {key:10s} — {name}")
        return

    def run_stream(key: str):
        name, fn, opts = STREAMS[key]
        log.info("Fetching: %s", name)
        if opts.get("needs_token") == "waqi_token":
            reading = fn(token=args.waqi_token)
        else:
            reading = fn()
        _save_reading(reading, f"sensor_{key}_{datetime.now():%Y%m%d_%H%M}.json")
        for k, v in reading.metrics.items():
            if k != "datasets":
                log.info("  %s: %s", k, v)

    if args.stream:
        if args.stream not in STREAMS:
            print(f"Unknown stream: {args.stream}. Use --list to see options.")
            return
        run_stream(args.stream)
        return

    if args.all:
        for key in STREAMS:
            try:
                run_stream(key)
            except Exception as e:
                log.error("FAILED %s: %s", key, e)
        return

    parser.print_help()


if __name__ == "__main__":
    main()
