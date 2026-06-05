// js/annotation-tools/editing.js
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { state, dom } from '../state.js';
import { showStatus, toStorageCoords } from '../utils/helpers.js';
import { getIntersection, getIntersectionFull, createScaledTextSprite } from '../core/scene.js';
import { projectEdgeToSurface, isProjectionAcceptable, computeProjectedEdges, recomputeAdjacentEdges, computeProjectedEdgesFlipAware, recomputeAdjacentEdgesFlipAware } from './projection.js';
import { renderAnnotations } from './render.js';
import { updateGroupsList } from './groups.js';
import { showBoxEditHelp, hideToolHelp } from '../ui/tool-help.js';
import { handleMeasureTap } from './measure.js';
import { getIntersectionWithFace, paintAtPoint, finishSurfacePainting, clearTempSurface, _startPaintLoop, _stopPaintLoop, queuePaintInput, setSurfacePaintCallbacks } from './surface-paint.js';
import { updateTempLine } from './drawing.js';
import { renderPendingBox, clearPendingBox, updatePendingBoxManipulation, updateSelectedBoxManipulation, confirmBoxPlacement, endPendingBoxManipulation, endSelectedBoxManipulation, setBoxEditCallbacks } from './box-edit.js';

// Late-bound references (set from main.js to avoid circular deps)
let _openAnnotationPopup = null;
let _openAnnotationPopupForEdit = null;
let _finishSurfacePainting = null;
let _setTool = null;

export function setEditingCallbacks({ openAnnotationPopup, openAnnotationPopupForEdit, finishSurfacePainting, setTool }) {
    _openAnnotationPopup = openAnnotationPopup;
    _openAnnotationPopupForEdit = openAnnotationPopupForEdit;
    _finishSurfacePainting = finishSurfacePainting;
    _setTool = setTool;
    setSurfacePaintCallbacks({ openAnnotationPopup });
    setBoxEditCallbacks({ openAnnotationPopup, setTool });
}

export function clearTempDrawing() {
    state.tempPoints = [];
    state.tempProjectedEdges = [];
    if (state.tempLine) {
        if (state.tempLine.geometry) state.tempLine.geometry.dispose();
        if (state.tempLine.material) state.tempLine.material.dispose();
        state.annotationObjects.remove(state.tempLine);
        state.tempLine = null;
    }
    state.measurePoints = [];
    state.measureMarkers.forEach(m => {
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
        state.annotationObjects.remove(m);
    });
    state.measureMarkers = [];
    if (state.measureLine) {
        if (state.measureLine.geometry) state.measureLine.geometry.dispose();
        if (state.measureLine.material) state.measureLine.material.dispose();
        state.annotationObjects.remove(state.measureLine);
        state.measureLine = null;
    }
    // Clear live measurement label
    if (state.measureLabel) {
        if (state.measureLabel.material && state.measureLabel.material.map) {
            state.measureLabel.material.map.dispose();
        }
        if (state.measureLabel.material) state.measureLabel.material.dispose();
        state.annotationObjects.remove(state.measureLabel);
        state.measureLabel = null;
    }
    state.isMultiPointMeasure = false;
    clearTempSurface();
    clearPendingBox();
}

// Pointer-event-compatible aliases for the canvas handlers.
// These are the core annotation logic; click/double-tap detection
// is handled by the pointer event wrappers in event-listeners.js.
export function onCanvasTap(event) {
    if (state.wasDragging) {
        state.wasDragging = false;
        return;
    }

    // If a box is unlocked for editing and user clicks elsewhere (not on that box),
    // lock the box and clear the edit state
    if (state.boxEditUnlocked !== null && !state.currentTool && state.currentModel) {
        const rect = dom.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        // Check if clicking on any box body or handle of the unlocked box
        const boxObjects = state.annotationObjects.children.filter(obj =>
            (obj.userData.isBoxBody || obj.userData.isBoxHandle) &&
            obj.userData.annotationId === state.boxEditUnlocked
        );
        const intersects = raycaster.intersectObjects(boxObjects);

        // If not clicking on the unlocked box, lock it
        if (intersects.length === 0) {
            state.boxEditUnlocked = null;
            hideToolHelp();
            renderAnnotations();
            showStatus('Box locked');
            return;
        }
    }

    if (!state.currentTool || !state.currentModel) return;

    const point = getIntersection(event);
    if (!point) return;

    if (state.currentTool === 'point') {
        const pointToUse = state.pendingPointPosition || point;
        state.pendingPointPosition = null;
        if (!pointToUse) return;
        _openAnnotationPopup(event, 'point', [toStorageCoords(pointToUse)]);
        _setTool(null);
    } else if (state.currentTool === 'line') {
        state.tempPoints.push(point);
        updateTempLine();
    } else if (state.currentTool === 'polygon') {
        state.tempPoints.push(point);
        updateTempLine();
    } else if (state.currentTool === 'measure') {
        handleMeasureTap(event, point);
    } else if (state.currentTool === 'surface') {
        state.isErasingMode = event.shiftKey;
        const hitInfo = getIntersectionWithFace(event);
        if (hitInfo) {
            paintAtPoint(hitInfo.point, hitInfo.mesh, hitInfo.faceIndex);
        }
    } else if (state.currentTool === 'box') {
        const defaultSize = state.modelBoundingSize * 0.15;
        state.pendingBoxData = {
            center: { x: point.x, y: point.y, z: point.z },
            size: { x: defaultSize, y: defaultSize, z: defaultSize },
            rotation: { x: 0, y: 0, z: 0 }
        };
        state.isBoxPlacementMode = true;
        state.pendingBoxClickPosition = { x: event.clientX, y: event.clientY };
        renderPendingBox();
        showStatus('Adjust box: drag to move, right-drag to rotate, drag corners to resize. Double-click to confirm.');
    }
}

