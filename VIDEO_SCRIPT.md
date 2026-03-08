# DigiPin Urban Intelligence — Video Walkthrough Script

## Video Title
**"DigiPin Urban Intelligence: Complete Feature Walkthrough"**

**Duration:** ~8-10 minutes
**Format:** Screen recording with narration
**Resolution:** 1920×1080 (Full HD)
**Tool:** OBS Studio / Loom / browser-based recorder

---

## PRE-RECORDING CHECKLIST

- [ ] Open dashboard at `http://localhost:5500` or deployed URL
- [ ] Set browser to full-screen (F11)
- [ ] Start on Indore city (default)
- [ ] Ensure Ollama is running (for DISHA demo)
- [ ] Clear browser localStorage (fresh start)
- [ ] Close all floating panels
- [ ] Zoom to level ~14 for good grid visibility

---

## SCENE 1: OPENING & OVERVIEW (0:00 – 0:30)

### Visual
- Dashboard loads, map centered on Indore
- Grid cells visible, subtle cyan outlines
- Top bar with logo, city selector, search bar
- Sidebar with "Urban Queries" visible

### Narration
> "Welcome to DigiPin Urban Intelligence — India's first hyper-local urban analytics platform. DigiPin divides every square meter of Indian cities into uniquely addressable grid cells, each enriched with over 160 real-time data features. Let's explore what this platform can do."

### Actions
1. Let dashboard load fully (wait for grid to render)
2. Slowly pan the map to show grid cells
3. Brief pause on the logo "DigiPin Intelligence"

---

## SCENE 2: CITY SELECTOR (0:30 – 0:50)

### Visual
- Click city dropdown → show 12 cities
- Select "Bengaluru" → map flies smoothly

### Narration
> "The platform covers 12 major Indian cities. Select any city — the map instantly flies to its center. Each city has full coverage with all 160+ urban features pre-indexed."

### Actions
1. Click city dropdown
2. Hover over a few options (Pune, Jaipur)
3. Click "Bengaluru" — map animates
4. Show the toast notification
5. Switch back to "Indore" for rest of demo

---

## SCENE 3: SEARCH — DigiPin Code & Place Name (0:50 – 1:20)

### Visual
- Type a DigiPin code in search → map flies to cell
- Type a place name → map flies to location

### Narration
> "Search works two ways. Enter a DigiPin code — like '3MC-88P-JL2J' — and the map flies directly to that exact cell. Or search by place name — type 'Rajwada' — and it geocodes the location and shows the matching DigiPin."

### Actions
1. Click search input
2. Type a valid DigiPin code → press Enter
3. Show map flying to the cell + toast
4. Clear search, type "Rajwada" → press Enter
5. Show map flying to location + toast with DigiPin

---

## SCENE 4: GRID CELL SELECTION & DETAIL PANEL (1:20 – 2:30)

### Visual
- Click a grid cell → detail panel opens
- Scroll through scores, features, action buttons

### Narration
> "Click any grid cell to unlock its intelligence profile. The detail panel shows the cell's DigiPin code, GPS coordinates, and reverse-geocoded address. Below that, you'll see over 30 intelligence scores — livability, safety, green index, walkability, healthcare access, food diversity, and many more. Each score is computed from real-time OSM, government, and sensor data."

> "Scroll down to see feature categories — food & dining, education, healthcare, transport, shopping — each with exact counts of nearby amenities. These aren't estimates — they're actual POI counts within the cell's radius."

### Actions
1. Click a grid cell (choose one in a busy area)
2. Panel opens — pause on DigiPin code + coordinates
3. Slowly scroll to show intelligence scores (bars + values)
4. Pause on a high score (e.g., Food Diversity: 85)
5. Scroll to feature categories
6. Expand "Food & Dining" to show individual counts
7. Expand "Healthcare" to show hospitals, clinics count

---

## SCENE 5: ACTION BUTTONS — SCORES DIALOG (2:30 – 3:00)

### Visual
- Click "Scores" button → radar chart appears
- Interactive radar showing all dimensions

### Narration
> "The Scores dialog visualizes all intelligence dimensions as an interactive radar chart. This gives you an instant visual fingerprint of any location — you can immediately see if a cell excels in connectivity but lacks green space, or has high commercial activity but low safety scores."

### Actions
1. Click "Scores" button in detail panel
2. Scores dialog opens with radar chart
3. Hover over chart axes to show values
4. Scroll down to see all scores listed
5. Close dialog

---

## SCENE 6: BUILDING INTELLIGENCE (3:00 – 3:40)

### Visual
- Click "Building Intelligence" → dialog opens
- Show LCZ classification, building metrics, height distribution

### Narration
> "Building Intelligence aggregates structural data from Google Open Buildings and Overture Maps. It shows the Local Climate Zone classification — like 'Compact Midrise' — along with key metrics: building count, average height, floor count, ground coverage, FSI, and development potential scores. This data helps urban planners understand the built form of any micro-area."

### Actions
1. Click "Building Intelligence" button
2. Dialog opens — pause on LCZ badge
3. Show key metrics grid (buildings, height, floors, coverage)
4. Scroll to development metrics
5. Close dialog

