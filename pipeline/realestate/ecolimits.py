"""Building limits per block: Coastal Regulation Zone (Chennai) and eco-sensitive zones and protected areas (Bengaluru).

Per L7 block (dataset ``eco_limits``):

    crz_pct         share of the block's land inside the Coastal Regulation Zone (%)
    esz_pct         share inside a notified eco-sensitive zone (%)
    protected_pct   share inside a national park, sanctuary or conservation reserve (%)

Sources (all on data.opencity.in, public domain):

* Tamil Nadu CRZ boundary (TNGIS): the landward CRZ line along the sea and both edges of the zone along the tidal
  Adyar, Cooum, Kosasthalaiyar and Buckingham Canal. The file holds lines, not areas, so the zone is recovered on a
  ~20 m raster (see ``between``).
* Karnataka Forest Department 2022 boundaries for Bengaluru Urban: Bannerghatta National Park eco-sensitive zone, and
  the protected areas (Bannerghatta National Park, Puttenahalli Lake Bird Conservation Reserve).

    python -m pipeline.realestate.ecolimits --region chennai,bengaluru
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PX_M = 20
CRZ_M = 500      # coastal zone width from the high-tide line
POCKET_M = 300   # a walled pocket wider than 2x this is land between two zones, not a river or canal zone
OPENCITY = "https://data.opencity.in/dataset/"
CRZ = OPENCITY + "e83a36d7-1ed5-4183-a7b0-964d2c4be1cf/resource/ac2d71ac-733a-465a-aae9-3d1c17caff27/download/tn_crz_boundary.geojson"
BLR_ESZ = OPENCITY + "7b7028af-9c01-4b7f-b3f5-d1e67fc1804c/resource/8284ae76-b0f4-4a12-8005-77fda43d6746/download/33baa6ca-2a13-4000-8cd0-b26340d6d744.kml"
BLR_PA = OPENCITY + "7b7028af-9c01-4b7f-b3f5-d1e67fc1804c/resource/646f203e-5591-4ebd-b502-47fa0902a5eb/download/e259bbc0-6503-40d8-9574-3fe55e279945.kml"


class Raster:
    """A lat/lng grid of about PX_M metres over a bounding box."""

    def __init__(self, bbox, px_m=PX_M):
        self.w, self.s, self.e, self.n = bbox
        lat0 = (self.s + self.n) / 2
        self.W = max(2, round((self.e - self.w) * 111_320 * math.cos(math.radians(lat0)) / px_m))
        self.H = max(2, round((self.n - self.s) * 110_574 / px_m))

    def xy(self, lng, lat):
        return (lng - self.w) / (self.e - self.w) * self.W, (self.n - lat) / (self.n - self.s) * self.H

    def lnglat(self, col, row):
        return self.w + (col + 0.5) / self.W * (self.e - self.w), self.n - (row + 0.5) / self.H * (self.n - self.s)


def _image(r):
    from PIL import Image, ImageDraw
    im = Image.new("1", (r.W, r.H), 0)
    return im, ImageDraw.Draw(im)


def walls(r, lines):
    """Boolean mask of the lines drawn two pixels wide, so the fill cannot slip through a diagonal step."""
    import numpy as np
    im, d = _image(r)
    for line in lines:
        if len(line) >= 2:
            d.line([r.xy(*p[:2]) for p in line], fill=1, width=2)
    return np.array(im, dtype=bool)


def fill_polygons(r, rings):
    """Boolean mask of the (outer, [holes]) polygons."""
    import numpy as np
    im, d = _image(r)
    for outer, holes in rings:
        d.polygon([r.xy(*p[:2]) for p in outer], fill=1)
        for h in holes:
            d.polygon([r.xy(*p[:2]) for p in h], fill=0)
    return np.array(im, dtype=bool)


def between(wall, px_m=PX_M, inland_side="w", sea_side="e"):
    """(zone, land) masks from CRZ walls.

    The TNGIS file draws the landward CRZ line 500 m from the high-tide line along the sea, and both edges of the zone
    along tidal rivers and canals, but not the high-tide line itself. So: the part reached from the sea edge is the
    coastal zone up to CRZ_M from the wall (beyond is sea); a walled-in pocket is a river or canal zone when it is
    narrow (no point more than POCKET_M from a wall); wider pockets are ordinary land caught between two zones.
    """
    import numpy as np
    from scipy import ndimage
    lab, k = ndimage.label(~wall)
    edge = {"w": lab[:, 0], "e": lab[:, -1], "n": lab[0, :], "s": lab[-1, :]}
    inland = set(np.unique(edge[inland_side])) - {0}
    sea = (set(np.unique(edge[sea_side])) - {0}) - inland
    dist = ndimage.distance_transform_edt(~wall) * px_m
    is_sea = np.isin(lab, list(sea))
    coastal = is_sea & (dist <= CRZ_M)
    widest = ndimage.maximum(dist, lab, index=np.arange(k + 1))
    narrow = np.array([i not in inland and i not in sea and widest[i] <= POCKET_M for i in range(k + 1)])
    narrow[0] = False
    pocket = narrow[lab]
    near_wall = wall & ndimage.binary_dilation(coastal | pocket, iterations=2)
    zone = coastal | pocket | near_wall
    return zone, ~is_sea | coastal


def block_shares(r, masks, land):
    """{digipin: {name: % of the block's land pixels in mask}} at LEVEL."""
    import numpy as np

    from pipeline.cells.store import cell_code
    rows, cols = np.nonzero(land)
    if not len(rows):
        return {}
    tot, hit = {}, {k: {} for k in masks}
    # One cell lookup per 3x3 pixel tile (~60 m): far below the ~250 m block size.
    for i in range(0, r.H, 3):
        for j in range(0, r.W, 3):
            sub = land[i:i + 3, j:j + 3]
            n = int(sub.sum())
            if not n:
                continue
            code = cell_code(LEVEL, *reversed(r.lnglat(j + 1, i + 1)), None)
            if code is None:
                continue
            tot[code] = tot.get(code, 0) + n
            for k, m in masks.items():
                h = int((m[i:i + 3, j:j + 3] & sub).sum())
                if h:
                    hit[k][code] = hit[k].get(code, 0) + h
    out = {}
    for k, d in hit.items():
        for code, h in d.items():
            out.setdefault(code, {})[k] = round(100 * h / tot[code], 1)
    return out


def geojson_lines(doc):
    for f in doc.get("features") or []:
        g = f.get("geometry") or {}
        if g.get("type") == "LineString":
            yield g["coordinates"]
        elif g.get("type") == "MultiLineString":
            yield from g["coordinates"]


def kml_polygons(text):
    """[(outer, [holes])] from every Polygon in a KML."""
    import xml.etree.ElementTree as ET
    tag = lambda e: e.tag.rsplit("}", 1)[-1]
    coords = lambda e: [tuple(map(float, t.split(",")[:2])) for t in (next(c for c in e.iter() if tag(c) == "coordinates").text or "").split()]
    out = []
    for poly in (e for e in ET.fromstring(text).iter() if tag(e) == "Polygon"):
        outer = next(e for e in poly if tag(e) == "outerBoundaryIs")
        holes = [coords(e) for e in poly if tag(e) == "innerBoundaryIs"]
        out.append((coords(outer), holes))
    return out


def chennai(bbox, log=print):
    import requests
    r = Raster(bbox)
    wall = walls(r, geojson_lines(json.loads(requests.get(CRZ, timeout=600).content)))
    zone, land = between(wall)
    log(f"chennai: raster {r.W}x{r.H}, CRZ {zone.sum() * PX_M ** 2 / 1e6:.1f} km² of {land.sum() * PX_M ** 2 / 1e6:.0f} km² land")
    return block_shares(r, {"crz_pct": zone}, land)


def bengaluru(bbox, log=print):
    import numpy as np
    import requests
    r = Raster(bbox)
    get = lambda u: requests.get(u, timeout=300).content.decode("utf-8-sig")
    esz, pa = fill_polygons(r, kml_polygons(get(BLR_ESZ))), fill_polygons(r, kml_polygons(get(BLR_PA)))
    log(f"bengaluru: ESZ {esz.sum() * PX_M ** 2 / 1e6:.1f} km², protected {pa.sum() * PX_M ** 2 / 1e6:.1f} km² in the region")
    return block_shares(r, {"esz_pct": esz, "protected_pct": pa}, np.ones_like(esz))


def cell_dataset(region, shares):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("crz_pct", "Share of the block in the Coastal Regulation Zone (Chennai)", agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("esz_pct", "Share of the block in an eco-sensitive zone (Bengaluru)", agg="mean", unit="%", domain=[0, 100], ramp="greens", higher_is="worse"),
        FieldSpec("protected_pct", "Share of the block in a national park or conservation reserve (Bengaluru)", agg="mean", unit="%", domain=[0, 100], ramp="greens", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="eco_limits", title="Coastal and eco-sensitive building limits", level=LEVEL, fields=specs, group="Real estate",
        description="How much of each block lies where building is restricted by law: the Coastal Regulation Zone from Tamil "
                    "Nadu's official CRZ line (Chennai), and the Bannerghatta eco-sensitive zone and protected areas from the "
                    "Karnataka Forest Department's 2022 boundaries (Bengaluru), via data.opencity.in.",
        source="pipeline/realestate/ecolimits.py (TNGIS CRZ line; Karnataka Forest Department ESZ and protected areas)",
        license="Public domain (TNGIS and Karnataka Forest Department via data.opencity.in)", default_field="crz_pct", extrude=False)
    recs = ({"digipin": c, **v} for c, v in shares.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="chennai,bengaluru")
    a = ap.parse_args(argv)
    for reg in a.region.split(","):
        shares = {"chennai": chennai, "bengaluru": bengaluru}[reg](bbox_for(reg))
        info = cell_dataset(reg, shares)
        print(f"{reg}: {info['cells']} blocks touch a limit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
