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
| 1 | ❌ Overture buildings: class, floors, height per block (use mix now comes from Overture land use: landmix lens) | Building use mix (residential/commercial/industrial) per block: core to real estate |
| 2 | ❌ Overture transport segments: road class, speed, surface per block | Road quality and arterial frontage for land value and retail siting |
| 3 | ✅ Office and IT clusters → jobs proxy (jobsmap lens) | Fills the missing jobs layer behind job access and rental demand |
| 4 | ✅ Property-agent density → market-activity signal (market lens) | Turns places data into a price-model input |
| 5 | Landslide susceptibility (NASA LHASA) | Hills in Mumbai, Pune, Bengaluru fringe, Bhopal |
| 6 | ✅ Cyclone wind return levels (IBTrACS tracks; cyclone lens) | Chennai, Kolkata, Mumbai: insurance and structure risk |
| 7 | ✅ Earthquake zone (ground lens) (BIS IS 1893 zones) | Delhi zone IV, Kolkata III/IV: building code and insurance |
| 8 | ✅ Lightning flash density (lightning lens) (LIS/OTD) | Deaths, power cuts, solar/telecom asset risk |
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
3. ✅ Building age bands from WSF Evolution + GHSL epochs (buildingage lens: area built per epoch since 1975) | EE | redevelopment lens
4. ✅ Building footprint shape: compactness, size class (small plots vs slabs) | EE Open Buildings v3 polygons | informal-housing and plot-size lens
5. ✅ Informal / slum likelihood (small dense roofs + low RWI + low road access) | derived | housing-quality lens
6. Rooftop area free for solar after water tanks (Open Buildings height variance) | EE | refines Home solar
7. ✅ Vacant building signal (no night light growth + no places + built) | derived | vacancy lens
8. ✅ Commercial floor-space estimate (places × building class × height) | derived | office/retail supply
9. ✅ Stalled-construction detector (bare soil steady for 24 months in construction_monthly) | EE | construction agent
10. ✅ Plot-level setback/coverage compliance proxy (cover vs base FAR rules) | derived | FAR what-if (`packed` lens, block-level roof cover and height)
11. RERA project registrations (state portals; scraping fragile) | API/key | supply pipeline
12. Circle rates for more states (Maharashtra ASR, Karnataka guidance values) | open PDFs | land-value calibration
13. Rental listings index (99acres/MagicBricks) | key | rent lens (parked for keys)
14. ✅ Hotel and serviced-apartment density (Overture lodging) | S3 | tourism demand lens
15. ✅ Co-working spaces (Overture) | S3 | office demand
16. ✅ Overture places per block (shops, food, offices, health, education, brands) | S3 | Commercial vitality
17. ✅ Retail catchment (Huff model on places + population) | derived | retail siting
18. ✅ Mall and big-box presence (Overture shopping_mall, chains) | S3 | retail anchor lens
19. ✅ Petrol pumps and EV chargers combined fuel map | S3/OSM | mobility energy (ev_charging.fuel and places.fuel; EV lens)
20. Land-pooling and master-plan zones (where states publish GIS) | open GIS | zoning overlay

## B. Climate, hazards and environment (21–45)

21. ✅ Climate 2050 heat (CMIP6) | EE
22. ✅ Street heat 2050 with block heat island | EE
23. ✅ Flood 2050 river + coast (Aqueduct) | EE
24. ✅ Water risk now and 2050 (Aqueduct 4.0) | EE
25. ✅ Climate 2050 grade A–E | derived
26. ⏸ Landslide susceptibility (NASA LHASA global) | EE community / NASA | hazard lens (parked: needs GES DISC EULA approval on the Earthdata account)
27. ✅ Cyclone wind 10/100-year return speeds (STORM, Bloemendaal 2020) | open download | wind risk (STORM sits on data.4tu.nl, unreachable here, so `cyclones` models the wind field from NOAA IBTrACS best tracks 1981–2024 instead; `cyclone` lens)
28. ✅ Seismic zone (BIS IS 1893-2016) | open map digitised | quake risk
29. ✅ Lightning flash density (NASA LIS/OTD climatology) | NASA | lightning risk
30. ✅ Dust AOD and dust-storm days (CAMS instead of MERRA-2) | NASA | dust lens
31. ✅ Wet-bulb 2050 (NEX-GDDP hurs + tasmax) | EE | humid heat future (humid_future (wet-bulb now and 2050))
32. ✅ Sea-level rise 2100 bathtub on FABDEM (connected) | EE community | coastal long view (covered by flood_future coastal 2050/2080 fields in the flood2050 lens)
33. ✅ Storm-surge 100-year (GTSR, Muis 2016) | open | coastal flood detail (covered: the Aqueduct coastal flood maps in `flood_future` are built on GTSR extreme sea levels; the raw GTSR files sit on data.4tu.nl, unreachable here)
34. ✅ Fire hotspots near the city (FIRMS VIIRS) | EE | crop-burning season (fires + burning lens)
35. ✅ Stubble-burning smoke source tracker (FIRMS × wind back-trajectory) | EE | Delhi air (partly: winter share in the burning lens (no back-trajectories))
36. ✅ Noise from aircraft (airport runways + flight paths) | OSM + derived | noise lens
37. ❌ Light pollution sky brightness (VIIRS radiance to SQM) | EE | night-sky lens (skipped: the Falchi 2016 atlas is CC BY-NC)
38. ✅ Soil sealing trend (GHSL imperviousness yearly) | EE | runoff lens (covered by builtup_yearly in the buildingage and runoff lenses)
39. ✅ Urban runoff coefficient per block (sealing + slope + soil) | derived | drainage lens
40. ✅ Drainage density (OSM drains + MERIT streams) | OSM/EE | waterlogging (`drains` dataset, `drainage` lens)
41. ✅ Lake and wetland health (Sentinel-2 water extent trend + NDCI) | EE | lake lens
42. ✅ Water quality chlorophyll / turbidity in lakes (Sentinel-2) | EE | lake lens
43. ✅ Mangrove extent and loss (Global Mangrove Watch) | EE | coastal buffer
44. ✅ Coastal erosion / shoreline change (Landsat shoreline) | EE | coast lens (`coast` lens on JRC water 1990 vs 2020 near the coast, with a CRZ band proxy)
45. ✅ Groundwater recharge potential (soil + slope + land cover) | EE | recharge siting

## C. Air and health (46–60)

