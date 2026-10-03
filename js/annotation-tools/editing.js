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
import { PLACEMENT } from '../survey/alignment.js';
import { findAlignment, handMovedOffset, handMovedStatus } from '../survey/survey-display.js';
import { renderSurveyBlock } from './survey-block.js';
import { refreshViewerSurveyBlock } from './annotation-viewer.js';

// Point drag bookkeeping. A plain click on a marker also runs the drag path,
// so the stored position at pointer-down is kept and compared on release: a
// survey point only counts as moved by hand when its position really changed.
let _dragStartPoint = null;     // storage copy of the dragged point at pointer-down
let _dragStartClient = null;    // pointer position at pointer-down
let _dragPointerMoved = false;  // latched once the pointer leaves the click radius

// The click radius of the pointer-up router (_handlePointerUp in
// event-listeners.js), squared: within it a gesture is still a click, so the
// point does not move. Pen on glass wobbles more than a mouse on a desk.
const DRAG_CLICK_DIST_SQ = 9;       // 3px radius
const DRAG_CLICK_DIST_SQ_PEN = 144; // 12px radius

// Survey control-point picking (tool 'survey-pick', survey/ui-alignment.js,
// wired in main.js): onPick receives the model hit in display space; isArmed
// tells whether a row waits for its pick (crosshair cursor, and only then is
// the hit taken at pointer-down). Markers are never dragged with this tool,
// so a drag always orbits.
let _onSurveyPick = null;
let _isSurveyPickArmed = () => false;
// Model hit at pointer-down, used by the tap that follows (a pen lifts off a
// little away from where it touched; the point tool does the same with
// state.pendingPointPosition). Tied to the pointer, so a touch tap never uses
// a mouse or pen hit.
let _surveyPickDown = null;

// Whether the annotation behind a scene object (marker, box handle or body)
// carries the persistent position lock (ann.locked, switched in the edit popup).
function isLockedObject(obj) {
    const annId = obj.userData.annotationId;
    const ann = state.annotations.find(a => a.id === annId);
    return !!ann && ann.locked === true;
}

// Whether the drag that is ending changed the stored point (false for a click).
function dragMovedPoint(ann, pointIndex) {
    const start = _dragStartPoint;
    const now = ann.points[pointIndex];
    if (!start || !now) return false;
    return now.x !== start.x || now.y !== start.y || now.z !== start.z;
}

export function setEditingCallbacks({ openAnnotationPopup, setTool }) {
    setSurfacePaintCallbacks({ openAnnotationPopup, setTool });
    setBoxEditCallbacks({ openAnnotationPopup, setTool });
    setDrawingCallbacks({ openAnnotationPopup, setTool });
}

export function setSurveyPickCallbacks({ onPick, isArmed }) {
    _onSurveyPick = onPick || null;
    _isSurveyPickArmed = isArmed || (() => false);
}

// A tap, or a fast second tap (which the pointer router turns into a
// double-tap), while picking survey control points: a second tap on the
// selected row replaces its pick.
function surveyPickTap(event) {
    const down = _surveyPickDown && _surveyPickDown.pointerId === event.pointerId ? _surveyPickDown.hit : null;
    _surveyPickDown = null;
    // Only the left mouse button picks: a right or middle click that did not
    // move (a pan let go, a context menu) must not replace a pick.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const hit = down || getIntersection(event);
    if (hit && _onSurveyPick) _onSurveyPick(hit);
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

    if (state.currentTool === 'survey-pick') {
        surveyPickTap(event);
        return;
    }

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

    if (state.currentTool === 'survey-pick') {
        surveyPickTap(event);
    } else if (state.currentTool === 'line' && state.tempPoints.length >= 2) {
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
    if (state.currentTool === 'survey-pick') {
        _surveyPickDown = state.currentModel && event.button === 0 && _isSurveyPickArmed()
            ? { pointerId: event.pointerId, hit: getIntersection(event) }
            : null;
        return;
    }

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

        const ann = state.annotations.find(a => a.id === annId);
        // A locked annotation's markers are not draggable: the pointer-down
        // carries on as on empty space, so the camera orbits as usual.
        if (ann && ann.locked !== true) {
            state.draggedAnnotation = ann;
            state.isDraggingPoint = true;
            state.draggedPointIndex = pointIndex;
            state.draggedMarker = marker;
            state.controls.enabled = false;
            dom.canvas.style.cursor = 'grabbing';

            const p = ann.points[pointIndex];
            _dragStartPoint = p ? { x: p.x, y: p.y, z: p.z } : null;
            _dragStartClient = { x: event.clientX, y: event.clientY };
            _dragPointerMoved = false;
        }
    }

    if (!state.isDraggingPoint && !state.isManipulatingBox) {
        beginBoxBodyDrag(event, raycaster);
    }
}

