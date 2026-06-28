/**
 * StudioScene — high-fidelity "City Studio" 3D model of Guna, in Three.js.
 *
 * The deck.gl overlay (studio-twin.js) hit a hard ceiling: no real shadows (deck's
 * shadow pass collapses extrusion under MapboxOverlay), so it reads as a flat
 * white model. This is a STANDALONE Three.js scene — real directional shadow
 * maps + SSAO ambient occlusion + tone-mapped materials — to actually approach
 * a polished paper architectural-model look: soft shadows, refined white massing, rounded
 * trees, blue water with width, grey roads with width.
 *
 * Opens as a fullscreen overlay from the "3D Model" button; OrbitControls to
 * fly around. Reads the same committed assets the deck twin uses.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const BASE = 'data/vectors/';
const C = { lat: 24.6354, lng: 77.3126 };
const MLAT = 110540, MLNG = 111320 * Math.cos(C.lat * Math.PI / 180);
const ENV_I = 0.5;                         // per-material envMapIntensity (r160 lacks scene.environmentIntensity)
const HEIGHT_EXAG = 1.5;                   // vertical exaggeration — gives the low-rise massing presence
const RANGE = 5000;                       // metres from centre — covers most of the city + the
                                          // two nearest water bodies (~3.8/4.6 km). Guna's rivers
                                          // are 12 km+ out (rural), so no in-core river exists.

const px = lng => (lng - C.lng) * MLNG;   // east  → +X
const pz = lat => -(lat - C.lat) * MLAT;  // north → -Z (footprint shapes use +sy then rotateX)

let _container = null, _renderer = null, _scene = null, _camera = null;
let _controls = null, _composer = null, _raf = 0, _active = false, _built = false;
let _lineMats = [];                       // LineMaterials needing resolution updates on resize
let _onProgress = null;                    // (msg) => void — updates the loading overlay during build
let _tiltH = null, _tiltV = null, _bloom = null, _smaa = null;   // post passes needing resize updates

// ───────────────────────── data ─────────────────────────
async function _json(url) {
    const r = await fetch(url, { cache: 'force-cache' });
    return r.ok ? r.json() : null;
}
function _height(area) {
    let f = area < 50 ? 1 : area < 110 ? 2 : area < 220 ? 3 : area < 450 ? 4 : area < 900 ? 5 : 6;
    const j = Math.abs(Math.sin(area * 12.9898)) ;     // stable pseudo-jitter
    if (j > 0.86) f += 1; else if (j < 0.16 && f > 1) f -= 1;
    return f * 3.2 * HEIGHT_EXAG;        // presentation-model vertical exaggeration for presence
}
function _inRange(lng, lat) {
    const x = px(lng), z = pz(lat);
    return x * x + z * z < RANGE * RANGE;
}

// ───────────────────────── builders ─────────────────────────
async function _buildBuildings(gj) {
    const geoms = [];
    const feats = gj.features || [];
    for (let fi = 0; fi < feats.length; fi++) {
        const f = feats[fi];
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
        // subtle per-building tonal variation: near-white with a faint warm/cool shift
        const seed = geoms.length;
        const v = 0.95 + 0.04 * _hash01(seed * 2.3 + 9);            // tighter, brighter ivory 0.95–0.99
        const warm = _hash01(seed * 1.7 + 3) < 0.55;               // slight warm majority
        const col = warm
            ? new THREE.Color(v * 1.000, v * 0.992, v * 0.978)     // warm ivory
            : new THREE.Color(v * 0.990, v * 0.994, v * 1.000);    // cool porcelain (neutral, not blue)
        const n = geo.attributes.position.count, carr = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) { carr[k * 3] = col.r; carr[k * 3 + 1] = col.g; carr[k * 3 + 2] = col.b; }
        geo.setAttribute('color', new THREE.Float32BufferAttribute(carr, 3));
        geoms.push(geo);
        if (fi % 1800 === 0) {
            if (_onProgress) _onProgress(`Building model… ${Math.round(100 * fi / feats.length)}%`);
            await new Promise(r => setTimeout(r));   // yield so the UI stays responsive
        }
    }
    if (!geoms.length) return null;
    if (_onProgress) _onProgress('Assembling…');
    await new Promise(r => setTimeout(r));
    const merged = mergeGeometries(geoms, false);
    geoms.forEach(g => g.dispose());
    merged.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0.0, envMapIntensity: ENV_I });
    mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(transformed,1.0)).xyz;')
            .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n vWNrm = normalize(mat3(modelMatrix) * objectNormal);');
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
            .replace('#include <dithering_fragment>', `
                // vertical tonal grade — soft contact-darkening at the base + a faint
                // warm crown: gives each white mass weight & form (the premium-model cue).
                gl_FragColor.rgb *= mix(0.88, 1.0, smoothstep(0.0, 9.0, vWPos.y));
                gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * vec3(1.02, 1.01, 0.997), clamp(vWPos.y / 36.0, 0.0, 1.0));
                if (abs(vWNrm.y) < 0.5 && vWPos.y > 1.2) {       // walls: one window row per floor (skip ground floor)
                    float vf = fract(vWPos.y / 4.8);              // 4.8 m == one (exaggerated) floor → rows match floor count
                    // horizontal coord runs ALONG the wall (axis perpendicular to the facade normal)
                    float hf = fract((abs(vWNrm.x) > abs(vWNrm.z) ? vWPos.z : vWPos.x) / 6.0);   // wider bays → far fewer windows
                    // one tall window per floor, subdivided into sparse bays; soft margins = the frame/slab
                    float paneV = smoothstep(0.14, 0.22, vf) - smoothstep(0.82, 0.90, vf);
                    float paneH = smoothstep(0.18, 0.30, hf) - smoothstep(0.70, 0.82, hf);
                    float pane = clamp(paneV * paneH, 0.0, 1.0);
                    gl_FragColor.rgb *= mix(1.0, 0.70, pane);     // darker glass → windows read clearly
                } else if (vWNrm.y > 0.5 && vWPos.y > 0.4) {     // roofs: very faint panel grid
                    float rx = abs(fract(vWPos.x / 4.0) - 0.5);
                    float rz = abs(fract(vWPos.z / 4.0) - 0.5);
                    float roof = max(1.0 - smoothstep(0.47, 0.49, rx), 1.0 - smoothstep(0.47, 0.49, rz));
                    gl_FragColor.rgb *= mix(1.0, 0.975, roof);    // barely-there
                }
                #include <dithering_fragment>`);
    };
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;

    // delicate architectural creases (fewer, fainter, cooler → pencil line not wireframe)
    const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(merged, 24),
        new THREE.LineBasicMaterial({ color: 0xaab2c0, transparent: true, opacity: 0.35 }));
    const grp = new THREE.Group(); grp.add(mesh); grp.add(edges);
    return grp;
}

const _TREE_GREENS = [0x6f9e5c, 0x5e9150, 0x7fae63, 0x88a866, 0x4f7e46, 0x6aa57a];
function _hash01(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }

/** Two InstancedMeshes (canopy + trunk) sharing per-instance transforms, with
 *  per-canopy colour, size jitter and random yaw so the foliage reads hand-drawn. */
