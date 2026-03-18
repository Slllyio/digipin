# Pre-trained Models Catalog for Guna Digital Twin

Comprehensive catalog of downloadable pre-trained models for urban analysis.
Last updated: 2026-03-18

---

## A. Foundation Models for Remote Sensing

### A1. IBM-NASA Prithvi EO 2.0 (300M)

| Field | Details |
|-------|---------|
| **Model ID** | `ibm-nasa-geospatial/Prithvi-EO-2.0-300M` |
| **Download** | https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-300M |
| **Size** | ~1.2 GB (300M params) |
| **Input** | 6-band GeoTIFF: Blue, Green, Red, Narrow NIR, SWIR1, SWIR2 (NASA HLS V2, 30m) |
| **Output** | Feature embeddings; fine-tune for segmentation, classification, regression |
| **License** | Apache 2.0 |
| **Hardware** | GPU recommended (8GB+ VRAM); runs on T4 |
| **Relevance** | Foundation model for ALL downstream tasks: LULC, flood, crop, change detection over Guna |

```python
from terratorch.registry import BACKBONE_REGISTRY
model = BACKBONE_REGISTRY.build("prithvi_eo_v2_300m", pretrained=True)
```

### A2. IBM-NASA Prithvi EO 2.0 (600M)

| Field | Details |
|-------|---------|
| **Model ID** | `ibm-nasa-geospatial/Prithvi-EO-2.0-600M` |
| **Download** | https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-600M |
| **Size** | ~2.4 GB (600M params) |
| **Input** | Same as 300M (6-band HLS GeoTIFF) |
| **Output** | Higher-capacity embeddings for fine-tuning |
| **License** | Apache 2.0 |
| **Hardware** | GPU 16GB+ VRAM recommended |
| **Relevance** | Higher accuracy version when compute is available |

### A3. IBM-NASA Prithvi EO 2.0 Tiny (Transfer Learning)

| Field | Details |
|-------|---------|
| **Model ID** | `ibm-nasa-geospatial/Prithvi-EO-2.0-tiny-TL` |
| **Download** | https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-tiny-TL |
| **Size** | ~200 MB (estimated, tiny variant) |
| **Input** | 6-band GeoTIFF (HLS) |
| **Output** | Embeddings for transfer learning |
| **License** | Apache 2.0 |
| **Hardware** | Laptop GPU (4GB VRAM) or even CPU |
| **Relevance** | Lightweight option for rapid prototyping on Guna data |

### A4. Clay Foundation Model

| Field | Details |
|-------|---------|
| **Model ID** | `made-with-clay/Clay` |
| **Download** | https://huggingface.co/made-with-clay/Clay |
| **Size** | ~800 MB (estimated, MAE architecture) |
| **Input** | Sentinel-1 (SAR) and Sentinel-2 (multispectral) imagery |
| **Output** | Geospatial embeddings for any location; fine-tune for classification/segmentation |
| **License** | Apache 2.0 (code), CC-BY-4.0 (docs) |
| **Hardware** | CUDA GPU required (tested on Linux) |
| **Relevance** | Multi-sensor foundation model; can combine optical + SAR for monsoon/cloud-covered periods in Guna |

```python
pip install git+https://github.com/Clay-foundation/model.git
python trainer.py fit --model ClayMAEModule --data ClayDataModule --config configs/config.yaml
```

### A5. SatlasPretrain (Allen AI) - Sentinel-2 Swin-v2-Base

| Field | Details |
|-------|---------|
| **Model ID** | `allenai/satlas-pretrain` |
| **Download (S2 RGB)** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/sentinel2_swinb_si_rgb.pth |
| **Download (S2 Multispectral)** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/sentinel2_swinb_si_ms.pth |
| **Download (S1 SAR)** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/sentinel1_swinb_si.pth |
| **Download (Landsat)** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/landsat_swinb_si.pth |
| **Size** | ~350 MB per Swin-B model |
| **Input** | Sentinel-2 RGB (3ch) or 9-band multispectral, normalized 0-1 |
| **Output** | Multi-scale feature maps; fine-tune for detection, segmentation, regression |
| **License** | ODC-BY (Open Data Commons Attribution) |
| **Hardware** | GPU 8GB+ VRAM |
| **Relevance** | Pre-trained on satellite data; supports solar farm, tree cover, building detection tasks |

