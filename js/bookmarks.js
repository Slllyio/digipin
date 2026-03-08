/**
 * Bookmarks / User Annotations — Save cells with notes to localStorage
 */
const Bookmarks = (() => {
    const STORAGE_KEY = 'digipin_bookmarks';
    let _bookmarks = [];
    let _markers = [];

    function init() {
        _bookmarks = load();
        renderMarkers();
    }

    function load() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
        } catch { return []; }
    }

    function save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_bookmarks));
    }

    function add(cell, note = '') {
        if (_bookmarks.some(b => b.code === cell.code)) {
            App.showToast('Already Bookmarked', `${cell.code} is already saved`, 'warning');
            return;
        }
        _bookmarks.push({
            code: cell.code,
            lat: cell.center.lat,
            lng: cell.center.lng,
            note,
            timestamp: Date.now()
        });
        save();
        renderMarkers();
        App.showToast('Bookmarked', `${cell.code} saved`, 'success');
    }

    function remove(code) {
        _bookmarks = _bookmarks.filter(b => b.code !== code);
        save();
        renderMarkers();
    }

    function updateNote(code, note) {
        const bm = _bookmarks.find(b => b.code === code);
        if (bm) { bm.note = note; save(); }
    }

    function getAll() { return _bookmarks; }

    function renderMarkers() {
        const map = MapModule.getMap();
        if (!map) return;
        
        _markers.forEach(m => m.remove());
        _markers = [];
        
        _bookmarks.forEach(bm => {
            const el = document.createElement('div');
            el.className = 'bookmark-marker';
            el.innerHTML = '<div class="bm-icon" style="background:#eab308;color:#000;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:16px;">&#9733;</div>';

            const popupEl = document.createElement('div');
            popupEl.style.fontFamily = 'Inter, sans-serif';
            const codeEl = document.createElement('strong');
            codeEl.textContent = bm.code;
            popupEl.appendChild(codeEl);
            if (bm.note) {
                popupEl.appendChild(document.createElement('br'));
                const noteEl = document.createElement('span');
                noteEl.textContent = bm.note;
                noteEl.style.fontSize = '11px';
                popupEl.appendChild(noteEl);
            }
            
            const popup = new maplibregl.Popup({ offset: 15 }).setDOMContent(popupEl);

            const marker = new maplibregl.Marker({ element: el })
                .setLngLat([bm.lng, bm.lat])
                .setPopup(popup)
                .addTo(map);

            _markers.push(marker);
        });
    }

    function openPanel() {
        const panel = document.getElementById('bookmarks-panel');
        if (!panel) return;
        panel.classList.add('open');
        renderPanel();
    }

    function closePanel() {
        const panel = document.getElementById('bookmarks-panel');
        if (panel) panel.classList.remove('open');
    }

    function renderPanel() {
        const list = document.getElementById('bookmarks-list');
        if (!list) return;
        while (list.firstChild) list.removeChild(list.firstChild);

        if (_bookmarks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'bm-empty';
            empty.textContent = 'No bookmarks yet. Click the star on any cell to save it.';
            list.appendChild(empty);
            return;
        }

        _bookmarks.forEach(bm => {
            const item = document.createElement('div');
            item.className = 'bm-item';

            const info = document.createElement('div');
            info.className = 'bm-info';
            info.style.cursor = 'pointer';
            info.addEventListener('click', () => MapModule.flyTo(bm.lat, bm.lng, 17));

            const code = document.createElement('div');
            code.className = 'bm-code';
            code.textContent = bm.code;
            info.appendChild(code);

            if (bm.note) {
                const note = document.createElement('div');
                note.className = 'bm-note';
                note.textContent = bm.note;
                info.appendChild(note);
            }

            const date = document.createElement('div');
            date.className = 'bm-date';
            date.textContent = new Date(bm.timestamp).toLocaleDateString();
            info.appendChild(date);

            const delBtn = document.createElement('button');
            delBtn.className = 'bm-delete';
            delBtn.textContent = '\u2715';
            delBtn.addEventListener('click', () => { remove(bm.code); renderPanel(); });

            item.appendChild(info);
            item.appendChild(delBtn);
            list.appendChild(item);
        });
    }

    return { init, add, remove, updateNote, getAll, openPanel, closePanel };
})();
