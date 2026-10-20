"""Offline tests for the Earth Engine / Planetary Computer catalog index."""
from pipeline.catalogs.fetch_cloud_catalogs import build, coverage, intersects, parse_bbox

GEE = (
    "id\ttitle\ttype\tsnippet\tprovider\tstate_date\tend_date\tbbox\tdeprecated\tcategory\tkeywords\tcatalog\turl\tlicense\n"
    "ESA/WorldCover/v200\tESA WorldCover 10m v200\timage_collection\tee.ImageCollection('ESA/WorldCover/v200')\tESA\t2021-01-01\t2022-01-01\t-180, -60, 180, 84\tFalse\tlanduse-landcover\tesa, landcover, sentinel1-derived\tx\thttps://developers.google.com/earth-engine/datasets/catalog/ESA_WorldCover_v200\tCC-BY-4.0\n"
    "OLD/thing\tOld thing\timage\tee.Image('OLD/thing')\tX\t2000-01-01\t2001-01-01\t-180, -90, 180, 90\tTrue\tclimate\told\tx\thttps://example.org/old\tother\n"
    "AAFC/ACI\tCanada crops\timage_collection\tee.ImageCollection('AAFC/ACI')\tAAFC\t2009-01-01\t2025-01-01\t-135.17, 36.83, -51.24, 62.25\tFalse\tagriculture\tcanada, crop\tx\thttps://developers.google.com/earth-engine/datasets/catalog/AAFC_ACI\tOGL\n"
)
PC = (
    "title\tid\tdescription\tbbox\tstart_date\tend_date\tgroup_id\tcontainer\tstorage_account\tkeywords\tproviders\tlicense\tlink\tvariables\tdimensions\tassets\n"
    "10m Annual LULC\tio-lulc-9-class\td\t-180, -90, 180, 90\t2017-01-01\t2023-01-01\t\t\t\tGlobal, Land Cover\tEsri, Impact Observatory\tCC-BY-4.0\thttps://planetarycomputer.microsoft.com/api/stac/v1/collections/io-lulc-9-class\t\t\tdata\n"
)


def test_bbox_parsing_and_india_test():
    assert parse_bbox("68, 6.5, 97.5, 35.5") == (68.0, 6.5, 97.5, 35.5)
    assert parse_bbox("") is None and parse_bbox("1,2,3") is None and parse_bbox("5, 0, 1, 1") is None
    assert intersects((75.0, 22.0, 76.0, 23.0))
    assert not intersects((-135.17, 36.83, -51.24, 62.25))


def test_coverage_labels():
    assert coverage((-180, -90, 180, 90)) == "Global"
    assert coverage((75.0, 22.0, 76.0, 23.0)).startswith("Regional")


def test_build_keeps_india_rows_in_finder_shape():
    doc = build({"gee": GEE, "pc": PC})
    ids = [d["id"] for d in doc["datasets"]]
    assert ids == ["ee:ESA/WorldCover/v200", "pc:io-lulc-9-class"]
    ee = doc["datasets"][0]
    for k in ("title", "publisher", "url", "license", "coverage", "tags"):
        assert ee[k], k
    assert ee["url"].startswith("https://")
    assert ee["access"] == "ee.ImageCollection('ESA/WorldCover/v200')"
    assert ee["tags"][:2] == ["landuse-landcover", "esa"]
    assert ee["years"] == "2021–2022"
    pc = doc["datasets"][1]
    assert pc["url"] == "https://planetarycomputer.microsoft.com/dataset/io-lulc-9-class"
    assert pc["access"].endswith("/collections/io-lulc-9-class")


def test_build_tolerates_missing_sources():
    assert build({})["datasets"] == []