export function onCanvasDoubleTap(event) {
    if (!state.currentModel) return;

    if (state.currentTool === 'line' && state.tempPoints.length >= 2) {
        // Convert from world space to storage (non-flipped) space
        const storagePoints = state.tempPoints.map(p => toStorageCoords(p));
        _openAnnotationPopup(event, 'line', storagePoints);
        _setTool(null);
    } else if (state.currentTool === 'polygon' && state.tempPoints.length >= 3) {
        const storagePoints = state.tempPoints.map(p => toStorageCoords(p));
        _openAnnotationPopup(event, 'polygon', storagePoints);
        _setTool(null);
    } else if (state.currentTool === 'surface' && state.paintedFaces.size > 0) {
        finishSurfacePainting(event);
        _setTool(null);
    } else if (state.isBoxPlacementMode && state.pendingBoxData) {
        confirmBoxPlacement(event);
    } else if (!state.currentTool) {
        // Check if double-clicking on an existing box to unlock it for editing
        const rect = dom.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        const boxObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isBoxBody && obj.isMesh
        );
        const boxIntersects = raycaster.intersectObjects(boxObjects);

        if (boxIntersects.length > 0) {
            const boxMesh = boxIntersects[0].object;
            const annId = boxMesh.userData.annotationId;
            const ann = state.annotations.find(a => a.id === annId);

            if (ann && ann.type === 'box') {
                // Toggle unlock state
                if (state.boxEditUnlocked === annId) {
                    // Already unlocked, lock it again
                    state.boxEditUnlocked = null;
                    hideToolHelp();
                    renderAnnotations(); // Update visual feedback (opacity/color change)
                    showStatus('Box locked');
                } else {
                    // Unlock for editing
                    state.boxEditUnlocked = annId;
                    showBoxEditHelp();
                    renderAnnotations(); // Update visual feedback (opacity/color change)
                    showStatus('Box unlocked for editing. Drag to move, right-drag to rotate, drag corners to resize.');
                }
            }
        }
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
    if (state.isBoxPlacementMode && state.pendingBoxData && state.currentModel) {
        const rect = dom.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        // Check for handle hit on pending box
        const handleObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isPendingBoxHandle && obj.isMesh
        );
        const handleIntersects = raycaster.intersectObjects(handleObjects);

        if (handleIntersects.length > 0) {
            const handle = handleIntersects[0].object;
            state.isManipulatingBox = true;
            state.boxManipulationMode = 'resize';
            state.activeBoxHandle = handle.userData.handleIndex;
            state.boxDragStartMouse = { x: event.clientX, y: event.clientY };
            state.boxDragStartData = JSON.parse(JSON.stringify(state.pendingBoxData));
            state.controls.enabled = false;
            dom.canvas.style.cursor = 'nwse-resize';
            return;
        }

        // Check for body hit on pending box
        const bodyObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isPendingBoxBody && obj.isMesh
        );
        const bodyIntersects = raycaster.intersectObjects(bodyObjects);

        if (bodyIntersects.length > 0) {
            state.isManipulatingBox = true;
            state.boxDragStartMouse = { x: event.clientX, y: event.clientY };
            state.boxDragStartData = JSON.parse(JSON.stringify(state.pendingBoxData));
            state.controls.enabled = false;

            if (event.button === 2) {
                state.boxManipulationMode = 'rotate';
                dom.canvas.style.cursor = 'ew-resize';
            } else {
                state.boxManipulationMode = 'move';
                dom.canvas.style.cursor = 'move';
            }
            return;
        }
    }

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

        if (marker.userData.isBoxHandle) {
            const ann = state.annotations.find(a => a.id === annId);
            if (ann && ann.type === 'box') {
                // Only allow manipulation if box is unlocked
                if (state.boxEditUnlocked !== annId) {
                    showStatus('Double-click box to unlock for editing');
                    return;
                }
                
                state.selectedBoxAnnotation = ann;
                state.isManipulatingBox = true;
                state.boxManipulationMode = 'resize';
                state.activeBoxHandle = marker.userData.handleIndex;
                state.boxDragStartMouse = { x: event.clientX, y: event.clientY };
                state.boxDragStartData = JSON.parse(JSON.stringify(ann.boxData));
                state.controls.enabled = false;
                dom.canvas.style.cursor = 'nwse-resize';
                return;
            }
        }

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
        const boxObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isBoxBody && obj.isMesh
        );
        const boxIntersects = raycaster.intersectObjects(boxObjects);

        if (boxIntersects.length > 0) {
            const boxMesh = boxIntersects[0].object;
            const annId = boxMesh.userData.annotationId;
            const ann = state.annotations.find(a => a.id === annId);

            if (ann && ann.type === 'box') {
                // Only allow manipulation if box is unlocked
                if (state.boxEditUnlocked !== annId) {
                    // Box is locked, show hint
                    showStatus('Double-click box to unlock for editing');
                    return;
                }
                
                state.selectedBoxAnnotation = ann;
                state.isManipulatingBox = true;
                state.boxDragStartMouse = { x: event.clientX, y: event.clientY };
                state.boxDragStartData = JSON.parse(JSON.stringify(ann.boxData));
                state.controls.enabled = false;

                if (event.button === 2) {
                    state.boxManipulationMode = 'rotate';
                    dom.canvas.style.cursor = 'ew-resize';
                } else {
                    state.boxManipulationMode = 'move';
                    dom.canvas.style.cursor = 'move';
                }
            }
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
