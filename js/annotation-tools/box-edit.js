// js/annotation-tools/box-edit.js
// Box annotation rendering, placement, and manipulation handlers.
// Split from editing.js across Phases 4a (render/clear) and 4b (manip math, end, confirm).
// Pure behaviour-identical relocation: code moved, not changed.
import * as THREE from 'three';
import { state, dom } from '../state.js';
import { showStatus, toStorageCoords, toDisplayCoords, boxDisplayQuaternion } from '../utils/helpers.js';
import { renderAnnotations } from './render.js';
import { updateGroupsList } from './groups.js';
import { showBoxEditHelp, hideToolHelp } from '../ui/tool-help.js';

// Late-bound callbacks (forwarded from editing.js setEditingCallbacks)
let _openAnnotationPopup = null;
let _setTool = null;
export function setBoxEditCallbacks({ openAnnotationPopup, setTool }) {
    _openAnnotationPopup = openAnnotationPopup;
    _setTool = setTool;
}

// --- Box "grab offset" helpers (keep the box's pick point under the cursor on move) ---
function clientToNDC(clientX, clientY) {
    const rect = dom.canvas.getBoundingClientRect();
    return new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
    );
}

// Vector from the box center to where the cursor first hit the move-plane at drag start.
// Subtracting it from the live plane hit keeps the grabbed point fixed under the cursor,
// so the box no longer snaps its center to the pointer on the first move.
function computeBoxGrabOffset(plane, startCenter) {
    const startMouseNDC = clientToNDC(state.boxDragStartMouse.x, state.boxDragStartMouse.y);
    const startRay = new THREE.Raycaster();
    startRay.setFromCamera(startMouseNDC, state.camera);
    const hitAtStart = new THREE.Vector3();
    if (startRay.ray.intersectPlane(plane, hitAtStart)) {
        return hitAtStart.sub(startCenter);
    }
    return new THREE.Vector3(0, 0, 0);
}

// Unit-box corner factors (x size = local corner offset from center).
// Shared by renderPendingBox and the resize math below.
const BOX_CORNERS = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
    [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5],
    [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]
];

// --- Shared box manipulation math (world/display space, flip-agnostic) ---
// These pure helpers hold the geometry that was previously duplicated between
// updatePendingBoxManipulation and updateSelectedBoxManipulation. They take and
// return world-space values; each caller owns its flip handling on read
// (toDisplayCoords) and storage conversion on write (toStorageCoords) -- the
// part that genuinely differs between the pending and selected paths.

// Move: returns the new world-space center for the pointer position, or null if
// the pointer ray misses the camera-facing move plane.
function computeBoxMove(mouse, startCenter) {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, state.camera);

    const cameraDir = new THREE.Vector3();
    state.camera.getWorldDirection(cameraDir);
    const movePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, startCenter);
    const grabOffset = computeBoxGrabOffset(movePlane, startCenter);

    const intersection = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(movePlane, intersection)) {
        return intersection.clone().sub(grabOffset);
    }
    return null;
}

