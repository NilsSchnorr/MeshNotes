// js/core/camera.js - Camera initialization, toggling, and ViewHelper
import * as THREE from 'three';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import { state, dom } from '../state.js';

// ============ Camera Initialization ============

export function initCameras() {
    const width = window.innerWidth - 320;
    const height = window.innerHeight - 50;

    // Create both cameras
    state.perspectiveCamera = new THREE.PerspectiveCamera(60, width / height, 0.001, 1000);
    state.perspectiveCamera.position.set(2, 2, 2);

    const frustumSize = 5;
    const aspect = width / height;
    state.orthographicCamera = new THREE.OrthographicCamera(
        -frustumSize * aspect / 2, frustumSize * aspect / 2,
        frustumSize / 2, -frustumSize / 2,
        0.001, 1000
    );
    state.orthographicCamera.position.set(2, 2, 2);

    // Start with perspective camera
    state.camera = state.perspectiveCamera;
}

// ============ ViewHelper ============

export function initViewHelper() {
    const vhCanvas = document.getElementById('viewhelper-canvas');
    state.viewHelperRenderer = new THREE.WebGLRenderer({ canvas: vhCanvas, alpha: true, antialias: true });
    state.viewHelperRenderer.setPixelRatio(window.devicePixelRatio);
    state.viewHelperRenderer.setSize(128, 128);

    state.viewHelper = new ViewHelper(state.camera, state.viewHelperRenderer.domElement);
    state.viewHelper.center = state.controls.target;

    // Click on ViewHelper axes to animate camera
    vhCanvas.addEventListener('pointerup', (event) => {
        if (state.viewHelper.handleClick(event)) {
            // ViewHelper handles the camera animation
        }
    });

    // When ViewHelper animation changes camera, update controls
    state.viewHelper.addEventListener('change', () => {
        state.controls.update();
    });
}

// ============ ViewHelper Relabeling ============
/**
 * Updates ViewHelper axis labels and colors to match the loaded model's
 * coordinate system. For Z-up models (rotated into Three.js Y-up space),
 * the internal Y-axis is relabeled as Z (blue) and the internal Z-axis
 * as Y (green), so users see their model's original coordinate axes.
 * Click navigation remains correct without changes because the model
 * rotation aligns the axes: clicking "Z" (at internal +Y) navigates
 * to the top-down view, which IS the Z-down view for a Z-up model.
 */
