# DigiPin Digital Twin — Architecture

## Data Format Decisions

| Data Type | Format | Serving | Why |
|-----------|--------|---------|-----|
| Vector maps | **PMTiles** (MVT) | Cloudflare R2 | HTTP range requests, zero server |
| Continuous rasters | **COG** (Cloud-Optimized GeoTIFF) | Cloudflare R2 | Sub-file viewport fetching |
| Categorical rasters | **PMTiles** (PNG) | Cloudflare R2 | Pre-rendered tiles, 3x smaller |
| Analytics | **GeoParquet** | Cloudflare R2 | DuckDB-WASM spatial SQL in browser |

## Storage Layout (~450MB on R2, $0/month)

```
digipin-tiles/
  vectors/
    buildings.pmtiles     (~35 MB)
    roads.pmtiles         (~20 MB)
    amenities.pmtiles     (~15 MB)
    water_bodies.pmtiles  (~5 MB)
    ward_boundaries.pmtiles (~2 MB)
  rasters/
    ndvi_2024_dry.tif     (~25 MB, COG)
    elevation_srtm.tif    (~15 MB, COG)
    lulc_2023.pmtiles     (~30 MB)
  analytics/
    buildings_full.parquet (~80 MB)
```

## Pipeline

```
Sources (Overture/OSM/Sentinel-2/SRTM)
  → GitHub Actions (monthly/weekly cron)
  → GDAL/tippecanoe/rio-cogeo
  → Cloudflare R2 (zero egress)
  → Browser (HTTP range requests)
```

## Browser Rendering

- **MapLibre GL JS** for vector tiles + 3D buildings (phased alongside Leaflet)
- **geotiff.js** for COG range fetching
- **DuckDB-WASM** for GeoParquet analytics
- **deck.gl** for GPU-accelerated heatmaps
- Max 3 raster layers visible simultaneously (performance budget)

## Hosting: Cloudflare R2

- 10 GB free storage, **zero egress cost forever**
- HTTP range requests supported
- CORS configurable
- Total estimated cost: **$0/month**

## Phase Roadmap

1. **Phase 1**: Static spatial foundation — PMTiles vectors + NDVI COG
2. **Phase 2**: 3D buildings + time-series animation + DuckDB-WASM
3. **Phase 3**: IUDX real-time IoT + flood simulation + CesiumJS 3D

## Data Sources Summary

### Rasters (26 datasets)
DEM (SRTM/Copernicus 30m), LULC (ESA WorldCover 10m), Population (WorldPop/GHSL),
Night Lights (VIIRS), NDVI (Sentinel-2 10m), Soil (SoilGrids 250m),
Climate (ERA5-Land 9km), Flood (JRC Surface Water 30m), Solar (NSRDB),
Building Height (WSF3D 12m / GHSL 100m)

### Vectors (23 datasets)
Buildings (Microsoft/Google/Overture/OSM), Roads (OSMnx/Overture),
Admin Boundaries (GADM 5 levels), POIs (8 OSM categories + Overture Places),
Water (OSM + HydroSHEDS), Railways (OSM + Datameet), Green Spaces,
Utilities, Census 2011, Cadastral (OSM proxy)

### Real-Time Sensors (20+ endpoints)
IUDX (Catalogue + Resource Server), CPCB/MPPCB AQI, OpenAQ v3,
WAQI, Open-Meteo (weather + AQI + solar), IMD Mausam,
TomTom/HERE Traffic, CWC Flood, Smart Cities Portal
