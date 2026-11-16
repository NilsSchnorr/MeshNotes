// tests/face-order.test.js - Surface face numbers in file order (item 7 of the 1.6.6 plan)
// MeshNotes builds its BVH indirect (BVH_OPTIONS), so face numbers follow the
// model file's triangle order. Files from before 1.6.6 hold numbers in the
// order of the old in-place build; face-order.js reproduces that order from
// the indirect table (or a temporary build for geometry with groups) and
// decides region by region which order a file used. Loads Three.js and the
// vendored three-mesh-bvh through tests/support/app-env.js. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/app-env.js';

const THREE = await import('three');
const { computeBoundsTree, acceleratedRaycast } = await import('three-mesh-bvh');
const { state } = await import('../js/state.js');
const FO = await import('../js/annotation-tools/face-order.js');
const { buildAnnotationJSON } = await import('../js/export/export-json.js');
const { mergeW3CCollection, importStatusText } = await import('../js/export/import-json.js');
const { toStorageCoords } = await import('../js/utils/helpers.js');

const { BVH_OPTIONS, FACE_ORDER } = FO;

/** A bumpy indexed grid with 2 * n * n faces, so the BVH has something to sort. */
function makeGrid(n, size = 10) {
    const geometry = new THREE.PlaneGeometry(size, size, n, n);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, Math.sin(pos.getX(i) * 3.1) * Math.cos(pos.getY(i) * 2.3));
    }
    return geometry;
}

/** A copy that shares the positions and the groups but has its own index (or none). */
function legacyCopy(geometry) {
    const copy = new THREE.BufferGeometry();
    copy.setAttribute('position', geometry.attributes.position);
    if (geometry.index) copy.setIndex(new THREE.BufferAttribute(geometry.index.array.slice(), 1));
    for (const g of geometry.groups) copy.addGroup(g.start, g.count, g.materialIndex);
    return copy;
}

const triangle = (index, t) => [index[3 * t], index[3 * t + 1], index[3 * t + 2]];

/** Builds the 1.6.6 BVH on a mesh as model-loader.js does. */
function buildIndirect(mesh) {
    FO.noteBuildGroups(mesh.geometry);
    mesh.geometry.boundsTree = computeBoundsTree.call(mesh.geometry, BVH_OPTIONS);
}

/** A loaded "model": a group holding the meshes, set as the session's model. */
function loadModel(meshes, { flipped = false } = {}) {
    const model = new THREE.Group();
    for (const m of meshes) model.add(m);
    if (flipped) model.rotation.x = Math.PI;
    model.updateMatrixWorld(true);
    state.currentModel = model;
    state.modelMeshes = meshes;
    state.isFlipped = flipped;
    for (const m of meshes) buildIndirect(m);
    return model;
}

/** Centre of file triangle t in storage coordinates, as surface-paint.js computes a centroid. */
function fileCentre(mesh, t) {
    const g = mesh.geometry, pos = g.attributes.position;
    const v = new THREE.Vector3(), c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) {
        const i = g.index ? g.index.getX(3 * t + k) : 3 * t + k;
        c.add(v.fromBufferAttribute(pos, i));
    }
    return toStorageCoords(c.divideScalar(3).applyMatrix4(mesh.matrixWorld));
}

/** File triangles of mesh whose centres lie within r of a storage point. */
function patchAround(mesh, centre, r) {
    const n = (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;
    const out = [];
    for (let t = 0; t < n; t++) {
        const c = fileCentre(mesh, t);
        if ((c.x - centre.x) ** 2 + (c.y - centre.y) ** 2 + (c.z - centre.z) ** 2 <= r * r) out.push(t);
    }
    return out;
}

const mean = (pts) => {
    const s = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 });
    return { x: s.x / pts.length, y: s.y / pts.length, z: s.z / pts.length };
};

