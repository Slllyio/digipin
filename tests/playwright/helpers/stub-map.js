// Minimal MapLibre / PMTiles stand-in for running the Playwright specs where the
// CDNs are unreachable (STUB_MAP=1). Records sources/layers, fires load, move and
// idle events, swallows the rest. CI runs the real libraries; this is local-only.
(() => {
  const listeners = {};
  function makeMap(opts) {
    const state = { layers: {}, sources: {}, center: opts.center || { lng: 75.8577, lat: 22.7196 }, zoom: opts.zoom || 12, pitch: 0, bearing: 0 };
    const map = {
      _state: state,
      on(evt, a, b) { const fn = typeof a === 'function' ? a : b; if (evt === 'load' || evt === 'idle' || evt === 'style.load') setTimeout(fn, 0); (listeners[evt] = listeners[evt] || []).push(fn); return map; },
      once(evt, a, b) { return map.on(evt, a, b); },
      off() { return map; },
      addSource(id, s) { state.sources[id] = s; }, getSource(id) { const s = state.sources[id]; return s ? Object.assign({ setData() {}, getTile() {} }, s) : undefined; }, removeSource(id) { delete state.sources[id]; },
      addLayer(l) { state.layers[l.id] = l; }, getLayer(id) { return state.layers[id]; }, removeLayer(id) { delete state.layers[id]; },
      setLayoutProperty() {}, setPaintProperty() {}, setFilter() {}, setLight() {}, setTerrain() {}, setSky() {}, setFog() {},
      getCenter() { return { ...state.center, wrap() { return this; } }; }, getZoom() { return state.zoom; }, getPitch() { return state.pitch; }, getBearing() { return state.bearing; },
      getBounds() { const c = state.center; return { getSouth: () => c.lat - 0.02, getNorth: () => c.lat + 0.02, getWest: () => c.lng - 0.03, getEast: () => c.lng + 0.03, toArray() { return [[c.lng - 0.03, c.lat - 0.02], [c.lng + 0.03, c.lat + 0.02]]; } }; },
      getCanvas() { const c = document.createElement('canvas'); c.width = 800; c.height = 600; return c; },
      getContainer() { return document.getElementById('map'); },
      getStyle() { return { layers: Object.values(state.layers), sources: state.sources }; },
      isStyleLoaded() { return true; }, loaded() { return true; }, areTilesLoaded() { return true; },
      queryRenderedFeatures() { return []; }, querySourceFeatures() { return []; },
      project() { return { x: 0, y: 0 }; }, unproject(p) { return { lng: state.center.lng, lat: state.center.lat }; },
      fire(evt, d) { (listeners[evt] || []).slice().forEach(fn => { try { fn(Object.assign({ type: evt, target: map }, d || {})); } catch (e) { console.error('listener ' + evt + ' ' + e.message); } }); return map; }, flyTo(o) { if (o.center) state.center = Array.isArray(o.center) ? { lng: o.center[0], lat: o.center[1] } : o.center; if (o.zoom != null) state.zoom = o.zoom; if (o.pitch != null) state.pitch = o.pitch; setTimeout(() => { map.fire('movestart'); map.fire('move'); map.fire('zoomend'); map.fire('moveend'); map.fire('idle'); }, 0); }, easeTo(o) { map.flyTo(o); }, jumpTo(o) { map.flyTo(o); }, fitBounds() {}, resize() {}, triggerRepaint() {}, setCenter(c) { state.center = Array.isArray(c) ? { lng: c[0], lat: c[1] } : c; }, setZoom(z) { state.zoom = z; }, setPitch() {}, setBearing() {}, setStyle() {}, addControl() {}, removeControl() {}, hasImage() { return false; }, addImage() {}, loadImage(u, cb) { cb && cb(null, null); }, getLight() { return {}; }, setMaxPitch() {}, setMinZoom() {}, remove() {}, panBy() {}, stop() {}, setTransformRequest() {},
      getMaxZoom() { return 22; }, getMinZoom() { return 0; }, dragRotate: { enable() {}, disable() {} }, touchZoomRotate: { enable() {}, disable() {} }, scrollZoom: { enable() {}, disable() {} }, doubleClickZoom: { enable() {}, disable() {} }, boxZoom: { enable() {}, disable() {} }, keyboard: { enable() {}, disable() {} }, dragPan: { enable() {}, disable() {} },
      transform: { zoom: 12 },
    };
    return map;
  }
  function Pop() { return { setLngLat() { return this; }, setHTML() { return this; }, setDOMContent() { return this; }, addTo() { return this; }, remove() {}, on() { return this; }, isOpen() { return false; } }; }
  function Marker() { return { setLngLat() { return this; }, addTo() { return this; }, remove() {}, getElement() { return document.createElement('div'); }, setPopup() { return this; }, getLngLat() { return { lng: 0, lat: 0 }; } }; }
  window.maplibregl = { Map: function (o) { return makeMap(o); }, Popup: Pop, Marker, NavigationControl: function () {}, ScaleControl: function () {}, GeolocateControl: function () {}, AttributionControl: function () {}, FullscreenControl: function () {}, addProtocol() {}, setWorkerCount() {}, version: 'stub',
    LngLatBounds: function () { return { extend() { return this; }, isEmpty() { return true; } }; }, LngLat: function (lng, lat) { return { lng, lat }; } };
  window.pmtiles = { Protocol: function () { return { tile() {} }; }, PMTiles: function () { return { getHeader: async () => ({}) }; } };
})();