---

## SCENE 7: 3D BUILDINGS & ROADS (3:40 – 4:30)

### Visual
- Click Buildings button → 3D mode activates
- Tilt map to show 3D extrusions
- Toggle Roads → color-coded network appears

### Narration
> "The Buildings layer renders over 528,000 Overture Maps footprints. In 3D mode, buildings are extruded by their actual height — commercial buildings in blue, residential in red, institutional in purple. Toggle to 2D for flat footprints."

> "The Roads layer visualizes the entire road network color-coded by class — orange motorways, yellow primary roads, cyan tertiary streets, gray residential lanes. This instantly reveals the transportation hierarchy of any area."

### Actions
1. Click Buildings button → "3D" mode
2. Click 3D toggle → map pitches to 60°
3. Right-click drag to rotate — show buildings from angle
4. Zoom into a dense area — show height variation
5. Toggle to "2D" mode briefly
6. Click Roads button → "Color" mode
7. Show the color-coded road network
8. Zoom to show different road classes
9. Toggle to "Minimal" mode briefly

---

## SCENE 8: DATA OVERLAYS — LCZ, LULC, WARDS (4:30 – 5:20)

### Visual
- Toggle LCZ → raster overlay appears
- Toggle LULC → land use classification
- Toggle Wards → administrative boundaries

### Narration
> "Three powerful overlay layers add context. Local Climate Zones from WUDAPT classify urban morphology into 17 types — compact highrise, open lowrise, dense trees, water bodies. This 100-meter resolution data reveals the city's thermal and structural character."

> "ISRO Bhuvan's Land Use Land Cover layer classifies 54 land types at 1:50,000 scale — residential, commercial, agricultural, forested, water bodies — all from India's own satellite program."

> "Ward Boundaries overlay shows administrative divisions fetched from OpenStreetMap, helping correlate urban data with governance units."

### Actions
1. Click LCZ button → raster appears
2. Pan to show different zone colors
3. Turn off LCZ, turn on LULC
4. Show different land use colors
5. Turn off LULC, turn on Wards
6. Click a ward polygon → show name popup
7. Turn off Wards

---

## SCENE 9: LAYERS PANEL — OVERTURE MAPS (5:20 – 6:00)

### Visual
- Open Layers panel → show grouped structure
- Toggle Water Bodies, Land Use, Places/POI

### Narration
> "The Layers panel organizes all overlays into collapsible groups. Under Overture Maps, toggle Water Bodies to see every river, lake, and pond rendered in blue. Land Use shows 11 zoning classes — residential, commercial, industrial, park, forest, and more. Places and POI scatter color-coded markers for every point of interest by category."

### Actions
1. Click Layers button (📊)
2. Panel opens — show expandable groups
3. Expand "Overture Maps" group
4. Toggle "Water Bodies" → blue polygons appear
5. Toggle "Land Use" → colored zones appear
6. Toggle "Places/POI" → markers scatter
7. Toggle each off
8. Close panel

---

## SCENE 10: HEATMAP ANALYSIS (6:00 – 6:40)

### Visual
- Open heatmap dropdown → select "Livability"
- 3D heatmap appears → tilt to show columns

### Narration
> "The 3D Heatmap engine samples 36 points across the visible area, computes the selected score for each, and renders them as extruded columns. Taller columns mean higher scores. Select Livability, Safety, Walkability, or any of the 10 available metrics. This gives you an instant spatial distribution of urban quality — spot the best and worst micro-zones at a glance."

### Actions
1. Click Heatmap button
2. Select "Livability" from dropdown
3. Wait for grid to render (3D columns)
4. Tilt map (3D mode) to show column heights
5. Pan to show variation across area
6. Switch to "Safety" heatmap
7. Show different distribution
8. Clear heatmap

---

## SCENE 11: URBAN QUERIES ENGINE (6:40 – 7:40)

### Visual
- Open sidebar → show 52 queries in 7 sectors
- Run "Best Mall Location" → progress bar → results

### Narration
> "The Urban Query Engine is the platform's analytical brain. It offers 52 pre-configured spatial queries organized in 7 sectors — Commercial, Residential, Infrastructure, Public Services, Tourism, Environment, and Real Estate."

> "Let's run 'Best Mall Location.' The engine analyzes 25 sample points, fetches all 160+ features for each, applies weighted scoring based on commercial activity, connectivity, foot traffic, and population — and ranks the top 10 locations. Watch the progress bar — each point is analyzed in real-time."

> "Results appear in a ranked panel. Click any result to fly to that location. The map also shows a 3D heatmap of the scoring distribution."

### Actions
1. Expand sidebar (if collapsed)
2. Scroll through query sectors — show variety
3. Click "Commercial & Business" sector
4. Click "Best Mall Location" query
5. Show progress bar filling (0% → 100%)
6. Results panel appears — pause on top 3
7. Click result #1 → map flies to location
8. Show 3D heatmap overlay of results
9. Close results panel

---

## SCENE 12: COMPARE & PIN (7:40 – 8:20)

### Visual
- Pin 2-3 cells → colored markers appear
- Open Compare panel → radar chart + table

