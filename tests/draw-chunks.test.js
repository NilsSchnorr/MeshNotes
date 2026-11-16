// tests/draw-chunks.test.js - Draw splitting for large meshes (Firefox draw limit)
// chunkLargeDraws() must cut a large mesh into draw calls that stay under the
// limit, without changing the geometry, the face numbering (file order, kept
// by the indirect BVH build), or what a raycast returns. Loads model-loader.js through
// tests/support/app-env.js. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/app-env.js';

const THREE = await import('three');
const { computeBoundsTree } = await import('three-mesh-bvh');
const { BVH_OPTIONS } = await import('../js/annotation-tools/face-order.js');
const { chunkLargeDraws, setMeshMaterial, DRAW_CHUNK_FACES, WIREFRAME_FACE_LIMIT } =
    await import('../js/core/model-loader.js');

// Firefox's default webgl.max-vert-ids-per-draw.
const FIREFOX_MAX_IDS_PER_DRAW = 30000000;

/** A bumpy indexed grid with `2 * n * n` faces, so the BVH has something to sort. */
function makeGrid(n) {
    const geometry = new THREE.PlaneGeometry(10, 10, n, n);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, Math.sin(pos.getX(i) * 3.1) * Math.cos(pos.getY(i) * 2.3));
    }
    return geometry;
}

const makeMesh = (geometry) => new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());

/** First hits of a fixed fan of rays, as "faceIndex@distance" strings. */
function castRays(mesh) {
    const raycaster = new THREE.Raycaster();
    const out = [];
    for (let i = 0; i < 200; i++) {
        const x = ((i * 37) % 97) / 97 * 9 - 4.5;
        const y = ((i * 61) % 89) / 89 * 9 - 4.5;
        raycaster.set(new THREE.Vector3(x, y, 20), new THREE.Vector3(0.01, -0.02, -1).normalize());
        const hit = raycaster.intersectObject(mesh, false)[0];
        out.push(hit ? `${hit.faceIndex}@${hit.distance.toFixed(9)}` : 'miss');
    }
    return out;
}

test('the chunk size keeps triangle and wireframe draws under the Firefox limit', () => {
    assert.ok(DRAW_CHUNK_FACES * 3 <= FIREFOX_MAX_IDS_PER_DRAW, 'triangles: 3 ids per face');
    assert.ok(DRAW_CHUNK_FACES * 6 <= FIREFOX_MAX_IDS_PER_DRAW, 'wireframe: 6 ids per face');
    assert.ok(DRAW_CHUNK_FACES < WIREFRAME_FACE_LIMIT);
});

test('a mesh at or below the chunk size is left untouched', () => {
    const mesh = makeMesh(makeGrid(10));                      // 200 faces
    const material = mesh.material;
    assert.equal(chunkLargeDraws(mesh, 200), false);
    assert.equal(mesh.geometry.groups.length, 0);
    assert.equal(mesh.material, material);
});

test('a large mesh is cut into contiguous groups that cover every face once', () => {
    const mesh = makeMesh(makeGrid(10));                      // 200 faces = 600 ids
    const material = mesh.material;
    assert.equal(chunkLargeDraws(mesh, 64), true);

    const groups = mesh.geometry.groups;
    assert.equal(groups.length, 4);                           // 64 + 64 + 64 + 8 faces
    let next = 0;
    for (const g of groups) {
        assert.equal(g.start, next, 'groups are contiguous');
        assert.equal(g.start % 3, 0, 'a group starts on a face boundary');
        assert.equal(g.count % 3, 0, 'a group holds whole faces');
        assert.ok(g.count <= 64 * 3, 'a group stays within the chunk size');
        assert.equal(g.materialIndex, 0);
        next += g.count;
    }
    assert.equal(next, mesh.geometry.index.count, 'all faces are covered');
    assert.deepEqual(mesh.material, [material], 'the material is wrapped, not replaced');
});

test('non-indexed geometry is cut by vertex count', () => {
    const mesh = makeMesh(makeGrid(10).toNonIndexed());       // 600 vertices
    assert.equal(chunkLargeDraws(mesh, 100), true);
    assert.deepEqual(mesh.geometry.groups.map(g => [g.start, g.count]), [[0, 300], [300, 300]]);
});

test('a geometry that already has groups is left alone', () => {
    const mesh = makeMesh(makeGrid(10));
    mesh.geometry.addGroup(0, 300, 0);
    mesh.geometry.addGroup(300, 300, 1);
    mesh.material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    assert.equal(chunkLargeDraws(mesh, 10), false);
    assert.equal(mesh.geometry.groups.length, 2);
    assert.equal(mesh.material.length, 2);
});

test('setMeshMaterial keeps the array form only for a split mesh', () => {
    const split = makeMesh(makeGrid(10));
    chunkLargeDraws(split, 64);
    const plain = makeMesh(makeGrid(10));
    const next = new THREE.MeshBasicMaterial();

    setMeshMaterial(split, next);
    assert.deepEqual(split.material, [next]);
    setMeshMaterial(plain, next);
    assert.equal(plain.material, next);
});

test('splitting after the BVH build keeps face numbering and raycast results', () => {
    const n = 60;                                             // 7200 faces
    const reference = makeMesh(makeGrid(n));
    reference.geometry.boundsTree = computeBoundsTree.call(reference.geometry, BVH_OPTIONS);
    const referenceIndex = Array.from(reference.geometry.index.array);
    const referenceHits = castRays(reference);
    assert.ok(referenceHits.filter(h => h !== 'miss').length > 150, 'the rays hit the grid');

    const mesh = makeMesh(makeGrid(n));
    mesh.geometry.boundsTree = computeBoundsTree.call(mesh.geometry, BVH_OPTIONS);
    assert.equal(chunkLargeDraws(mesh, 1000), true);
    assert.deepEqual(Array.from(mesh.geometry.index.array), referenceIndex, 'index buffer unchanged');
    assert.deepEqual(castRays(mesh), referenceHits, 'accelerated raycast unchanged');

    // Without a BVH (failed build), Three.js walks the groups itself.
    mesh.geometry.boundsTree = null;
    reference.geometry.boundsTree = null;
    assert.deepEqual(castRays(mesh), castRays(reference), 'brute-force raycast unchanged');
});

test('the indirect BVH build keeps file face order, whether the draw was split before or after it', () => {
    const n = 60;
    const fileOrder = Array.from(makeGrid(n).index.array);

    const after = makeMesh(makeGrid(n));
    after.geometry.boundsTree = computeBoundsTree.call(after.geometry, BVH_OPTIONS);
    chunkLargeDraws(after, 1000);

    const before = makeMesh(makeGrid(n));
    chunkLargeDraws(before, 1000);
    before.geometry.boundsTree = computeBoundsTree.call(before.geometry, BVH_OPTIONS);

    assert.deepEqual(Array.from(after.geometry.index.array), fileOrder);
    assert.deepEqual(Array.from(before.geometry.index.array), fileOrder);

    // The in-place build used before 1.6.6 sorted the index buffer.
    const legacy = makeMesh(makeGrid(n));
    legacy.geometry.boundsTree = computeBoundsTree.call(legacy.geometry);
    assert.notDeepEqual(Array.from(legacy.geometry.index.array), fileOrder);
});