/** A region as MeshNotes before 1.6.6 stored it: legacy positions, centroid = mean of the triangle centres. */
function legacyRegion(mesh, meshIndex, fileTris) {
    const bvh = mesh.geometry.boundsTree;
    const n = fileTris.length && (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;
    const legacyOf = new Map();
    for (let j = 0; j < n; j++) legacyOf.set(bvh.resolveTriangleIndex(j), j);
    return {
        type: 'surface',
        faceData: fileTris.map(t => `${meshIndex}_${legacyOf.get(t)}`),
        points: [mean(fileTris.map(t => fileCentre(mesh, t)))]
    };
}

const sortedIds = (ids) => [...ids].sort();

// ---- The old order is reproduced -------------------------------------------

test('indexed geometry: the indirect table reproduces the old in-place order', () => {
    const geometry = makeGrid(40);
    const copy = legacyCopy(geometry);
    computeBoundsTree.call(copy);                                   // as MeshNotes before 1.6.6
    const bvh = computeBoundsTree.call(geometry, BVH_OPTIONS);      // as 1.6.6
    const before = Array.from(geometry.index.array);
    const n = geometry.index.count / 3;
    for (let j = 0; j < n; j++) {
        assert.deepEqual(triangle(copy.index.array, j), triangle(geometry.index.array, bvh.resolveTriangleIndex(j)), `position ${j}`);
    }
    assert.deepEqual(Array.from(geometry.index.array), before, 'the indirect build leaves the index buffer in file order');
});

test('geometry without an index: same order, and the indirect build adds no index', () => {
    const geometry = makeGrid(30).toNonIndexed();
    const copy = legacyCopy(geometry);
    computeBoundsTree.call(copy);                                   // generates an index and sorts it
    const bvh = computeBoundsTree.call(geometry, BVH_OPTIONS);
    assert.equal(geometry.index, null);
    const n = geometry.attributes.position.count / 3;
    for (let j = 0; j < n; j++) assert.equal(copy.index.array[3 * j] / 3, bvh.resolveTriangleIndex(j), `position ${j}`);
});

test('geometry with groups (multi-material OBJ): the temporary build reproduces the old per-group order', () => {
    const geometry = makeGrid(30).toNonIndexed();
    const vertices = geometry.attributes.position.count;
    geometry.addGroup(0, 900, 0);
    geometry.addGroup(900, vertices - 900, 1);
    const copy = legacyCopy(geometry);
    computeBoundsTree.call(copy);                                   // one root per group, as before 1.6.6
    const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
    buildIndirect(mesh);
    const legacy = FO.legacyResolver(mesh);
    const n = vertices / 3;
    for (let j = 0; j < n; j++) assert.equal(legacy(j), copy.index.array[3 * j] / 3, `position ${j}`);
    assert.equal(legacy(n), null, 'past the last triangle');
    assert.equal(geometry.index, null, 'the model geometry stays without an index');
});

test('golden order: the vendored library still sorts as three-mesh-bvh 0.8.2 did', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/bvh-legacy-order.json', import.meta.url), 'utf8'));
    const geometry = new THREE.PlaneGeometry(4, 4, 8, 8);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.round(1000 * Math.sin(pos.getX(i) * 1.7) * Math.cos(pos.getY(i) * 1.3)) / 1000);
    const bvh = computeBoundsTree.call(geometry, BVH_OPTIONS);
    const order = fixture.order.map((_, j) => bvh.resolveTriangleIndex(j));
    assert.deepEqual(order, fixture.order, 'a library change altered the legacy order: older files would be renumbered wrongly');
});