export function updateViewHelperLabels() {
    if (!state.viewHelper) return;

    const colorRed   = new THREE.Color('#ff3653');
    const colorGreen = new THREE.Color('#8adb00');
    const colorBlue  = new THREE.Color('#2c8fff');

    // Helper: create a sprite canvas texture matching ViewHelper's internal format
    function makeSpriteMaterial(color, text) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.beginPath();
        ctx.arc(32, 32, 16, 0, 2 * Math.PI);
        ctx.closePath();
        ctx.fillStyle = color.getStyle();
        ctx.fill();
        if (text) {
            ctx.font = '24px Arial';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#000000';
            ctx.fillText(text, 32, 41);
        }
        const texture = new THREE.CanvasTexture(canvas);
        return new THREE.SpriteMaterial({ map: texture, toneMapped: false });
    }

    // Always show Z-up labels in ViewHelper for consistent UX.
    // Archaeological/heritage users universally work in Z-up coordinate systems
    // (Agisoft, CloudCompare, Blender), so the gizmo should always reflect that
    // convention regardless of the internal Three.js Y-up representation.
    // Mapping: Three.js +Y = Display +Z (up), Three.js -Z = Display +Y (front)
    const isZup = true;

    state.viewHelper.children.forEach(child => {
        if (child.isSprite && child.userData.type) {
            const type = child.userData.type;
            // Dispose old texture
            if (child.material.map) child.material.map.dispose();
            child.material.dispose();

            switch (type) {
                case 'posY':
                    // Internal +Y: in Z-up -> model +Z (blue "Z"), in Y-up -> green "Y"
                    child.material = isZup
                        ? makeSpriteMaterial(colorBlue, 'Z')
                        : makeSpriteMaterial(colorGreen, 'Y');
                    child.scale.setScalar(1); // positive axis = large
                    break;
                case 'negY':
                    // Internal -Y: in Z-up -> model -Z (blue dot), in Y-up -> green dot
                    child.material = isZup
                        ? makeSpriteMaterial(colorBlue)
                        : makeSpriteMaterial(colorGreen);
                    child.scale.setScalar(0.8); // negative axis = small
                    break;
                case 'posZ':
                    // Internal +Z: in Z-up -> model -Y (green dot), in Y-up -> blue "Z"
                    child.material = isZup
                        ? makeSpriteMaterial(colorGreen)
                        : makeSpriteMaterial(colorBlue, 'Z');
                    child.scale.setScalar(isZup ? 0.8 : 1);
                    break;
                case 'negZ':
                    // Internal -Z: in Z-up -> model +Y (green "Y"), in Y-up -> blue dot
                    child.material = isZup
                        ? makeSpriteMaterial(colorGreen, 'Y')
                        : makeSpriteMaterial(colorBlue);
                    child.scale.setScalar(isZup ? 1 : 0.8);
                    break;
                // posX, negX: always red, unchanged
            }
        } else if (child.isMesh && child.material) {
            // Axis line meshes: identify by rotation (stable across relabeling)
            // ViewHelper internals: yAxis.rotation.z = PI/2, zAxis.rotation.y = -PI/2
            const isYAxis = Math.abs(child.rotation.z - Math.PI / 2) < 0.01;
            const isZAxis = Math.abs(child.rotation.y + Math.PI / 2) < 0.01;
            if (isYAxis) {
                child.material.color.copy(isZup ? colorBlue : colorGreen);
            } else if (isZAxis) {
                child.material.color.copy(isZup ? colorGreen : colorBlue);
            }
        }
    });
}

// ============ Camera Toggle ============

export function toggleCamera() {
    state.isOrthographic = !state.isOrthographic;

    if (state.isOrthographic) {
        // Switch to orthographic
        // Copy position and rotation from perspective camera
        state.orthographicCamera.position.copy(state.perspectiveCamera.position);
        state.orthographicCamera.quaternion.copy(state.perspectiveCamera.quaternion);

        // Calculate frustum size based on distance to target
        const distance = state.perspectiveCamera.position.distanceTo(state.controls.target);
        const fov = state.perspectiveCamera.fov * Math.PI / 180;
        const frustumHeight = 2 * distance * Math.tan(fov / 2);
        const aspect = (window.innerWidth - 320) / (window.innerHeight - 50);

        state.orthographicCamera.left = -frustumHeight * aspect / 2;
        state.orthographicCamera.right = frustumHeight * aspect / 2;
        state.orthographicCamera.top = frustumHeight / 2;
        state.orthographicCamera.bottom = -frustumHeight / 2;
        state.orthographicCamera.updateProjectionMatrix();

        state.camera = state.orthographicCamera;
        dom.cameraToggle.textContent = 'Orthographic';
        dom.cameraToggle.classList.add('active');
    } else {
        // Switch to perspective
        // Copy position and rotation from orthographic camera
        state.perspectiveCamera.position.copy(state.orthographicCamera.position);
        state.perspectiveCamera.quaternion.copy(state.orthographicCamera.quaternion);

        state.camera = state.perspectiveCamera;
        dom.cameraToggle.textContent = 'Perspective';
        dom.cameraToggle.classList.remove('active');
    }

    // Update controls to use new camera
    state.controls.object = state.camera;
    state.controls.update();

    // Recreate ViewHelper with new camera
    state.viewHelper.dispose();
    state.viewHelper = new ViewHelper(state.camera, state.viewHelperRenderer.domElement);
    state.viewHelper.center = state.controls.target;
    state.viewHelper.addEventListener('change', () => {
        state.controls.update();
    });
    updateViewHelperLabels();
}
