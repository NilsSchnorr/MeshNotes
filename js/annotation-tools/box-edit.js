// js/annotation-tools/box-edit.js
// Box annotation rendering/placement helpers (Phase 4a module split from editing.js).
// Pure behaviour-identical relocation: code moved, not changed.
// (Phase 4b will lift the box manipulation handlers out of the pointer routers.)
import * as THREE from 'three';
import { state } from '../state.js';

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
