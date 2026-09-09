// js/annotation-tools/projection.js
import * as THREE from 'three';
import { state } from '../state.js';
import { showStatus, flipTransform } from '../utils/helpers.js';

// ---- Projection quality tuning ---------------------------------------------
// Sampling density and OUTPUT density are two separate budgets and must not be
// conflated. Sampling density controls how faithfully the closest-point walk
// follows the surface — it is paid once, in BVH queries, when an annotation is
// edited. Output density controls how many vertices land in the Line2 geometry,
// and is paid on every renderAnnotations() call, including once per pointermove
// while a point is being dragged. We therefore sample finely and emit coarsely.

// Target spacing between samples along an edge, as a fraction of the model's
// bounding size. 0.004 ≈ 250 samples across the full extent of the object.
const SAMPLE_SPACING_RELATIVE = 0.004;

// Never fewer than this many segments, however short the edge.
const MIN_SEGMENTS = 8;

// Hard ceiling on samples per edge, so a line spanning a whole large model
// cannot blow up the BVH query count.
const MAX_SEGMENTS = 256;

// Hard ceiling on emitted points per edge (see the two-budget note above).
const MAX_OUTPUT_POINTS = 64;

// Laplacian smoothing passes over the raw projected polyline. Two is enough to
// remove per-triangle jitter without visibly shrinking the curve.
const SMOOTHING_ROUNDS = 2;

// ---- Module scratch ---------------------------------------------------------
// getFaceWorldNormal runs once per sample; at up to 256 samples per edge, the
// old per-call allocation of six Vector3 plus a Matrix3 was real GC pressure.
// These are reused across every call and must never be held onto by callers.
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _edge1 = new THREE.Vector3();
const _edge2 = new THREE.Vector3();

// closestPointToPoint writes into (and returns) this target. Reused across every
// sample; callers must copy out of it before the next query.
const _hitTarget = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const _scratchNormalMatrix = new THREE.Matrix3();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();

/**
 * Write the world-space face normal for a given face index into `target`.
 * Works with both indexed and non-indexed geometry.
 *
 * `normalMatrix` is supplied by the caller because mesh.matrixWorld is constant
 * for the duration of a projection call — deriving it per sample was pure waste.
 *
 * Note: deliberately kept separate from surface-paint.js's _computeLocalFaceNormal.
 * This returns a WORLD-space normal; the surface-paint variant stays in LOCAL
 * space for its per-face paint hot path. They are not interchangeable; do not
 * merge them.
 */
function getFaceWorldNormal(mesh, faceIndex, normalMatrix, target) {
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute('position');
    const index = geo.index;

    if (index) {
        _vA.fromBufferAttribute(posAttr, index.getX(faceIndex * 3));
        _vB.fromBufferAttribute(posAttr, index.getX(faceIndex * 3 + 1));
        _vC.fromBufferAttribute(posAttr, index.getX(faceIndex * 3 + 2));
    } else {
        _vA.fromBufferAttribute(posAttr, faceIndex * 3);
        _vB.fromBufferAttribute(posAttr, faceIndex * 3 + 1);
        _vC.fromBufferAttribute(posAttr, faceIndex * 3 + 2);
    }

    _edge1.subVectors(_vB, _vA);
    _edge2.subVectors(_vC, _vA);
    target.crossVectors(_edge1, _edge2).normalize();
    target.applyMatrix3(normalMatrix).normalize();

    return target;
}

// ---- Per-call mesh contexts -------------------------------------------------
// The inverse world matrix and normal matrix of each BVH-bearing mesh, derived
// once per projection call rather than once per sample. Entries are pooled.

const _meshContexts = [];
let _meshContextCount = 0;

function buildMeshContexts() {
    _meshContextCount = 0;
    for (const mesh of state.modelMeshes) {
        if (!mesh.geometry || !mesh.geometry.boundsTree) continue;

        let ctx = _meshContexts[_meshContextCount];
        if (!ctx) {
            ctx = {
                mesh: null,
                invMatrix: new THREE.Matrix4(),
                normalMatrix: new THREE.Matrix3()
            };
            _meshContexts[_meshContextCount] = ctx;
        }
        ctx.mesh = mesh;
        ctx.invMatrix.copy(mesh.matrixWorld).invert();
        ctx.normalMatrix.getNormalMatrix(mesh.matrixWorld);
        _meshContextCount++;
    }
    return _meshContextCount;
}