function _buildTrees(obj) {
    const pts = (obj && obj.trees || []).filter(t => _inRange(t[0], t[1]));
    if (!pts.length) return null;
    const canopyGeo = new THREE.IcosahedronGeometry(3.2, 1); canopyGeo.scale(1, 0.82, 1); canopyGeo.translate(0, 4.4, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.45, 4.4, 6); trunkGeo.translate(0, 2.2, 0);
    const canopyMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: ENV_I,
        emissive: 0x24401c, emissiveIntensity: 0.16 });   // instanceColor tints per-tree; faint leaf glow in shade
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.95, metalness: 0, envMapIntensity: ENV_I });
    const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, pts.length);
    const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, pts.length);
    canopy.castShadow = canopy.receiveShadow = true; trunk.castShadow = false;   // trunk shadow hidden under canopy

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < pts.length; i++) {
        const base = (pts[i][2] || 1) * 1.1;
        const r = _hash01(i + 0.3);
        const s = base * (0.7 + 0.85 * r * r);                     // r²-biased: many small, few large = natural stand
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
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    return mesh;
}
/** Unlit water material: deep-centre → bright sky-sheen at grazing angles (Fresnel)
 *  two-tone. Stays flat + depthWrite:false (no z-fight, no time-based shimmer). */
function _waterMat(color) {
    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const deep = new THREE.Color(color).multiplyScalar(0.82);
    const edge = new THREE.Color(color).lerp(new THREE.Color(0xeaf4fb), 0.42);
    mat.onBeforeCompile = (sh) => {
        sh.uniforms.uDeep = { value: deep }; sh.uniforms.uEdge = { value: edge };
        sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vVDw;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n vVDw = normalize(cameraPosition - (modelMatrix * vec4(transformed,1.0)).xyz);');
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uDeep; uniform vec3 uEdge; varying vec3 vVDw;')
            .replace('#include <dithering_fragment>', `
                float fres = pow(1.0 - clamp(vVDw.y, 0.0, 1.0), 3.0);   // grazing banks catch sky
                gl_FragColor.rgb = mix(uDeep, uEdge, clamp(fres * 1.4, 0.0, 1.0)) + fres * 0.08;
                #include <dithering_fragment>`);
    };
    return mat;
}
function _buildWaterPolys(gj, y, color = 0x9fb8c9, tier = null, bank = { color: 0x155fae, opacity: 0.75 }) {
    const geoms = [];
    for (const f of (gj.features || [])) {
        if (tier && f.properties && f.properties.tier !== tier) continue;
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
    // Unlit flat blue — avoids the lighting/SSAO striping that MeshStandard gave on
    // the many thin vectorised water triangles; reads as clean clear water.
    const mesh = new THREE.Mesh(merged, _waterMat(color));
    mesh.renderOrder = 5;                               // above the stream tiers (2-4), no z-fight
    const grp = new THREE.Group(); grp.add(mesh);
    if (bank) {                                          // crisp bank outline (skipped for tiny brooks)
        const banks = new THREE.LineSegments(
            new THREE.EdgesGeometry(merged, 1),
            new THREE.LineBasicMaterial({ color: bank.color, transparent: true, opacity: bank.opacity, depthWrite: false }));
        banks.renderOrder = 6;                            // above its own fill, no z-fight
        grp.add(banks);
    }
    return grp;
}

/** Hand-digitised channel centreline (survey-grade, traced on satellite imagery)
 *  → a smooth tapered ribbon. Per-vertex averaged normals give continuous mitred
 *  joints (no gaps at bends); the ends taper so the river doesn't stop abruptly.
 *  Flat unlit + depthWrite:false so it sits stable over the ground (no z-fight). */
function _buildTracedChannel(gj, y) {
    const W = { river: 26, stream: 14 }, COL = { river: 0x1773cf, stream: 0x2f8fdc };
    const byTier = {};
    for (const f of (gj.features || [])) {
        const t = (f.properties && f.properties.tier) || 'river';
        (byTier[t] = byTier[t] || []).push(f);
    }
    const grp = new THREE.Group();
    let ro = 4;
    for (const tier of Object.keys(byTier)) {
        const wBase = W[tier] || 18, geoms = [];
        for (const f of byTier[tier]) {
            const g = f.geometry; if (!g || g.type !== 'LineString') continue;
            const co = g.coordinates;
            const pp = co.map(c => [px(c[0]), pz(c[1])]);   // [X, Z]
            const n = pp.length; if (n < 2) continue;
            const L = [], R = [];
            for (let i = 0; i < n; i++) {
                const a = pp[Math.max(0, i - 1)], b = pp[Math.min(n - 1, i + 1)];
                let dx = b[0] - a[0], dz = b[1] - a[1];
                const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
                const nx = -dz, nz = dx;                     // left normal in XZ
                const t = i / (n - 1), edge = Math.min(t, 1 - t);
                const hw = wBase * (0.5 + 0.5 * Math.min(1, edge / 0.07)) / 2;  // taper tips
                L.push([pp[i][0] + nx * hw, pp[i][1] + nz * hw]);
                R.push([pp[i][0] - nx * hw, pp[i][1] - nz * hw]);
            }
            const pos = [];
            for (let i = 0; i < n - 1; i++) {
                const l0 = L[i], r0 = R[i], l1 = L[i + 1], r1 = R[i + 1];
                pos.push(l0[0], y, l0[1], r0[0], y, r0[1], l1[0], y, l1[1]);
                pos.push(r0[0], y, r0[1], r1[0], y, r1[1], l1[0], y, l1[1]);
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geoms.push(geo);
        }
        if (!geoms.length) continue;
        const merged = mergeGeometries(geoms, false); geoms.forEach(g => g.dispose());
        const mesh = new THREE.Mesh(merged, _waterMat(COL[tier] || 0x1773cf));
        mesh.renderOrder = ro++;
        grp.add(mesh);
    }
    return grp.children.length ? grp : null;
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
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xd2dec0, roughness: 1, metalness: 0, side: THREE.DoubleSide, envMapIntensity: ENV_I }));
    mesh.receiveShadow = true;
    return mesh;
}