```python
import torch, torchvision
model = torchvision.models.swin_transformer.swin_v2_b()
state = torch.load('sentinel2_swinb_si_rgb.pth')
swin_prefix = 'backbone.backbone.'
swin_state = {k[len(swin_prefix):]: v for k, v in state.items() if k.startswith(swin_prefix)}
model.load_state_dict(swin_state)
```

### A6. SatlasPretrain - Tiny Variants (Edge-friendly)

| Field | Details |
|-------|---------|
| **Download (S2 Tiny RGB)** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/sentinel2_swint_si_rgb.pth |
| **Download (S2 Tiny MS)** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/sentinel2_swint_si_ms.pth |
| **Size** | ~110 MB per Swin-T model |
| **License** | ODC-BY |
| **Hardware** | Laptop GPU (4GB) or high-end CPU |
| **Relevance** | Lightweight backbone for resource-constrained Guna deployment |

### A7. SatlasPretrain - ResNet Variants

| Field | Details |
|-------|---------|
| **Download (S2 ResNet50 RGB)** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/sentinel2_resnet50_si_rgb.pth |
| **Download (S2 ResNet152 RGB)** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/sentinel2_resnet152_si_rgb.pth |
| **Size** | ~100 MB (ResNet50), ~230 MB (ResNet152) |
| **License** | ODC-BY |
| **Relevance** | Classic CNN backbones; easier to fine-tune, more tutorials available |

---

## B. Building Detection & Segmentation

### B1. Google Open Buildings (v3)

| Field | Details |
|-------|---------|
| **Data Source** | https://sites.research.google/open-buildings/ |
| **Download** | Dataset links CSV: `https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv` |
| **Format** | Line-delimited GeoJSON (.csv.gz), partitioned by country-quadkey |
| **Coverage** | India: 128M building footprints + 3.5M height estimates |
| **License** | CC-BY-4.0 or ODbL (dual license) |
| **Relevance** | PRE-COMPUTED building footprints for Guna; no model needed, just download data |
| **Note** | Underlying model is NOT downloadable; data is the deliverable |

### B2. Microsoft Global ML Building Footprints

| Field | Details |
|-------|---------|
| **Data Source** | https://github.com/microsoft/GlobalMLBuildingFootprints |
| **Download** | Via dataset-links.csv at Azure endpoint |
| **Format** | Line-delimited GeoJSON (.csv.gz) |
| **Coverage** | India: 128M footprints with height estimates |
| **License** | CDLA Permissive 2.0 |
| **Method** | Semantic segmentation + polygonization from satellite imagery |
| **Relevance** | Alternative building footprint source for Guna; compare with Google for validation |

### B3. Segment Anything Model (SAM) via SamGeo

| Field | Details |
|-------|---------|
| **Model** | `facebook/sam-vit-base` (93.7M params, ~375 MB) |
| **Small variant** | `facebook/sam2.1-hiera-small` (46.1M params, ~185 MB) |
| **Download** | https://huggingface.co/facebook/sam-vit-base |
| **Input** | RGB images (any resolution) |
| **Output** | Instance segmentation masks for any object |
| **License** | Apache 2.0 |
| **Hardware** | GPU 8GB+ VRAM recommended |
| **Relevance** | Segment buildings, roads, water bodies from satellite/drone imagery of Guna |

```python
# Using samgeo for geospatial workflow
pip install "segment-geospatial[samgeo3]"

from samgeo import SamGeo
sam = SamGeo(model_type="vit_b")
sam.generate("satellite_image.tif", output="masks.tif")
sam.tiff_to_vector("masks.tif", "buildings.shp")
```

### B4. MIT Scene Parsing (UPerNet + HRNet)

