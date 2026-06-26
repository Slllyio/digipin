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

const BASE = 'data/vectors/';
const C = { lat: 24.6354, lng: 77.3126 };
const MLAT = 110540, MLNG = 111320 * Math.cos(C.lat * Math.PI / 180);
const RANGE = 3200;                       // metres from centre to include (perf + focus)

const px = lng => (lng - C.lng) * MLNG;   // east  → +X
const pz = lat => -(lat - C.lat) * MLAT;  // north → -Z (footprint shapes use +sy then rotateX)

let _container = null, _renderer = null, _scene = null, _camera = null;
let _controls = null, _composer = null, _raf = 0, _active = false, _built = false;

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

    const mat = new THREE.MeshStandardMaterial({ color: 0xf3f4f7, roughness: 0.92, metalness: 0.0 });
    mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(transformed,1.0)).xyz;')
            .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n vWNrm = normalize(mat3(modelMatrix) * objectNormal);');
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
            .replace('#include <dithering_fragment>', `
                if (abs(vWNrm.y) < 0.5 && vWPos.y > 0.4) {       // walls only
                    float fy = abs(fract(vWPos.y / 3.2) - 0.5);
                    float floors = 1.0 - smoothstep(0.40, 0.49, fy);
                    float hx = abs(fract((vWPos.x + vWPos.z) / 3.4) - 0.5);
                    float mull = 1.0 - smoothstep(0.40, 0.49, hx);
                    float grid = clamp(max(floors, mull * 0.6), 0.0, 1.0);
                    gl_FragColor.rgb *= mix(1.0, 0.86, grid);
                }
                #include <dithering_fragment>`);
    };
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;

    // soft architectural edges
    const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(merged, 25),
        new THREE.LineBasicMaterial({ color: 0x9aa2b2, transparent: true, opacity: 0.5 }));
    const grp = new THREE.Group(); grp.add(mesh); grp.add(edges);
    return grp;
}

function _treeGeometry() {
    // canopy sphere (green) + trunk (brown), via vertex colours
    const canopy = new THREE.SphereGeometry(3.0, 9, 6); canopy.scale(1, 0.85, 1); canopy.translate(0, 4.4, 0);
    const trunk = new THREE.CylinderGeometry(0.35, 0.45, 4.4, 6); trunk.translate(0, 2.2, 0);
    const setColor = (g, c) => {
        const col = new THREE.Color(c); const arr = [];
        for (let i = 0; i < g.attributes.position.count; i++) arr.push(col.r, col.g, col.b);
        g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
    };
    setColor(canopy, 0x5e8f57); setColor(trunk, 0x7a5a3a);
    return mergeGeometries([canopy, trunk], false);
}
function _buildTrees(obj) {
    const pts = (obj && obj.trees || []).filter(t => _inRange(t[0], t[1]));
    if (!pts.length) return null;
    const geo = _treeGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < pts.length; i++) {
        const s = (pts[i][2] || 1) * 1.1;
        m.makeScale(s, s, s); m.setPosition(px(pts[i][0]), 0, pz(pts[i][1]));
        mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
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
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0x6fb0d6, roughness: 0.4, metalness: 0 }));
    mesh.receiveShadow = true;
    return mesh;
}

// ───────────────────────── scene lifecycle ─────────────────────────
function _setupRenderer(w, h) {
    _renderer = new THREE.WebGLRenderer({ antialias: true });
    _renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    _renderer.setSize(w, h);
    _renderer.shadowMap.enabled = true;
    _renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    _renderer.toneMapping = THREE.ACESFilmicToneMapping;
    _renderer.toneMappingExposure = 1.05;
    _renderer.outputColorSpace = THREE.SRGBColorSpace;
}
function _setupScene() {
    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0xeef1f5);
    _scene.fog = new THREE.Fog(0xeef1f5, RANGE * 1.1, RANGE * 2.4);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xd6dae2, 1.0);
    _scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff6e8, 2.2);
    sun.position.set(-900, 1500, 800);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const d = RANGE * 1.2;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 100, far: 6000 });
    sun.shadow.bias = -0.0002;
    _scene.add(sun);

    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(RANGE * 6, RANGE * 6),
        new THREE.MeshStandardMaterial({ color: 0xdfe3e9, roughness: 1, metalness: 0 }));
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
    ssao.kernelRadius = 14; ssao.minDistance = 0.0008; ssao.maxDistance = 0.12;
    _composer.addPass(ssao);
    _composer.addPass(new OutputPass());
}

async function _build() {
    const [b, t, riv, wat, road] = await Promise.all([
        _json(BASE + 'buildings_lite_guna.geojson'),
        _json(BASE + 'aino_trees_guna.json'),
        _json(BASE + 'osm_rivers_guna_continuous.geojson'),
        _json(BASE + 'osm_water_guna.geojson'),
        _json(BASE + 'osm_roads_guna.geojson'),
    ]);
    if (road) { const m = _ribbons(road, _roadW, 0xc9ccd4, 0.4); if (m) _scene.add(m); }
    if (wat) { const m = _buildWaterPolys(wat, 0.5); if (m) _scene.add(m); }
    if (riv) { const m = _ribbons(riv, _riverW, 0x5a96c8, 0.6); if (m) _scene.add(m); }
    if (b) { const m = _buildBuildings(b); if (m) _scene.add(m); }
    if (t) { const m = _buildTrees(t); if (m) _scene.add(m); }
    _built = true;
}
function _roadW(f) {
    const k = ((f.properties && (f.properties.highway || f.properties.fclass)) || '') + '';
    if (/motorway|trunk/.test(k)) return 16; if (/primary/.test(k)) return 13;
    if (/secondary/.test(k)) return 10; if (/tertiary/.test(k)) return 7.5;
    if (/residential|unclassified|living/.test(k)) return 5; return 3.2;
}
function _riverW(f) {
    const k = (f.properties && f.properties.waterway) || '';
    return k === 'river' ? 24 : k === 'canal' ? 18 : k === 'stream' ? 10 : 7;
}

function _loop() { _raf = requestAnimationFrame(_loop); _controls.update(); _composer.render(); }
function _onResize() {
    if (!_active) return;
    const w = innerWidth, h = innerHeight;
    _camera.aspect = w / h; _camera.updateProjectionMatrix();
    _renderer.setSize(w, h); _composer.setSize(w, h);
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
    _container.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#eef1f5;';
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
    _scene = _camera = _controls = _composer = _renderer = null; _built = false;
}
function toggle() { _active ? close_() : open(); }
function isActive() { return _active; }

window.AinoScene = { open, close: close_, toggle, isActive };
