# DigiPin Urban Intelligence 📍

**India's First Hyper-Local Urban Analytics Platform**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

## What It Does

DigiPin divides every square metre of Indian cities into uniquely addressable grid cells, each enriched with **160+ real-time data features** and **30+ intelligence scores**. It provides urban planners, businesses, and government agencies with actionable hyper-local analytics.

## Key Numbers

| Metric | Value |
|--------|-------|
| **Cities** | 12 major Indian cities |
| **Features per cell** | 160+ (food, education, healthcare, transport, shopping, etc.) |
| **Intelligence scores** | 30+ (livability, safety, walkability, green index, etc.) |
| **Urban queries** | 52 across 7 sectors |
| **Building footprints** | 528K+ (3D extruded by height) |
| **LCZ classes** | 17 Local Climate Zones |
| **LULC classes** | 54 (ISRO Bhuvan) |

## Features

- **Grid Cell Intelligence**: Click any cell for 160+ features and 30+ scores with radar chart
- **3D Buildings**: 528K Overture Maps footprints with height extrusion, color-coded by type
- **Urban Query Engine**: 52 pre-configured spatial queries (Best Mall Location, School Desert, etc.)
- **Heatmap Analysis**: 3D extruded columns for 10 metrics across visible area
- **Compare Tool**: Pin up to 3 cells for side-by-side radar chart comparison
- **Walkability Isochrones**: OpenRouteService-powered 5/10/15 minute walking zones
- **DISHA AI**: Local Qwen2.5 LLM assistant with full cell context
- **Overlays**: LCZ, LULC, Wards, Roads, Water Bodies, POI layers
- **Flood Simulation**: 3D flood risk with drain networks and encroachment detection
- **Mob Simulation**: Crowd dynamics with S.144 enforcement and force deployment
- **Reports & Bookmarks**: Print-ready profiles, persistent bookmarks

## Quick Start

```bash
# 1. Clone
git clone https://github.com/Slllyio/digipin.git
cd digipin

# 2. Set up environment
cp .env.example .env  # Edit with your API keys

# 3. Install Ollama (for DISHA AI)
# Download from https://ollama.ai then:
ollama pull qwen2.5

# 4. Serve
python -m http.server 5500
# Or: npx serve -l 5500

# 5. Open http://localhost:5500
```

## Data Sources

| Source | Provider | Resolution | Use |
|--------|----------|-----------|-----|
| POI & Roads | OpenStreetMap | Vector | Amenities, road network |
| Buildings | Overture Maps | Vector | 528K footprints + heights |
| Buildings | Google Open Buildings | Vector | Footprints + heights |
| LULC | ISRO Bhuvan | 1:50,000 | 54 land use classes |
| LCZ | WUDAPT | 100m | 17 climate zone classes |
| Land Cover | ESA WorldCover | 10m | Global land cover |
| 3D Terrain | Cesium | Mesh | 3D globe rendering |

## Project Structure

```
digipin/
├── index.html           # Main app entry point
├── js/                  # JavaScript modules
├── css/                 # Stylesheets
├── data/                # Pre-processed city data
├── building-blocks/     # Reusable components
├── pipeline/            # Data processing pipeline
├── guna-twin-city/      # Digital twin for Guna
├── docs/                # Documentation
├── tests/               # Test suite
├── screenshots/         # App screenshots
├── video-output/        # Demo video assets
└── VIDEO_SCRIPT.md      # 10-min walkthrough script
```

## License

MIT License - see [LICENSE](LICENSE)