/**
 * Find the face normal at the closest surface point to a given world-space
 * position. Returns null if no BVH-accelerated mesh is available.
 * Assumes buildMeshContexts() has already run for this call.
 */
function getClosestSurfaceNormal(worldPoint) {
    const localPoint = new THREE.Vector3();
    let bestDistance = Infinity;
    let bestCtx = null;
    let bestFaceIndex = -1;

    for (let m = 0; m < _meshContextCount; m++) {
        const ctx = _meshContexts[m];
        localPoint.copy(worldPoint).applyMatrix4(ctx.invMatrix);

        const result = ctx.mesh.geometry.boundsTree.closestPointToPoint(localPoint, _hitTarget);

        if (result && result.distance < bestDistance) {
            bestDistance = result.distance;
            bestCtx = ctx;
            bestFaceIndex = result.faceIndex;
        }
    }

    if (!bestCtx) return null;
    return getFaceWorldNormal(bestCtx.mesh, bestFaceIndex, bestCtx.normalMatrix, new THREE.Vector3());
}

/**
 * Resolve how many segments to sample an edge with.
 *
 * An explicit count from the caller wins outright — that is how the interactive
 * tiers (the drawing preview and the live drag re-projection) keep their fixed,
 * deliberately cheap budgets.
 *
 * Otherwise the count is derived from arc length so that density is a property
 * of the edge, not of the call site. A fixed count meant a 2 m edge and a 2 cm
 * edge got the same 30 samples: far too coarse on one, wasteful on the other.
 * The spacing is floored at the mesh's own mean triangle edge (≈ boundingSize /
 * sqrt(faceCount)), because sampling below the resolution of the geometry only
 * traces its facets and its noise.
 */
function resolveSegmentCount(chordLength, explicit) {
    if (typeof explicit === 'number' && isFinite(explicit) && explicit > 0) {
        return Math.max(1, Math.round(explicit));
    }

    const modelSize = state.modelBoundingSize || 1;
    let spacing = modelSize * SAMPLE_SPACING_RELATIVE;

    const faces = state.modelFaceCount || 0;
    if (faces > 0) {
        const meanTriangleEdge = modelSize / Math.sqrt(faces);
        if (meanTriangleEdge > spacing) spacing = meanTriangleEdge;
    }

    if (!(spacing > 0)) return MIN_SEGMENTS;

    const n = Math.round(chordLength / spacing);
    return Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, n));
}

/**
 * In-place Laplacian smoothing of a projected polyline, constrained to the
 * surface by a tangent-plane snap.
 *
 * Corner-cutting (Chaikin) would have been the obvious choice but it multiplies
 * the point count and every new point needs its own closestPointToPoint. Moving
 * the existing points instead keeps the count fixed, and pushing each smoothed
 * point back onto the plane of the face it was projected onto keeps it on the
 * surface to first order — which is all that is needed, since no point travels
 * more than a fraction of a triangle. Cost: pure arithmetic, no BVH queries.
 *
 * Endpoints are held fixed. They are the projections of the user's own placed
 * vertices, and adjacent edges share them; letting them drift would open gaps
 * between edges and pull the polyline away from its vertex markers.
 *
 * @param {Array<{x,y,z}>} points - modified in place.
 * @param {Float32Array} normals - flat xyz per point, surface normal at each sample.
 * @param {Uint8Array} normalValid - 1 where the matching normal is usable.
 */
function smoothOnSurface(points, normals, normalValid) {
    const n = points.length;
    if (n < 3) return;

    const buf = new Float64Array(n * 3);

    for (let round = 0; round < SMOOTHING_ROUNDS; round++) {
        for (let i = 1; i < n - 1; i++) {
            const prev = points[i - 1];
            const cur = points[i];
            const next = points[i + 1];

            // [1, 2, 1] / 4 — a mild λ = 0.5 Laplacian.
            let sx = (prev.x + 2 * cur.x + next.x) * 0.25;
            let sy = (prev.y + 2 * cur.y + next.y) * 0.25;
            let sz = (prev.z + 2 * cur.z + next.z) * 0.25;

            if (normalValid[i]) {
                const nx = normals[i * 3];
                const ny = normals[i * 3 + 1];
                const nz = normals[i * 3 + 2];
                // Remove the component of the displacement along the normal, so
                // the point slides across the surface instead of sinking into it.
                const d = (sx - cur.x) * nx + (sy - cur.y) * ny + (sz - cur.z) * nz;
                sx -= nx * d;
                sy -= ny * d;
                sz -= nz * d;
            }

            buf[i * 3] = sx;
            buf[i * 3 + 1] = sy;
            buf[i * 3 + 2] = sz;
        }

        for (let i = 1; i < n - 1; i++) {
            points[i].x = buf[i * 3];
            points[i].y = buf[i * 3 + 1];
            points[i].z = buf[i * 3 + 2];
        }
    }
}

