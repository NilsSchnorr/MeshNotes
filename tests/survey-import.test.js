// tests/survey-import.test.js - Surface distance, snapping and re-placement of survey points, and merge decisions 2 and 5
// (plan: Algorithms > Surface distance and snapping; Edge cases "Model without a BVH" and "Thousands of rows").
// Builds small box meshes with three-mesh-bvh trees, registers them the way model-loader.js does
// (state.currentModel, modelMeshes, bvhAvailable) and runs projection.js, survey-import.js and
// mergeW3CCollection through the full frame chain: survey -> export (alignment.js) -> storage
// (pointFromZUp) -> display (flip) and back. Loads the browser modules through tests/support/app-env.js.
// Also covers creating points from CSV rows (plan: Data model > CSV row to annotation): names, entry text,
// attributes, import groups, the duplicate rules, the summary and the export round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/app-env.js';
import { T1, T2, T3, T5, makeAlignment, refined, surveyAnnotation, group, modelDist } from './support/survey-samples.js';
import * as AL from '../js/survey/alignment.js';
import { parseSurveyCsv, autoMap, buildRecords, swapMappingEN } from '../js/survey/column-mapping.js';

const THREE = await import('three');
const { computeBoundsTree } = await import('three-mesh-bvh');
const { state } = await import('../js/state.js');
const P = await import('../js/annotation-tools/projection.js');
const SI = await import('../js/survey/survey-import.js');
const { buildAnnotationJSON } = await import('../js/export/export-json.js');
const { mergeW3CCollection, realignMoves, importReplacementPlan, importStatusText } = await import('../js/export/import-json.js');

// As model-loader.js registers it.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

const UA = 'aaaaaaaa-0000-4000-8000-000000000001';
// Mesh vertices are 32-bit floats, so surface points carry errors of about 1e-7 m.
const TOL = 1e-6;
const close = (a, b, tol = TOL) => Math.abs(a - b) <= tol;
const clone = (v) => structuredClone(v);

