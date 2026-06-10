"""
GeoJSON → PMTiles Converter (Pure Python, no tippecanoe)
========================================================
Converts large GeoJSON building footprints into PMTiles vector tiles
that MapLibre GL JS can render efficiently via the pmtiles:// protocol.

Uses:
  - geopandas for spatial indexing & tile clipping
  - mapbox_vector_tile (MVT) for encoding Mapbox Vector Tiles
  - pmtiles for writing the PMTiles v3 archive

Usage:
    python geojson_to_pmtiles.py
    python geojson_to_pmtiles.py --input ../data/vectors/google_open_buildings_indore.geojson
    python geojson_to_pmtiles.py --min-zoom 10 --max-zoom 14
"""

import argparse
import json
import math
import time
from pathlib import Path

import geopandas as gpd
import mapbox_vector_tile as mvt
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer as PMTilesWriter
from shapely.geometry import box, mapping

# Dual import: bare when run as a script from pipeline/, package-qualified when
# imported as pipeline.geojson_to_pmtiles (e.g. by build_tile).
try:
    from _lib.io import setup_logging
except ModuleNotFoundError:  # pragma: no cover - import-context shim
    from pipeline._lib.io import setup_logging

log = setup_logging("geojson_to_pmtiles")

# Tile coordinate system constants
EXTENT = 4096  # MVT tile extent (standard)