| Field | Details |
|-------|---------|
| **Download** | http://sceneparsing.csail.mit.edu/model/pytorch |
| **Architectures** | ResNet50-PPM, ResNet101-UPerNet, HRNetV2-W48, MobileNetV2 |
| **Input** | RGB images, normalized, any resolution |
| **Output** | 150-class semantic segmentation (includes buildings, roads, trees, water) |
| **License** | BSD 3-Clause |
| **Hardware** | GPU 4GB+ (MobileNet variant runs on CPU) |
| **Relevance** | Scene understanding for drone/street-level imagery of Guna; segments buildings, roads, vegetation, sky |

```python
python3 test.py --imgs path/to/image.jpg --gpu 0 --cfg config/ade20k-resnet50dilated-ppm_deepsup.yaml
```

---

## C. Road Detection & Quality

### C1. Road Damage Detector (RDD2022)

| Field | Details |
|-------|---------|
| **Source** | https://github.com/sekilab/RoadDamageDetector |
| **Models** | ResNet (128 MB), MobileNet (18 MB) |
| **Input** | RGB photos (.jpg), road surface images from dashcam/smartphone |
| **Output** | Bounding boxes for: D00 (longitudinal crack), D10 (transverse crack), D20 (alligator crack), D40 (pothole) |
| **License** | Check repository LICENSE file |
| **Dataset** | Includes India data (6 countries: Japan, India, Czech, Norway, US, China) |
| **Hardware** | MobileNet variant runs on smartphone; ResNet needs laptop GPU |
| **Relevance** | Road damage assessment for Guna roads; trained on Indian road data |

### C2. CRESI (City-scale Road Extraction from Satellite Imagery)

| Field | Details |
|-------|---------|
| **Source** | https://github.com/avanetten/cresi |
| **Input** | SpaceNet satellite imagery or Google satellite + OSM labels |
| **Output** | Geo-referenced road network graphs (NetworkX) with speed estimates |
| **License** | Apache 2.0 |
| **Hardware** | GPU required; Docker-based pipeline |
| **Relevance** | Extract routable road network for Guna from satellite imagery; estimates travel times |

### C3. Road Network Classification (ResNet-34)

| Field | Details |
|-------|---------|
| **Source** | https://github.com/ualsg/Road-Network-Classification |
| **Architecture** | ResNet-34 |
| **Task** | Classify road network patterns |
| **Relevance** | Classify Guna's road network structure (grid, organic, radial) |

---

## D. Land Use / Land Cover (LULC)

### D1. Prithvi EO 2.0 - Multi-temporal Crop Classification

| Field | Details |
|-------|---------|
| **Model ID** | `ibm-nasa-geospatial/Prithvi-EO-1.0-100M-multi-temporal-crop-classification` |
| **Download** | https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-1.0-100M-multi-temporal-crop-classification |
| **Size** | ~400 MB (100M params) |
| **Input** | Multi-temporal 6-band HLS GeoTIFF |
| **Output** | Crop type classification |
| **License** | Apache 2.0 |
| **Relevance** | Classify agricultural land around Guna (major agricultural district in MP) |

### D2. Dynamic World (Google + WRI)

| Field | Details |
|-------|---------|
| **Source** | https://github.com/google/dynamicworld |
| **Model** | TensorFlow SavedModel (downloadable from repo `./model/forward` and `./model/backward`) |
| **Input** | Sentinel-2 imagery |
| **Output** | 9 classes: Water, Trees, Grass, Crops, Shrub/Scrub, Flooded Vegetation, Built-Up, Bare Ground, Snow/Ice |
| **Resolution** | 10m |
| **License** | Apache 2.0 |
| **Hardware** | Can run locally via Jupyter notebook |
| **Relevance** | Near real-time LULC for Guna at 10m resolution; built-up area detection, crop vs. urban boundary |

```python
# See single_image_runner.ipynb in the repo for local inference
```

### D3. CLIP-ViT EuroSAT (Land Cover Classification)

