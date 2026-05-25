"""Urban Heat Island pipeline — extracts MODIS LST COGs from Earth Engine.

Output written to data/heat/:
  modis_lst_2016-2024.tif  (multi-band COG, 18 bands: day+night LST per year)

Asset: MODIS/061/MOD11A1 — daily land surface temperature at 1km native.
We aggregate to annual mean per year × {day, night} to surface the urban
heat-island signal (cities heat differently from surrounding vegetated
land, especially at night). 9 years × 2 phases = 18 bands.

Run with `python -m pipeline.heat.extract_modis_lst`.
GEE auth via cached OAuth or GOOGLE_APPLICATION_CREDENTIALS, with
GEE_PROJECT defaulting to van-suraksha-alert (same as growth pipeline).
"""
