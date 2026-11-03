/**
 * GltfExport — the 3D building massing as a binary glTF (.glb) for Blender,
 * Rhino, Unity, Sketchfab, web viewers and AR. Extruded footprints (walls +
 * roofs) in local metres around the origin cell: +X east, +Y up, -Z north
 * (glTF's right-handed y-up convention). The origin's lat/lng and the
 * source are written into the asset extras so the model can be placed back
 * on a map.
 *
 * No dependencies: the GLB container, ear-clipping triangulation and the
 * flat-shaded mesh are written here. Buildings with holes lose the holes
 * (only the outer ring is extruded), the same simplification the 3D layer
 * and the CAD export make.
 *
 * triangulate()/buildMesh()/buildGLB() are pure (unit-tested); download()
 * collects the visible footprints from the live map.
 */
const GltfExport = (() => {
    const RAD = Math.PI / 180;
    const M_PER_DEG_LAT = 111320;
    const MAX_BUILDINGS = 20000;

    function _signedArea(pts) {
        let a = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        }
        return a / 2;
    }

    function _cross(a, b, c) {
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }

    function _inTri(p, a, b, c) {
        return _cross(a, b, p) >= 0 && _cross(b, c, p) >= 0 && _cross(c, a, p) >= 0;
    }

    /**
     * Ear-clipping triangulation of a simple polygon given as [[x,y]…] (open
     * or closed ring). Returns triangles as index triples into the open ring,
     * wound counter-clockwise; [] for a degenerate polygon.
     */
    function triangulate(ring) {
        let pts = ring.slice();
        const f = pts[0], l = pts[pts.length - 1];
        if (pts.length > 1 && f[0] === l[0] && f[1] === l[1]) pts = pts.slice(0, -1);
        if (pts.length < 3 || Math.abs(_signedArea(pts)) < 1e-9) return [];
        const idx = pts.map((_, i) => i);
        if (_signedArea(pts) < 0) idx.reverse();           // work counter-clockwise
        const tris = [];
        let guard = idx.length * idx.length;
        while (idx.length > 3 && guard-- > 0) {
            let clipped = false;
            for (let k = 0; k < idx.length; k++) {
                const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
                const a = pts[i0], b = pts[i1], c = pts[i2];
                if (_cross(a, b, c) <= 1e-12) continue;            // reflex or flat corner
                let ear = true;
                for (const j of idx) {
                    if (j === i0 || j === i1 || j === i2) continue;
                    if (_inTri(pts[j], a, b, c)) { ear = false; break; }
                }
                if (!ear) continue;
                tris.push([i0, i1, i2]);
                idx.splice(k, 1);
                clipped = true;
                break;
            }
            if (!clipped) break;                                   // self-intersecting input
        }
        if (idx.length === 3 && _cross(pts[idx[0]], pts[idx[1]], pts[idx[2]]) > 1e-12) tris.push([idx[0], idx[1], idx[2]]);
        return tris;
    }

    /** lng/lat ring → local metres [east, north] from (lat0, lng0). */
    function _local(ring, lat0, lng0) {
        const kx = M_PER_DEG_LAT * Math.cos(lat0 * RAD);
        return ring.map(([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * M_PER_DEG_LAT]);
    }

    /**
     * Flat-shaded mesh for buildings = [{ polygon:[[lng,lat]…], height }].
     * Returns { positions:Float32Array, normals:Float32Array, indices:Uint32Array, count }.
     */
    function buildMesh(buildings, origin) {
        const pos = [], nor = [], idx = [];
        let count = 0;
        const quad = (p0, p1, p2, p3, n) => {
            const base = pos.length / 3;
            [p0, p1, p2, p3].forEach(p => { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); });
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        (buildings || []).slice(0, MAX_BUILDINGS).forEach(b => {
            if (!b || !b.polygon || b.polygon.length < 4 || !(b.height > 0)) return;
            const pts = _local(b.polygon, origin.lat, origin.lng);
            const open = pts.slice(0, -1);
            if (Math.abs(_signedArea(open)) < 1e-6) return;
            const ccw = _signedArea(open) > 0 ? open : open.slice().reverse();
            const h = b.height;
            // map plan (east, north) → glTF (x = east, y = up, z = −north)
            const P = (p, y) => [p[0], y, -p[1]];
            for (let i = 0; i < ccw.length; i++) {
                const a = ccw[i], c = ccw[(i + 1) % ccw.length];
                const dx = c[0] - a[0], dy = c[1] - a[1];
                const len = Math.hypot(dx, dy);
                if (len < 1e-6) continue;
                // outward normal of a CCW ring edge is (dy, −dx) in plan
                const n = [dy / len, 0, dx / len];            // plan (nx, ny) = (dy, −dx)/len → glTF (x, −ny) = (dy/len, dx/len)
                quad(P(a, 0), P(c, 0), P(c, h), P(a, h), n);
            }
            const tris = triangulate(ccw);
            const baseRoof = pos.length / 3;
            ccw.forEach(p => { const q = P(p, h); pos.push(q[0], q[1], q[2]); nor.push(0, 1, 0); });
            // CCW in plan (east, north) stays CCW from above after z = −north, so (a, b, c) faces up
            tris.forEach(([a, b, c]) => idx.push(baseRoof + a, baseRoof + b, baseRoof + c));
            count++;
        });
        return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx), count };
    }

    function _pad4(n) { return (n + 3) & ~3; }

    /** Pack the mesh into a binary glTF 2.0 (GLB) ArrayBuffer. */
    function buildGLB(mesh, meta = {}) {
        const posBytes = mesh.positions.byteLength, norBytes = mesh.normals.byteLength, idxBytes = mesh.indices.byteLength;
        const total = posBytes + norBytes + idxBytes;
        let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < mesh.positions.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                const v = mesh.positions[i + k];
                if (v < min[k]) min[k] = v;
                if (v > max[k]) max[k] = v;
            }
        }
        if (!mesh.positions.length) { min = [0, 0, 0]; max = [0, 0, 0]; }
        const json = {
            asset: { version: '2.0', generator: 'DigiPin glTF export', extras: meta },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0, name: meta.name || 'DigiPin buildings' }],
            materials: [{ name: 'massing', pbrMetallicRoughness: { baseColorFactor: [0.82, 0.84, 0.88, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: false }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }] }],
            accessors: [
                { bufferView: 0, componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3', min, max },
                { bufferView: 1, componentType: 5126, count: mesh.normals.length / 3, type: 'VEC3' },
                { bufferView: 2, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
            ],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
                { buffer: 0, byteOffset: posBytes, byteLength: norBytes, target: 34962 },
                { buffer: 0, byteOffset: posBytes + norBytes, byteLength: idxBytes, target: 34963 },
            ],
            buffers: [{ byteLength: total }],
        };
        const jsonText = JSON.stringify(json);
        const jsonBytes = new TextEncoder().encode(jsonText);
        const jsonLen = _pad4(jsonBytes.length);
        const binLen = _pad4(total);
        const out = new ArrayBuffer(12 + 8 + jsonLen + 8 + binLen);
        const dv = new DataView(out);
        const u8 = new Uint8Array(out);
        dv.setUint32(0, 0x46546C67, true);                  // 'glTF'
        dv.setUint32(4, 2, true);
        dv.setUint32(8, out.byteLength, true);
        dv.setUint32(12, jsonLen, true);
        dv.setUint32(16, 0x4E4F534A, true);                 // 'JSON'
        u8.set(jsonBytes, 20);
        u8.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen); // pad JSON with spaces
        const binHead = 20 + jsonLen;
        dv.setUint32(binHead, binLen, true);
        dv.setUint32(binHead + 4, 0x004E4942, true);        // 'BIN\0'
        let o = binHead + 8;
        u8.set(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, posBytes), o); o += posBytes;
        u8.set(new Uint8Array(mesh.normals.buffer, mesh.normals.byteOffset, norBytes), o); o += norBytes;
        u8.set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, idxBytes), o);
        return out;
    }

    function filename(code) {
        return `digipin_buildings_${String(code || 'cell').replace(/-/g, '')}.glb`;
    }

    /** Collect the visible footprints around `cell`, build and download the .glb. */
    function download(cell) {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        const feats = (typeof FootprintExport !== 'undefined') ? FootprintExport.collect(map) : [];
        const buildings = feats
            .filter(f => f.geometry && f.geometry.type === 'Polygon' && f.height > 0)
            .map(f => ({ polygon: f.geometry.coordinates[0], height: f.height }));
        if (!buildings.length) return 0;
        const b = cell && cell.bounds;
        const origin = b ? { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 }
            : { lat: buildings[0].polygon[0][1], lng: buildings[0].polygon[0][0] };
        const mesh = buildMesh(buildings, origin);
        const glb = buildGLB(mesh, { name: 'DigiPin buildings', code: cell && cell.code || null, originLat: origin.lat, originLng: origin.lng, source: 'Overture Maps buildings, DigiPin' });
        const blob = new Blob([glb], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename(cell && cell.code);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return mesh.count;
    }

    return { triangulate, buildMesh, buildGLB, filename, download };
})();

if (typeof window !== 'undefined') {
    window.GltfExport = GltfExport;
}