// Idle hover-cursor feedback (no active tool): grab/resize over draggable
// annotation markers and box handles, move over a box body, default otherwise.
// While survey control points are picked: a crosshair when a row is selected.
// Locked annotations get the default cursor, matching onCanvasPointerDown.
// Lifted from the inline onCanvasPointerMove block (router-thinning pass).
function updateHoverCursor(mouse) {
    // Survey picking: a crosshair while a row waits for its pick
    if (state.currentTool === 'survey-pick') {
        dom.canvas.style.cursor = state.currentModel && _isSurveyPickArmed() ? 'crosshair' : 'default';
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
            const locked = isLockedObject(hitMarker);
            if (hitMarker.userData.isBoxHandle) {
                dom.canvas.style.cursor = locked ? 'default' : 'nwse-resize';
                return;
            }
            // A locked point or vertex falls through to the box-body check,
            // as its pointer-down does.
            if (!locked) {
                dom.canvas.style.cursor = 'grab';
                return;
            }
        }

        const boxObjects = state.annotationObjects.children.filter(obj =>
            obj.userData.isBoxBody && obj.isMesh
        );
        const boxIntersects = raycaster.intersectObjects(boxObjects);

        if (boxIntersects.length > 0 && !isLockedObject(boxIntersects[0].object)) {
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
        // Nothing moves until the pointer leaves the click radius, so a plain
        // click or a slightly wobbly tap on a marker never shifts the point.
        if (!_dragPointerMoved) {
            if (_dragStartClient) {
                const dx = event.clientX - _dragStartClient.x;
                const dy = event.clientY - _dragStartClient.y;
                const limit = event.pointerType === 'pen' ? DRAG_CLICK_DIST_SQ_PEN : DRAG_CLICK_DIST_SQ;
                if (dx * dx + dy * dy <= limit) return;
            }
            _dragPointerMoved = true;
        }

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

        // An unlocked survey point keeps its surveyed E/N/H. Once the pointer
        // has really moved it, it counts as moved by hand, so a refine never
        // moves it again, and the status shows how far it sits from its fitted
        // position (both in storage coordinates, so the flip does not enter).
        // A plain click moved nothing and shows no status.
        const ann = state.draggedAnnotation;
        const moved = !!ann && dragMovedPoint(ann, state.draggedPointIndex);
        let status = moved ? 'Point moved' : null;
        if (moved && ann.survey) {
            ann.survey.placement = PLACEMENT.MANUAL;
            const alignment = findAlignment(state.alignments, ann.survey.alignmentId);
            status = handMovedStatus(handMovedOffset(ann.survey, ann.points[0], alignment));
            // An open edit popup or read-only viewer shows the new placement.
            if (state.editingAnnotation === ann) renderSurveyBlock(dom.annSurveyBlock, ann, state.alignments);
            refreshViewerSurveyBlock(ann);
        }

        state.isDraggingPoint = false;
        state.draggedAnnotation = null;
        state.draggedPointIndex = -1;
        state.draggedMarker = null;
        state.controls.enabled = true;
        dom.canvas.style.cursor = 'default';
        _dragStartPoint = null;
        _dragStartClient = null;
        _dragPointerMoved = false;

        renderAnnotations();
        updateGroupsList();
        if (status) showStatus(status);
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
