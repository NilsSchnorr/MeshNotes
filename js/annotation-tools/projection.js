// js/annotation-tools/projection.js
import * as THREE from 'three';
import { state } from '../state.js';
import { showStatus, flipTransform } from '../utils/helpers.js';

/**
 * Get the world-space face normal for a given face index on a mesh.
 * Works with both indexed and non-indexed geometry.
 *
 * Note: deliberately kept separate from surface-paint.js's _computeLocalFaceNormal.
 * This returns a WORLD-space normal (applies the mesh normal matrix) and allocates
 * per call — fine here, where it runs once per raycast hit. The surface-paint
 * variant stays in LOCAL space and is zero-allocation for its per-face paint hot
 * path. They are not interchangeable; do not merge them.
 */
function getFaceWorldNormal(mesh, faceIndex) {
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute('position');
    const index = geo.index;

    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();

    if (index) {
        vA.fromBufferAttribute(posAttr, index.getX(faceIndex * 3));
        vB.fromBufferAttribute(posAttr, index.getX(faceIndex * 3 + 1));
        vC.fromBufferAttribute(posAttr, index.getX(faceIndex * 3 + 2));
    } else {
        vA.fromBufferAttribute(posAttr, faceIndex * 3);
        vB.fromBufferAttribute(posAttr, faceIndex * 3 + 1);
        vC.fromBufferAttribute(posAttr, faceIndex * 3 + 2);
    }

    const edge1 = new THREE.Vector3().subVectors(vB, vA);
    const edge2 = new THREE.Vector3().subVectors(vC, vA);
    const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

    // Transform to world space
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    normal.applyMatrix3(normalMatrix).normalize();

    return normal;
}

/**
 * Find the face normal at the closest surface point to a given world-space position.
 * Returns null if no BVH-accelerated mesh is available.
 */
function getClosestSurfaceNormal(worldPoint) {
    const localPoint = new THREE.Vector3();
    const invMatrix = new THREE.Matrix4();
    let bestDistance = Infinity;
    let bestNormal = null;

    for (const mesh of state.modelMeshes) {
        if (!mesh.geometry.boundsTree) continue;

        invMatrix.copy(mesh.matrixWorld).invert();
        localPoint.copy(worldPoint).applyMatrix4(invMatrix);

        const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
        const result = mesh.geometry.boundsTree.closestPointToPoint(localPoint, target);

        if (result && result.distance < bestDistance) {
            bestDistance = result.distance;
            bestNormal = getFaceWorldNormal(mesh, result.faceIndex);
        }
    }

    return bestNormal;
}

export function projectEdgeToSurface(pointA, pointB, segments = 30) {
    if (state.modelMeshes.length === 0) return null;

    const projectedPoints = [];
    const tempPoint = new THREE.Vector3();
    const localPoint = new THREE.Vector3();
    const invMatrix = new THREE.Matrix4();

    // Get reference normals at the endpoints for normal-consistency filtering.
    // This prevents projection from "jumping" to the opposite side of thin-walled
    // geometry (e.g. inside of a vase when annotating the outside).
    const refNormalA = getClosestSurfaceNormal(pointA);
    const refNormalB = getClosestSurfaceNormal(pointB);
    const hasRefNormals = (refNormalA !== null && refNormalB !== null);
    const interpolatedNormal = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const rayOffset = (state.modelBoundingSize || 1) * 0.1;

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        tempPoint.lerpVectors(pointA, pointB, t);

        let bestDistance = Infinity;
        let bestPoint = null;
        let bestFaceNormal = null;

        for (const mesh of state.modelMeshes) {
            if (!mesh.geometry.boundsTree) continue;

            invMatrix.copy(mesh.matrixWorld).invert();
            localPoint.copy(tempPoint).applyMatrix4(invMatrix);

            const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
            const result = mesh.geometry.boundsTree.closestPointToPoint(localPoint, target);

            if (result && result.distance < bestDistance) {
                bestDistance = result.distance;
                bestPoint = result.point.clone().applyMatrix4(mesh.matrixWorld);
                bestFaceNormal = getFaceWorldNormal(mesh, result.faceIndex);
            }
        }

        // Normal consistency check: reject points projected onto the wrong surface
        if (bestPoint && hasRefNormals && bestFaceNormal) {
            interpolatedNormal.lerpVectors(refNormalA, refNormalB, t).normalize();

            if (bestFaceNormal.dot(interpolatedNormal) < 0) {
                // The closest point is on the opposite-facing surface.
                // Raycast from above the correct surface to find the right one.
                const rayOrigin = tempPoint.clone().addScaledVector(interpolatedNormal, rayOffset);
                const rayDir = interpolatedNormal.clone().negate();
                raycaster.set(rayOrigin, rayDir);

                let fallbackPoint = null;
                for (const mesh of state.modelMeshes) {
                    const hits = raycaster.intersectObject(mesh);
                    if (hits.length > 0) {
                        // Use the first hit whose normal is consistent
                        for (const hit of hits) {
                            const hitNormal = getFaceWorldNormal(mesh, hit.faceIndex);
                            if (hitNormal.dot(interpolatedNormal) >= 0) {
                                fallbackPoint = hit.point.clone();
                                break;
                            }
                        }
                        if (fallbackPoint) break;
                    }
                }

                bestPoint = fallbackPoint; // null → linear interpolation fallback
            }
        }

        if (bestPoint) {
            projectedPoints.push({ x: bestPoint.x, y: bestPoint.y, z: bestPoint.z });
        } else {
            projectedPoints.push({ x: tempPoint.x, y: tempPoint.y, z: tempPoint.z });
        }
    }

    return projectedPoints;
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

export function computeProjectedEdges(points, closePolygon = false, segments = 30) {
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
export function computeProjectedEdgesFlipAware(points, closePolygon = false, segments = 30) {
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
