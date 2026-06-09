/**
 * Urban Data Fetcher — 160+ Features from Free APIs
 * Sources: OpenStreetMap Overpass, Open-Meteo (Weather + AQI + Solar), CPCB/WAQI,
 *          Nominatim, Wikipedia, Open-Elevation, WorldPop, Bhoonidhi (ISRO),
 *          OGD India (data.gov.in), Indian Pincode API
 *
 * PIPELINE DESIGN:
 *  - Overpass: Broad tag-category queries (amenity, shop, tourism, etc.)
 *    then classify responses into 135 features client-side
 *  - Open-Meteo: Weather (no key needed)
 *  - Open-Meteo AQI: Grid-level air quality (PM2.5, PM10, NO2, SO2, O3, CO, UV)
 *  - Open-Meteo Solar: GHI/DNI solar radiation for solar potential
 *  - CPCB: Primary AQI via data.gov.in, WAQI fallback, Open-Meteo tertiary
 *  - Nominatim: Reverse geocoding — shared result to avoid duplicate calls
 *  - Wikipedia: Geosearch for historical context
 *  - Open-Elevation: 5-point sampling for relative elevation
 *  - WorldPop: Population density estimate (100m grid)
 *  - Bhoonidhi (ISRO): Satellite imagery availability for the area
 *  - OGD India: Health facility data enrichment
 *
 * CONFIGURATION (window.DIGIPIN_CONFIG):
 *  Set this object before loading the script to customise behaviour.
 *
 *  waqiToken (string) — WAQI API token from https://aqicn.org/data-platform/token/
 *    Default: 'demo'  (city-name endpoint, city-center AQI only)
 *    Real token:      uses geo endpoint feed/geo:{lat};{lng}/?token={token}
 *                     which returns the nearest monitoring station to the cell.
 *    Example:
 *      window.DIGIPIN_CONFIG = { waqiToken: 'your-token-here' };
 *
 *  ogdApiKey (string) — data.gov.in (OGD) API key for hospital / CEPI / pincode
 *    enrichment. Defaults to data.gov.in's shared public sample key (rate-limited).
 *    Register a free key at https://data.gov.in/ for higher quota:
 *      window.DIGIPIN_CONFIG = { ogdApiKey: 'your-key-here' };
 *
 *  CPCB is the primary AQI source; WAQI is the first fallback.
 *  Even with a demo token the pipeline gives useful results via CPCB + Open-Meteo.
 *
 *  SECURITY NOTE: This is a keyless static PWA — it cannot hide a real secret.
 *  Only public / shared-sample credentials live in this file. Any genuinely
 *  private key must be fronted by a backend proxy, never shipped to the browser.
 */

