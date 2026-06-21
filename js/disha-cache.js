/**
 * DISHA Cache — IndexedDB response cache with TTL
 *
 * Caches LLM responses to avoid redundant API calls for repeated questions.
 * Also caches city scan cell data to speed up re-scans.
 *
 * Cache key = cellCode + contextType + normalized question
 * TTL: 1 hour for environment-sensitive, 24 hours for static data
 */

const DISHACache = (() => {
    const DB_NAME = 'disha_cache';
    const DB_VERSION = 1;
    const STORE_RESPONSES = 'responses';
    const STORE_CELLS = 'cells';

    // TTL in milliseconds
    const TTL = {
        environment: 60 * 60 * 1000,       // 1 hour (weather/AQI changes)
        building: 24 * 60 * 60 * 1000,     // 24 hours (static morphology)
        infrastructure: 12 * 60 * 60 * 1000, // 12 hours
        investment: 12 * 60 * 60 * 1000,    // 12 hours
        general: 6 * 60 * 60 * 1000,        // 6 hours
        cell_data: 30 * 60 * 1000           // 30 min (for city scan cell caching)
    };

    let _db = null;

    // ===== DB INIT =====
    function openDB() {
        if (_db) return Promise.resolve(_db);

        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;

                if (!db.objectStoreNames.contains(STORE_RESPONSES)) {
                    const store = db.createObjectStore(STORE_RESPONSES, { keyPath: 'key' });
                    store.createIndex('timestamp', 'timestamp');
                }

                if (!db.objectStoreNames.contains(STORE_CELLS)) {
                    const store = db.createObjectStore(STORE_CELLS, { keyPath: 'key' });
                    store.createIndex('timestamp', 'timestamp');
                }
            };

            req.onsuccess = (e) => {
                _db = e.target.result;
                resolve(_db);
            };

            req.onerror = () => reject(req.error);
        });
    }

    // ===== KEY GENERATION =====
    function normalizeQuestion(question) {
        return question.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[?!.,;:]+$/g, '');
    }

    function makeResponseKey(cellCode, contextType, question, lang) {
        const norm = normalizeQuestion(question);
        // Include the UI language: a Hindi answer must not be replayed in English
        // mode (or vice versa) for the same cell+question within the TTL.
        return `${cellCode}:${contextType}:${lang || 'en'}:${norm}`;
    }

    function makeCellKey(lat, lng) {
        // Round to 4 decimal places (~11m resolution) for cache hits on nearby points
        return `cell:${lat.toFixed(4)}:${lng.toFixed(4)}`;
    }

    // ===== RESPONSE CACHE =====
    async function getResponse(cellCode, contextType, question, lang) {
        try {
            const db = await openDB();
            const key = makeResponseKey(cellCode, contextType, question, lang);
            const ttl = TTL[contextType] || TTL.general;

            return new Promise((resolve) => {
                const tx = db.transaction(STORE_RESPONSES, 'readonly');
                const store = tx.objectStore(STORE_RESPONSES);
                const req = store.get(key);

                req.onsuccess = () => {
                    const entry = req.result;
                    if (!entry) {
                        resolve(null);
                        return;
                    }

                    // Check TTL
                    if (Date.now() - entry.timestamp > ttl) {
                        // Expired — delete and return null
                        deleteResponse(key);
                        resolve(null);
                        return;
                    }

                    resolve({
                        response: entry.response,
                        provider: entry.provider,
                        cached: true,
                        age: Date.now() - entry.timestamp
                    });
                };

                req.onerror = () => resolve(null);
            });
        } catch {
            return null;
        }
    }

    async function putResponse(cellCode, contextType, question, response, provider, lang) {
        try {
            const db = await openDB();
            const key = makeResponseKey(cellCode, contextType, question, lang);

            return new Promise((resolve) => {
                const tx = db.transaction(STORE_RESPONSES, 'readwrite');
                const store = tx.objectStore(STORE_RESPONSES);
                store.put({
                    key,
                    response,
                    provider,
                    contextType,
                    timestamp: Date.now()
                });
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    async function deleteResponse(key) {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_RESPONSES, 'readwrite');
            tx.objectStore(STORE_RESPONSES).delete(key);
        } catch { /* ignore */ }
    }

    // ===== CELL DATA CACHE (for city scan) =====
    async function getCellData(lat, lng) {
        try {
            const db = await openDB();
            const key = makeCellKey(lat, lng);

            return new Promise((resolve) => {
                const tx = db.transaction(STORE_CELLS, 'readonly');
                const store = tx.objectStore(STORE_CELLS);
                const req = store.get(key);

                req.onsuccess = () => {
                    const entry = req.result;
                    if (!entry) {
                        resolve(null);
                        return;
                    }

                    if (Date.now() - entry.timestamp > TTL.cell_data) {
                        deleteCellData(key);
                        resolve(null);
                        return;
                    }

                    resolve(entry.data);
                };

                req.onerror = () => resolve(null);
            });
        } catch {
            return null;
        }
    }

    async function putCellData(lat, lng, data) {
        try {
            const db = await openDB();
            const key = makeCellKey(lat, lng);

            return new Promise((resolve) => {
                const tx = db.transaction(STORE_CELLS, 'readwrite');
                const store = tx.objectStore(STORE_CELLS);
                store.put({
                    key,
                    data,
                    timestamp: Date.now()
                });
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    async function deleteCellData(key) {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_CELLS, 'readwrite');
            tx.objectStore(STORE_CELLS).delete(key);
        } catch { /* ignore */ }
    }

    // ===== CACHE MANAGEMENT =====
    async function clear() {
        try {
            const db = await openDB();
            const tx = db.transaction([STORE_RESPONSES, STORE_CELLS], 'readwrite');
            tx.objectStore(STORE_RESPONSES).clear();
            tx.objectStore(STORE_CELLS).clear();
            return true;
        } catch {
            return false;
        }
    }

    async function getStats() {
        try {
            const db = await openDB();
            return new Promise((resolve) => {
                const tx = db.transaction([STORE_RESPONSES, STORE_CELLS], 'readonly');
                let responseCount = 0;
                let cellCount = 0;

                const rReq = tx.objectStore(STORE_RESPONSES).count();
                rReq.onsuccess = () => { responseCount = rReq.result; };

                const cReq = tx.objectStore(STORE_CELLS).count();
                cReq.onsuccess = () => { cellCount = cReq.result; };

                tx.oncomplete = () => {
                    resolve({ responses: responseCount, cells: cellCount });
                };
                tx.onerror = () => resolve({ responses: 0, cells: 0 });
            });
        } catch {
            return { responses: 0, cells: 0 };
        }
    }

    // Prune expired entries (call periodically)
    async function prune() {
        try {
            const db = await openDB();
            const now = Date.now();
            const maxAge = 24 * 60 * 60 * 1000; // Remove anything older than 24h

            const tx = db.transaction([STORE_RESPONSES, STORE_CELLS], 'readwrite');

            // Prune responses
            const rStore = tx.objectStore(STORE_RESPONSES);
            const rCursor = rStore.openCursor();
            rCursor.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (now - cursor.value.timestamp > maxAge) {
                        cursor.delete();
                    }
                    cursor.continue();
                }
            };

            // Prune cells
            const cStore = tx.objectStore(STORE_CELLS);
            const cCursor = cStore.openCursor();
            cCursor.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (now - cursor.value.timestamp > TTL.cell_data) {
                        cursor.delete();
                    }
                    cursor.continue();
                }
            };
        } catch { /* ignore */ }
    }

    return {
        getResponse,
        putResponse,
        getCellData,
        putCellData,
        clear,
        getStats,
        prune,
        normalizeQuestion
    };
})();
