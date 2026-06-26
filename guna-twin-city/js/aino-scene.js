/**
 * AinoScene — high-fidelity "Aino Studio" 3D model of Guna, in Three.js.
 *
 * The deck.gl overlay (aino-twin.js) hit a hard ceiling: no real shadows (deck's
 * shadow pass collapses extrusion under MapboxOverlay), so it reads as a flat
 * white model. This is a STANDALONE Three.js scene — real directional shadow
 * maps + SSAO ambient occlusion + tone-mapped materials — to actually approach
 * the aino.world illustration: soft shadows, refined white massing, rounded
 * trees, blue water with width, grey roads with width.
 *
 * Opens as a fullscreen overlay from the "Aino 3D" button; OrbitControls to
 * fly around. Reads the same committed assets the deck twin uses.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const BASE = 'data/vectors/';
const C = { lat: 24.6354, lng: 77.3126 };
const MLAT = 110540, MLNG = 111320 * Math.cos(C.lat * Math.PI / 180);
const RANGE = 5000;                       // metres from centre — covers most of the city + the
                                          // two nearest water bodies (~3.8/4.6 km). Guna's rivers
                                          // are 12 km+ out (rural), so no in-core river exists.

const px = lng => (lng - C.lng) * MLNG;   // east  → +X
const pz = lat => -(lat - C.lat) * MLAT;  // north → -Z (footprint shapes use +sy then rotateX)

let _container = null, _renderer = null, _scene = null, _camera = null;
let _controls = null, _composer = null, _raf = 0, _active = false, _built = false;
let _lineMats = [];                       // LineMaterials needing resolution updates on resize

// ───────────────────────── data ─────────────────────────
async function _json(url) {
    const r = await fetch(url, { cache: 'force-cache' });
    return r.ok ? r.json() : null;
}
function _height(area) {
    let f = area < 50 ? 1 : area < 110 ? 2 : area < 220 ? 3 : area < 450 ? 4 : area < 900 ? 5 : 6;
    const j = Math.abs(Math.sin(area * 12.9898)) ;     // stable pseudo-jitter
    if (j > 0.86) f += 1; else if (j < 0.16 && f > 1) f -= 1;
    return f * 3.2;
}
function _inRange(lng, lat) {
    const x = px(lng), z = pz(lat);
    return x * x + z * z < RANGE * RANGE;
}

// ───────────────────────── builders ─────────────────────────
function _buildBuildings(gj) {
    const geoms = [];
    for (const f of (gj.features || [])) {
        const g = f.geometry; if (!g || g.type !== 'Polygon') continue;
        const ring = g.coordinates[0]; if (!ring || ring.length < 4) continue;
        const cx = ring[0][0], cy = ring[0][1];
        if (!_inRange(cx, cy)) continue;
        const shape = new THREE.Shape();
        for (let i = 0; i < ring.length; i++) {
            const x = px(ring[i][0]), y = (ring[i][1] - C.lat) * MLAT;   // shape XY (Y=north)
            i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
        }
        const h = _height(+(f.properties && f.properties.area_m2) || 0);
        const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);                 // shape plane → ground (XZ), depth → +Y
        geoms.push(geo);
    }
    if (!geoms.length) return null;
    const merged = mergeGeometries(geoms, false);
    geoms.forEach(g => g.dispose());
    merged.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ color: 0xf7f8fa, roughness: 0.92, metalness: 0.0 });
    mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(transformed,1.0)).xyz;')
            .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n vWNrm = normalize(mat3(modelMatrix) * objectNormal);');
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
            .replace('#include <dithering_fragment>', `
                if (abs(vWNrm.y) < 0.5 && vWPos.y > 0.4) {       // walls: delicate window grid
                    float fy = abs(fract(vWPos.y / 3.2) - 0.5);   // floor lines (per 3.2 m)
                    float floors = 1.0 - smoothstep(0.46, 0.49, fy);
                    float mx = abs(fract(vWPos.x / 3.4) - 0.5);   // mullions aligned to facade axes
                    float mz = abs(fract(vWPos.z / 3.4) - 0.5);
                    float mull = max(1.0 - smoothstep(0.46, 0.49, mx), 1.0 - smoothstep(0.46, 0.49, mz));
                    float grid = clamp(max(floors, mull), 0.0, 1.0);
                    gl_FragColor.rgb *= mix(1.0, 0.93, grid);     // light, crisp
                } else if (vWNrm.y > 0.5 && vWPos.y > 0.4) {     // roofs: very faint panel grid
                    float rx = abs(fract(vWPos.x / 4.0) - 0.5);
                    float rz = abs(fract(vWPos.z / 4.0) - 0.5);
                    float roof = max(1.0 - smoothstep(0.47, 0.49, rx), 1.0 - smoothstep(0.47, 0.49, rz));
                    gl_FragColor.rgb *= mix(1.0, 0.96, roof);
                }
                #include <dithering_fragment>`);
    };
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;

    // soft architectural edges (light grey, more crease lines)
    const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(merged, 20),
        new THREE.LineBasicMaterial({ color: 0xb4bac6, transparent: true, opacity: 0.45 }));
    const grp = new THREE.Group(); grp.add(mesh); grp.add(edges);
    return grp;
}

const _TREE_GREENS = [0x6f9e63, 0x5e8f57, 0x7faa66, 0x86a86a, 0x5a874f];
function _hash01(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }

/** Two InstancedMeshes (canopy + trunk) sharing per-instance transforms, with
 *  per-canopy colour, size jitter and random yaw so the foliage reads hand-drawn. */