def lng_lat_to_tile(lng, lat, zoom):
    """Convert lng/lat to tile x, y at given zoom level."""
    n = 2 ** zoom
    x = int((lng + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    x = max(0, min(n - 1, x))
    y = max(0, min(n - 1, y))
    return x, y


def tile_bounds(x, y, z):
    """Get lng/lat bounds for a tile."""
    n = 2 ** z
    lng_min = x / n * 360.0 - 180.0
    lng_max = (x + 1) / n * 360.0 - 180.0
    lat_max = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_min = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lng_min, lat_min, lng_max, lat_max


def simplify_for_zoom(geom, zoom):
    """Simplify geometry based on zoom level — lower zoom = more simplification."""
    # At zoom 14, ~1m resolution; at zoom 10, ~16m resolution
    tolerance_degrees = 360.0 / (2 ** zoom * EXTENT) * 2
    simplified = geom.simplify(tolerance_degrees, preserve_topology=True)
    if simplified.is_empty:
        return geom  # Don't simplify to nothing
    return simplified


def build_mvt_tile(features_in_tile, tile_bbox, layer_name="building"):
    """Encode a list of (geometry, properties) into an MVT tile bytes.

    Pass raw lng/lat geometries and let mapbox-vector-tile handle the
    quantization via quantize_bounds. This correctly applies the Web Mercator
    projection, avoiding the lat-shift bug from manual linear interpolation.
    """
    mvt_features = []
    for geom, props in features_in_tile:
        if geom.is_empty:
            continue

        mvt_features.append({
            "geometry": mapping(geom),
            "properties": props,
        })

    if not mvt_features:
        return None

    # quantize_bounds = [west, south, east, north] in lng/lat
    # mapbox-vector-tile projects these through Mercator internally
    lng_min, lat_min, lng_max, lat_max = tile_bbox
    tile_data = mvt.encode(
        [{"name": layer_name, "features": mvt_features}],
        quantize_bounds=[lng_min, lat_min, lng_max, lat_max],
    )
    return tile_data


def convert(
    input_path: Path,
    output_path: Path,
    min_zoom: int = 10,
    max_zoom: int = 14,
    layer_name: str = "building",
):
    """Convert GeoJSON to PMTiles."""
    log.info("Loading GeoJSON: %s", input_path)
    start = time.time()

    # Load with on_invalid="ignore" to skip degenerate geometries
    gdf = gpd.read_file(input_path, on_invalid="ignore")
    log.info("Loaded %d features in %.1fs", len(gdf), time.time() - start)

    # Drop rows with null/empty geometry (from invalid WKT polygons)
    before = len(gdf)
    gdf = gdf[~gdf.geometry.isna() & ~gdf.geometry.is_empty].copy()
    gdf = gdf[gdf.geometry.is_valid].copy()
    if len(gdf) < before:
        log.info("Dropped %d invalid/empty geometries (%d remaining)", before - len(gdf), len(gdf))

    # Build spatial index
    log.info("Building spatial index...")
    sindex = gdf.sindex

    # Determine bounds
    total_bounds = gdf.total_bounds  # [minx, miny, maxx, maxy]
    log.info("Bounds: %.4f, %.4f to %.4f, %.4f", *total_bounds)

    # Prepare properties — keep only useful columns, reduce size
    prop_columns = [c for c in gdf.columns if c != "geometry"]
    # Limit to essential properties to keep tile sizes small
    keep_props = {"confidence", "area_in_meters", "class", "height", "num_floors"}
    prop_columns = [c for c in prop_columns if c in keep_props]

    # Collect all tiles
    all_tiles = {}  # tileid -> tile_bytes
    total_tiles = 0

    for zoom in range(min_zoom, max_zoom + 1):
        zoom_start = time.time()

        # Find tile range for this zoom
        x_min, y_min = lng_lat_to_tile(total_bounds[0], total_bounds[3], zoom)
        x_max, y_max = lng_lat_to_tile(total_bounds[2], total_bounds[1], zoom)

        tile_count = (x_max - x_min + 1) * (y_max - y_min + 1)
        log.info("Zoom %d: tiles %d×%d = %d (x: %d-%d, y: %d-%d)",
                 zoom, x_max - x_min + 1, y_max - y_min + 1, tile_count,
                 x_min, x_max, y_min, y_max)

        tiles_written = 0
        features_total = 0

        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                # Get tile bounds with small buffer for edge features
                bounds = tile_bounds(x, y, zoom)
                buffer = (bounds[2] - bounds[0]) * 0.05  # 5% buffer
                query_box = box(
                    bounds[0] - buffer,
                    bounds[1] - buffer,
                    bounds[2] + buffer,
                    bounds[3] + buffer,
                )

                # Spatial query
                candidate_idx = list(sindex.intersection(query_box.bounds))
                if not candidate_idx:
                    continue

                candidates = gdf.iloc[candidate_idx]

                # Clip to tile bounds (with buffer)
                tile_box = box(*bounds)
                features_in_tile = []

                for idx, row in candidates.iterrows():
                    geom = row.geometry
                    if geom is None or geom.is_empty:
                        continue

                    # Simplify for lower zooms
                    if zoom < max_zoom:
                        geom = simplify_for_zoom(geom, zoom)

                    # Clip to tile
                    try:
                        clipped = geom.intersection(tile_box)
                        if clipped.is_empty:
                            continue
                    except Exception:
                        continue

                    # Build properties dict
                    props = {}
                    for col in prop_columns:
                        val = row.get(col)
                        if val is not None and not (isinstance(val, float) and math.isnan(val)):
                            props[col] = val

                    features_in_tile.append((clipped, props))

                if not features_in_tile:
                    continue

                # Encode MVT
                tile_bytes = build_mvt_tile(features_in_tile, bounds, layer_name)
                if tile_bytes is None:
                    continue

                tile_id = zxy_to_tileid(zoom, x, y)
                all_tiles[tile_id] = tile_bytes
                tiles_written += 1
                features_total += len(features_in_tile)

        elapsed = time.time() - zoom_start
        log.info("  Zoom %d: %d tiles, %d features in %.1fs",
                 zoom, tiles_written, features_total, elapsed)
        total_tiles += tiles_written

    # Write PMTiles
    log.info("Writing PMTiles: %d total tiles...", total_tiles)
    write_start = time.time()

    with open(output_path, "wb") as f:
        writer = PMTilesWriter(f)

        # Write tiles in sorted order (required by PMTiles spec)
        for tile_id in sorted(all_tiles.keys()):
            writer.write_tile(tile_id, all_tiles[tile_id])

        # Metadata
        metadata = {
            "name": "Google Open Buildings — Indore",
            "description": "528K building footprints from Google Open Buildings v3",
            "format": "pbf",
            "type": "overlay",
            "version": "1.0",
            "bounds": f"{total_bounds[0]},{total_bounds[1]},{total_bounds[2]},{total_bounds[3]}",
            "center": f"{(total_bounds[0]+total_bounds[2])/2},{(total_bounds[1]+total_bounds[3])/2},{max_zoom}",
            "minzoom": str(min_zoom),
            "maxzoom": str(max_zoom),
            "vector_layers": json.dumps([{
                "id": layer_name,
                "fields": {col: "String" for col in prop_columns},
                "minzoom": min_zoom,
                "maxzoom": max_zoom,
            }]),
        }

        writer.finalize(
            header={
                "tile_type": TileType.MVT,
                "tile_compression": Compression.NONE,
                "min_zoom": min_zoom,
                "max_zoom": max_zoom,
                "min_lon_e7": int(total_bounds[0] * 1e7),
                "min_lat_e7": int(total_bounds[1] * 1e7),
                "max_lon_e7": int(total_bounds[2] * 1e7),
                "max_lat_e7": int(total_bounds[3] * 1e7),
                "center_lon_e7": int((total_bounds[0] + total_bounds[2]) / 2 * 1e7),
                "center_lat_e7": int((total_bounds[1] + total_bounds[3]) / 2 * 1e7),
                "center_zoom": max_zoom,
            },
            metadata=metadata,
        )

    size_mb = output_path.stat().st_size / (1024 * 1024)
    elapsed = time.time() - write_start
    log.info("PMTiles written: %s (%.1f MB) in %.1fs", output_path.name, size_mb, elapsed)
    log.info("Total conversion time: %.1fs", time.time() - start)

    return output_path


def main():
    parser = argparse.ArgumentParser(description="Convert GeoJSON to PMTiles vector tiles")
    parser.add_argument(
        "--input", type=Path,
        default=Path(__file__).parent.parent / "data" / "vectors" / "google_open_buildings_indore.geojson",
        help="Input GeoJSON file",
    )
    parser.add_argument(
        "--output", type=Path, default=None,
        help="Output PMTiles file (default: same name with .pmtiles extension)",
    )
    parser.add_argument("--min-zoom", type=int, default=10, help="Minimum zoom level (default: 10)")
    parser.add_argument("--max-zoom", type=int, default=14, help="Maximum zoom level (default: 14)")
    parser.add_argument("--layer-name", type=str, default="building", help="MVT layer name (default: building)")
    args = parser.parse_args()

    output = args.output or args.input.with_suffix(".pmtiles")

    convert(
        input_path=args.input,
        output_path=output,
        min_zoom=args.min_zoom,
        max_zoom=args.max_zoom,
        layer_name=args.layer_name,
    )


if __name__ == "__main__":
    main()
