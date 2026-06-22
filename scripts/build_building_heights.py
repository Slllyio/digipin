#!/usr/bin/env python3
"""
Bake per-building heights for the Indore pilot from Google Open Buildings 2.5D.

Overture footprints carry no height for Indore (verified: 0/11928 in the central
tile), so the dark-theme 3D "digital twin" needs heights from elsewhere. This
samples the Open Buildings 2.5D Temporal `building_height` band (Google Earth
Engine, ~4 m, 2023) at every Overture building centroid in the pilot bbox and
writes a compact lookup keyed by Overture id:

    data/heights/indore_building_heights.json   ->  { "<overture_id>": <metres>, ... }

The web app (js/buildings-deck.js → loadHeights) reads that file and uses the
real height per building, falling back to a footprint-area estimate for any id
not present.

Run (auth is a GEE service-account key, JSON, in the environment):

    export GEE_SERVICE_ACCOUNT_KEY="$(cat key.json)"     # or set as an env secret
    python3 scripts/build_building_heights.py

Requires: earthengine-api, pmtiles, mapbox-vector-tile  (pip install).
"""
import os, sys, json, math, gzip, tempfile, urllib.request

PMTILES = "https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2024-08-20/buildings.pmtiles"
# Central Indore [west, south, east, north] — ~7km around the default map view
# (75.8577, 22.7196). The full metro has ~435k footprints (too large to ship as a
# per-building lookup); this covers the pilot's actual viewing area, and anything
# outside falls back to the footprint-area estimate.
BBOX = (75.8227, 22.6886, 75.8927, 22.7506)
ZOOM = 14
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "heights", "indore_building_heights.json")
EE_COLLECTION = "GOOGLE/Research/open-buildings-temporal/v1"
EE_YEAR = 2023
BATCH = 4000   # EE getInfo element budget per request


def lon2tile(lon, z):
    """Slippy-map tile X index for a longitude at zoom z."""
    return int((lon + 180.0) / 360.0 * (2 ** z))


def lat2tile(lat, z):
    """Slippy-map tile Y index for a latitude at zoom z."""
    r = math.radians(lat)
    return int((1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * (2 ** z))


def harvest_centroids():
    """Return [(overture_id, lng, lat)] for every building footprint in the bbox."""
    from pmtiles.reader import Reader
    from mapbox_vector_tile import decode as mvt_decode

    def fetch(off, ln):
        req = urllib.request.Request(PMTILES, headers={"Range": f"bytes={off}-{off + ln - 1}"})
        return urllib.request.urlopen(req, timeout=60).read()

    reader = Reader(lambda off, ln: fetch(off, ln))
    x0, x1 = lon2tile(BBOX[0], ZOOM), lon2tile(BBOX[2], ZOOM)
    y0, y1 = lat2tile(BBOX[3], ZOOM), lat2tile(BBOX[1], ZOOM)   # y grows southward
    out, seen = [], set()
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            data = reader.get(ZOOM, tx, ty)
            if not data:
                continue
            if data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
            dec = mvt_decode(data)
            layer = dec.get("building")
            if not layer:
                continue
            extent = layer["extent"]
            for f in layer["features"]:
                bid = f["properties"].get("id")
                if not bid or bid in seen:
                    continue
                # centroid of the tile-local geometry -> lng/lat
                pts = _all_points(f["geometry"])
                if not pts:
                    continue
                mx = sum(p[0] for p in pts) / len(pts)
                my = sum(p[1] for p in pts) / len(pts)
                lng = (tx + mx / extent) / (2 ** ZOOM) * 360.0 - 180.0
                n = math.pi - 2.0 * math.pi * (ty + (1 - my / extent)) / (2 ** ZOOM)
                lat = math.degrees(math.atan(math.sinh(n)))
                seen.add(bid)
                out.append((bid, lng, lat))
    return out


def _all_points(geom):
    """Flatten every [x, y] coordinate pair out of a (possibly nested) geometry."""
    pts = []
    def walk(x):
        if isinstance(x, (list, tuple)):
            if len(x) == 2 and all(isinstance(v, (int, float)) for v in x):
                pts.append(x)
            else:
                for y in x:
                    walk(y)
    walk(geom["coordinates"] if isinstance(geom, dict) else geom)
    return pts


def ee_init():
    """Initialise Earth Engine from the GEE_SERVICE_ACCOUNT_KEY env var (JSON)."""
    import ee
    key = os.environ.get("GEE_SERVICE_ACCOUNT_KEY")
    if not key:
        sys.exit("GEE_SERVICE_ACCOUNT_KEY not set in environment.")
    info = json.loads(key)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(info, fh)
        key_path = fh.name
    try:
        creds = ee.ServiceAccountCredentials(info["client_email"], key_path)
        ee.Initialize(creds)
    finally:
        # Don't leave the service-account key sitting on disk.
        try: os.unlink(key_path)
        except OSError: pass
    return ee


def sample_heights(ee, centroids):
    """Sample Open Buildings 2.5D height at each centroid; return {id: metres}."""
    img = (ee.ImageCollection(EE_COLLECTION)
           .filter(ee.Filter.calendarRange(EE_YEAR, EE_YEAR, "year"))
           .select("building_height")
           .mosaic())
    heights = {}
    for i in range(0, len(centroids), BATCH):
        chunk = centroids[i:i + BATCH]
        feats = [ee.Feature(ee.Geometry.Point([lng, lat]), {"bid": bid})
                 for bid, lng, lat in chunk]
        fc = ee.FeatureCollection(feats)
        sampled = img.reduceRegions(collection=fc, reducer=ee.Reducer.first(), scale=4).getInfo()
        for f in sampled["features"]:
            p = f["properties"]
            h = p.get("building_height", p.get("first"))
            if h is not None and h > 0:
                heights[p["bid"]] = round(float(h))   # whole metres keep the file lean
        print(f"  sampled {min(i + BATCH, len(centroids))}/{len(centroids)} (kept {len(heights)})")
    return heights


def main():
    """Harvest centroids, sample heights, and write the baked JSON lookup."""
    print("Harvesting Overture building centroids in the pilot bbox…")
    centroids = harvest_centroids()
    print(f"  {len(centroids)} buildings")
    ee = ee_init()
    print("Sampling Open Buildings 2.5D heights via Earth Engine…")
    heights = sample_heights(ee, centroids)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(heights, fh, separators=(",", ":"))
    print(f"Wrote {len(heights)} heights -> {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