/** Road style by OSM class: clean grey lines with a clear width hierarchy. */
function _roadStyle(f) {
    const k = ((f.properties && (f.properties.highway || f.properties.fclass)) || '') + '';
    if (/motorway|trunk|_link/.test(k)) return { w: 5.6, color: 0x737a87 };
    if (/primary/.test(k)) return { w: 4.4, color: 0x80828f };
    if (/secondary/.test(k)) return { w: 3.4, color: 0x8b909c };
    if (/tertiary/.test(k)) return { w: 2.6, color: 0x979ca8 };
    if (/residential|unclassified|living/.test(k)) return { w: 1.8, color: 0xa6abb6 };
    return { w: 1.2, color: 0xb2b7c1 };                 // service/track/footway — barely there
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
    const mkLine = (positions, color, lw, ro, ofs) => {
        const geo = new LineSegmentsGeometry(); geo.setPositions(positions);
        const mat = new LineMaterial({
            color, linewidth: lw, worldUnits: false,
            resolution: new THREE.Vector2(w, h), transparent: true, opacity: 0.96,
            depthWrite: false, polygonOffset: true, polygonOffsetFactor: ofs, polygonOffsetUnits: ofs,
        });
        _lineMats.push(mat);
        const line = new LineSegments2(geo, mat); line.renderOrder = ro; line.computeLineDistances();
        grp.add(line);
    };
    for (const b of buckets.values()) {
        if (!b.pts.length) continue;
        const positions = new Float32Array(b.pts);
        const casing = new THREE.Color(b.color).multiplyScalar(0.80).getHex();
        mkLine(positions, casing, b.w + 1.6, 1, -2);   // darker casing under
        mkLine(positions, b.color, b.w, 2, -3);        // lighter fill on top
    }
    return grp.children.length ? grp : null;
}