const DataFetcher = (() => {
    const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
    const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
    const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
    const WIKIPEDIA_URL = 'https://en.wikipedia.org/w/api.php';
    const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';
    const CPCB_AQI_RESOURCE = '3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69';
    const WORLDPOP_API = 'https://api.worldpop.org/v1/wopr/pointtotal';
    const OPEN_METEO_AQI_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
    const OPEN_METEO_SOLAR_URL = 'https://api.open-meteo.com/v1/forecast';
    // const BHOONIDHI_API = 'https://bhoonidhi-api.nrsc.gov.in'; // CORS-blocked, disabled
    // data.gov.in (OGD) key. This is the platform's shared *public sample* key,
    // documented openly at https://data.gov.in/help/how-use-datasets-apis — it is
    // rate-limited and low-sensitivity, not a private credential. Override it with
    // your own registered key via window.DIGIPIN_CONFIG.ogdApiKey for higher quota.
    const OGD_API_KEY = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG?.ogdApiKey)
        || '579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b';
    const OGD_HOSPITAL_RESOURCE = '0c534d1d8b4e3c3b0219254f563741a6';
    const OGD_CEPI_RESOURCE = '0579cf1f-7e3b-4b15-b29a-87cf7b7c7a08';
    const OGD_PINCODE_RESOURCE = '5c2f62fe-5afa-4119-a499-fec9d604d5bd';
    let _cepiCache = null; // loaded once (only 43 records)

    // IUDX (India Urban Data Exchange) — Smart City data for Indore.
    // Both endpoints used below are public/no-auth: the open S3 sample bucket and
    // the IUDX catalogue search API (via CORS proxy, see fetchIUDXCatalogue). No
    // client_id/secret is needed or stored here — a static PWA cannot keep a secret
    // anyway. If a future feature needs the authenticated Resource Server, proxy it
    // through a backend and inject the token at request time, never in client source.
    const IUDX_S3_BASE = 'https://fs-sample-file-bucket.s3.ap-south-1.amazonaws.com/public-access/indore';
    const IUDX_DATASETS = [
        { key: 'busStops',    label: 'Bus Stops (BRTS/City)',  icon: '🚌', file: 'indore-stops-info.json' },
        { key: 'bikeHubs',    label: 'MYBYK Bike Hubs',        icon: '🚲', file: 'indore-bike-docking-station-locations.json' },
        { key: 'vmd',         label: 'Variable Message Displays', icon: '📺', file: 'indore-vmd-locations.json' },
        { key: 'pa',          label: 'Public Addressing Systems', icon: '📢', file: 'indore-pa-locations.json' }
    ];
    let _iudxCache = null; // cached after first load
    let _iudxCatalogueCache = {}; // city → catalogue results

    // ===== CATEGORY DEFINITIONS =====
    const CATEGORIES = {
        food: {
            name: 'Food & Dining',
            icon: '🍽️',
            features: [
                { key: 'restaurants', label: 'Restaurants', match: { amenity: 'restaurant' } },
                { key: 'cafes', label: 'Cafés', match: { amenity: 'cafe' } },
                { key: 'fast_food', label: 'Fast Food', match: { amenity: 'fast_food' } },
                { key: 'bars', label: 'Bars & Pubs', match: { amenity: /^(bar|pub)$/ } },
                { key: 'food_court', label: 'Food Courts', match: { amenity: 'food_court' } },
                { key: 'ice_cream', label: 'Ice Cream', match: { amenity: 'ice_cream' } },
                { key: 'bakery', label: 'Bakeries', match: { shop: 'bakery' } },
                { key: 'butcher', label: 'Butcher Shops', match: { shop: 'butcher' } },
                { key: 'confectionery', label: 'Sweet Shops', match: { shop: 'confectionery' } },
                { key: 'drinking_water', label: 'Drinking Water', match: { amenity: 'drinking_water' } }
            ]
        },
        education: {
            name: 'Education',
            icon: '🎓',
            features: [
                { key: 'schools', label: 'Schools', match: { amenity: 'school' } },
                { key: 'colleges', label: 'Colleges', match: { amenity: 'college' } },
                { key: 'universities', label: 'Universities', match: { amenity: 'university' } },
                { key: 'kindergartens', label: 'Kindergartens', match: { amenity: 'kindergarten' } },
                { key: 'libraries', label: 'Libraries', match: { amenity: 'library' } },
                { key: 'language_school', label: 'Language Schools', match: { amenity: 'language_school' } },
                { key: 'driving_school', label: 'Driving Schools', match: { amenity: 'driving_school' } },
                { key: 'research', label: 'Research Institutes', match: { amenity: 'research_institute' } }
            ]
        },
        healthcare: {
            name: 'Healthcare',
            icon: '🏥',
            features: [
                { key: 'hospitals', label: 'Hospitals', match: { amenity: 'hospital' } },
                { key: 'clinics', label: 'Clinics & Doctors', match: { amenity: /^(clinic|doctors)$/ } },
                { key: 'pharmacies', label: 'Pharmacies', match: { amenity: 'pharmacy' } },
                { key: 'dentists', label: 'Dentists', match: { amenity: 'dentist' } },
                { key: 'veterinary', label: 'Veterinary', match: { amenity: 'veterinary' } },
                { key: 'blood_bank', label: 'Blood Banks', match: { healthcare: 'blood_bank' } },
                { key: 'nursing_home', label: 'Nursing Homes', match: { amenity: 'nursing_home' } },
                { key: 'lab', label: 'Diagnostic Labs', match: { healthcare: 'laboratory' } },
                { key: 'optician', label: 'Opticians', match: { shop: 'optician' } },
                { key: 'alt_medicine', label: 'Alternative Medicine', match: { healthcare: 'alternative' } }
            ]
        },
        finance: {
            name: 'Financial Services',
            icon: '🏦',
            features: [
                { key: 'banks', label: 'Banks', match: { amenity: 'bank' } },
                { key: 'atms', label: 'ATMs', match: { amenity: 'atm' } },
                { key: 'exchange', label: 'Money Exchange', match: { amenity: 'bureau_de_change' } },
                { key: 'insurance', label: 'Insurance Offices', match: { office: 'insurance' } },
                { key: 'microfinance', label: 'Microfinance', match: { amenity: 'microfinance' } },
                { key: 'financial', label: 'Financial Services', match: { office: 'financial' } },
                { key: 'tax', label: 'Tax Offices', match: { office: 'tax' } }
            ]
        },
        shopping: {
            name: 'Shopping & Retail',
            icon: '🛒',
            features: [
                { key: 'mall', label: 'Shopping Malls', match: { shop: 'mall' } },
                { key: 'supermarket', label: 'Supermarkets', match: { shop: 'supermarket' } },
                { key: 'convenience', label: 'Convenience Stores', match: { shop: 'convenience' } },
                { key: 'clothes', label: 'Clothing Stores', match: { shop: 'clothes' } },
                { key: 'electronics', label: 'Electronics', match: { shop: 'electronics' } },
                { key: 'mobile', label: 'Mobile Phone Shops', match: { shop: 'mobile_phone' } },
                { key: 'hardware', label: 'Hardware Stores', match: { shop: /^(hardware|doityourself)$/ } },
                { key: 'furniture', label: 'Furniture', match: { shop: 'furniture' } },
                { key: 'jewelry', label: 'Jewelry', match: { shop: 'jewelry' } },
                { key: 'books', label: 'Book Stores', match: { shop: 'books' } },
                { key: 'stationery', label: 'Stationery', match: { shop: 'stationery' } },
                { key: 'department', label: 'Department Stores', match: { shop: 'department_store' } },
                { key: 'marketplace', label: 'Markets / Bazaars', match: { amenity: 'marketplace' } },
                { key: 'car_dealer', label: 'Auto Dealers', match: { shop: 'car' } }
            ]
        },
        transport: {
            name: 'Transportation',
            icon: '🚌',
            features: [
                { key: 'bus_stop', label: 'Bus Stops', match: { highway: 'bus_stop' } },
                { key: 'railway', label: 'Railway Stations', match: { railway: /^(station|halt)$/ } },
                { key: 'metro', label: 'Metro Stations', match: { station: 'subway' } },
                { key: 'taxi', label: 'Taxi Stands', match: { amenity: 'taxi' } },
                { key: 'parking', label: 'Car Parking', match: { amenity: 'parking' } },
                { key: 'bicycle_parking', label: 'Bicycle Parking', match: { amenity: 'bicycle_parking' } },
                { key: 'bicycle_rental', label: 'Bicycle Rental', match: { amenity: 'bicycle_rental' } },
                { key: 'fuel', label: 'Petrol Pumps', match: { amenity: 'fuel' } },
                { key: 'ev_charging', label: 'EV Charging', match: { amenity: 'charging_station' } },
                { key: 'car_wash', label: 'Car Wash', match: { amenity: 'car_wash' } },
                { key: 'car_repair', label: 'Car Repair', match: { shop: 'car_repair' } },
                { key: 'auto_rickshaw', label: 'Auto Stands', match: { amenity: 'auto_rickshaw_stand' } }
            ]
        },
        government: {
            name: 'Government & Civic',
            icon: '🏛️',
            features: [
                { key: 'police', label: 'Police Stations', match: { amenity: 'police' } },
                { key: 'fire', label: 'Fire Stations', match: { amenity: 'fire_station' } },
                { key: 'post_office', label: 'Post Offices', match: { amenity: 'post_office' } },
                { key: 'courthouse', label: 'Courts', match: { amenity: 'courthouse' } },
                { key: 'govt_office', label: 'Govt Offices', match: { office: 'government' } },
                { key: 'embassy', label: 'Embassies', match: { amenity: 'embassy' } },
                { key: 'community', label: 'Community Centers', match: { amenity: 'community_centre' } },
                { key: 'social', label: 'Social Facilities', match: { amenity: 'social_facility' } },
                { key: 'toilets', label: 'Public Toilets', match: { amenity: 'toilets' } },
                { key: 'recycling', label: 'Recycling', match: { amenity: /^(recycling|waste_disposal)$/ } },
                { key: 'townhall', label: 'Town Halls', match: { amenity: 'townhall' } },
                { key: 'prison', label: 'Prisons', match: { amenity: 'prison' } }
            ]
        },
        leisure: {
            name: 'Parks & Recreation',
            icon: '🌳',
            features: [
                { key: 'parks', label: 'Parks', match: { leisure: 'park' } },
                { key: 'playground', label: 'Playgrounds', match: { leisure: 'playground' } },
                { key: 'garden', label: 'Gardens', match: { leisure: 'garden' } },
                { key: 'pitch', label: 'Sports Pitches', match: { leisure: 'pitch' } },
                { key: 'swimming', label: 'Swimming Pools', match: { leisure: 'swimming_pool' } },
                { key: 'gym', label: 'Gyms', match: { leisure: 'fitness_centre' } },
                { key: 'sports_centre', label: 'Sports Centers', match: { leisure: 'sports_centre' } },
                { key: 'stadium', label: 'Stadiums', match: { leisure: 'stadium' } },
                { key: 'golf', label: 'Golf Courses', match: { leisure: 'golf_course' } },
                { key: 'water_park', label: 'Water Parks', match: { leisure: 'water_park' } },
                { key: 'dog_park', label: 'Dog Parks', match: { leisure: 'dog_park' } },
                { key: 'nature_reserve', label: 'Nature Reserves', match: { leisure: 'nature_reserve' } }
            ]
        },
        entertainment: {
            name: 'Entertainment & Culture',
            icon: '🎭',
            features: [
                { key: 'cinema', label: 'Cinemas', match: { amenity: 'cinema' } },
                { key: 'theatre', label: 'Theatres', match: { amenity: 'theatre' } },
                { key: 'museum', label: 'Museums', match: { tourism: 'museum' } },
                { key: 'gallery', label: 'Art Galleries', match: { tourism: 'gallery' } },
                { key: 'nightclub', label: 'Nightclubs', match: { amenity: 'nightclub' } },
                { key: 'arcade', label: 'Amusement Arcades', match: { leisure: 'amusement_arcade' } },
                { key: 'theme_park', label: 'Theme Parks', match: { tourism: 'theme_park' } },
                { key: 'zoo', label: 'Zoos', match: { tourism: 'zoo' } },
                { key: 'monument', label: 'Monuments', match: { historic: /^(monument|memorial)$/ } },
                { key: 'worship', label: 'Places of Worship', match: { amenity: 'place_of_worship' } }
            ]
        },
        accommodation: {
            name: 'Accommodation & Tourism',
            icon: '🏨',
            features: [
                { key: 'hotel', label: 'Hotels', match: { tourism: 'hotel' } },
                { key: 'guest_house', label: 'Guest Houses', match: { tourism: 'guest_house' } },
                { key: 'hostel', label: 'Hostels', match: { tourism: 'hostel' } },
                { key: 'motel', label: 'Motels', match: { tourism: 'motel' } },
                { key: 'attraction', label: 'Tourist Attractions', match: { tourism: 'attraction' } },
                { key: 'viewpoint', label: 'Viewpoints', match: { tourism: 'viewpoint' } },
                { key: 'info', label: 'Tourist Information', match: { tourism: 'information' } },
                { key: 'picnic', label: 'Picnic Sites', match: { tourism: 'picnic_site' } }
            ]
        },
        landuse: {
            name: 'Land Use & Buildings',
            icon: '🏗️',
            features: [
                { key: 'residential_area', label: 'Residential Areas', match: { landuse: 'residential' } },
                { key: 'commercial_area', label: 'Commercial Areas', match: { landuse: 'commercial' } },
                { key: 'industrial_area', label: 'Industrial Areas', match: { landuse: 'industrial' } },
                { key: 'retail_area', label: 'Retail Areas', match: { landuse: 'retail' } },
                { key: 'buildings_total', label: 'Total Buildings', match: { building: /.*/ }, countOnly: true },
                { key: 'res_buildings', label: 'Residential Bldgs', match: { building: /^(residential|house|apartments|detached)$/ } },
                { key: 'com_buildings', label: 'Commercial Bldgs', match: { building: /^(commercial|office|retail)$/ } },
                { key: 'construction', label: 'Under Construction', match: { landuse: 'construction' } },
                { key: 'vacant', label: 'Vacant Land', match: { landuse: /^(brownfield|greenfield)$/ } },
                { key: 'cemetery', label: 'Cemeteries', match: { landuse: 'cemetery' } },
                { key: 'military', label: 'Military Areas', match: { landuse: 'military' } },
                { key: 'farmland', label: 'Farmland', match: { landuse: /^(farmland|orchard|vineyard)$/ } }
            ]
        },
        infrastructure: {
            name: 'Infrastructure & Utilities',
            icon: '🛤️',
            features: [
                { key: 'street_lamps', label: 'Street Lights', match: { highway: 'street_lamp' } },
                { key: 'cell_tower', label: 'Cell Towers', match: { man_made: /^(tower|mast)$/ } },
                { key: 'power', label: 'Power Infrastructure', match: { power: /^(substation|line|pole)$/ } },
                { key: 'water_tower', label: 'Water Towers', match: { man_made: /^(water_tower|storage_tank)$/ } },
                { key: 'bridge', label: 'Bridges', match: { man_made: 'bridge' } },
                { key: 'roads', label: 'Road Network', match: { highway: /^(primary|secondary|tertiary|residential|trunk)$/ }, countOnly: true },
                { key: 'footpath', label: 'Footpaths', match: { highway: /^(footway|path|pedestrian)$/ }, countOnly: true },
                { key: 'cycleway', label: 'Cycleways', match: { highway: 'cycleway' }, countOnly: true },
                { key: 'water_body', label: 'Water Bodies', match: { natural: 'water' } },
                { key: 'river', label: 'Rivers & Streams', match: { waterway: /^(river|stream|canal)$/ } }
            ]
        },
        business: {
            name: 'Business & Services',
            icon: '💼',
            features: [
                { key: 'offices', label: 'Offices', match: { office: /^(yes|company)$/ } },
                { key: 'it_company', label: 'IT / Tech', match: { office: 'it' } },
                { key: 'coworking', label: 'Coworking Spaces', match: { amenity: 'coworking_space' } },
                { key: 'estate_agent', label: 'Real Estate Agents', match: { shop: 'estate_agent' } },
                { key: 'lawyer', label: 'Lawyers', match: { office: 'lawyer' } },
                { key: 'accountant', label: 'Accountants', match: { office: 'accountant' } },
                { key: 'beauty', label: 'Salons & Barbers', match: { shop: /^(beauty|hairdresser)$/ } },
                { key: 'laundry', label: 'Laundry', match: { shop: /^(laundry|dry_cleaning)$/ } },
                { key: 'photo', label: 'Photography', match: { shop: 'photo' } },
                { key: 'tailor', label: 'Tailors', match: { shop: 'tailor' } }
            ]
        }
    };

    // ===== LRU CACHE (in-memory) =====
    const _cache = new Map();
    const MAX_CACHE = 100;
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    function _cacheKey(lat, lng, radius) {
        return `${lat.toFixed(4)},${lng.toFixed(4)},${radius}`;
    }

    function _cacheGet(key) {
        const entry = _cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.time > CACHE_TTL) {
            _cache.delete(key);
            return null;
        }
        _cache.delete(key);
        _cache.set(key, entry);
        return entry.data;
    }

    function _cacheSet(key, data) {
        if (_cache.size >= MAX_CACHE) {
            const oldest = _cache.keys().next().value;
            _cache.delete(oldest);
        }
        _cache.set(key, { data, time: Date.now() });
        // Write-through to IndexedDB (async, non-blocking)
        _idbSet(key, data).catch(() => {});
    }

    // ===== IndexedDB PERSISTENT CACHE =====
    const IDB_NAME = 'digipin-cache';
    const IDB_STORE = 'cells';
    const IDB_VERSION = 1;
    const IDB_TTL = 24 * 60 * 60 * 1000; // 24 hours
    const IDB_MAX_ENTRIES = 500;
    let _idb = null;

    function _idbOpen() {
        if (_idb) return Promise.resolve(_idb);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = () => { _idb = req.result; resolve(_idb); };
            req.onerror = () => reject(req.error);
        });
    }

    async function _idbGet(key) {
        const db = await _idbOpen();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const req = store.get(key);
            req.onsuccess = () => {
                const entry = req.result;
                if (!entry) return resolve(null);
                if (Date.now() - entry.time > IDB_TTL) {
                    _idbDelete(key).catch(() => {});
                    return resolve(null);
                }
                resolve(entry.data);
            };
            req.onerror = () => resolve(null);
        });
    }

    async function _idbSet(key, data) {
        const db = await _idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            store.put({ key, data, time: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            // Periodic eviction: count and trim if over limit
            const countReq = store.count();
            countReq.onsuccess = () => {
                if (countReq.result > IDB_MAX_ENTRIES) {
                    _idbEvict(Math.floor(IDB_MAX_ENTRIES * 0.2)).catch(() => {});
                }
            };
        });
    }

    async function _idbDelete(key) {
        const db = await _idbOpen();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    async function _idbEvict(count) {
        const db = await _idbOpen();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const req = store.openCursor();
            let deleted = 0;
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor && deleted < count) {
                    cursor.delete();
                    deleted++;
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve(deleted);
            tx.onerror = () => resolve(0);
        });
    }

    async function _idbClear() {
        const db = await _idbOpen();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }

    /**
     * Utility: Fetch with exponential backoff retry
     */
    // Per-attempt timeout (ms). The public APIs (Overpass, Nominatim,
    // open-elevation) routinely hang rather than error under load, which would
    // otherwise stall the whole cell fetch on a single `await fetch`. Aborting
    // lets the retry/backoff loop and each caller's fallback kick in so the app
    // degrades gracefully instead of freezing.
    const FETCH_TIMEOUT_MS = 15000;

    async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000, timeout = FETCH_TIMEOUT_MS) {
        let lastError;
        for (let i = 0; i < retries; i++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeout}ms`)), timeout);
            // Forward a caller-supplied abort signal so external cancellation
            // (e.g. navigating away mid-query) still propagates to the fetch.
            if (options.signal) {
                if (options.signal.aborted) controller.abort(options.signal.reason);
                else options.signal.addEventListener('abort',
                    () => controller.abort(options.signal.reason), { once: true });
            }
            try {
                const resp = await fetch(url, { ...options, signal: controller.signal });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return await resp.json();
            } catch (err) {
                lastError = err;
                // Honour a caller-initiated abort immediately — don't burn retries.
                if (options.signal?.aborted) throw err;
                if (i < retries - 1) {
                    await new Promise(res => setTimeout(res, backoff * Math.pow(2, i)));
                }
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastError;
    }

    /**
     * Build ONE efficient Overpass query using broad tag categories
     */
    function buildOverpassQuery(lat, lng, radius) {
        return `[out:json][timeout:45];(
  nwr[amenity](around:${radius},${lat},${lng});
  nwr[shop](around:${radius},${lat},${lng});
  nwr[tourism](around:${radius},${lat},${lng});
  nwr[leisure](around:${radius},${lat},${lng});
  nwr[office](around:${radius},${lat},${lng});
  nwr[healthcare](around:${radius},${lat},${lng});
  way[building](around:${radius},${lat},${lng});
  way[landuse](around:${radius},${lat},${lng});
  nwr[highway=bus_stop](around:${radius},${lat},${lng});
  nwr[highway=street_lamp](around:${radius},${lat},${lng});
  way[highway~"^(primary|secondary|tertiary|residential|trunk|footway|path|pedestrian|cycleway)$"](around:${radius},${lat},${lng});
  nwr[man_made~"^(tower|mast|water_tower|storage_tank|bridge)$"](around:${radius},${lat},${lng});
  nwr[power](around:${radius},${lat},${lng});
  nwr[natural=water](around:${radius},${lat},${lng});
  nwr[waterway](around:${radius},${lat},${lng});
  nwr[railway~"^(station|halt)$"](around:${radius},${lat},${lng});
  nwr[station=subway](around:${radius},${lat},${lng});
  nwr[historic](around:${radius},${lat},${lng});
);out center body;`;
    }

    /**
     * Match an OSM element against a feature definition
     */
    function matchesFeature(tags, feature) {
        for (const [tagKey, expected] of Object.entries(feature.match)) {
            const actual = tags[tagKey];
            if (!actual) continue;
            if (expected instanceof RegExp) {
                if (expected.test(actual)) return true;
            } else if (actual === expected) {
                return true;
            }
        }
        return false;
    }

    /**
     * Parse Overpass response into categorized feature counts
     */
    function classifyElements(elements) {
        const results = {};

        Object.values(CATEGORIES).forEach(cat => {
            cat.features.forEach(f => {
                results[f.key] = { count: 0, names: [], items: [], subTypes: {} };
            });
        });

        elements.forEach(el => {
            const tags = el.tags || {};
            const center = el.center || { lat: el.lat, lon: el.lon };
            const name = tags.name || tags['name:en'] || '';

            Object.values(CATEGORIES).forEach(cat => {
                cat.features.forEach(f => {
                    if (matchesFeature(tags, f)) {
                        results[f.key].count++;
                        if (name && results[f.key].names.length < 20) {
                            results[f.key].names.push(name);
                        }
                        if (results[f.key].items.length < 20 && center) {
                            results[f.key].items.push({
                                name: name || tags.operator || '',
                                lat: center.lat,
                                lng: center.lon || center.lng,
                                type: el.type
                            });
                        }
                        if (f.key === 'worship' && tags.religion) {
                            const r = String(tags.religion).toLowerCase();
                            results[f.key].subTypes[r] = (results[f.key].subTypes[r] || 0) + 1;
                        }
                    }
                });
            });
        });

        return results;
    }

    /**
     * Determine search radius based on zoom level for variable-radius queries
     */
    function getRadiusForZoom(zoom) {
        if (zoom >= 18) return 200;
        if (zoom >= 17) return 300;
        if (zoom >= 16) return 400;
        if (zoom >= 15) return 500;
        if (zoom >= 14) return 700;
        return 1000;
    }

    /**
     * Fetch ALL features for a DigiPin location
     * @param {number} lat
     * @param {number} lng
     * @param {number} radius - Search radius in meters (default 500)
     * @param {object} [sharedAddress] - Pre-fetched address to avoid duplicate Nominatim calls
     */
    // ===== REQUEST COALESCING =====
    // Overlays fire many concurrent fetchAllFeatures() calls, and rapid
    // re-toggles / bivariate axis changes re-request the same cells before the
    // first completes. The LRU/IndexedDB cache only populates *after* a fetch
    // finishes, so without coalescing each identical (lat,lng,radius) in flight
    // does a full duplicate network fetch. _coalesce funnels them onto one
    // promise; the cache then serves everyone once it resolves.
    const _inflight = new Map();

    /** Funnel concurrent calls for the same key onto a single in-flight promise.
     *  Pure + testable: pass any Map, a key, and a factory. No caching of its
     *  own — the entry is removed once the promise settles. */
    function _coalesce(inflight, key, factory) {
        if (inflight.has(key)) return inflight.get(key);
        const p = Promise.resolve().then(factory).finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    }

    async function fetchAllFeatures(lat, lng, radius = 500, sharedAddress = null) {
        const key = _cacheKey(lat, lng, radius);
        const cached = _cacheGet(key);
        if (cached) return cached;
        return _coalesce(_inflight, key, () => _doFetchAllFeatures(lat, lng, radius, sharedAddress));
    }

    async function _doFetchAllFeatures(lat, lng, radius = 500, sharedAddress = null) {
        const key = _cacheKey(lat, lng, radius);
        const cached = _cacheGet(key);
        if (cached) return cached;

        // Check IndexedDB persistent cache (survives page reloads)
        try {
            const idbCached = await _idbGet(key);
            if (idbCached) {
                _cache.set(key, { data: idbCached, time: Date.now() }); // promote to LRU
                return idbCached;
            }
        } catch { /* IndexedDB unavailable, continue to network */ }

        const result = {
            location: { lat, lng },
            radius,
            timestamp: new Date().toISOString(),
            categories: {},
            environment: {},
            address: {},
            context: {},
            scores: {},
            raw: { totalElements: 0, featureTypesFound: 0 }
        };

        // Fetch address first (or use shared) — needed by AQI functions
        let addressData;
        if (sharedAddress) {
            addressData = { status: 'fulfilled', value: sharedAddress };
        } else {
            addressData = await fetchAddress(lat, lng).then(
                v => ({ status: 'fulfilled', value: v }),
                () => ({ status: 'rejected' })
            );
        }

        if (addressData.status === 'fulfilled') {
            result.address = addressData.value;
        }

        // Extract city name for AQI queries (shared — no duplicate Nominatim call)
        const cityName = result.address.city || result.address.area || 'Indore';

        // Per-source memoization for the slow / shared-input fetches.
        // Adjacent DigiPin cells (4x4m) often share the same upstream data
        // (weather station, elevation tile, Wikipedia geosearch radius), so
        // this is a meaningful win on top of the existing result-level cache.
        const cache = (typeof DataFetcherCache !== 'undefined') ? DataFetcherCache : null;
        const memo = (name, ttlMs, factory) => cache
            ? cache.memoize(cache.keyFor(name, lat, lng), ttlMs, factory)
            : factory();
        const HOUR = 60 * 60 * 1000;
        const DAY = 24 * HOUR;

        // Fire remaining requests in parallel (including building intelligence + new sources)
        const [osmData, weatherData, aqiData, wikiData, elevData, popData, buildingData, openMeteoAqi, solarData, bhoondhiData, ogdHealthData, iudxData, iudxCatalogueData, cepiData, postOfficeData, precipData] = await Promise.allSettled([
            fetchOSMData(lat, lng, radius),
            memo('weather', 1 * HOUR, () => fetchWeather(lat, lng)),
            memo('aqi', 1 * HOUR, () => fetchAQI(lat, lng, cityName)),
            memo('wiki', 30 * DAY, () => fetchWikipedia(lat, lng)),
            memo('elev', 30 * DAY, () => fetchElevation(lat, lng)),
            fetchWorldPop(lat, lng),
            typeof BuildingIntelligence !== 'undefined' ? BuildingIntelligence.fetch(lat, lng, radius) : Promise.resolve(null),
            fetchOpenMeteoAQI(lat, lng),
            fetchSolarRadiation(lat, lng),
            fetchBhoonidhi(lat, lng),
            fetchOGDHealthFacilities(lat, lng, result.address.state),
            fetchIUDX(lat, lng),
            fetchIUDXCatalogue(cityName),
            fetchCEPI(cityName, result.address.state),
            fetchNearbyPostOffices(lat, lng, result.address.district),
            memo('precip', 7 * DAY, () => fetchHistoricalPrecipitation(lat, lng))
        ]);

        // === OSM POI data ===
        if (osmData.status === 'fulfilled') {
            const elements = osmData.value.elements || [];
            result.raw.totalElements = elements.length;

            const classified = classifyElements(elements);

            let typesFound = 0;
            Object.values(classified).forEach(f => { if (f.count > 0) typesFound++; });
            result.raw.featureTypesFound = typesFound;

            Object.entries(CATEGORIES).forEach(([catKey, cat]) => {
                result.categories[catKey] = {
                    name: cat.name,
                    icon: cat.icon,
                    features: {}
                };
                cat.features.forEach(f => {
                    result.categories[catKey].features[f.key] = {
                        label: f.label,
                        ...classified[f.key]
                    };
                });
            });
        }

        // === Weather ===
        if (weatherData.status === 'fulfilled') {
            result.environment = weatherData.value;
        }

        // === AQI ===
        if (aqiData.status === 'fulfilled') {
            result.environment = { ...result.environment, ...aqiData.value };
        }

        // === Wikipedia Context ===
        if (wikiData.status === 'fulfilled' && wikiData.value) {
            result.context.wikipedia = wikiData.value;
        }

        // === Elevation (for flood risk) ===
        if (elevData.status === 'fulfilled' && elevData.value != null) {
            result.environment.elevation = elevData.value;
        }

        // === Annual precipitation (for flood risk) ===
        if (precipData.status === 'fulfilled' && precipData.value != null) {
            result.environment.precipitation = precipData.value;
        }

        // === WorldPop population density ===
        if (popData.status === 'fulfilled' && popData.value != null) {
            result.environment.populationDensity = popData.value;
        }

        // === Building Intelligence (LCZ + enhanced building data) ===
        if (buildingData.status === 'fulfilled' && buildingData.value) {
            result.buildingIntel = buildingData.value;
        }

        // === Open-Meteo AQI (enriches/fills gaps in CPCB/WAQI data) ===
        if (openMeteoAqi.status === 'fulfilled' && openMeteoAqi.value) {
            const omAqi = openMeteoAqi.value;
            // Fill in any missing AQI fields from Open-Meteo
            if (result.environment.aqi == null && omAqi.aqi != null) {
                result.environment.aqi = omAqi.aqi;
                result.environment.aqiSource = 'Open-Meteo';
            }
            // Always add detailed pollutant data if not already present
            if (result.environment.pm25 == null) result.environment.pm25 = omAqi.pm25;
            if (result.environment.pm10 == null) result.environment.pm10 = omAqi.pm10;
            if (result.environment.no2 == null) result.environment.no2 = omAqi.no2;
            if (result.environment.so2 == null) result.environment.so2 = omAqi.so2;
            if (result.environment.o3 == null) result.environment.o3 = omAqi.o3;
            if (result.environment.co == null) result.environment.co = omAqi.co;
            if (result.environment.uvIndex == null) result.environment.uvIndex = omAqi.uvIndex;
        }

        // === Solar Radiation ===
        if (solarData.status === 'fulfilled' && solarData.value) {
            result.environment.solar = solarData.value;
        }

        // === Bhoonidhi (ISRO Satellite Data) ===
        if (bhoondhiData.status === 'fulfilled' && bhoondhiData.value) {
            result.context.satellite = bhoondhiData.value;
        }

        // === OGD Health Facilities ===
        if (ogdHealthData.status === 'fulfilled' && ogdHealthData.value) {
            result.context.healthFacilities = ogdHealthData.value;
        }

        // === IUDX Smart City Data ===
        if (iudxData.status === 'fulfilled' && iudxData.value) {
            result.context.iudx = iudxData.value;
        }

        // === IUDX Catalogue Discovery ===
        if (iudxCatalogueData.status === 'fulfilled' && iudxCatalogueData.value) {
            result.context.iudxCatalogue = iudxCatalogueData.value;
        }

        // === CEPI Pollution Index ===
        if (cepiData.status === 'fulfilled' && cepiData.value) {
            result.context.cepi = cepiData.value;
        }

        // === Nearby Post Offices ===
        if (postOfficeData.status === 'fulfilled' && postOfficeData.value) {
            result.context.postOffices = postOfficeData.value;
        }

        // === Realtime layers (urban growth forecast, future: IMD, quakes, etc.) ===
        result.realtime = result.realtime || {};
        if (typeof RealtimeGrowth !== 'undefined') {
            try {
                const osmConstruction =
                    (result.categories?.landuse?.features?.construction?.count) || 0;
                const osmCommercial =
                    (result.categories?.shops?.features?.commercial?.count) || 0;
                const signals = await RealtimeGrowth.fetchCell(lat, lng, {
                    osm_construction_count: osmConstruction,
                    osm_commercial_density: osmCommercial,
                });
                const growth = RealtimeGrowth.scoreCell(signals);
                if (growth) result.realtime.growth = growth;
            } catch (e) {
                console.warn('[orchestrator] growth fetch skipped:', e);
            }
        }

        if (typeof RealtimeHeat !== 'undefined') {
            try {
                const heatSignals = await RealtimeHeat.fetchCell(lat, lng);
                const heat = RealtimeHeat.scoreCell(heatSignals);
                if (heat) result.realtime.heat = heat;
            } catch (e) {
                console.warn('[orchestrator] heat fetch skipped:', e);
            }
        }

        // === Compute intelligence scores ===
        result.scores = computeScores(result);

        // === Real-time signals — best-effort, never fail the cell fetch ===
        // Sources: NDMA SACHET CAP alerts, IMD warnings + forecast, NCS
        // earthquakes, Open-Meteo flood forecast. All best-effort.
        // NOTE: preserve any realtime keys already written upstream
        // (growth, heat) — earlier the unconditional reset to {} silently
        // erased those scores for every alert-bearing cell.
        result.realtime = result.realtime || {};
        const stateName = result.address?.state || '';
        const districtName = result.address?.district || '';
        // cityName is already declared above (line ~564). Reuse it.

        if (typeof RealtimeAlerts !== 'undefined') {
            try {
                const scoped = await RealtimeAlerts.getForLocation(stateName, cityName);
                const severe = RealtimeAlerts.filterBySeverity(scoped, 'Severe');
                result.realtime.sachet = {
                    alerts: scoped,
                    severeCount: severe.length,
                    summary: RealtimeAlerts.summary(scoped)
                };
            } catch { /* skip */ }
        }

        if (typeof RealtimeIMD !== 'undefined') {
            try {
                const [imdWarnings, imdForecast] = await Promise.all([
                    RealtimeIMD.getWarningsForLocation(districtName, cityName),
                    RealtimeIMD.getForecastForLocation(districtName, cityName),
                ]);
                result.realtime.imd = {
                    warnings: imdWarnings,
                    forecast: imdForecast,
                    worstColor: RealtimeIMD.worstColor(imdWarnings),
                };
            } catch { /* skip */ }
        }

        if (typeof RealtimeQuakes !== 'undefined') {
            try {
                const nearby = await RealtimeQuakes.getNearby(lat, lng, 200);
                result.realtime.quakes = {
                    nearby,
                    largest_nearby: nearby[0] || null,
                    count_within_200km: nearby.length,
                };
            } catch { /* skip */ }
        }

        if (typeof RealtimeFlood !== 'undefined') {
            try {
                const flood = await RealtimeFlood.getForecast(lat, lng);
                if (flood) result.realtime.flood = flood;
            } catch { /* skip */ }
        }

        // Merge building intelligence scores into main scores
        if (result.buildingIntel?.scores) {
            Object.assign(result.scores, result.buildingIntel.scores);
        }

        // Enhance real_estate_growth with building intel data
        if (result.buildingIntel?.metrics) {
            const bi = result.buildingIntel.metrics;
            const existing = result.scores.real_estate_growth?.value || 0;
            // Blend existing OSM-based score with building intelligence
            const devBoost = (bi.development_potential || 0) * 0.3;
            result.scores.real_estate_growth.value = Math.min(100, Math.round(existing * 0.7 + devBoost));
        }

        _cacheSet(key, result);
        return result;
    }

    async function fetchOSMData(lat, lng, radius) {
        const query = buildOverpassQuery(lat, lng, radius);
        return fetchWithRetry(OVERPASS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query)
        });
    }

    async function fetchWeather(lat, lng) {
        const url = `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,uv_index&timezone=auto`;
        try {
            const data = await fetchWithRetry(url);
            const c = data.current || {};
            return {
                temperature: c.temperature_2m,
                humidity: c.relative_humidity_2m,
                windSpeed: c.wind_speed_10m,
                uvIndex: c.uv_index,
                weatherCode: c.weather_code,
                weatherDesc: getWeatherDescription(c.weather_code),
                elevation: data.elevation
            };
        } catch { return {}; }
    }

    /**
     * AQI: Primary — CPCB via data.gov.in
     * Fallback — WAQI. Uses geo endpoint when a real token is configured
     * via window.DIGIPIN_CONFIG.waqiToken; otherwise falls back to the
     * city-name endpoint (the demo token cannot do geo).
     * cityName is passed in to avoid duplicate Nominatim call.
     */
    async function fetchAQI(lat, lng, cityName = 'Indore') {
        // Try CPCB first
        try {
            const cpcbResult = await fetchCPCB_AQI(cityName);
            if (cpcbResult && cpcbResult.aqi != null) return cpcbResult;
        } catch { /* fall through */ }

        // Fallback: WAQI
        const waqiToken = (typeof window !== 'undefined' && window.DIGIPIN_CONFIG?.waqiToken) || 'demo';
        const usingRealToken = waqiToken && waqiToken !== 'demo';
        const url = usingRealToken
            ? `https://api.waqi.info/feed/geo:${lat};${lng}/?token=${encodeURIComponent(waqiToken)}`
            : `https://api.waqi.info/feed/${encodeURIComponent(cityName)}/?token=demo`;

        try {
            const data = await fetchWithRetry(url);
            if (data.status !== 'ok') return {};

            const d = data.data;
            return {
                aqi: d.aqi,
                pm25: d.iaqi?.pm25?.v,
                pm10: d.iaqi?.pm10?.v,
                o3: d.iaqi?.o3?.v,
                no2: d.iaqi?.no2?.v,
                so2: d.iaqi?.so2?.v,
                aqiStation: d.city?.name,
                aqiDominant: d.dominentpol,
                aqiSource: usingRealToken ? 'WAQI (geo)' : 'WAQI (city)'
            };
        } catch {
            return {};
        }
    }

    /**
     * CPCB AQI via data.gov.in — 800 CPCB/SPCB monitoring stations
     * Now takes cityName directly instead of calling Nominatim again
     */
    async function fetchCPCB_AQI(cityName) {
        const url = `https://api.data.gov.in/resource/${CPCB_AQI_RESOURCE}?api-key=579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b&format=json&limit=5&filters[city]=${encodeURIComponent(cityName)}`;

        const data = await fetchWithRetry(url);
        const records = data.records || [];
        if (records.length === 0) return null;

        const best = records.find(r => r.pollutant_avg && parseFloat(r.pollutant_avg) > 0) || records[0];
        const pm25 = records.find(r => r.pollutant_id === 'PM2.5');
        const pm10 = records.find(r => r.pollutant_id === 'PM10');
        const findPollutant = (id) => records.find(r => r.pollutant_id === id);
        const no2 = findPollutant('NO2');
        const so2 = findPollutant('SO2');
        const o3 = findPollutant('Ozone');

        const aqiVal = pm25 ? computeAQI_PM25(parseFloat(pm25.pollutant_avg)) :
                       pm10 ? computeAQI_PM10(parseFloat(pm10.pollutant_avg)) : null;

        return {
            aqi: aqiVal,
            pm25: pm25 ? parseFloat(pm25.pollutant_avg) : undefined,
            pm10: pm10 ? parseFloat(pm10.pollutant_avg) : undefined,
            no2: no2 ? parseFloat(no2.pollutant_avg) : undefined,
            so2: so2 ? parseFloat(so2.pollutant_avg) : undefined,
            o3: o3 ? parseFloat(o3.pollutant_avg) : undefined,
            aqiStation: best.station || best.city,
            aqiDominant: pm25 ? 'pm25' : pm10 ? 'pm10' : undefined,
            aqiSource: 'CPCB'
        };
    }

    /** AQI sub-index for PM2.5 (Indian NAQI standard).
     *  Bands are contiguous (each cLow touches the previous cHigh) so any
     *  fractional concentration in a former gap (e.g. 30.5, 60.7) still maps
     *  to a sub-index instead of falling through to null. */
    function computeAQI_PM25(c) {
        if (c == null || !Number.isFinite(c) || c < 0) return null;
        const bp = [
            [0, 30, 0, 50], [30, 60, 51, 100], [60, 90, 101, 200],
            [90, 120, 201, 300], [120, 250, 301, 400], [250, 500, 401, 500]
        ];
        for (const [cLow, cHigh, iLow, iHigh] of bp) {
            if (c >= cLow && c <= cHigh) {
                return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (c - cLow) + iLow);
            }
        }
        return c > 500 ? 500 : null;   // above-scale readings cap at 500
    }

    /** AQI sub-index for PM10 (Indian NAQI standard). Contiguous bands — see
     *  computeAQI_PM25 for the gap-closing rationale. */
    function computeAQI_PM10(c) {
        if (c == null || !Number.isFinite(c) || c < 0) return null;
        const bp = [
            [0, 50, 0, 50], [50, 100, 51, 100], [100, 250, 101, 200],
            [250, 350, 201, 300], [350, 430, 301, 400], [430, 600, 401, 500]
        ];
        for (const [cLow, cHigh, iLow, iHigh] of bp) {
            if (c >= cLow && c <= cHigh) {
                return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (c - cLow) + iLow);
            }
        }
        return c > 600 ? 500 : null;   // above-scale readings cap at 500
    }

    async function fetchAddress(lat, lng) {
        try {
            const url = `${NOMINATIM_URL}?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
            const data = await fetchWithRetry(url, {
                headers: { 'User-Agent': 'DigiPinUrbanIntelligence/1.0' }
            });
            const addr = data.address || {};
            return {
                fullAddress: data.display_name,
                area: addr.suburb || addr.neighbourhood || addr.hamlet || '',
                city: addr.city || addr.town || addr.village || '',
                district: addr.county || addr.state_district || '',
                state: addr.state || '',
                pincode: addr.postcode || '',
                country: addr.country || ''
            };
        } catch {
            return {};
        }
    }

    /**
     * Fetch nearby Wikipedia summary for historical/cultural context
     */
    async function fetchWikipedia(lat, lng) {
        try {
            const searchUrl = `${WIKIPEDIA_URL}?action=query&list=geosearch&gscoord=${lat}|${lng}&gsradius=5000&gslimit=3&format=json&origin=*`;
            const searchData = await fetchWithRetry(searchUrl);
            const pages = searchData.query?.geosearch;
            if (!pages || pages.length === 0) return null;

            const pageIds = pages.map(p => p.pageid).join('|');
            const propUrl = `${WIKIPEDIA_URL}?action=query&prop=extracts&exintro=1&explaintext=1&pageids=${pageIds}&format=json&origin=*`;
            const propData = await fetchWithRetry(propUrl);
            const propPages = propData.query?.pages || {};

            const nearest = pages[0];
            const nearestExtract = propPages[nearest.pageid]?.extract;
            if (!nearestExtract) return null;

            const nearby = pages.slice(1).map(p => ({
                title: p.title,
                distance: p.dist,
                url: `https://en.wikipedia.org/?curid=${p.pageid}`
            }));

            return {
                title: nearest.title,
                distanceToCenter: nearest.dist,
                summary: nearestExtract.substring(0, 300) + (nearestExtract.length > 300 ? '...' : ''),
                url: `https://en.wikipedia.org/?curid=${nearest.pageid}`,
                nearby
            };
        } catch {
            return null;
        }
    }

    /**
     * Fetch elevation for flood risk assessment — 5-point sampling
     */
    async function fetchElevation(lat, lng) {
        try {
            const offset = 0.0018; // ~200m
            const points = [
                { latitude: lat, longitude: lng },
                { latitude: lat + offset, longitude: lng },
                { latitude: lat - offset, longitude: lng },
                { latitude: lat, longitude: lng + offset },
                { latitude: lat, longitude: lng - offset }
            ];
            const url = `${OPEN_ELEVATION_URL}?locations=${points.map(p => `${p.latitude},${p.longitude}`).join('|')}`;
            const data = await fetchWithRetry(url);
            const results = data.results || [];
            if (results.length === 0) return null;

            const centerElev = results[0].elevation;
            const surroundingElev = results.slice(1).map(r => r.elevation);
            const avgSurrounding = surroundingElev.reduce((s, e) => s + e, 0) / surroundingElev.length;

            return {
                center: centerElev,
                surrounding: avgSurrounding,
                relative: centerElev - avgSurrounding,
                isLowLying: centerElev < avgSurrounding - 2
            };
        } catch {
            return null;
        }
    }

    /**
     * Fetch the previous 365 days of daily precipitation from Open-Meteo's
     * archive API (free, no key) and return the annual total in mm.
     * Used as input to the flood_risk score. The window ends 7 days ago
     * to account for archive ingestion lag.
     */
    async function fetchHistoricalPrecipitation(lat, lng) {
        try {
            const end = new Date();
            end.setUTCDate(end.getUTCDate() - 7);
            const start = new Date(end);
            start.setUTCFullYear(start.getUTCFullYear() - 1);
            const fmt = (d) => d.toISOString().slice(0, 10);
            const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${fmt(start)}&end_date=${fmt(end)}&daily=precipitation_sum&timezone=Asia%2FKolkata`;
            const data = await fetchWithRetry(url);
            const sums = (data.daily?.precipitation_sum || []).filter(v => v != null);
            if (sums.length === 0) return null;
            const totalMm = sums.reduce((a, b) => a + b, 0);
            return {
                annualMm: Math.round(totalMm),
                daysCovered: sums.length,
                periodStart: fmt(start),
                periodEnd: fmt(end)
            };
        } catch {
            return null;
        }
    }

    /**
     * Fetch WorldPop population density estimate
     * Uses the WOPR point-total API for 100m resolution
     * Falls back to building-density proxy if unavailable
     */
    async function fetchWorldPop(lat, lng) {
        try {
            const url = `${WORLDPOP_API}?iso3=IND&lat=${lat}&lon=${lng}&agesex=false`;
            const data = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!data.ok) return null;
            const json = await data.json();
            // WOPR returns {data: [{pop: value, ...}]}
            const pop = json.data?.[0]?.pop;
            if (pop != null && pop > 0) {
                return {
                    source: 'WorldPop',
                    personsPerHectare: Math.round(pop),
                    densityLevel: pop > 300 ? 'very_high' : pop > 150 ? 'high' : pop > 50 ? 'medium' : 'low'
                };
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Open-Meteo Air Quality — grid-level AQI data for any lat/lng (no key needed)
     * Returns: PM2.5, PM10, NO2, SO2, O3, CO, US AQI, UV index
     */
    async function fetchOpenMeteoAQI(lat, lng) {
        try {
            const url = `${OPEN_METEO_AQI_URL}?latitude=${lat}&longitude=${lng}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi,uv_index&timezone=auto`;
            const data = await fetchWithRetry(url);
            const c = data.current || {};
            return {
                aqi: c.us_aqi,
                pm25: c.pm2_5,
                pm10: c.pm10,
                no2: c.nitrogen_dioxide,
                so2: c.sulphur_dioxide,
                o3: c.ozone,
                co: c.carbon_monoxide,
                uvIndex: c.uv_index,
                aqiSource: 'Open-Meteo'
            };
        } catch { return null; }
    }

    /**
     * Open-Meteo Solar Radiation — GHI, DNI, DHI for solar potential analysis
     * Uses the weather forecast API with solar radiation variables
     */
    async function fetchSolarRadiation(lat, lng) {
        try {
            // Use daily aggregates so values are meaningful regardless of time-of-day
            const url = `${OPEN_METEO_SOLAR_URL}?latitude=${lat}&longitude=${lng}&daily=shortwave_radiation_sum,sunshine_duration&timezone=auto&forecast_days=1`;
            const data = await fetchWithRetry(url);
            const d = data.daily || {};
            // shortwave_radiation_sum is in MJ/m² per day; convert to kWh/m²/day (÷3.6)
            const ghiMJ = d.shortwave_radiation_sum?.[0] ?? 0;
            const ghiKwh = Math.round(ghiMJ / 3.6 * 100) / 100;
            const sunHours = d.sunshine_duration?.[0] ? Math.round(d.sunshine_duration[0] / 3600 * 10) / 10 : null;
            return {
                ghiDaily: ghiKwh,                      // kWh/m²/day
                ghiMJ,                                 // MJ/m²/day (raw)
                sunshineDuration: sunHours,            // hours
                solarPotential: ghiKwh > 5.5 ? 'Excellent' :
                                ghiKwh > 4.0 ? 'Good' :
                                ghiKwh > 2.5 ? 'Moderate' : 'Low'
            };
        } catch { return null; }
    }

    /**
     * Bhoonidhi (ISRO) — Search satellite imagery available for a location
     * NOTE: ISRO API blocks CORS and is unreachable from browsers.
     * Kept as stub for future server-side proxy integration.
     */
    async function fetchBhoonidhi(/* lat, lng */) {
        // ISRO's Bhoonidhi API blocks CORS and often rejects non-Indian IPs.
        // Disabled to avoid ERR_FAILED errors slowing down the panel.
        return null;
    }

    /**
     * IUDX — Fetch smart city infrastructure near a location.
     * Loads public sample datasets from IUDX S3, caches them, and does
     * spatial proximity matching to find nearby bus stops, bike hubs, etc.
     */
    async function fetchIUDX(lat, lng) {
        try {
            // Load and cache all datasets on first call (retry if previous load was partial)
            const cacheEmpty = _iudxCache && Object.values(_iudxCache).every(v => v.length === 0);
            if (!_iudxCache || cacheEmpty) {
                const fetches = IUDX_DATASETS.map(async ds => {
                    try {
                        const resp = await fetch(`${IUDX_S3_BASE}/${ds.file}`);
                        if (!resp.ok) return { key: ds.key, data: [] };
                        return { key: ds.key, data: await resp.json() };
                    } catch { return { key: ds.key, data: [] }; }
                });
                const results = await Promise.all(fetches);
                _iudxCache = {};
                results.forEach(r => { _iudxCache[r.key] = r.data; });
            }

            // Haversine distance in km
            const toRad = d => d * Math.PI / 180;
            const haversine = (lat1, lng1, lat2, lng2) => {
                const R = 6371;
                const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
                const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            };

            // Find nearest items in each dataset (no radius limit — show closest 3)
            const nearby = {};
            let totalNearby = 0;
            IUDX_DATASETS.forEach(ds => {
                const items = (_iudxCache[ds.key] || [])
                    .map(item => {
                        const coords = item.location?.coordinates; // [lng, lat]
                        if (!coords) return null;
                        const dist = haversine(lat, lng, coords[1], coords[0]);
                        return {
                            name: item.stop_name || item.stationName || item.name || 'Unknown',
                            type: item.stop_desc || item.bikeType || '',
                            distance: dist < 1 ? Math.round(dist * 1000) + 'm' : (Math.round(dist * 10) / 10) + 'km',
                            distRaw: dist,
                            coords: [coords[1], coords[0]]
                        };
                    })
                    .filter(Boolean)
                    .sort((a, b) => a.distRaw - b.distRaw)
                    .slice(0, 3);
                nearby[ds.key] = { label: ds.label, icon: ds.icon, items, total: (_iudxCache[ds.key] || []).length };
                totalNearby += items.length;
            });

            if (totalNearby === 0) return null;
            return { nearby, totalNearby, source: 'IUDX (India Urban Data Exchange)' };
        } catch { return null; }
    }

    /**
     * IUDX Catalogue API — Discover available datasets for a city.
     * Uses cos.iudx.org.in/iudx/cat/v1/search (no auth needed).
     * Routed via allorigins proxy to bypass CORS restrictions from browser.
     * Returns dataset metadata: names, descriptions, resource types, providers.
     */
    async function fetchIUDXCatalogue(cityName) {
        try {
            const city = (cityName || 'indore').toLowerCase().trim();
            if (_iudxCatalogueCache[city]) return _iudxCatalogueCache[city];

            const catUrl = `https://cos.iudx.org.in/iudx/cat/v1/search?property=[type]&value=[[iudx:Resource]]&q=${encodeURIComponent(city)}&limit=50`;
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(catUrl)}`;
            const resp = await fetch(proxyUrl);
            if (!resp.ok) return null;
            const data = await resp.json();
            const results = data.results || [];
            if (results.length === 0) return null;

            // Categorize datasets by domain
            const domainKeywords = {
                transport: ['bus', 'transit', 'traffic', 'vehicle', 'parking', 'bike', 'transport', 'mobility'],
                environment: ['air', 'weather', 'pollution', 'flood', 'water', 'sewage', 'waste', 'environment'],
                energy: ['energy', 'solar', 'power', 'electricity', 'smart meter', 'lighting', 'streetlight', 'feeder'],
                civic: ['grievance', 'complaint', 'civic', 'municipal', 'ward', 'property tax', 'issue'],
                health: ['health', 'hospital', 'medical', 'ambulance'],
                safety: ['cctv', 'surveillance', 'police', 'fire', 'safety', 'emergency', 'addressing']
            };

            const datasets = results.map(r => {
                const text = `${r.label || ''} ${r.description || ''} ${(r.tags || []).join(' ')}`.toLowerCase();
                let domain = 'other';
                for (const [key, keywords] of Object.entries(domainKeywords)) {
                    if (keywords.some(kw => text.includes(kw))) { domain = key; break; }
                }
                return {
                    id: r.id,
                    label: r.label || r.id?.split('/').pop() || 'Unknown',
                    description: (r.description || '').slice(0, 200),
                    provider: r.provider?.name || r.provider || 'Unknown',
                    domain,
                    tags: (r.tags || []).slice(0, 5)
                };
            });

            // Group by domain
            const byDomain = {};
            datasets.forEach(ds => {
                if (!byDomain[ds.domain]) byDomain[ds.domain] = [];
                byDomain[ds.domain].push(ds);
            });

            const result = {
                city,
                totalDatasets: datasets.length,
                byDomain,
                domains: Object.keys(byDomain),
                source: 'IUDX Catalogue (catalogue.iudx.org.in)'
            };

            _iudxCatalogueCache[city] = result;
            return result;
        } catch { return null; }
    }

    /**
     * OGD India — Fetch nearby health facilities from data.gov.in
     */
    async function fetchOGDHealthFacilities(lat, lng, state) {
        try {
            const url = `https://api.data.gov.in/resource/${OGD_HOSPITAL_RESOURCE}?api-key=${OGD_API_KEY}&format=json&limit=10&filters[state]=${encodeURIComponent(state || 'Madhya Pradesh')}`;
            const data = await fetchWithRetry(url);
            const records = data.records || [];
            if (records.length === 0) return null;

            // Filter by proximity (rough lat/lng match within ~0.1 degree)
            const nearby = records.filter(r => {
                const rLat = parseFloat(r.latitude);
                const rLng = parseFloat(r.longitude);
                if (isNaN(rLat) || isNaN(rLng)) return false;
                return Math.abs(rLat - lat) < 0.1 && Math.abs(rLng - lng) < 0.1;
            });

            return {
                totalInState: data.total || records.length,
                nearbyFacilities: nearby.slice(0, 5).map(r => ({
                    name: r.hospital_name || r.facility_name || 'Unknown',
                    type: r.hospital_category || r.facility_type || '',
                    address: r.location || r.address || '',
                    beds: r.num_bed || r.total_beds || 'N/A'
                })),
                source: 'OGD India (data.gov.in)'
            };
        } catch { return null; }
    }

    /**
     * OGD India — CEPI (Comprehensive Environmental Pollution Index).
     * 43 critically polluted industrial clusters in India.
     * Loads once and checks if the user's city/state has a CPA nearby.
     */
    async function fetchCEPI(cityName, state) {
        try {
            if (!_cepiCache) {
                const url = `https://api.data.gov.in/resource/${OGD_CEPI_RESOURCE}?api-key=${OGD_API_KEY}&format=json&limit=50`;
                const data = await fetchWithRetry(url);
                _cepiCache = data.records || [];
            }
            if (_cepiCache.length === 0) return null;

            const city = (cityName || '').toLowerCase();
            const st = (state || '').toLowerCase();
            // Match by city name or state
            const matches = _cepiCache.filter(r => {
                const cluster = (r.industrial_cluster_area || '').toLowerCase();
                const rState = (r.state || '').toLowerCase();
                return cluster.includes(city) || (st && rState.includes(st));
            });
            if (matches.length === 0) return null;

            return {
                clusters: matches.map(r => ({
                    name: r.industrial_cluster_area,
                    state: r.state,
                    cepiScore2009: parseFloat(r.cepi_score_2009) || null,
                    cepiScore2011: parseFloat(r.cepi_score_2011) || null,
                    cepiScore2013: parseFloat(r.cepi_score_2013) || null,
                    moratorium: r.status_of_moratorium
                })),
                source: 'CPCB/MoEFCC via data.gov.in'
            };
        } catch { return null; }
    }

    /**
     * OGD India — Find nearest post offices from All India Pincode Directory.
     * 165K+ records with lat/lng. Filters by district for performance.
     */
    async function fetchNearbyPostOffices(lat, lng, district) {
        try {
            const dist = district || 'Indore';
            const url = `https://api.data.gov.in/resource/${OGD_PINCODE_RESOURCE}?api-key=${OGD_API_KEY}&format=json&limit=50&filters[district]=${encodeURIComponent(dist.toUpperCase())}`;
            const data = await fetchWithRetry(url);
            const records = data.records || [];
            if (records.length === 0) return null;

            const toRad = d => d * Math.PI / 180;
            const haversine = (lat1, lng1, lat2, lng2) => {
                const R = 6371;
                const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
                const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            };

            const nearby = records
                .map(r => {
                    const rLat = parseFloat(r.latitude);
                    const rLng = parseFloat(r.longitude);
                    if (isNaN(rLat) || isNaN(rLng)) return null;
                    return {
                        name: r.officename,
                        pincode: r.pincode,
                        type: r.officetype, // HO=Head, SO=Sub, BO=Branch
                        delivery: r.delivery === 'Delivery',
                        distance: haversine(lat, lng, rLat, rLng),
                        coords: [rLat, rLng]
                    };
                })
                .filter(Boolean)
                .sort((a, b) => a.distance - b.distance)
                .slice(0, 5)
                .map(r => ({
                    ...r,
                    distance: r.distance < 1 ? Math.round(r.distance * 1000) + 'm' : (Math.round(r.distance * 10) / 10) + 'km'
                }));

            if (nearby.length === 0) return null;
            return {
                nearest: nearby,
                totalInDistrict: data.total || records.length,
                district: dist,
                source: 'India Post via data.gov.in'
            };
        } catch { return null; }
    }

    function getWeatherDescription(code) {
        const d = {
            0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
            45: 'Foggy', 48: 'Depositing rime fog',
            51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
            61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
            71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
            80: 'Rain showers', 81: 'Moderate showers', 82: 'Violent showers',
            95: 'Thunderstorm', 96: 'T-storm with hail', 99: 'T-storm heavy hail'
        };
        return d[code] || 'Unknown';
    }

    // ===== SCORE NORMALIZATION =====
    // Log-scale normalization: compresses high values, preserves low-end discrimination
    // normLog(5, 50) ≈ 41, normLog(25, 50) ≈ 82 — better spread than linear
    function normLog(val, max) {
        if (val <= 0) return 0;
        return Math.min(100, Math.round((Math.log(1 + val) / Math.log(1 + max)) * 100));
    }

    /**
     * Religious diversity from a {religion: count} distribution.
     * Blends Shannon evenness (how balanced the mix is) with richness
     * (how many distinct religions are present, saturating at 4).
     * Falls back to a discounted log of total count when OSM has no
     * religion= tags, so the score does not collapse to zero in
     * under-tagged areas.
     */
    function religiousDiversityScore(subTypes, totalCount) {
        const counts = Object.values(subTypes || {}).filter(c => c > 0);
        const taggedTotal = counts.reduce((a, b) => a + b, 0);
        if (taggedTotal === 0) {
            // No religion= tags survived classification; weak fallback from raw count.
            return Math.round(normLog(totalCount, 20) * 0.5);
        }
        const richnessFactor = Math.min(counts.length / 4, 1);
        if (counts.length === 1) {
            // Single religion: evenness undefined; lean on richness + presence only.
            return Math.round(100 * (0.4 * richnessFactor) * Math.min(1, taggedTotal / 3));
        }
        const H = counts.reduce((acc, c) => {
            const p = c / taggedTotal;
            return acc - p * Math.log(p);
        }, 0);
        const evenness = H / Math.log(counts.length);
        return Math.round(100 * (0.6 * evenness + 0.4 * richnessFactor));
    }

    /**
     * Flood risk score (0-100, HIGHER = safer).
     * Inputs: elevation object from fetchElevation, precipitation object
     * from fetchHistoricalPrecipitation. Both may be null when sources fail.
     *
     * Baseline 50 at the Indian-context anchor of ~400m elevation, ~800mm/yr
     * rainfall, flat terrain. Each 100m gain adds ~8, each 200mm above baseline
     * subtracts ~10, and the local relative-elevation signal (whether the cell
     * sits in a basin vs on a ridge) is weighted strongest because that is the
     * single most predictive feature for urban waterlogging.
     *
     * Returns null when both elevation and precipitation are missing — score
     * is meaningless without at least one terrain or hydrology signal.
     */
    function floodRiskScore(elevation, precipitation) {
        if (elevation == null && precipitation == null) return null;
        let score = 50;

        if (elevation && typeof elevation === 'object') {
            const centerM = elevation.center;
            if (typeof centerM === 'number') {
                score += 0.08 * (centerM - 400);
            }
            if (typeof elevation.relative === 'number') {
                // Strong signal — sitting in a 5m+ basin vs on a 5m+ ridge.
                score += Math.max(-25, Math.min(15, elevation.relative * 2));
            }
            if (elevation.isLowLying) score -= 15;
        }

        if (precipitation && typeof precipitation.annualMm === 'number') {
            score -= 0.05 * (precipitation.annualMm - 800);
        }

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    /**
     * Compute 20 intelligence scores (0-100) using log-scale normalization
     * Max values calibrated for 500m radius in dense Indian cities
     */
    function computeScores(data) {
        const cats = data.categories || {};
        const get = (catKey, featureKey) => {
            return cats[catKey]?.features?.[featureKey]?.count || 0;
        };

        const scores = {
            walkability: {
                label: 'Walkability Score',
                value: normLog(
                    get('food', 'restaurants') * 2 + get('food', 'cafes') * 2 +
                    get('shopping', 'convenience') * 2 + get('shopping', 'supermarket') * 2 +
                    get('transport', 'bus_stop') * 3 + get('leisure', 'parks') * 3 +
                    get('infrastructure', 'footpath') * 1.5 + get('government', 'toilets') * 2, 80)
            },
            safety: {
                label: 'Safety Index',
                value: computeSafetyScore(data)
            },
            green: {
                label: 'Green Index',
                value: normLog(
                    get('leisure', 'parks') * 8 + get('leisure', 'garden') * 5 +
                    get('leisure', 'playground') * 3 + get('infrastructure', 'water_body') * 4 +
                    get('leisure', 'nature_reserve') * 15 + get('leisure', 'dog_park') * 3, 80)
            },
            connectivity: {
                label: 'Connectivity Score',
                value: normLog(
                    get('transport', 'bus_stop') * 3 + get('transport', 'metro') * 20 +
                    get('transport', 'railway') * 15 + get('transport', 'parking') * 2 +
                    get('transport', 'bicycle_rental') * 5 + get('infrastructure', 'roads') * 0.3, 100)
            },
            commercial: {
                label: 'Commercial Vibrancy',
                value: normLog(
                    get('shopping', 'mall') * 15 + get('shopping', 'supermarket') * 5 +
                    get('food', 'restaurants') * 2 + get('business', 'offices') * 3 +
                    get('shopping', 'marketplace') * 8 + get('shopping', 'department') * 10 +
                    get('shopping', 'convenience') * 1, 120)
            },
            education_score: {
                label: 'Education Index',
                value: normLog(
                    get('education', 'schools') * 5 + get('education', 'colleges') * 10 +
                    get('education', 'universities') * 20 + get('education', 'libraries') * 8 +
                    get('education', 'kindergartens') * 3, 80)
            },
            healthcare_access: {
                label: 'Healthcare Access',
                value: normLog(
                    get('healthcare', 'hospitals') * 12 + get('healthcare', 'clinics') * 3 +
                    get('healthcare', 'pharmacies') * 1.5 + get('healthcare', 'lab') * 5 +
                    get('healthcare', 'dentists') * 3 + get('healthcare', 'nursing_home') * 8, 100)
            },
            entertainment_score: {
                label: 'Entertainment Score',
                value: normLog(
                    get('entertainment', 'cinema') * 8 + get('leisure', 'parks') * 3 +
                    get('leisure', 'gym') * 4 + get('entertainment', 'nightclub') * 6 +
                    get('entertainment', 'museum') * 10 + get('entertainment', 'theatre') * 8 +
                    get('leisure', 'sports_centre') * 5, 80)
            },
            livability: { label: 'Livability Index', value: 0 },
            investment: {
                label: 'Investment Potential',
                value: normLog(
                    get('landuse', 'construction') * 12 + get('landuse', 'vacant') * 8 +
                    get('transport', 'bus_stop') * 2 + get('transport', 'metro') * 20 +
                    get('business', 'coworking') * 8 + get('business', 'estate_agent') * 10, 100)
            },
            tourism: {
                label: 'Tourism Appeal',
                value: normLog(
                    get('accommodation', 'hotel') * 5 + get('entertainment', 'monument') * 8 +
                    get('entertainment', 'museum') * 10 + get('accommodation', 'attraction') * 8 +
                    get('food', 'restaurants') * 1 + get('accommodation', 'guest_house') * 3 +
                    get('entertainment', 'worship') * 2, 80)
            },
            infra_maturity: {
                label: 'Infrastructure Maturity',
                value: normLog(
                    get('infrastructure', 'street_lamps') * 0.5 + get('infrastructure', 'cell_tower') * 8 +
                    get('infrastructure', 'power') * 5 + get('government', 'post_office') * 8 +
                    get('infrastructure', 'roads') * 0.2 + get('infrastructure', 'bridge') * 10, 100)
            },
            noise_estimate: {
                label: 'Quietness (Higher=Better)',
                value: computeQuietnessScore(data)
            },
            population_proxy: {
                label: 'Population Density',
                value: computePopulationScore(data)
            },
            food_diversity: {
                label: 'Food Diversity',
                value: normLog(
                    get('food', 'restaurants') + get('food', 'cafes') + get('food', 'fast_food') +
                    get('food', 'bakery') + get('food', 'bars') + get('food', 'ice_cream') +
                    get('food', 'confectionery') + get('food', 'butcher'), 40)
            },
            religious_diversity: (() => {
                const worship = cats['entertainment']?.features?.['worship'];
                return {
                    label: 'Religious Diversity',
                    value: religiousDiversityScore(worship?.subTypes, worship?.count || 0)
                };
            })(),
            public_service: {
                label: 'Public Service Access',
                value: normLog(
                    get('government', 'post_office') * 8 + get('government', 'govt_office') * 8 +
                    get('government', 'community') * 5 + get('government', 'toilets') * 3 +
                    get('government', 'townhall') * 10 + get('government', 'social') * 5, 60)
            },
            real_estate_growth: {
                label: 'Real Estate Growth',
                value: normLog(
                    get('landuse', 'construction') * 15 + get('landuse', 'vacant') * 10 +
                    get('business', 'estate_agent') * 12 + get('transport', 'ev_charging') * 8, 80)
            },
            digital_readiness: {
                label: 'Digital Readiness',
                value: normLog(
                    get('infrastructure', 'cell_tower') * 8 + get('business', 'coworking') * 12 +
                    get('business', 'it_company') * 10 + get('transport', 'ev_charging') * 6 +
                    get('shopping', 'electronics') * 3 + get('shopping', 'mobile') * 3, 80)
            },
            flood_risk: {
                label: 'Flood Risk (Higher=Riskier)',
                value: computeFloodRisk(data)
            }
        };

        // Livability = weighted average of key quality-of-life scores
        const livWeights = {
            walkability: 2, safety: 3, green: 2, connectivity: 1.5,
            healthcare_access: 2, noise_estimate: 1.5, food_diversity: 1
        };
        let livSum = 0, livW = 0;
        for (const [k, w] of Object.entries(livWeights)) {
            livSum += (scores[k]?.value || 0) * w;
            livW += w;
        }
        scores.livability.value = Math.round(livSum / livW);

        return scores;
    }

    /**
     * Enhanced safety score — uses street lamps density, police presence, lighting coverage
     * Combines: infrastructure lighting + emergency services + building density (eyes on street)
     */
    function computeSafetyScore(data) {
        const cats = data.categories || {};
        const get = (catKey, featureKey) => cats[catKey]?.features?.[featureKey]?.count || 0;

        const lamps = get('infrastructure', 'street_lamps');
        const police = get('government', 'police');
        const fire = get('government', 'fire');
        const hospitals = get('healthcare', 'hospitals');
        const footpaths = get('infrastructure', 'footpath');
        const buildings = get('landuse', 'buildings_total');
        const industrial = get('landuse', 'industrial_area');
        const nightclubs = get('entertainment', 'nightclub');

        // Street lamp density is the strongest proxy for nighttime safety
        // 50+ lamps in 500m radius = well-lit area
        let score = normLog(lamps * 2 + police * 15 + fire * 12 + hospitals * 5, 100);

        // "Eyes on the street" bonus — mixed-use areas with buildings are safer
        score += Math.min(15, normLog(buildings * 0.1 + footpaths * 2, 30));

        // Penalize isolated industrial zones (less foot traffic at night)
        score -= industrial * 8;
        score -= nightclubs * 3;

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    /**
     * Enhanced noise estimation — road classification + commercial activity + transport hubs
     * Returns quietness (higher = quieter)
     */
    function computeQuietnessScore(data) {
        const cats = data.categories || {};
        const get = (catKey, featureKey) => cats[catKey]?.features?.[featureKey]?.count || 0;

        // Noise sources with calibrated weights
        let noiseLevel = 0;

        // Roads by classification (major roads = much noisier)
        // We don't have individual road classes from our classifier, but we can use total + bus stops as proxy
        noiseLevel += get('infrastructure', 'roads') * 0.3;  // residential roads
        noiseLevel += get('transport', 'bus_stop') * 4;       // bus routes = busy roads
        noiseLevel += get('transport', 'railway') * 15;       // railway very noisy
        noiseLevel += get('transport', 'metro') * 8;
        noiseLevel += get('landuse', 'industrial_area') * 12;
        noiseLevel += get('entertainment', 'nightclub') * 6;
        noiseLevel += get('shopping', 'marketplace') * 5;
        noiseLevel += get('transport', 'fuel') * 3;           // petrol pumps on busy roads
        noiseLevel += get('entertainment', 'cinema') * 2;

        // Noise dampeners
        noiseLevel -= get('leisure', 'parks') * 3;
        noiseLevel -= get('leisure', 'garden') * 2;
        noiseLevel -= get('leisure', 'nature_reserve') * 5;

        // Convert to quietness (invert, with log compression)
        // noiseLevel of 0 = very quiet (100), 80+ = very noisy (0-10)
        const quietness = 100 - normLog(Math.max(0, noiseLevel), 80);
        return Math.max(0, Math.min(100, quietness));
    }

    /**
     * Enhanced population score — uses WorldPop if available, falls back to building density
     */
    function computePopulationScore(data) {
        const pop = data.environment?.populationDensity;

        // If WorldPop data available, use it directly
        if (pop && pop.personsPerHectare > 0) {
            // 500+ people/hectare = max density for Indian cities (slum areas)
            return normLog(pop.personsPerHectare, 500);
        }

        // Fallback: building density proxy
        const cats = data.categories || {};
        const get = (catKey, featureKey) => cats[catKey]?.features?.[featureKey]?.count || 0;

        const resBuildings = get('landuse', 'res_buildings');
        const totalBuildings = get('landuse', 'buildings_total');
        const convenience = get('shopping', 'convenience');
        const resAreas = get('landuse', 'residential_area');

        // Weight residential buildings more, add convenience stores as proxy
        return normLog(
            resBuildings * 5 + totalBuildings * 0.3 + convenience * 8 + resAreas * 10, 200
        );
    }

    /**
     * Flood risk score (0-100, higher = more risky)
     */
    function computeFloodRisk(data) {
        const cats = data.categories || {};
        const get = (catKey, featureKey) => cats[catKey]?.features?.[featureKey]?.count || 0;
        const elev = data.environment?.elevation;

        let risk = 30; // baseline for Indian urban areas

        if (elev && typeof elev === 'object') {
            if (elev.isLowLying) risk += 25;
            else if (elev.relative < 0) risk += 10;
            else if (elev.relative > 5) risk -= 15;
        }

        risk += get('infrastructure', 'water_body') * 8;
        risk += get('infrastructure', 'river') * 12;
        risk -= get('infrastructure', 'bridge') * 5;
        risk -= get('infrastructure', 'power') * 2;
        risk += get('landuse', 'industrial_area') * 5;

        return Math.max(0, Math.min(100, Math.round(risk)));
    }

    // ===== EXPORT FUNCTIONS =====

    function exportToJSON(data, filename = 'digipin_data.json') {
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportToCSV(data, filename = 'digipin_features.csv') {
        let csv = 'Category,Feature Key,Feature Name,Count\n';
        for (const [, cat] of Object.entries(data.categories)) {
            for (const [featKey, feat] of Object.entries(cat.features)) {
                if (feat.count > 0) {
                    csv += `"${cat.name}","${featKey}","${feat.label}",${feat.count}\n`;
                }
            }
        }
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    return {
        fetchAllFeatures,
        CATEGORIES,
        fetchOSMData,
        fetchWeather,
        fetchAQI,
        fetchOpenMeteoAQI,
        fetchSolarRadiation,
        fetchBhoonidhi,
        fetchOGDHealthFacilities,
        fetchIUDX,
        fetchIUDXCatalogue,
        fetchCEPI,
        fetchNearbyPostOffices,
        fetchAddress,
        fetchWikipedia,
        fetchElevation,
        fetchWorldPop,
        classifyElements,
        computeAQI_PM25,
        computeAQI_PM10,
        _coalesce,
        clearPersistentCache: _idbClear,
        exportToJSON,
        exportToCSV,
        getRadiusForZoom
    };
})();
