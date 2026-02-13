// js/annotation-tools/projection.js
import * as THREE from 'three';
import { state } from '../state.js';
import { showStatus } from '../utils/helpers.js';

export function projectEdgeToSurface(pointA, pointB, segments = 30) {
    if (state.modelMeshes.length === 0) return null;

    const projectedPoints = [];
    const tempPoint = new THREE.Vector3();
    const localPoint = new THREE.Vector3();
    const invMatrix = new THREE.Matrix4();

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        tempPoint.lerpVectors(pointA, pointB, t);

        let bestDistance = Infinity;
        let bestPoint = null;

        for (const mesh of state.modelMeshes) {
            if (!mesh.geometry.boundsTree) continue;

            invMatrix.copy(mesh.matrixWorld).invert();
            localPoint.copy(tempPoint).applyMatrix4(invMatrix);

            const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
            const result = mesh.geometry.boundsTree.closestPointToPoint(localPoint, target);

            if (result && result.distance < bestDistance) {
                bestDistance = result.distance;
                bestPoint = result.point.clone().applyMatrix4(mesh.matrixWorld);
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
            ann.projectedEdges = computeProjectedEdges(ann.points, ann.type === 'polygon');
            ann.surfaceProjection = true;
            count++;
        }
    });

    if (count > 0) {
        if (_renderAnnotations) _renderAnnotations();
        showStatus(`Re-projected ${count} annotations onto surface`);
    }
}
