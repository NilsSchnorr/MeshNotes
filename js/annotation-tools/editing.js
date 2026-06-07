// js/annotation-tools/editing.js
import * as THREE from 'three';
import { state, dom } from '../state.js';
import { showStatus, toStorageCoords } from '../utils/helpers.js';
import { getIntersection } from '../core/scene.js';
import { computeProjectedEdgesFlipAware, recomputeAdjacentEdgesFlipAware } from './projection.js';
import { renderAnnotations } from './render.js';
import { updateGroupsList } from './groups.js';
import { handleMeasureTap, clearActiveMeasurement } from './measure.js';
import { getIntersectionWithFace, paintAtPoint, finishSurfacePainting, clearTempSurface, _startPaintLoop, _stopPaintLoop, queuePaintInput, setSurfacePaintCallbacks, handleSurfaceTap, handleSurfaceDoubleTap } from './surface-paint.js';
import { setDrawingCallbacks, addDrawingPoint, handlePointTap, finishDrawing } from './drawing.js';
import { clearPendingBox, updatePendingBoxManipulation, updateSelectedBoxManipulation, confirmBoxPlacement, endPendingBoxManipulation, endSelectedBoxManipulation, setBoxEditCallbacks, handleUnlockedBoxClickElsewhere, beginBoxPlacement, toggleExistingBoxLock, handlePendingBoxPointerDown, beginBoxHandleDrag, beginBoxBodyDrag } from './box-edit.js';

export function setEditingCallbacks({ openAnnotationPopup, setTool }) {
    setSurfacePaintCallbacks({ openAnnotationPopup, setTool });
    setBoxEditCallbacks({ openAnnotationPopup, setTool });
    setDrawingCallbacks({ openAnnotationPopup, setTool });
}

/**
 * Cancel an in-progress point/line/polygon drawing, surface paint, or box
 * placement. Deliberately does NOT clear measurements — those persist across
 * tool switches (see toggleTool) so the user can return and add more, or clear
 * them manually. clearTempDrawing() layers the measurement clear on top.
 */
export function cancelUnfinishedDrawing() {
    state.tempPoints = [];
    state.tempProjectedEdges = [];
    if (state.tempLine) {
        if (state.tempLine.geometry) state.tempLine.geometry.dispose();
        if (state.tempLine.material) state.tempLine.material.dispose();
        state.annotationObjects.remove(state.tempLine);
        state.tempLine = null;
    }
    clearTempSurface();
    clearPendingBox();
}

export function clearTempDrawing() {
    cancelUnfinishedDrawing();
    clearActiveMeasurement();
}

// Pointer-event-compatible aliases for the canvas handlers.
// These are the core annotation logic; click/double-tap detection
// is handled by the pointer event wrappers in event-listeners.js.
export function onCanvasTap(event) {
    if (state.wasDragging) {
        state.wasDragging = false;
        return;
    }

    if (handleUnlockedBoxClickElsewhere(event)) return;

    if (!state.currentTool || !state.currentModel) return;

    const point = getIntersection(event);
    if (!point) return;

    if (state.currentTool === 'point') {
        handlePointTap(event, point);
    } else if (state.currentTool === 'line' || state.currentTool === 'polygon') {
        addDrawingPoint(point);
    } else if (state.currentTool === 'measure') {
        handleMeasureTap(event, point);
    } else if (state.currentTool === 'surface') {
        handleSurfaceTap(event);
    } else if (state.currentTool === 'box') {
        beginBoxPlacement(event, point);
    }
}

export function onCanvasDoubleTap(event) {
    if (!state.currentModel) return;

    if (state.currentTool === 'line' && state.tempPoints.length >= 2) {
        finishDrawing(event, 'line');
    } else if (state.currentTool === 'polygon' && state.tempPoints.length >= 3) {
        finishDrawing(event, 'polygon');
    } else if (state.currentTool === 'surface' && state.paintedFaces.size > 0) {
        handleSurfaceDoubleTap(event);
    } else if (state.isBoxPlacementMode && state.pendingBoxData) {
        confirmBoxPlacement(event);
    } else if (!state.currentTool) {
        toggleExistingBoxLock(event);
    }
}

export function onCanvasPointerDown(event) {
    if (state.currentTool === 'point' && state.currentModel && event.button === 0) {
        state.pendingPointPosition = getIntersection(event);
        return;
    }

    if (state.currentTool === 'surface' && state.currentModel && event.button === 0) {
        state.isPaintingSurface = true;
        state.controls.enabled = false;

        // Start tracking a new stroke for undo
        state.currentStrokeAdded = new Set();
        state.currentStrokeRemoved = new Set();

        // Store the initial paint position and start the rAF-gated paint loop.
        // This ensures the first click paints immediately on the next frame,
        // and subsequent mousemoves are coalesced to one paint per frame.
        queuePaintInput(event.clientX, event.clientY, event.shiftKey);
        _startPaintLoop();
        return;
    }

    // Handle pending box manipulation during placement mode
    if (handlePendingBoxPointerDown(event)) return;

    if (!state.currentModel || state.currentTool) return;

    const rect = dom.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, state.camera);

    const markerObjects = state.annotationObjects.children.filter(obj =>
        obj.userData.isAnnotationMarker && obj.isMesh
    );

    const intersects = raycaster.intersectObjects(markerObjects);

    if (intersects.length > 0) {
        const marker = intersects[0].object;
        const annId = marker.userData.annotationId;
        const pointIndex = marker.userData.pointIndex;

        if (marker.userData.isBoxHandle && beginBoxHandleDrag(event, marker)) return;

        state.draggedAnnotation = state.annotations.find(a => a.id === annId);
        if (state.draggedAnnotation) {
            state.isDraggingPoint = true;
            state.draggedPointIndex = pointIndex;
            state.draggedMarker = marker;
            state.controls.enabled = false;
            dom.canvas.style.cursor = 'grabbing';
        }
    }

    if (!state.isDraggingPoint && !state.isManipulatingBox) {
        beginBoxBodyDrag(event, raycaster);
    }
}

