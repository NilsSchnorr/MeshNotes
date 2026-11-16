// js/annotation-tools/face-order.js - Face numbers of surface regions in file order
//
// A surface region stores its triangles as "m_t": mesh m of the loaded model
// (state.modelMeshes), triangle t of that mesh in the order the model file
// lists its faces (annotation format: selector spec section 5, erratum of
// 2026-11-16). MeshNotes builds its BVH with `indirect: true` (BVH_OPTIONS), so
// the index buffer keeps that order and raycasts and brush shapecasts report
// file triangles.
//
// MeshNotes before 1.6.6 built the BVH in place, which sorts the index buffer,
// and counted triangles in that sorted buffer ("legacy" order). Where no BVH
// was built (models over 5M faces in 1.0 and 1.1, failed builds up to 1.4.1)
// it counted in file order. Files without modelSource meshnotes:faceOrder
// "file" can therefore hold either, region by region; normalizeSurfaceFaces()
// reads each region both ways and keeps the reading whose triangles lie at the
// stored centroid.
//
// The legacy order is reproduced exactly: the in-place and the indirect build
// of three-mesh-bvh 0.8.x run the same partition on the same triangle bounds,
// so the indirect table maps legacy position j to file triangle
// resolveTriangleIndex(j). A geometry that had groups at build time (an OBJ
// with several materials in one object) was built with one root per group,
// which the indirect build does not do; its legacy order comes from a
// temporary in-place build of a copy (legacyTableFromGroups()).
// tests/face-order.test.js guards both against the vendored library.

import * as THREE from 'three';
import { computeBoundsTree } from 'three-mesh-bvh';
import { state } from '../state.js';
import { toStorageCoords } from '../utils/helpers.js';

/** Options of every model BVH build (model-loader.js). */
export const BVH_OPTIONS = Object.freeze({ indirect: true });

/** Value of modelSource meshnotes:faceOrder for face numbers in file order. */
export const FACE_ORDER_FILE = 'file';

/** Results of normalizeSurfaceFaces(). */
export const FACE_ORDER = Object.freeze({
    FILE: 'file',            // already in file order (declared or checked)
    CONVERTED: 'converted',  // renumbered from the legacy order
    UNCHECKED: 'unchecked'   // could not be decided; numbers kept as read
});

// A reading wins only when its RMS distance to the centroid is at most this
// share of the other reading's.
const DECISION_RATIO = 0.5;

// Geometries that had groups when their BVH was built (filled by model-loader.js).
const _builtWithGroups = new WeakSet();
// Legacy tables built from a temporary build, per geometry.
const _legacyTables = new WeakMap();

/**
 * Records that a geometry had groups at its BVH build. Call right before
 * computeBoundsTree(BVH_OPTIONS); groups added afterwards (draw chunks) do not
 * count.
 * @param {THREE.BufferGeometry} geometry
 */
export function noteBuildGroups(geometry) {
    if (geometry && geometry.groups && geometry.groups.length > 0) _builtWithGroups.add(geometry);
}

/**
 * Parses a face id "m_t" into { mesh, tri }; null when it is not two
 * non-negative integers.
 * @param {*} id
 * @returns {{mesh: number, tri: number}|null}
 */
export function parseFaceId(id) {
    if (typeof id !== 'string') return null;
    const m = /^(\d+)_(\d+)$/.exec(id);
    if (!m) return null;
    return { mesh: Number(m[1]), tri: Number(m[2]) };
}

// Root mean square distance of points to a centre.
function rmsDistance(points, c) {
    let sum = 0;
    for (const p of points) {
        const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
        sum += dx * dx + dy * dy + dz * dz;
    }
    return Math.sqrt(sum / points.length);
}