| Field | Details |
|-------|---------|
| **Model ID** | `tanganke/clip-vit-base-patch32_eurosat` |
| **Download** | https://huggingface.co/tanganke/clip-vit-base-patch32_eurosat |
| **Size** | 87.5M params (~350 MB) |
| **Input** | 224x224 RGB satellite images |
| **Output** | 10 EuroSAT classes: AnnualCrop, Forest, HerbaceousVeg, Highway, Industrial, Pasture, PermanentCrop, Residential, River, SeaLake |
| **License** | Not specified (CLIP base is MIT) |
| **Downloads** | 12.1k/month |
| **Hardware** | Laptop CPU/GPU |
| **Relevance** | Quick land-use classification tiles over Guna; zero-shot with text prompts possible |

```python
from transformers import CLIPVisionModel
vision_model = CLIPVisionModel.from_pretrained('tanganke/clip-vit-base-patch32_eurosat')
```

### D4. BigEarthNet v2 ResNet50 (Sentinel-2)

| Field | Details |
|-------|---------|
| **Model ID** | `BIFOLD-BigEarthNetv2-0/resnet50-s2-v0.2.0` |
| **Download** | https://huggingface.co/BIFOLD-BigEarthNetv2-0/resnet50-s2-v0.2.0 |
| **Size** | ~100 MB (ResNet50) |
| **Input** | Sentinel-2 multispectral bands |
| **Output** | Multi-label land cover classification (19 CLC classes) |
| **License** | MIT |
| **Performance** | mAP@macro: 0.714, F1@micro: 0.765 |
| **Hardware** | Laptop GPU or CPU |
| **Relevance** | Multi-label LULC from free Sentinel-2 data over Guna |

```python
from reben_publication.BigEarthNetv2_0_ImageClassifier import BigEarthNetv2_0_ImageClassifier
model = BigEarthNetv2_0_ImageClassifier.from_pretrained("BIFOLD-BigEarthNetv2-0/resnet50-s2-v0.2.0")
```

### D5. BigEarthNet ViT (Sentinel-1 SAR)

| Field | Details |
|-------|---------|
| **Model ID** | `BIFOLD-BigEarthNetv2-0/vit_base_patch8_224-s1-v0.2.0` |
| **Download** | https://huggingface.co/BIFOLD-BigEarthNetv2-0/vit_base_patch8_224-s1-v0.2.0 |
| **Input** | Sentinel-1 SAR imagery (works through clouds/monsoon) |
| **Output** | Multi-label land cover classification |
| **License** | MIT |
| **Relevance** | LULC during monsoon season when optical imagery is cloud-covered |

### D6. SegFormer B0 (ADE20K Scene Segmentation)

| Field | Details |
|-------|---------|
| **Model ID** | `nvidia/segformer-b0-finetuned-ade-512-512` |
| **Download** | https://huggingface.co/nvidia/segformer-b0-finetuned-ade-512-512 |
| **Size** | 3.75M params (~15 MB) |
| **Input** | 512x512 RGB images |
| **Output** | 150-class semantic segmentation (buildings, roads, trees, water, vehicles, etc.) |
| **License** | Check SegFormer LICENSE (NVIDIA) |
| **Downloads** | 510k/month |
| **Hardware** | Laptop CPU (tiny model!) |
| **Relevance** | Ultra-lightweight scene segmentation for drone/street-view imagery of Guna |

```python
from transformers import SegformerImageProcessor, SegformerForSemanticSegmentation
processor = SegformerImageProcessor.from_pretrained("nvidia/segformer-b0-finetuned-ade-512-512")
model = SegformerForSemanticSegmentation.from_pretrained("nvidia/segformer-b0-finetuned-ade-512-512")
inputs = processor(images=image, return_tensors="pt")
outputs = model(**inputs)
# outputs.logits shape: (batch, 150, H/4, W/4)
```

---

## E. Change Detection

### E1. Remote Sensing Change Detection (RSCD) Models

| Field | Details |
|-------|---------|
| **Model IDs** | `InPeerReview/RemoteSensingChangeDetection-RSCD.CTTF`, `.STNR`, `.HA2F` |
| **Download** | https://huggingface.co/InPeerReview/RemoteSensingChangeDetection-RSCD.CTTF |
| **Input** | Bi-temporal satellite image pairs |
| **Output** | Binary change mask |
| **Relevance** | Detect construction, demolition, urban expansion in Guna over time |

