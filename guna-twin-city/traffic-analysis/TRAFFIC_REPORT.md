# Guna Traffic Management — Deep Analysis & One-Way Proposals

**City:** Guna, Madhya Pradesh, India (24.6354°N, 77.3126°E)
**Population:** ~200,000 (District HQ, Tier 3 city)
**Date:** 2026-03-16
**Data Sources:** OpenStreetMap (8,470 road segments), NHAI, MoRTH, Google Maps

---

## 1. Road Network Overview

### 1.1 Classification Breakdown

| Road Type       | Segments | Total Length (km) | % of Network | Avg Segment (m) |
|-----------------|----------|-------------------|--------------|------------------|
| Residential     | 5,218    | 1,256.76          | 38.1%        | 241              |
| Unclassified    | 1,315    | 880.46            | 26.7%        | 670              |
| Track           | 423      | 298.68            | 9.1%         | 706              |
| Tertiary        | 436      | 298.41            | 9.1%         | 684              |
| Primary (SH)    | 70       | 196.32            | 6.0%         | 2,805            |
| Trunk (NH-46)   | 89       | 148.35            | 4.5%         | 1,667            |
| Service         | 699      | 115.62            | 3.5%         | 165              |
| Secondary (MDR) | 194      | 101.17            | 3.1%         | 522              |
| **TOTAL**       | **8,470**| **3,297.11**      | **100%**     |                  |

### 1.2 Arterial Highway Network

| Route  | Type    | Length (km) | Role                                           |
|--------|---------|-------------|------------------------------------------------|
| NH-46  | Trunk   | 148.76      | Gwalior–Shivpuri–**Guna**–Bhopal (Asian Hwy 47)|
| SH-54  | Primary | 77.82       | State Highway                                   |
| SH-9   | Primary | 67.34       | State Highway                                   |
| SH-10  | Primary | 36.65       | State Highway                                   |
| MD0708 | Secondary| 35.26      | Major District Road                              |
| MD0701 | Secondary| 34.52      | Major District Road                              |
| MD0703 | Secondary| 20.09      | Major District Road                              |

**Critical fact:** NH-46 is part of **Asian Highway 47 (AH47)**, the most strategically important corridor through Guna district.

### 1.3 Current Traffic Management Infrastructure

| Feature          | Count | Note                                          |
|------------------|-------|-----------------------------------------------|
| Roundabouts      | 4     | Extremely low for a district HQ               |
| One-way segments | 159   | 137 km on NH-46 (divided highway), only 15 residential one-way segments |
| Bridges          | 1,137 | Including culverts                            |
| Fords            | 52    | Monsoon vulnerability — roads cross streams without bridges |
| Toll segments    | 30    | On NH-46                                      |
| Traffic signals  | ~0    | Not tagged in OSM (data gap or absence)       |

**Key finding:** The urban core has virtually **no one-way traffic management** — only 15 residential one-way segments covering 3.8 km. Only 4 roundabouts exist across the entire district.

---

## 2. Critical Bottleneck Analysis

### 2.1 Primary Bottleneck: SH-10/SH-54 Junction

**Location:** 24.648°N, 77.318°E (central Guna city)

This is the **single highest-connectivity intersection** in the entire network — two state highways and a secondary road converge at one point. Any congestion here cascades across SH-10, SH-54, and connecting roads.

**Issues:**
- No grade separation (at-grade intersection)
- Unknown signal timing (likely traffic police manual control during peak hours)
- Market area proximity increases pedestrian-vehicle conflict
- Three-way merge creates complex turning movements

**Recommendation:** Grade separation or a well-designed multi-arm roundabout with dedicated turning lanes.

### 2.2 Railway Level Crossings

Guna is on the **Delhi–Mumbai Western Railway** (Kota–Bina section). Level crossings on this busy line cause periodic blockages of 5–15 minutes per train passage.

**Impact pattern:**
- ~20–30 train passages per day on the Kota–Bina section
- Each crossing closure: 5–15 minutes
- Total daily blockage per crossing: 100–450 minutes (1.5–7.5 hours)
- Queue buildup: 50–200 vehicles per closure during peak hours

**Recommendation:** Identify the 2-3 busiest level crossings and propose Road Over Bridges (ROBs) or Road Under Bridges (RUBs).

### 2.3 Market Area Congestion

**Typical congestion generators in cities of Guna's size:**
- On-street parking in front of shops (encroaches 30–50% of road width)
- Auto-rickshaw / tempo aggregation near bus stand and railway station
- Narrow old-city roads designed for non-motorized traffic
- School/college zone peak-hour surges (8:00–9:00 AM, 1:00–2:00 PM)

### 2.4 NH-46 Through-Traffic