function _buildTrees(obj) {
    const pts = (obj && obj.trees || []).filter(t => _inRange(t[0], t[1]));
    if (!pts.length) return null;
    const canopyGeo = new THREE.SphereGeometry(3.0, 9, 6); canopyGeo.scale(1, 0.85, 1); canopyGeo.translate(0, 4.4, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.45, 4.4, 6); trunkGeo.translate(0, 2.2, 0);
    const canopyMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.95, metalness: 0 });
    const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, pts.length);
    const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, pts.length);
    canopy.castShadow = canopy.receiveShadow = true; trunk.castShadow = true;

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < pts.length; i++) {
        const base = (pts[i][2] || 1) * 1.1;
        const s = base * (0.82 + 0.42 * _hash01(i + 0.3));         // size jitter
        pos.set(px(pts[i][0]), 0, pz(pts[i][1]));
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), _hash01(i) * Math.PI * 2);  // random yaw
        scl.set(s, s * (0.9 + 0.25 * _hash01(i + 0.7)), s);       // slight height variation
        m.compose(pos, q, scl);
        canopy.setMatrixAt(i, m); trunk.setMatrixAt(i, m);
        canopy.setColorAt(i, col.setHex(_TREE_GREENS[i % _TREE_GREENS.length]));
    }
    canopy.instanceMatrix.needsUpdate = true; trunk.instanceMatrix.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    const grp = new THREE.Group(); grp.add(canopy); grp.add(trunk);
    return grp;
}

