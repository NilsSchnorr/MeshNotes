// js/core/scene.js - Three.js scene setup and intersection helpers
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state, dom } from '../state.js';

// ============ Scene Initialization ============

export function initScene() {
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x041D31);

    const width = window.innerWidth - 320;
    const height = window.innerHeight - 50;

    state.renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, preserveDrawingBuffer: true });
    state.renderer.setSize(width, height);
    state.renderer.setPixelRatio(window.devicePixelRatio);
    state.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Annotation objects group
    state.scene.add(state.annotationObjects);
}

export function initControls() {
    state.controls = new OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.05;
}

export function addGrid() {
    const gridHelper = new THREE.GridHelper(10, 10, 0x1A5A8A, 0x1A5A8A);
    gridHelper.name = 'gridHelper';
    state.scene.add(gridHelper);
}

export function onWindowResize() {
    const width = window.innerWidth - 320;
    const height = window.innerHeight - 50;
    const aspect = width / height;

    // Update perspective camera
    state.perspectiveCamera.aspect = aspect;
    state.perspectiveCamera.updateProjectionMatrix();

    // Update orthographic camera
    const frustumSize = state.orthographicCamera.top * 2; // Current frustum size
    state.orthographicCamera.left = -frustumSize * aspect / 2;
    state.orthographicCamera.right = frustumSize * aspect / 2;
    state.orthographicCamera.updateProjectionMatrix();

    state.renderer.setSize(width, height);

    // Update line material resolutions
    state.annotationObjects.traverse((child) => {
        if (child.material && child.material.isLineMaterial) {
            child.material.resolution.set(width, height);
        }
    });
}

// ============ Raycasting ============

export function getIntersection(event) {
    if (!state.currentModel) return null;

    const rect = dom.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, state.camera);
    const intersects = raycaster.intersectObject(state.currentModel, true);

    return intersects.length > 0 ? intersects[0].point.clone() : null;
}

export function getIntersectionFull(event) {
    if (!state.currentModel) return null;

    const rect = dom.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, state.camera);
    const intersects = raycaster.intersectObjects(state.modelMeshes, false);

    if (intersects.length > 0) {
        return {
            point: intersects[0].point.clone(),
            faceIndex: intersects[0].faceIndex,
            mesh: intersects[0].object
        };
    }
    return null;
}

// ============ Text Sprite Helpers ============

export function createTextSprite(text, color = '#EDC040', backgroundColor = null, fontSize = 48) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    // Measure text to size canvas appropriately
    context.font = `bold ${fontSize}px Arial`;
    const metrics = context.measureText(text);
    const textWidth = metrics.width;
    const textHeight = fontSize;

    // Add small padding for text outline
    const padding = 8;
    canvas.width = textWidth + padding * 2;
    canvas.height = textHeight + padding * 2;

    // Draw text with outline for readability
    context.font = `bold ${fontSize}px Arial`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // Dark outline for contrast
    context.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    context.lineWidth = 4;
    context.strokeText(text, canvas.width / 2, canvas.height / 2);

    // Main text color
    context.fillStyle = color;
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    // Create sprite
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false
    });

    const sprite = new THREE.Sprite(spriteMaterial);
    
    // Ensure text labels render on top of everything (including flat models)
    sprite.renderOrder = 9999;

    // Scale sprite based on canvas aspect ratio
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(aspect * 0.15, 0.15, 1);

    return sprite;
}

export function createScaledTextSprite(text, color, position, scaleFactor = 1) {
    const sprite = createTextSprite(text, color);
    sprite.position.copy(position);

    // Scale using power of 0.7 - keeps large model labels the same, shrinks small model labels more
    if (state.currentModel) {
        const box = new THREE.Box3().setFromObject(state.currentModel);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        sprite.scale.multiplyScalar(Math.pow(maxDim, 0.7) * 0.085 * scaleFactor * state.textSizeMultiplier);
    }

    return sprite;
}