### E2. SatlasPretrain Multi-Image Temporal Models

| Field | Details |
|-------|---------|
| **Download** | https://huggingface.co/allenai/satlas-pretrain/resolve/main/sentinel2_swinb_mi_rgb.pth |
| **Size** | ~350 MB |
| **Input** | Multiple temporal Sentinel-2 images (same location, different dates) |
| **Output** | Temporal feature maps for change detection |
| **License** | ODC-BY |
| **Relevance** | Foundation backbone for training change detection over Guna |

---

## F. Flood Detection & Water

### F1. Prithvi EO 2.0 - Flood Segmentation (Sen1Floods11)

| Field | Details |
|-------|---------|
| **Model ID** | `ibm-nasa-geospatial/Prithvi-EO-2.0-300M-TL-Sen1Floods11` |
| **Download** | https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-300M-TL-Sen1Floods11 |
| **Size** | ~1.2 GB |
| **Input** | 6-band HLS GeoTIFF (temporal sequence) |
| **Output** | Binary flood extent segmentation mask |
| **License** | Apache 2.0 |
| **Downloads** | 2.6k |
| **Relevance** | Flood mapping for Guna during monsoon; direct integration with existing flood analysis module |

### F2. ML4Floods (U-Net models)

| Field | Details |
|-------|---------|
| **Model ID** | `isp-uv-es/ml4floods` |
| **Download** | https://huggingface.co/isp-uv-es/ml4floods |
| **Models** | 3 variants: full multispectral, S2-to-L8 bands, RGBNIR |
| **Architecture** | U-Net multioutput |
| **Input** | Sentinel-2 or Landsat imagery |
| **Output** | Binary flood extent mask |
| **License** | CC BY-NC 4.0 (non-commercial) |
| **Relevance** | Cloud-aware flood detection; handles cloud cover during Guna monsoon |

```python
pip install ml4floods
# See: https://spaceml-org.github.io/ml4floods/content/ml4ops/HOWTO_Run_Inference_multioutput_binary.html
```

### F3. Prithvi EO - Burn Scar Detection

| Field | Details |
|-------|---------|
| **Model ID** | `ibm-nasa-geospatial/Prithvi-EO-2.0-300M-BurnScars` |
| **Download** | https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-300M-BurnScars |
| **Input** | 6-band HLS GeoTIFF |
| **Output** | Burn scar extent mask |
| **License** | Apache 2.0 |
| **Relevance** | Detect fire-affected areas around Guna (agricultural burning, forest fires in MP) |

---

## G. Vegetation & Tree Detection

### G1. DeepForest (Tree Crown Detection)

| Field | Details |
|-------|---------|
| **Source** | https://github.com/weecology/DeepForest |
| **Install** | `pip install deepforest` |
| **Models** | Tree crown detection, Bird detection (pre-built) |
| **Architecture** | RetinaNet (PyTorch torchvision) |
| **Input** | RGB aerial imagery (any resolution, best at 0.1-1m/pixel) |
| **Output** | Bounding boxes for individual tree crowns |
| **License** | MIT |
| **Hardware** | GPU recommended, works on CPU |
| **Relevance** | Count and locate trees in Guna for urban canopy assessment, green cover mapping |

```python
from deepforest import main
model = main.deepforest()
model.use_release()  # downloads pre-trained weights
predictions = model.predict_image(path="aerial_image.png")
```

### G2. SatlasPretrain for Tree Cover

SatlasPretrain backbone models (see A5) were specifically pre-trained on tree cover mapping as one of their tasks. Fine-tune the Swin-B backbone on labeled tree cover data for Guna.

---

## H. Crowd & People Detection

### H1. iRail Crowd Counting (YOLOv8n)

