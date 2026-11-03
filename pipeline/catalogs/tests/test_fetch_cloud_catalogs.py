"""Offline tests for the Earth Engine / Planetary Computer catalog index."""
from pipeline.catalogs.fetch_cloud_catalogs import (aws_entries, build, cmr_entries, copernicus_entries, coverage,
                                                   intersects, off_india, overlap_share, parse_bbox, read_tsv)

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


def test_drops_rows_named_for_other_countries_despite_a_global_bbox():
    assert off_india("AirView California Unified", "GOOGLE/AirView/California_Unified_2015_2019")
    assert off_india("USGS 3DEP 10m", "USGS/3DEP/10m_collection")
    assert not off_india("ESA WorldCover 10m v200", "ESA/WorldCover/v200")
    assert not off_india("VIIRS Nighttime Day/Night Band", "NOAA/VIIRS/DNB/ANNUAL_V22")


CMR = (
    "id\ttitle\tcatalog\tstate_date\tend_date\tbbox\turl\tdescription\tlicense\n"
    "a\tINSAT-3D Imager Level-2B Cloud Map\tISRO STAC Catalog\t2014-01-01\t2026-01-01\t0.8, -81, 163, 81\thttps://cmr.earthdata.nasa.gov/search/concepts/C1-ISRO.umm_json\td\tCC0-1.0\n"
    "b\tMODIS/Terra Land Surface Temperature/Emissivity Monthly L3 Global 6km SIN Grid V061\tLPCLOUD STAC Catalog\t2000-01-01\t\t-180, -90, 180, 90\thttps://cmr.earthdata.nasa.gov/search/concepts/C2-LPCLOUD.umm_json\td\tCC0-1.0\n"
    "c\tMODIS/Terra Land Surface Temperature/Emissivity Monthly L3 Global 6km SIN Grid V006\tLPCLOUD STAC Catalog\t2000-01-01\t\t-180, -90, 180, 90\thttps://cmr.earthdata.nasa.gov/search/concepts/C3-LPCLOUD.umm_json\td\tCC0-1.0\n"
    "d\tVIIRS Land Surface Temperature 6-Min L2 Swath 750m\tLPCLOUD STAC Catalog\t2012-01-01\t\t-180, -90, 180, 90\thttps://cmr.earthdata.nasa.gov/search/concepts/C4-LPCLOUD.umm_json\td\tCC0-1.0\n"
    "e\tOcean salinity cruise data\tNOAA_NCEI STAC Catalog\t1990-01-01\t1991-01-01\t-2, -61, 105, 29\thttps://cmr.earthdata.nasa.gov/search/concepts/C5-X.umm_json\td\tCC0-1.0\n"
    "f\tMonsoon rain gauges over central India\tALL STAC Catalog\t2001-01-01\t2002-01-01\t74, 18, 82, 25\thttps://cmr.earthdata.nasa.gov/search/concepts/C6-ALL.umm_json\td\tCC0-1.0\n"
)


def test_cmr_keeps_india_named_local_and_gridded_global_once():
    out = list(cmr_entries(read_tsv(CMR)))
    ids = [e["id"] for e in out]
    # INSAT named for India; MODIS LST gridded global (V006 collapsed into V061);
    # the swath and the off-shore cruise are dropped; the local India study is kept.
    assert ids == ["cmr:C1-ISRO", "cmr:C2-LPCLOUD", "cmr:C6-ALL"]
    assert out[1]["url"] == "https://search.earthdata.nasa.gov/search/granules?p=C2-LPCLOUD"
    assert out[1]["platform"] == "NASA Earthdata"
    assert "land surface temperature" in out[1]["tags"]


def test_overlap_share():
    assert overlap_share((75, 20, 80, 25)) == 1.0
    assert overlap_share((-2, -61, 105, 29)) < 0.25


CDS = (
    "type\tstac_version\tid\ttitle\tdescription\tlinks\tkeywords\tlicense\tproviders\textent\tsummaries\tassets\n"
    "Collection\t1.1.0\treanalysis-era5-land\tERA5-Land hourly data\td\t[]\t['Variable domain: Land (hydrology)', 'Spatial coverage: Global']\tCC-BY-4.0\t[]\t"
    "{'spatial': {'bbox': [[0.0, -89.0, 360.0, 89.0]]}, 'temporal': {'interval': [['1950-01-01T00:00:00Z', '2026-09-07T00:00:00Z']]}}\t{}\t{}\n"
    "Collection\t1.1.0\tefas-historical\tEuropean Flood Awareness System history\td\t[]\t[]\tother\t[]\t"
    "{'spatial': {'bbox': [[-25, 22, 50, 72]]}, 'temporal': {'interval': [['1991-01-01T00:00:00Z', None]]}}\t{}\t{}\n"
)


def test_copernicus_converts_0_360_bboxes_and_drops_europe():
    out = list(copernicus_entries(read_tsv(CDS), "cds"))
    assert [e["id"] for e in out] == ["cds:reanalysis-era5-land"]
    era = out[0]
    assert era["coverage"] == "Global"
    assert era["url"] == "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land"
    assert era["years"] == "1950–2026"
    assert "land (hydrology)" in era["tags"]


AWS = (
    "Name\tDescription\tARN\tRegion\tType\tExplore\tDocumentation\tContact\tManagedBy\tUpdateFrequency\tLicense\tTags\tRequesterPays\tAccountRequired\tHost\tControlledAccess\n"
    "IGP Brick Kilns India\tKilns\tarn:aws:s3:::igp-kilns\tus-west-2\tS3 Bucket\t[]\thttps://example.org/kilns\tx\t[Sust Lab](https://x)\tonce\t[CC BY 4.0](https://cc)\t['air quality', 'geospatial']\tFalse\tFalse\t\t\n"
    "Indiana Elevation\tIndiana lidar\tarn:aws:s3:::indiana\tus-east-1\tS3 Bucket\t[]\thttps://example.org/in\tx\tx\tonce\tx\t[]\tFalse\tFalse\t\t\n"
)


def test_aws_keeps_entries_that_name_india_not_indiana():
    out = list(aws_entries(read_tsv(AWS)))
    assert [e["id"] for e in out] == ["aws:igp-kilns"]
    assert out[0]["access"] == "s3://igp-kilns"
    assert out[0]["license"] == "CC BY 4.0"
    assert out[0]["publisher"] == "Sust Lab"
