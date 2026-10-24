"""Mirror all Bharatlas layers from R2 to data/bharatlas/.

Bharatlas (bharatlas.com) publishes a `catalog.json` index of 59
India-wide curated geospatial layers, each served from a Cloudflare R2
public bucket as multiple formats:

    pmtiles      vector tiles — directly usable by MapLibre
    parquet      columnar — for DuckDB / pandas analysis
    geojson      full GeoJSON — for GIS tools that don't speak parquet
    kml          Google Earth
    shapefile    legacy GIS

This script pulls the catalog, then downloads every layer's PMTiles +
parquet (the two most useful formats for DigiPin's stack). GeoJSON and
KML are large and rarely needed; pass --formats to include them.

Behaviour:
    - Resume-friendly: skips files that already exist with matching size
    - Reports per-layer progress + total bytes downloaded
    - Polite: 0.5 s base delay between requests (R2 doesn't rate-limit
      but we want to be a courteous mirror)
    - Idempotent: re-running produces no changes if everything's
      already on disk

Usage:
    python pipeline/bharatlas/fetch_all.py                # PMTiles + parquet
    python pipeline/bharatlas/fetch_all.py --formats pmtiles
    python pipeline/bharatlas/fetch_all.py --formats all  # every format
    python pipeline/bharatlas/fetch_all.py --layers datagov_pincodes lgd_subdistricts

Catalog source:
    https://bharatlas.com/catalog.json
    https://github.com/urbanmorph/geodata

Output layout:
    data/bharatlas/
        catalog.json                                # mirror of the upstream index
        admin/states/LGD_States.pmtiles             # one path per upstream R2 key
        admin/states/LGD_States.parquet
        postal/boundaries/Datagov_Pincode_Boundaries.pmtiles
        ...
        MANIFEST.json                               # summary of what was fetched
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen, Request

CATALOG_URL = "https://bharatlas.com/catalog.json"
OUT_DIR = Path("data/bharatlas")
DEFAULT_FORMATS = ("pmtiles", "parquet")
ALL_FORMATS = ("pmtiles", "parquet", "geojson", "kml", "shapefile")
POLITE_DELAY_S = 0.5

log = logging.getLogger("pipeline.bharatlas.fetch_all")


@dataclass
class LayerStat:
    id: str
    formats_fetched: list[str]
    bytes_total: int
    rows: int
    source: str
    licence: str


def _download(url: str, dest: Path, expected_bytes: int | None) -> tuple[bool, int]:
    """Stream-download `url` to `dest`. Returns (downloaded_now, bytes_on_disk).

    If `dest` already exists and matches `expected_bytes` (within 1%), the
    file is considered up-to-date and not refetched.
    """
    if dest.is_file() and expected_bytes is not None:
        actual = dest.stat().st_size
        if abs(actual - expected_bytes) / max(expected_bytes, 1) < 0.01:
            return False, actual

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = Request(url, headers={"User-Agent": "DigiPin-Bharatlas-Mirror/1.0 (+https://github.com/Slllyio/digipin)"})

    with urlopen(req, timeout=120) as r:
        total = int(r.headers.get("Content-Length") or 0)
        chunk = 256 * 1024
        bytes_read = 0
        with tmp.open("wb") as f:
            while True:
                buf = r.read(chunk)
                if not buf:
                    break
                f.write(buf)
                bytes_read += len(buf)

    if total and abs(bytes_read - total) > 1024:
        log.warning("size mismatch for %s — got %d, expected %d", dest.name, bytes_read, total)

    tmp.replace(dest)
    time.sleep(POLITE_DELAY_S)
    return True, bytes_read


def _r2_path_from_url(catalog: dict, url: str) -> str:
    """Strip the R2 base from a URL → relative path for local mirror."""
    base = catalog["r2_base"].rstrip("/")
    if url.startswith(base):
        return url[len(base) + 1:]
    return urlparse(url).path.lstrip("/")


def fetch_catalog(catalog_path: Path) -> dict:
    """Fetch the upstream catalog.json + save a copy locally."""
    log.info("fetching catalog: %s", CATALOG_URL)
    req = Request(CATALOG_URL, headers={"User-Agent": "DigiPin-Bharatlas-Mirror/1.0"})
    with urlopen(req, timeout=30) as r:
        data = r.read()
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_bytes(data)
    parsed = json.loads(data)
    log.info("catalog version=%s generated=%s layers=%d",
             parsed.get("version"), parsed.get("generated"), len(parsed.get("layers", [])))
    return parsed


def fetch_layer(layer: dict, catalog: dict, formats: list[str], out_dir: Path) -> LayerStat:
    """Mirror one layer's selected formats. Returns a LayerStat."""
    fmts_done: list[str] = []
    total_bytes = 0
    for fmt in formats:
        entry = layer.get(fmt)
        if not entry or "url" not in entry:
            continue
        rel = _r2_path_from_url(catalog, entry["url"])
        dest = out_dir / rel
        expected = entry.get("bytes")
        downloaded, on_disk = _download(entry["url"], dest, expected)
        fmts_done.append(fmt)
        total_bytes += on_disk
        marker = "downloaded" if downloaded else "cached  "
        log.info("  %-9s %s %s (%.1f MB)",
                 fmt, marker, dest.relative_to(out_dir),
                 on_disk / 1e6)

    return LayerStat(
        id=layer["id"],
        formats_fetched=fmts_done,
        bytes_total=total_bytes,
        rows=layer.get("rows", 0),
        source=layer.get("source", ""),
        licence=layer.get("licence", ""),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--formats", nargs="+", default=list(DEFAULT_FORMATS),
                        choices=list(ALL_FORMATS) + ["all"],
                        help=f"formats to fetch (default: {' '.join(DEFAULT_FORMATS)})")
    parser.add_argument("--layers", nargs="+",
                        help="restrict to specific layer ids (default: all)")
    parser.add_argument("--out", default=str(OUT_DIR),
                        help=f"output directory (default: {OUT_DIR})")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(message)s",
        datefmt="%H:%M:%S",
    )

    formats = list(ALL_FORMATS) if "all" in args.formats else args.formats
    out_dir = Path(args.out)
    catalog_path = out_dir / "catalog.json"
    catalog = fetch_catalog(catalog_path)

    selected = catalog["layers"]
    if args.layers:
        wanted = set(args.layers)
        selected = [l for l in selected if l["id"] in wanted]
        missing = wanted - {l["id"] for l in selected}
        if missing:
            log.warning("unknown layer ids: %s", ", ".join(sorted(missing)))

    log.info("mirroring %d layers, formats=%s", len(selected), ", ".join(formats))
    stats: list[LayerStat] = []
    for i, layer in enumerate(selected, 1):
        log.info("[%d/%d] %s (%s, %s rows)", i, len(selected),
                 layer["id"], layer.get("source", "?"), layer.get("rows", "?"))
        stats.append(fetch_layer(layer, catalog, formats, out_dir))

    total = sum(s.bytes_total for s in stats)
    log.info("done. mirrored %d layers, %.1f MB total", len(stats), total / 1e6)

    manifest = {
        "mirrored_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "catalog_version": catalog.get("version"),
        "catalog_generated": catalog.get("generated"),
        "formats": formats,
        "total_bytes": total,
        "layer_count": len(stats),
        "layers": [asdict(s) for s in stats],
    }
    (out_dir / "MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log.info("manifest: %s", out_dir / "MANIFEST.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
