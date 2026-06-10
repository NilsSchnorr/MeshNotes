// js/annotation-tools/drawing.js
// Point / line / polygon drawing helpers (Phase 3 module split from editing.js).
// Pure behaviour-identical relocation: code moved, not changed.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { state } from '../state.js';
import { showStatus, toStorageCoords } from '../utils/helpers.js';
import { getViewportWidth, getViewportHeight } from '../core/scene.js';
import { projectEdgeToSurface, isProjectionAcceptable } from './projection.js';

// Late-bound callbacks (set via editing.js setEditingCallbacks -> setDrawingCallbacks)
let _openAnnotationPopup = null;
let _setTool = null;
export function setDrawingCallbacks({ openAnnotationPopup, setTool }) {
    _openAnnotationPopup = openAnnotationPopup;
    _setTool = setTool;
}

/**
 * Undo the last point placed during line or polygon drawing.
 * Removes the last point and its corresponding projected edge, then updates the visual.
 * @returns {boolean} True if a point was removed, false if no points to undo.
 */
export function undoLastPoint() {
    if (state.tempPoints.length === 0) {
        return false;
    }
    
    // Remove the last point
    state.tempPoints.pop();
    
    // Remove the last projected edge if it exists
    // Note: tempProjectedEdges[i] corresponds to the edge from tempPoints[i] to tempPoints[i+1]
    // So when we remove the last point, we should remove the edge that ended at that point
    if (state.tempProjectedEdges.length > 0 && state.tempProjectedEdges.length >= state.tempPoints.length) {
        state.tempProjectedEdges.pop();
    }
    
    // Update the visual representation
    updateTempLine();
    
    // Provide feedback
    const remaining = state.tempPoints.length;
    if (remaining === 0) {
        showStatus('All points removed. Click to start again.');
    } else {
        showStatus(`Point removed. ${remaining} point${remaining !== 1 ? 's' : ''} remaining.`);
    }
    
    return true;
}

export function updateTempLine() {
    if (state.tempLine) {
        // Dispose the previous temp line's GPU resources before rebuilding —
        // this runs once per placed vertex, so skipping dispose leaks one
        // geometry + material pair per click while drawing.
        if (state.tempLine.geometry) state.tempLine.geometry.dispose();
        if (state.tempLine.material) state.tempLine.material.dispose();
        state.annotationObjects.remove(state.tempLine);
        state.tempLine = null;
    }

    if (state.tempPoints.length < 2) return;

    const positions = [];

    if (state.surfaceProjectionEnabled && state.modelMeshes.length > 0) {
        for (let i = 0; i < state.tempPoints.length - 1; i++) {
            let edgePoints;
            if (i < state.tempProjectedEdges.length && state.tempProjectedEdges[i]) {
                edgePoints = state.tempProjectedEdges[i];
            } else {
                const projected = projectEdgeToSurface(state.tempPoints[i], state.tempPoints[i + 1], 20);
                const straightFallback = [
                    { x: state.tempPoints[i].x, y: state.tempPoints[i].y, z: state.tempPoints[i].z },
                    { x: state.tempPoints[i + 1].x, y: state.tempPoints[i + 1].y, z: state.tempPoints[i + 1].z }
                ];
                if (projected && isProjectionAcceptable(projected, state.tempPoints[i], state.tempPoints[i + 1])) {
                    edgePoints = projected;
                } else {
                    edgePoints = straightFallback;
                }
                if (i < state.tempPoints.length - 2) {
                    state.tempProjectedEdges[i] = edgePoints;
                }
            }
            const startIdx = (i === 0) ? 0 : 1;
            for (let j = startIdx; j < edgePoints.length; j++) {
                positions.push(edgePoints[j].x, edgePoints[j].y, edgePoints[j].z);
            }
        }
    } else {
        state.tempPoints.forEach(p => positions.push(p.x, p.y, p.z));
    }

    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    const material = new LineMaterial({
        color: 0xEDC040,
        linewidth: 3,
        resolution: new THREE.Vector2(getViewportWidth(), getViewportHeight()),
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
    });

    state.tempLine = new Line2(geometry, material);
    state.annotationObjects.add(state.tempLine);
}


/**
 * onCanvasTap (point tool): open the annotation popup at the tapped point and
 * deactivate the tool. Honours a pre-resolved pendingPointPosition if present.
 * Lifted verbatim from the onCanvasTap point branch (router-thinning pass).
 * @param {PointerEvent|MouseEvent} event
 * @param {THREE.Vector3} point - intersected world-space point.
 */
export function handlePointTap(event, point) {
    const pointToUse = state.pendingPointPosition || point;
    state.pendingPointPosition = null;
    if (!pointToUse) return;
    _openAnnotationPopup(event, 'point', [toStorageCoords(pointToUse)]);
    _setTool(null);
}

/**
 * onCanvasTap (line/polygon tools): append a vertex and refresh the temp line.
 * @param {THREE.Vector3} point - intersected world-space point.
 */
export function addDrawingPoint(point) {
    state.tempPoints.push(point);
    updateTempLine();
}

/**
 * onCanvasDoubleTap (line/polygon tools): finalise the drawing — convert the
 * collected world-space points to storage (non-flipped) space, open the
 * annotation popup, and deactivate the tool.
 * @param {PointerEvent|MouseEvent} event
 * @param {'line'|'polygon'} type
 */
export function finishDrawing(event, type) {
    // Convert from world space to storage (non-flipped) space
    const storagePoints = state.tempPoints.map(p => toStorageCoords(p));
    _openAnnotationPopup(event, type, storagePoints);
    _setTool(null);
}