function _ribbons(gj, widthFn, color, y) {
    // build flat ribbon quads along each LineString
    const geoms = [];
    for (const f of (gj.features || [])) {
        const g = f.geometry; if (!g || g.type !== 'LineString') continue;
        const co = g.coordinates;
        const w = widthFn(f) / 2;
        for (let i = 0; i < co.length - 1; i++) {
            const x1 = px(co[i][0]), z1 = pz(co[i][1]), x2 = px(co[i + 1][0]), z2 = pz(co[i + 1][1]);
            if (!_inRange(co[i][0], co[i][1]) && !_inRange(co[i + 1][0], co[i + 1][1])) continue;
            const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz) || 1;
            const nx = -dz / len * w, nz = dx / len * w;
            const q = new THREE.BufferGeometry();
            q.setAttribute('position', new THREE.Float32BufferAttribute([
                x1 + nx, y, z1 + nz, x1 - nx, y, z1 - nz, x2 + nx, y, z2 + nz, x2 - nx, y, z2 - nz,
            ], 3));
            q.setIndex([0, 2, 1, 1, 2, 3]);
            geoms.push(q);
        }
    }
    if (!geoms.length) return null;
    const merged = mergeGeometries(geoms, false); geoms.forEach(g => g.dispose());
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 }));
    mesh.receiveShadow = true;
    return mesh;
}
function _buildWaterPolys(gj, y) {
    const geoms = [];
    for (const f of (gj.features || [])) {
        const g = f.geometry; if (!g) continue;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        for (const poly of polys) {
            const ring = poly[0]; if (!ring || ring.length < 4) continue;
            if (!_inRange(ring[0][0], ring[0][1])) continue;
            const shape = new THREE.Shape();
            for (let i = 0; i < ring.length; i++) {
                const x = px(ring[i][0]), z = pz(ring[i][1]);
                i === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z);
            }
            const geo = new THREE.ShapeGeometry(shape); geo.rotateX(Math.PI / 2); geo.translate(0, y, 0);
            geoms.push(geo);
        }
    }
    if (!geoms.length) return null;
    const merged = mergeGeometries(geoms, false); geoms.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0x9fb8c9, roughness: 0.6, metalness: 0 }));
    mesh.receiveShadow = true;
    // crisp bank outline
    const banks = new THREE.LineSegments(
        new THREE.EdgesGeometry(merged, 1),
        new THREE.LineBasicMaterial({ color: 0x84a0b4, transparent: true, opacity: 0.6 }));
    const grp = new THREE.Group(); grp.add(mesh); grp.add(banks);
    return grp;
}

/** Soft muted-green park fill polygons (osm green spaces). */
function _buildGreenSpaces(gj, y) {
    const geoms = [];
    for (const f of (gj.features || [])) {
        const g = f.geometry; if (!g) continue;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        for (const poly of polys) {
            const ring = poly[0]; if (!ring || ring.length < 4) continue;
            if (!_inRange(ring[0][0], ring[0][1])) continue;
            const shape = new THREE.Shape();
            for (let i = 0; i < ring.length; i++) {
                const x = px(ring[i][0]), z = pz(ring[i][1]);
                i === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z);
            }
            const geo = new THREE.ShapeGeometry(shape); geo.rotateX(Math.PI / 2); geo.translate(0, y, 0);
            geoms.push(geo);
        }
    }
    if (!geoms.length) return null;
    const merged = mergeGeometries(geoms, false); geoms.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xcfe0bf, roughness: 1, metalness: 0 }));
    mesh.receiveShadow = true;
    return mesh;
}

/** Road style by OSM class: delicate light-grey lines, pixel width + colour. */
function _roadStyle(f) {
    const k = ((f.properties && (f.properties.highway || f.properties.fclass)) || '') + '';
    if (/motorway|trunk|_link/.test(k)) return { w: 2.6, color: 0xb9bec9 };
    if (/primary/.test(k)) return { w: 2.2, color: 0xbfc4cf };
    if (/secondary/.test(k)) return { w: 1.8, color: 0xc6cad3 };
    if (/tertiary/.test(k)) return { w: 1.5, color: 0xccd0d8 };
    if (/residential|unclassified|living/.test(k)) return { w: 1.1, color: 0xd2d6dd };
    return { w: 0.8, color: 0xd8dbe2 };                 // service/track/footway/path
}

/** Roads as delicate fat-lines: one LineSegments2 per class (pixel-constant width).
 *  depthTest on (buildings occlude), depthWrite off + polygonOffset (no z-fight). */