// Resize: returns { center, size } in world space for the dragged corner, or
// null if the pointer ray misses the camera-facing drag plane. The opposite
// corner stays fixed; the box rebuilds around the new diagonal.
function computeBoxResize(mouse, startCenter, startSize, displayQuat, activeHandle) {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, state.camera);

    const draggedCornerFactors = BOX_CORNERS[activeHandle];
    const oppositeCornerFactors = BOX_CORNERS[7 - activeHandle];

    const oppositeCornerLocal = new THREE.Vector3(
        oppositeCornerFactors[0] * startSize.x,
        oppositeCornerFactors[1] * startSize.y,
        oppositeCornerFactors[2] * startSize.z
    );
    oppositeCornerLocal.applyQuaternion(displayQuat);
    const fixedCorner = oppositeCornerLocal.add(startCenter);

    const draggedCornerLocal = new THREE.Vector3(
        draggedCornerFactors[0] * startSize.x,
        draggedCornerFactors[1] * startSize.y,
        draggedCornerFactors[2] * startSize.z
    );
    draggedCornerLocal.applyQuaternion(displayQuat);
    const draggedCornerWorld = draggedCornerLocal.clone().add(startCenter);

    const cameraDir = new THREE.Vector3();
    state.camera.getWorldDirection(cameraDir);
    const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, draggedCornerWorld);

    const newCornerPos = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, newCornerPos)) {
        const newCenter = new THREE.Vector3().addVectors(fixedCorner, newCornerPos).multiplyScalar(0.5);

        const diagonal = new THREE.Vector3().subVectors(newCornerPos, fixedCorner);
        const inverseQuat = displayQuat.clone().invert();
        diagonal.applyQuaternion(inverseQuat);

        const newSize = {
            x: Math.max(0.01, Math.abs(diagonal.x)),
            y: Math.max(0.01, Math.abs(diagonal.y)),
            z: Math.max(0.01, Math.abs(diagonal.z))
        };
        return { center: newCenter, size: newSize };
    }
    return null;
}

// Rotate: returns a new { x, y, z } euler from the pointer deltas, with optional
// 15-degree snapping while Shift is held. Rotation is screen-space and flip-agnostic.
function computeBoxRotation(startRotation, deltaX, deltaY, shiftKey) {
    const rotationSpeed = 0.01;
    let rotX = (startRotation?.x || 0) + deltaY * rotationSpeed;
    let rotY = (startRotation?.y || 0) + deltaX * rotationSpeed;
    const rotZ = startRotation?.z || 0;

    if (shiftKey) {
        const snapAngle = Math.PI / 12;
        rotX = Math.round(rotX / snapAngle) * snapAngle;
        rotY = Math.round(rotY / snapAngle) * snapAngle;
    }
    return { x: rotX, y: rotY, z: rotZ };
}

/**
 * Renders the pending box during placement mode.
 * Creates a temporary box visualization that can be manipulated before confirmation.
 */
export function renderPendingBox() {
    // First clear any existing pending box objects
    const existingObjects = state.annotationObjects.children.filter(obj =>
        obj.userData.isPendingBoxBody || obj.userData.isPendingBoxHandle || obj.userData.isPendingBoxWireframe
    );
    existingObjects.forEach(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => m.dispose());
        }
        state.annotationObjects.remove(obj);
    });

    if (!state.pendingBoxData) return;

    const { center, size, rotation } = state.pendingBoxData;
    const color = state.groups.length > 0 ? new THREE.Color(state.groups[0].color) : new THREE.Color(0xEDC040);

    // Calculate model size for scaling handles
    const modelSize = state.currentModel ?
        new THREE.Box3().setFromObject(state.currentModel).getSize(new THREE.Vector3()) :
        new THREE.Vector3(1, 1, 1);
    const maxDim = Math.max(modelSize.x, modelSize.y, modelSize.z);

    // Create box body (semi-transparent fill)
    const boxGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const fillMaterial = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false
    });

    const boxMesh = new THREE.Mesh(boxGeometry.clone(), fillMaterial);
    boxMesh.position.set(center.x, center.y, center.z);
    if (rotation) {
        boxMesh.rotation.set(rotation.x, rotation.y, rotation.z);
    }
    boxMesh.userData.isPendingBoxBody = true;
    boxMesh.renderOrder = 1;
    state.annotationObjects.add(boxMesh);

    // Create wireframe edges
    const edgesGeometry = new THREE.EdgesGeometry(boxGeometry);
    const edgesMaterial = new THREE.LineBasicMaterial({
        color: color,
        linewidth: 2,
        transparent: true,
        opacity: 1.0,
        depthTest: true,
        depthWrite: false
    });
    const wireframe = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    wireframe.position.copy(boxMesh.position);
    wireframe.rotation.copy(boxMesh.rotation);
    wireframe.userData.isPendingBoxWireframe = true;
    wireframe.renderOrder = 2;
    state.annotationObjects.add(wireframe);

    // Create corner handles
    const corners = BOX_CORNERS;

    const handleGeometry = new THREE.SphereGeometry(0.02, 12, 12);

    corners.forEach((corner, index) => {
        const handleMaterial = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 1.0,
            depthTest: true,
            depthWrite: false
        });
        const handle = new THREE.Mesh(handleGeometry, handleMaterial);

        const localPos = new THREE.Vector3(
            corner[0] * size.x,
            corner[1] * size.y,
            corner[2] * size.z
        );

        if (rotation) {
            const euler = new THREE.Euler(rotation.x, rotation.y, rotation.z);
            localPos.applyEuler(euler);
        }
        handle.position.set(
            center.x + localPos.x,
            center.y + localPos.y,
            center.z + localPos.z
        );

        handle.scale.setScalar(Math.pow(maxDim, 0.8) * 0.018 * state.pointSizeMultiplier);
        handle.userData.isPendingBoxHandle = true;
        handle.userData.handleIndex = index;
        handle.renderOrder = 3;
        state.annotationObjects.add(handle);
    });
}