Despite the 13 km **Guna Bypass**, some heavy vehicles still use internal city roads due to:
- Familiarity / habit
- Fuel station locations
- Loading/unloading points within city
- Bypass condition (if poorly maintained)

**Recommendation:** Enforce bypass usage for heavy vehicles via checkpoints + signage. Install vehicle category restrictions on city entry points.

---

## 3. Time-of-Day Congestion Patterns

Based on typical Tier 3 Indian city patterns (to be validated with Google Routes API data):

| Time Slot     | Congestion Level | Primary Cause                        |
|---------------|------------------|--------------------------------------|
| 6:00–7:30     | Low              | Early morning, low traffic           |
| 7:30–9:30     | **HIGH**         | School/college/office rush           |
| 9:30–11:00    | Medium           | Market opening, commercial activity  |
| 11:00–13:00   | Medium-High      | Peak market hours                    |
| 13:00–14:30   | Medium           | School closure rush + lunch break    |
| 14:30–16:30   | Low-Medium       | Afternoon lull                       |
| 16:30–19:00   | **HIGH**         | Evening market peak + office return  |
| 19:00–20:30   | Medium           | Evening shopping, restaurants        |
| 20:30–22:00   | Low              | Declining activity                   |
| 22:00–6:00    | Very Low         | Night (NH-46 heavy vehicles active)  |

**Peak congestion windows: 7:30–9:30 AM and 4:30–7:00 PM** (total: ~4.5 hours/day)

---

## 4. One-Way Traffic Proposals

### 4.1 Design Principles

Based on lessons from Pune, Bhopal, and Indore implementations:

1. **One-way pairs, not isolated one-ways** — always designate a parallel return route
2. **Time-restricted initially** — apply only during peak hours (7:30–9:30, 16:30–19:00) to reduce business impact
3. **Adequate signage + enforcement** — one-way without enforcement is worse than no one-way
4. **Parking management must accompany** — ban on-street parking on one-way corridors
5. **Stakeholder consultation** — engage shopkeepers and residents before implementation

### 4.2 Proposed One-Way Corridors

#### Corridor A: Market Area Pair

**Problem:** The central market area around the SH-10/SH-54 junction has narrow roads with heavy two-way traffic and on-street parking.

**Proposal:**
- **Route A1 (Northbound):** [Main market road] — one-way north
- **Route A2 (Southbound):** [Parallel road ~200m east/west] — one-way south
- **Distance:** ~1.5 km each
- **Hours:** Peak hours only (7:30–9:30, 16:30–19:00) initially, full-day after 6 months if successful

**Expected impact:**
- Road capacity increase: ~40% (eliminates head-on conflicts)
- Travel time reduction: 25–35% during peak hours
- Parking: Designate one side of each road for parking, ban parking on the other

#### Corridor B: Station Road — Bus Stand Link

**Problem:** The railway station to bus stand corridor sees heavy auto-rickshaw and pedestrian traffic, creating severe mixed-traffic congestion.

**Proposal:**
- **Route B1 (Station → Bus Stand):** One-way outbound
- **Route B2 (Bus Stand → Station):** Parallel return route
- **Distance:** ~1 km each
- **Additional:** Designated auto-rickshaw stand at both ends (clear the road of parked autos)

**Expected impact:**
- Eliminate auto-rickshaw queueing on the main road
- Travel time reduction: 30–40%
- Pedestrian safety improvement

#### Corridor C: School Zone Traffic Management

**Problem:** School zones create 30-minute traffic jams twice daily.

**Proposal:**
- Time-restricted one-way (school hours only): 7:30–8:30 AM, 1:00–2:00 PM
- Direction: Toward school in morning, away from school in afternoon
- Parent pickup/drop designated zone: 200m before school gate

### 4.3 Impact on Passenger Travel Time

**Critical constraint:** One-way systems increase distance for some trips but reduce time for all.

| Scenario                    | Distance Change | Time Change | Net Benefit |
|-----------------------------|-----------------|-------------|-------------|
| Along one-way direction     | 0%              | -30%        | Positive    |
| Against one-way (must loop) | +30–60%         | -10 to +15% | Neutral/marginal |
| Cross-traffic               | 0%              | -20%        | Positive    |

**Mitigation for "against direction" trips:**
- Keep one-way corridors short (1–1.5 km) so detours are minimal
- Ensure return routes are of equal or better quality
- Add turning points at frequent intervals (every 300m)

---

## 5. Data Collection Plan

### 5.1 Google Routes API — Travel Time Profiling

Collect travel times on key corridors at 2-hour intervals across a full week:

**Routes to monitor:**
1. NH-46 North Entry → City Center → NH-46 South Exit
2. Railway Station → Bus Stand
3. SH-10 from east → SH-54 junction → SH-54 west
4. Guna Bypass (NH-46 bypass) end-to-end
5. Market area circuit

**Time points:** 6:00, 8:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00, 22:00

**API:** Google Routes API with `TRAFFIC_AWARE` routing model.

### 5.2 Physical Survey Requirements

What cannot be obtained remotely:
- Actual turning movement counts at the SH-10/SH-54 junction
- Railway level crossing closure frequency and queue lengths
- On-street parking occupancy rates
- Pedestrian crossing volumes
- Auto-rickshaw density at key points

### 5.3 Vehicle Registration Data

**Source:** MP Transport MIS (`mis.mptransport.org`), RTO code MP-08
- Total registered vehicles in Guna district
- Vehicle category breakdown (2-wheelers, cars, commercial, autos)
- Year-over-year growth rate

---

## 6. Traffic Simulation Recommendation

### Tool: SiMTraM (IIT Bombay's Indian Traffic Adaptation of SUMO)

**Why not vanilla SUMO:** SUMO enforces strict lane discipline, which is unrealistic for Indian roads where vehicles weave, two-wheelers fill gaps, and lane markings are often ignored.

**SiMTraM advantages:**
- Supports lane-less driving behavior
- Models heterogeneous traffic (autos, 2-wheelers, cars, trucks, buses, bicycles, pedestrians)
- Based on SUMO but calibrated for Indian conditions
- Open source

**Simulation workflow:**
1. Extract Guna road network via OSMnx (bbox: 24.60, 77.28, 24.67, 77.35)
2. Convert to SUMO/SiMTraM network format
3. Calibrate with Google Routes API travel time data
4. Baseline simulation: current two-way traffic
5. Scenario A: Market area one-way pair
6. Scenario B: Station-Bus Stand one-way
7. Scenario C: Combined A+B
8. Compare: travel time, queue length, throughput, emissions

---

## 7. Quick Wins (No Infrastructure Required)

| # | Intervention                          | Cost    | Impact | Timeline |
|---|---------------------------------------|---------|--------|----------|
| 1 | Ban on-street parking on SH-10/SH-54 within 500m of junction | Zero | High | Immediate |
| 2 | Designate auto-rickshaw stands (off main roads) | Low | Medium | 1 month |
| 3 | School zone time-restricted one-way   | Low     | Medium | 1 month |
| 4 | Enforce NH-46 bypass for heavy vehicles| Low    | High   | 1 month |
| 5 | Peak-hour traffic police at SH-10/SH-54 junction | Low | High | Immediate |
| 6 | No-honking zones near hospitals/schools| Zero   | Low    | Immediate |
| 7 | Speed breakers at accident-prone spots | Low    | Medium | 2 months |

---

## 8. Medium-Term Recommendations

| # | Intervention                          | Cost      | Impact | Timeline  |
|---|---------------------------------------|-----------|--------|-----------|
| 1 | Traffic signals at top 5 intersections| Medium    | High   | 6 months  |
| 2 | Market area one-way pair (Corridor A) | Low-Med   | High   | 3 months  |
| 3 | Station Road one-way (Corridor B)     | Low       | Medium | 3 months  |
| 4 | Multi-level parking near market       | High      | High   | 12 months |
| 5 | ROB at busiest railway level crossing | Very High | Very High | 18 months |
| 6 | Pedestrian-only zone in market core   | Medium    | High   | 6 months  |

---

## 9. Data Sources Reference

| Source | What It Provides | Access |
|--------|-----------------|--------|
| OpenStreetMap | Road network, lanes, one-way tags | Free — Overpass API |
| Mappls (MapMyIndia) | Best real-time traffic for Indian cities | API — free tier |
| Google Routes API | Historical travel time profiles | $200/mo free credit |
| IHMCL | NH toll plaza vehicle counts, FASTag data | `ihmcl.co.in` |
| MoRTH Year Books | National traffic census data | `morth.gov.in` |
| MP Transport MIS | Vehicle registration (RTO MP-08) | `mis.mptransport.org` |
| data.gov.in | Government open data (transport) | Free |
| SiMTraM | Indian traffic simulation (SUMO fork) | IIT Bombay — open source |

---

## 10. Next Steps

1. **Run the `collect_traffic_data.py` script** to gather Google Routes API travel times
2. **Validate congestion patterns** against the time-of-day estimates in Section 3
3. **Identify exact one-way corridor roads** using the road geometry data
4. **Build SUMO/SiMTraM simulation** for before/after comparison
5. **Stakeholder mapping** — identify market associations, RTO, traffic police contacts
6. **Present findings** to Guna Municipal Corporation / District Administration