| Field | Details |
|-------|---------|
| **Model ID** | `AmineSam/irail-crowd-counting-yolov8n` |
| **Download** | https://huggingface.co/AmineSam/irail-crowd-counting-yolov8n |
| **Size** | ~6 MB (YOLOv8 nano) |
| **Input** | RGB images, 832px |
| **Output** | Head bounding boxes; count = crowd density |
| **License** | CC BY-SA 4.0 |
| **Performance** | mAP@0.50: 0.881, MAE: 4.67 |
| **Hardware** | Runs on CPU, smartphone, edge device |
| **Relevance** | Crowd counting at Guna events, markets, railway station; feeds mob simulation |

### H2. YOLO26 Detection Models (Ultralytics)

| Field | Details |
|-------|---------|
| **Source** | https://github.com/ultralytics/ultralytics |
| **Models** | YOLO26n (2.4MB), YOLO26s (9.5MB), YOLO26m (20.4MB), YOLO26l (24.8MB), YOLO26x (55.7MB) |
| **Input** | 640px RGB images |
| **Output** | 80 COCO classes: person, car, truck, bus, motorcycle, bicycle, etc. |
| **License** | AGPL-3.0 (open source) / Enterprise (commercial) |
| **Hardware** | Nano/Small run on edge devices and smartphones |
| **Relevance** | Person + vehicle detection from CCTV/drone for traffic analysis and crowd monitoring in Guna |

```python
from ultralytics import YOLO
model = YOLO("yolo26n.pt")  # auto-downloads
results = model.predict("image.jpg")
```

### H3. YOLO26 Segmentation Models

| Field | Details |
|-------|---------|
| **Models** | YOLO26n-seg (2.7MB) to YOLO26x-seg (62.8MB) |
| **Output** | Instance segmentation masks + class labels |
| **Relevance** | Segment individual people/vehicles from drone imagery over Guna |

### H4. YOLO26 Pose Estimation Models

| Field | Details |
|-------|---------|
| **Models** | YOLO26n-pose to YOLO26x-pose |
| **Input** | 640px RGB |
| **Output** | Human pose keypoints (17 COCO keypoints) |
| **Relevance** | Activity recognition in public spaces |

### H5. CSRNet Crowd Counting

| Field | Details |
|-------|---------|
| **Source** | Multiple HuggingFace repos (e.g., `avanish07/crowd_count_CSRNet`) |
| **Architecture** | VGG-16 frontend + dilated convolution backend |
| **Input** | RGB images (any size) |
| **Output** | Density map; sum = estimated count |
| **License** | Varies by repo |
| **Relevance** | Dense crowd estimation at gatherings, melas, religious events in Guna |

---

## I. TorchGeo Pre-trained Weights (Multi-sensor)

TorchGeo provides a comprehensive weight registry. Key weights relevant to Guna:

### I1. TorchGeo Sentinel-2 ResNet (MoCo/SimCLR)

| Field | Details |
|-------|---------|
| **Install** | `pip install torchgeo` |
| **Weights** | `ResNet18_Weights.SENTINEL2_ALL_MOCO`, `ResNet50_Weights.SENTINEL2_ALL_MOCO` |
| **Input** | Sentinel-2 all bands (13 channels) |
| **License** | MIT |
| **Relevance** | Pre-trained backbone; fine-tune for any Sentinel-2 task over Guna |

```python
import timm
from torchgeo.models import ResNet18_Weights
weights = ResNet18_Weights.SENTINEL2_ALL_MOCO
model = timm.create_model("resnet18", in_chans=weights.meta["in_chans"], num_classes=10)
model.load_state_dict(weights.get_state_dict(progress=True), strict=False)
```

### I2. TorchGeo Sensor-Agnostic Foundation Models

| Model | Architecture | Key Feature |
|-------|-------------|-------------|
| Copernicus-FM | ViT | Explicit spatial/temporal/spectral |
| CROMA | ViT (Base, Large) | Multi-sensor implicit support |
| DOFA | MAE (Base16, Large16) | Explicit spectral flexibility |
| Panopticon | ViT | Multi-sensor |
| Scale-MAE | ViT-Large16 | Explicit spatial scaling |

All loadable via `torchgeo.models` API with `get_model()` and `get_weight()` functions.

