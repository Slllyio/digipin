# 120 data additions for DigiPin

This list was made on 2026-10-23 and checked against the 58 cell datasets and about 70 lenses already on `dev`.

Each item gives four things:

- **What it adds.**
- **The open source it comes from.**
- **How it is reached.** EE means Google Earth Engine. S3 means a public bucket. API means a public web API. Key means it needs an API key and is parked for the final keys round.
- **The first lens or feature it feeds.**

**Status:** ✅ means shipped. ▶ means next in the build queue. Everything else is open.

## Build queue (top 15, in order)

| # | Item | Why first |
|---|---|---|
| 1 | ❌ Overture buildings: class, floors, height per block | Building use mix (residential/commercial/industrial) per block: core to real estate |
| 2 | ❌ Overture transport segments: road class, speed, surface per block | Road quality and arterial frontage for land value and retail siting |
| 3 | ✅ Office and IT clusters → jobs proxy (jobsmap lens) | Fills the missing jobs layer behind job access and rental demand |
| 4 | ✅ Property-agent density → market-activity signal (market lens) | Turns places data into a price-model input |
| 5 | Landslide susceptibility (NASA LHASA) | Hills in Mumbai, Pune, Bengaluru fringe, Bhopal |
| 6 | Cyclone wind return levels (STORM) | Chennai, Kolkata, Mumbai: insurance and structure risk |
| 7 | ✅ Earthquake zone (ground lens) (BIS IS 1893 zones) | Delhi zone IV, Kolkata III/IV: building code and insurance |
| 8 | Lightning flash density (LIS/OTD) | Deaths, power cuts, solar/telecom asset risk |
| 9 | ✅ Dust and dust storms (CAMS dust share and dust-haze days; airtrend lens) | Delhi/Jaipur/Ahmedabad pre-monsoon air |
| 10 | ✅ Wet-bulb 2050 (CMIP6 hurs + tas) | Humid heat future for coastal cities |
| 11 | ✅ Crop and green-belt loss at the edge (Dynamic World; farmloss lens) | Peri-urban conversion pressure |
| 12 | ✅ Air trend (NO₂ 2019→2025, PM2.5 2012→2022, SO₂) | Where air is getting worse fastest |
| 13 | Schools and hospitals capacity (Overture + OSM beds/levels) | Service gap lenses with size, not just count |
| 14 | ✅ Tree planting potential (canopy gap × heat × pavement) | Cooling action siting |
| 15 | ✅ Cool-roof potential (roof area × albedo × heat) | Cheap heat action per block |

## Also shipped from outside the top 15

- ✅ Satellite embeddings: the "What changed" lens and "looks like this from space" search (items 116–117)
- ✅ Open burning from VIIRS fires (items 34–35)
- ✅ Ground conditions: subsoil clay, wet land and slopes (items 103 and 105)
- ✅ Lake health: water lost since 2019, algae and weeds (items 41–42)
- ✅ Flood exposure to 2080 added to the flood_future dataset (long view next to item 32)

## A. Buildings and real estate (1–20)

1. ❌ Overture buildings class / subtype per block (residential, commercial, industrial, civic, religious) | S3 | land-use mix lens, property report (dropped: under 1% of Indian buildings carry a class or height in Overture)
2. ❌ Overture building floors and height where tagged | S3 | FAR check against Open Buildings 2.5D (dropped: under 1% of Indian buildings carry floors or height in Overture)
3. Building age bands from WSF Evolution + GHSL epochs (exists as settled_year; add age histogram) | EE | redevelopment lens
4. Building footprint shape: compactness, size class (small plots vs slabs) | EE Open Buildings v3 polygons | informal-housing and plot-size lens
5. Informal / slum likelihood (small dense roofs + low RWI + low road access) | derived | housing-quality lens
6. Rooftop area free for solar after water tanks (Open Buildings height variance) | EE | refines Home solar
7. Vacant building signal (no night light growth + no places + built) | derived | vacancy lens
8. Commercial floor-space estimate (places × building class × height) | derived | office/retail supply
9. Stalled-construction detector (bare soil steady for 24 months in construction_monthly) | EE | construction agent
10. Plot-level setback/coverage compliance proxy (cover vs base FAR rules) | derived | FAR what-if
11. RERA project registrations (state portals; scraping fragile) | API/key | supply pipeline
12. Circle rates for more states (Maharashtra ASR, Karnataka guidance values) | open PDFs | land-value calibration
13. Rental listings index (99acres/MagicBricks) | key | rent lens (parked for keys)
14. Hotel and serviced-apartment density (Overture lodging) | S3 | tourism demand lens
15. Co-working spaces (Overture) | S3 | office demand
16. ✅ Overture places per block (shops, food, offices, health, education, brands) | S3 | Commercial vitality
17. Retail catchment (Huff model on places + population) | derived | retail siting
18. Mall and big-box presence (Overture shopping_mall, chains) | S3 | retail anchor lens
19. Petrol pumps and EV chargers combined fuel map | S3/OSM | mobility energy
20. Land-pooling and master-plan zones (where states publish GIS) | open GIS | zoning overlay