/**
 * Clears the pending box and resets placement state.
 */
export function clearPendingBox() {
    // Remove pending box objects from scene
    const pendingObjects = state.annotationObjects.children.filter(obj =>
        obj.userData.isPendingBoxBody || obj.userData.isPendingBoxHandle || obj.userData.isPendingBoxWireframe
    );
    pendingObjects.forEach(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => m.dispose());
        }
        state.annotationObjects.remove(obj);
    });

    // Reset state
    state.pendingBoxData = null;
    state.isBoxPlacementMode = false;
    state.pendingBoxClickPosition = null;
}

export function confirmBoxPlacement(event) {
    // Confirm box placement - convert from world space to storage coords
    const storageCenter = toStorageCoords(state.pendingBoxData.center);
    const point = { x: storageCenter.x, y: storageCenter.y, z: storageCenter.z };

    // The pending box's rotation is a DISPLAY-space Euler (the pending-box
    // renderer applies it directly, with no flip premultiply). Stored
    // rotations follow the boxDisplayQuaternion contract:
    //     display = Rx(PI) * storage   (when flipped)
    // so invert that here. Otherwise a box created while flipped with a
    // Y/Z rotation component keeps a mirrored lean after un-flipping and
    // in exports. No-op when the model is not flipped.
    const pendingRot = state.pendingBoxData.rotation ? { ...state.pendingBoxData.rotation } : { x: 0, y: 0, z: 0 };
    let storageRotation = pendingRot;
    if (state.isFlipped) {
        const qDisplay = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(pendingRot.x, pendingRot.y, pendingRot.z, 'XYZ'));
        const qFlipInv = new THREE.Quaternion()
            .setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI).invert();
        const e = new THREE.Euler().setFromQuaternion(qDisplay.premultiply(qFlipInv), 'XYZ');
        storageRotation = { x: e.x, y: e.y, z: e.z };
    }

    const boxData = {
        center: storageCenter,
        size: { ...state.pendingBoxData.size },
        rotation: storageRotation
    };

    // Exit placement mode but KEEP the pending box visuals on screen, so the box
    // stays visible while the annotation popup is open (instead of vanishing until
    // save). The pending visuals are removed when the popup resolves: saveAnnotation()
    // and the cancel / X-close handlers all call clearTempDrawing(), which in turn
    // calls clearPendingBox(). On save, renderAnnotations() then draws the real box.
    state.isBoxPlacementMode = false;
    state.pendingBoxData = null;
    state.pendingBoxClickPosition = null;

    // Open popup with the finalized box data
    _openAnnotationPopup(event, 'box', [point], boxData);
    _setTool(null);
}