/** Bridge decks: white strips where roads are tagged bridge=yes (sit over water). */
function _buildBridges(gj, y) {
    const sub = { type: 'FeatureCollection', features: (gj.features || []).filter(f => f.properties && f.properties.bridge === 'yes') };
    if (!sub.features.length) return null;
    return _ribbons(sub, f => _roadStyle(f).w * 4.0, 0xf4f5f7, y);   // metre width ~ class
}

/** A small pin (thin pole + ball) for landmark markers. */
function _markerGeo() {
    const pole = new THREE.CylinderGeometry(1.1, 1.1, 22, 5); pole.translate(0, 11, 0);
    const ball = new THREE.SphereGeometry(5, 8, 6); ball.translate(0, 26, 0);
    return mergeGeometries([pole, ball], false);
}
function _buildMarkers(pts, color) {
    const inr = pts.filter(p => _inRange(p[0], p[1]));
    if (!inr.length) return null;
    const mesh = new THREE.InstancedMesh(_markerGeo(),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05, envMapIntensity: ENV_I,
            emissive: new THREE.Color(color).multiplyScalar(0.25), emissiveIntensity: 0.6 }), inr.length);   // glow as accents
    mesh.castShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < inr.length; i++) { m.makeTranslation(px(inr[i][0]), 0, pz(inr[i][1])); mesh.setMatrixAt(i, m); }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
}

