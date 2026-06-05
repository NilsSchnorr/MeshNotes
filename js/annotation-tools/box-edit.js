// js/annotation-tools/box-edit.js
// Box annotation rendering, placement, and manipulation handlers.
// Split from editing.js across Phases 4a (render/clear) and 4b (manip math, end, confirm).
// Pure behaviour-identical relocation: code moved, not changed.
import * as THREE from 'three';
import { state, dom } from '../state.js';
import { showStatus, toStorageCoords } from '../utils/helpers.js';
import { renderAnnotations } from './render.js';
import { updateGroupsList } from './groups.js';

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
    const corners = [
        [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
        [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5],
        [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]
    ];

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
    const boxData = {
        center: storageCenter,
        size: { ...state.pendingBoxData.size },
        rotation: state.pendingBoxData.rotation ? { ...state.pendingBoxData.rotation } : { x: 0, y: 0, z: 0 }
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
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        const startCenter = new THREE.Vector3(
            state.boxDragStartData.center.x,
            state.boxDragStartData.center.y,
            state.boxDragStartData.center.z
        );
        const cameraDir = new THREE.Vector3();
        state.camera.getWorldDirection(cameraDir);
        const movePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, startCenter);
        const grabOffset = computeBoxGrabOffset(movePlane, startCenter);

        const intersection = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(movePlane, intersection)) {
            const newCenter = intersection.clone().sub(grabOffset);
            state.pendingBoxData.center = {
                x: newCenter.x,
                y: newCenter.y,
                z: newCenter.z
            };
            renderPendingBox();
        }
    } else if (state.boxManipulationMode === 'resize') {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        const corners = [
            [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
            [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
            [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5],
            [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]
        ];

        const draggedCornerFactors = corners[state.activeBoxHandle];
        const oppositeIndex = 7 - state.activeBoxHandle;
        const oppositeCornerFactors = corners[oppositeIndex];

        const startCenter = new THREE.Vector3(
            state.boxDragStartData.center.x,
            state.boxDragStartData.center.y,
            state.boxDragStartData.center.z
        );
        const startSize = state.boxDragStartData.size;
        const startRotation = state.boxDragStartData.rotation || { x: 0, y: 0, z: 0 };
        const euler = new THREE.Euler(startRotation.x, startRotation.y, startRotation.z);

        const oppositeCornerLocal = new THREE.Vector3(
            oppositeCornerFactors[0] * startSize.x,
            oppositeCornerFactors[1] * startSize.y,
            oppositeCornerFactors[2] * startSize.z
        );
        oppositeCornerLocal.applyEuler(euler);
        const fixedCorner = oppositeCornerLocal.add(startCenter);

        const draggedCornerLocal = new THREE.Vector3(
            draggedCornerFactors[0] * startSize.x,
            draggedCornerFactors[1] * startSize.y,
            draggedCornerFactors[2] * startSize.z
        );
        draggedCornerLocal.applyEuler(euler);
        const draggedCornerWorld = draggedCornerLocal.clone().add(startCenter);

        const cameraDir = new THREE.Vector3();
        state.camera.getWorldDirection(cameraDir);
        const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, draggedCornerWorld);

        const newCornerPos = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(dragPlane, newCornerPos)) {
            const newCenter = new THREE.Vector3().addVectors(fixedCorner, newCornerPos).multiplyScalar(0.5);

            const diagonal = new THREE.Vector3().subVectors(newCornerPos, fixedCorner);
            const inverseEuler = new THREE.Euler(-startRotation.x, -startRotation.y, -startRotation.z, 'ZYX');
            diagonal.applyEuler(inverseEuler);

            const newSize = {
                x: Math.max(0.01, Math.abs(diagonal.x)),
                y: Math.max(0.01, Math.abs(diagonal.y)),
                z: Math.max(0.01, Math.abs(diagonal.z))
            };

            state.pendingBoxData.center = {
                x: newCenter.x,
                y: newCenter.y,
                z: newCenter.z
            };
            state.pendingBoxData.size = newSize;
            renderPendingBox();
        }
    } else if (state.boxManipulationMode === 'rotate') {
        const rotationSpeed = 0.01;
        let rotX = (state.boxDragStartData.rotation?.x || 0) + deltaY * rotationSpeed;
        let rotY = (state.boxDragStartData.rotation?.y || 0) + deltaX * rotationSpeed;
        let rotZ = state.boxDragStartData.rotation?.z || 0;

        if (event.shiftKey) {
            const snapAngle = Math.PI / 12;
            rotX = Math.round(rotX / snapAngle) * snapAngle;
            rotY = Math.round(rotY / snapAngle) * snapAngle;
        }

        state.pendingBoxData.rotation = {
            x: rotX,
            y: rotY,
            z: rotZ
        };
        renderPendingBox();
    }
}