## B. Climate, hazards and environment (21–45)

21. ✅ Climate 2050 heat (CMIP6) | EE
22. ✅ Street heat 2050 with block heat island | EE
23. ✅ Flood 2050 river + coast (Aqueduct) | EE
24. ✅ Water risk now and 2050 (Aqueduct 4.0) | EE
25. ✅ Climate 2050 grade A–E | derived
26. ▶ Landslide susceptibility (NASA LHASA global) | EE community / NASA | hazard lens
27. ▶ Cyclone wind 10/100-year return speeds (STORM, Bloemendaal 2020) | open download | wind risk
28. ▶ Seismic zone (BIS IS 1893-2016) | open map digitised | quake risk
29. ▶ Lightning flash density (NASA LIS/OTD climatology) | NASA | lightning risk
30. ▶ Dust AOD and dust-storm days (MERRA-2) | NASA | dust lens
31. ✅ Wet-bulb 2050 (NEX-GDDP hurs + tasmax) | EE | humid heat future (humid_future (wet-bulb now and 2050))
32. Sea-level rise 2100 bathtub on FABDEM (connected) | EE community | coastal long view
33. Storm-surge 100-year (GTSR, Muis 2016) | open | coastal flood detail
34. ✅ Fire hotspots near the city (FIRMS VIIRS) | EE | crop-burning season (fires + burning lens)
35. ✅ Stubble-burning smoke source tracker (FIRMS × wind back-trajectory) | EE | Delhi air (partly: winter share in the burning lens (no back-trajectories))
36. Noise from aircraft (airport runways + flight paths) | OSM + derived | noise lens
37. Light pollution sky brightness (VIIRS radiance to SQM) | EE | night-sky lens
38. Soil sealing trend (GHSL imperviousness yearly) | EE | runoff lens
39. ✅ Urban runoff coefficient per block (sealing + slope + soil) | derived | drainage lens
40. Drainage density (OSM drains + MERIT streams) | OSM/EE | waterlogging
41. ✅ Lake and wetland health (Sentinel-2 water extent trend + NDCI) | EE | lake lens
42. ✅ Water quality chlorophyll / turbidity in lakes (Sentinel-2) | EE | lake lens
43. ✅ Mangrove extent and loss (Global Mangrove Watch) | EE | coastal buffer
44. Coastal erosion / shoreline change (Landsat shoreline) | EE | coast lens
45. Groundwater recharge potential (soil + slope + land cover) | EE | recharge siting

## C. Air and health (46–60)

46. CAMS PM2.5 forecast (next 5 days) | API | air alerts
47. Ozone (Sentinel-5P O3 + CAMS) | EE | ozone lens
48. ✅ SO2 from industry (Sentinel-5P) | EE | industry pollution (air_trend SO₂ hotspots)
49. ✅ Formaldehyde HCHO (Sentinel-5P) | EE | VOC hotspots (already in air_quality (HCHO))
50. Methane at landfills (Sentinel-5P CH4 + landfill locations) | EE/OSM | landfill lens
51. Landfills and dumpsites (OSM landuse=landfill + Wikidata) | OSM | waste lens
52. Sewage treatment plants and capacity | OSM/Wikidata | sanitation
53. Hospitals with beds (Overture + OSM beds tag + Wikidata) | S3/OSM | health capacity
54. Pharmacies and diagnostics (Overture) | S3 | health access
55. Dengue/malaria risk proxy (standing water + temperature + humidity) | EE | vector lens
56. Heat-health mortality estimate (Gasparrini ERFs on hot days) | derived | heat deaths lens
57. ✅ Air-pollution premature deaths (GBD PM2.5 IER) | derived | air deaths lens
58. Walkable shade on routes to clinics | derived | shade lens extension
59. ✅ Green space per resident (WHO 9 m² target) | derived | green lens extension
60. Cooling centres siting (libraries, malls, temples with AC) | S3 | heat action plan

## D. Mobility and access (61–78)

