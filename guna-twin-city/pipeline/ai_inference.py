"""
DigiPin Digital Twin — AI Inference Pipeline (Guna)
====================================================
Runs pre-trained geospatial AI models on Guna's satellite and sensor data.

Subcommands:
    lulc       Dynamic World / BigEarthNet LULC classification
    flood      IBM/NASA Prithvi flood segmentation
    buildings  SAM2 building footprint extraction
    crowd      YOLOv8n crowd counting
    ndvi       NDVI time-series computation
    change     Change detection via NDBI differencing

Usage:
    python ai_inference.py lulc --input data/satellite/sentinel2_guna/
    python ai_inference.py flood --input data/satellite/sentinel2_guna/
    python ai_inference.py buildings --input data/satellite/aerial_guna.tif
    python ai_inference.py crowd --input path/to/image.jpg
    python ai_inference.py ndvi --input data/satellite/sentinel2_guna/
    python ai_inference.py change --before data/satellite/scene1/ --after data/satellite/scene2/

Requires (base): pip install numpy rasterio shapely
Per-model deps listed in each subcommand's --help.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from config import BBOX, BBOX_CITY, CENTER_LAT, CENTER_LON, CITY_NAME, DATA_DIR, fix_proj

fix_proj()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("ai_inference")

# ---------------------------------------------------------------------------
# Output directory
# ---------------------------------------------------------------------------
AI_OUTPUT_DIR = DATA_DIR / "ai_outputs"
AI_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# LULC class definitions (Dynamic World 9-class)
# ---------------------------------------------------------------------------
LULC_CLASSES = {
    0: "water",
    1: "trees",
    2: "grass",
    3: "flooded_vegetation",
    4: "crops",
    5: "shrub_and_scrub",
    6: "built_area",
    7: "bare_ground",
    8: "snow_and_ice",
}

LULC_COLORS = {
    0: (65, 105, 225),    # royal blue
    1: (34, 139, 34),     # forest green
    2: (144, 238, 144),   # light green
    3: (0, 128, 128),     # teal
    4: (255, 215, 0),     # gold
    5: (210, 180, 140),   # tan
    6: (255, 0, 0),       # red
    7: (194, 178, 128),   # sand
    8: (255, 255, 255),   # white
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _check_dependency(module_name: str, pip_name: str | None = None) -> bool:
    """Return True if *module_name* is importable, else print install hint."""
    import importlib

    pip_name = pip_name or module_name
    try:
        importlib.import_module(module_name)
        return True
    except ImportError:
        log.error(
            "Missing dependency: %s. Install with:\n    pip install %s",
            module_name,
            pip_name,
        )
        return False


def _write_summary(
    out_dir: Path,
    task: str,
    *,
    metrics: dict[str, Any],
    inputs: list[str],
    outputs: list[str],
    model: str,
    device: str,
    elapsed_s: float,
) -> Path:
    """Write a JSON summary file and return its path."""
    summary = {
        "task": task,
        "model": model,
        "device": device,
        "city": CITY_NAME,
        "bbox": BBOX_CITY,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "elapsed_seconds": round(elapsed_s, 2),
        "inputs": inputs,
        "outputs": outputs,
        "metrics": metrics,
    }
    path = out_dir / f"{task}_summary.json"
    path.write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    log.info("Summary written to %s", path)
    return path


def _get_torch_device(device_name: str):
    """Return a torch device object for the given device name."""
    import torch

    if device_name == "cuda":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device_name == "directml":
        try:
            import torch_directml
            return torch_directml.device()
        except ImportError:
            log.warning("torch-directml not installed, falling back to CPU")
            return torch.device("cpu")
    return torch.device("cpu")


def _to_device(tensor_or_model, device_name: str):
    """Move a tensor or model to the specified device."""
    device = _get_torch_device(device_name)
    return tensor_or_model.to(device)


def _collect_tifs(input_path: Path) -> list[Path]:
    """Gather .tif/.tiff files from a file or directory."""
    if input_path.is_file():
        return [input_path]
    tifs = sorted(input_path.glob("*.tif")) + sorted(input_path.glob("*.tiff"))
    if not tifs:
        log.error("No GeoTIFF files found in %s", input_path)
        sys.exit(1)
    return tifs


def _read_bands(tif_path: Path, band_indices: list[int] | None = None) -> tuple:
    """Read a GeoTIFF and return (numpy array, profile).

    Parameters
    ----------
    tif_path : path to GeoTIFF
    band_indices : 1-based band indices to read. None = all bands.

    Returns
    -------
    (data, profile) where data shape is (bands, height, width).
    """
    import rasterio

    with rasterio.open(tif_path) as src:
        profile = dict(src.profile)
        if band_indices:
            data = src.read(band_indices)
        else:
            data = src.read()
    return data, profile


def _write_geotiff(
    path: Path,
    data: np.ndarray,
    profile: dict,
    *,
    dtype: str | None = None,
    count: int | None = None,
    nodata: float | None = None,
) -> Path:
    """Write a numpy array as a GeoTIFF, returning the path."""
    import rasterio

    out_profile = dict(profile)
    if dtype:
        out_profile["dtype"] = dtype
    if count is not None:
        out_profile["count"] = count
    if nodata is not None:
        out_profile["nodata"] = nodata
    out_profile["driver"] = "GTiff"
    out_profile["compress"] = "lzw"

    if data.ndim == 2:
        data = data[np.newaxis, :, :]
    out_profile["count"] = data.shape[0]
    out_profile["height"] = data.shape[1]
    out_profile["width"] = data.shape[2]

    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", **out_profile) as dst:
        dst.write(data)
    log.info("GeoTIFF written: %s (%s)", path, out_profile["dtype"])
    return path


def _mask_to_geojson(
    mask: np.ndarray,
    transform,
    out_path: Path,
    *,
    min_area_m2: float = 0.0,
    simplify_tolerance: float = 0.0,
    properties: dict | None = None,
) -> Path:
    """Vectorize a binary mask to GeoJSON polygons.

    Parameters
    ----------
    mask : 2-D boolean / uint8 array (1 = feature, 0 = background)
    transform : rasterio Affine transform
    out_path : output GeoJSON path
    min_area_m2 : drop polygons smaller than this (approximate via pixel area)
    simplify_tolerance : Douglas-Peucker tolerance in CRS units
    properties : extra properties added to each feature
    """
    from rasterio.features import shapes
    from shapely.geometry import mapping, shape

    mask_uint8 = mask.astype(np.uint8)
    features = []
    for geom, value in shapes(mask_uint8, transform=transform):
        if value == 0:
            continue
        poly = shape(geom)
        if simplify_tolerance > 0:
            poly = poly.simplify(simplify_tolerance, preserve_topology=True)
        if poly.is_empty:
            continue
        # Approximate area filtering (in CRS units squared)
        if min_area_m2 > 0:
            # Rough conversion: 1 degree ~ 111,000 m at equator
            area_m2 = poly.area * (111_000 ** 2)
            if area_m2 < min_area_m2:
                continue
        feat_props = {"value": int(value)}
        if properties:
            feat_props.update(properties)
        features.append(
            {"type": "Feature", "geometry": mapping(poly), "properties": feat_props}
        )

    geojson = {"type": "FeatureCollection", "features": features}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(geojson, indent=2), encoding="utf-8")
    log.info("GeoJSON written: %s (%d features)", out_path, len(features))
    return out_path


# ===================================================================
# 1. LULC Classification
# ===================================================================
class LULCClassifier:
    """Dynamic World / BigEarthNet LULC classification on Sentinel-2 tiles.

    Tiles the input into 64x64 patches, classifies each patch, and stitches
    back into a full-resolution classified raster.
    """

    REQUIRED_DEPS = [
        ("tensorflow", "tensorflow"),
        ("rasterio", "rasterio"),
    ]
    PATCH_SIZE = 64
    NUM_CLASSES = 9

    # HuggingFace model IDs (tried in order)
    DW_MODEL_REPO = "google/dynamicworld"
    FALLBACK_MODEL_REPO = "torchgeo/bigearthnet_resnet50"

    def __init__(self, device: str = "cpu"):
        self.device = device
        self._model = None
        self._backend = None  # "tf" or "torch"

    # ------------------------------------------------------------------
    def check_deps(self) -> bool:
        """Return True if at least one backend is available."""
        has_tf = _check_dependency("tensorflow", "tensorflow")
        has_torch = _check_dependency("torch", "torch torchvision")
        if not has_tf and not has_torch:
            log.error(
                "LULC needs at least one backend.\n"
                "    pip install tensorflow   (for Dynamic World)\n"
                "  OR\n"
                "    pip install torch torchvision torchgeo   (for BigEarthNet)"
            )
            return False
        return True

    # ------------------------------------------------------------------
    def _load_model_tf(self) -> bool:
        """Try loading Dynamic World TF SavedModel."""
        try:
            import tensorflow as tf

            log.info("Attempting to load Dynamic World TF SavedModel ...")
            cache_dir = Path.home() / ".cache" / "digipin_models" / "dynamic_world"
            if cache_dir.exists() and any(cache_dir.iterdir()):
                self._model = tf.saved_model.load(str(cache_dir))
                self._backend = "tf"
                log.info("Dynamic World TF model loaded from cache.")
                return True

            # Try downloading via huggingface_hub
            try:
                from huggingface_hub import snapshot_download

                local = snapshot_download(
                    self.DW_MODEL_REPO,
                    cache_dir=str(cache_dir.parent),
                    local_dir=str(cache_dir),
                )
                self._model = tf.saved_model.load(local)
                self._backend = "tf"
                log.info("Dynamic World TF model downloaded and loaded.")
                return True
            except Exception as exc:
                log.warning("Dynamic World download failed: %s", exc)
                return False
        except ImportError:
            return False

    def _load_model_torch(self) -> bool:
        """Fallback: load BigEarthNet ResNet50 via torchgeo."""
        try:
            import torch

            log.info("Attempting to load BigEarthNet ResNet50 via torchgeo ...")
            try:
                from torchgeo.models import ResNet50_Weights, resnet50

                weights = ResNet50_Weights.SENTINEL2_ALL_MOCO
                model = resnet50(weights=weights)
                model.set_to_inference_mode = lambda: None  # placeholder
                for param in model.parameters():
                    param.requires_grad = False
                if self.device != "cpu":
                    model = _to_device(model, self.device)
                self._model = model
                self._backend = "torch"
                log.info("BigEarthNet ResNet50 loaded (torchgeo).")
                return True
            except Exception as exc:
                log.warning("torchgeo ResNet50 failed: %s", exc)

            # Manual fallback -- a simple ResNet50 for 9-class classification
            from torchvision.models import resnet50 as tv_resnet50

            cache_dir = Path.home() / ".cache" / "digipin_models" / "bigearthnet_resnet50"
            cache_dir.mkdir(parents=True, exist_ok=True)
            weight_path = cache_dir / "resnet50_lulc.pth"

            if weight_path.exists():
                model = tv_resnet50(num_classes=self.NUM_CLASSES)
                model.load_state_dict(torch.load(str(weight_path), map_location="cpu"))
            else:
                log.warning(
                    "No pre-trained LULC weights cached. Using ImageNet-initialised "
                    "ResNet50 -- predictions will be untrained placeholders. "
                    "Download proper weights to %s",
                    weight_path,
                )
                model = tv_resnet50(weights="IMAGENET1K_V2")
                # Replace final FC for 9 classes
                model.fc = torch.nn.Linear(model.fc.in_features, self.NUM_CLASSES)

            for param in model.parameters():
                param.requires_grad = False
            if self.device != "cpu":
                model = _to_device(model, self.device)
            self._model = model
            self._backend = "torch"
            return True

        except ImportError:
            return False

    # ------------------------------------------------------------------
    def load_model(self) -> None:
        """Load best available model (TF first, then PyTorch fallback)."""
        if self._load_model_tf():
            return
        if self._load_model_torch():
            return
        log.error("Could not load any LULC model. Check dependencies.")
        sys.exit(1)

    # ------------------------------------------------------------------
    def _classify_patches_torch(self, image: np.ndarray) -> np.ndarray:
        """Classify an image (C, H, W) into (H, W) class indices using PyTorch."""
        import torch

        _, h, w = image.shape
        patch = self.PATCH_SIZE
        result = np.zeros((h, w), dtype=np.uint8)

        # Pad to multiple of patch size
        pad_h = (patch - h % patch) % patch
        pad_w = (patch - w % patch) % patch
        image_padded = np.pad(image, ((0, 0), (0, pad_h), (0, pad_w)), mode="reflect")

        _, ph, pw = image_padded.shape
        patches_collected = []
        coords = []

        for y in range(0, ph, patch):
            for x in range(0, pw, patch):
                tile = image_padded[:, y : y + patch, x : x + patch]
                patches_collected.append(tile)
                coords.append((y, x))

        # Batch inference
        batch_size = 32
        all_preds = []
        for i in range(0, len(patches_collected), batch_size):
            batch = np.stack(patches_collected[i : i + batch_size]).astype(np.float32)
            # Normalise to [0, 1]
            bmax = batch.max()
            if bmax > 0:
                batch = batch / bmax
            # Select first 3 channels if model expects RGB
            if batch.shape[1] > 3:
                batch = batch[:, :3, :, :]
            tensor = torch.from_numpy(batch)
            if self.device != "cpu":
                tensor = _to_device(tensor, self.device)
            with torch.no_grad():
                out = self._model(tensor)
                preds = out.argmax(dim=1).cpu().numpy()
            all_preds.append(preds)

        all_preds = np.concatenate(all_preds)

        for idx, (y, x) in enumerate(coords):
            cls_val = int(all_preds[idx].flat[0]) if all_preds[idx].ndim > 0 else int(all_preds[idx])
            # Fill the patch with majority class (patch-level classification)
            end_y = min(y + patch, h)
            end_x = min(x + patch, w)
            if y < h and x < w:
                result[y:end_y, x:end_x] = cls_val % self.NUM_CLASSES

        return result

    def _classify_patches_tf(self, image: np.ndarray) -> np.ndarray:
        """Classify with TF SavedModel. Expects (C, H, W) input."""
        import tensorflow as tf

        _, h, w = image.shape
        patch = self.PATCH_SIZE
        result = np.zeros((h, w), dtype=np.uint8)

        pad_h = (patch - h % patch) % patch
        pad_w = (patch - w % patch) % patch
        image_padded = np.pad(image, ((0, 0), (0, pad_h), (0, pad_w)), mode="reflect")

        _, ph, pw = image_padded.shape

        for y in range(0, ph, patch):
            for x in range(0, pw, patch):
                tile = image_padded[:, y : y + patch, x : x + patch]
                # TF expects (batch, H, W, C)
                tile_hwc = np.transpose(tile, (1, 2, 0)).astype(np.float32)
                tile_max = tile_hwc.max()
                if tile_max > 0:
                    tile_hwc = tile_hwc / tile_max
                inp = tf.constant(tile_hwc[np.newaxis, ...])
                try:
                    pred = self._model(inp)
                    if isinstance(pred, dict):
                        pred = list(pred.values())[0]
                    cls_val = int(tf.argmax(pred, axis=-1).numpy().flat[0])
                except Exception:
                    cls_val = 0
                end_y = min(y + patch, h)
                end_x = min(x + patch, w)
                if y < h and x < w:
                    result[y:end_y, x:end_x] = cls_val % self.NUM_CLASSES

        return result

    # ------------------------------------------------------------------
    def run(self, input_path: Path, output_dir: Path) -> dict[str, Any]:
        """Run LULC classification on all GeoTIFFs in *input_path*."""
        import rasterio

        tifs = _collect_tifs(input_path)
        log.info("LULC -- processing %d file(s)", len(tifs))

        self.load_model()
        all_outputs: list[str] = []
        combined_stats: dict[str, float] = {name: 0.0 for name in LULC_CLASSES.values()}
        total_pixels = 0

        for tif in tifs:
            log.info("Classifying %s ...", tif.name)
            data, profile = _read_bands(tif)

            if self._backend == "torch":
                classified = self._classify_patches_torch(data)
            else:
                classified = self._classify_patches_tf(data)

            # Write classified raster
            out_tif = output_dir / f"lulc_{tif.stem}.tif"
            _write_geotiff(out_tif, classified, profile, dtype="uint8", count=1, nodata=255)
            all_outputs.append(str(out_tif))

            # Per-class pixel counts
            for cls_id, cls_name in LULC_CLASSES.items():
                count = int(np.sum(classified == cls_id))
                combined_stats[cls_name] += count
            total_pixels += classified.size

        # Area statistics
        area_stats = {}
        for cls_name, px_count in combined_stats.items():
            frac = px_count / max(total_pixels, 1)
            area_stats[cls_name] = {
                "pixel_count": int(px_count),
                "fraction": round(frac, 4),
                "percent": round(frac * 100, 2),
            }

        stats_path = output_dir / "lulc_area_statistics.json"
        stats_path.write_text(json.dumps(area_stats, indent=2), encoding="utf-8")
        all_outputs.append(str(stats_path))
        log.info("LULC area statistics: %s", stats_path)

        return {
            "outputs": all_outputs,
            "metrics": {
                "total_pixels": total_pixels,
                "num_files": len(tifs),
                "area_stats": area_stats,
            },
        }


# ===================================================================
# 2. Flood Segmentation (Prithvi)
# ===================================================================
class FloodSegmenter:
    """IBM/NASA Prithvi-EO flood segmentation on Sentinel-2 imagery.

    Expected bands: B02 (Blue), B03 (Green), B04 (Red), B08 (NIR),
    B11 (SWIR1), B12 (SWIR2) -- stacked in a single GeoTIFF or as
    separate band files in a directory.
    """

    MODEL_REPO = "ibm-nasa-geospatial/Prithvi-EO-2.0-300M-TL-Sen1Floods11"
    REQUIRED_BANDS = ["B02", "B03", "B04", "B08", "B11", "B12"]

    def __init__(self, device: str = "cpu"):
        self.device = device
        self._model = None
        self._processor = None

    def check_deps(self) -> bool:
        ok = True
        for mod, pip in [("torch", "torch"), ("transformers", "transformers"),
                         ("rasterio", "rasterio"), ("shapely", "shapely")]:
            if not _check_dependency(mod, pip):
                ok = False
        if not ok:
            log.error(
                "Flood segmentation requires:\n"
                "    pip install torch transformers rasterio shapely\n"
                "    Optional: pip install terratorch"
            )
        return ok

    def load_model(self) -> None:
        """Download and load the Prithvi flood model from HuggingFace."""
        log.info("Loading Prithvi flood model: %s ...", self.MODEL_REPO)

        # Try terratorch first (native Prithvi support)
        try:
            from terratorch.models import PrithviModelFactory

            self._model = PrithviModelFactory.build_model(
                task="segmentation",
                backbone=self.MODEL_REPO,
                num_classes=2,
            )
            log.info("Prithvi model loaded via terratorch.")
            return
        except Exception as exc:
            log.debug("terratorch not available: %s", exc)

        # Fallback: transformers AutoModel
        try:
            import torch
            from transformers import AutoModel, AutoModelForImageSegmentation

            try:
                self._model = AutoModelForImageSegmentation.from_pretrained(
                    self.MODEL_REPO, trust_remote_code=True
                )
            except Exception:
                self._model = AutoModel.from_pretrained(
                    self.MODEL_REPO, trust_remote_code=True
                )
            for param in self._model.parameters():
                param.requires_grad = False
            if self.device != "cpu":
                self._model = _to_device(self._model, self.device)
            log.info("Prithvi model loaded via transformers.")
            return
        except Exception as exc:
            log.warning("HuggingFace model load failed: %s", exc)

        # Final fallback -- simple threshold-based water index
        log.warning(
            "Using NDWI threshold fallback for flood detection "
            "(model download failed). Results will be approximate."
        )
        self._model = "ndwi_fallback"

    def _ndwi_fallback(self, data: np.ndarray) -> np.ndarray:
        """Simple NDWI-based flood mask when ML model unavailable.

        Expects data shape (bands, H, W) with bands in order:
        B02, B03, B04, B08, B11, B12.
        NDWI = (Green - NIR) / (Green + NIR)
        """
        green = data[1].astype(np.float32)  # B03
        nir = data[3].astype(np.float32)    # B08
        denom = green + nir + 1e-8
        ndwi = (green - nir) / denom
        flood_mask = (ndwi > 0.3).astype(np.uint8)
        return flood_mask

    def _model_inference(self, data: np.ndarray) -> np.ndarray:
        """Run Prithvi model inference. data shape (6, H, W)."""
        import torch

        # Normalise bands to [0, 1]
        data_f = data.astype(np.float32)
        for b in range(data_f.shape[0]):
            bmax = data_f[b].max()
            if bmax > 0:
                data_f[b] /= bmax

        tensor = torch.from_numpy(data_f[np.newaxis, ...])
        if self.device == "cuda" and torch.cuda.is_available():
            tensor = tensor.cuda()

        with torch.no_grad():
            try:
                out = self._model(tensor)
                if isinstance(out, dict):
                    logits = out.get("logits", list(out.values())[0])
                else:
                    logits = out
                if logits.ndim == 4:
                    pred = logits.argmax(dim=1).squeeze().cpu().numpy()
                else:
                    pred = (logits.squeeze().cpu().numpy() > 0.5).astype(np.uint8)
            except Exception as exc:
                log.warning("Model inference failed (%s), using NDWI fallback", exc)
                pred = self._ndwi_fallback(data)

        return pred.astype(np.uint8)

    def _load_bands(self, input_path: Path) -> tuple:
        """Load 6-band stack. Returns (data (6,H,W), profile)."""
        import rasterio

        if input_path.is_file():
            data, profile = _read_bands(input_path)
            if data.shape[0] >= 6:
                return data[:6], profile
            log.warning("Expected >=6 bands, got %d. Padding with zeros.", data.shape[0])
            padded = np.zeros((6, data.shape[1], data.shape[2]), dtype=data.dtype)
            padded[: data.shape[0]] = data
            return padded, profile

        # Directory: look for individual band files
        band_files = {}
        for band_name in self.REQUIRED_BANDS:
            candidates = list(input_path.glob(f"*{band_name}*.tif"))
            if candidates:
                band_files[band_name] = candidates[0]
            else:
                log.warning("Band %s not found in %s", band_name, input_path)

        if len(band_files) < 4:
            # Fall back to first multi-band TIF
            tifs = _collect_tifs(input_path)
            return _read_bands(tifs[0])

        # Stack individual bands
        first_band = list(band_files.values())[0]
        with rasterio.open(first_band) as src:
            profile = dict(src.profile)
            h, w = src.height, src.width

        stack = np.zeros((6, h, w), dtype=np.float32)
        for idx, band_name in enumerate(self.REQUIRED_BANDS):
            if band_name in band_files:
                with rasterio.open(band_files[band_name]) as src:
                    stack[idx] = src.read(1).astype(np.float32)

        return stack, profile

    def run(self, input_path: Path, output_dir: Path) -> dict[str, Any]:
        """Run flood segmentation."""
        import rasterio

        self.load_model()

        data, profile = self._load_bands(input_path)
        log.info("Flood -- input shape: %s", data.shape)

        if self._model == "ndwi_fallback":
            flood_mask = self._ndwi_fallback(data)
        else:
            flood_mask = self._model_inference(data)

        # Write flood mask GeoTIFF
        mask_path = output_dir / "flood_mask.tif"
        _write_geotiff(mask_path, flood_mask, profile, dtype="uint8", count=1, nodata=255)

        # Vectorize flood extent
        transform = rasterio.transform.from_bounds(
            BBOX_CITY["west"], BBOX_CITY["south"],
            BBOX_CITY["east"], BBOX_CITY["north"],
            data.shape[2], data.shape[1],
        )
        if "transform" in profile:
            transform = profile["transform"]

        geojson_path = output_dir / "flood_extent.geojson"
        _mask_to_geojson(
            flood_mask, transform, geojson_path,
            properties={"type": "flood_extent"},
        )

        flood_pixels = int(np.sum(flood_mask == 1))
        total_pixels = flood_mask.size
        flood_frac = flood_pixels / max(total_pixels, 1)

        return {
            "outputs": [str(mask_path), str(geojson_path)],
            "metrics": {
                "flood_pixels": flood_pixels,
                "total_pixels": total_pixels,
                "flood_fraction": round(flood_frac, 4),
                "flood_percent": round(flood_frac * 100, 2),
                "method": "ndwi_fallback" if self._model == "ndwi_fallback" else "prithvi",
            },
        }


# ===================================================================
# 3. Building Segmentation (SAM2)
# ===================================================================
class BuildingSegmenter:
    """Building footprint extraction using SAM2 via segment-geospatial.

    Post-processes results to filter by area and simplify polygons.
    """

    MODEL_TYPE = "sam2.1-hiera-small"
    # Area thresholds in square metres
    MIN_AREA_M2 = 10.0
    MAX_AREA_M2 = 5000.0

    def __init__(self, device: str = "cpu"):
        self.device = device

    def check_deps(self) -> bool:
        ok = True
        for mod, pip in [
            ("samgeo", "segment-geospatial"),
            ("torch", "torch torchvision"),
            ("rasterio", "rasterio"),
            ("shapely", "shapely"),
        ]:
            if not _check_dependency(mod, pip):
                ok = False
        if not ok:
            log.error(
                "Building segmentation requires:\n"
                "    pip install segment-geospatial torch torchvision rasterio shapely"
            )
        return ok

    def run(self, input_path: Path, output_dir: Path) -> dict[str, Any]:
        """Run SAM2 building segmentation on a high-res aerial/satellite image."""
        import rasterio
        from shapely.geometry import mapping, shape

        tifs = _collect_tifs(input_path)
        src_tif = tifs[0]
        log.info("Buildings -- processing %s", src_tif.name)

        mask_path = output_dir / "buildings_mask.tif"
        raw_geojson_path = output_dir / "buildings_raw.geojson"
        final_geojson_path = output_dir / "buildings_footprints.geojson"

        # Try segment-geospatial (SAM2)
        try:
            from samgeo import SamGeo2

            sam = SamGeo2(
                model_id=self.MODEL_TYPE,
                device=self.device,
                automatic=True,
            )
            log.info("Running SAM2 automatic segmentation ...")
            sam.generate(str(src_tif), str(mask_path))
            sam.raster_to_vector(str(mask_path), str(raw_geojson_path))
            log.info("SAM2 segmentation complete.")

        except Exception as exc:
            log.warning("SAM2 failed (%s), using threshold-based fallback.", exc)
            data, profile = _read_bands(src_tif)

            # Simple brightness-based building detection fallback
            if data.shape[0] >= 3:
                rgb = data[:3].astype(np.float32)
            else:
                rgb = np.stack([data[0]] * 3).astype(np.float32)

            brightness = rgb.mean(axis=0)
            bmax = brightness.max()
            if bmax > 0:
                brightness /= bmax

            # Buildings tend to be bright, high-contrast pixels
            mask = ((brightness > 0.4) & (brightness < 0.9)).astype(np.uint8)
            _write_geotiff(mask_path, mask, profile, dtype="uint8", count=1)

            transform = profile.get(
                "transform",
                rasterio.transform.from_bounds(
                    BBOX_CITY["west"], BBOX_CITY["south"],
                    BBOX_CITY["east"], BBOX_CITY["north"],
                    data.shape[2], data.shape[1],
                ),
            )
            _mask_to_geojson(mask, transform, raw_geojson_path)

        # Post-process: filter by area, simplify
        log.info("Post-processing building polygons ...")
        raw_data = json.loads(raw_geojson_path.read_text(encoding="utf-8"))
        filtered_features = []

        for feat in raw_data.get("features", []):
            try:
                poly = shape(feat["geometry"])
                area_m2 = poly.area * (111_000 ** 2)  # approximate
                if area_m2 < self.MIN_AREA_M2 or area_m2 > self.MAX_AREA_M2:
                    continue
                simplified = poly.simplify(0.00001, preserve_topology=True)
                if simplified.is_empty:
                    continue
                feat["geometry"] = mapping(simplified)
                feat["properties"]["area_m2"] = round(area_m2, 1)
                filtered_features.append(feat)
            except Exception:
                continue

        final_geojson = {"type": "FeatureCollection", "features": filtered_features}
        final_geojson_path.write_text(
            json.dumps(final_geojson, indent=2), encoding="utf-8"
        )
        log.info(
            "Buildings: %d raw -> %d filtered polygons",
            len(raw_data.get("features", [])),
            len(filtered_features),
        )

        return {
            "outputs": [str(mask_path), str(final_geojson_path)],
            "metrics": {
                "raw_polygons": len(raw_data.get("features", [])),
                "filtered_polygons": len(filtered_features),
                "min_area_m2": self.MIN_AREA_M2,
                "max_area_m2": self.MAX_AREA_M2,
            },
        }


# ===================================================================
# 4. Crowd Counting (YOLOv8n)
# ===================================================================
class CrowdCounter:
    """Person detection and crowd counting using YOLOv8n / YOLO11n.

    Outputs: person count, bounding boxes JSON, density estimate.
    Feeds into the mob simulation module.
    """

    PERSON_CLASS_ID = 0  # COCO class 0 = person
    CONFIDENCE_THRESHOLD = 0.25

    def __init__(self, device: str = "cpu"):
        self.device = device
        self._model = None

    def check_deps(self) -> bool:
        if not _check_dependency("ultralytics", "ultralytics"):
            log.error("Crowd counting requires:\n    pip install ultralytics")
            return False
        return True

    def load_model(self) -> None:
        """Load YOLO model (auto-downloads weights on first run)."""
        from ultralytics import YOLO

        # Try YOLO11n first, fallback to v8n
        for model_name in ["yolo11n.pt", "yolov8n.pt"]:
            try:
                self._model = YOLO(model_name)
                log.info("Loaded model: %s", model_name)
                return
            except Exception as exc:
                log.debug("Could not load %s: %s", model_name, exc)

        # Final fallback
        self._model = YOLO("yolov8n.pt")
        log.info("Loaded YOLOv8n fallback.")

    def run(self, input_path: Path, output_dir: Path) -> dict[str, Any]:
        """Run crowd counting on an image or video frame."""
        import cv2

        self.load_model()

        if not input_path.is_file():
            log.error("Crowd counting expects a single image file, got: %s", input_path)
            sys.exit(1)

        log.info("Crowd -- processing %s", input_path.name)
        img = cv2.imread(str(input_path))
        if img is None:
            log.error("Could not read image: %s", input_path)
            sys.exit(1)

        h, w = img.shape[:2]
        results = self._model(img, device=self.device, conf=self.CONFIDENCE_THRESHOLD)

        persons = []
        for result in results:
            for box in result.boxes:
                cls_id = int(box.cls[0])
                if cls_id != self.PERSON_CLASS_ID:
                    continue
                conf = float(box.conf[0])
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                persons.append({
                    "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    "confidence": round(conf, 3),
                })

        person_count = len(persons)
        # Density: persons per megapixel
        area_px = h * w
        density_per_mpx = (person_count / area_px) * 1_000_000 if area_px > 0 else 0

        # Density classification
        if density_per_mpx > 500:
            density_level = "very_high"
        elif density_per_mpx > 200:
            density_level = "high"
        elif density_per_mpx > 50:
            density_level = "moderate"
        elif density_per_mpx > 10:
            density_level = "low"
        else:
            density_level = "sparse"

        # Save annotated image
        annotated_path = output_dir / f"crowd_annotated_{input_path.stem}.jpg"
        annotated_img = results[0].plot() if results else img
        cv2.imwrite(str(annotated_path), annotated_img)

        # Save detections JSON
        detections = {
            "person_count": person_count,
            "density_per_megapixel": round(density_per_mpx, 1),
            "density_level": density_level,
            "image_size": {"width": w, "height": h},
            "detections": persons,
        }
        det_path = output_dir / f"crowd_detections_{input_path.stem}.json"
        det_path.write_text(json.dumps(detections, indent=2), encoding="utf-8")

        log.info(
            "Crowd: %d persons detected, density=%s (%.1f/Mpx)",
            person_count, density_level, density_per_mpx,
        )

        return {
            "outputs": [str(annotated_path), str(det_path)],
            "metrics": {
                "person_count": person_count,
                "density_per_megapixel": round(density_per_mpx, 1),
                "density_level": density_level,
                "image_width": w,
                "image_height": h,
            },
        }


# ===================================================================
# 5. NDVI Time Series
# ===================================================================
class NDVIAnalyzer:
    """Compute NDVI from Sentinel-2 Red (B04) and NIR (B08) bands.

    No ML model needed -- pure band-ratio computation.
    Produces per-date NDVI rasters and a time-series JSON.
    """

    def __init__(self, device: str = "cpu"):
        self.device = device  # unused, kept for interface consistency

    def check_deps(self) -> bool:
        return _check_dependency("rasterio", "rasterio")

    def _compute_ndvi(self, red: np.ndarray, nir: np.ndarray) -> np.ndarray:
        """Compute NDVI = (NIR - Red) / (NIR + Red). Returns float32 in [-1, 1]."""
        red_f = red.astype(np.float32)
        nir_f = nir.astype(np.float32)
        denom = nir_f + red_f
        ndvi = np.where(denom > 0, (nir_f - red_f) / denom, 0.0)
        return ndvi.astype(np.float32)

    def _extract_date(self, filename: str) -> str:
        """Try to extract a date string from a filename."""
        import re

        # Common Sentinel-2 patterns: 20240115, 2024-01-15, etc.
        patterns = [
            r"(\d{4})(\d{2})(\d{2})",
            r"(\d{4})-(\d{2})-(\d{2})",
            r"(\d{4})_(\d{2})_(\d{2})",
        ]
        for pat in patterns:
            m = re.search(pat, filename)
            if m:
                return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        return filename

    def run(self, input_path: Path, output_dir: Path) -> dict[str, Any]:
        """Compute NDVI for all scenes in input_path."""
        import rasterio

        tifs = _collect_tifs(input_path)
        log.info("NDVI -- processing %d file(s)", len(tifs))

        ndvi_dir = output_dir / "ndvi_series"
        ndvi_dir.mkdir(parents=True, exist_ok=True)

        time_series: list[dict[str, Any]] = []
        all_outputs: list[str] = []

        for tif in tifs:
            data, profile = _read_bands(tif)
            date_str = self._extract_date(tif.stem)

            # Determine Red and NIR bands
            num_bands = data.shape[0]
            if num_bands >= 8:
                # Assume standard Sentinel-2 band ordering: B01..B08..
                red = data[3]  # B04
                nir = data[7]  # B08
            elif num_bands >= 4:
                red = data[2]  # 3rd band = Red
                nir = data[3]  # 4th band = NIR
            elif num_bands == 2:
                red = data[0]
                nir = data[1]
            else:
                log.warning(
                    "Only %d band(s) in %s -- using band 0 for both Red/NIR (NDVI=0)",
                    num_bands, tif.name,
                )
                red = data[0]
                nir = data[0]

            ndvi = self._compute_ndvi(red, nir)

            # Write NDVI raster
            ndvi_path = ndvi_dir / f"ndvi_{tif.stem}.tif"
            _write_geotiff(ndvi_path, ndvi, profile, dtype="float32", count=1, nodata=-9999.0)
            all_outputs.append(str(ndvi_path))

            # Statistics
            valid = ndvi[ndvi > -1.0]
            stats = {
                "date": date_str,
                "file": tif.name,
                "mean": round(float(valid.mean()), 4) if valid.size > 0 else None,
                "median": round(float(np.median(valid)), 4) if valid.size > 0 else None,
                "std": round(float(valid.std()), 4) if valid.size > 0 else None,
                "min": round(float(valid.min()), 4) if valid.size > 0 else None,
                "max": round(float(valid.max()), 4) if valid.size > 0 else None,
                "pct_vegetation": round(
                    float(np.sum(valid > 0.3) / max(valid.size, 1) * 100), 2
                ) if valid.size > 0 else None,
            }
            time_series.append(stats)
            log.info("NDVI %s: mean=%.3f, vegetation=%.1f%%",
                     date_str,
                     stats["mean"] or 0,
                     stats["pct_vegetation"] or 0)

        # Sort by date
        time_series.sort(key=lambda x: x["date"])

        # Trend analysis (linear regression on mean NDVI over time)
        trend = self._compute_trend(time_series)

        result_data = {
            "time_series": time_series,
            "trend": trend,
            "num_scenes": len(tifs),
        }
        ts_path = output_dir / "ndvi_time_series.json"
        ts_path.write_text(json.dumps(result_data, indent=2), encoding="utf-8")
        all_outputs.append(str(ts_path))

        return {
            "outputs": all_outputs,
            "metrics": {
                "num_scenes": len(tifs),
                "trend_direction": trend.get("direction", "unknown"),
                "trend_slope_per_day": trend.get("slope_per_day"),
            },
        }

    def _compute_trend(self, time_series: list[dict]) -> dict[str, Any]:
        """Simple linear trend on mean NDVI values."""
        valid_points = [
            ts for ts in time_series
            if ts["mean"] is not None
        ]
        if len(valid_points) < 2:
            return {"direction": "insufficient_data", "slope_per_day": None}

        # Convert dates to ordinal days
        try:
            from datetime import datetime

            dates = []
            values = []
            for ts in valid_points:
                d = datetime.strptime(ts["date"][:10], "%Y-%m-%d")
                dates.append(d.toordinal())
                values.append(ts["mean"])

            x = np.array(dates, dtype=np.float64)
            y = np.array(values, dtype=np.float64)
            x_centered = x - x.mean()
            denom = np.sum(x_centered ** 2)
            if denom == 0:
                return {"direction": "constant", "slope_per_day": 0.0}
            slope = float(np.sum(x_centered * (y - y.mean())) / denom)
            y_pred = slope * x_centered + y.mean()
            ss_res = float(np.sum((y - y_pred) ** 2))
            ss_tot = float(np.sum((y - y.mean()) ** 2))
            r_sq = 1.0 - ss_res / max(ss_tot, 1e-12)

            if slope > 0.0001:
                direction = "greening"
            elif slope < -0.0001:
                direction = "browning"
            else:
                direction = "stable"

            return {
                "direction": direction,
                "slope_per_day": round(slope, 6),
                "r_squared": round(r_sq, 4),
                "num_points": len(valid_points),
            }
        except Exception as exc:
            log.warning("Trend computation failed: %s", exc)
            return {"direction": "error", "slope_per_day": None, "error": str(exc)}


# ===================================================================
# 6. Change Detection
# ===================================================================
class ChangeDetector:
    """Detect urban/land-cover change between two Sentinel-2 scenes.

    Uses Normalized Difference Built-up Index (NDBI):
        NDBI = (SWIR - NIR) / (SWIR + NIR)
    Change = |NDBI_after - NDBI_before| > threshold
    """

    CHANGE_THRESHOLD = 0.15

    def __init__(self, device: str = "cpu"):
        self.device = device

    def check_deps(self) -> bool:
        ok = True
        for mod, pip in [("rasterio", "rasterio"), ("shapely", "shapely")]:
            if not _check_dependency(mod, pip):
                ok = False
        return ok

    def _compute_ndbi(self, data: np.ndarray) -> np.ndarray:
        """Compute NDBI from a multi-band array.

        Expects bands in Sentinel-2 order. Uses SWIR1 (B11, index 10 in
        13-band or index 4 in 6-band) and NIR (B08, index 7 or 3).
        Falls back to last two bands for 2-band inputs.
        """
        num_bands = data.shape[0]
        if num_bands >= 12:
            swir = data[10].astype(np.float32)  # B11
            nir = data[7].astype(np.float32)     # B08
        elif num_bands >= 6:
            swir = data[4].astype(np.float32)    # 5th band ~ SWIR
            nir = data[3].astype(np.float32)     # 4th band ~ NIR
        elif num_bands >= 4:
            swir = data[3].astype(np.float32)
            nir = data[2].astype(np.float32)
        elif num_bands == 2:
            swir = data[1].astype(np.float32)
            nir = data[0].astype(np.float32)
        else:
            log.warning("Only 1 band -- NDBI will be zero everywhere.")
            return np.zeros(data.shape[1:], dtype=np.float32)

        denom = swir + nir + 1e-8
        ndbi = (swir - nir) / denom
        return ndbi

    def run(
        self,
        before_path: Path,
        after_path: Path,
        output_dir: Path,
    ) -> dict[str, Any]:
        """Run change detection between *before* and *after* scenes."""
        import rasterio

        before_tifs = _collect_tifs(before_path)
        after_tifs = _collect_tifs(after_path)

        before_data, before_profile = _read_bands(before_tifs[0])
        after_data, after_profile = _read_bands(after_tifs[0])

        log.info(
            "Change detection -- before: %s (%s), after: %s (%s)",
            before_tifs[0].name, before_data.shape,
            after_tifs[0].name, after_data.shape,
        )

        # Ensure same spatial dimensions
        min_h = min(before_data.shape[1], after_data.shape[1])
        min_w = min(before_data.shape[2], after_data.shape[2])
        before_data = before_data[:, :min_h, :min_w]
        after_data = after_data[:, :min_h, :min_w]

        ndbi_before = self._compute_ndbi(before_data)
        ndbi_after = self._compute_ndbi(after_data)
        diff = ndbi_after - ndbi_before
        abs_diff = np.abs(diff)

        # Binary change mask
        change_mask = (abs_diff > self.CHANGE_THRESHOLD).astype(np.uint8)

        # Classify direction: 1=new built-up, 2=removed built-up
        change_classified = np.zeros_like(change_mask, dtype=np.uint8)
        change_classified[(change_mask == 1) & (diff > 0)] = 1  # new built-up
        change_classified[(change_mask == 1) & (diff < 0)] = 2  # built-up removed

        # Write outputs
        profile = dict(before_profile)
        profile["height"] = min_h
        profile["width"] = min_w

        mask_path = output_dir / "change_mask.tif"
        _write_geotiff(mask_path, change_classified, profile, dtype="uint8", count=1, nodata=0)

        diff_path = output_dir / "ndbi_difference.tif"
        _write_geotiff(diff_path, diff, profile, dtype="float32", count=1, nodata=-9999.0)

        # Vectorize change areas
        transform = profile.get(
            "transform",
            rasterio.transform.from_bounds(
                BBOX_CITY["west"], BBOX_CITY["south"],
                BBOX_CITY["east"], BBOX_CITY["north"],
                min_w, min_h,
            ),
        )

        geojson_path = output_dir / "change_areas.geojson"
        _mask_to_geojson(
            change_mask, transform, geojson_path,
            min_area_m2=100.0,
            simplify_tolerance=0.0001,
            properties={"threshold": self.CHANGE_THRESHOLD},
        )

        total_px = change_mask.size
        changed_px = int(np.sum(change_mask == 1))
        new_builtup = int(np.sum(change_classified == 1))
        removed_builtup = int(np.sum(change_classified == 2))

        log.info(
            "Change: %.2f%% changed (%d new built-up, %d removed)",
            changed_px / max(total_px, 1) * 100,
            new_builtup,
            removed_builtup,
        )

        return {
            "outputs": [str(mask_path), str(diff_path), str(geojson_path)],
            "metrics": {
                "total_pixels": total_px,
                "changed_pixels": changed_px,
                "change_percent": round(changed_px / max(total_px, 1) * 100, 2),
                "new_builtup_pixels": new_builtup,
                "removed_builtup_pixels": removed_builtup,
                "threshold": self.CHANGE_THRESHOLD,
            },
        }


# ===================================================================
# CLI -- argparse with subcommands
# ===================================================================
def _add_common_args(parser: argparse.ArgumentParser) -> None:
    """Add --device and --output flags shared by all subcommands."""
    parser.add_argument(
        "--device",
        choices=["cpu", "cuda", "directml"],
        default="auto",
        help="Inference device: cpu, cuda, directml, or auto (default: auto-detect)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output directory (default: data/ai_outputs/<task>/)",
    )


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="ai_inference",
        description="DigiPin Digital Twin -- AI Inference Pipeline (Guna)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python ai_inference.py lulc --input data/satellite/sentinel2_guna/\n"
            "  python ai_inference.py flood --input data/satellite/sentinel2_guna/\n"
            "  python ai_inference.py buildings --input data/satellite/aerial_guna.tif\n"
            "  python ai_inference.py crowd --input path/to/image.jpg\n"
            "  python ai_inference.py ndvi --input data/satellite/sentinel2_guna/\n"
            "  python ai_inference.py change --before scene1/ --after scene2/\n"
        ),
    )

    sub = parser.add_subparsers(dest="task", required=True, help="AI task to run")

    # --- lulc ---
    p_lulc = sub.add_parser("lulc", help="LULC classification (Dynamic World / BigEarthNet)")
    p_lulc.add_argument("--input", type=Path, required=True, help="Sentinel-2 GeoTIFF or directory")
    _add_common_args(p_lulc)

    # --- flood ---
    p_flood = sub.add_parser("flood", help="Prithvi flood segmentation")
    p_flood.add_argument("--input", type=Path, required=True, help="Sentinel-2 6-band GeoTIFF or directory")
    _add_common_args(p_flood)

    # --- buildings ---
    p_bldg = sub.add_parser("buildings", help="SAM2 building footprint extraction")
    p_bldg.add_argument("--input", type=Path, required=True, help="High-res aerial/satellite GeoTIFF")
    _add_common_args(p_bldg)

    # --- crowd ---
    p_crowd = sub.add_parser("crowd", help="YOLOv8n crowd counting")
    p_crowd.add_argument("--input", type=Path, required=True, help="CCTV/drone image (JPG/PNG)")
    _add_common_args(p_crowd)

    # --- ndvi ---
    p_ndvi = sub.add_parser("ndvi", help="NDVI time-series analysis")
    p_ndvi.add_argument("--input", type=Path, required=True, help="Directory of Sentinel-2 GeoTIFFs")
    _add_common_args(p_ndvi)

    # --- change ---
    p_change = sub.add_parser("change", help="Change detection via NDBI differencing")
    p_change.add_argument("--before", type=Path, required=True, help="Before scene (GeoTIFF or directory)")
    p_change.add_argument("--after", type=Path, required=True, help="After scene (GeoTIFF or directory)")
    _add_common_args(p_change)

    return parser


# ===================================================================
# Dispatch
# ===================================================================
TASK_REGISTRY: dict[str, type] = {
    "lulc": LULCClassifier,
    "flood": FloodSegmenter,
    "buildings": BuildingSegmenter,
    "crowd": CrowdCounter,
    "ndvi": NDVIAnalyzer,
    "change": ChangeDetector,
}


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    task = args.task
    device = args.device

    # Auto-detect best available device
    if device == "auto":
        import torch
        if torch.cuda.is_available():
            device = "cuda"
        else:
            try:
                import torch_directml
                device = "directml"
            except ImportError:
                device = "cpu"

    log.info("=" * 60)
    log.info("DigiPin AI Inference -- task=%s, device=%s", task, device)
    log.info("=" * 60)

    # Resolve output directory
    output_dir: Path = args.output or (AI_OUTPUT_DIR / task)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Instantiate task handler
    handler_cls = TASK_REGISTRY[task]
    handler = handler_cls(device=device)

    # Dependency check
    if not handler.check_deps():
        log.error("Missing dependencies -- aborting.")
        sys.exit(1)

    # Run
    t0 = time.perf_counter()

    if task == "change":
        result = handler.run(args.before, args.after, output_dir)
        input_files = [str(args.before), str(args.after)]
    else:
        result = handler.run(args.input, output_dir)
        input_files = [str(args.input)]

    elapsed = time.perf_counter() - t0

    # Write summary
    model_name = getattr(handler, "MODEL_REPO", None) or getattr(handler, "MODEL_TYPE", task)
    _write_summary(
        output_dir,
        task,
        metrics=result.get("metrics", {}),
        inputs=input_files,
        outputs=result.get("outputs", []),
        model=str(model_name),
        device=device,
        elapsed_s=elapsed,
    )

    log.info("Completed in %.1f s. Outputs in %s", elapsed, output_dir)


if __name__ == "__main__":
    main()