/** Faint ward / admin boundary lines on the ground. */
function _buildBoundaries(gj, y) {
    const geoms = [];
    for (const f of (gj.features || [])) {
        const g = f.geometry; if (!g) continue;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        for (const poly of polys) {
            const ring = poly[0]; if (!ring || ring.length < 2) continue;
            if (!_inRange(ring[0][0], ring[0][1])) continue;
            const pos = [];
            for (let i = 0; i < ring.length - 1; i++) {
                pos.push(px(ring[i][0]), y, pz(ring[i][1]), px(ring[i + 1][0]), y, pz(ring[i + 1][1]));
            }
            const q = new THREE.BufferGeometry();
            q.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geoms.push(q);
        }
    }
    if (!geoms.length) return null;
    const merged = mergeGeometries(geoms, false); geoms.forEach(g => g.dispose());
    return new THREE.LineSegments(merged,
        new THREE.LineBasicMaterial({ color: 0xc6a8cf, transparent: true, opacity: 0.32 }));
}

// ───────────────────────── scene lifecycle ─────────────────────────
// ───────────────────────── atmosphere & ground (canvas textures) ─────────────────────────
/** Vertical gradient sky: cool zenith → warm horizon, complements the warm model. */
function _skyTexture() {
    const c = document.createElement('canvas'); c.width = 2; c.height = 512;
    const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, '#cdd9e8');     // cool zenith
    grad.addColorStop(0.55, '#e9e6df');    // neutral mid
    grad.addColorStop(1.0, '#f3ead9');     // warm horizon (== fog colour)
    g.fillStyle = grad; g.fillRect(0, 0, 2, 512);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
/** Model-base ground: bright lit pool under the city, darkening to a plinth rim,
 *  plus a near-invisible paper grain so the plane never bands. */
function _groundTexture() {
    const s = 1024, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    g.fillStyle = '#efece4'; g.fillRect(0, 0, s, s);
    const r = g.createRadialGradient(s / 2, s / 2, s * 0.10, s / 2, s / 2, s * 0.55);
    r.addColorStop(0.0, '#f7f4ed'); r.addColorStop(0.6, '#ece8df'); r.addColorStop(1.0, '#d7d1c4');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
    const img = g.getImageData(0, 0, s, s), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 6; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = _renderer.capabilities.getMaxAnisotropy();
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.center.set(0.5, 0.5); tex.repeat.set(2.4, 2.4);   // compress the lit pool to ~city size
    return tex;
}