/**
 * Re-space a polyline evenly by arc length, optionally reducing its point count.
 *
 * Sampling uniformly in t along the straight chord does not map to uniform
 * spacing on the surface: points bunch where the surface runs close to the chord
 * and stretch where it bulges away. Re-spacing fixes that, and capping the
 * output count is what keeps the denser sampling from reaching the render path.
 *
 * Never upsamples — a coarse interactive tier stays coarse.
 */
function resampleByArcLength(points, maxOutputPoints) {
    const n = points.length;
    if (n < 3) return points;

    const targetCount = Math.min(maxOutputPoints, n);
    if (targetCount < 2) return points;

    const cumulative = new Float64Array(n);
    for (let i = 1; i < n; i++) {
        const a = points[i - 1];
        const b = points[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        cumulative[i] = cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const total = cumulative[n - 1];
    if (!(total > 0)) return points;

    const out = new Array(targetCount);
    out[0] = points[0];
    out[targetCount - 1] = points[n - 1];

    let seg = 1;
    for (let k = 1; k < targetCount - 1; k++) {
        const distanceAlong = total * k / (targetCount - 1);
        while (seg < n - 1 && cumulative[seg] < distanceAlong) seg++;

        const l0 = cumulative[seg - 1];
        const l1 = cumulative[seg];
        const span = l1 - l0;
        const t = span > 0 ? (distanceAlong - l0) / span : 0;

        const a = points[seg - 1];
        const b = points[seg];
        out[k] = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t
        };
    }

    return out;
}

/**
 * Project the edge A→B onto the model surface.
 *
 * @param {THREE.Vector3} pointA
 * @param {THREE.Vector3} pointB
 * @param {number|null} segments - explicit sample count for the interactive
 *        tiers; null/omitted selects an arc-length-adaptive count.
 * @returns {Array<{x,y,z}>|null}
 */
export function projectEdgeToSurface(pointA, pointB, segments = null) {
    if (state.modelMeshes.length === 0) return null;
    if (buildMeshContexts() === 0) return null;

    const chordLength = pointA.distanceTo(pointB);
    const sampleCount = resolveSegmentCount(chordLength, segments);

    const projectedPoints = [];
    const sampleNormals = new Float32Array((sampleCount + 1) * 3);
    const sampleNormalValid = new Uint8Array(sampleCount + 1);

    const tempPoint = new THREE.Vector3();
    const localPoint = new THREE.Vector3();
    const bestPoint = new THREE.Vector3();
    const bestFaceNormal = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();
    const hitNormal = new THREE.Vector3();

    // Reference normals at the endpoints, for normal-consistency filtering.
    // This prevents projection from "jumping" to the opposite side of thin-walled
    // geometry (e.g. inside of a vase when annotating the outside).
    const refNormalA = getClosestSurfaceNormal(pointA);
    const refNormalB = getClosestSurfaceNormal(pointB);
    const hasRefNormals = (refNormalA !== null && refNormalB !== null);
    const interpolatedNormal = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const rayOffset = (state.modelBoundingSize || 1) * 0.1;

    for (let i = 0; i <= sampleCount; i++) {
        const t = i / sampleCount;
        tempPoint.lerpVectors(pointA, pointB, t);

        let bestDistance = Infinity;
        let haveBest = false;

        for (let m = 0; m < _meshContextCount; m++) {
            const ctx = _meshContexts[m];
            localPoint.copy(tempPoint).applyMatrix4(ctx.invMatrix);

            const result = ctx.mesh.geometry.boundsTree.closestPointToPoint(localPoint, _hitTarget);

            if (result && result.distance < bestDistance) {
                bestDistance = result.distance;
                bestPoint.copy(result.point).applyMatrix4(ctx.mesh.matrixWorld);
                getFaceWorldNormal(ctx.mesh, result.faceIndex, ctx.normalMatrix, bestFaceNormal);
                haveBest = true;
            }
        }

        let haveNormal = haveBest;

        // Normal consistency check: reject points projected onto the wrong surface
        if (haveBest && hasRefNormals) {
            interpolatedNormal.lerpVectors(refNormalA, refNormalB, t).normalize();

            if (bestFaceNormal.dot(interpolatedNormal) < 0) {
                // The closest point is on the opposite-facing surface.
                // Raycast from above the correct surface to find the right one.
                _rayOrigin.copy(tempPoint).addScaledVector(interpolatedNormal, rayOffset);
                _rayDir.copy(interpolatedNormal).negate();
                raycaster.set(_rayOrigin, _rayDir);

                let foundFallback = false;
                for (const mesh of state.modelMeshes) {
                    const hits = raycaster.intersectObject(mesh);
                    if (hits.length > 0) {
                        // Use the first hit whose normal is consistent
                        _scratchNormalMatrix.getNormalMatrix(mesh.matrixWorld);
                        for (const hit of hits) {
                            getFaceWorldNormal(mesh, hit.faceIndex, _scratchNormalMatrix, faceNormal);
                            if (faceNormal.dot(interpolatedNormal) >= 0) {
                                bestPoint.copy(hit.point);
                                hitNormal.copy(faceNormal);
                                foundFallback = true;
                                break;
                            }
                        }
                        if (foundFallback) break;
                    }
                }

                if (foundFallback) {
                    bestFaceNormal.copy(hitNormal);
                } else {
                    // null → linear interpolation fallback
                    haveBest = false;
                    haveNormal = false;
                }
            }
        }

        if (haveBest) {
            projectedPoints.push({ x: bestPoint.x, y: bestPoint.y, z: bestPoint.z });
        } else {
            projectedPoints.push({ x: tempPoint.x, y: tempPoint.y, z: tempPoint.z });
        }

        if (haveNormal) {
            sampleNormals[i * 3] = bestFaceNormal.x;
            sampleNormals[i * 3 + 1] = bestFaceNormal.y;
            sampleNormals[i * 3 + 2] = bestFaceNormal.z;
            sampleNormalValid[i] = 1;
        }
    }

    smoothOnSurface(projectedPoints, sampleNormals, sampleNormalValid);

    return resampleByArcLength(projectedPoints, MAX_OUTPUT_POINTS);
}

export function isProjectionAcceptable(projectedPoints, pointA, pointB) {
    const lineDir = new THREE.Vector3().subVectors(pointB, pointA);
    const lineLength = lineDir.length();
    if (lineLength < 1e-10) return true;
    lineDir.normalize();

    const relativeLimit = state.projectionDeviationRelative * lineLength;
    const absoluteLimit = state.projectionDeviationAbsolute * state.modelBoundingSize;
    const maxAllowed = Math.min(relativeLimit, absoluteLimit);

    const toPoint = new THREE.Vector3();
    const closestOnLine = new THREE.Vector3();

    for (const p of projectedPoints) {
        toPoint.set(p.x, p.y, p.z).sub(pointA);
        const t = Math.max(0, Math.min(lineLength, toPoint.dot(lineDir)));
        closestOnLine.copy(pointA).addScaledVector(lineDir, t);
        const deviation = closestOnLine.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
        if (deviation > maxAllowed) return false;
    }

    return true;
}

export function computeProjectedEdges(points, closePolygon = false, segments = null) {
    const edges = [];
    const vec3Points = points.map(p => new THREE.Vector3(p.x, p.y, p.z));

    for (let i = 0; i < vec3Points.length - 1; i++) {
        const projected = projectEdgeToSurface(vec3Points[i], vec3Points[i + 1], segments);
        if (projected && isProjectionAcceptable(projected, vec3Points[i], vec3Points[i + 1])) {
            edges.push(projected);
        } else {
            edges.push([points[i], points[i + 1]]);
        }
    }

    if (closePolygon && vec3Points.length > 2) {
        const lastEdge = projectEdgeToSurface(
            vec3Points[vec3Points.length - 1], vec3Points[0], segments
        );
        if (lastEdge && isProjectionAcceptable(lastEdge, vec3Points[vec3Points.length - 1], vec3Points[0])) {
            edges.push(lastEdge);
        } else {
            edges.push([points[points.length - 1], points[0]]);
        }
    }

    return edges;
}

export function recomputeAdjacentEdges(ann, pointIndex) {
    if (!ann.projectedEdges) return;
    const n = ann.points.length;
    const vec3Points = ann.points.map(p => new THREE.Vector3(p.x, p.y, p.z));

    const prevIdx = (ann.type === 'polygon')
        ? (pointIndex - 1 + n) % n
        : pointIndex - 1;
    if (prevIdx >= 0 && prevIdx < n) {
        const edgeIdx = prevIdx;
        if (edgeIdx < ann.projectedEdges.length) {
            const projected = projectEdgeToSurface(vec3Points[prevIdx], vec3Points[pointIndex], 15);
            if (projected && isProjectionAcceptable(projected, vec3Points[prevIdx], vec3Points[pointIndex])) {
                ann.projectedEdges[edgeIdx] = projected;
            } else {
                ann.projectedEdges[edgeIdx] = [ann.points[prevIdx], ann.points[pointIndex]];
            }
        }
    }

    const nextIdx = pointIndex + 1;
    if (nextIdx < n) {
        const edgeIdx = pointIndex;
        if (edgeIdx < ann.projectedEdges.length) {
            const projected = projectEdgeToSurface(vec3Points[pointIndex], vec3Points[nextIdx], 15);
            if (projected && isProjectionAcceptable(projected, vec3Points[pointIndex], vec3Points[nextIdx])) {
                ann.projectedEdges[edgeIdx] = projected;
            } else {
                ann.projectedEdges[edgeIdx] = [ann.points[pointIndex], ann.points[nextIdx]];
            }
        }
    } else if (ann.type === 'polygon' && pointIndex === n - 1) {
        const closingIdx = ann.projectedEdges.length - 1;
        const projected = projectEdgeToSurface(vec3Points[pointIndex], vec3Points[0], 15);
        if (projected && isProjectionAcceptable(projected, vec3Points[pointIndex], vec3Points[0])) {
            ann.projectedEdges[closingIdx] = projected;
        } else {
            ann.projectedEdges[closingIdx] = [ann.points[pointIndex], ann.points[0]];
        }
    }
}

// ============ Flip-Aware Projection Wrappers ============
// When the model is flipped, stored annotation points are in non-flipped space
// but the mesh's matrixWorld includes the flip. These wrappers convert points
// to display (world) space before projection, then convert results back to storage.

/**
 * Flip-aware wrapper for computeProjectedEdges.
 * Converts storage-space points to display space for projection math,
 * then converts results back to storage space.
 */
export function computeProjectedEdgesFlipAware(points, closePolygon = false, segments = null) {
    if (!state.isFlipped) {
        return computeProjectedEdges(points, closePolygon, segments);
    }
    const displayPoints = points.map(p => flipTransform(p));
    const edges = computeProjectedEdges(displayPoints, closePolygon, segments);
    return edges.map(edge => edge.map(p => flipTransform(p)));
}

/**
 * Flip-aware wrapper for recomputeAdjacentEdges.
 * Temporarily converts annotation data to display space, runs projection,
 * then converts everything back to storage space.
 */
export function recomputeAdjacentEdgesFlipAware(ann, pointIndex) {
    if (!state.isFlipped) {
        recomputeAdjacentEdges(ann, pointIndex);
        return;
    }
    // Temporarily convert points and existing edges to display (world) space
    const savedPoints = ann.points;
    ann.points = savedPoints.map(p => flipTransform(p));
    if (ann.projectedEdges) {
        ann.projectedEdges = ann.projectedEdges.map(edge => edge.map(p => flipTransform(p)));
    }

    recomputeAdjacentEdges(ann, pointIndex);

    // Restore original points, convert all edges back to storage space
    ann.points = savedPoints;
    if (ann.projectedEdges) {
        ann.projectedEdges = ann.projectedEdges.map(edge => edge.map(p => flipTransform(p)));
    }
}

// Late-bound reference to renderAnnotations (set from main.js to avoid circular deps)
let _renderAnnotations = null;
export function setRenderAnnotations(fn) {
    _renderAnnotations = fn;
}

export function reprojectAllAnnotations() {
    if (state.modelMeshes.length === 0 || !state.surfaceProjectionEnabled) return;

    let count = 0;
    state.annotations.forEach(ann => {
        if ((ann.type === 'line' || ann.type === 'polygon') && ann.points.length >= 2 && ann.surfaceProjection !== false) {
            ann.projectedEdges = computeProjectedEdgesFlipAware(ann.points, ann.type === 'polygon');
            ann.surfaceProjection = true;
            count++;
        }
    });

    if (count > 0) {
        if (_renderAnnotations) _renderAnnotations();
        showStatus(`Re-projected ${count} annotations onto surface`);
    }
}