test('raycasts and brush shapecasts report file triangles with the indirect build', () => {
    const geometry = makeGrid(30);
    const plain = new THREE.Mesh(geometry.clone(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const fast = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    fast.raycast = acceleratedRaycast;
    fast.geometry.boundsTree = computeBoundsTree.call(fast.geometry, BVH_OPTIONS);
    const raycaster = new THREE.Raycaster();
    for (let i = 0; i < 40; i++) {
        // Off the grid lines and quad diagonals, where two triangles tie.
        const x = -4.41 + i * 0.2137, y = -3.93 + ((i * 0.7919) % 8);
        raycaster.set(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
        const a = raycaster.intersectObject(plain)[0], b = raycaster.intersectObject(fast)[0];
        assert.equal(b.faceIndex, a.faceIndex, `ray ${i}`);
    }
    // A brush shapecast names the same triangles as a brute-force test.
    const centre = new THREE.Vector3(1, -2, 0), r2 = 1.5 ** 2;
    const viaBvh = new Set();
    fast.geometry.boundsTree.shapecast({
        intersectsBounds: (box) => box.distanceToPoint(centre) ** 2 <= r2,
        intersectsTriangle: (tri, t) => {
            const c = new THREE.Vector3().add(tri.a).add(tri.b).add(tri.c).divideScalar(3);
            if (c.distanceToSquared(centre) <= r2) viaBvh.add(t);
            return false;
        }
    });
    const brute = new Set(patchAround(plain, centre, 1.5));
    assert.deepEqual([...viaBvh].sort((p, q) => p - q), [...brute].sort((p, q) => p - q));
});

// ---- Deciding the order of a region -----------------------------------------

test('chooseFaceOrder: same triangles, one impossible reading, a clear winner, no winner', () => {
    const at = { 0: { x: 0, y: 0, z: 0 }, 1: { x: 0.1, y: 0, z: 0 }, 2: { x: 9, y: 0, z: 0 }, 3: { x: 9.1, y: 0, z: 0 } };
    const centre = (m, t) => at[t] || null;
    const faces = (...ts) => ts.map(t => ({ mesh: 0, tri: t }));
    // Legacy reading names the same set: file.
    assert.equal(FO.chooseFaceOrder(faces(0, 1), at[0], { centre, legacy: (m, t) => (t === 0 ? 1 : 0) }), 'file');
    // Legacy positions 0, 1 are file triangles 2, 3, far from the centroid: file.
    assert.equal(FO.chooseFaceOrder(faces(0, 1), at[0], { centre, legacy: (m, t) => t + 2 }), 'file');
    // Stored numbers 2, 3 read as legacy are triangles 0, 1 at the centroid: legacy.
    assert.equal(FO.chooseFaceOrder(faces(2, 3), at[0], { centre, legacy: (m, t) => t - 2 }), 'legacy');
    // The legacy reading runs past the mesh: file.
    assert.equal(FO.chooseFaceOrder(faces(0, 1), at[0], { centre, legacy: () => null }), 'file');
    // Halfway between: undecided.
    assert.equal(FO.chooseFaceOrder(faces(0), { x: 4.5, y: 0, z: 0 }, { centre, legacy: () => 2 }), null);
    // Nothing to decide on.
    assert.equal(FO.chooseFaceOrder([], at[0], { centre, legacy: () => 0 }), null);
    assert.equal(FO.chooseFaceOrder(faces(0), null, { centre, legacy: () => 0 }), null);
});

test('normalizeSurfaceFaces renumbers an old region and keeps one in file order', () => {
    const mesh = new THREE.Mesh(makeGrid(40), new THREE.MeshBasicMaterial());
    loadModel([mesh]);
    const fileTris = patchAround(mesh, { x: 2, y: 1, z: 0 }, 1.2);
    assert.ok(fileTris.length > 20);

    const old = legacyRegion(mesh, 0, fileTris);
    assert.equal(FO.normalizeSurfaceFaces(old), FACE_ORDER.CONVERTED);
    assert.deepEqual(sortedIds(old.faceData), sortedIds(fileTris.map(t => `0_${t}`)));
    assert.equal(old.faceOrderUnchecked, undefined);

    const current = { type: 'surface', faceData: fileTris.map(t => `0_${t}`), points: [mean(fileTris.map(t => fileCentre(mesh, t)))] };
    const ids = [...current.faceData];
    assert.equal(FO.normalizeSurfaceFaces(current), FACE_ORDER.FILE);
    assert.deepEqual(current.faceData, ids);

    // A centroid moved onto the surface (nearest triangle centre) still decides.
    const snapped = legacyRegion(mesh, 0, fileTris);
    snapped.points = [fileCentre(mesh, fileTris[Math.floor(fileTris.length / 2)])];
    assert.equal(FO.normalizeSurfaceFaces(snapped), FACE_ORDER.CONVERTED);
});

test('normalizeSurfaceFaces works on a flipped model and on a second mesh', () => {
    const a = new THREE.Mesh(makeGrid(20), new THREE.MeshBasicMaterial());
    const b = new THREE.Mesh(makeGrid(30), new THREE.MeshBasicMaterial());
    b.position.set(20, 0, 0);
    loadModel([a, b], { flipped: true });
    const fileTris = patchAround(b, fileCentre(b, 700), 1.0);
    const old = legacyRegion(b, 1, fileTris);
    assert.equal(FO.normalizeSurfaceFaces(old), FACE_ORDER.CONVERTED);
    assert.deepEqual(sortedIds(old.faceData), sortedIds(fileTris.map(t => `1_${t}`)));
});

test('a declared file is left alone; without a model, a BVH or a centroid the region is unchecked', () => {
    const mesh = new THREE.Mesh(makeGrid(30), new THREE.MeshBasicMaterial());
    loadModel([mesh]);
    const fileTris = patchAround(mesh, { x: -2, y: 2, z: 0 }, 1.0);

    const declared = legacyRegion(mesh, 0, fileTris);
    const ids = [...declared.faceData];
    assert.equal(FO.normalizeSurfaceFaces(declared, { declared: true }), FACE_ORDER.FILE);
    assert.deepEqual(declared.faceData, ids);

    const noModel = legacyRegion(mesh, 0, fileTris);
    assert.equal(FO.normalizeSurfaceFaces(noModel, { meshes: [] }), FACE_ORDER.UNCHECKED);
    assert.equal(noModel.faceOrderUnchecked, true);

    const noBvh = legacyRegion(mesh, 0, fileTris);
    const other = new THREE.Mesh(makeGrid(30), new THREE.MeshBasicMaterial());   // no BVH built
    assert.equal(FO.normalizeSurfaceFaces(noBvh, { meshes: [other] }), FACE_ORDER.UNCHECKED);

    const noCentroid = { ...legacyRegion(mesh, 0, fileTris), points: [] };
    assert.equal(FO.normalizeSurfaceFaces(noCentroid), FACE_ORDER.UNCHECKED);

    const wrongMesh = legacyRegion(mesh, 0, fileTris);
    wrongMesh.faceData = wrongMesh.faceData.map(id => id.replace(/^0_/, '5_'));
    assert.equal(FO.normalizeSurfaceFaces(wrongMesh), FACE_ORDER.UNCHECKED);

    // A later successful check clears the mark.
    assert.equal(FO.normalizeSurfaceFaces(noModel), FACE_ORDER.CONVERTED);
    assert.equal(noModel.faceOrderUnchecked, undefined);
});

// ---- Import and export -------------------------------------------------------

function setSession(annotations = []) {
    state.modelFileName = 'grid.glb';
    state.modelHash = 'hash';
    state.modelFrameOrigin = null;
    state.modelInfo = { entries: [], metadata: null };
    state.groups = [{ id: 1, uuid: 'g1', name: 'Default', color: '#4CAF50', visible: true, opacity: 1 }];
    state.annotations = annotations;
    state.alignments = [];
    state.defaultAlignmentId = null;
}

const surfaceAnn = (uuid, region) => ({
    id: Math.floor(Math.random() * 1e9), uuid, type: 'surface', name: uuid, groupId: 1,
    points: region.points, faceData: region.faceData,
    entries: [{ id: 1, uuid: `${uuid}-e`, description: '', author: 'A', timestamp: '2026-11-01T10:00:00.000Z' }]
});

test('export writes meshnotes:faceOrder only when every surface region is in file order', () => {
    const mesh = new THREE.Mesh(makeGrid(20), new THREE.MeshBasicMaterial());
    loadModel([mesh]);
    setSession([]);
    assert.equal(JSON.parse(buildAnnotationJSON()).modelSource['meshnotes:faceOrder'], undefined, 'no surface region');

    const region = { faceData: ['0_1', '0_2'], points: [fileCentre(mesh, 1)] };
    setSession([surfaceAnn('s1', region)]);
    assert.equal(JSON.parse(buildAnnotationJSON()).modelSource['meshnotes:faceOrder'], 'file');

    state.annotations[0].faceOrderUnchecked = true;
    const json = JSON.parse(buildAnnotationJSON());
    assert.equal(json.modelSource['meshnotes:faceOrder'], undefined, 'an unchecked region leaves the marker out');
    assert.equal(JSON.stringify(json).includes('faceOrderUnchecked'), false, 'the session mark is never exported');
});

test('import: an old file is renumbered, a 1.6.6 file is taken as it is, and an unchecked region is reported', () => {
    const mesh = new THREE.Mesh(makeGrid(40), new THREE.MeshBasicMaterial());
    loadModel([mesh]);
    const fileTris = patchAround(mesh, { x: 1, y: -1, z: 0 }, 1.0);
    const fileIds = sortedIds(fileTris.map(t => `0_${t}`));

    // A file as MeshNotes 1.6.5 wrote it: legacy numbers, no marker.
    setSession([surfaceAnn('s1', legacyRegion(mesh, 0, fileTris))]);
    const oldFile = JSON.parse(buildAnnotationJSON());
    delete oldFile.modelSource['meshnotes:faceOrder'];

    setSession([]);
    const r1 = mergeW3CCollection(oldFile);
    assert.deepEqual(r1.surfaceFaces, { converted: 1, unchecked: 0 });
    assert.deepEqual(sortedIds(state.annotations[0].faceData), fileIds);

    // Exported again by 1.6.6: marker set, numbers in file order, taken as they are.
    const newFile = JSON.parse(buildAnnotationJSON());
    assert.equal(newFile.modelSource['meshnotes:faceOrder'], 'file');
    setSession([]);
    const r2 = mergeW3CCollection(newFile);
    assert.deepEqual(r2.surfaceFaces, { converted: 0, unchecked: 0 });
    assert.deepEqual(sortedIds(state.annotations[0].faceData), fileIds);

    // The same file re-exported by 1.6.5 lost its marker: checked, found in file order.
    delete newFile.modelSource['meshnotes:faceOrder'];
    setSession([]);
    const r3 = mergeW3CCollection(newFile);
    assert.deepEqual(r3.surfaceFaces, { converted: 0, unchecked: 0 });
    assert.deepEqual(sortedIds(state.annotations[0].faceData), fileIds);

    // Without a model the region is kept as read and reported.
    state.modelMeshes = [];
    state.currentModel = null;
    setSession([]);
    const r4 = mergeW3CCollection(oldFile);
    assert.deepEqual(r4.surfaceFaces, { converted: 0, unchecked: 1 });
    assert.equal(state.annotations[0].faceOrderUnchecked, true);
    assert.match(importStatusText(r4), /1 surface region could not be checked on this device/);
    assert.equal(JSON.parse(buildAnnotationJSON()).modelSource['meshnotes:faceOrder'], undefined);
});