function _buildRoadLines(gj, w, h) {
    const buckets = new Map();                          // colorKey -> {color, w, pts:[]}
    for (const f of (gj.features || [])) {
        const g = f.geometry; if (!g || g.type !== 'LineString') continue;
        if (f.properties && f.properties.bridge === 'yes') continue;   // bridges drawn separately
        const s = _roadStyle(f); const key = s.color;
        let b = buckets.get(key); if (!b) { b = { color: s.color, w: s.w, pts: [] }; buckets.set(key, b); }
        const co = g.coordinates;
        for (let i = 0; i < co.length - 1; i++) {
            if (!_inRange(co[i][0], co[i][1]) && !_inRange(co[i + 1][0], co[i + 1][1])) continue;
            b.pts.push(px(co[i][0]), 0.15, pz(co[i][1]), px(co[i + 1][0]), 0.15, pz(co[i + 1][1]));
        }
    }
    const grp = new THREE.Group();
    for (const b of buckets.values()) {
        if (!b.pts.length) continue;
        const geo = new LineSegmentsGeometry(); geo.setPositions(new Float32Array(b.pts));
        const mat = new LineMaterial({
            color: b.color, linewidth: b.w, worldUnits: false,
            resolution: new THREE.Vector2(w, h), transparent: true, opacity: 0.95,
            depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        });
        _lineMats.push(mat);
        const line = new LineSegments2(geo, mat); line.renderOrder = 1; line.computeLineDistances();
        grp.add(line);
    }
    return grp.children.length ? grp : null;
}

/** Bridge decks: white strips where roads are tagged bridge=yes (sit over water). */
function _buildBridges(gj, y) {
    const sub = { type: 'FeatureCollection', features: (gj.features || []).filter(f => f.properties && f.properties.bridge === 'yes') };
    if (!sub.features.length) return null;
    return _ribbons(sub, f => _roadStyle(f).w * 4.0, 0xf4f5f7, y);   // metre width ~ class
}

// ───────────────────────── scene lifecycle ─────────────────────────
function _setupRenderer(w, h) {
    _renderer = new THREE.WebGLRenderer({ antialias: true });
    _renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    _renderer.setSize(w, h);
    _renderer.shadowMap.enabled = true;
    _renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    _renderer.toneMapping = THREE.ACESFilmicToneMapping;
    _renderer.toneMappingExposure = 0.98;
    _renderer.outputColorSpace = THREE.SRGBColorSpace;
}
function _setupScene() {
    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0xf4f2ec);                 // warm near-white
    _scene.fog = new THREE.Fog(0xf4f2ec, RANGE * 1.2, RANGE * 2.6);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xe9e4da, 1.15);
    _scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e2, 1.7);
    sun.position.set(-900, 1500, 800);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const d = RANGE * 1.2;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 100, far: 6000 });
    sun.shadow.bias = -0.0002;
    _scene.add(sun);

    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(RANGE * 6, RANGE * 6),
        new THREE.MeshStandardMaterial({ color: 0xf3f0ea, roughness: 1, metalness: 0 }));   // near-white warm
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    _scene.add(ground);
}
function _setupCamera(w, h) {
    _camera = new THREE.PerspectiveCamera(45, w / h, 1, 12000);
    _camera.position.set(RANGE * 0.8, RANGE * 0.75, RANGE * 0.8);
    _controls = new OrbitControls(_camera, _renderer.domElement);
    _controls.target.set(0, 0, 0);
    _controls.enableDamping = true; _controls.dampingFactor = 0.08;
    _controls.maxPolarAngle = Math.PI / 2.15; _controls.minDistance = 200; _controls.maxDistance = RANGE * 3;
    _controls.update();
}
function _setupComposer(w, h) {
    _composer = new EffectComposer(_renderer);
    _composer.addPass(new RenderPass(_scene, _camera));
    const ssao = new SSAOPass(_scene, _camera, w, h);
    ssao.kernelRadius = 10; ssao.minDistance = 0.0008; ssao.maxDistance = 0.12;
    _composer.addPass(ssao);
    _composer.addPass(new OutputPass());
}