### Narration
> "The Compare feature lets you evaluate up to 3 locations side by side. Pin cells from their detail panels — each gets a color-coded marker on the map. Open the Compare panel to see a multi-axis radar chart overlaying all pinned cells, plus a detailed score-by-score comparison table. This is invaluable for site selection and investment decisions."

### Actions
1. Click a cell → open detail panel
2. Click "Pin for Compare" → marker appears, badge shows "1"
3. Click another cell → pin it → badge shows "2"
4. Click a third cell → pin it → badge shows "3"
5. Click Compare button
6. Compare panel opens — show radar chart
7. Scroll to comparison table
8. Point out score differences
9. Close compare panel

---

## SCENE 13: WALKABILITY & ISOCHRONE (8:20 – 8:50)

### Visual
- Click "Walkability Radius" → 3 concentric rings appear
- Green (5 min), Yellow (10 min), Red (15 min)

### Narration
> "The Walkability Radius uses OpenRouteService to compute actual walking isochrones — not simple circles, but real route-based zones. The green ring shows what's reachable in 5 minutes walking, yellow in 10 minutes, red in 15. This accounts for actual road networks, not crow-fly distance."

### Actions
1. Open a cell's detail panel
2. Click "Walkability Radius"
3. Isochrone rings render — zoom to show all 3
4. Click a ring → popup shows "10 min walk"
5. Zoom in to show street-level detail of ring boundary

---

## SCENE 14: BOOKMARKS & REPORTS (8:50 – 9:20)

### Visual
- Save a bookmark → open bookmarks panel
- Generate report → new tab with print-ready layout

### Narration
> "Save any location as a Bookmark with a personal note. Bookmarks persist in your browser — open the Bookmarks panel anytime to revisit saved locations."

> "The Report Generator creates a print-ready intelligence profile for any cell — complete with all scores, feature counts, and environmental data. Use your browser's print function to save it as a PDF."

### Actions
1. Click "Save Bookmark" → enter a note → save
2. Click Bookmarks button → show saved list
3. Close bookmarks
4. Click "Generate Report" → new tab opens
5. Show the formatted report (scores, features, address)
6. Brief pause on report layout

---

## SCENE 15: DISHA AI ASSISTANT (9:20 – 9:50)

### Visual
- Click "Ask DISHA" → AI panel opens
- Type a question → streaming response appears

### Narration
> "DISHA is the platform's AI assistant, powered by a local Qwen2.5 language model via Ollama. It has full context of the selected cell — all 160+ features, scores, and building data. Ask natural questions like 'Is this a good location for a cafe?' or 'What are the safety concerns here?' DISHA provides data-grounded analysis in real-time."

### Actions
1. Click "Ask DISHA" from detail panel
2. DISHA panel opens — show status indicator (green = connected)
3. Click a suggested question OR type: "Is this area good for a restaurant?"
4. Show streaming response appearing word by word
5. Briefly show another question

---

## SCENE 16: CLOSING (9:50 – 10:10)

### Visual
- Zoom out to show the full city grid
- Overlay text: feature count, data sources

### Narration
> "DigiPin Urban Intelligence transforms raw geospatial data into actionable urban insights. 12 cities, 160+ features, 30+ intelligence scores, 52 analytical queries, 3D building visualization, real-time AI assistance — all running in your browser. Built on open data from OpenStreetMap, Overture Maps, ISRO Bhuvan, and Google Open Buildings."

> "Start exploring at [your URL]. Thank you for watching."

### Actions
1. Zoom out slowly to show city-wide grid
2. Pan gently across the city
3. Fade to closing card with project name + credits

---

## POST-PRODUCTION NOTES

### Suggested Background Music
- Lo-fi ambient / tech-documentary style
- Volume: 20-30% under narration

### Text Overlays to Add
| Timestamp | Overlay Text |
|-----------|-------------|
| 0:05 | "DigiPin Urban Intelligence" (title card) |
| 0:10 | "160+ Features · 30+ Scores · 52 Queries" |
| 1:25 | "30+ Intelligence Scores" |
| 3:05 | "528K Building Footprints" |
| 4:35 | "17 Climate Zones · 54 Land Classes" |
| 6:45 | "52 Urban Queries · 7 Sectors" |
| 9:55 | "12 Cities · Open Data · Browser-Based" |

### Transitions
- Use smooth crossfades between scenes (0.5s)
- No flashy transitions — keep it professional
- Map animations serve as natural transitions

### Thumbnail
- Split screen: 3D buildings on left, radar chart on right
- Title: "DigiPin: Urban Intelligence for India"
- Purple/cyan color scheme matching the app

---

## QUICK REFERENCE: FEATURE COUNT

| Category | Count |
|----------|-------|
| Cities supported | 12 |
| Data features per cell | 160+ |
| Intelligence scores | 30+ |
| Urban queries | 52 |
| Query sectors | 7 |
| Overlay layers | 8+ |
| Building footprints | 528K+ |
| LCZ classes | 17 |
| LULC classes | 54 |
| Feature categories | 15 |
| Heatmap metrics | 10 |
| Isochrone rings | 3 |
| Compare slots | 3 |