function assertPoint(actual, expected, tol = TOL) {
    assert.ok(actual && modelDist(actual, expected) <= tol,
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual && { x: actual.x, y: actual.y, z: actual.z })}`);
}

// ---- Test model ------------------------------------------------------------

// A box mesh with its BVH, added to parent; size and centre in the parent's frame.
function boxMesh(parent, size, center, segments = 1) {
    const geometry = new THREE.BoxGeometry(size[0], size[1], size[2], segments, segments, segments);
    geometry.translate(center[0], center[1], center[2]);
    geometry.computeBoundsTree();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    parent.add(mesh);
    return mesh;
}

// The test model in storage coordinates (Y-up, re-centred):
//   base:   x and z from -2 to 2, y from -2 to 0 (top face at y = 0)
//   pillar: x and z from 1 to 2,  y from 0 to 2  (top face at y = 2)
// Built like a Z-up file (the loader's -90 degree turn about X), with the base
// inside a glTF node scaled by 2, so mesh-local and world distances differ.
function loadTestModel({ bvh = true } = {}) {
    const model = new THREE.Group();
    model.rotation.x = -Math.PI / 2;
    const node = new THREE.Group();
    node.scale.setScalar(2);
    model.add(node);
    const base = boxMesh(node, [2, 2, 1], [0, 0, -0.5]);
    const pillar = boxMesh(model, [1, 1, 2], [1.5, -1.5, 1]);
    model.updateMatrixWorld(true);
    // Re-centre like setupLoadedModelInternal (the bounding box is centred already).
    model.position.sub(new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3()));
    model.updateMatrixWorld(true);
    state.currentModel = model;
    state.modelMeshes = [base, pillar];
    state.bvhAvailable = bvh;
    state.isFlipped = false;
    return model;
}

// The flip toggle as scene.js toggleFlip() does it (that function needs the
// DOM). Like it, this leaves the matrices stale after the re-centring; the
// query updates them.
function toggleFlip(model) {
    state.isFlipped = !state.isFlipped;
    model.rotation.x += state.isFlipped ? Math.PI : -Math.PI;
    model.updateMatrixWorld(true);
    model.position.sub(new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3()));
}

// survey-samples alignments (heading 90, shift 512000 / 4123000 / 58) map a
// survey point to storage (dN, dH, dE) relative to the shift. For a point
// over the base top, the nearest surface point is straight below or above.
function onBaseTop(alignment, s) {
    const f = AL.surveyToStorage(alignment, s);
    return { x: f.x, y: 0, z: f.z };
}

// ---- Sessions (as in import-json.test.js) ----------------------------------

function setSession({ groups = [], annotations = [], alignments = [], defaultAlignmentId = null } = {}) {
    state.modelFileName = 'trench3.glb';
    state.modelHash = 'abc123';
    state.modelFrameOrigin = null;
    state.modelInfo = { entries: [], metadata: null };
    state.groups = groups;
    state.annotations = annotations;
    state.alignments = alignments;
    state.defaultAlignmentId = defaultAlignmentId;
}

function exportSession(session) {
    setSession(clone(session));
    return JSON.parse(buildAnnotationJSON());
}

const byUuid = (uuid) => state.annotations.find(a => a.uuid === uuid);

// ---- Tests -----------------------------------------------------------------

test('nearestSurfacePoint: world distance, face-normal side and the search radius', () => {
    loadTestModel();
    assert.equal(P.isSurfaceQueryAvailable(), true);

    // 0.3 m above the base top: 0.15 units in the scaled node's own frame.
    const above = P.nearestSurfacePoint(new THREE.Vector3(-1, 0.3, -1));
    assertPoint(above.point, { x: -1, y: 0, z: -1 });
    assert.ok(close(above.distance, 0.3));
    assert.equal(above.side, 1);
    assertPoint(above.normal, { x: 0, y: 1, z: 0 });
    // Inside the base, 0.2 m under its top face: below.
    const below = P.nearestSurfacePoint({ x: -1, y: -0.2, z: -1 });
    assertPoint(below.point, { x: -1, y: 0, z: -1 });
    assert.ok(close(below.distance, 0.2));
    assert.equal(below.side, -1);
    // The other mesh.
    const pillarTop = P.nearestSurfacePoint({ x: 1.5, y: 2.4, z: 1.5 });
    assertPoint(pillarTop.point, { x: 1.5, y: 2, z: 1.5 });
    assert.ok(close(pillarTop.distance, 0.4));
    assert.equal(pillarTop.side, 1);

    // The radius is in world units, and a hit beyond it is dropped.
    assert.ok(P.nearestSurfacePoint({ x: -1, y: 0.3, z: -1 }, 0.3 + TOL));
    assert.equal(P.nearestSurfacePoint({ x: -1, y: 0.3, z: -1 }, 0.29), null);
    const far = { x: -1, y: 5, z: -1 };
    assert.equal(P.nearestSurfacePoint(far, 2), null);
    const unlimited = P.nearestSurfacePoint(far);
    assertPoint(unlimited.point, { x: 1, y: 2, z: 1 });          // the pillar's corner, nearer than the base top
    assert.ok(close(unlimited.distance, Math.sqrt(17)));

    // Batch: one entry per position, null beyond the radius; results are
    // copies, so a later query does not change them.
    const batch = P.nearestSurfacePoints([{ x: -1, y: 0.3, z: -1 }, far], 2);
    assert.equal(batch.length, 2);
    assert.equal(batch[1], null);
    P.nearestSurfacePoints([{ x: 1.5, y: 2.4, z: 1.5 }]);
    assertPoint(batch[0].point, { x: -1, y: 0, z: -1 });
});

test('survey rows through the full frame chain: fitted position -> surface -> storage, flip off and on', async () => {
    const model = loadTestModel();
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const records = [
        { e: 511999, n: 4122999, h: 58.3 },         // over the base top at storage (-1, 0, -1)
        { e: 511999, n: 4122999, h: 57.8 },         // the same spot, 0.2 m under the top: inside the base
        { e: 512001.5, n: 4123001.5, h: 60.4 },     // over the pillar top at (1.5, 2, 1.5)
        { e: 512030, n: 4123000, h: 58 }            // 28 m off the model's side at (0, 0, 2)
    ];
    const positions = SI.fittedStoragePositions(records, a);
    assertPoint(positions[0], { x: -1, y: 0.3, z: -1 });
    assertPoint(positions[3], { x: 0, y: 0, z: 30 });
    assert.deepEqual(positions, AL.fittedPositions(records, a, { frame: 'storage' }));

    const expected = [
        { point: { x: -1, y: 0, z: -1 }, distance: 0.3 },
        { point: { x: -1, y: 0, z: -1 }, distance: -0.2 },
        { point: { x: 1.5, y: 2, z: 1.5 }, distance: 0.4 }
    ];
    const runs = [];
    for (const flipped of [false, true]) {
        if (flipped) toggleFlip(model);
        assert.equal(state.isFlipped, flipped);
        const m = await SI.measureSurfaceDistances(positions);
        assert.equal(m.measured, true);
        assert.equal(m.searchRadius, 2);
        expected.forEach((x, i) => {
            assertPoint(m.results[i].point, x.point);
            assert.ok(close(m.distances[i], x.distance), `row ${i}: ${m.distances[i]}`);
            assert.equal(m.results[i].distance, m.distances[i]);
            assert.equal(m.results[i].side, Math.sign(x.distance));
        });
        assert.equal(m.distances[3], Infinity);              // beyond the 2 m search radius
        assert.equal(m.results[3], null);

        // Snapping searches without a limit: the far row lands on the side face.
        const snaps = SI.snapToSurface(positions);
        expected.forEach((x, i) => {
            assertPoint(snaps[i].point, x.point);
            assert.ok(close(snaps[i].surfaceDistance, x.distance));
        });
        assertPoint(snaps[3].point, { x: 0, y: 0, z: 2 });
        assert.ok(close(snaps[3].surfaceDistance, 28));

        // Placements for creating points: measured rows reuse their hit, the
        // far row (ticked by hand) is snapped.
        const placed = await SI.surfacePlacements(positions, m, [3, 0]);
        assert.deepEqual(placed.map(p => p.index), [3, 0]);
        assertPoint(placed[0].point, { x: 0, y: 0, z: 2 });
        assert.ok(close(placed[1].surfaceDistance, 0.3));
        runs.push({ m, snaps });
    }
    // Flipped or not, the same storage results.
    runs[0].snaps.forEach((s, i) => {
        assertPoint(runs[1].snaps[i].point, s.point);
        assert.ok(close(runs[1].snaps[i].surfaceDistance, s.surfaceDistance));
    });
    // A storage position queried as if it were a display position gives the
    // wrong side once the model is flipped: the wrapper's conversion matters.
    assert.equal(P.nearestSurfacePoint(positions[0]).side, -1);
    toggleFlip(model);
    assert.equal(P.nearestSurfacePoint(positions[0]).side, 1);
});

test('a scaled node: distances are compared in world space and the radius is scaled into mesh space', () => {
    // Mesh A sits in a node scaled by 10: its bottom face is 1.0 m from the
    // query in the world but 0.1 units in its own frame. Mesh B is 0.5 m away.
    // Comparing mesh-local distances would pick A.
    const model = new THREE.Group();
    const big = new THREE.Group();
    big.scale.setScalar(10);
    model.add(big);
    const meshA = boxMesh(big, [1, 0.1, 1], [0, 0.25, 0]);     // world y from 2 to 3
    const meshB = boxMesh(model, [4, 1, 4], [0, 0, 0]);        // world y from -0.5 to 0.5
    // Mesh C sits in a node scaled by 0.1: 0.3 m in the world are 3 units in
    // its frame. Subdivided, so its BVH has inner nodes that a search radius
    // left unscaled (0.5 units) would prune.
    const small = new THREE.Group();
    small.scale.setScalar(0.1);
    small.position.set(10, 0, 0);
    model.add(small);
    const meshC = boxMesh(small, [10, 1, 10], [0, 0, 0], 8);   // world y from -0.05 to 0.05 around x = 10
    model.updateMatrixWorld(true);
    state.currentModel = model;
    state.modelMeshes = [meshA, meshB, meshC];
    state.bvhAvailable = true;
    state.isFlipped = false;

    const hit = P.nearestSurfacePoint({ x: 0, y: 1, z: 0 });
    assertPoint(hit.point, { x: 0, y: 0.5, z: 0 });
    assert.ok(close(hit.distance, 0.5));
    assert.equal(hit.side, 1);
    const fromA = P.nearestSurfacePoint({ x: 0, y: 2.2, z: 0 });
    assertPoint(fromA.point, { x: 0, y: 2, z: 0 });
    assert.ok(close(fromA.distance, 0.2));
    assert.equal(fromA.side, -1);                                 // inside mesh A

    // The world radius covers 3 local units of mesh C.
    const hitC = P.nearestSurfacePoint({ x: 10, y: 0.35, z: 0 }, 0.5);
    assertPoint(hitC.point, { x: 10, y: 0.05, z: 0 });
    assert.ok(close(hitC.distance, 0.3));
    assert.equal(P.nearestSurfacePoint({ x: 10, y: 0.35, z: 0 }, 0.29), null);
});

test('no BVH or no model: nothing measured or snapped, the bounding box decides the selection', async () => {
    loadTestModel({ bvh: false });
    assert.equal(P.isSurfaceQueryAvailable(), false);
    assert.equal(P.nearestSurfacePoints([{ x: -1, y: 0.3, z: -1 }]), null);
    assert.equal(P.nearestSurfacePointsFlipAware([{ x: -1, y: 0.3, z: -1 }]), null);
    assert.equal(P.nearestSurfacePoint({ x: -1, y: 0.3, z: -1 }), null);

    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const records = [
        { e: 511999, n: 4122999, h: 58.3 },     // inside the box
        { e: 511999, n: 4122999, h: 60.4 },     // 0.4 m above the box (y = 2.4)
        { e: 512005, n: 4123000, h: 58 }        // 3 m beyond its side (z = 5)
    ];
    const positions = SI.fittedStoragePositions(records, a);
    const m = await SI.measureSurfaceDistances(positions);
    assert.deepEqual(m, { measured: false, searchRadius: 2, distances: [null, null, null], results: [null, null, null] });
    const box = SI.modelStorageBox();
    assertPoint(box.min, { x: -2, y: -2, z: -2 });
    assertPoint(box.max, { x: 2, y: 2, z: 2 });

    const c = SI.classifyMeasurement(records, positions, m, { limit: 0.5 });
    assert.deepEqual(c.rows.map(r => [r.index, r.method, r.onModel]),
        [[0, 'box', true], [1, 'box', true], [2, 'box', false]]);
    assert.equal(c.onModelCount, 2);
    assert.ok(close(c.rows[1].boxDistance, 0.4));
    // A narrower limit leaves the row above the box out; inside always counts.
    assert.equal(SI.classifyMeasurement(records, positions, m, { limit: 0.1 }).onModelCount, 1);

    // Points keep their fitted positions; surfaceDistance null is the flag.
    const snaps = SI.snapToSurface(positions);
    snaps.forEach((s, i) => {
        assert.deepEqual(s.point, positions[i]);
        assert.notEqual(s.point, positions[i]);
        assert.equal(s.surfaceDistance, null);
    });
    const placed = await SI.surfacePlacements(positions, m);
    assert.deepEqual(placed.map(p => p.surfaceDistance), [null, null, null]);
    assert.deepEqual(placed[2].point, positions[2]);

    // No model at all.
    state.currentModel = null;
    state.modelMeshes = [];
    assert.equal(P.isSurfaceQueryAvailable(), false);
    assert.equal(SI.modelStorageBox(), null);
    assert.equal((await SI.measureSurfaceDistances(positions)).measured, false);
    assert.equal(SI.classifyMeasurement(records, positions, m).onModelCount, 0);
});

test('chunked runs: 200 per frame with a progress callback, cancelled by a signal or a model change', async () => {
    const model = loadTestModel();
    let frames = 0;
    globalThis.requestAnimationFrame = (cb) => { frames++; setTimeout(cb, 0); return frames; };
    try {
        // 450 positions over the base top, away from its edges and the pillar.
        const positions = Array.from({ length: 450 }, (_, i) => ({
            x: -1.5 + (i % 30) * 0.1, y: 0.1 + Math.floor(i / 30) * 0.01, z: -1
        }));
        const progress = [];
        const m = await SI.measureSurfaceDistances(positions, { onProgress: (done, total) => progress.push([done, total]) });
        assert.deepEqual(progress, [[200, 450], [400, 450], [450, 450]]);
        assert.equal(frames, 2);                         // the first chunk runs at once
        m.distances.forEach((d, i) => assert.ok(close(d, positions[i].y), `row ${i}`));
        assert.equal(SI.SURFACE_CHUNK_SIZE, 200);

        // Cancelled after the first chunk: rejects, no further chunk runs.
        const controller = new AbortController();
        const seen = [];
        await assert.rejects(SI.measureSurfaceDistances(positions, {
            signal: controller.signal,
            onProgress: (done) => { seen.push(done); controller.abort(); }
        }), { name: 'AbortError' });
        assert.deepEqual(seen, [200]);

        // Another model loaded between two chunks.
        const chunks = [];
        await assert.rejects(SI.runChunked(450, (start, end) => {
            chunks.push([start, end]);
            state.currentModel = new THREE.Group();
        }), { name: 'AbortError' });
        assert.deepEqual(chunks, [[0, 200]]);
        state.currentModel = model;

        // The chunked replacement moves the points together at the end.
        const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
        const a2 = refined(a, { headingDeg: 90.5, now: T2 });
        const s = (i) => ({ e: 511998.5 + (i % 15) * 0.1, n: 4122998.5 + Math.floor(i / 15) * 0.1, h: 58.2 });
        state.annotations = Array.from({ length: 250 }, (_, i) =>
            surveyAnnotation({ id: i + 1, uuid: `c${i}`, alignment: a, s: s(i), position: onBaseTop(a, s(i)) }));
        const before = clone(state.annotations.map(ann => ann.points[0]));
        const plan = AL.planRefinePlacement(state.annotations, a, a2);
        const cancel = new AbortController();
        await assert.rejects(SI.applyReplacementChunked(plan, {
            signal: cancel.signal, onProgress: () => cancel.abort()
        }), { name: 'AbortError' });
        assert.deepEqual(state.annotations.map(ann => ann.points[0]), before);   // nothing moved

        const steps = [];
        const stats = await SI.applyReplacementChunked(plan, { onProgress: (done, total) => steps.push([done, total]) });
        assert.deepEqual(steps, [[200, 250], [250, 250]]);
        assert.equal(stats.moved, 250);
        assert.equal(stats.snapped, true);
        state.annotations.forEach((ann, i) => {
            assertPoint(ann.points[0], onBaseTop(a2, s(i)));
            assert.ok(close(ann.survey.surfaceDistance, 0.2));
        });
    } finally {
        delete globalThis.requestAnimationFrame;
    }
});

test('chunked runs go on in a hidden tab and never overwrite a point changed meanwhile', async () => {
    loadTestModel();
    // A hidden tab: animation frames never come.
    let frames = 0;
    globalThis.requestAnimationFrame = () => ++frames;
    try {
        const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
        const a2 = refined(a, { headingDeg: 90.5, now: T2 });
        const s = (i) => ({ e: 511998.5 + (i % 15) * 0.1, n: 4122998.5 + Math.floor(i / 15) * 0.1, h: 58.2 });
        state.annotations = Array.from({ length: 250 }, (_, i) =>
            surveyAnnotation({ id: i + 1, uuid: `h${i}`, alignment: a, s: s(i), position: onBaseTop(a, s(i)) }));
        const [p0, p1, p2, p3] = state.annotations;
        const before = clone([p0, p1, p2, p3].map(ann => ann.points[0]));
        const plan = AL.planRefinePlacement(state.annotations, a, a2);

        // Between the chunks: p0 is moved by an undo, p1 gets another survey
        // block (a second import), p2 is deleted, p3 is re-attached elsewhere.
        const run = SI.applyReplacementChunked(plan, {
            onProgress: (done) => {
                if (done !== 200) return;
                p0.points[0] = { x: -1.25, y: 0, z: -1.25 };
                p1.survey = { ...p1.survey };
                state.annotations = state.annotations.filter(ann => ann !== p2);
                p3.survey.alignmentId = 999;
            }
        });
        const stats = await run;
        assert.ok(frames >= 1);
        assert.equal(stats.moved, 246);
        assert.equal(stats.skipped, 4);
        assert.deepEqual(p0.points[0], { x: -1.25, y: 0, z: -1.25 });
        assert.deepEqual([p1, p2, p3].map(ann => ann.points[0]), before.slice(1));
        state.annotations.slice(3).forEach((ann, k) => assertPoint(ann.points[0], onBaseTop(a2, s(k + 4))));
    } finally {
        delete globalThis.requestAnimationFrame;
    }
});

test('remeasureForLimit measures again only the rows beyond the old search radius', async () => {
    loadTestModel();
    const positions = [
        { x: -1, y: 0.3, z: -1 },       // 0.3 m
        { x: -1, y: 4.5, z: -1 },       // sqrt(14.25) = 3.77 m to the pillar's corner
        { x: -1, y: 20, z: -1 }         // 18.2 m
    ];
    const records = positions.map((p, i) => ({ row: i + 2 }));
    const m = await SI.measureSurfaceDistances(positions, { maxDistance: SI.searchRadiusForLimit(0.5) });
    assert.equal(m.searchRadius, 2);
    assert.ok(close(m.distances[0], 0.3));
    assert.deepEqual(m.distances.slice(1), [Infinity, Infinity]);

    // Limits up to the radius need nothing new.
    assert.equal(await SI.remeasureForLimit(positions, m, 0.5), m);
    assert.equal(await SI.remeasureForLimit(positions, m, 2), m);

    // Above it: only the Infinity rows are queried again (row 0 is moved
    // here to show that it is not), with the radius of the new limit.
    const moved = positions.map(p => ({ ...p }));
    moved[0] = { x: -1, y: 0.9, z: -1 };
    const r = await SI.remeasureForLimit(moved, m, 2.5);
    assert.notEqual(r, m);
    assert.equal(r.searchRadius, 10);
    assert.ok(close(r.distances[0], 0.3));
    assert.ok(close(r.distances[1], Math.sqrt(14.25)));
    assertPoint(r.results[1].point, { x: 1, y: 2, z: 1 });
    assert.equal(r.distances[2], Infinity);
    assert.deepEqual(m.distances.slice(1), [Infinity, Infinity]);   // the old measurement is unchanged
    const c = SI.classifyMeasurement(records, positions, r, { limit: 2.5 });
    assert.deepEqual(c.rows.map(row => [row.index, row.onModel]), [[0, true], [1, false], [2, false]]);
    assert.equal(SI.classifyMeasurement(records, positions, r, { limit: 4 }).onModelCount, 2);

    assert.equal(SI.searchRadiusForLimit(), 2);
    assert.equal(SI.searchRadiusForLimit(0.1), 2);
    assert.equal(SI.searchRadiusForLimit(1), 4);
    assert.equal(SI.searchRadiusForLimit(Number.NaN), 2);
});

test('applyReplacement moves fit points to the new fit, snaps them and never moves hand-moved points', () => {
    loadTestModel();
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const a2 = refined(a, { headingDeg: 90.5, now: T2 });
    const s1 = { e: 511999, n: 4122999, h: 58.25 };         // 0.25 m above the base top
    const s2 = { e: 511999.5, n: 4122998.5, h: 57.9 };      // 0.1 m below it
    const s3 = { e: 512000.5, n: 4122999.5, h: 58.1 };
    const s4 = { e: 511999.25, n: 4122999.75, h: 58.3 };
    const p1 = surveyAnnotation({ id: 1, uuid: 'p1', alignment: a, s: s1, position: onBaseTop(a, s1), surfaceDistance: 0.25 });
    const p2 = surveyAnnotation({ id: 2, uuid: 'p2', alignment: a, s: s2, position: onBaseTop(a, s2), surfaceDistance: -0.1 });
    const p3 = surveyAnnotation({ id: 3, uuid: 'p3', alignment: a, s: s3, placement: 'manual', position: { x: -0.5, y: 0, z: 0.5 } });
    const p4 = surveyAnnotation({ id: 4, uuid: 'p4', alignment: a, s: s4, position: onBaseTop(a, s4), surfaceDistance: 0.3 });
    state.annotations = [p1, p2, p3, p4];
    const before = clone({ p1: p1.points[0], p2: p2.points[0], p3, p4 });

    const plan = AL.planRefinePlacement(state.annotations, a, a2);
    assert.equal(plan.count, 3);
    assert.deepEqual(plan.manual, [p3]);
    p4.survey.placement = 'manual';                 // dragged after the preview
    const stats = SI.applyReplacement(plan);

    assertPoint(p1.points[0], onBaseTop(a2, s1));
    assert.ok(close(p1.survey.surfaceDistance, AL.surveyToStorage(a2, s1).y));
    assert.ok(close(p1.survey.surfaceDistance, 0.25));
    assert.equal(p1.survey.placement, 'fit');
    assertPoint(p2.points[0], onBaseTop(a2, s2));
    assert.ok(close(p2.survey.surfaceDistance, -0.1));
    assert.deepEqual(p3, before.p3);
    assert.deepEqual(p4.points, before.p4.points);
    assert.equal(p4.survey.surfaceDistance, 0.3);

    const shifts = [modelDist(before.p1, p1.points[0]), modelDist(before.p2, p2.points[0])];
    assert.ok(shifts.every(d => d > 0.005 && d < 0.05), `shifts ${shifts}`);
    assert.equal(stats.moved, 2);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.snapped, true);
    assert.ok(close(stats.maxMove, Math.max(...shifts)));
    assert.ok(close(stats.medianMove, (shifts[0] + shifts[1]) / 2));

    // An empty plan moves nothing.
    assert.deepEqual(SI.applyReplacement({ moves: [] }), { moved: 0, maxMove: 0, medianMove: 0, skipped: 0, snapped: true });

    // Without a BVH, then without a model: to the fitted position, unsnapped, surfaceDistance null.
    for (const noModel of [false, true]) {
        const q = surveyAnnotation({ id: 9, uuid: 'q9', alignment: a, s: s1, position: onBaseTop(a, s1) });
        state.bvhAvailable = false;
        if (noModel) { state.currentModel = null; state.modelMeshes = []; }
        const result = SI.applyReplacement(AL.planRefinePlacement([q], a, a2));
        assertPoint(q.points[0], AL.surveyToStorage(a2, s1));
        assert.equal(q.survey.surfaceDistance, null);
        assert.equal(result.moved, 1);
        assert.equal(result.snapped, false);
        assert.ok(close(result.maxMove, modelDist(onBaseTop(a, s1), AL.surveyToStorage(a2, s1))));
        assert.equal(SI.replacementSummary(result),
            `1 survey point moved to the newer alignment (largest ${result.maxMove.toFixed(3)} m, not snapped to the surface)`);
    }

    assert.equal(SI.replacementSummary({ moved: 3, maxMove: 0.0421, snapped: true }),
        '3 survey points moved to the newer alignment (largest 0.042 m)');
    assert.equal(SI.replacementSummary({ moved: 3, maxMove: 0.0421, snapped: true }, { alignmentCount: 2 }),
        '3 survey points moved to the newer alignments (largest 0.042 m)');
    assert.equal(SI.replacementSummary({ moved: 0, maxMove: 0, snapped: true }), '');
    assert.equal(SI.replacementSummary(null), '');
});

test('decision 2: a newer alignment from the file moves and snaps the local-only fit points', () => {
    loadTestModel();
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const a2 = refined(a, { id: 501, headingDeg: 90.5, now: T2 });
    const s1 = { e: 511999, n: 4122999, h: 58.25 };
    const s3 = { e: 511999.5, n: 4122998.5, h: 57.9 };
    const s4 = { e: 512000.5, n: 4122999.5, h: 58.1 };
    const groups = [group(1, 'g1', 'Default')];
    const file = exportSession({
        groups,
        annotations: [surveyAnnotation({ id: 1, uuid: 'p1', alignment: a2, s: s1, position: onBaseTop(a2, s1), surfaceDistance: 0.25 })],
        alignments: [a2]
    });

    const p1 = surveyAnnotation({ id: 11, uuid: 'p1', alignment: a, s: s1, position: onBaseTop(a, s1) });
    const p3 = surveyAnnotation({ id: 13, uuid: 'p3', alignment: a, s: s3, position: onBaseTop(a, s3), surfaceDistance: -0.1 });
    const p4 = surveyAnnotation({ id: 14, uuid: 'p4', alignment: a, s: s4, placement: 'manual', position: { x: -0.5, y: 0, z: 0.5 } });
    setSession({ groups: clone(groups), annotations: [p1, p3, p4], alignments: [a] });
    const p3Before = { ...p3.points[0] };
    const p4Before = clone(p4);

    const result = mergeW3CCollection(clone(file));
    assert.deepEqual(result.alignments.replaced, [UA]);
    assert.equal(result.realign.length, 1);
    const entry = result.realign[0];
    assert.equal(entry.kind, 'replaced');
    assert.equal(entry.previous, a);
    assert.equal(entry.alignment, state.alignments[0]);
    const moves = realignMoves(result.realign);
    assert.deepEqual(moves.map(m => m.annotation.uuid), ['p3']);
    assert.deepEqual(entry.plan.manual.map(ann => ann.uuid), ['p4']);
    // mergeW3CCollection itself moves nothing.
    assert.deepEqual(p3.points[0], p3Before);

    const stats = SI.applyReplacement({ moves });
    assertPoint(p3.points[0], onBaseTop(a2, s3));
    assert.ok(close(p3.survey.surfaceDistance, -0.1));
    assert.equal(p3.survey.alignmentId, a.id);
    assert.equal(p3.survey.placement, 'fit');
    assert.deepEqual(p4, p4Before);
    assertPoint(p1.points[0], onBaseTop(a2, s1));           // taken from the file
    assert.equal(stats.moved, 1);
    assert.ok(close(stats.maxMove, modelDist(p3Before, p3.points[0])));
    assert.ok(stats.maxMove > 0.005);
    assert.equal(SI.replacementSummary(stats),
        `1 survey point moved to the newer alignment (largest ${stats.maxMove.toFixed(3)} m)`);

    // A newer copy with the same fit (only renamed) moves nothing.
    const current = state.alignments[0];
    const renamed = AL.editAlignmentMetadata(current, { name: 'Trench 3 east', now: T5 });
    const file2 = exportSession({ groups, annotations: [], alignments: [renamed] });
    const q = surveyAnnotation({ id: 21, uuid: 'q1', alignment: current, s: s3, position: onBaseTop(current, s3) });
    setSession({ groups: clone(groups), annotations: [q], alignments: [current] });
    const again = mergeW3CCollection(file2);
    assert.deepEqual(again.alignments.replaced, [UA]);
    assert.equal(state.alignments[0].name, 'Trench 3 east');
    assert.deepEqual(again.realign, []);
});

test('decision 5: points placed from the file on an alignment whose local copy is newer move to the local fit', () => {
    loadTestModel();
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const local = refined(a, { headingDeg: 90.5, now: T5 });     // id 101, newer
    const fileCopy = makeAlignment({ id: 501, uuid: UA, now: T1 });
    const s5 = { e: 511999, n: 4122999, h: 58.25 };
    const s6 = { e: 511999.5, n: 4122998.5, h: 58.1 };
    const s7 = { e: 512000.5, n: 4122999.5, h: 58.1 };
    const s8 = { e: 511999.25, n: 4122999.75, h: 57.95 };
    const groups = [group(1, 'g1', 'Default')];
    const file = exportSession({
        groups,
        annotations: [
            // q7: held on both sides, the local copy wins (newer alignment).
            surveyAnnotation({ id: 7, uuid: 'q7', alignment: fileCopy, s: s7, position: onBaseTop(fileCopy, s7) }),
            // q8: detached here, on the alignment over there with newer entries: the file's copy wins.
            surveyAnnotation({ id: 8, uuid: 'q8', alignment: fileCopy, s: s8, position: onBaseTop(fileCopy, s8), entryModified: T3 }),
            // q5, q6: only in the file; q6 was moved by hand.
            surveyAnnotation({ id: 5, uuid: 'q5', alignment: fileCopy, s: s5, position: onBaseTop(fileCopy, s5) }),
            surveyAnnotation({ id: 6, uuid: 'q6', alignment: fileCopy, s: s6, placement: 'manual', position: { x: 0.5, y: 0, z: -0.5 } })
        ],
        alignments: [fileCopy]
    });

    const q7 = surveyAnnotation({ id: 17, uuid: 'q7', alignment: local, s: s7, position: onBaseTop(local, s7) });
    const q8 = surveyAnnotation({ id: 18, uuid: 'q8', alignment: null, s: s8, position: { x: -1.2, y: 0, z: 1.2 } });
    setSession({ groups: clone(groups), annotations: [q7, q8], alignments: [local] });
    const q7Before = clone(q7);

    const result = mergeW3CCollection(clone(file));
    assert.deepEqual(result.alignments.kept, [UA]);
    assert.deepEqual(result.alignments.replaced, []);
    assert.equal(state.alignments[0].id, local.id);
    assert.deepEqual(state.alignments[0].rotation, local.rotation);
    assert.equal(result.realign.length, 1);
    const entry = result.realign[0];
    assert.equal(entry.kind, 'kept');
    assert.equal(entry.alignment, state.alignments[0]);
    assert.equal(entry.previous.id, local.id);                    // the file's fit under the local id
    assert.deepEqual(entry.previous.rotation, fileCopy.rotation);
    assert.deepEqual(entry.previous.translation, fileCopy.translation);
    const moves = realignMoves(result.realign);
    assert.deepEqual(moves.map(m => m.annotation.uuid).sort(), ['q5', 'q8']);
    assert.deepEqual(entry.plan.manual.map(ann => ann.uuid), ['q6']);
    const q5 = byUuid('q5');
    const q6 = byUuid('q6');
    assertPoint(q5.points[0], onBaseTop(fileCopy, s5));     // added at the file's fit
    assert.equal(q8.survey.alignmentId, local.id);                 // the file's copy won (newer entries)
    const q6Before = clone(q6);

    const stats = SI.applyReplacement({ moves });
    assert.equal(stats.moved, 2);
    assertPoint(q5.points[0], onBaseTop(local, s5));
    assert.ok(close(q5.survey.surfaceDistance, 0.25));
    assertPoint(q8.points[0], onBaseTop(local, s8));
    assert.ok(close(q8.survey.surfaceDistance, -0.05));
    assert.deepEqual(q6, q6Before);
    assert.deepEqual(q7.points, q7Before.points);                  // the local copy won: untouched
    assert.deepEqual(q7.survey, q7Before.survey);

    // Importing the session's own export again: same alignment, same fit, nothing to move.
    const own = JSON.parse(buildAnnotationJSON());
    const again = mergeW3CCollection(own);
    assert.deepEqual(again.alignments.kept, [UA]);
    assert.deepEqual(again.realign, []);
});

test('import wiring: moves to run, chunking and the status line for decisions 2 and 5', () => {
    loadTestModel();
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const a2 = refined(a, { id: 501, headingDeg: 90.5, now: T2 });
    const groups = [group(1, 'g1', 'Default')];
    const s = (i) => ({ e: 511998.5 + (i % 15) * 0.1, n: 4122998.5 + Math.floor(i / 15) * 0.1, h: 58.2 });
    const file = exportSession({ groups, annotations: [], alignments: [a2] });
    const local = (count) => Array.from({ length: count }, (_, i) =>
        surveyAnnotation({ id: i + 1, uuid: `w${i}`, alignment: a, s: s(i), position: onBaseTop(a, s(i)) }));

    // Three local-only fit points on the replaced alignment: synchronous.
    setSession({ groups: clone(groups), annotations: local(3), alignments: [a] });
    const result = mergeW3CCollection(clone(file));
    const r = importReplacementPlan(result);
    assert.equal(r.moves.length, 3);
    assert.equal(r.alignmentCount, 1);
    assert.equal(r.chunked, false);
    const stats = SI.applyReplacement({ moves: r.moves });
    assert.equal(importStatusText(result, SI.replacementSummary(stats, { alignmentCount: r.alignmentCount })),
        `Import: 1 alignment updated, 3 survey points moved to the newer alignment (largest ${stats.maxMove.toFixed(3)} m)`);

    // More than one chunk: chunked.
    setSession({ groups: clone(groups), annotations: local(SI.SURFACE_CHUNK_SIZE + 1), alignments: [a] });
    assert.equal(importReplacementPlan(mergeW3CCollection(clone(file))).chunked, true);

    // Nothing to move: no extra part.
    setSession({ groups: clone(groups), annotations: [], alignments: [a] });
    const empty = mergeW3CCollection(clone(file));
    assert.deepEqual(importReplacementPlan(empty), { moves: [], alignmentCount: 0, chunked: false });
    assert.equal(importStatusText(empty, ''), 'Import: 1 alignment updated');
    assert.equal(importStatusText({ added: 0, merged: 0, unchanged: 0, alignments: { added: [], replaced: [] } }),
        'Import: nothing to import');
});

test('autosave restore and plain imports move nothing', () => {
    loadTestModel();
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const s1 = { e: 511999, n: 4122999, h: 58.25 };
    const groups = [group(1, 'g1', 'Default')];
    // A point left off the surface on purpose: a restore must not snap it.
    const p1 = surveyAnnotation({ id: 1, uuid: 'p1', alignment: a, s: s1, surfaceDistance: 0.25 });
    const file = exportSession({ groups, annotations: [p1], alignments: [a], defaultAlignmentId: a.id });

    // Restore: the session is empty, so every alignment is new.
    setSession();
    const restored = mergeW3CCollection(clone(file));
    assert.deepEqual(restored.alignments.added, [UA]);
    assert.deepEqual(restored.realign, []);
    assertPoint(byUuid('p1').points[0], AL.surveyToStorage(a, s1));
    assert.equal(byUuid('p1').survey.surfaceDistance, 0.25);

    // A file without alignments.
    const plain = clone(file);
    delete plain['meshnotes:alignments'];
    delete plain['meshnotes:defaultAlignment'];
    plain.first.items = [];
    const result = mergeW3CCollection(plain);
    assert.deepEqual(result.realign, []);
    assertPoint(byUuid('p1').points[0], AL.surveyToStorage(a, s1));
});

// ---- Creating points from CSV rows -----------------------------------------

// Made-up survey file. With the survey-samples alignment (heading 90, shift
// 512000 / 4123000 / 58) a row lands at storage (dN, dH, dE):
//   row 2  P1    over the base top at (-1, 0.3, -1): 0.3 m above the surface
//   row 3  (no name) over the base top at (-0.5, 0.05, -0.5): 0.05 m above
//   row 4  P3    over the pillar top at (1.5, 2.4, 1.5): 0.4 m above
//   row 5  P4    28 m beside the model at (0, 0, 30)
//   row 6  P5    no Easting: skipped
const SITE_CSV = [
    'Name,Code,Easting,Northing,Elevation,Description,Solution status,Author',
    'P1,GCP,511999.000,4122999.000,58.300,"Wall corner",FIX,Test Person',
    ',PEG,511999.500,4122999.500,58.050,,FLOAT,Test Person',
    'P3,,512001.500,4123001.500,60.400,Pillar top,FIX,',
    'P4,,512030.000,4123000.000,58.000,Far away,FIX,',
    'P5,,,4123000.000,58.000,No easting,FIX,'
].join('\n');

function siteRecords() {
    const parsed = parseSurveyCsv(SITE_CSV);
    const mapping = autoMap(parsed.headers, parsed.rows, { hasHeader: parsed.hasHeader, decimal: parsed.decimal });
    return { parsed, mapping, ...buildRecords(parsed.rows, mapping, { decimal: parsed.decimal, headers: parsed.headers }) };
}

// A record as buildRecords() makes it, for the duplicate rules.
const rec = (row, name, e, n, h) => ({
    row, name, e, n, h, raw: { e: String(e), n: String(n), h: String(h) },
    columns: { e: 'Easting', n: 'Northing', h: 'Elevation' }, description: '', code: '', attributes: {}
});

test('rows to annotation text: the name fallback, the Code line and the attributes', () => {
    assert.equal(SI.fileBaseName('trench3.csv'), 'trench3');
    assert.equal(SI.fileBaseName('site.2025.CSV'), 'site.2025');
    assert.equal(SI.fileBaseName('points'), 'points');
    assert.equal(SI.fileBaseName(''), 'Survey import');
    assert.equal(SI.surveyPointName({ name: 'GCP1', row: 4 }, 'trench3.csv'), 'GCP1');
    assert.equal(SI.surveyPointName({ name: '', row: 7 }, 'trench3.csv'), 'trench3 row 7');

    assert.equal(SI.surveyEntryText({ description: 'Wall\ncorner', code: 'GCP' }), 'Wall\ncorner\nCode: GCP');
    assert.equal(SI.surveyEntryText({ description: '', code: 'PEG' }), 'Code: PEG');
    assert.equal(SI.surveyEntryText({ description: 'Pillar top', code: '' }), 'Pillar top');
    assert.equal(SI.surveyEntryText({ description: '', code: '' }), '');

    // The code comes first, keyed by its column; a ticked Code column keeps its verbatim cell.
    const attrs = SI.surveyAttributes({ code: 'GCP', attributes: { 'Solution status': 'FIX' } }, 'Code');
    assert.deepEqual(Object.keys(attrs), ['Code', 'Solution status']);
    assert.equal(attrs.Code, 'GCP');
    assert.deepEqual(SI.surveyAttributes({ code: 'GCP', attributes: { Code: ' GCP ' } }, 'Code'), { Code: ' GCP ' });
    assert.deepEqual(SI.surveyAttributes({ code: '', attributes: {} }, 'Code'), {});
    assert.deepEqual(SI.surveyAttributes({ code: 'GCP', attributes: {} }, null), {});
});

test('import groups: a (2) suffix for a taken name, collapsed, labels off above the limit', () => {
    assert.equal(SI.uniqueGroupName('site', []), 'site');
    assert.equal(SI.uniqueGroupName('site', [{ name: 'site' }]), 'site (2)');
    assert.equal(SI.uniqueGroupName('site', [{ name: 'site' }, { name: 'site (2)' }]), 'site (3)');
    assert.equal(SI.uniqueGroupName('site', [{ name: 'Site' }]), 'site');

    assert.equal(SI.labelsVisibleFor(50, 50), true);
    assert.equal(SI.labelsVisibleFor(51, 50), false);
    assert.equal(SI.labelsVisibleFor(5000, 0), true);       // 0 = never hide
    assert.equal(SI.labelsVisibleFor(51), false);           // default 50
    assert.equal(SI.LABELS_OFF_ABOVE_DEFAULT, 50);

    const first = SI.SURVEY_GROUP_COLORS[0];
    assert.equal(SI.surveyGroupColor([]), first);
    assert.equal(SI.surveyGroupColor([{ color: first.toLowerCase() }]), SI.SURVEY_GROUP_COLORS[1]);

    const g = SI.makeSurveyGroup({ name: 'site', groups: [{ name: 'site', color: '#EDC040' }], pointCount: 51 });
    assert.deepEqual(Object.keys(g), ['id', 'uuid', 'name', 'color', 'visible', 'opacity', 'collapsed', 'labelsVisible']);
    assert.equal(g.name, 'site (2)');
    assert.equal(g.visible, true);
    assert.equal(g.opacity, 1.0);
    assert.equal(g.collapsed, true);
    assert.equal(g.labelsVisible, false);
    assert.equal(SI.makeSurveyGroup({ name: 'x', pointCount: 3 }).labelsVisible, true);
});

test('creating survey points: locked point annotations on the surface, in a new collapsed group', async () => {
    loadTestModel();
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    setSession({ groups: [group(1, 'g1', 'Default'), group(2, 'g2', 'site')], annotations: [], alignments: [a] });

    const { parsed, mapping, valid: records, skipped } = siteRecords();
    // Author holds personal data: never suggested as an attribute.
    assert.deepEqual(mapping.extras, [parsed.headers.indexOf('Solution status')]);
    assert.deepEqual(records.map(r => r.row), [2, 3, 4, 5]);
    assert.deepEqual(skipped.map(s => s.row), [6]);

    const positions = SI.fittedStoragePositions(records, a);
    const m = await SI.measureSurfaceDistances(positions, { maxDistance: SI.searchRadiusForLimit(0.5) });
    const c = SI.classifyMeasurement(records, positions, m, { limit: 0.5 });
    assert.equal(c.onModelCount, 3);
    const ticked = c.rows.filter(r => r.ticked).map(r => r.index).sort((x, y) => x - y);
    assert.deepEqual(ticked, [0, 1, 2]);

    const plan = SI.planSurveyCreation(ticked.map(i => ({ index: i, record: records[i] })),
        { fileName: 'site.csv', alignmentId: a.id, fileSha256: 'feed', annotations: state.annotations });
    assert.deepEqual(plan.create.map(x => x.name), ['P1', 'site row 3', 'P3']);
    assert.deepEqual([plan.duplicates, plan.nameConflicts], [[], []]);

    const placements = await SI.surfacePlacements(positions, m, plan.create.map(x => x.index));
    const result = SI.commitSurveyImport({
        plan, placements, alignmentId: a.id, fileName: 'site.csv', fileSha256: 'feed', codeColumn: 'Code',
        group: { kind: 'new', name: 'site' }, author: 'Test Person', language: 'en', locked: true,
        labelsOffAbove: 2, importedAt: T3
    });

    // A new group: 'site' is taken, so 'site (2)'; collapsed; 3 points > 2, so no labels.
    assert.equal(result.groupCreated, true);
    assert.equal(result.group.name, 'site (2)');
    assert.equal(result.group.collapsed, true);
    assert.equal(result.group.labelsVisible, false);
    assert.equal(state.groups.length, 3);
    assert.equal(state.annotations.length, 3);
    assert.deepEqual(state.annotations, result.created);

    const [p1, p2, p3] = result.created;
    // The shape of data.js saveAnnotation(), plus locked and survey.
    assert.deepEqual(Object.keys(p1), ['id', 'uuid', 'type', 'name', 'creator', 'groupId', 'points', 'entries', 'locked', 'survey']);
    assert.equal(p1.type, 'point');
    assert.equal(p1.name, 'P1');
    assert.equal(p1.creator, 'Test Person');
    assert.equal(p1.groupId, result.group.id);
    assert.equal(p1.locked, true);
    assert.equal(p1.entries.length, 1);
    assert.deepEqual(Object.keys(p1.entries[0]), ['id', 'uuid', 'description', 'author', 'language', 'timestamp', 'links']);
    assert.equal(p1.entries[0].description, 'Wall corner\nCode: GCP');
    assert.equal(p1.entries[0].author, 'Test Person');
    assert.equal(p1.entries[0].language, 'en');
    assert.equal(p1.entries[0].timestamp, T3);
    assert.deepEqual(p1.entries[0].links, []);
    assert.notEqual(p1.uuid, p2.uuid);

    // On the surface; the surveyed coordinate and the distance beside it.
    assertPoint(p1.points[0], { x: -1, y: 0, z: -1 });
    assert.ok(close(p1.survey.surfaceDistance, 0.3));
    assertPoint(p2.points[0], { x: -0.5, y: 0, z: -0.5 });
    assertPoint(p3.points[0], { x: 1.5, y: 2, z: 1.5 });
    assert.deepEqual({ ...p1.survey, surfaceDistance: null }, {
        alignmentId: a.id,
        e: 511999, n: 4122999, h: 58.3,
        raw: { e: '511999.000', n: '4122999.000', h: '58.300' },
        columns: { e: 'Easting', n: 'Northing', h: 'Elevation' },
        attributes: { Code: 'GCP', 'Solution status': 'FIX' },
        source: { fileName: 'site.csv', fileSha256: 'feed', row: 2, importedAt: T3 },
        placement: 'fit',
        surfaceDistance: null
    });
    assert.equal(p2.name, 'site row 3');
    assert.equal(p2.entries[0].description, 'Code: PEG');
    assert.equal(p3.entries[0].description, 'Pillar top');
    assert.deepEqual(p3.survey.attributes, { 'Solution status': 'FIX' });

    // Unlocked when the setting is off: no locked key at all.
    const open = SI.buildSurveyAnnotation(records[0], {
        name: 'P1', point: { x: 0, y: 0, z: 0 }, alignmentId: a.id, groupId: 1, fileName: 'site.csv',
        importedAt: T3, locked: false
    });
    assert.equal('locked' in open, false);
    assert.equal(open.survey.surfaceDistance, null);
    assert.equal(open.survey.source.fileSha256, null);

    // The summary: imported, off the model, skipped with row and reason, warnings.
    const summary = SI.surveyImportSummary({
        job: { file: { name: 'site.csv' }, skipped }, alignment: a, classification: c, ticked, plan, result,
        measurement: m, limit: 0.5, surfaceWarn: 0.1, labelsOffAbove: 2,
        acceptedWarnings: ['A binding warning.']
    });
    assert.equal(summary.imported, 3);
    assert.equal(summary.groupName, 'site (2)');
    assert.equal(summary.crsLabel, 'EPSG:32635');
    assert.deepEqual(summary.offModel, [{ row: 5, name: 'P4', distance: 'more than 2 m' }]);
    assert.deepEqual(summary.unticked, []);
    assert.deepEqual(summary.skipped, [{ row: 6, name: 'P5', reason: 'Easting is empty' }]);
    assert.equal(summary.warnings[0], 'A binding warning.');
    // One line for every point beyond the 0.10 m warning (row 3, 0.05 m, is within it).
    assert.ok(summary.warnings.includes('2 points lie more than 0.1 m from the surface (largest 0.400 m): rows 2, 4.'));
    assert.ok(summary.warnings.some(w => w.startsWith('Labels are hidden in group "site (2)"')));
    const text = SI.surveySummaryText(summary);
    for (const line of ['Survey import: site.csv', 'Alignment: Trench 3 (EPSG:32635)', 'Group: site (2)',
        'Distance limit: 0.5 m', 'Imported: 3 points', 'Not imported, off the model: 1', 'Skipped: 1',
        '  Row 5  P4  more than 2 m', '  Row 6  P5  Easting is empty', '  A binding warning.']) {
        assert.ok(text.split('\n').includes(line), `missing line: ${line}`);
    }

    // Export and read back into an empty session: the same survey block, lock and group flags.
    const file = JSON.parse(buildAnnotationJSON());
    setSession();
    mergeW3CCollection(clone(file));
    const back = byUuid(p1.uuid);
    assert.equal(back.locked, true);
    assert.equal(back.survey.alignmentId, state.alignments[0].id);
    assert.deepEqual({ ...back.survey, alignmentId: null }, { ...p1.survey, alignmentId: null });
    assert.deepEqual(byUuid(p2.uuid).survey.attributes, p2.survey.attributes);
    const g = state.groups.find(x => x.uuid === result.group.uuid);
    assert.equal(g.collapsed, true);
    assert.equal(g.labelsVisible, false);
});

test('duplicate rules: same file and row, or same name within 1 mm, skipped; a name in use imported and flagged', () => {
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    const s1 = { e: 511999, n: 4122999, h: 58.3 };
    const s7 = { e: 512001, n: 4123001, h: 58.2 };
    const fromFile = surveyAnnotation({ id: 1, uuid: 'e1', alignment: a, s: s1, name: 'P1' });
    fromFile.survey.source = { fileName: 'site.csv', fileSha256: 'feed', row: 2, importedAt: T1 };
    const gcp7 = surveyAnnotation({ id: 2, uuid: 'e2', alignment: a, s: s7, name: 'GCP7' });
    const plain = { id: 3, uuid: 'e3', type: 'point', name: 'Well', groupId: 1, points: [{ x: 0, y: 0, z: 0 }], entries: [] };
    const annotations = [fromFile, gcp7, plain];

    const records = [
        rec(2, 'P1 renamed', 511999.2, 4122999, 58.3),        // same file and row as e1
        rec(3, 'GCP7', s7.e + 0.0005, s7.n, s7.h),             // same name, 0.5 mm away
        rec(4, 'GCP7', s7.e + 1, s7.n, s7.h),                  // same name, 1 m away
        rec(5, 'Well', 512000, 4123000, 58),                   // name of a hand-made annotation
        rec(6, 'Q', 512002, 4123002, 58),
        rec(7, 'Q', 512002.0004, 4123002, 58),                 // repeats row 6 within 1 mm
        rec(8, 'Q', 512004, 4123002, 58)                       // same name as row 6, 2 m away
    ];
    const selected = records.map((record, index) => ({ index, record }));
    const plan = SI.planSurveyCreation(selected, { fileName: 'site.csv', alignmentId: a.id, fileSha256: 'feed', annotations });
    assert.deepEqual(plan.create.map(x => x.record.row), [4, 5, 6, 8]);
    assert.deepEqual(plan.duplicates.map(x => [x.record.row, x.reason, x.message]), [
        [2, 'SAME_ROW', 'already imported from this file'],
        [3, 'SAME_NAME_POSITION', 'same name and position as an existing point'],
        [7, 'SAME_NAME_POSITION', 'same name and position as row 6']
    ]);
    assert.deepEqual(plan.nameConflicts.map(x => [x.record.row, x.reason]), [[4, 'SAME_NAME'], [5, 'SAME_NAME_OTHER'], [8, 'SAME_NAME']]);
    assert.equal(plan.nameConflicts[0].message, 'Row 4: the name "GCP7" is already used by a point of this alignment at other coordinates.');
    assert.equal(plan.nameConflicts[1].message, 'Row 5: the name "Well" is already used by another annotation.');
    assert.equal(plan.nameConflicts[2].message, 'Row 8: the name "Q" is also used by row 6, at other coordinates.');

    // Without a file hash (no crypto.subtle) only the name rule finds duplicates.
    const noHash = SI.planSurveyCreation(selected, { fileName: 'site.csv', alignmentId: a.id, fileSha256: null, annotations });
    assert.equal(noHash.create[0].record.row, 2);
    // Another alignment: its points are not duplicates, their names are flagged
    // (row 4 meets row 3 of the same batch first, 1 m away).
    const other = SI.planSurveyCreation(selected.slice(0, 3), { fileName: 'site.csv', alignmentId: 999, fileSha256: 'feed', annotations });
    assert.deepEqual(other.create.map(x => x.record.row), [2, 3, 4]);
    assert.deepEqual(other.nameConflicts.map(x => [x.record.row, x.reason]), [[3, 'SAME_NAME_OTHER'], [4, 'SAME_NAME']]);
});

test('committing into an existing group, an empty plan, and a group that no longer exists', () => {
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    setSession({ groups: [group(1, 'g1', 'Default', { labelsVisible: true })], annotations: [], alignments: [a] });
    const records = [rec(2, 'A', 512000, 4123000, 58), rec(3, 'B', 512001, 4123000, 58), rec(4, 'C', 512002, 4123000, 58)];
    const plan = SI.planSurveyCreation(records.map((record, index) => ({ index, record })), { fileName: 'f.csv', alignmentId: a.id });
    const placements = records.map((r, index) => ({ index, point: { x: index, y: 0, z: 0 }, surfaceDistance: 0.01 }));
    const base = { plan, placements, alignmentId: a.id, fileName: 'f.csv', importedAt: T3 };

    // Existing group: the points go there; its labels (also those of annotations
    // the import did not make) are left alone, the summary only mentions them.
    const r1 = SI.commitSurveyImport({ ...base, group: { kind: 'existing', groupId: 1 }, labelsOffAbove: 2 });
    assert.equal(r1.groupCreated, false);
    assert.equal(r1.labelsCrowded, true);
    assert.equal(state.groups[0].labelsVisible, true);
    assert.equal(state.groups.length, 1);
    assert.ok(r1.created.every(x => x.groupId === 1 && x.locked === true));
    assert.equal('collapsed' in state.groups[0], false);      // an existing group's collapse state is left alone

    // Nothing to create: no group either.
    const empty = SI.commitSurveyImport({ ...base, plan: { create: [], duplicates: [], nameConflicts: [] }, group: { kind: 'new', name: 'f' } });
    assert.deepEqual(empty, { created: [], group: null, groupCreated: false, labelsCrowded: false });
    assert.equal(state.groups.length, 1);

    // The chosen group was deleted meanwhile: a new group named after the file.
    const r2 = SI.commitSurveyImport({ ...base, group: { kind: 'existing', groupId: 42 } });
    assert.equal(r2.groupCreated, true);
    assert.equal(r2.group.name, 'f');
    assert.equal(r2.group.labelsVisible, true);
    assert.equal(state.annotations.length, 6);

    // A missing placement throws before anything is added.
    assert.throws(() => SI.commitSurveyImport({ ...base, placements: placements.slice(1), group: { kind: 'new', name: 'g' } }), RangeError);
    assert.equal(state.groups.length, 2);
    assert.equal(state.annotations.length, 6);
});

test('the summary: duplicates merged into Skipped in row order, name warnings, rows outside the model box', () => {
    const a = makeAlignment({ id: 101, uuid: UA, now: T1 });
    a.name = '';
    setSession({ groups: [group(1, 'g1', 'Default', { labelsVisible: true })], annotations: [], alignments: [a] });
    const records = [
        rec(2, 'Q', 512000, 4123000, 58),
        rec(3, 'Q', 512000.0004, 4123000, 58),     // repeats row 2 within 1 mm: skipped
        rec(5, 'Q', 512003, 4123000, 58),          // same name as row 2, 3 m away: imported and flagged
        rec(6, 'R', 512010, 4123000, 58),          // 1.5 m outside the model box, imported with 'Import all'
        rec(7, 'S', 512020, 4123000, 58)           // off the model, not chosen
    ];
    const jobSkipped = [{ row: 4, name: 'Bad', message: 'Easting is empty' }];
    // No surface query: the bounding box decides (classifyByDistance BOX rows).
    const boxRow = (index, boxDistance, onModel) => ({ index, record: records[index], distance: null, boxDistance, method: AL.SELECTION_METHODS.BOX, onModel, ticked: onModel });
    const classification = {
        rows: [boxRow(0, 0, true), boxRow(1, 0, true), boxRow(2, 0.05, true), boxRow(3, 1.5, false), boxRow(4, 9, false)],
        onModelCount: 3, total: 5, limit: 0.5
    };
    const ticked = [0, 1, 2, 3];
    const plan = SI.planSurveyCreation(ticked.map(index => ({ index, record: records[index] })),
        { fileName: 'f.csv', alignmentId: a.id, fileSha256: 'feed', annotations: state.annotations });
    const placements = plan.create.map(c => ({ index: c.index, point: { x: c.index, y: 0, z: 0 }, surfaceDistance: null }));
    const result = SI.commitSurveyImport({ plan, placements, alignmentId: a.id, fileName: 'f.csv', fileSha256: 'feed', group: { kind: 'existing', groupId: 1 }, labelsOffAbove: 2, importedAt: T3 });
    const summary = SI.surveyImportSummary({
        job: { file: { name: 'f.csv' }, skipped: jobSkipped }, alignment: a, classification, ticked, plan, result,
        measurement: { measured: false, searchRadius: 2 }, limit: 0.5, surfaceWarn: 0.1, labelsOffAbove: 2
    });
    assert.equal(summary.alignmentName, 'Unnamed alignment');
    assert.equal(summary.imported, 3);
    assert.deepEqual(summary.skipped, [
        { row: 3, name: 'Q', reason: 'same name and position as row 2' },
        { row: 4, name: 'Bad', reason: 'Easting is empty' }
    ]);
    assert.deepEqual(summary.offModel, [{ row: 7, name: 'S', distance: '9.000 m from the model box' }]);
    assert.deepEqual(summary.unticked, []);
    // Every row is accounted for once.
    assert.equal(summary.imported + summary.offModel.length + summary.unticked.length + summary.skipped.length,
        records.length + jobSkipped.length);
    assert.ok(summary.warnings.includes('Row 5: the name "Q" is also used by row 2, at other coordinates.'));
    assert.ok(summary.warnings.some(w => w.startsWith('The model has no surface query (BVH)')));
    // Row 5 (0.05 m) is within the warning distance; row 6, chosen by 'Import all', is flagged.
    assert.ok(summary.warnings.includes('1 point lies more than 0.1 m outside the model bounding box (largest 1.500 m): row 6.'));
    assert.ok(summary.warnings.includes('Group "Default" shows labels and received more than 2 points. Labels can be turned off in the group settings.'));
    assert.ok(SI.surveySummaryText(summary).split('\n').includes('Alignment: Unnamed alignment (EPSG:32635)'));
});

test('import jobs: Swap rebuilds the records, remembered mappings are checked against the file', async () => {
    const { parsed, mapping, valid, skipped } = siteRecords();
    const job = {
        file: { name: 'site.csv', size: SITE_CSV.length, sha256: null }, parsed, decimal: parsed.decimal,
        preset: 'auto', mapping, records: valid, skipped, codeColumn: 'Code', heightColumn: 'Elevation'
    };
    const swapped = SI.jobWithMapping(job, swapMappingEN(mapping));
    assert.equal(swapped.preset, 'custom');
    assert.deepEqual([swapped.records[0].e, swapped.records[0].n], [valid[0].n, valid[0].e]);
    assert.deepEqual(swapped.records[0].columns, { e: 'Northing', n: 'Easting', h: 'Elevation' });
    assert.deepEqual(swapped.skipped.map(s => s.row), [6]);
    assert.equal(swapped.codeColumn, 'Code');
    assert.equal(swapped.heightColumn, 'Elevation');
    assert.equal(job.mapping, mapping);     // the input job is unchanged
    assert.equal(SI.jobWithMapping(job, { ...mapping, code: null }).codeColumn, null);

    const n = parsed.headers.length;     // 8
    assert.deepEqual(SI.sanitizeMapping({ ...mapping, extras: [6, 6, 2, 99, -1] }, n), { ...mapping, extras: [6] });
    assert.equal(SI.sanitizeMapping({ ...mapping, height: 12 }, n), null);
    assert.equal(SI.sanitizeMapping({ ...mapping, easting: '2' }, n), null);
    assert.deepEqual(SI.sanitizeMapping({ easting: 2, northing: 3, height: 4 }, n),
        { name: null, easting: 2, northing: 3, height: 4, description: null, code: null, extras: [] });
    assert.equal(SI.sanitizeMapping(null, n), null);

    // SHA-256 of the bytes, as lowercase hex.
    assert.equal(await SI.sha256Hex(new TextEncoder().encode('abc')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

    // Distances in the selection list.
    const surfaceRow = { method: 'surface', distance: -0.0234 };
    assert.equal(SI.selectionDistanceText(surfaceRow, { searchRadius: 2 }), '0.023 m');
    assert.equal(SI.selectionDistanceText({ method: 'surface', distance: Infinity }, { searchRadius: 4 }), 'more than 4 m');
    assert.equal(SI.selectionDistanceText({ method: 'box', boxDistance: 0.4 }, {}), '0.400 m from the model box');
    assert.equal(SI.selectionDistanceText({ method: 'box', boxDistance: 0 }, {}), 'inside the model box');
    assert.equal(SI.selectionDistanceText({ method: 'none' }, {}), 'not measured');
    assert.equal(SI.metresShort(0.5), '0.5 m');
    assert.equal(SI.metresShort(0.125), '0.125 m');
});