// Idle hover-cursor feedback (no active tool): grab/resize over draggable
// annotation markers and box handles, move over a box body, default otherwise.
// Lifted from the inline onCanvasPointerMove block (router-thinning pass).
function updateHoverCursor(mouse) {
    if (!state.currentTool && state.currentModel) {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        const markerObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isAnnotationMarker && obj.isMesh
        );

        const markerIntersects = raycaster.intersectObjects(markerObjects);

        if (markerIntersects.length > 0) {
            const hitMarker = markerIntersects[0].object;
            if (hitMarker.userData.isBoxHandle) {
                dom.canvas.style.cursor = 'nwse-resize';
            } else {
                dom.canvas.style.cursor = 'grab';
            }
            return;
        }

        const boxObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isBoxBody && obj.isMesh
        );
        const boxIntersects = raycaster.intersectObjects(boxObjects);

        if (boxIntersects.length > 0) {
            dom.canvas.style.cursor = 'move';
        } else {
            dom.canvas.style.cursor = 'default';
        }
    }
}

export function onCanvasPointerMove(event) {
    const rect = dom.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    if (state.isPaintingSurface && state.currentTool === 'surface' && state.currentModel) {
        // Just store the latest position — the rAF paint loop will process it.
        // This coalesces multiple mousemove events into one paint per frame.
        queuePaintInput(event.clientX, event.clientY, event.shiftKey);
        return;
    }

    if (state.isDraggingPoint && state.draggedMarker && state.currentModel) {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        const intersects = raycaster.intersectObject(state.currentModel, true);

        if (intersects.length > 0) {
            const newPos = intersects[0].point;
            state.draggedMarker.position.copy(newPos);

            if (state.draggedAnnotation && state.draggedPointIndex >= 0) {
                // Convert from world space to storage (non-flipped) space
                const storagePos = toStorageCoords(newPos);
                state.draggedAnnotation.points[state.draggedPointIndex] = {
                    x: storagePos.x,
                    y: storagePos.y,
                    z: storagePos.z
                };

                if (state.draggedAnnotation.projectedEdges && state.draggedAnnotation.surfaceProjection) {
                    recomputeAdjacentEdgesFlipAware(state.draggedAnnotation, state.draggedPointIndex);
                }

                renderAnnotations();

                const markers = state.annotationObjects.children.filter(obj =>
                    obj.userData.isAnnotationMarker &&
                    obj.userData.annotationId === state.draggedAnnotation.id &&
                    obj.userData.pointIndex === state.draggedPointIndex
                );
                if (markers.length > 0) {
                    state.draggedMarker = markers[0];
                }
            }
        }
        return;
    }

    // Handle pending box manipulation during placement
    if (state.isManipulatingBox && state.isBoxPlacementMode && state.pendingBoxData && state.boxDragStartData) {
        updatePendingBoxManipulation(event, mouse);
        return;
    }

    if (state.isManipulatingBox && state.selectedBoxAnnotation && state.boxDragStartData) {
        updateSelectedBoxManipulation(event, mouse);
        return;
    }

    updateHoverCursor(mouse);
}

export function onCanvasPointerUp(event) {
    if (state.isPaintingSurface) {
        // Save the completed stroke to history for undo
        if (state.currentStrokeAdded || state.currentStrokeRemoved) {
            const added = state.currentStrokeAdded || new Set();
            const removed = state.currentStrokeRemoved || new Set();
            if (added.size > 0 || removed.size > 0) {
                state.surfaceStrokeHistory.push({ added, removed });
            }
            state.currentStrokeAdded = null;
            state.currentStrokeRemoved = null;
        }

        state.isPaintingSurface = false;
        state.controls.enabled = true;
        _stopPaintLoop();
    }

    // Handle pending box manipulation end
    if (state.isManipulatingBox && state.isBoxPlacementMode && state.pendingBoxData) {
        endPendingBoxManipulation();
        return;
    }

    if (state.isDraggingPoint) {
        state.wasDragging = true;

        if (state.draggedAnnotation && state.draggedAnnotation.surfaceProjection &&
            (state.draggedAnnotation.type === 'line' || state.draggedAnnotation.type === 'polygon')) {
            state.draggedAnnotation.projectedEdges = computeProjectedEdgesFlipAware(
                state.draggedAnnotation.points,
                state.draggedAnnotation.type === 'polygon'
            );
        }

        state.isDraggingPoint = false;
        state.draggedAnnotation = null;
        state.draggedPointIndex = -1;
        state.draggedMarker = null;
        state.controls.enabled = true;
        dom.canvas.style.cursor = 'default';

        renderAnnotations();
        updateGroupsList();
        showStatus('Point moved');
    }

    if (state.isManipulatingBox) {
        endSelectedBoxManipulation();
    }
}


// ============ Re-exported from ./measure.js (Phase 1 module split) ============
// editing.js stays the public entry point; measurement code now lives in measure.js.
export { undoLastMeasurePoint, updateMeasurementsDisplay, deleteMeasurement, clearAllMeasurements, renderMeasurements } from './measure.js';

// ============ Re-exported from ./surface-paint.js (Phase 2 module split) ============
export { scheduleSurfaceHighlight, updateSurfaceHighlight, undoLastSurfaceStroke } from './surface-paint.js';
export { getIntersectionWithFace, paintAtPoint, finishSurfacePainting, clearTempSurface };

// ============ Re-exported from ./drawing.js (Phase 3 module split) ============
export { undoLastPoint } from './drawing.js';