61. ❌ Overture transport segments: class, surface, speed limit | S3 | road quality (dropped: road surface and speed are under 1% tagged in Overture for India)
62. Road surface from Sentinel-2 (paved vs unpaved) | EE | road quality
63. Footpath presence (OSM sidewalk tags) | OSM | walk lens
64. Streetlights (OSM highway=street_lamp + VIIRS) | OSM/EE | night safety
65. Metro ridership by station (DMRC/BMRCL open data where published) | open | transit lens
66. Bus GTFS for Delhi (parked for key), Chennai, Hyderabad | key/open | bus frequency
67. Railway suburban stations with frequency (Mumbai locals timetable) | open | rail access
68. Airport access time | derived | travel lens
69. Truck routes and no-entry hours | OSM | freight
70. Parking supply from OSM + places | OSM/S3 | parking lens extension
71. Bike-share docks (Yulu/Bounce where open) | API | micro-mobility
72. Auto-rickshaw stands | OSM | last-mile
73. Traffic accidents by road (iRAD summaries where public) | open | road safety
74. School zones and safe routes | OSM | school-run lens
75. Ride-hailing price proxy (distance × surge zones) | derived | mobility cost
76. Congestion from Uber Movement archive (Mumbai, Delhi, Bengaluru, Hyderabad 2016–2020) | open archive | traffic calibration
77. Isochrones by car with time of day (existing traffic model) | derived | access lens
78. Freight logistics parks and warehouses (Overture/OSM) | S3/OSM | logistics lens

## E. People and economy (79–95)

79. ✅ Jobs proxy from offices + places + non-residential floor space | derived | job access
80. Census 2011 ward population and literacy (where ward shapes exist) | open | equity lens
81. NFHS-5 district health and wealth indicators | open | district context
82. SECC / PMAY beneficiary density (where published) | open | housing need
83. Gig and informal work proxy (two-wheeler density × places) | derived | economy lens
84. Night-time economy (VIIRS late-night radiance × food/leisure places) | EE/S3 | night economy
85. Tourism footfall proxy (Wikipedia page views of landmarks + hotels) | API | tourism lens
86. Landmark and heritage sites (Wikidata, ASI list) | API | heritage lens
87. Religious places and festival crowd zones | S3/OSM | crowd lens
88. Schools by board and level (UDISE+ where open) | open | education lens
89. Colleges and coaching hubs (Overture) | S3 | student housing demand
90. Bank branches and ATMs per resident (financial inclusion) | S3 | finance lens
91. Post offices and India Post services (DIGIPIN home!) | open | postal lens
92. Startups and IT parks (Wikidata, SEZ list) | open | innovation lens
93. GST registrations by district | open | economy context
94. Electricity reliability (power-cut reports, ESMI where open) | open | utilities
95. ❌ Mobile broadband coverage (Ookla open data tiles) | S3 | digital access lens (skipped: Ookla open data is CC BY-NC-SA (non-commercial))

## F. Land and nature (96–110)

96. ✅ Crop-to-urban conversion at the edge (WorldCereal + Dynamic World) | EE | edge pressure
97. Green-belt and ridge forest boundaries (Delhi Ridge, Aravalli) | open GIS | encroachment
98. ❌ Protected areas and eco-sensitive zones (WDPA) | EE | no-build overlay (skipped: WDPA needs an IBAT licence for commercial use; OSM protected areas in Actions instead)
99. Biodiversity intactness (NHM BII) | open | nature lens
100. Bird and wildlife sightings (GBIF occurrences) | API | nature lens
101. Tree species diversity proxy (Sentinel-2 phenology) | EE | green quality
102. Soil organic carbon and texture (SoilGrids; exists partly) | EE | gardens/recharge
103. ✅ Slope stability and cut-fill (DEM curvature) | EE | construction cost (slopes in the ground lens)
104. Bedrock depth (Pelletier 2016) | EE | foundation cost
105. ✅ Expansive black-cotton soil (SoilGrids clay + vertisol class) | EE | foundation risk (subsoil + ground lens)
106. Quarries and mines (Global mining polygons, Maus 2022) | open | land damage
107. Brick kilns (Sentinel-2 detections, Boyd et al.) | open | air/land
108. Lake encroachment by year (JRC GSW yearly) | EE | encroachment extension
109. Urban farms and community gardens | OSM | food lens
110. Night-sky dark spots for parks | EE | leisure

## G. Platform and AI (111–120)

111. Per-block "what changed this month" digest across all datasets | derived | alerts
112. Comparable-block search across all 13 cities on the new fields | derived | similar()
113. DISHA site memo: one-click climate + market + access due diligence | derived | agents
114. Data-confidence per lens (coverage × source quality) | derived | confidence lens
115. Scenario builder: add a metro / flyover / park and re-score | derived | what-if
116. ✅ Embeddings per block (Google Satellite Embedding V1, 64-d) for similarity | EE | AI search (embeddings + lookalike)
117. ✅ Change detection with Satellite Embeddings year over year | EE | change lens (change lens)
118. Building-use classifier from embeddings + places | EE/S3 | land-use mix
119. Export any lens to GeoJSON / GeoParquet / CSV per DIGIPIN | derived | data API
120. Public data API: static JSON per DIGIPIN prefix with every field | derived | developer API

## Parked for the keys round

Items 11, 13, 46, 66 (Delhi), 71, 85 need keys or logins. Collect them with IMD, OpenAQ and the GEE repo secret.