/**
 * Decides in which order a region's face numbers were written. Pure.
 * @param {Array<{mesh: number, tri: number}>} faces
 * @param {{x: number, y: number, z: number}} centroid - the stored centroid
 * @param {{centre: Function, legacy: Function}} resolve
 *   centre(mesh, tri): centre of file triangle tri, in the centroid's frame,
 *   or null when the mesh has no such triangle;
 *   legacy(mesh, tri): the file triangle at legacy position tri, or null
 *   when there is none.
 * @returns {'file'|'legacy'|null} null when neither reading is clearly closer
 */
export function chooseFaceOrder(faces, centroid, resolve) {
    if (!Array.isArray(faces) || faces.length === 0 || !centroid) return null;
    const legacyTris = faces.map(f => resolve.legacy(f.mesh, f.tri));
    // Both readings name the same triangles (in any order): nothing to decide.
    const fileSet = new Set(faces.map(f => `${f.mesh}_${f.tri}`));
    if (legacyTris.every((t, i) => t !== null && fileSet.has(`${faces[i].mesh}_${t}`))) return 'file';

    const fileCentres = faces.map(f => resolve.centre(f.mesh, f.tri));
    const legacyCentres = legacyTris.map((t, i) => (t === null ? null : resolve.centre(faces[i].mesh, t)));
    const fileOk = fileCentres.every(Boolean);
    const legacyOk = legacyCentres.every(Boolean);
    if (fileOk && !legacyOk) return 'file';
    if (legacyOk && !fileOk) return 'legacy';
    if (!fileOk && !legacyOk) return null;

    const rmsFile = rmsDistance(fileCentres, centroid);
    const rmsLegacy = rmsDistance(legacyCentres, centroid);
    if (rmsFile <= rmsLegacy * DECISION_RATIO) return 'file';
    if (rmsLegacy <= rmsFile * DECISION_RATIO) return 'legacy';
    return null;
}

// Number of triangles of a geometry.
function triangleCount(geometry) {
    const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    return Math.floor(count / 3);
}

/**
 * Legacy order of a geometry that had groups at its build: a temporary
 * in-place build (the default options MeshNotes used before 1.6.6) of a copy
 * that shares the positions and the groups. Only geometry without an index
 * is supported (the OBJ loader writes none); then legacy position j holds the
 * corners 3t, 3t+1, 3t+2 of file triangle t. null otherwise.
 * @param {THREE.BufferGeometry} geometry
 * @returns {Uint32Array|null} legacy position -> file triangle
 */
export function legacyTableFromGroups(geometry) {
    if (geometry.index) return null;
    const temp = new THREE.BufferGeometry();
    temp.setAttribute('position', geometry.attributes.position);
    for (const g of geometry.groups) temp.addGroup(g.start, g.count, g.materialIndex);
    computeBoundsTree.call(temp);   // sorts temp's generated index in place
    const index = temp.index.array;
    const table = new Uint32Array(index.length / 3);
    for (let j = 0; j < table.length; j++) table[j] = index[3 * j] / 3;
    // temp was never rendered, so nothing holds it; the shared position
    // attribute stays with the model. Not disposed on purpose: a dispose
    // event could reach renderer caches of the shared attribute.
    temp.boundsTree = null;
    return table;
}

/**
 * Maps legacy positions of one model mesh to file triangles, or null when this
 * device cannot reproduce the legacy order (no BVH on the mesh, or groups on
 * an indexed geometry).
 * @param {THREE.Mesh} mesh
 * @returns {((j: number) => number|null)|null}
 */
export function legacyResolver(mesh) {
    const geometry = mesh && mesh.geometry;
    if (!geometry || !geometry.attributes || !geometry.attributes.position) return null;
    const count = triangleCount(geometry);
    if (_builtWithGroups.has(geometry)) {
        let table = _legacyTables.get(geometry);
        if (table === undefined) {
            try { table = legacyTableFromGroups(geometry); } catch (e) { table = null; }
            _legacyTables.set(geometry, table);
        }
        if (!table) return null;
        return (j) => (j < table.length ? table[j] : null);
    }
    const bvh = geometry.boundsTree;
    if (!bvh || !bvh.indirect) return null;
    return (j) => (j < count ? bvh.resolveTriangleIndex(j) : null);
}