function _setupRenderer(w, h) {
    _renderer = new THREE.WebGLRenderer({ antialias: true });
    _renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    _renderer.setSize(w, h);
    _renderer.shadowMap.enabled = true;
    _renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    _renderer.toneMapping = THREE.ACESFilmicToneMapping;
    _renderer.toneMappingExposure = 0.88;
    _renderer.outputColorSpace = THREE.SRGBColorSpace;
}
function _setupScene() {
    _scene = new THREE.Scene();
    _scene.background = _skyTexture();                             // cool-zenith → warm-horizon gradient
    _scene.fog = new THREE.Fog(0xf3ead9, RANGE * 1.5, RANGE * 4.0);   // matched to horizon → city dissolves into sky

    // Soft image-based ambient (RoomEnvironment) — the biggest win for a premium
    // white model. r160 has no scene.environmentIntensity, so strength is set
    // per-material via envMapIntensity (ENV_I on buildings/ground/trees).
    try {
        const pmrem = new THREE.PMREMGenerator(_renderer);
        const envScene = new RoomEnvironment();
        _scene.environment = pmrem.fromScene(envScene, 0.04).texture;
        if (envScene.dispose) envScene.dispose();
        pmrem.dispose();
    } catch (e) { /* IBL optional — hemi + sun still light the scene */ }

    const hemi = new THREE.HemisphereLight(0xfdf3e3, 0xd8cfc0, 0.32);   // faint warm bias; IBL is the real fill
    _scene.add(hemi);

    // Warm raking key light (golden-hour) → soft long shadows that define massing.
    const sun = new THREE.DirectionalLight(0xffe0b0, 2.1);
    const el = 26 * Math.PI / 180, az = 38 * Math.PI / 180, R = 9000;
    sun.position.set(R * Math.cos(el) * Math.sin(az), R * Math.sin(el), R * Math.cos(el) * Math.cos(az));
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const d = RANGE * 1.05;                              // tighter frustum → crisper shadow texels
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1000, far: 16000 });
    sun.shadow.bias = -0.0001; sun.shadow.normalBias = 1.3;
    _scene.add(sun); _scene.add(sun.target);

    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(RANGE * 6, RANGE * 6),
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: _groundTexture(), roughness: 0.96, metalness: 0, envMapIntensity: ENV_I }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    _scene.add(ground);

    _renderer.shadowMap.autoUpdate = false;             // static scene — render shadows once after _build()
}
function _setupCamera(w, h) {
    _camera = new THREE.PerspectiveCamera(45, w / h, 1, 12000);
    _camera.position.set(1300, 760, 1300);              // closer 3/4 hero over the core — flattering first impression
    _controls = new OrbitControls(_camera, _renderer.domElement);
    _controls.target.set(250, 0, -250);                // the dense core + Guniya corridor
    _controls.enableDamping = true; _controls.dampingFactor = 0.08;
    _controls.maxPolarAngle = Math.PI / 2.15; _controls.minDistance = 200; _controls.maxDistance = RANGE * 3;
    _controls.update();
}
// Tilt-shift: separable gaussian whose blur ramps up outside a screen-Y band of
// sharpness — the signature "miniature scale-model" cue. Screen-space, so it is
// stable as the camera orbits. Two instances run H then V.
function _tiltShader() {
    return {
        uniforms: {
            tDiffuse: { value: null },
            uDir: { value: new THREE.Vector2(1 / innerWidth, 0) },
            uFocus: { value: 0.52 }, uWidth: { value: 0.16 },
            uFalloff: { value: 0.28 }, uMaxBlur: { value: 2.6 },
        },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `
            uniform sampler2D tDiffuse; uniform vec2 uDir;
            uniform float uFocus, uWidth, uFalloff, uMaxBlur; varying vec2 vUv;
            void main(){
                float d = abs(vUv.y - uFocus);
                float amt = clamp((d - uWidth) / uFalloff, 0.0, 1.0) * uMaxBlur;
                vec2 o = uDir * amt;
                vec4 s = texture2D(tDiffuse, vUv) * 0.227027;
                s += texture2D(tDiffuse, vUv + o*1.0) * 0.194595;
                s += texture2D(tDiffuse, vUv - o*1.0) * 0.194595;
                s += texture2D(tDiffuse, vUv + o*2.0) * 0.121622;
                s += texture2D(tDiffuse, vUv - o*2.0) * 0.121622;
                s += texture2D(tDiffuse, vUv + o*3.0) * 0.054054;
                s += texture2D(tDiffuse, vUv - o*3.0) * 0.054054;
                s += texture2D(tDiffuse, vUv + o*4.0) * 0.016216;
                s += texture2D(tDiffuse, vUv - o*4.0) * 0.016216;
                gl_FragColor = s;
            }`,
    };
}
// Warm split-tone grade + gentle vignette — a whisper of cinematic finish.
function _gradeShader() {
    return {
        uniforms: {
            tDiffuse: { value: null }, uWarm: { value: 1.0 }, uSat: { value: 0.97 },
            uContrast: { value: 1.05 }, uVigOffset: { value: 0.30 }, uVigDark: { value: 0.30 },
        },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `
            uniform sampler2D tDiffuse; uniform float uWarm, uSat, uContrast, uVigOffset, uVigDark;
            varying vec2 vUv;
            void main(){
                vec4 c = texture2D(tDiffuse, vUv); vec3 col = c.rgb;
                float l = dot(col, vec3(0.299, 0.587, 0.114));
                col += l * vec3(0.020, 0.008, -0.014) * uWarm;        // warm highlights
                col += (1.0 - l) * vec3(-0.006, 0.0, 0.012) * uWarm;  // cool shadows
                col = mix(vec3(l), col, uSat);                        // saturation
                col = (col - 0.5) * uContrast + 0.5;                  // contrast
                float vig = 1.0 - uVigDark * smoothstep(uVigOffset, 0.72, length(vUv - 0.5));
                col *= vig;
                gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
            }`,
    };
}
function _setupComposer(w, h) {
    _composer = new EffectComposer(_renderer);     // r160 default RT is HalfFloat → no banding on the gradient sky
    _composer.addPass(new RenderPass(_scene, _camera));

    const ssao = new SSAOPass(_scene, _camera, w, h);
    ssao.kernelRadius = 12; ssao.minDistance = 0.0008; ssao.maxDistance = 0.09;   // seat buildings, no sky halos
    _composer.addPass(ssao);

    _tiltH = new ShaderPass(_tiltShader()); _tiltV = new ShaderPass(_tiltShader());
    _tiltH.uniforms.uDir.value.set(1 / w, 0); _tiltV.uniforms.uDir.value.set(0, 1 / h);
    _composer.addPass(_tiltH); _composer.addPass(_tiltV);

    _bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.16, 0.5, 0.92);   // subtle; high threshold protects white roofs
    _composer.addPass(_bloom);

    _composer.addPass(new ShaderPass(_gradeShader()));

    _smaa = new SMAAPass(w, h);
    _composer.addPass(_smaa);

    _composer.addPass(new OutputPass());           // owns tone-mapping + sRGB; must stay last
}