export function updatePendingBoxManipulation(event, mouse) {
    const deltaX = event.clientX - state.boxDragStartMouse.x;
    const deltaY = event.clientY - state.boxDragStartMouse.y;

    if (state.boxManipulationMode === 'move') {
        const sc = state.boxDragStartData.center;
        const startCenter = new THREE.Vector3(sc.x, sc.y, sc.z);
        const newCenter = computeBoxMove(mouse, startCenter);
        if (newCenter) {
            state.pendingBoxData.center = { x: newCenter.x, y: newCenter.y, z: newCenter.z };
            renderPendingBox();
        }
    } else if (state.boxManipulationMode === 'resize') {
        const sc = state.boxDragStartData.center;
        const startCenter = new THREE.Vector3(sc.x, sc.y, sc.z);
        const startSize = state.boxDragStartData.size;
        // Pending box lives in display space already, so no flip pre-multiply here.
        const r = state.boxDragStartData.rotation || { x: 0, y: 0, z: 0 };
        const displayQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z, 'XYZ'));
        const result = computeBoxResize(mouse, startCenter, startSize, displayQuat, state.activeBoxHandle);
        if (result) {
            state.pendingBoxData.center = { x: result.center.x, y: result.center.y, z: result.center.z };
            state.pendingBoxData.size = result.size;
            renderPendingBox();
        }
    } else if (state.boxManipulationMode === 'rotate') {
        state.pendingBoxData.rotation = computeBoxRotation(state.boxDragStartData.rotation, deltaX, deltaY, event.shiftKey);
        renderPendingBox();
    }
}

export function updateSelectedBoxManipulation(event, mouse) {
    const deltaX = event.clientX - state.boxDragStartMouse.x;
    const deltaY = event.clientY - state.boxDragStartMouse.y;

    if (state.boxManipulationMode === 'move') {
        // Stored center -> display (world) space for the manipulation math.
        const dc = toDisplayCoords(state.boxDragStartData.center);
        const startCenter = new THREE.Vector3(dc.x, dc.y, dc.z);
        const newCenterWorld = computeBoxMove(mouse, startCenter);
        if (newCenterWorld) {
            // Convert from world space back to storage
            const stored = toStorageCoords(newCenterWorld);
            state.selectedBoxAnnotation.boxData.center = { x: stored.x, y: stored.y, z: stored.z };
            state.selectedBoxAnnotation.points[0] = { ...state.selectedBoxAnnotation.boxData.center };
            renderAnnotations();
        }
    } else if (state.boxManipulationMode === 'resize') {
        // Stored center -> display (world) space for the manipulation math.
        const dc = toDisplayCoords(state.boxDragStartData.center);
        const startCenter = new THREE.Vector3(dc.x, dc.y, dc.z);
        const startSize = state.boxDragStartData.size;
        // Display orientation (flip-aware) so the math matches the rendered body.
        const displayQuat = boxDisplayQuaternion(state.boxDragStartData.rotation);
        const result = computeBoxResize(mouse, startCenter, startSize, displayQuat, state.activeBoxHandle);
        if (result) {
            // Convert from world space back to storage
            const stored = toStorageCoords(result.center);
            state.selectedBoxAnnotation.boxData.center = { x: stored.x, y: stored.y, z: stored.z };
            state.selectedBoxAnnotation.boxData.size = result.size;
            state.selectedBoxAnnotation.points[0] = { ...state.selectedBoxAnnotation.boxData.center };
            renderAnnotations();
        }
    } else if (state.boxManipulationMode === 'rotate') {
        state.selectedBoxAnnotation.boxData.rotation = computeBoxRotation(state.boxDragStartData.rotation, deltaX, deltaY, event.shiftKey);
        renderAnnotations();
    }
}

export function endPendingBoxManipulation() {
    state.wasDragging = true;
    state.isManipulatingBox = false;
    state.boxManipulationMode = null;
    state.boxDragStartMouse = null;
    state.boxDragStartData = null;
    state.activeBoxHandle = null;
    state.controls.enabled = true;
    dom.canvas.style.cursor = 'default';
    // Don't call renderAnnotations - the pending box is rendered separately
}