### I3. TorchGeo Sentinel-1 SAR Weights

| Field | Details |
|-------|---------|
| **Architectures** | ResNet50, ViT-Small/Base/Large, Swin V2-B |
| **Training** | CLOSP, DeCUR, MoCo, SoftCon, MAE, FGMAE |
| **Input** | 2-channel SAR (VH, VV) |
| **Relevance** | SAR works through clouds; critical for monsoon-season analysis of Guna |

### I4. TorchGeo Aerial/Urban Weights

| Field | Details |
|-------|---------|
| **Weights** | Swin-T/S/B on Cityscapes; U-Net on OpenAerialMap |
| **Input** | 3-channel RGB aerial imagery |
| **Task** | Urban semantic segmentation |
| **Relevance** | Segment urban features from drone imagery of Guna |

---

## J. Small / Edge / Browser Models

### J1. SegFormer B0 (~15 MB)
See D6 above. Runs on CPU, 3.75M params.

### J2. YOLO26n Detection (2.4 MB)
See H2 above. Smallest YOLO; runs on smartphones.

### J3. RDD MobileNet (18 MB)
See C1 above. Road damage detection on smartphones.

### J4. SatlasPretrain Swin-Tiny (~110 MB)
See A6 above. Lightweight satellite backbone.

### J5. ONNX Sentinel-2 Segmentation

| Field | Details |
|-------|---------|
| **Model ID** | `ivanalkhayat/sentinel2-unet-segmentation-onnx` |
| **Download** | https://huggingface.co/ivanalkhayat/sentinel2-unet-segmentation-onnx |
| **Format** | ONNX (browser/edge compatible via ONNX.js or onnxruntime-web) |
| **Input** | Sentinel-2 imagery |
| **Output** | Segmentation mask |
| **Relevance** | Can run in browser for the DigiPin web application |

### J6. YOLOv8n Crowd Counter (~6 MB)
See H1 above. Runs on edge devices.

---

## K. Data Sources (Pre-computed, No Model Needed)

### K1. Google Open Buildings v3
- 128M buildings in India with height estimates
- Download: https://sites.research.google/open-buildings/
- License: CC-BY-4.0 / ODbL
- Filter by Guna district coordinates

### K2. Microsoft Global ML Building Footprints
- 128M buildings in India
- Download: https://github.com/microsoft/GlobalMLBuildingFootprints
- License: CDLA Permissive 2.0

### K3. Dynamic World (via Google Earth Engine)
- 10m LULC classification, 9 classes, near real-time
- Access via Earth Engine: `ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")`
- Also downloadable model: https://github.com/google/dynamicworld

---

## Summary Table