async function _build() {
    const w = innerWidth, h = innerHeight;
    const [b, t, riv, wat, road, green, s2, chan, rail, poi, sens, adm] = await Promise.all([
        _json(BASE + 'buildings_lite_guna.geojson'),
        _json(BASE + 'studio_trees_guna.json'),
        _json(BASE + 'osm_rivers_guna_continuous.geojson'),
        _json(BASE + 'osm_water_guna.geojson'),
        _json(BASE + 'osm_roads_guna.geojson'),
        _json(BASE + 'osm_green_spaces_guna.geojson'),
        _json(BASE + 'channels_s2_guna.geojson'),   // Sentinel-2 (10 m) standing water → tanks
        _json(BASE + 'channels_traced_guna.geojson'), // survey-grade Guniya traced on satellite imagery
        _json(BASE + 'osm_railways_guna.geojson'),
        _json(BASE + 'osm_pois_guna.geojson'),
        _json(BASE + 'sensitive_infrastructure_guna.geojson'),
        _json(BASE + 'osm_admin_boundaries_guna.geojson'),
    ]);
    const pts = (gj, pred) => (gj && gj.features || [])
        .filter(f => f.geometry && f.geometry.type === 'Point' && (!pred || pred(f.properties || {})))
        .map(f => f.geometry.coordinates);
    // y-stack: boundaries 0.08 → parks 0.10 → roads 0.15 → streams 0.34-0.40 → JRC water 0.42-0.46 → rivers 0.55 → bridges 0.70
    if (adm) { const m = _buildBoundaries(adm, 0.08); if (m) _scene.add(m); }
    if (green) { const m = _buildGreenSpaces(green, 0.10); if (m) _scene.add(m); }
    if (road) { const m = _buildRoadLines(road, w, h); if (m) _scene.add(m); }
    // Survey-grade water: Guniya traced on satellite imagery + Sentinel-2 tanks.
    if (s2) { const pw = _buildWaterPolys(s2, 0.46, 0x1773cf, 'permanent'); if (pw) _scene.add(pw); }  // real tanks/perennial pools
    if (chan) { const m = _buildTracedChannel(chan, 0.44); if (m) _scene.add(m); }                     // the Guniya, on its real course
    if (wat) { const m = _buildWaterPolys(wat, 0.45, 0x1d7fd6); if (m) _scene.add(m); }
    if (riv) { const m = _ribbons(riv, _riverW, 0x1d7fd6, 0.55); if (m) _scene.add(m); }
    if (road) { const m = _buildBridges(road, 0.70); if (m) _scene.add(m); }
    if (b) { const m = await _buildBuildings(b); if (m) _scene.add(m); }
    if (t) { const m = _buildTrees(t); if (m) _scene.add(m); }
    // landmark markers: hospitals + stations (committed-but-previously-unused data)
    const hosp = [...pts(poi, p => /hospital|clinic/.test(p.amenity || '')), ...pts(sens, p => p.category === 'hospital')];
    const stn = [...pts(rail), ...pts(sens, p => p.category === 'transport')];
    if (hosp.length) { const m = _buildMarkers(hosp, 0xd98a8a); if (m) _scene.add(m); }   // soft red
    if (stn.length) { const m = _buildMarkers(stn, 0x8a93d9); if (m) _scene.add(m); }     // soft indigo
    _built = true;
    if (_renderer) _renderer.shadowMap.needsUpdate = true;   // render shadows once now everything is in (autoUpdate off)
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
    _renderer.setSize(w, h); _composer.setSize(w, h);   // propagates setSize to bloom/SMAA/SSAO passes
    _lineMats.forEach(m => m.resolution.set(w, h));   // fat lines need canvas size
    if (_tiltH) _tiltH.uniforms.uDir.value.set(1 / w, 0);   // keep tilt-shift blur axis pixel-correct
    if (_tiltV) _tiltV.uniforms.uDir.value.set(0, 1 / h);
}

