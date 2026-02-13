// js/core/lighting.js - Lighting setup and controls
import * as THREE from 'three';
import { state, dom } from '../state.js';

// ============ Lighting Initialization ============

export function initLighting() {
    state.ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
    state.scene.add(state.ambientLight);

    state.dirLight1 = new THREE.DirectionalLight(0xffffff, 0.96);
    state.dirLight1.position.set(5, 10, 7);
    state.dirLight1.target = new THREE.Object3D(); // Add target for camera-linked mode
    state.scene.add(state.dirLight1);
    state.scene.add(state.dirLight1.target);

    state.dirLight2 = new THREE.DirectionalLight(0xffffff, 0.48);
    state.dirLight2.position.set(-5, -5, -5);
    state.scene.add(state.dirLight2);
}

// ============ Brightness Control ============

export function setBrightness(value) {
    const factor = value / 100;
    state.ambientLight.intensity = 0.72 * factor;
    // Apply 1.5x boost when in fixed direction mode for better raking light effect
    const dirLightMultiplier = state.lightFollowsCamera ? 1.0 : 1.5;
    state.dirLight1.intensity = 0.96 * factor * dirLightMultiplier;
    state.dirLight2.intensity = 0.48 * factor;
    dom.brightnessValue.textContent = `${value}%`;
}

// ============ Opacity Control ============

export function setModelOpacity(value) {
    state.modelOpacity = value / 100;
    dom.opacityValue.textContent = `${value}%`;

    if (!state.currentModel) return;

    state.currentModel.traverse((child) => {
        if (child.isMesh) {
            child.material.transparent = true;
            child.material.opacity = state.modelOpacity;
            child.material.depthWrite = state.modelOpacity > 0.9;
            child.material.needsUpdate = true;
        }
    });
}

// ============ Point Size Control ============

export function setPointSize(value) {
    state.pointSizeMultiplier = value / 100;
    dom.pointSizeValue.textContent = `${value}%`;
    localStorage.setItem('meshnotes_pointSize', value);
    // Note: renderAnnotations() will be called by the event listener
    // to avoid circular dependency, caller is responsible for re-rendering
}

// ============ Text Size Control ============

export function setTextSize(value) {
    state.textSizeMultiplier = value / 100;
    dom.textSizeValue.textContent = `${value}%`;
    localStorage.setItem('meshnotes_textSize', value);
    // Note: renderAnnotations() will be called by the event listener
    // to avoid circular dependency, caller is responsible for re-rendering
}

// ============ Light Mode Controls ============

export function toggleLightMode() {
    state.lightFollowsCamera = !state.lightFollowsCamera;

    if (state.lightFollowsCamera) {
        dom.lightToggle.textContent = 'Follows Camera';
        dom.lightToggle.classList.add('active');
        dom.lightDirectionRow.classList.remove('visible');
        // Restore normal light intensity
        state.dirLight1.intensity = 0.96 * (parseInt(dom.brightnessSlider.value) / 100);
        updateLightFromCamera();
    } else {
        dom.lightToggle.textContent = 'Fixed Direction';
        dom.lightToggle.classList.remove('active');
        dom.lightDirectionRow.classList.add('visible');
        // Boost light intensity 1.5x for better raking light shadow visibility
        state.dirLight1.intensity = 0.96 * (parseInt(dom.brightnessSlider.value) / 100) * 1.5;
        updateFixedLightDirection();
    }
}

export function updateLightFromCamera() {
    // Position light relative to camera direction
    const cameraDir = new THREE.Vector3();
    state.camera.getWorldDirection(cameraDir);

    // Light comes from camera direction (slightly above)
    const lightDistance = 10;
    const lightPos = state.camera.position.clone().sub(cameraDir.multiplyScalar(lightDistance));
    lightPos.y += 5; // Slightly above camera level

    state.dirLight1.position.copy(lightPos);
    state.dirLight1.target.position.copy(state.controls.target);
}

export function updateFixedLightDirection() {
    // Convert spherical coordinates to Cartesian
    const azimuthRad = (state.fixedLightAzimuth * Math.PI) / 180;
    const elevationRad = (state.fixedLightElevation * Math.PI) / 180;

    const distance = 10;

    // Spherical to Cartesian conversion
    // Elevation: 0 deg = horizon, 90 deg = straight up, -90 deg = straight down
    const y = Math.sin(elevationRad) * distance;
    const horizontalDist = Math.cos(elevationRad) * distance;
    const x = Math.sin(azimuthRad) * horizontalDist;
    const z = Math.cos(azimuthRad) * horizontalDist;

    state.dirLight1.position.set(x, y, z);
    state.dirLight1.target.position.set(0, 0, 0);
}

export function setLightAzimuth(value) {
    state.fixedLightAzimuth = value;
    dom.lightAzimuthValue.textContent = `${value}\u00B0`;
    if (!state.lightFollowsCamera) {
        updateFixedLightDirection();
    }
}

export function setLightElevation(value) {
    state.fixedLightElevation = value;
    dom.lightElevationValue.textContent = `${value}\u00B0`;
    if (!state.lightFollowsCamera) {
        updateFixedLightDirection();
    }
}