| # | Model | Size | Task | Input | License | Edge? |
|---|-------|------|------|-------|---------|-------|
| A1 | Prithvi EO 2.0 300M | 1.2GB | Foundation | 6-band HLS | Apache 2.0 | No |
| A2 | Prithvi EO 2.0 600M | 2.4GB | Foundation | 6-band HLS | Apache 2.0 | No |
| A3 | Prithvi EO 2.0 Tiny | ~200MB | Foundation | 6-band HLS | Apache 2.0 | Maybe |
| A4 | Clay Foundation | ~800MB | Foundation | S1+S2 | Apache 2.0 | No |
| A5 | SatlasPretrain Swin-B | ~350MB | Foundation | S2 RGB/MS | ODC-BY | No |
| A6 | SatlasPretrain Swin-T | ~110MB | Foundation | S2 RGB/MS | ODC-BY | Maybe |
| A7 | SatlasPretrain ResNet | 100-230MB | Foundation | S2 RGB | ODC-BY | Maybe |
| B1 | Google Open Buildings | Data only | Buildings | N/A | CC-BY-4.0 | N/A |
| B2 | MS Building Footprints | Data only | Buildings | N/A | CDLA P2.0 | N/A |
| B3 | SAM ViT-Base | 375MB | Segmentation | RGB | Apache 2.0 | No |
| B3b | SAM2.1 Hiera-Small | 185MB | Segmentation | RGB | Apache 2.0 | No |
| B4 | MIT Scene Parsing | 50-200MB | Scene Seg | RGB | BSD 3-Clause | Maybe |
| C1 | RDD2022 MobileNet | 18MB | Road Damage | RGB photo | Check repo | Yes |
| C1b | RDD2022 ResNet | 128MB | Road Damage | RGB photo | Check repo | No |
| C2 | CRESI | Varies | Road Network | Satellite | Apache 2.0 | No |
| D1 | Prithvi Crop Class. | 400MB | Crop LULC | 6-band HLS | Apache 2.0 | No |
| D2 | Dynamic World | ~50MB | 9-class LULC | Sentinel-2 | Apache 2.0 | Maybe |
| D3 | CLIP-ViT EuroSAT | 350MB | Land Cover | 224px RGB | MIT-ish | No |
| D4 | BigEarthNet ResNet50 | 100MB | LULC Multi-label | S2 bands | MIT | Maybe |
| D5 | BigEarthNet ViT S1 | 350MB | LULC (SAR) | S1 SAR | MIT | No |
| D6 | SegFormer B0 | 15MB | Scene Seg 150cls | 512px RGB | NVIDIA | Yes |
| E1 | RSCD Change Detection | Varies | Change Det. | Bi-temporal | Check | No |
| E2 | SatlasPretrain MI | 350MB | Temporal | Multi-date S2 | ODC-BY | No |
| F1 | Prithvi Flood | 1.2GB | Flood Seg | 6-band HLS | Apache 2.0 | No |
| F2 | ML4Floods UNet | ~200MB | Flood Seg | S2/Landsat | CC BY-NC 4.0 | No |
| F3 | Prithvi Burn Scar | 1.2GB | Burn Scar | 6-band HLS | Apache 2.0 | No |
| G1 | DeepForest | ~100MB | Tree Detection | RGB aerial | MIT | Maybe |
| H1 | YOLOv8n Crowd | 6MB | Head Detection | 832px RGB | CC BY-SA 4.0 | Yes |
| H2 | YOLO26n | 2.4MB | Object Detection | 640px RGB | AGPL-3.0 | Yes |
| H3 | YOLO26n-seg | 2.7MB | Instance Seg | 640px RGB | AGPL-3.0 | Yes |
| H4 | YOLO26n-pose | ~3MB | Pose Estimation | 640px RGB | AGPL-3.0 | Yes |
| J5 | ONNX S2 UNet | ~50MB | S2 Seg | Sentinel-2 | Check | Yes |

**Total: 30+ distinct downloadable models/data sources across 8 categories.**

---

## Recommended Priority for Guna Digital Twin

### Tier 1 (Use Immediately - Data Downloads)
1. **Google Open Buildings** - Building footprints for Guna (free, pre-computed)
2. **Microsoft Building Footprints** - Cross-validate with Google
3. **Dynamic World** - LULC classification via Earth Engine

### Tier 2 (Quick Wins - Small Models)
4. **SegFormer B0** (15MB) - Scene segmentation from drone/street imagery
5. **YOLO26n** (2.4MB) - Person/vehicle detection from CCTV
6. **RDD2022 MobileNet** (18MB) - Road damage from smartphone photos
7. **DeepForest** - Tree crown counting from aerial imagery
8. **YOLOv8n Crowd** (6MB) - Crowd counting at events

### Tier 3 (Fine-tune for Guna-specific Tasks)
9. **Prithvi EO 2.0 300M** - Foundation model for all remote sensing tasks
10. **BigEarthNet ResNet50** - LULC from free Sentinel-2 data
11. **SatlasPretrain Swin-T** - Lightweight satellite backbone
12. **ML4Floods** - Monsoon flood detection
13. **Prithvi Flood (Sen1Floods11)** - Flood extent mapping

### Tier 4 (Advanced / Research)
14. **Clay Foundation** - Multi-sensor (SAR + optical) analysis
15. **SatlasPretrain Swin-B** - High-capacity backbone
16. **SAM/SamGeo** - Interactive segmentation of any feature
17. **CRESI** - Full road network extraction