async function _build() {
    const w = innerWidth, h = innerHeight;
    const [b, t, riv, wat, road, green] = await Promise.all([
        _json(BASE + 'buildings_lite_guna.geojson'),
        _json(BASE + 'aino_trees_guna.json'),
        _json(BASE + 'osm_rivers_guna_continuous.geojson'),
        _json(BASE + 'osm_water_guna.geojson'),
        _json(BASE + 'osm_roads_guna.geojson'),
        _json(BASE + 'osm_green_spaces_guna.geojson'),
    ]);
    // y-stack: parks 0.10 → roads 0.15 → water 0.45 → rivers 0.55 → bridges 0.70
    if (green) { const m = _buildGreenSpaces(green, 0.10); if (m) _scene.add(m); }
    if (road) { const m = _buildRoadLines(road, w, h); if (m) _scene.add(m); }
    if (wat) { const m = _buildWaterPolys(wat, 0.45); if (m) _scene.add(m); }
    if (riv) { const m = _ribbons(riv, _riverW, 0x93b0c4, 0.55); if (m) _scene.add(m); }
    if (road) { const m = _buildBridges(road, 0.70); if (m) _scene.add(m); }
    if (b) { const m = _buildBuildings(b); if (m) _scene.add(m); }
    if (t) { const m = _buildTrees(t); if (m) _scene.add(m); }
    _built = true;
}
function _riverW(f) {
    const k = (f.properties && f.properties.waterway) || '';
    return k === 'river' ? 22 : k === 'canal' ? 18 : k === 'stream' ? 9 : 7;
}

function _loop() { _raf = requestAnimationFrame(_loop); _controls.update(); _composer.render(); }
function _onResize() {
    if (!_active) return;
    const w = innerWidth, h = innerHeight;
    _camera.aspect = w / h; _camera.updateProjectionMatrix();
    _renderer.setSize(w, h); _composer.setSize(w, h);
    _lineMats.forEach(m => m.resolution.set(w, h));   // fat lines need canvas size
}

function _chrome() {
    const close = document.createElement('button');
    close.textContent = '✕ Close 3D';
    close.style.cssText = 'position:absolute;top:14px;right:16px;z-index:2;padding:8px 14px;border:none;'
        + 'border-radius:8px;background:rgba(20,24,40,0.82);color:#fff;font:600 13px system-ui;cursor:pointer;';
    close.onclick = close_;
    const label = document.createElement('div');
    label.textContent = 'Guna · Aino Studio (Three.js) — drag to orbit, scroll to zoom';
    label.style.cssText = 'position:absolute;bottom:14px;left:16px;z-index:2;padding:6px 12px;border-radius:8px;'
        + 'background:rgba(20,24,40,0.7);color:#e7ebf2;font:500 12px system-ui;';
    _container.appendChild(close); _container.appendChild(label);
}

async function open() {
    if (_active) return;
    _active = true;
    _container = document.createElement('div');
    _container.id = 'aino-scene';
    _container.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#f4f2ec;';
    const loading = document.createElement('div');
    loading.textContent = 'Building Guna 3D model…';
    loading.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
        + 'font:600 16px system-ui;color:#3a4252;z-index:3;';
    _container.appendChild(loading);
    document.body.appendChild(_container);

    const w = innerWidth, h = innerHeight;
    _setupRenderer(w, h);
    _container.appendChild(_renderer.domElement);
    _setupScene(); _setupCamera(w, h); _setupComposer(w, h);
    addEventListener('resize', _onResize);
    _chrome();
    await _build();
    loading.remove();
    _loop();
}
function close_() {
    if (!_active) return;
    _active = false;
    cancelAnimationFrame(_raf);
    removeEventListener('resize', _onResize);
    if (_renderer) { _renderer.dispose(); }
    if (_container) { _container.remove(); _container = null; }
    _lineMats = [];
    _scene = _camera = _controls = _composer = _renderer = null; _built = false;
}
function toggle() { _active ? close_() : open(); }
function isActive() { return _active; }

window.AinoScene = { open, close: close_, toggle, isActive };
