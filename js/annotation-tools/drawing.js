// js/annotation-tools/drawing.js
// Point / line / polygon drawing helpers (Phase 3 module split from editing.js).
// Pure behaviour-identical relocation: code moved, not changed.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { state } from '../state.js';
import { showStatus } from '../utils/helpers.js';
import { projectEdgeToSurface, isProjectionAcceptable } from './projection.js';

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
        state.annotationObjects.remove(state.tempLine);
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
        resolution: new THREE.Vector2(window.innerWidth - 320, window.innerHeight - 50),
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
    });

    state.tempLine = new Line2(geometry, material);
    state.annotationObjects.add(state.tempLine);
}