function _chrome() {
    const close = document.createElement('button');
    close.textContent = '✕ Close 3D';
    close.style.cssText = 'position:absolute;top:14px;right:16px;z-index:2;padding:8px 14px;border:none;'
        + 'border-radius:8px;background:rgba(20,24,40,0.82);color:#fff;font:600 13px system-ui;cursor:pointer;';
    close.onclick = close_;
    const label = document.createElement('div');
    label.textContent = 'Guna · City Studio (Three.js) — drag to orbit, scroll to zoom';
    label.style.cssText = 'position:absolute;bottom:14px;left:16px;z-index:2;padding:6px 12px;border-radius:8px;'
        + 'background:rgba(20,24,40,0.7);color:#e7ebf2;font:500 12px system-ui;';
    _container.appendChild(close); _container.appendChild(label);
}

async function open() {
    if (_active) return;
    _active = true;
    _container = document.createElement('div');
    _container.id = 'studio-scene';
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
    _onProgress = (msg) => { loading.textContent = msg; };
    await _build();
    _onProgress = null;
    loading.remove();
    _loop();
    window.__studio = { scene: _scene, camera: _camera, controls: _controls, THREE };  // debug/framing handle
}
function close_() {
    if (!_active) return;
    _active = false;
    cancelAnimationFrame(_raf);
    removeEventListener('resize', _onResize);
    if (_renderer) { _renderer.dispose(); }
    if (_container) { _container.remove(); _container = null; }
    _lineMats = [];
    _tiltH = _tiltV = _bloom = _smaa = null;
    _scene = _camera = _controls = _composer = _renderer = null; _built = false;
}
function toggle() { _active ? close_() : open(); }
function isActive() { return _active; }

window.StudioScene = { open, close: close_, toggle, isActive };