export function updateSelectedBoxManipulation(event, mouse) {
    const deltaX = event.clientX - state.boxDragStartMouse.x;
    const deltaY = event.clientY - state.boxDragStartMouse.y;

    if (state.boxManipulationMode === 'move') {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        // Convert stored center to display (world) space for plane positioning
        const sc = state.boxDragStartData.center;
        const dc = state.isFlipped ? { x: sc.x, y: -sc.y, z: -sc.z } : sc;
        const startCenter = new THREE.Vector3(dc.x, dc.y, dc.z);
        const cameraDir = new THREE.Vector3();
        state.camera.getWorldDirection(cameraDir);
        const movePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, startCenter);
        const grabOffset = computeBoxGrabOffset(movePlane, startCenter);

        const intersection = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(movePlane, intersection)) {
            const newCenterWorld = intersection.clone().sub(grabOffset);
            // Convert from world space back to storage
            const stored = toStorageCoords(newCenterWorld);
            state.selectedBoxAnnotation.boxData.center = {
                x: stored.x,
                y: stored.y,
                z: stored.z
            };
            state.selectedBoxAnnotation.points[0] = { ...state.selectedBoxAnnotation.boxData.center };
            renderAnnotations();
        }
    } else if (state.boxManipulationMode === 'resize') {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, state.camera);

        const corners = [
            [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
            [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
            [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5],
            [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]
        ];

        const draggedCornerFactors = corners[state.activeBoxHandle];
        const oppositeIndex = 7 - state.activeBoxHandle;
        const oppositeCornerFactors = corners[oppositeIndex];

        // Convert stored center to display (world) space for manipulation
        const sc = state.boxDragStartData.center;
        const dc = state.isFlipped ? { x: sc.x, y: -sc.y, z: -sc.z } : sc;
        const startCenter = new THREE.Vector3(dc.x, dc.y, dc.z);
        const startSize = state.boxDragStartData.size;
        const startRotation = state.boxDragStartData.rotation || { x: 0, y: 0, z: 0 };
        const euler = new THREE.Euler(startRotation.x, startRotation.y, startRotation.z);

        const oppositeCornerLocal = new THREE.Vector3(
            oppositeCornerFactors[0] * startSize.x,
            oppositeCornerFactors[1] * startSize.y,
            oppositeCornerFactors[2] * startSize.z
        );
        oppositeCornerLocal.applyEuler(euler);
        const fixedCorner = oppositeCornerLocal.add(startCenter);

        const draggedCornerLocal = new THREE.Vector3(
            draggedCornerFactors[0] * startSize.x,
            draggedCornerFactors[1] * startSize.y,
            draggedCornerFactors[2] * startSize.z
        );
        draggedCornerLocal.applyEuler(euler);
        const draggedCornerWorld = draggedCornerLocal.clone().add(startCenter);

        const cameraDir = new THREE.Vector3();
        state.camera.getWorldDirection(cameraDir);
        const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, draggedCornerWorld);

        const newCornerPos = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(dragPlane, newCornerPos)) {
            const newCenter = new THREE.Vector3().addVectors(fixedCorner, newCornerPos).multiplyScalar(0.5);

            const diagonal = new THREE.Vector3().subVectors(newCornerPos, fixedCorner);
            const inverseEuler = new THREE.Euler(-startRotation.x, -startRotation.y, -startRotation.z, 'ZYX');
            diagonal.applyEuler(inverseEuler);

            const newSize = {
                x: Math.max(0.01, Math.abs(diagonal.x)),
                y: Math.max(0.01, Math.abs(diagonal.y)),
                z: Math.max(0.01, Math.abs(diagonal.z))
            };

            // Convert from world space back to storage
            const stored = toStorageCoords(newCenter);
            state.selectedBoxAnnotation.boxData.center = {
                x: stored.x,
                y: stored.y,
                z: stored.z
            };
            state.selectedBoxAnnotation.boxData.size = newSize;
            state.selectedBoxAnnotation.points[0] = { ...state.selectedBoxAnnotation.boxData.center };
            renderAnnotations();
        }
    } else if (state.boxManipulationMode === 'rotate') {
        const rotationSpeed = 0.01;
        let rotX = (state.boxDragStartData.rotation?.x || 0) + deltaY * rotationSpeed;
        let rotY = (state.boxDragStartData.rotation?.y || 0) + deltaX * rotationSpeed;
        let rotZ = state.boxDragStartData.rotation?.z || 0;

        if (event.shiftKey) {
            const snapAngle = Math.PI / 12;
            rotX = Math.round(rotX / snapAngle) * snapAngle;
            rotY = Math.round(rotY / snapAngle) * snapAngle;
        }

        state.selectedBoxAnnotation.boxData.rotation = {
            x: rotX,
            y: rotY,
            z: rotZ
        };
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