46. CAMS PM2.5 forecast (next 5 days) | API | air alerts
47. ❌ Ozone (Sentinel-5P O3 + CAMS) | EE | ozone lens (skipped: the Sentinel-5P ozone product is a total column, mostly stratospheric, so it says nothing about street-level ozone)
48. ✅ SO2 from industry (Sentinel-5P) | EE | industry pollution (air_trend SO₂ hotspots)
49. ✅ Formaldehyde HCHO (Sentinel-5P) | EE | VOC hotspots (already in air_quality (HCHO))
50. ❌ Methane at landfills (Sentinel-5P CH4 + landfill locations) | EE/OSM | landfill lens (skipped: dry-season 2022–25 mean is only ~12 ppb higher at Ghazipur than central Delhi, and west Mumbai reads as high as Deonar, so the 7 km pixels can't separate landfills from noise)
51. ✅ Landfills and dumpsites (OSM landuse=landfill + Wikidata) | OSM | waste lens
52. ✅ Sewage treatment plants and capacity | OSM/Wikidata | sanitation (wastewater basins in `drains`; capacity not open)
53. Hospitals with beds (Overture + OSM beds tag + Wikidata) | S3/OSM | health capacity
54. ✅ Pharmacies and diagnostics (Overture) | S3 | health access
55. ✅ Dengue/malaria risk proxy (standing water + temperature + rain; mosquito lens) | EE | vector lens
56. ❌ Heat-health mortality estimate (Gasparrini ERFs on hot days) | derived | heat deaths lens (skipped: de Bont 2024 gives +14.7% deaths on city-level heatwave days, so a block map would be uniform)
57. ✅ Air-pollution premature deaths (GBD PM2.5 IER) | derived | air deaths lens
58. ✅ Walkable shade on routes to clinics | derived | shade lens extension (`shadecare` lens: network route traced block by block, canopy × surface heat)
59. ✅ Green space per resident (WHO 9 m² target) | derived | green lens extension
60. ✅ Cooling centres siting (libraries, malls, temples with AC) | S3 | heat action plan (`cooling` lens)

## D. Mobility and access (61–78)

61. ❌ Overture transport segments: class, surface, speed limit | S3 | road quality (dropped: road surface and speed are under 1% tagged in Overture for India)
62. ❌ Road surface from Sentinel-2 (paved vs unpaved) | EE | road quality (skipped: OSM surface tags cover only 20% of Delhi road length, and a Sentinel-2 classifier would need training labels)
63. ❌ Footpath presence (OSM sidewalk tags) | OSM | walk lens (too sparse: Delhi has 96 km tagged)
64. ✅ Streetlights (VIIRS light on station walks: existing nightwalk lens) (OSM highway=street_lamp + VIIRS) | OSM/EE | night safety
65. Metro ridership by station (DMRC/BMRCL open data where published) | open | transit lens
66. ✅ Bus GTFS for Chennai, Hyderabad, Pune, Ahmedabad and Mumbai (items 219, 220; Delhi still parked for its key) | open | bus frequency
67. ⏸ Railway suburban stations with frequency (Mumbai locals timetable) | open | rail access (catchment half shipped as `stationload`, item 138; no open timetable)
68. ✅ Airport access time | derived | travel lens (`airport` lens)
69. ❌ Truck routes and no-entry hours | OSM | freight (skipped: only 15 km of Delhi roads carry an hgv restriction in OSM)
70. ✅ Parking supply (existing parking lens) from OSM + places | OSM/S3 | parking lens extension
71. ❌ Bike-share docks (Yulu/Bounce where open) | API | micro-mobility (skipped: no open dock feeds; OSM has 66 bicycle_rental points in Delhi)
72. ❌ Auto-rickshaw stands | OSM | last-mile (skipped: Overture lists one taxi stand in Delhi)
73. Traffic accidents by road (iRAD summaries where public) | open | road safety
74. ✅ School zones and safe routes (existing roadsafety and schoolrun lenses) | OSM | school-run lens
75. Ride-hailing price proxy (distance × surge zones) | derived | mobility cost
76. Congestion from Uber Movement archive (Mumbai, Delhi, Bengaluru, Hyderabad 2016–2020) | open archive | traffic calibration
77. ✅ Isochrones by car with time of day (existing ambulance lens: hospital by road at 9 am vs 3 am) (existing traffic model) | derived | access lens
78. ✅ Freight logistics parks and warehouses (existing freight lens) (Overture/OSM) | S3/OSM | logistics lens

## E. People and economy (79–95)

79. ✅ Jobs proxy from offices + places + non-residential floor space | derived | job access
80. Census 2011 ward population and literacy (where ward shapes exist) | open | equity lens
81. ✅ NFHS-5 district health and household indicators (stunting, anaemia, BP, sugar, insurance, clean fuel and more) for all 13 cities, from a GitHub CSV conversion of the IIPS fact sheets | GitHub | `districthealth` lens (new dataset `nfhs`, pipeline/realestate/nfhs.py)
82. SECC / PMAY beneficiary density (where published) | open | housing need
83. ✅ Gig and informal work proxy (two-wheeler density × places) | derived | economy lens (`riders` lens: delivery-rider hubs from eateries and grocers, rest-stop gaps from toilets, water and heat; vehicle registrations are not open per block)
84. ✅ Night-time economy (VIIRS late-night radiance × food/leisure places) | EE/S3 | night economy
85. ✅ Tourism footfall proxy (Wikipedia page views of landmarks + hotels) | API | tourism lens (`landmarks` dataset uses Wikipedia language editions, since the page-view API rate-limits this host; `tourism` lens)
86. ✅ Landmark and heritage sites (Wikidata, ASI list; heritage lens with AMASR 100 m / 300 m limits) | API | heritage lens
87. ✅ Religious places and festival crowd zones | S3/OSM | crowd lens (`crowds` lens)
88. Schools by board and level (UDISE+ where open) | open | education lens
89. ✅ Colleges and coaching hubs (Overture) | S3 | student housing demand
90. ✅ Bank branches and ATMs per resident (financial inclusion) | S3 | finance lens
91. ✅ Post offices and India Post services (DIGIPIN home!; reach lens, Overture listings) | open | postal lens
92. ✅ Startups and IT parks (Wikidata, SEZ list) | open | innovation lens (`places.tech` from Overture categories, since Wikidata lists few IT parks; `techhubs` lens)
93. GST registrations by district | open | economy context
94. ✅ Electricity reliability: local power cuts from NASA Black Marble daily night lights (blocks dark while the city stays lit; ESMI has no open API) | EE | `powercuts` lens (new dataset `blackouts`, pipeline/realestate/blackouts.py)
95. ❌ Mobile broadband coverage (Ookla open data tiles) | S3 | digital access lens (skipped: Ookla open data is CC BY-NC-SA (non-commercial))

## F. Land and nature (96–110)

96. ✅ Crop-to-urban conversion at the edge (WorldCereal + Dynamic World) | EE | edge pressure
97. ✅ Green-belt and ridge forest boundaries (Delhi Ridge, Aravalli; Overture protected land + ESZ, greenbelt lens) | open GIS | encroachment
98. ❌ Protected areas and eco-sensitive zones (WDPA) | EE | no-build overlay (skipped: WDPA needs an IBAT licence for commercial use; OSM protected areas in Actions instead)
99. ❌ Biodiversity intactness (NHM BII) | open | nature lens (skipped: every NHM BII release is CC BY-NC or other-NC)
100. ❌ Bird and wildlife sightings (GBIF occurrences) | API | nature lens (skipped: records mix in CC BY-NC)
101. ✅ Tree species diversity proxy (Sentinel-2 phenology) | EE | green quality (`tree_season` layer: summer-leafy share, greening and its spread over Meta canopy; `summershade` lens)
102. ✅ Soil organic carbon and texture (SoilGrids; exists partly) | EE | gardens/recharge (`topsoil` layer from OpenLandMap, since SoilGrids masks cities; `gardens` lens)
103. ✅ Slope stability and cut-fill (DEM curvature) | EE | construction cost (slopes in the ground lens)
104. ⏸ Bedrock depth (Pelletier 2016) | EE | foundation cost (parked: not in Earth Engine; ORNL DAAC download needs the Earthdata account to approve the ORNL app, with the GES DISC approval)
105. ✅ Expansive black-cotton soil (SoilGrids clay + vertisol class) | EE | foundation risk (subsoil + ground lens)
106. ✅ Quarries and mines (Overture/OSM quarries; Maus 2022 global mines has none inside the 13 cities) | open | land damage
107. ❌ Brick kilns (Sentinel-2 detections, Boyd et al.) | open | air/land (skipped: SentinelKilnDB is CC BY-NC)
108. ✅ Lake encroachment by year (JRC GSW yearly) | EE | encroachment extension
109. ✅ Urban farms and community gardens | OSM | food lens (`landuse.farm_pct`, `cityfarms` lens; soil side in `gardens`)
110. ❌ Night-sky dark spots for parks | EE | leisure

## G. Platform and AI (111–120)

111. ✅ Per-block "what changed this month" digest across all datasets (monthly lens: built-up, lights, NDVI, NO₂ year on year) | derived | alerts
112. ✅ Comparable-block search across all 13 cities on the new fields | derived | similar() (`similarEverywhere`, DISHA "comparable localities in every city"; roof cover, surface heat and flood exposure added to the match)
113. ✅ DISHA site memo: one-click climate + market + access due diligence | derived | agents (covered by the property report: panel button and DISHA `propreport`, now with lightning, monument limits and power line rows)
114. ✅ Data-confidence per lens (coverage × source quality) | derived | confidence lens (exists as the `confidence` lens)
115. ✅ Scenario builder: add a metro / flyover / park and re-score | derived | what-if (Intel What-if gains New metro station, New clinic and New school: `UrbanLenses.rescore` re-runs every lens that reads the edited columns; parks, trees and road links were already there)
116. ✅ Embeddings per block (Google Satellite Embedding V1, 64-d) for similarity | EE | AI search (embeddings + lookalike)
117. ✅ Change detection with Satellite Embeddings year over year | EE | change lens (change lens)
118. ✅ Building-use classifier from embeddings + places | EE/S3 | land-use mix (`builduse` lens: Gaussian naive Bayes trained on blocks with mapped Overture land use; 64–78% held-out accuracy)
119. ✅ Export any lens to GeoJSON / GeoParquet / CSV per DIGIPIN | derived | data API
120. ✅ Public data API: static JSON per DIGIPIN prefix with every field | derived | developer API (docs/DATA_API.md on reading data/cells directly; `python -m pipeline.cells.lookup <code>` returns every field at one place)
121. ✅ High-voltage power line corridors and substations (Overture/OSM voltage tags, MoP RoW widths) | S3 | `power_lines` dataset, `powerlines` lens, property report row
122. ✅ Public toilets and drinking-water points (Overture/OSM street objects) | S3 | `street_infra` dataset, `toilets` lens
123. ✅ Gated colonies from street gates and barriers (Overture/OSM) | S3 | `gated` lens
124. ✅ Railway noise bands: residents within 50 and 150 m of mainline track (Overture transportation rail) | S3 | `railnoise` lens
125. ✅ Maternity, gynaecology and children's doctors (Overture categories) | S3 | `mothercare` lens
126. ❌ EV charging stations (Overture `ev_charging_station`) | S3 | EV gap lens (skipped: only 44 listed in all of Delhi)
127. ✅ Wedding and banquet halls: weekend traffic and noise clusters (Overture) | S3 | `events` lens (places gained `events`)
128. ✅ Freight, cargo and warehouse clusters (Overture freight and storage categories) | S3 | logistics lens (covered by the `freight` lens; places also gained `freight` and `wholesale` counts)
129. ✅ Fire risk in crowded markets: shop density × roof cover × fire-station reach (Overture, Open Buildings) | derived | `marketfire` lens (new module js/urban-lenses-safety.js)
130. ✅ Old buildings, now tall: settled by 1985 × mean height × floors added since 2016 (WSF Evolution, GHSL 1975, Open Buildings 2.5D) | derived | `oldtall` lens (structural audit priorities)
131. ✅ Emergency services on wet ground: hospitals, fire and police stations and relief-camp schools in the 100-year flood or waterlogging zones (Overture, OSM, Aqueduct, Sentinel-1) | derived | `critwater` lens
132. ✅ Earthquake shaking on soft ground: low wet ground × sandy soil × tall buildings, with the IS 1893 zone (MERIT Hydro, SoilGrids, Open Buildings) | derived | `quake` lens
133. ✅ Homes beside factories: industrial land next to and mixed with housing, with satellite thermal hotspots (OSM land use, VIIRS) | derived | `factoryhomes` lens
134. ✅ Storm-surge shelter gaps: coastal 100-year flood residents × schools and community halls within 1 km (Aqueduct, OSM, Overture) | derived | `refuge` lens
135. ✅ Fire engines in packed lanes: roof cover × distance to a main road × fire-station reach (Open Buildings, OSM, Overture) | derived | `firelanes` lens
136. ✅ School safety check: flood, waterlogging, soft ground in seismic zones, packed lanes, industry and road noise at every school block (NDMA School Safety Policy) | derived | `schoolsafe` lens
137. ✅ Hospital safety check: the same six hazards at every hospital block (NDMA hospital safety guidelines) | derived | `hospitalsafe` lens
138. ✅ Crowded local-train stations: residents per suburban station by nearest-station catchment (rail_access, WorldPop) | derived | `stationload` lens
139. ✅ Older people in walk-up flats: residents 60+ in 3-5 storey blocks × pharmacy reach (WorldPop, Open Buildings, Overture) | derived | `walkups` lens
140. ✅ Monsoon tree-fall risk: tall canopy over busy main roads × heavy rain and cyclone wind (Meta canopy height, OSM, CHIRPS, IBTrACS) | derived | `treefall` lens
141. ✅ Substations under water: power substations in flood and waterlogging zones, now and by 2050, and the residents nearest each (OSM, Aqueduct, Sentinel-1) | derived | `gridflood` lens
142. ✅ Coaching hub safety: coaching-centre clusters × waterlogging (basements) × packed lanes × fire-station reach (Overture, Sentinel-1, Open Buildings, OSM) | derived | `coaching` lens
143. ✅ Rooftop rainwater: roof area × annual rain × runoff, per resident and against groundwater decline (Open Buildings, CHIRPS, CGWB norms) | derived | `rainharvest` lens
144. ✅ Construction dust and heat: building sites near schools, hospitals and homes, and hot sites for outdoor workers (Dynamic World sites, Landsat LST, OSM, Overture) | derived | `sitedust` lens
145. ✅ Hotel cluster fire safety: hotel and guest-house clusters × packed blocks × deep lanes × fire-station reach × old stock (Overture, Open Buildings, OSM, WSF) | derived | `hotelfire` lens
146. ✅ Quarries and flooded pits near homes: quarry land × open water × residents and children within 500 m (OSM land use, ESA WorldCover, WorldPop) | derived | `quarries` lens
147. ✅ Heritage at risk: listed monuments × flood, waterlogging, soft ground in seismic zones, packed lanes, industry and traffic (Wikidata + safety checks) | derived | `heritagesafe` lens
148. ✅ Fuel stations among homes: petrol and CNG stations sharing blocks with schools and hospitals, packed blocks and floodplains (Overture, OSM, Open Buildings, Aqueduct) | derived | `fuelsafe` lens
149. ✅ Tests, teeth and eyes: diagnostic labs and scan centres, dentists and eye clinics within reach, and old-age homes per over-60 (Overture places) | S3 | `carekit` lens (places gained `diagnostics`, `dental`, `eyecare`, `elder_homes`)
150. ✅ Coal smoke upwind: coal, gas and oil power plants within 150 km, weighted by how often the wind blows from each plant to the block (WRI Global Power Plant Database, ERA5-Land daily wind) | EE | `coalplume` lens (new dataset `power_plants`, pipeline/realestate/powerplants.py)
151. ✅ Downwind of the dump: residents downwind of landfills and industrial land, by the city wind rose (OSM land use, ERA5-Land daily wind) | EE | `dumpsmoke` lens (new dataset `downwind`, pipeline/realestate/downwind.py)
152. ✅ Homes on the forest edge: residents and young children within 500 m of large forest or protected land, on dark edges (ESA WorldCover, OSM protected areas, VIIRS) | derived | `wildedge` lens (human-wildlife conflict and forest fire)
153. ✅ A school within 1 km: school-age children (WorldPop 5-14) against mapped schools within the RTE 1 km and 3 km norms, and young people against colleges (WorldPop, OSM, Overture) | EE | `schoolgap` lens (demographics gained `school_age`, `youth_15_24`)
154. ✅ Railway level crossings: rail and road meeting at grade, on main roads and in heavy traffic, with bridge candidates (Overture/OSM transportation, traffic model) | S3 | `railgates` lens (new dataset `level_crossings`)
155. ✅ Rooms with a view: tower blocks within 400 m of sea, lake, river or big park, and the land-value gap (Open Buildings, JRC water, OSM parks) | derived | `views` lens
156. ✅ Neighbourhood names per block: the colony, sector, urban village or ward holding each block, its larger area and district (Overture divisions from OSM); lens picks read "39J3286 · Saket, South Delhi" | Overture | `neighbourhoods` dataset, `UrbanLenses.names`
157. ✅ PIN code per block: a distance-weighted vote of postcodes on Overture place addresses within 600 m, with its share (low on PIN boundaries); shown on the property report | Overture places | `neighbourhoods.pin`, `UrbanLenses.places`
158. ✅ Brick-kiln smoke: 22,459 Gangetic-plain kilns with PM2.5 estimates, weighted by how often the wind blows from each to the block (IGP asset-level emissions inventory, CC BY 4.0; ERA5-Land wind); Delhi, Lucknow, Kolkata | S3 + EE | `kilnsmoke` lens (new dataset `brick_kilns`, pipeline/realestate/kilns.py)
159. ✅ Municipal ward per block for 11 cities (MCD, BBMP, GHMC, BMC, GCC, PMC, KMC and others), with zone and corporation, for joining ward-level budgets, grievances and elections (DataMeet Municipal Spatial Data, CC BY 4.0) | GitHub | `wards` dataset, property report header
160. ✅ Assembly and Lok Sabha constituency per block, with SC/ST reservation, 13 cities (2008 delimitation; DataMeet from ECI, CC BY 2.5 India) | GitHub | `constituencies` dataset, property report header
161. ✅ DISHA "which ward / PIN code / constituency is this?" for a clicked block (neighbourhood, PIN, ward, assembly, Lok Sabha) | derived | `whereis` intent
162. ✅ District health lens over NFHS-5 (stunting, anaemia, raised BP, sugar, insurance) by district | GitHub | `districthealth` lens
163. ✅ Flooded before: reported flood spots and mapped 2005/2015 flood extents for Chennai, Bengaluru and Hyderabad (OpenCity, public domain) | OpenCity | `floodagain` lens (new dataset `flood_reports`, pipeline/realestate/floodreports.py)
164. ✅ Newest ward maps: Bengaluru GBA 2025 (369 wards, five corporations), Indore, Ahmedabad, Bhopal, Greater Jaipur 2024, GHMC and KMC 2022, plus Gurugram, Faridabad, Thane and Navi Mumbai for metro blocks (OpenCity, public domain) | OpenCity | `wards` dataset
165. ✅ Government school strain: UDISE+ 2024-25 school census summed by PIN code (pupils per teacher, classrooms in major repair, girls' toilets, government share) for 7 cities (OpenCity, public domain) | OpenCity | `schoolstrain` lens (new dataset `schools_udise`, pipeline/realestate/udise.py)
166. ✅ Recorded road crashes: Bengaluru Traffic Police station-wise crash and fatality counts 2018-2025 on its 2022 jurisdiction map (OpenCity, public domain) | OpenCity | `crashrecord` lens (new dataset `road_crashes`, pipeline/realestate/btpcrashes.py)
167. ✅ Mapped slums: corporation slum boundary maps for Chennai, Hyderabad, Mumbai (2015 clusters) and Bengaluru, with notified status where recorded (OpenCity, public domain) | OpenCity | `slummap` lens (new dataset `slums_mapped`, pipeline/realestate/slums.py)
168. ✅ Public toilets from corporation lists for Pune, Chennai, Mumbai (with women's seats) and Hyderabad, replacing sparse OpenStreetMap counts in the toilets lens (OpenCity) | OpenCity | `toilets` lens (new dataset `toilets_official`, pipeline/realestate/toilets.py)
169. ✅ Hyderabad bus timetable: TGSRTC GTFS (Telangana open data, February 2026, 5,028 stops, 44,892 weekday trips) via OpenCity, so busgap, transit access and feeder lenses use real frequencies there too | OpenCity | `bus_service` dataset (pipeline/traffic/gtfs_cells.py)
170. ✅ Operator bus-stop lists: BEST Mumbai (6,267), PMPML Pune (5,624) and Chennai bus shelters (983) top up OpenStreetMap stops per block; Pune transit access rises from 65% to 92% of residents, Mumbai from 92% to 98% (OpenCity, public domain) | OpenCity | `bus_stops_official` dataset (pipeline/traffic/official_stops.py), merged in the transit loader
171. ✅ Police station per block for Mumbai, Bengaluru and Hyderabad (OpenCity jurisdiction maps, public domain), in DISHA 'which police station is this?' and the property report | OpenCity | `police_stations` dataset (pipeline/realestate/police.py)
172. ✅ Lok Sabha 2024 results per block: MP and party, margin, and assembly-segment EVM turnout, leading party and NOTA for all 13 cities (ECI via OpenCity, public domain); DISHA names the MP | OpenCity | `turnout` lens (new dataset `elections_2024`, pipeline/realestate/elections.py)
173. ✅ Anganwadi reach: ICDS centre maps for Hyderabad (Telangana), Bengaluru (Karnataka KGIS) and Chennai, walking distance for children under five and new-centre picks (OpenCity, public domain) | OpenCity | `anganwadi` lens (new dataset `anganwadis`, pipeline/realestate/anganwadis.py)
174. ✅ Free clinic reach: corporation UPHCs, Namma Clinics and health centres for Chennai, Bengaluru and Hyderabad, walking distance and new-clinic picks (OpenCity, public domain) | OpenCity | `freeclinic` lens (new dataset `public_care`, pipeline/realestate/publiccare.py)
175. ✅ Municipal tree census: Pune 2019 (about 4 million trees with girth, canopy, condition) and BBMP Bengaluru 2026, trees per resident, invasive and single-species blocks, big trees, planting picks (OpenCity, public domain) | OpenCity | `treecensus` lens (new dataset `tree_census`, pipeline/realestate/treecensus.py)
176. ✅ Fire station reach: fire services' own station maps for Mumbai, Pune, Hyderabad and Bengaluru topping up OpenStreetMap/Overture counts in every fire lens, distance to the nearest station and new-station picks (OpenCity, public domain) | OpenCity | `firereach` lens (new dataset `fire_stations_official`, pipeline/realestate/firestations.py)
177. ✅ Street light poles: BBMP 2024 pole survey for four Bengaluru zones (1.9 lakh poles, LED share), poles per street km and dark-street picks (OpenCity, public domain) | OpenCity | `streetpoles` lens (new dataset `street_lights`, pipeline/realestate/streetlights.py)
178. ✅ Public libraries: Pune list (54) and Karnataka Department of Public Libraries' Bengaluru map (105) topping up `places.libraries` for the cooling-centre lens (OpenCity, public domain) | OpenCity | loader top-up (new dataset `libraries_official`, pipeline/realestate/libraries.py)
179. ✅ Mumbai schools: BMC education department maps (1,134 municipal, 404 aided, 709 unaided) topping up `emergency_access.schools` for the school gap, school-run and relief-camp lenses (OpenCity, public domain) | OpenCity | loader top-up (new dataset `schools_official`, pipeline/realestate/bmcschools.py)
180. ✅ Water bodies census: Jal Shakti's first Census of Water Bodies (2023) for Delhi, Kolkata, Hyderabad and Bengaluru, ponds not in use or encroached, ownership, storage, revival picks (OpenCity, public domain) | OpenCity | `pondcensus` lens (new dataset `water_bodies`, pipeline/realestate/waterbodies.py)
181. ✅ Subsidised canteen reach: Indira Canteens (Bengaluru), Amma Unavagams (Chennai) and Annapurna centres (Hyderabad), walking distance for residents and slum residents, new-canteen picks (OpenCity, public domain) | OpenCity | `canteen` lens (new dataset `canteens`, pipeline/realestate/canteens.py)
182. ✅ Sewer gaps: BWSSB sewerage line maps for Bengaluru (about 10,400 km of pipe), residents with no sewer nearby or thin coverage, next-sewer picks (OpenCity, public domain) | OpenCity | `sewergap` lens (new dataset `sewers`, pipeline/realestate/sewers.py)
183. ✅ Planned road widening: BDA RMP 2015 road width map for Bengaluru (2,138 km with planned widths, 541 km of proposed links), residents on roads planned 24 m+ and blocks new links cross (OpenCity, public domain) | OpenCity | `roadplan` lens in the new js/urban-lenses-civic.js module (new dataset `road_plan`, pipeline/realestate/roadplan.py)
184. ✅ Hyderabad community halls: GHMC's 2018 map (1,264 in the region) topping up `places.community_centres`; Hyderabad's hot-quarter residents with no cooling-centre candidate within 1 km fall from 29.3% to 11.5% (OpenCity, public domain) | OpenCity | loader top-up (new dataset `community_halls`, pipeline/realestate/communityhalls.py)
185. ✅ Cremation and burial grounds: BMC, PMC, GCC and BBMP maps (Mumbai 189, Pune 76, Chennai 210, Bengaluru 80), distance, residents per site, electric or gas crematoriums, new-site picks (OpenCity, public domain) | OpenCity | `lastrites` lens in js/urban-lenses-civic.js (new dataset `funeral_sites`, pipeline/realestate/funeral.py)
186. ✅ Borewells beside septic tanks: BWSSB public borewell map (about 7,200 wells) crossed with the sewer network; 12% of public borewells stand where sewers are missing or thin (OpenCity, public domain) | OpenCity | `wellrisk` lens in js/urban-lenses-civic.js (new dataset `borewells`, pipeline/realestate/borewells.py)
187. ✅ Waste bin reach: GCC street bins (Chennai 2022, 8,130 in the region) and GHMC dumper bins (Hyderabad 2018, 2,505), residents with no bin within 250 m (Chennai 13%, Hyderabad 38%) (OpenCity, public domain) | OpenCity | `binreach` lens in js/urban-lenses-civic.js (new dataset `waste_bins`, pipeline/realestate/wastebins.py)
188. ✅ Large-project pipeline: SEIAA Karnataka construction projects with environmental clearance in Bengaluru Urban (598 projects of 20,000 m²+, 397 residential, 158 commercial by name), projects within 2 km per block (47% of residents live with 5 or more nearby; top clusters in the east around Hoodi and Kundalahalli) (KGIS via OpenCity, public domain) | OpenCity | `bigprojects` lens in js/urban-lenses-civic.js (new dataset `big_projects`, pipeline/realestate/seiaa.py)
189. ✅ Coastal and eco-sensitive building limits: Chennai Coastal Regulation Zone rebuilt from Tamil Nadu's official CRZ line (24 km² incl. the Adyar, Cooum and Buckingham Canal strips; 3.9 lakh residents, 4.5%, and 6.5 km² built-up inside) and Bengaluru's Bannerghatta eco-sensitive zone and protected areas (Karnataka Forest Department 2022; barely inside the city region) (TNGIS and KFD via OpenCity, public domain) | OpenCity | `buildlimits` lens in js/urban-lenses-civic.js (new dataset `eco_limits`, pipeline/realestate/ecolimits.py)
190. ✅ Police station reach: official station maps for Mumbai (Mumbai Police, 101), Bengaluru (Karnataka Police KGIS, 115 stations and 12 outposts) and Hyderabad (Telangana Police, 84 law-and-order stations after dropping traffic stations, quarters and offices by name; UTM 44N converted), judged inside each city police's jurisdiction map; residents more than 2 km from a station: Mumbai 4.7%, Bengaluru 11%, Hyderabad 19%. Also tops up `places.police` for the services and flood-safety lenses (OpenCity, public domain) | OpenCity | `policereach` lens in js/urban-lenses-civic.js (new dataset `police_official`, pipeline/realestate/police.py)
191. ✅ Lake buffer building: Karnataka GIS wetland map of Bengaluru Urban (265 lakes and tanks, 47 km²) filled on a 10 m raster with 30 m (zoning no-build buffer) and 75 m (NGT 2016, set aside in 2019) rings; about 1.35 km² of the 10.7 km² 30 m buffer is built up (12.6%, pro rata), home to some 38,000 residents (KGIS via OpenCity, public domain) ; extended to Hyderabad with GHMC's 849 reservoirs and tanks under GO Ms 168 (30 m round tanks of 10 ha or more, 9 m round smaller): about 2.2 km² of the 11 km² buffer built up (20%), some 78,000 residents | OpenCity | `lakebuffer` lens in js/urban-lenses-civic.js (new dataset `lake_buffers`, pipeline/realestate/lakebuffers.py)
192. ✅ Neighbourhood park reach: GHMC parks (821), playgrounds (488) and layout open spaces (1,353), 2018, for Hyderabad and PMC garden outlines (198, about 200 ha, 0.35 m² per resident) for Pune; residents with no listed park or playground within 500 m: Hyderabad 41%, Pune 53%; Hyderabad picks are reserved layout open spaces beside the most unserved homes (OpenCity, public domain) ; Mumbai added with BMC's 950 gardens, parks, play grounds and zoos, judged inside the BMC area (19% of residents with none within 500 m) | OpenCity | `parkreach` lens in js/urban-lenses-civic.js (new dataset `parks_official`, pipeline/realestate/parksofficial.py)
193. ✅ Storm-water drain buffers: BBMP's 2022 primary (329 km), secondary (440 km) and tertiary (1,222 km) drain maps on a 10 m raster with the Revised Master Plan 2015 buffer (50, 25 and 15 m from the centre) and the NGT 2016 buffer (50, 35 and 25 m, set aside by the Supreme Court in 2019); 114.5 km² of buffer, about 29% built up (pro rata), some 17 lakh residents (OpenCity, public domain) | OpenCity | `drainbuffer` lens in js/urban-lenses-civic.js (new dataset `drain_buffers`, pipeline/realestate/drainbuffers.py)
194. ✅ Birdlife: GBIF bird records since 2015 under CC0 or CC BY 4.0 (eBird, iNaturalist; BY-NC left out) per ~1 km block, one faceted search per block, with richness rarefied to 200 records; Bengaluru 33 lakh records (median 57 species in 200 records), Delhi 14.5 lakh (Okhla and Basai lead), now all 12 cities; 14-67% of residents live in blocks with under 20 records (GBIF, CC BY 4.0) | GBIF | `birdlife` lens in js/urban-lenses-civic.js (new dataset `birds`, pipeline/realestate/birds.py)
195. ✅ Sewer gaps for Chennai and Pune: CMWSSB sewer main network (about 4,200 km) and the sewers in PMC's drainage map (about 2,190 km) added to `sewers`, judged only inside the corporation's wards; residents with no sewer within 250 m: Bengaluru 6%, Chennai 9.8%, Pune 5.2%; HMWSSB's core-city sewer lines for Hyderabad (3,260 km, judged inside the 72 mapped sections: 0.5%) (OpenCity, public domain) | OpenCity | `sewergap` lens now covers Bengaluru, Chennai, Pune and core Hyderabad
196. ✅ Storm-drain gaps on wet streets: GCC's 2023 storm-water drain map for Chennai (2,225 km, mostly covered) and the storm drains and nalas in PMC's drainage map for Pune (1,122 km and 404 km) against OpenStreetMap street length, crossed with the waterlogging index and reported flood spots; residents where drains run along under 30% of the streets and the block pools water: Chennai 37%, Pune 19% (OpenCity, public domain). BBMP's maps hold only Bengaluru's major drains, so Bengaluru is not judged | OpenCity | `stormgap` lens in js/urban-lenses-civic.js (new dataset `storm_drains`, pipeline/realestate/stormdrains.py)
197. ✅ Piped water gaps: BWSSB's detailed water supply line maps for Bengaluru (10,800 km of lines up to 300 mm, 940 km of mains); 3.8% of residents inside the corporation have no water line within 250 m and 12.6% live where lines run along under 30% of the streets; 3.1 lakh have neither a water line nor a sewer nearby (OpenCity, public domain) | OpenCity | `watergap` lens in js/urban-lenses-civic.js (new dataset `water_lines`, pipeline/realestate/waterlines.py)
198. ✅ Sewage treatment plants nearby: BWSSB's 39 plants with capacity (Bengaluru, 1,372 MLD), CMWSSB's plant outlines (Chennai, 8) and PMC's existing (9, 477 MLD) and proposed (8) plants (Pune); residents within 500 m of a plant (Bengaluru 1.4%, Pune 1.8%, Chennai 0.9%) and rated capacity against the sewage residents make at 108 litres a head a day (Bengaluru 96%, Pune 69%) (OpenCity, public domain) | OpenCity | `stpnear` lens in js/urban-lenses-civic.js (new dataset `stps`, pipeline/realestate/stps.py)
199. ✅ Basic services together: crosses the agencies' water line, sewer, storm drain, public bin and public toilet maps already in the cells; residents inside the corporation short of two or more mapped networks nearby: Bengaluru 2.4%, Chennai 8%, Pune 3.1%, core Hyderabad 2.1% (OpenCity, public domain) | OpenCity | `basics` lens in js/urban-lenses-civic.js (no new dataset)
200. ✅ Property registration offices: the sub-registrar office (and district registrar) for every lived-in block from the Karnataka and Tamil Nadu registration jurisdiction maps, distance to it, residents per office (Bengaluru 43 offices, median 1.5 lakh residents each; Chennai 29, median 2.6 lakh) (OpenCity, public domain) | OpenCity | `sroload` lens in js/urban-lenses-civic.js (new dataset `registration`, pipeline/realestate/registration.py)
201. ✅ Pincode crowding: the India Post 2025 pincode for every lived-in block in all 12 cities, its post office, postal division and area, and residents per pincode (Delhi median 1.3 lakh, 31% of residents in pincodes over 5 lakh people; Bengaluru 16.5%; Chennai none) (OpenCity, public domain) | OpenCity | `pinsize` lens in js/urban-lenses-civic.js (new dataset `pincodes`, pipeline/realestate/pincodes.py)
202. ✅ Pothole complaints: BBMP Fix My Street pothole and road-cut complaints for May-June 2022 per block, fixed share, road surface and repair estimate (Bengaluru: 13,444 accepted, 19.5% fixed by end of June, 18% utility road cuts, ₹4.6 crore of repairs) (OpenCity, public domain) | OpenCity | `potholes` lens in js/urban-lenses-civic.js (new dataset `potholes`, pipeline/realestate/potholes.py)
203. ✅ Revenue villages: the Survey of India revenue village, tehsil and district for every lived-in block (the names land records are filed under) in Delhi, Bengaluru, Pune, Ahmedabad and Kolkata, with town and cantonment limits marked, and residents per old village (Delhi: 347 villages, 72 now home to more than 1 lakh people) (OpenCity, public domain) | OpenCity | `revvillage` lens in js/urban-lenses-civic.js (new dataset `villages`, pipeline/realestate/villages.py)
204. ✅ BDA layouts: the Bangalore Development Authority layout for every block (lived-in or empty), its code and area, with build-out and filling speed per layout (58 layouts, about 184 km², 29% of Bengaluru's residents; emptiest large layout 7.7% built over) (OpenCity, public domain) | OpenCity | `bdalayout` lens in js/urban-lenses-civic.js (new dataset `bda_layouts`, pipeline/realestate/bdalayouts.py)
205. ✅ Paved-over watersheds: the Watershed Atlas micro-watershed for every block in Bengaluru, Chennai, Delhi, Hyderabad, Kolkata, Mumbai and Pune, and how much of each is built over, classed by the Impervious Cover Model (Chennai 26 of 37 past 25%; Bengaluru 47 of 115; Delhi 106 of 326) (OpenCity, public domain) | OpenCity | `watershedpave` lens in js/urban-lenses-civic.js (new dataset `watersheds`, pipeline/realestate/watersheds.py)
206. ✅ Student housing near colleges: Karnataka's 2023 college maps for Bengaluru Urban (706 PU, 371 degree, 97 engineering, 70 polytechnic, 24 universities) per block, and where college pull within 2 km outruns the hostels and PGs Overture lists (biggest clusters around Basavanagudi and V.V. Puram; gaps at the southern and northern edges) (OpenCity, public domain) | OpenCity | `studenthousing` lens in js/urban-lenses-civic.js (new dataset `colleges`, pipeline/realestate/colleges.py)
207. ✅ Official land use 2017: KSRSAC's urban land use map of the BBMP area sampled per block into residential, commercial, industrial, vacant, civic, green, farm, water and road shares, and 2017 vacant land checked against building since (94.5 km² vacant or unbuilt layouts in 2017; 205 of 1,438 mostly-vacant blocks added few or no buildings since 2016) (OpenCity, public domain) | OpenCity | `vacant2017` lens in js/urban-lenses-civic.js (new dataset `landuse_2017`, pipeline/realestate/landuse2017.py)
208. ✅ Land converted 2011-2017: KSRSAC's 2011 land use map of the BBMP area sampled per block like the 2017 one, and the vacant and farm land that turned into other uses between them (162.6 km² to 98.8 km²; 79.4 km² converted, mostly to homes; 21 km² of green ground lost) (OpenCity, public domain) | OpenCity | `landchange` lens in js/urban-lenses-civic.js (new dataset `landuse_2011`, pipeline/realestate/landuse2017.py --year 2011)
209. ✅ Ward and utility boundaries: the BESCOM section and BWSSB service station (Bengaluru) or TNEB section and CMWSSB depot (Chennai) serving every lived-in block, and how many electricity, water and police units each ward is split across (Chennai: 63% of residents live in wards split across 4 or more electricity sections; Bengaluru's most split ward deals with 25 offices) (OpenCity, public domain) | OpenCity | `wardfit` lens in js/urban-lenses-civic.js (new dataset `service_areas`, pipeline/realestate/serviceareas.py)
210. ✅ Police station per block for Chennai: Greater Chennai Police jurisdictions (222 outlines, 106 stations over 6,600 lived-in blocks) added to `police_stations`, which also restores its pipeline (pipeline/realestate/policejuris.py; the code had been overwritten by the station-points module), and Chennai's wards now count police stations in `wardfit` (median ward: 3; Royapuram's Ward 63: 6) (OpenCity, public domain) | OpenCity | `police_stations` dataset, `wardfit` lens
211. ✅ Metro frequency and reach: Hyderabad Metro Rail's own GTFS timetable (July 2026) binned per block (platforms, lines, weekday departures, peak gap between trains), and residents within 800 m of a station by peak wait (19% of residents within 800 m; the Green line runs every 12 minutes at peak against 2 to 4 on the busiest Red line platforms) (OpenCity, public domain) | OpenCity | `metrowait` lens in js/urban-lenses-civic.js (new dataset `metro_service`, pipeline/traffic/metro_gtfs.py)
212. ✅ Namma Metro frequency: the BMRCL timetable (community GTFS from BMRCL's published headways, August 2026, ODbL) added to `metro_service` for Bengaluru (101 station blocks; 27.4 lakh residents, 21%, within 800 m; only 5.6 lakh of them with a train every 5 minutes at peak; Peenya and Nagasandra-end stations every 11 minutes) | github.com/Vonter/bmrcl-gtfs | `metrowait` lens
213. ✅ Survey parcel size and public land: GHMC town survey (Hyderabad), KGIS BBMP-area revenue survey (Bengaluru) and PMC revenue (Pune) cadastral maps per block into `cadastre` (parcels, median parcel m², government or kharab land %); Hyderabad median block 507 m² parcels (~20 owners per hectare), 39.8 km² government land; Bengaluru 1.8 ha survey numbers, 41 km² kharab; Pune 4 ha gut numbers | data.opencity.in (public domain) | `landgrain` lens
214. ✅ Official flood hazard zones and return periods for Chennai: the flood inundation hazard map (five classes) and the 5 to 200-year return-period flood extents per block into `flood_zones`; 9.2 lakh residents in Very High or High hazard zones, 17.8 lakh inside the 5-year extent, 41.6 lakh inside the 100-year extent (8.6 lakh in its deepest class) | data.opencity.in chennai-flooding-data (public domain) | `floodzones` lens
215. ✅ Groundwater depth and prospects: CMWSSB ward-well depths for Chennai (May and December 2023, March 2021 to 2024 change; median resident 5 m before the monsoon, 15.7 lakh where it was 8 m or deeper) and the Bengaluru groundwater prospect map (outskirts; the built core is masked) into `groundwater_local` | data.opencity.in (public domain) | `gwdepth` and `gwprospect` lenses
216. ✅ Pune public clinics: PMC's list of its dawakhanas, health centres (32) and maternity homes (16) with coordinates added to `public_care`; `freeclinic` now covers Pune (28.6 lakh residents, 64%, more than a 1 km walk from a listed PMC centre) | data.opencity.in pune-healthcare-hospitals-and-clinics (public domain) | `freeclinic` lens
217. ✅ Homes versus workplaces for all 13 cities: JRC GHS-BUILT-C 2018 (10 m) per block into `built_class` (non-residential share of built-up ground, buildings over 15 m, roads, open green), checked against Overture businesses; mostly residential pockets hold about a quarter of residents in Bengaluru and Delhi | Earth Engine JRC/GHSL/P2023A/GHS_BUILT_C (CC BY 4.0) | `homeswork` lens
218. ✅ Air quality monitor gaps: TSPCB (Hyderabad) and KSPCB (Bengaluru) air and noise monitoring stations per block into `air_monitors`; half of Bengaluru's residents and 84% of Hyderabad's live more than 2 km from any station; new-station picks weighted by satellite PM2.5 | data.opencity.in (public domain) | `airmonitorgap` lens
219. ✅ Chennai bus frequency: MTC timetables (community GTFS from the MTC app, UngalSoththu ChennaiGTFS, ODbL/PDDL, April 2026; 5,580 stops, 47,047 weekday trips) binned into `bus_service`; 1,597 Chennai blocks have a bus every 10 minutes or better at peak, and busgap now tests Chennai corridors on real frequency | github.com/ungalsoththu/ChennaiGTFS | `busgap` and `transit` lenses
220. ✅ Bus timetables for Pune, Ahmedabad and Mumbai: community GTFS by croyla (PMPML, AMTS with Janmarg BRTS, BEST with TMT/KDMT/VVMT; MIT and MIT-0, Aug-Oct 2026) binned into `bus_service` (Pune 3,945 blocks with stops, Ahmedabad 2,746, Mumbai 3,537) and merged into the bus stop heat points (Pune 552 to 2,320 stops, Ahmedabad 78 to 2,008, Mumbai 1,856 to 4,985) | github.com/croyla | `busgap`, `transit` and bus stop heat lenses
221. ✅ Leaving government schools: UDISE+ 2021-22 district files joined to 2024-25 by PIN code; `schools_udise` gains govt_share_pct and govt_share_change_pp (shares, not counts, because UDISE+ switched to verified pupil records in 2022-23). Delhi's share fell 6.2 points, Hyderabad's 4.9; Kolkata's rose 2.7 | data.opencity.in UDISE+ | `schooldrift` lens
222. ✅ Wind near the ground: Global Wind Atlas 3 (DTU/World Bank, CC BY 4.0, 250 m) mean wind at 10 m and 100 m for all 13 cities as `wind` (wind10_ms, wind100_ms, wind_kept_pct). 88% of Delhi's residents live in light air under 2 m/s against 4% of Bengaluru's | Earth Engine (awesome-gee-community-catalog) | `stillair` lens (stillest fifth on the heaviest road exhaust)
223. ✅ Solar output per block: Global Solar Atlas 2 (World Bank/Solargis, CC BY 4.0, about 1 km) PV output per kWp, irradiation and worst-month share for all 13 cities as `solar_atlas`; the rooftop solar and home solar lenses now use it instead of one city irradiance × 0.75 (Delhi 1,479 kWh/kWp against 1,339 before, Mumbai 1,611 against 1,448; monsoon worst month 47% of the best in Mumbai) | Earth Engine (awesome-gee-community-catalog) | `solar`, `solarhome` lenses
224. ✅ Bad-air days: GHAP daily PM2.5 (Wei et al., CC BY 4.0, 1 km, 2017-2022) counted per block for all 13 cities as `pm25_days` (days over 60, 90 and 120 µg/m³ in 2022, mean, worst-5% day, days over 60 in 2017 and the change). The average Delhi resident had 243 days above the 24-hour standard in 2022, Kolkata 144, Bengaluru 5 | Earth Engine (awesome-gee-community-catalog) | `badairdays` lens
225. ✅ Floods in the news: Google Research's Groundsource (2026, CC BY 4.0; Gemini-extracted, geocoded news flood records 2000 to March 2026) kept at street and neighbourhood scale (up to 2 km²) and counted as distinct days per block for all 13 cities as `news_floods` (Mumbai 646 blocks, Delhi 1,378, Hyderabad 1,250); top Mumbai spots are Kondivita (Andheri-Kurla Road), Parel-Hindmata and Matunga East | Earth Engine (awesome-gee-community-catalog) | `floodnews` lens
226. ✅ How neighbourhoods were built: WRI Global Intra-Urban Land Use (2020, 5 m, CC BY 4.0) per block for all 13 cities as `urban_form` (unplanned, informal subdivision, formal subdivision and housing-project shares of residential ground; open, non-residential and road shares). Residents in mostly unplanned or informal blocks: Kolkata 78%, Delhi 35%, Bengaluru 32% (revenue-layout style informal plots), Mumbai 21%; roads take about half the ground they do in planned blocks | Earth Engine | `howbuilt` lens
227. ✅ Hot nights: NASA ECOSTRESS land surface temperature at 70 m on cloud-free April-June nights (21:30 to 05:30 IST, 2023-2025; public domain) per block for all 13 cities as `night_heat` (median night LST, difference from the region's median block, scene count). The space station's drifting orbit gives the night passes Landsat and MODIS miss. Residents 1 °C or more above the median resident's night: Chennai 17.5%, Hyderabad 16.4%, Delhi 15.8% (old city, Karol Bagh, Shahdara), Bhopal 15.5%, Mumbai 1.6%; Delhi's homes sit 2 °C above the wider region's median block | Earth Engine | `hotnights` lens
228. ✅ Big roads to come: Greater Bengaluru Authority's eleven planned elevated corridors (August 2026 list, tenders floated; OpenCity alignment KMLs, public domain) as `new_roads` (distance to the nearest alignment for blocks within 3 km, alignment length per block, nearest corridor). 56.6 km on the Bengaluru map; 3.2 lakh residents in the blocks it crosses and 12.9 lakh within 500 m, most along Yeshwanthapura–Old Madras Road; 16,149 census trees in the crossed blocks. The producer also reads MSRDC's Pune Outer Ring Road EIA alignments, but they fall almost entirely outside the Pune map | OpenCity | `newroads` lens
229. ✅ Rain gauge gaps: KSNDMC telemetric rain gauges and weather stations (KGIS maps on OpenCity, public domain) as `rain_gauges` for Bengaluru: 133 gauges and 11 stations on the map, one per 92,000 residents; 5.5 lakh residents (4.1%) live more than 2 km from one, and 60 of the 1,575 blocks near a reported flood spot are beyond reach of a gauge, clustered around Varthur, Whitefield and Panathur | OpenCity | `raingaugegap` lens
230. ✅ More bus stops: Greater Hyderabad's TGSRTC stop map (5,028 stops, OpenCity, public domain) joins the operator stop lists that top up OpenStreetMap in the transit lenses; Chennai's MTC GTFS stops now feed bus stop heat (207 mapped stops to 2,290; 71% sit at 40+ °C with under 10% canopy). The scheduled CI refresh had been dropping GTFS stops whenever a feed was unreachable from the runner (Ahmedabad fell to 178 stops, Pune 552, Mumbai 1,856); a source that comes back empty now keeps its last stops, and the three cities are restored (2,037, 2,320 and 4,985) | OpenCity, GTFS | `transit`, `busheat`, `busgap` lenses
231. ✅ Afternoon peak heat: NASA ECOSTRESS land surface temperature on cloud-free April-June afternoons (11:30 to 16:30 IST, 2018-2025; 70 m, public domain) for all 13 cities as `pm_heat`, the hottest hours that the late-morning Landsat and MODIS passes miss (Delhi's median block 43.8 °C). Hot nights now shows overnight cooling: homes cool 18.2 °C from afternoon to night in Delhi, 13 °C in Bengaluru and 7.9 °C in Kolkata, and the hottest-night blocks cool less everywhere (Kolkata 4.8 °C, Bengaluru 11.8 °C) | Earth Engine | `hotnights` lens
232. ✅ TB care reach: Karnataka health department TB units, CBNAAT rapid test sites, drug-resistant and district TB centres and nutrition rehabilitation centres (KGIS maps on OpenCity, public domain) as `tb_care` for Bengaluru: 22 TB units on the map (one per 6 lakh residents), concentrated in the core; 51 lakh residents (38.5%) and 26% of mapped-slum residents live more than 3 km from one, and only 3 sites run CBNAAT | OpenCity | `tbcare` lens
233. ✅ Official parking lots: BMC's public parking lots with stated capacity (89 lots, 62,051 vehicle spaces; OpenCity, public domain) in data/vectors/parking_lots_official_mumbai.geojson (`python -m pipeline.traffic.parking --official`); a block takes the larger of the official capacity and the mapped-lot estimate. Mumbai's demand in overflowing streets falls from 49.9% to 48.9% (shipped in commit cc5e6ad with item 232) | OpenCity | `parking` lens
234. ✅ Hyderabad schools: the Telangana school education department map (43,242 schools with management; OpenCity, public domain) joins `schools_official` for Hyderabad: 5,984 schools on the map (1,337 government, 273 aided, 4,348 private unaided), lifting the school-run, school-safety and relief-camp lenses to 7,424 mapped schools. Checked and skipped: Bengaluru parking lot maps (OpenStreetMap extracts), Chennai schools, parks, fire and police maps (no licence set) | OpenCity | `schoolsafe`, `schoolrun`, `refuge` lenses
235. ✅ Citizen service centres: Karnataka's Common Service Centre and Grama One maps for Bengaluru Urban (OpenCity, public domain; coordinates only, operator names and phones never read) become `service_centres` (1,431 CSCs and 77 Grama One centres in 1,267 blocks) and the `servicecentres` lens: one centre per 8,788 residents, 4 lakh residents (3.1%) and 6.4% of residents aged 60+ more than 1 km from one; new centre picks led by Doddabettahalli and Sadashiva Nagara | OpenCity | `servicecentres` lens
236. ✅ Bengaluru Business Corridor: BDA's Peripheral Ring Road right of way (October 2022 alignment, 73 km, land acquisition under way in 2026; OpenCity, public domain) joins `new_roads`, read as a polygon outline whose length counts once; the `newroads` lens now covers 129.6 km of planned road with 15.6 lakh residents within 500 m (2.8 lakh along the PRR). Checked and skipped: STRR alignments (Satellite Town Ring Road runs outside the Bengaluru map), Goregaon-Mulund Link Road (only afforestation-site KMLs) | OpenCity | `newroads` lens
237. ✅ Chennai TB and Aadhaar centres: Greater Chennai Corporation's TB centre map (35 in the region) joins `tb_care` and the Chennai Aadhaar enrolment centre map (49) joins `service_centres` (new field `aadhaar`; OpenCity, public domain), so `tbcare` (12.9% of residents more than 3 km from a TB centre) and `servicecentres` (72.5% more than 1 km from an Aadhaar centre) now cover Chennai. Checked and skipped: gridded electricity consumption (Chen et al. 2022, CC BY 4.0; spreads state totals by night light and put Mumbai at 308 kWh per resident, about a third of real use), GlobalBuildingAtlas heights (CC BY-NC), Hyderabad EV charger consumption (no coordinates), Karnataka NGO map (sector codes without a legend) | OpenCity | `tbcare`, `servicecentres` lenses
238. ✅ NPKG Layout arterial road: BDA's 11.4 km major arterial road through Nadaprabhu Kempegowda Layout (alignment map with the 2023 forest-land requests; OpenCity, public domain) joins `new_roads` as kind 3, taking `newroads` to 141 km of planned road with 15.8 lakh residents within 500 m. Checked and skipped: Greater Hesaraghatta grassland conservation reserve (2025 notification; lies almost wholly north of the Bengaluru map) | OpenCity | `newroads` lens
239. ✅ Recycling reach: BBMP Reduce-Reuse-Recycle centres and KSPCB e-waste collection centres (Bengaluru, 51) and Greater Chennai Corporation's resource recovery centres (53) plus its compost yards and biogas plants (168), OpenCity, public domain, become `waste_recovery` and the `recycling` lens: 71% of Bengaluru's and 79% of Chennai's residents live more than 1 km from a drop-off centre, and 10 lakh Chennai residents (11.5%) within about 250 m of a processing site. Checked and skipped: BBMP dry waste collection centre maps (no licence), Pune waste disposal sites (no coordinates), KSPCB biomedical waste facilities (all outside the Bengaluru map) | OpenCity | `recycling` lens
240. ✅ Public land bank: the Greater Bengaluru Authority's 2026 property register (6,817 properties; OpenCity, public domain), keeping the 2,792 placed on the plot (the rest stack on about 200 ward points), becomes `public_land` with vacant and service plots matched from the Kannada descriptions, and the `publicland` lens: 484 ha placed, 212 vacant plots (28 ha) within 500 m of 30.8 lakh residents, 82 of them where there is no public clinic within 1 km or no anganwadi within 500 m, with plots to put to use. Checked and skipped: BBMP trade licences (owner-level rows, no coordinates), water heritage sites (one to three per city), Chennai water transmission mains (trunk lines only) | OpenCity | `publicland` lens

## Parked for the keys round

Items 11, 13, 46, 66 (Delhi), 71, 85 need keys or logins. Collect them with IMD, OpenAQ and the GEE repo secret.