// Centre of file triangle t of a mesh in storage coordinates (the frame of a
// stored centroid), or null when the mesh has no such triangle.
function triangleCentre(mesh, t, out) {
    const geometry = mesh.geometry;
    if (t >= triangleCount(geometry)) return null;
    const pos = geometry.attributes.position;
    const index = geometry.index;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) {
        const v = index ? index.getX(3 * t + k) : 3 * t + k;
        out.fromBufferAttribute(pos, v);
        x += out.x; y += out.y; z += out.z;
    }
    out.set(x / 3, y / 3, z / 3).applyMatrix4(mesh.matrixWorld);
    return toStorageCoords(out);
}

/**
 * Brings a surface annotation's face numbers into file order. A file that
 * declares file order is left alone. Otherwise each region is read in file
 * and in legacy order and the reading whose triangles lie at the stored
 * centroid is kept; a legacy reading is renumbered. A region that cannot be
 * decided (no model, no BVH to reproduce the legacy order, no centroid, or no
 * clear winner) keeps its numbers and gets ann.faceOrderUnchecked (session
 * only; export then leaves the marker out, see exportFaceOrder()).
 * @param {Object} ann - internal annotation, points already in storage frame
 * @param {{declared?: boolean, meshes?: THREE.Mesh[]}} [options]
 * @returns {'file'|'converted'|'unchecked'} FACE_ORDER
 */
export function normalizeSurfaceFaces(ann, { declared = false, meshes = state.modelMeshes } = {}) {
    if (!ann) return FACE_ORDER.FILE;
    delete ann.faceOrderUnchecked;
    if (ann.type !== 'surface' || !Array.isArray(ann.faceData) || ann.faceData.length === 0) {
        return FACE_ORDER.FILE;
    }
    if (declared) return FACE_ORDER.FILE;

    const unchecked = () => { ann.faceOrderUnchecked = true; return FACE_ORDER.UNCHECKED; };
    const faces = ann.faceData.map(parseFaceId);
    const centroid = ann.points && ann.points[0];
    if (faces.some(f => !f) || !centroid || !meshes || meshes.length === 0) return unchecked();

    const resolvers = new Map();
    for (const f of faces) {
        if (resolvers.has(f.mesh)) continue;
        const mesh = meshes[f.mesh];
        const resolver = mesh ? legacyResolver(mesh) : null;
        if (!resolver) return unchecked();
        resolvers.set(f.mesh, resolver);
    }
    if (state.currentModel) state.currentModel.updateMatrixWorld(true);

    const scratch = new THREE.Vector3();
    const reading = chooseFaceOrder(faces, centroid, {
        centre: (m, t) => triangleCentre(meshes[m], t, scratch),
        legacy: (m, t) => resolvers.get(m)(t)
    });
    if (reading === 'file') return FACE_ORDER.FILE;
    if (reading !== 'legacy') return unchecked();
    ann.faceData = faces.map(f => `${f.mesh}_${resolvers.get(f.mesh)(f.tri)}`);
    return FACE_ORDER.CONVERTED;
}

/**
 * modelSource meshnotes:faceOrder for an export: "file" when the session holds
 * a surface region and every region is in file order, undefined otherwise
 * (no region, or one that could not be checked).
 * @param {Object[]} annotations
 * @returns {'file'|undefined}
 */
export function exportFaceOrder(annotations) {
    const surfaces = (annotations || []).filter(a => a && a.type === 'surface' && Array.isArray(a.faceData) && a.faceData.length > 0);
    if (surfaces.length === 0 || surfaces.some(a => a.faceOrderUnchecked)) return undefined;
    return FACE_ORDER_FILE;
}