export function endSelectedBoxManipulation() {
    state.wasDragging = true;

    const statusMsg = state.boxManipulationMode === 'move' ? 'Box moved' :
                      state.boxManipulationMode === 'resize' ? 'Box resized' :
                      state.boxManipulationMode === 'rotate' ? 'Box rotated' : 'Box updated';

    state.isManipulatingBox = false;
    state.selectedBoxAnnotation = null;
    state.boxManipulationMode = null;
    state.boxDragStartMouse = null;
    state.boxDragStartData = null;
    state.activeBoxHandle = null;
    state.controls.enabled = true;
    dom.canvas.style.cursor = 'default';

    renderAnnotations();
    updateGroupsList();
    showStatus(statusMsg);
}


// ============ Router-dispatch helpers (router-thinning pass) ============
// These were inline branches in the editing.js pointer routers; moved here so
// all box behaviour lives in box-edit.js. Behaviour-identical relocation; the
// only adaptation is returning a boolean so the router can early-return.

/**
 * onCanvasTap: if a box is unlocked for editing and the user clicks somewhere
 * other than that box, lock it. Returns true if the click was handled (box
 * locked) and the router should stop processing the tap.
 * @param {PointerEvent|MouseEvent} event
 * @returns {boolean}
 */
export function handleUnlockedBoxClickElsewhere(event) {
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
            return true;
        }
    }
    return false;
}

/**
 * onCanvasTap: spawn a pending box at the tapped point and enter placement mode.
 * @param {PointerEvent|MouseEvent} event
 * @param {THREE.Vector3} point - intersected world-space point.
 */
export function beginBoxPlacement(event, point) {
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

/**
 * onCanvasDoubleTap: when no tool is active, double-clicking an existing box
 * toggles its unlocked-for-editing state.
 * @param {PointerEvent|MouseEvent} event
 */
export function toggleExistingBoxLock(event) {
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

/**
 * onCanvasPointerDown: during box placement, begin manipulating the pending box
 * if the pointer hit one of its handles (resize) or its body (move/rotate).
 * Returns true if a manipulation was started and the router should early-return.
 * @param {PointerEvent|MouseEvent} event
 * @returns {boolean}
 */
export function handlePendingBoxPointerDown(event) {
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
            return true;
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
            return true;
        }
    }
    return false;
}


/**
 * onCanvasPointerDown: if the hit marker is a handle of an unlocked box, begin a
 * resize manipulation. Returns true if the event was consumed (resize started, or
 * a "locked" hint shown); false if the marker is not a box handle the router
 * should keep treating as a normal draggable point.
 * @param {PointerEvent|MouseEvent} event
 * @param {THREE.Object3D} marker - the intersected annotation marker.
 * @returns {boolean}
 */
export function beginBoxHandleDrag(event, marker) {
    const annId = marker.userData.annotationId;
    const ann = state.annotations.find(a => a.id === annId);
    if (ann && ann.type === 'box') {
        // Only allow manipulation if box is unlocked
        if (state.boxEditUnlocked !== annId) {
            showStatus('Double-click box to unlock for editing');
            return true;
        }

        state.selectedBoxAnnotation = ann;
        state.isManipulatingBox = true;
        state.boxManipulationMode = 'resize';
        state.activeBoxHandle = marker.userData.handleIndex;
        state.boxDragStartMouse = { x: event.clientX, y: event.clientY };
        state.boxDragStartData = JSON.parse(JSON.stringify(ann.boxData));
        state.controls.enabled = false;
        dom.canvas.style.cursor = 'nwse-resize';
        return true;
    }
    return false;
}

/**
 * onCanvasPointerDown: if the pointer hit an unlocked box body (and no point drag
 * or box manipulation is already in progress), begin a move (left button) or
 * rotate (right button) manipulation. Reuses the marker raycaster the router
 * already built, to avoid a second raycast.
 * @param {PointerEvent|MouseEvent} event
 * @param {THREE.Raycaster} raycaster - the router's marker raycaster.
 */
export function beginBoxBodyDrag(event, raycaster) {
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
